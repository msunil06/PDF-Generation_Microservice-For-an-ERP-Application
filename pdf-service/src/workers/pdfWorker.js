const { singleQueue, bulkQueue } = require('../queues');
const { generatePDF } = require('../services/pdfGenerator');
const { computeHMAC, embedHashInMetadata } = require('../services/signer');
const { uploadPdf, getSignedDownloadUrl, getPdfS3Key } = require('../services/storage');
const db = require('../services/database');
const logger = require('../utils/logger');

const SINGLE_CONCURRENCY = 4;
const BULK_CONCURRENCY = 4;

singleQueue.process(SINGLE_CONCURRENCY, async (job) => {
  const { jobId, type, documentId, data, requestedAt } = job.data;

  logger.info('Processing single PDF job', {
    jobId,
    documentId,
    type,
    attemptNumber: job.attemptsMade + 1,
  });

  try {
    const startTime = Date.now();
    const pdfBuffer = await generatePDF({ type, documentId, data });
    const renderTime = Date.now() - startTime;

    logger.info('PDF rendered', { documentId, renderTime, size: pdfBuffer.length });

    const hmacHash = computeHMAC(pdfBuffer);

    const signedPdfBuffer = embedHashInMetadata(pdfBuffer, hmacHash, documentId);

    const s3Key = getPdfS3Key(documentId, type, requestedAt);
    await uploadPdf(signedPdfBuffer, s3Key, {
      documentId,
      type,
      hmacHash,
      generatedAt: new Date().toISOString(),
    });

    const { url: downloadUrl, expiresAt } = await getSignedDownloadUrl(s3Key, 900);

    await db.savePdfMetadata({
      documentId,
      jobId,
      type,
      s3Key,
      fileSize: signedPdfBuffer.length,
      hmacHash,
      generatedAt: new Date().toISOString(),
    });

    logger.info('Single PDF job complete', {
      documentId,
      totalTime: Date.now() - startTime,
      fileSize: signedPdfBuffer.length,
    });

    return {
      downloadUrl,
      expiresAt,
      fileSize: signedPdfBuffer.length,
      hmacHash,
      s3Key,
    };

  } catch (error) {
    logger.error('Single PDF job failed', {
      jobId,
      documentId,
      attempt: job.attemptsMade + 1,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
});

bulkQueue.process(BULK_CONCURRENCY, async (job) => {
  const { batchId, jobIndex, totalInBatch, type, documentId, data, requestedAt } = job.data;

  logger.info('Processing bulk PDF job', {
    batchId,
    jobIndex: `${jobIndex + 1}/${totalInBatch}`,
    documentId,
    type,
  });

  try {
    if (jobIndex === 0) {
      await db.updateBatch(batchId, { status: 'processing', startedAt: new Date().toISOString() });
    }

    const pdfBuffer = await generatePDF({ type, documentId, data });

    const hmacHash = computeHMAC(pdfBuffer);
    const signedPdfBuffer = embedHashInMetadata(pdfBuffer, hmacHash, documentId);

    const s3Key = getPdfS3Key(documentId, type, requestedAt);
    await uploadPdf(signedPdfBuffer, s3Key, {
      documentId,
      type,
      hmacHash,
      generatedAt: new Date().toISOString(),
      batchId,
    });

    await db.savePdfMetadata({
      documentId,
      batchId,
      type,
      s3Key,
      fileSize: signedPdfBuffer.length,
      hmacHash,
      generatedAt: new Date().toISOString(),
    });

    const { completed, failed, total } = await db.incrementBatchProgress(batchId, 'completed');

    const progressData = {
      batchId,
      completed,
      failed,
      total,
      status: completed + failed === total ? 'assembling_zip' : 'processing',
      progress: Math.round(((completed + failed) / total) * 100),
      lastCompletedDocumentId: documentId,
    };

    await publishProgress(batchId, progressData);

    if (completed + failed === total) {
      await assembleBatchZip(batchId, total, completed, failed);
    }

    return { success: true, documentId, s3Key };

  } catch (error) {
    logger.error('Bulk PDF job failed', {
      batchId,
      jobIndex,
      documentId,
      attempt: job.attemptsMade + 1,
      error: error.message,
    });

    if (job.attemptsMade + 1 >= job.opts.attempts) {
      const { completed, failed, total } = await db.incrementBatchProgress(batchId, 'failed', documentId);

      await publishProgress(batchId, {
        batchId,
        completed,
        failed,
        total,
        status: completed + failed === total ? 'assembling_zip' : 'processing',
        progress: Math.round(((completed + failed) / total) * 100),
        failedDocumentId: documentId,
      });

      if (completed + failed === total) {
        await assembleBatchZip(batchId, total, completed, failed);
      }
    }

    throw error;
  }
});

async function assembleBatchZip(batchId, total, completed, failed) {
  const archiver = require('archiver');
  const { PassThrough } = require('stream');
  const { uploadZipStream, getSignedDownloadUrl, getZipS3Key } = require('../services/storage');

  logger.info('Assembling batch ZIP', { batchId, completed, failed, total });

  try {
    await db.updateBatch(batchId, { status: 'assembling_zip' });

    const pdfMetadataList = await db.getBatchPdfs(batchId);

    if (pdfMetadataList.length === 0) {
      await db.updateBatch(batchId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
      });
      await publishProgress(batchId, { batchId, status: 'failed', completed, failed, total });
      return;
    }

    const archive = archiver('zip', {
      zlib: { level: 6 },
    });

    const passThrough = new PassThrough();
    archive.pipe(passThrough);

    const uploadPromise = uploadZipStream(passThrough, batchId);

    const AWS = require('aws-sdk');
    const s3Client = new AWS.S3({ region: process.env.AWS_REGION || 'ap-south-1' });

    const manifest = {
      batchId,
      generatedAt: new Date().toISOString(),
      totalDocuments: total,
      successfulDocuments: completed,
      failedDocuments: failed,
      documents: [],
    };

    for (const pdfMeta of pdfMetadataList) {
      const s3Stream = s3Client.getObject({
        Bucket: process.env.S3_BUCKET || 'erp-pdfs-prod',
        Key: pdfMeta.s3_key,
      }).createReadStream();

      const fileName = `${pdfMeta.document_type}_${pdfMeta.document_id}.pdf`;
      archive.append(s3Stream, { name: fileName });

      manifest.documents.push({
        documentId: pdfMeta.document_id,
        type: pdfMeta.document_type,
        fileName,
        hmacHash: pdfMeta.hmac_hash,
        generatedAt: pdfMeta.generated_at,
      });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    await archive.finalize();

    await uploadPromise;

    const zipS3Key = getZipS3Key(batchId);
    const { url: downloadUrl, expiresAt } = await getSignedDownloadUrl(zipS3Key, 86400);

    const finalStatus = failed > 0 ? 'partial_complete' : 'complete';
    await db.updateBatch(batchId, {
      status: finalStatus,
      downloadUrl,
      downloadExpiresAt: expiresAt,
      completedAt: new Date().toISOString(),
    });

    await publishProgress(batchId, {
      batchId,
      status: finalStatus,
      completed,
      failed,
      total,
      downloadUrl,
      expiresAt,
      message: failed > 0
        ? `${completed} of ${total} PDFs generated successfully. ${failed} failed.`
        : `All ${total} PDFs generated successfully.`,
    });

    logger.info('Batch ZIP assembly complete', {
      batchId,
      zipS3Key,
      documentsIncluded: pdfMetadataList.length,
    });

  } catch (error) {
    logger.error('ZIP assembly failed', { batchId, error: error.message });

    await db.updateBatch(batchId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
    });

    await publishProgress(batchId, { batchId, status: 'failed', error: error.message });
  }
}

async function publishProgress(batchId, data) {
  const Redis = require('ioredis');
  const publisher = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
    keyPrefix: 'pdf-svc:',
  });

  try {
    await publisher.publish(`pdf-progress:${batchId}`, JSON.stringify(data));
  } finally {
    publisher.disconnect();
  }
}

logger.info('Workers initialized', {
  singleConcurrency: SINGLE_CONCURRENCY,
  bulkConcurrency: BULK_CONCURRENCY,
});
