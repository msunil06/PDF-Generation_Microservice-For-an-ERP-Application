const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { singleQueue, bulkQueue } = require('../queues');
const { verifyHMAC } = require('../services/signer');
const { getSignedDownloadUrl } = require('../services/storage');
const db = require('../services/database');
const logger = require('../utils/logger');

const router = express.Router();

const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.PDF_SERVICE_API_KEY) {
    logger.warn('Unauthorized request', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(validateApiKey);

router.post('/generate', async (req, res) => {
  const { type, documentId, data } = req.body;

  if (!type || !documentId || !data) {
    return res.status(400).json({ error: 'Missing required fields: type, documentId, data' });
  }

  if (!['purchase_order', 'invoice'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type. Must be "purchase_order" or "invoice"' });
  }

  const jobId = uuidv4();

  try {
    const job = await singleQueue.add(
      {
        jobId,
        type,
        documentId,
        data: JSON.parse(JSON.stringify(data)),
        requestedAt: new Date().toISOString(),
      },
      { priority: 1 }
    );

    const result = await job.finished();

    return res.status(200).json({
      success: true,
      jobId,
      documentId,
      downloadUrl: result.downloadUrl,
      expiresAt: result.expiresAt,
      fileSize: result.fileSize,
      hmacHash: result.hmacHash,
    });

  } catch (error) {
    logger.error('Single PDF generation failed', {
      jobId,
      documentId,
      error: error.message,
    });

    if (error.message === 'Job failed') {
      return res.status(500).json({
        error: 'PDF generation failed after retries',
        jobId,
        message: 'Please try again. If the problem persists, contact support.',
      });
    }

    if (error.message?.includes('timeout')) {
      return res.status(202).json({
        message: 'PDF generation is taking longer than expected',
        jobId,
        statusUrl: `/api/pdf/status/${jobId}`,
      });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/bulk', async (req, res) => {
  const { documents } = req.body;

  if (!Array.isArray(documents) || documents.length === 0) {
    return res.status(400).json({ error: 'documents must be a non-empty array' });
  }

  if (documents.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 documents per bulk request' });
  }

  for (const doc of documents) {
    if (!doc.type || !doc.documentId || !doc.data) {
      return res.status(400).json({
        error: `Invalid document: ${doc.documentId || 'unknown'}. Missing type, documentId, or data`
      });
    }
  }

  const batchId = uuidv4();
  const requestedAt = new Date().toISOString();

  try {
    await db.createBatch({
      batchId,
      totalDocuments: documents.length,
      requestedAt,
      status: 'queued',
    });

    const jobPromises = documents.map((doc, index) => {
      return bulkQueue.add(
        {
          batchId,
          jobIndex: index,
          totalInBatch: documents.length,
          type: doc.type,
          documentId: doc.documentId,
          data: JSON.parse(JSON.stringify(doc.data)),
          requestedAt,
        },
        {
          priority: 10,
          jobId: `${batchId}-${index}`,
        }
      );
    });

    await Promise.all(jobPromises);

    logger.info('Bulk job enqueued', {
      batchId,
      documentCount: documents.length,
    });

    return res.status(202).json({
      success: true,
      batchId,
      documentCount: documents.length,
      statusUrl: `/api/pdf/bulk/status/${batchId}`,
      progressUrl: `/api/pdf/bulk/progress/${batchId}`,
      message: 'Bulk generation started. Use statusUrl to poll or progressUrl for real-time updates.',
    });

  } catch (error) {
    logger.error('Failed to enqueue bulk jobs', { batchId, error: error.message });
    return res.status(500).json({ error: 'Failed to start bulk generation' });
  }
});

router.get('/bulk/status/:batchId', async (req, res) => {
  const { batchId } = req.params;

  try {
    const batch = await db.getBatch(batchId);

    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    return res.json({
      batchId,
      status: batch.status,
      totalDocuments: batch.total_documents,
      completed: batch.completed_count,
      failed: batch.failed_count,
      progress: Math.round((batch.completed_count / batch.total_documents) * 100),
      downloadUrl: batch.download_url || null,
      expiresAt: batch.download_expires_at || null,
      failedDocuments: batch.failed_document_ids || [],
      startedAt: batch.started_at,
      completedAt: batch.completed_at,
    });

  } catch (error) {
    logger.error('Failed to get batch status', { batchId, error: error.message });
    return res.status(500).json({ error: 'Failed to retrieve batch status' });
  }
});

router.get('/bulk/progress/:batchId', async (req, res) => {
  const { batchId } = req.params;
  const _lastEventId = req.headers['last-event-id'] || '0';

  const batch = await db.getBatch(batchId);
  if (!batch) {
    return res.status(404).json({ error: 'Batch not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const currentState = await db.getBatch(batchId);
  const eventId = Date.now();

  res.write(`id: ${eventId}\n`);
  res.write(`event: status\n`);
  res.write(`data: ${JSON.stringify({
    batchId,
    status: currentState.status,
    completed: currentState.completed_count,
    total: currentState.total_documents,
    progress: Math.round((currentState.completed_count / currentState.total_documents) * 100),
  })}\n\n`);

  const { createClient } = require('ioredis');
  const subscriber = new createClient({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  });

  const channel = `pdf-progress:${batchId}`;
  subscriber.subscribe(channel);

  subscriber.on('message', (chan, message) => {
    if (chan === channel) {
      const eventId = Date.now();
      res.write(`id: ${eventId}\n`);
      res.write(`event: progress\n`);
      res.write(`data: ${message}\n\n`);

      const data = JSON.parse(message);
      if (data.status === 'complete' || data.status === 'failed') {
        subscriber.unsubscribe(channel);
        subscriber.quit();
        res.end();
      }
    }
  });

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe(channel);
    subscriber.quit();
  });
});

router.get('/download/:documentId', async (req, res) => {
  const { documentId } = req.params;

  try {
    const metadata = await db.getPdfMetadata(documentId);

    if (!metadata) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { url, expiresAt } = await getSignedDownloadUrl(metadata.s3_key, 900);

    return res.json({
      documentId,
      downloadUrl: url,
      expiresAt,
      fileSize: metadata.file_size,
      generatedAt: metadata.generated_at,
      hmacHash: metadata.hmac_hash,
    });

  } catch (error) {
    logger.error('Failed to generate download URL', { documentId, error: error.message });
    return res.status(500).json({ error: 'Failed to generate download URL' });
  }
});

router.post('/verify', async (req, res) => {
  const { documentId } = req.body;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId is required' });
  }

  try {
    const metadata = await db.getPdfMetadata(documentId);

    if (!metadata) {
      return res.status(404).json({ error: 'Document not found in records' });
    }

    const { downloadPdfFromS3 } = require('../services/storage');
    const pdfBytes = await downloadPdfFromS3(metadata.s3_key);

    const isValid = verifyHMAC(pdfBytes, metadata.hmac_hash);

    return res.json({
      documentId,
      valid: isValid,
      generatedAt: metadata.generated_at,
      verifiedAt: new Date().toISOString(),
      documentType: metadata.document_type,
      ...(isValid ? {} : {
        warning: 'HMAC verification failed. This PDF may have been tampered with.',
      }),
    });

  } catch (error) {
    logger.error('Verification failed', { documentId, error: error.message });
    return res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = router;
