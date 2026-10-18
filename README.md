# PDF Generation Microservice — ERP Integration

A production-ready PDF generation microservice for an ERP application that handles both individual and bulk document generation using **Node.js**, **Puppeteer**, **Bull**, and **AWS S3**.

---

## Architecture Overview

See [architecture-diagram.svg](./architecture-diagram.svg) for the full system diagram.

```
ERP Clients
    │
    ▼ HTTPS
Django Monolith (EC2 r6i.large)
    │── POST /api/pdf/generate    → PDF Microservice (single)
    │── POST /api/pdf/bulk        → PDF Microservice (batch)
    │── GET  /api/pdf/status/:id  → Redis pub/sub → SSE to client
    │── GET  /api/pdf/download/:id → Signed S3 URL
    │
    ├── PostgreSQL RDS  (pdf_metadata, pdf_batches tables)
    └── Redis           (Bull queue + SSE pub/sub)
            │
            ▼
    PDF Microservice (EC2 t3.medium)
    │── Express API Gateway
    │── Bull Queue Manager (pdf-single + pdf-bulk queues)
    │── Puppeteer Worker Pool (4 workers, 512MB each)
    │── Template Engine (Handlebars)
    │── PDF Signer (HMAC-SHA256)
    └── ZIP Assembler (streaming → S3)
            │
            ▼
    AWS S3 (erp-pdfs-prod)
    │── pdfs/{year}/{month}/{type}/{uuid}.pdf
    └── bulk/{batchId}/bundle.zip
```

---

## Key Design Decisions

| Problem | Solution |
|---------|----------|
| OOM on 500+ row documents | Chunked HTML rendering (150 rows/chunk) + pdf-lib merge |
| Unreliable client connectivity | Pre-built ZIP in S3, stable signed URLs, HTTP Range support |
| Stale data in bulk generation | Data snapshot frozen at request time (freeze pattern) |
| Tamper evidence | HMAC-SHA256 of PDF bytes, stored in DB + embedded in XMP metadata |
| Budget (₹12,500/mo) | Single t3.medium instance + shared Redis + S3 lifecycle rules |

---

## Project Structure

```
pdf-service/
├── src/
│   ├── index.js              # Express server + Bull Board
│   ├── queues.js             # Bull queue configuration
│   ├── routes/
│   │   ├── pdf.js            # PDF API endpoints
│   │   └── health.js         # Health check
│   ├── workers/
│   │   └── pdfWorker.js      # Bull job processors + ZIP assembly
│   ├── services/
│   │   ├── pdfGenerator.js   # Puppeteer + chunked rendering
│   │   ├── signer.js         # HMAC-SHA256 tamper evidence
│   │   ├── storage.js        # AWS S3 upload/download
│   │   └── database.js       # PostgreSQL metadata storage
│   └── utils/
│       └── logger.js         # Winston structured logging
├── templates/
│   ├── purchase_order.hbs    # Handlebars PO template
│   └── invoice.hbs           # GST-compliant invoice template
├── tests/
│   └── pdf.test.js           # Unit + integration tests
├── Dockerfile                # Multi-stage Docker build
├── .env.example              # Environment variables template
└── package.json

django-integration/
├── pdf_views.py              # Django views integrating with PDF service
└── pdf_schema.sql            # PostgreSQL schema (add to existing DB)
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker (for production)
- Redis (shared with Django)
- PostgreSQL (shared with Django)
- AWS Account with S3 bucket

### Local Development

```bash
# 1. Install dependencies
cd pdf-service
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values

# 3. Apply database schema
psql $DATABASE_URL -f ../django-integration/pdf_schema.sql

# 4. Start the service
npm run dev
```

The service starts on `http://localhost:3001`.

**Bull Board** (queue monitor) available at: `http://localhost:3001/admin/queues`

### Production (Docker)

```bash
# Build image
docker build -t pdf-microservice ./pdf-service

# Run container
docker run -d \
  --name pdf-service \
  -p 3001:3001 \
  --env-file ./pdf-service/.env \
  --restart unless-stopped \
  pdf-microservice
```

---

## API Reference

### Single PDF Generation

```http
POST /api/pdf/generate
X-API-Key: {PDF_SERVICE_API_KEY}
Content-Type: application/json

{
  "type": "purchase_order",
  "documentId": "PO-2024-001",
  "data": { ... }
}
```

**Response (200):**
```json
{
  "success": true,
  "jobId": "uuid",
  "documentId": "PO-2024-001",
  "downloadUrl": "https://s3.ap-south-1.amazonaws.com/erp-pdfs-prod/...",
  "expiresAt": "2024-01-01T12:15:00Z",
  "fileSize": 524288,
  "hmacHash": "abc123..."
}
```

### Bulk PDF Generation

```http
POST /api/pdf/bulk
X-API-Key: {PDF_SERVICE_API_KEY}
Content-Type: application/json

{
  "documents": [
    { "type": "purchase_order", "documentId": "PO-001", "data": { ... } },
    ...
  ]
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "batchId": "uuid",
  "documentCount": 50,
  "statusUrl": "/api/pdf/bulk/status/{batchId}",
  "progressUrl": "/api/pdf/bulk/progress/{batchId}"
}
```

### Real-time Progress (SSE)

```http
GET /api/pdf/bulk/progress/{batchId}
Accept: text/event-stream
Last-Event-ID: {lastEventId}
```

Events are streamed as the batch progresses. Client reconnects using `Last-Event-ID` header.

### Download Re-request

```http
GET /api/pdf/download/{documentId}
```

Generates a fresh signed S3 URL (15 min TTL) — handles re-download after connectivity failure.

### Tamper Verification

```http
POST /api/pdf/verify
Content-Type: application/json

{ "documentId": "PO-2024-001" }
```

**Response:**
```json
{
  "documentId": "PO-2024-001",
  "valid": true,
  "generatedAt": "2024-01-01T12:00:00Z",
  "verifiedAt": "2024-01-01T14:30:00Z"
}
```

### Health Check

```http
GET /health
```

---

## Scenario Constraints — How We Handle Them

### 1. OOM on 500+ Row Documents
- Row count checked before rendering
- If `count > 200`: HTML split into 150-row chunks
- Each chunk rendered as separate Puppeteer job
- Chunks merged using `pdf-lib`
- Worker hard-limited to 512MB RAM

### 2. Unreliable Client Connectivity
- ZIP assembled **server-side** before client download
- Stable S3 signed URL valid 24h for bulk downloads
- HTTP `Range` requests on S3 allow resume
- ZIP stored in S3 for 24 hours (re-downloadable)

### 3. Data Consistency (Stale PDF Bug)
- Django serializes **full data payload at request time**
- All 100 PDF jobs receive the same frozen data snapshot
- No database re-reads during rendering
- PDF reflects exact state at time of user's request

### 4. Tamper Evidence
- `HMAC-SHA256(pdf_bytes, server_secret)` computed after generation
- Hash stored in PostgreSQL `pdf_metadata.hmac_hash`
- Hash also embedded in PDF XMP metadata (for offline verification)
- Verify via `POST /api/pdf/verify`

### 5. Budget (₹12,500/month)
- **Estimated cost: ~₹3,181/month (~$38)** — 75% under budget
- Single t3.medium for PDF service (~$30/month)
- S3 with lifecycle rules (~$3/month year-1)
- Shares existing Redis + PostgreSQL infrastructure

---

## Running Tests

```bash
cd pdf-service
npm test
```

---

## Deployment Checklist

- [ ] Set `PDF_HMAC_SECRET` to a 32+ char random string (store in AWS Secrets Manager)
- [ ] Set `PDF_SERVICE_API_KEY` to a strong random string
- [ ] Configure S3 bucket with lifecycle rules (see `pdf_schema.sql` comments)
- [ ] Apply database schema: `psql $DATABASE_URL -f django-integration/pdf_schema.sql`
- [ ] Attach IAM role to EC2 instance with S3 read/write permissions
- [ ] Configure security group to allow Django server → port 3001 (VPC internal only)
- [ ] Set up CloudWatch Logs agent to capture container stdout

---

## Cost Breakdown (Monthly)

| Component | Cost (USD) | Cost (INR) |
|-----------|-----------|-----------|
| EC2 t3.medium (PDF service) | $30.37 | ₹2,521 |
| S3 storage (lifecycle-managed) | $3.20 | ₹266 |
| S3 API calls | $0.15 | ₹12 |
| CloudWatch Logs | $2.50 | ₹208 |
| AWS Secrets Manager | $0.40 | ₹33 |
| **Total** | **$36.62** | **₹3,039** |

Budget: ₹12,500 | Headroom: ₹9,461 (76%)
