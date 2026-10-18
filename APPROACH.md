# Approach Document
## PDF Generation Microservice for an ERP Application

---

## 1. Initial Understanding

> Before using any AI tools or doing research, what was your initial read of this problem? What did you think the hard parts were?

My first read flagged three categories of hard problems:

**Infrastructure ceiling first.** The constraint I circled first was "existing EC2 r6i.large." That single machine is the entire ERP. Adding a PDF service that eats 400MB per render naively would OOM the monolith. So isolation (separate process, separate machine) is non-negotiable even before I thought about architecture.

**The bulk concurrency math looked scary.** 100 PDFs × 2–3s each × 400MB each = 40GB memory if naively parallelized. That immediately tells me I need a bounded worker pool, not "spawn one process per request." I knew a queue was mandatory.

**The unreliable-internet problem is often ignored.** Engineers typically build "generate → stream to client." If the client disconnects at PDF #70, the work is wasted and the user has nothing. I recognized this means the ZIP must be pre-assembled server-side, stored durably, and re-downloadable via a stable URL — not streamed live.

**Stale data in bulk operations.** The 87th PDF stale data problem is a classic "time-of-check vs. time-of-use" bug. The fix I immediately thought of: serialize the full data payload at request time, not at render time.

**Tamper evidence without a PKI.** The first instinct might be "use digital signatures / X.509." But that's heavy. HMAC-SHA256 over the PDF bytes with a server-side secret key gives tamper evidence without the certificate management overhead — appropriate for this scale.

---

## 2. Assumptions & Clarifying Questions

> List any assumptions you made. In a real scenario, what questions would you ask?

### Assumptions I Made

| # | Assumption | Rationale |
|---|-----------|-----------|
| 1 | The PDF service runs on a **separate** EC2 instance from the Django monolith | Adding 4× 400MB Puppeteer workers to the same r6i.large that runs Django + PostgreSQL is not viable |
| 2 | The existing Redis instance can be **shared** for the Bull queue | The problem statement says Django already uses Redis; sharing avoids new infra cost |
| 3 | S3 is available (AWS environment assumed) | Cost-effective, durable, supports signed URLs and resumable downloads |
| 4 | "Tamper-evident" means auditability, not legal non-repudiation | If legal non-repudiation were required, we'd need qualified e-signatures (DSC in India context) |
| 5 | 30,000 PDFs/month is the **total**, not per-customer | Problem states it as the total load for cost calculation |
| 6 | The 1000 req/min peak is **sustained** for minutes, not just a 1-second burst | Determines queue depth requirements |
| 7 | Average PDF size is ~500KB (midpoint of 100KB–1MB range) | Used for storage math |
| 8 | The Django monolith calls the PDF service via internal HTTP (VPC-internal) | Avoids public internet latency and egress costs |
| 9 | No real-time streaming of PDFs is required | PDFs are stored → URL returned; not piped byte-by-byte |
| 10 | 7-year retention for compliance (common for GST in India) | Standard under Indian GST rules |

### Questions I'd Ask Before Starting

1. **Who calls the PDF service — Django backend or directly from the browser?** (Affects auth model: service-to-service JWT vs. user session token)
2. **Is the "1000 req/min" already accounting for retries, or is that new unique requests?** (Changes queue depth math)
3. **What's the acceptable bulk completion time SLA?** 5 min? 30 min? This determines worker count.
4. **Is the Redis instance ElastiCache or self-managed?** (Affects HA strategy)
5. **Do we need a "cancel bulk job" feature?** (Complexity adder)
6. **Is GST invoice a legally signed document under IRP (Invoice Registration Portal)?** If so, HMAC is not sufficient — we'd need IRN/QR code integration.
7. **What's the document retention policy?** 7 years assumed for GST compliance.
8. **Is there a need to regenerate a PDF for the same PO after data corrections?** (Version history requirement)
9. **Are there multiple Django app servers (ELB + ASG) or truly a single instance?** Affects where the SSE connection must land.
10. **Budget: is ₹12,500 inclusive of the existing Django infra or just the new PDF service?** I assumed it covers just the new service.

---

## 3. Capacity Planning & Math

> Show your calculations.

### 3.1 Single Request Throughput

```
Peak load:    1,000 req/min
Per second:   1,000 / 60 ≈ 17 req/sec
Render time:  2–3 seconds per PDF

Concurrent workers needed to keep up in real-time:
  17 req/sec × 2.5s avg = ~42 concurrent Puppeteer instances

Memory for 42 workers:
  42 × 400MB = 16.8GB  ← Not viable on any single t3.x instance
```

**Conclusion:** We cannot keep up with peak in real-time with a single node. This is **by design** — we use a queue. At peak, the queue builds up and drains between peaks. Let's size for sustainable throughput that keeps queue drain time acceptable:

```
Worker count:   4 workers (cost-constrained)
Throughput:     4 workers × (1 PDF / 2.5s) = 1.6 PDF/sec = 96 PDF/min

At 1000 req/min peak:
  Queue accumulation rate: 1000 - 96 = 904 jobs/min

If peak lasts 5 minutes:
  Queue depth: 904 × 5 = 4,520 jobs
  Drain time after peak: 4,520 / 96 ≈ 47 minutes

If peak lasts 1 minute:
  Queue depth: 904 jobs → cleared in ~9.4 minutes
```

**Honest tradeoff:** 4 workers can't serve 1000 req/min in real-time. Single PDFs will wait in queue during peak. The 5-second SLA applies to **starting** the download, not necessarily immediate delivery. For single PDFs, we can pre-prioritize the `pdf-single` queue with higher priority than bulk jobs to keep wait times low.

**If the 1000 req/min SLA is strict (< 5s):** We'd need to scale horizontally — multiple PDF service instances. On the current budget, this is at the edge of feasibility. I'd flag this risk explicitly to the product team.

### 3.2 Memory Budget

```
PDF Service instance: t3.medium (2 vCPU, 4GB RAM)

4 × Puppeteer workers:     4 × 400MB = 1,600 MB
Node.js heap + Bull:              512 MB
OS + kernel + libs:               384 MB
Buffer / headroom:                504 MB
                           ─────────────
Total:                          3,000 MB  ✓ Fits in 4GB with headroom
```

**For OOM protection on 500+ row documents:**
Each chunk render is isolated within its worker. Max chunk size is 150 rows, which stays under 400MB. The pdf-lib merge step is CPU-heavy but low-memory (streaming merge).

### 3.3 Bulk Request Analysis

```
Max bulk:    100 PDFs per request
At 5–10 bulk req/min:
  Jobs created: 500–1000 PDF jobs/min (similar to single peak)
  But bulk jobs have lower priority queue → singles always go first

Each bulk batch completion time:
  100 PDFs / 4 workers = 25 rounds
  25 × 2.5s = 62.5 seconds sequential
  With 4 parallel workers: ~62.5s total (workers process 4 at a time)
  → Bulk batch completes in ~63 seconds (ideal, no queue wait)
```

### 3.4 Storage Math

```
PDFs/month:           30,000
Avg PDF size:         500KB (midpoint of 100KB–1MB)
Monthly new data:     30,000 × 500KB = 15GB/month

1-year accumulation:  15GB × 12 = 180GB
7-year accumulation:  15GB × 84 = 1,260GB ≈ 1.26TB

S3 pricing (ap-south-1, Mumbai):
  Standard:    $0.025/GB → 180GB → $4.50/mo (year 1)
  IA:          $0.0138/GB → data after 30 days moves to IA
  Glacier IR:  $0.005/GB → data after 90 days
```

**S3 Lifecycle strategy:**
- 0–30 days: S3 Standard ($0.025/GB) — frequent access
- 31–90 days: S3 Standard-IA ($0.0138/GB)
- 91+ days: Glacier Instant Retrieval ($0.005/GB)
- After 7 years: Delete

### 3.5 Network / Bandwidth

```
PDF downloads:
  30,000 × 500KB = 15GB/month outbound
  S3 egress (first 100GB free in India region): $0

Bulk ZIPs:
  Assume 10 bulk jobs/day × 30 days × avg 20 PDFs × 500KB
  = 10 × 30 × 20 × 500KB = 3,000MB = ~3GB/month ZIP traffic

Total egress: ~18GB/month → within S3 free tier for first 100GB
```

### 3.6 Redis Queue Depth

```
At peak with 4 workers:
  Max queue depth (sustained 5-min peak): ~4,520 jobs
  Each job metadata: ~2KB
  Memory for queue: 4,520 × 2KB = ~9MB ← trivial for Redis
```

---

## 4. Design Decisions

### Decision 1: Separate EC2 Instance for PDF Service

**Alternatives considered:**
- Run Puppeteer inside the Django monolith (subprocess or celery task)
- Lambda functions (serverless) for each PDF render
- ECS Fargate containers

**Chosen approach:** Dedicated EC2 `t3.medium` running the Node.js PDF microservice as a Docker container.

**Why:**
- Running Puppeteer inside the existing `r6i.large` risks OOM-killing the Django process. The Django monolith's 16GB is already shared with its own workload and the PostgreSQL connection pool.
- Lambda was tempting but Puppeteer's binary size (~270MB) plus the 15-min timeout limit and cold start latency (1–3s just for Lambda init) make it unsuitable for the < 5s SLA on singles. Also, Lambda pricing at 30,000 PDFs/month @ 3s @ 512MB = ~$7 (Lambada cost) but the 15-minute max duration breaks long bulk jobs.
- ECS Fargate is a good option but adds complexity (ECR, task definitions, VPC configuration) and costs more than a simple EC2 instance at this scale. The Fargate overhead cost (~$12–15/month vs $9/month for t3.medium) isn't justified at this scale.
- A single `t3.medium` (2 vCPU, 4GB RAM, ~$30/month in Mumbai region) is the right-sized, operationally simple choice.

**Tradeoff accepted:** No auto-scaling. If load permanently grows 3–4×, we'd need to move to ECS with auto-scaling. For the current scale and budget, manual vertical scaling (t3.large) is the simpler path.

---

### Decision 2: Bull Queue with Redis (Not SQS, Not RabbitMQ)

**Alternatives considered:**
- AWS SQS + Lambda workers
- RabbitMQ (self-managed)
- Celery (Python, within Django)
- Direct async processing in Node.js (in-memory queue)

**Chosen approach:** [Bull](https://github.com/OptimalBits/bull) job queue backed by the **existing Redis instance** that Django already uses.

**Why:**
- The biggest win: **no new infrastructure**. Django already runs Redis for caching. Bull can share the same Redis connection (using a different key namespace). This saves ~$15–20/month on a dedicated Redis instance.
- Bull gives us: named queues, priority queues (singles prioritized over bulk), delayed retries with exponential backoff, job progress events (native), dead letter handling, and a web UI (Bull Board) — all out of the box.
- SQS would require Lambda or polling workers, adds latency, and complicates the progress reporting (no native pub/sub for SSE).
- Celery would mean running PDF generation in Python, but Puppeteer is a Node.js library. A Python→Node bridge is unnecessary complexity.
- In-memory queue dies on restart — not acceptable for a job that takes 3 minutes to complete.

**Tradeoff accepted:** We depend on the existing Redis instance. If Redis goes down, both Django caching and PDF queueing fail. Mitigation: Redis already has its own HA setup (assumed ElastiCache with replica). If it doesn't, that's a separate infrastructure concern that predates this service.

---

### Decision 3: Data Snapshot at Request Time (Freeze Pattern)

**Alternatives considered:**
- Re-query the database at render time (current broken behavior)
- Use PostgreSQL row-level locking during bulk generation
- Use database read replicas with a consistent snapshot

**Chosen approach:** Django **serializes the complete data payload** (all PO/invoice fields, line items, GST rates) into the job payload at the time the bulk request is received. The entire JSON snapshot is stored with each queued job.

**Why:**
- This directly solves the reported bug: the 87th PDF is rendered from the same frozen data as the 1st PDF, regardless of intervening database updates.
- PostgreSQL row-level locking for 3+ minutes would block writes to those records — unacceptable for an ERP where users might be correcting data.
- Read replicas with `BEGIN TRANSACTION / SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` is elegant but adds complexity and requires coordinating isolation levels across the Django ORM.
- The snapshot approach is simple, testable, and explicit: "here is exactly what was rendered."

**Tradeoff accepted:** The PDF reflects data as of request time. If a user triggers generation and then immediately corrects a typo, the generated PDF will have the typo. This is actually **correct behavior** for compliance documents — you want a record of what was sent, not what was later corrected. If regeneration is needed, it should be a new explicit request.

**Size concern:** 100 PDFs with 500 line items each, at ~5KB of JSON per document = 500KB job payload — Redis handles this trivially.

---

### Decision 4: Pre-Built ZIP in S3 (Not Live Streaming)

**Alternatives considered:**
- Stream ZIP to client as PDFs are generated (live streaming)
- Generate ZIP on-demand when client requests it
- Return individual PDF URLs for client-side batch download

**Chosen approach:** After all PDFs in a bulk job are generated, the PDF service **assembles the ZIP server-side using streaming** (archiver.js) and uploads it to S3. The client gets a signed S3 URL to download the complete ZIP.

**Why:**
- Directly solves the unreliable connectivity problem. If a client disconnects during ZIP download, they can re-request the signed URL and the ZIP is still in S3.
- HTTP `Range` requests work natively on S3, so the client's browser/download manager can resume a partial download automatically.
- Live streaming seems elegant but requires a persistent connection for the entire bulk duration (minutes). Any network hiccup = complete failure.
- Returning individual URLs means 50+ separate downloads — each one can fail independently, and the user has no single "everything" package.
- The ZIP is built using **streaming** (archiver.js piped to S3 multipart upload) — we never load all 100 PDFs into memory simultaneously.

**Tradeoff accepted:** The ZIP is not available until ALL PDFs in the batch are complete. If PDF #87 fails after retries, the ZIP doesn't get created. Mitigation: include a "partial ZIP" option where successfully generated PDFs are zipped even if some failed — flag failures in a manifest JSON included in the ZIP.

---

### Decision 5: HMAC-SHA256 for Tamper Evidence (Not PKI/Digital Signatures)

**Alternatives considered:**
- X.509 digital signatures embedded in PDF (DSS/PAdES)
- Third-party e-signature service (DocuSign, DigiLocker)
- Blockchain anchoring (SHA-256 hash on a public blockchain)
- Simple MD5/SHA-256 hash stored in database

**Chosen approach:** Compute `HMAC-SHA256(pdf_bytes, server_secret_key)`. Store the hash in:
1. PostgreSQL `pdf_metadata` table (keyed by document UUID)
2. The PDF's XMP metadata field (embedded in the PDF itself)

**Why:**
- The requirement is "tamper-evident" — you need to prove the PDF wasn't modified **after generation**. HMAC achieves this without certificate management.
- PKI/PAdES is technically correct but requires: a code-signing certificate, renewal every 1–3 years, HSM for key storage, and adds ~$500+/year in certificate costs. For an internal compliance requirement, this is over-engineered.
- Blockchain anchoring is trendy but adds latency, requires a blockchain provider, and solving "who owns the contract?" is more complex than the problem.
- Plain SHA-256 (no HMAC) is sufficient for integrity but doesn't prove the hash came from your server — anyone could compute it. HMAC ties the hash to a server-side secret.
- **Verification process:** POST the PDF bytes to `/api/pdf/verify` → server recomputes HMAC → compares to stored hash in PostgreSQL → returns `{valid: true/false, generated_at: ..., generated_by: ...}`.

**Tradeoff accepted:** If the server secret key is compromised, an attacker could forge valid HMACs. Mitigation: rotate the key periodically (stored in AWS Secrets Manager). Historical HMACs can be recomputed with the old key (stored with key version ID). This is a known, manageable risk for an internal ERP — not a public trust scenario.

---

### Decision 6: Chunked HTML Rendering for Large Documents

**Alternatives considered:**
- Increase Puppeteer memory limits (just throw more RAM at it)
- Use a different PDF library (wkhtmltopdf, PDFKit, reportlab)
- Reject requests with > 200 line items (bad UX)
- Render on a larger instance specifically for complex documents

**Chosen approach:** Before rendering, count the line items. If `count > 200`, partition the HTML into chunks of 150 rows each. Render each chunk as a separate PDF page set, then merge using `pdf-lib`. Each chunk render stays under ~300MB, well within the 512MB worker limit.

**Why:**
- Puppeteer's OOM crash is caused by laying out a DOM with 500+ table rows — the Chrome layout engine runs out of memory. The fix is to never feed it that many rows at once.
- wkhtmltopdf is unmaintained (last release 2020) and has its own layout bugs with complex CSS. Our templates use modern CSS grid/flexbox.
- PDFKit/reportlab generate PDFs programmatically — we'd have to re-implement the entire HTML template in code, losing the visual fidelity and designer-friendliness of HTML/CSS templates.
- Rejecting large documents is not acceptable for an ERP — a PO with 500 line items is a legitimate real-world document.

**Tradeoff accepted:** Chunked rendering increases render time for large documents (each chunk is a separate Puppeteer launch). A 500-row document might take 8–12 seconds instead of 2–3. This is acceptable for a bulk operation. For single-document requests with 500+ rows, we notify the user ("This document is large; generation may take up to 15 seconds").

---

## 5. AI Usage Log

> Detailed transcripts of prompts, AI responses, and where I accepted or overrode AI suggestions.

I used **Claude (Anthropic)** as my primary AI tool throughout this task. Below are the actual conversations — including prompts I wrote, what the AI said, what I accepted, and crucially, where I pushed back or corrected it.

---

### Conversation 1 — Initial Architecture: Queue vs. Synchronous

**My Prompt:**
> "I'm designing a PDF generation microservice for an ERP. It uses Puppeteer to render HTML templates. The Django monolith sends requests. Peak load is 1000 single PDFs per minute and 5–10 bulk requests (up to 100 PDFs each) per minute. Each PDF takes 2–3 seconds and uses ~400MB memory. Should I handle this synchronously or with a queue? The existing infra is a single EC2 r6i.large running Django + PostgreSQL + Redis."

**Claude's Response (summary):**
Claude correctly identified that synchronous processing would require ~42 concurrent Puppeteer instances to keep up with 1000 req/min (17 req/sec × 2.5s), consuming ~17GB of RAM — exceeding any single instance. It recommended a queue-based approach with a worker pool and suggested either Bull (Node.js) or Celery (Python).

**What I accepted:**
The fundamental argument for queue-based processing was right. The math checked out — I re-did it myself: 17 req/sec × 2.5s = 42 concurrent workers needed at peak, which is not feasible on a single machine with 400MB/worker.

**What I changed:**
Claude initially suggested keeping PDF generation inside the Django monolith using Celery. I pushed back — Puppeteer is a Node.js library, not Python. Running it inside a Celery worker means either: (a) spawning a Node.js subprocess from Python, which adds overhead and complexity, or (b) using a Python-based PDF library like WeasyPrint, which doesn't match the requirement of Puppeteer. I steered the design toward a **separate Node.js microservice** with its own Bull queue.

**My follow-up prompt:**
> "If I build this as a separate Node.js service with Bull queue backed by the existing Redis, what's the memory budget if I run 4 Puppeteer workers concurrently on a t3.medium (4GB RAM)? Will it fit?"

**Claude's Response:**
4 workers × 400MB = 1.6GB peak + ~512MB Node.js heap + ~384MB OS = ~2.5GB total. Fits comfortably in 4GB with headroom.

**Verdict:** ✅ Accepted. This became the core sizing decision.

---

### Conversation 2 — Handling Puppeteer OOM for 500+ Row Documents

**My Prompt:**
> "The problem says Puppeteer crashes with OOM errors when rendering purchase orders with 500+ line items. What are my options? I need to keep using Puppeteer (it's specified in the requirements) and I can't just increase the server RAM because of the budget constraint."

**Claude's Response (summary):**
Claude gave me four options:
1. Increase `--max-old-space-size` flag for Node.js/Chrome
2. Use `page.setContent()` with chunked HTML and merge PDFs afterward using `pdf-lib`
3. Switch to a non-headless PDF library (WeasyPrint, wkhtmltopdf, PDFKit)
4. Render on a larger instance just for complex documents

**What I accepted:**
Option 2 — chunked HTML rendering + pdf-lib merge. This is the right approach because it:
- Keeps Puppeteer (as required)
- Stays within memory budget (each chunk ≤ 150 rows ≈ 300MB, well under 512MB worker limit)
- Doesn't require new infrastructure

**What I rejected:**
- Option 1 (increase `--max-old-space-size`): Just raising limits doesn't fix the root cause — Chrome's layout engine runs out of memory laying out 500-row tables. More headroom delays the crash, doesn't prevent it.
- Option 3 (switch libraries): Requirements explicitly say Puppeteer.
- Option 4 (separate larger instance): Violates the budget constraint.

**My follow-up prompt:**
> "For the chunked approach — how do I split a Handlebars template that has a header section, a line items table, and a totals/signature section? The header should only appear on the first chunk, totals only on the last chunk. Show me the Handlebars conditional logic."

**Claude's Response:**
Claude provided the `{{#if isFirstPage}}` / `{{#if isLastPage}}` pattern with `chunkIndex` and `totalChunks` passed as template context variables. This is exactly what's now in the `purchase_order.hbs` template.

**Verdict:** ✅ Accepted as-is. The conditional pattern was correct and clean.

---

### Conversation 3 — Data Consistency: The "87th PDF Has Stale Data" Bug

**My Prompt:**
> "The problem describes a real bug: a customer triggered bulk generation of 100 invoices. By the time the 87th PDF was rendered (~3 minutes later), the ERP data had been updated and that PDF showed stale data. How do I prevent this? The Django app uses PostgreSQL. I want to understand all the options before choosing one."

**Claude's Response (summary):**
Claude presented four patterns:
1. **Re-query at render time** (current broken behavior — baseline to fix)
2. **PostgreSQL REPEATABLE READ transaction** held open for the entire bulk job duration
3. **Event sourcing / CQRS** — capture data changes as events, render from a point-in-time snapshot
4. **Serialize full payload at request time** — Django writes the complete data as JSON into the job payload before enqueueing

**What I accepted:**
Option 4 — serialize the full payload at request time. It's simple, explicit, and directly solves the problem without complex infrastructure.

**What I rejected and why:**

*Option 2 (long-lived PostgreSQL transaction):*
Claude suggested holding a `REPEATABLE READ` transaction open for the 3-minute bulk job duration. I pushed back hard on this. A 3-minute open transaction in PostgreSQL:
- Blocks autovacuum from cleaning dead rows (table bloat)
- Holds locks that prevent schema migrations
- In the worst case (if the connection drops), leaves an orphaned transaction that blocks the entire table

I told Claude: *"A long-lived transaction for 3 minutes in a production ERP database is not acceptable. The risk of blocking autovacuum and schema changes outweighs the elegance of the approach."*

Claude agreed and confirmed Option 4 as the better fit for this scale.

*Option 3 (event sourcing):*
Complete overkill for this problem. Event sourcing requires a fundamental rethink of how the Django app writes data. You don't adopt event sourcing to fix a PDF generation bug.

**My follow-up prompt:**
> "For Option 4, what's the size concern? If I serialize 100 invoices each with 500 line items at maybe 5KB of JSON each, that's 500KB stored in Redis as a job payload. Is that a problem for Bull?"

**Claude's Response:**
500KB per job × 100 jobs = 50MB total in Redis at peak. Bull stores job data in Redis hashes. Redis is fine handling this — it's designed for in-memory data. The practical limit is available Redis RAM, not Bull itself. At 50MB per bulk batch and 5–10 bulk batches/min, worst case is 250–500MB extra Redis usage during peak, which is manageable.

**Verdict:** ✅ Accepted. Added this calculation to Section 3 (Capacity Planning).

---

### Conversation 4 — Cost Estimation (With AI Error I Caught)

**My Prompt:**
> "Help me estimate the monthly AWS cost for this setup in the ap-south-1 (Mumbai) region:
> - 1x EC2 t3.medium running 24/7
> - S3 storage for 30,000 PDFs/month at avg 500KB each = 15GB/month new data, 1-year accumulation = 180GB
> - S3 GET/PUT API calls: ~60,000/month
> - Data egress for downloads: ~18GB/month
> Budget ceiling is $150/month."

**Claude's Response (first attempt):**
Claude calculated:
- EC2 t3.medium: $0.0416/hr × 730 hrs = **$30.37/month** ✅
- S3 storage 180GB: **$4.14/month** — but used **$0.023/GB** (US-East-1 pricing)
- S3 egress 18GB: **$1.62/month** — again US-East-1 pricing

**Error I caught:**
Claude used US-East-1 (Virginia) pricing throughout. The ap-south-1 (Mumbai) S3 pricing is different:
- S3 Standard in Mumbai: **$0.025/GB** (not $0.023)
- S3 Standard-IA in Mumbai: **$0.0138/GB**
- S3 Glacier IR in Mumbai: **$0.005/GB**
- Data transfer out in Mumbai: **$0.109/GB** for first 10TB (not $0.09)

I corrected Claude: *"You used US-East-1 pricing. The service runs in ap-south-1 (Mumbai). Can you redo the S3 and egress calculation with Mumbai region prices?"*

**Claude's corrected response:**
- S3 storage (lifecycle-managed, avg across tiers): ~$3.20/month ✅
- S3 egress 18GB: First 100GB/month free in AWS free tier, so $0 ✅ *(This was another thing Claude missed initially — I pointed out the free tier)*
- Total: ~$36–38/month, well under $150 ✅

**Verdict:** ⚠️ Partially accepted — required correction on region pricing and free tier. Always verify AWS pricing against the official calculator for the specific region. This is a real-world lesson: AI pricing knowledge has a training data cutoff and often defaults to the most common region.

---

### Conversation 5 — Tamper Evidence: HMAC vs. PKI

**My Prompt:**
> "The compliance team needs generated PDFs to be tamper-evident — they need to prove a PDF was not modified after generation. What are my options? The team is small, there's no dedicated security engineer, and the budget is tight. I need something I can actually maintain."

**Claude's Response (first attempt):**
Claude led with **PDF digital signatures (PAdES/CAdES)** using X.509 certificates, which is technically the "proper" answer. It described:
- Code-signing certificates from a CA (DigiCert, GlobalSign)
- Embedding signatures in the PDF using iText or Apache PDFBox
- Annual certificate renewal ($200–500/year)
- HSM (Hardware Security Module) for production key storage

**Where I pushed back:**
I responded: *"This is a small ERP. There's no security engineer. The requirement is 'tamper-evident for compliance' — not 'legally non-repudiated in court.' Is there a simpler approach that doesn't require certificate management and still meets the spirit of the requirement?"*

**Claude's revised response:**
Claude then walked through simpler options:
1. **Plain SHA-256 hash** stored in the database — simple but doesn't prove *who* computed it
2. **HMAC-SHA256** with a server-side secret — proves the hash came from our server (can't be faked without the secret)
3. **Blockchain anchoring** — publish hash to a public blockchain for external auditability

**What I chose and why:**
HMAC-SHA256. Plain SHA-256 has no authentication — anyone can compute the same hash after modifying the PDF. HMAC ties the hash to a server secret: without the secret, you can't produce a valid HMAC, so a valid HMAC proves the PDF came from our server unmodified.

Blockchain is interesting but:
- Adds external dependency (a blockchain provider)
- Adds latency per PDF (blockchain writes are slow)
- Solving "who controls the contract?" is more complex than needed

**My follow-up prompt:**
> "For HMAC — if I store the hash in PostgreSQL and also embed it in the PDF's XMP metadata, what's the verification workflow? And how do I handle key rotation so old PDFs can still be verified after we rotate the HMAC secret?"

**Claude's Response:**
- Verification: download PDF from S3 → recompute HMAC with current key → compare to stored hash in DB
- Key rotation: store a `hmac_key_version` column alongside the hash in `pdf_metadata`. When rotating, keep old key available for verification of historical documents. New PDFs use the new key. Old PDFs verified with their version's key.

**Verdict:** ✅ Accepted. Key rotation via `hmac_key_version` column is now in the database schema (`pdf_schema.sql`).

**What I overrode:**
Claude's initial suggestion of PKI/PAdES. For a small ERP with a tight budget and no security engineer, HMAC-SHA256 is the right engineering call. A perfect solution that nobody can operate is worse than a simpler solution that works reliably.

---

### Summary: How I Used AI

| Task | AI Used For | Where I Overrode |
|------|-------------|-----------------|
| Architecture | Exploring queue vs sync tradeoffs | Rejected Celery; insisted on separate Node.js service |
| OOM handling | Getting list of options | Rejected "increase memory limits" — doesn't fix root cause |
| Data consistency | Understanding all patterns | Rejected long-lived PostgreSQL transactions (autovacuum risk) |
| Cost estimation | Initial numbers | Corrected from US-East to Mumbai pricing; caught missing free tier |
| Tamper evidence | Comparing security options | Overrode PKI recommendation — too complex for the team size |

**My rule throughout:** AI is excellent at generating a complete list of options and explaining tradeoffs. It is poor at knowing which option is *right for your specific constraints*. I always wrote the constraint into the prompt explicitly ("tight budget," "no security engineer," "can't block autovacuum") and pushed back when the AI gave a generic best-practice answer that ignored those constraints.

---

## 6. Weaknesses & Future Improvements

> What is the weakest part of your design? If you had 2 more days, what would you improve?

### Current Weaknesses

**1. The 1000 req/min SLA is aspirational, not guaranteed.**
With 4 workers, we process ~96 PDF/min. Peak demand of 1000 req/min means jobs queue up. Single PDFs will wait in queue during sustained peak load. This is the most significant gap between the stated requirement and the current design.

**What I'd do with 2 more days:**
- Add a second PDF service instance (horizontal scaling) — doubles throughput to ~192/min
- Implement adaptive worker count: start with 4, auto-scale to 8 when queue depth exceeds threshold (still within memory budget on t3.large: 8GB RAM)
- Add a cache layer: if the same PO/invoice is requested within 60 seconds, return the cached S3 URL (Redis TTL cache keyed by document ID + version)

**2. No graceful handling of Redis failure.**
If Redis goes down, both Bull queue and Django cache fail simultaneously. No circuit breaker is in place.

**What I'd add:** A fallback to an in-memory queue (with persistence warning) and a Django setting to bypass the PDF service and generate synchronously during Redis outages.

**3. Worker process leak.**
If a Puppeteer worker crashes ungracefully (SIGKILL from OOM), the Bull job may remain in "active" state forever. Need a "stalled jobs" check interval in Bull (already supported but needs configuration).

**4. No webhook / callback support.**
Currently, the bulk completion is notified via SSE. If the client doesn't maintain an SSE connection, they must poll. A webhook callback URL (provided at bulk request time) would allow fire-and-forget bulk jobs.

**5. Single region.**
All infrastructure is in one AWS region. No disaster recovery. For true compliance, PDFs should be cross-region replicated (S3 CRR). S3 CRR adds ~$0.015/GB replication cost.

### If This Needed to Support 10× Load (300,000 PDFs/month, 10,000 req/min peak):

1. **Move to ECS with auto-scaling** — Scale PDF service containers from 2 to 20 based on Bull queue depth metric in CloudWatch
2. **Dedicated ElastiCache cluster** — Separate from Django's Redis to isolate blast radius
3. **S3 Transfer Acceleration** — For users in regions far from Mumbai
4. **Read replica for snapshot queries** — Route all data-fetch-for-PDF queries to a PostgreSQL read replica
5. **CDN (CloudFront)** — Cache repeat PDF downloads at edge (some POs are downloaded many times by different users)
6. **Separate Bull worker clusters** — Dedicated workers for single (latency-sensitive) vs. bulk (throughput-oriented) queues on different instance types

---

## 7. One Thing the Problem Statement Didn't Mention

> What's something important for a production deployment that wasn't called out?

### PDF Template Versioning

The problem talks about *generating* PDFs from templates, but doesn't mention **what happens when a template changes**.

**Why this matters in production:**

Imagine it's April 2025 and the GST invoice template is updated to comply with a new government format. From that point forward, all new PDFs use the new template. But a customer calls in December 2025 asking about an invoice from February 2025. The compliance team needs to verify that invoice. If the system only stores the PDF (not which template version generated it), it's impossible to re-render it identically for verification purposes.

**Specifically, this creates two real problems:**

1. **Re-generation inconsistency:** If a customer requests a "re-generation" of an old document (e.g., due to file corruption), the new PDF will look different from the original because the template changed. This breaks tamper-evidence — the recomputed HMAC won't match the stored HMAC.

2. **Regulatory risk:** Indian GST regulations (Rule 48 of CGST Rules) specify required fields for tax invoices. If a template update inadvertently drops a required field, all PDFs generated with the new template are non-compliant. Without versioning, you can't identify which invoices are affected.

**What I'd implement:**

- Template files stored in S3 with version IDs
- `pdf_metadata` table includes `template_version` column (e.g., `invoice_v3.2`)
- Bull job payload includes the template version to use (or defaults to `latest`)
- Deployment of a new template version does not delete old versions
- Audit log when template versions are activated/deactivated

This is a 2-day addition but critical for any real compliance use case.

---

## 8. Cost Estimation

> Line-by-line monthly cost breakdown. Prices in INR at ₹83/$1.

### New Infrastructure (PDF Service Only)

| Component | Spec | Monthly Cost (USD) | Monthly Cost (INR) |
|-----------|------|-------------------|-------------------|
| EC2 t3.medium | 2 vCPU, 4GB RAM, on-demand, ap-south-1 | $30.37 | ₹2,521 |
| S3 Storage (year 1 avg) | ~90GB avg (lifecycle: Standard→IA→Glacier) | $3.20 | ₹266 |
| S3 API calls | 30,000 PUT + 30,000 GET = 60,000 ops | $0.15 | ₹12 |
| S3 Egress (downloads) | ~18GB/month (within 100GB free tier) | $0.00 | ₹0 |
| Data transfer EC2→S3 | Same-region: free | $0.00 | ₹0 |
| EBS gp3 volume (20GB) | OS + Docker + logs | $1.60 | ₹133 |
| **Subtotal (new infra)** | | **$35.32** | **₹2,932** |

### Shared/Existing Infrastructure (Incremental Load)

| Component | Notes | Incremental Cost (USD) | Incremental Cost (INR) |
|-----------|-------|----------------------|----------------------|
| Existing EC2 r6i.large | Already paid; PDF service is separate | $0 | ₹0 |
| Existing Redis (ElastiCache) | Bull uses ~10MB of existing instance | $0 | ₹0 |
| Existing PostgreSQL RDS | +1 table for pdf_metadata; negligible load | $0 | ₹0 |
| Existing data transfer | VPC-internal: free | $0 | ₹0 |
| **Subtotal (shared)** | | **$0** | **₹0** |

### Optional / Recommended Additions

| Component | Why | Monthly Cost (USD) | Monthly Cost (INR) |
|-----------|-----|-------------------|-------------------|
| CloudWatch Logs | 5GB logs/month | $2.50 | ₹208 |
| SNS email alerts | Job failure notifications | $0.10 | ₹8 |
| AWS Secrets Manager | Store HMAC key, 1 secret | $0.40 | ₹33 |
| **Subtotal (optional)** | | **$3.00** | **₹249** |

### Total Monthly Cost

| Category | USD | INR |
|----------|-----|-----|
| New infrastructure | $35.32 | ₹2,932 |
| Shared infrastructure (incremental) | $0 | ₹0 |
| Optional additions | $3.00 | ₹249 |
| **TOTAL** | **$38.32** | **₹3,181** |

**Budget available:** ₹12,500 (~$150)
**Estimated cost:** ₹3,181 (~$38)
**Headroom:** ₹9,319 (~$112) — **75% under budget**

This headroom accommodates:
- Adding a second t3.medium for redundancy (+₹2,521) — still under budget
- Upgrading to t3.large if worker count needs to increase (+₹1,800)
- 3 years of growing storage before hitting the budget ceiling

### Math Check: S3 Storage Cost

```
Year 1 average storage:
  Month 1: 15GB (all Standard: 15 × $0.025 = $0.375)
  Month 6: 90GB (breakdown by lifecycle):
    - Recent 30 days: 15GB × $0.025 = $0.375
    - 31-90 days: 15GB × $0.0138 = $0.207
    - >90 days: 60GB × $0.005 = $0.300
    Total month 6: $0.882

  Year 1 average: ~$0.60/month → conservative estimate of $3.20/month over 3 years accounts for growth.
```

### Why Not Lambda?

Lambda pricing for 30,000 PDFs at 3s render, 512MB:
```
Compute: 30,000 × 3s × 512MB / 1024 × $0.0000166667 = $0.75/month
Requests: 30,000 × $0.0000002 = $0.006/month
Total Lambda: ~$0.76/month
```
Lambda looks cheaper but: cold starts add 1–3s latency, 15-min limit breaks bulk, Puppeteer binary at 270MB exceeds Lambda's 250MB package limit (requires Lambda Layers + EFS mounting = complexity). **Not worth it.**

---

*Document prepared by the candidate. Architecture diagram available in `architecture-diagram.svg`.*
