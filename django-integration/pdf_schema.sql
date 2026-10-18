CREATE TABLE IF NOT EXISTS pdf_metadata (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     VARCHAR(100) NOT NULL,
    document_type   VARCHAR(20) NOT NULL,
    job_id          UUID,
    batch_id        UUID,
    
    s3_key          VARCHAR(500) NOT NULL,
    file_size       INTEGER NOT NULL,
    
    hmac_hash       VARCHAR(64) NOT NULL,
    hmac_key_version VARCHAR(10) DEFAULT 'v1',
    
    template_name   VARCHAR(100),
    
    requested_at    TIMESTAMPTZ NOT NULL,
    generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    requested_by_id INTEGER REFERENCES auth_user(id),
    
    CONSTRAINT pdf_metadata_document_unique UNIQUE (document_id, generated_at)
);

CREATE INDEX idx_pdf_metadata_document_id ON pdf_metadata (document_id);
CREATE INDEX idx_pdf_metadata_batch_id ON pdf_metadata (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_pdf_metadata_generated_at ON pdf_metadata (generated_at DESC);
CREATE INDEX idx_pdf_metadata_document_type ON pdf_metadata (document_type);

CREATE TABLE IF NOT EXISTS pdf_batches (
    batch_id            UUID PRIMARY KEY,
    status              VARCHAR(20) NOT NULL DEFAULT 'queued',
    
    total_documents     INTEGER NOT NULL,
    completed_count     INTEGER NOT NULL DEFAULT 0,
    failed_count        INTEGER NOT NULL DEFAULT 0,
    
    download_url        TEXT,
    download_expires_at TIMESTAMPTZ,
    
    failed_document_ids TEXT[],
    
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    
    requested_by_id     INTEGER REFERENCES auth_user(id),
    
    CONSTRAINT pdf_batches_status_check CHECK (
        status IN ('queued', 'processing', 'assembling_zip', 'partial_complete', 'complete', 'failed')
    )
);

CREATE INDEX idx_pdf_batches_status ON pdf_batches (status);
CREATE INDEX idx_pdf_batches_requested_at ON pdf_batches (requested_at DESC);

CREATE OR REPLACE FUNCTION increment_batch_progress(
    p_batch_id UUID,
    p_increment_type VARCHAR(10),
    p_failed_document_id VARCHAR(100) DEFAULT NULL
)
RETURNS TABLE (completed INTEGER, failed INTEGER, total INTEGER)
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_increment_type = 'completed' THEN
        UPDATE pdf_batches
        SET completed_count = completed_count + 1
        WHERE batch_id = p_batch_id;
    ELSIF p_increment_type = 'failed' THEN
        UPDATE pdf_batches
        SET 
            failed_count = failed_count + 1,
            failed_document_ids = CASE 
                WHEN p_failed_document_id IS NOT NULL 
                THEN array_append(COALESCE(failed_document_ids, '{}'), p_failed_document_id)
                ELSE failed_document_ids
            END
        WHERE batch_id = p_batch_id;
    END IF;
    
    RETURN QUERY
    SELECT completed_count, failed_count, total_documents
    FROM pdf_batches
    WHERE batch_id = p_batch_id;
END;
$$;
