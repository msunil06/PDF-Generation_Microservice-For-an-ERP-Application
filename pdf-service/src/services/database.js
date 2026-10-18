const { Pool } = require('pg');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL client error', { error: err.message });
});

async function savePdfMetadata({ documentId, jobId, batchId, type, s3Key, fileSize, hmacHash, generatedAt }) {
  const query = `
    INSERT INTO pdf_metadata 
      (document_id, job_id, batch_id, document_type, s3_key, file_size, hmac_hash, generated_at, requested_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (document_id, generated_at) DO UPDATE
    SET s3_key = EXCLUDED.s3_key,
        hmac_hash = EXCLUDED.hmac_hash,
        file_size = EXCLUDED.file_size
    RETURNING id
  `;
  
  const result = await pool.query(query, [
    documentId, jobId || null, batchId || null, type, s3Key, fileSize, hmacHash, generatedAt
  ]);
  
  return result.rows[0];
}

async function getPdfMetadata(documentId) {
  const result = await pool.query(
    `SELECT * FROM pdf_metadata 
     WHERE document_id = $1 
     ORDER BY generated_at DESC 
     LIMIT 1`,
    [documentId]
  );
  return result.rows[0] || null;
}

async function createBatch({ batchId, totalDocuments, requestedAt, status }) {
  await pool.query(
    `INSERT INTO pdf_batches (batch_id, total_documents, requested_at, status)
     VALUES ($1, $2, $3, $4)`,
    [batchId, totalDocuments, requestedAt, status]
  );
}

async function getBatch(batchId) {
  const result = await pool.query(
    'SELECT * FROM pdf_batches WHERE batch_id = $1',
    [batchId]
  );
  return result.rows[0] || null;
}

async function updateBatch(batchId, fields) {
  const setClauses = Object.keys(fields)
    .map((key, i) => `${camelToSnake(key)} = $${i + 2}`)
    .join(', ');
  
  await pool.query(
    `UPDATE pdf_batches SET ${setClauses} WHERE batch_id = $1`,
    [batchId, ...Object.values(fields)]
  );
}

async function incrementBatchProgress(batchId, type, failedDocumentId = null) {
  const result = await pool.query(
    'SELECT * FROM increment_batch_progress($1, $2, $3)',
    [batchId, type, failedDocumentId]
  );
  return result.rows[0];
}

async function getBatchPdfs(batchId) {
  const result = await pool.query(
    `SELECT * FROM pdf_metadata 
     WHERE batch_id = $1 
     ORDER BY generated_at`,
    [batchId]
  );
  return result.rows;
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

module.exports = {
  savePdfMetadata,
  getPdfMetadata,
  createBatch,
  getBatch,
  updateBatch,
  incrementBatchProgress,
  getBatchPdfs,
};
