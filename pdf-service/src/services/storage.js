const AWS = require('aws-sdk');
const path = require('path');
const logger = require('../utils/logger');

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'ap-south-1',
  signatureVersion: 'v4',
});

const BUCKET_NAME = process.env.S3_BUCKET || 'erp-pdfs-prod';

function getPdfS3Key(documentId, type, requestedAt) {
  const date = new Date(requestedAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `pdfs/${year}/${month}/${type}/${documentId}.pdf`;
}

function getZipS3Key(batchId) {
  return `bulk/${batchId}/bundle.zip`;
}

async function uploadPdf(pdfBuffer, s3Key, metadata = {}) {
  logger.debug('Uploading PDF to S3', { s3Key, size: pdfBuffer.length });

  const params = {
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
    ContentDisposition: `attachment; filename="${path.basename(s3Key)}"`,
    ServerSideEncryption: 'AES256',
    Metadata: {
      'document-id': metadata.documentId || '',
      'document-type': metadata.type || '',
      'hmac-hash': metadata.hmacHash || '',
      'generated-at': metadata.generatedAt || new Date().toISOString(),
      'service-version': '1.0.0',
    },
  };

  const result = await s3.upload(params).promise();

  logger.info('PDF uploaded to S3', {
    s3Key,
    location: result.Location,
    eTag: result.ETag,
    size: pdfBuffer.length,
  });

  return {
    s3Key: result.Key,
    eTag: result.ETag,
    location: result.Location,
  };
}

async function getSignedDownloadUrl(s3Key, expiresIn = 900) {
  const url = await s3.getSignedUrlPromise('getObject', {
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Expires: expiresIn,
    ResponseContentType: 'application/pdf',
    ResponseContentDisposition: `attachment; filename="${path.basename(s3Key)}"`,
  });

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  return { url, expiresAt };
}

async function downloadPdfFromS3(s3Key) {
  const result = await s3.getObject({
    Bucket: BUCKET_NAME,
    Key: s3Key,
  }).promise();

  return result.Body;
}

async function uploadZipStream(zipStream, batchId) {
  const s3Key = getZipS3Key(batchId);

  logger.info('Starting streaming ZIP upload to S3', { s3Key });

  const params = {
    Bucket: BUCKET_NAME,
    Key: s3Key,
    Body: zipStream,
    ContentType: 'application/zip',
    ContentDisposition: `attachment; filename="documents-${batchId}.zip"`,
    ServerSideEncryption: 'AES256',
    Metadata: {
      'batch-id': batchId,
      'generated-at': new Date().toISOString(),
    },
  };

  const result = await s3.upload(params, {
    partSize: 10 * 1024 * 1024,
    queueSize: 2,
  }).promise();

  logger.info('ZIP uploaded to S3', { s3Key, location: result.Location });

  return { s3Key, location: result.Location };
}

module.exports = {
  uploadPdf,
  getSignedDownloadUrl,
  downloadPdfFromS3,
  uploadZipStream,
  getPdfS3Key,
  getZipS3Key,
};
