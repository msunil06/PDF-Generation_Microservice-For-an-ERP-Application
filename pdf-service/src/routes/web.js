const express = require('express');
const { generatePDF } = require('../services/pdfGenerator');
const { computeHMAC, verifyHMAC } = require('../services/signer');
const logger = require('../utils/logger');
const db = require('../services/database');

const router = express.Router();

router.post('/generate', async (req, res) => {
  const { type, documentId, data, format } = req.body;

  if (!type || !documentId || !data) {
    return res.status(400).json({ error: 'Missing required fields: type, documentId, data' });
  }

  if (!['purchase_order', 'invoice'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type. Must be "purchase_order" or "invoice"' });
  }

  const startTime = Date.now();

  try {
    logger.info('Web PDF generation requested', { documentId, type });

    const pdfBuffer = await generatePDF({ type, documentId, data });
    const renderTime = Date.now() - startTime;

    const hmacHash = computeHMAC(pdfBuffer);

    try {
      await db.savePdfMetadata({
        documentId,
        jobId: null,
        batchId: null,
        type,
        s3Key: `local/${type}/${documentId}.pdf`,
        fileSize: pdfBuffer.length,
        hmacHash,
        generatedAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      logger.debug('Database metadata storage skipped (local mode)', { error: dbErr.message });
    }

    if (format === 'binary' || req.query.download === '1') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${documentId}.pdf"`);
      res.setHeader('X-HMAC-SHA256', hmacHash);
      return res.send(pdfBuffer);
    }

    return res.json({
      success: true,
      documentId,
      type,
      fileSize: pdfBuffer.length,
      hmacHash,
      renderTimeMs: renderTime,
      generatedAt: new Date().toISOString(),
      pdfBase64: pdfBuffer.toString('base64'),
    });

  } catch (error) {
    logger.error('Web PDF generation failed', { documentId, error: error.message });
    return res.status(500).json({
      error: 'Failed to generate PDF',
      message: error.message,
    });
  }
});

router.post('/verify', async (req, res) => {
  const { pdfBase64, expectedHash } = req.body;

  if (!pdfBase64 || !expectedHash) {
    return res.status(400).json({ error: 'Missing pdfBase64 or expectedHash in request body' });
  }

  try {
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const computedHash = computeHMAC(pdfBuffer);
    const isValid = verifyHMAC(pdfBuffer, expectedHash);

    return res.json({
      verified: isValid,
      computedHash,
      expectedHash,
      message: isValid
        ? 'Document verified! Cryptographic HMAC matches. The document has NOT been modified.'
        : 'Tamper Alert! The document hash does NOT match. The document may have been altered.',
    });
  } catch (error) {
    logger.error('Verification error', { error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
