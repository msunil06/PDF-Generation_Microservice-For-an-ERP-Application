const request = require('supertest');
const app = require('../src/index');
const { singleQueue, bulkQueue } = require('../src/queues');
const { computeHMAC, verifyHMAC } = require('../src/services/signer');

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.PDF_SERVICE_API_KEY = 'test-api-key-12345';
  process.env.PDF_HMAC_SECRET = 'test-secret-key-minimum-32-characters-long';
});

afterAll(async () => {
  await Promise.allSettled([
    singleQueue.close(),
    bulkQueue.close(),
  ]);
});

describe('HMAC Signer', () => {
  beforeEach(() => {
    process.env.PDF_HMAC_SECRET = 'test-secret-key-minimum-32-characters-long';
  });

  test('computeHMAC returns consistent hex string', () => {
    const buffer = Buffer.from('test pdf content');
    const hash1 = computeHMAC(buffer);
    const hash2 = computeHMAC(buffer);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('verifyHMAC returns true for unmodified PDF', () => {
    const buffer = Buffer.from('original pdf content');
    const hash = computeHMAC(buffer);
    expect(verifyHMAC(buffer, hash)).toBe(true);
  });

  test('verifyHMAC returns false for modified PDF', () => {
    const original = Buffer.from('original pdf content');
    const modified = Buffer.from('modified pdf content');
    const hash = computeHMAC(original);
    expect(verifyHMAC(modified, hash)).toBe(false);
  });

  test('verifyHMAC uses timing-safe comparison', () => {
    const buffer = Buffer.from('test content');
    const hash = computeHMAC(buffer);
    const wrongHash = 'a'.repeat(64);
    
    expect(() => verifyHMAC(buffer, wrongHash)).not.toThrow();
  });

  test('computeHMAC throws if secret is too short', () => {
    process.env.PDF_HMAC_SECRET = 'short';
    expect(() => computeHMAC(Buffer.from('test'))).toThrow('at least 32 characters');
  });
});

describe('POST /api/pdf/generate', () => {
  const validPayload = {
    type: 'purchase_order',
    documentId: 'PO-TEST-001',
    data: {
      orderNumber: 'PO-TEST-001',
      orderDate: '2024-01-01',
      company: { name: 'Test Corp', address: '123 Test St', gstin: '29AABCU9603R1ZX' },
      vendor: { name: 'Test Vendor', address: '456 Vendor St', gstin: '27AAPFU0939F1ZV' },
      shipTo: { name: 'Warehouse A', address: '789 Ship St', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      line_items: [
        {
          name: 'Test Product',
          hsnCode: '8471',
          quantity: 10,
          unit: 'Nos',
          unitPrice: 1000,
          gstRate: 18,
          gstAmount: 1800,
          totalAmount: 11800,
        }
      ],
      totals: { subtotal: 10000, cgst: 900, sgst: 900, igst: 0, grandTotal: 11800 },
    },
  };

  test('returns 401 without API key', async () => {
    const res = await request(app)
      .post('/api/pdf/generate')
      .send(validPayload);

    expect(res.status).toBe(401);
  });

  test('returns 400 for missing type', async () => {
    const res = await request(app)
      .post('/api/pdf/generate')
      .set('X-API-Key', process.env.PDF_SERVICE_API_KEY)
      .send({ documentId: 'PO-001', data: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('type');
  });

  test('returns 400 for invalid type', async () => {
    const res = await request(app)
      .post('/api/pdf/generate')
      .set('X-API-Key', process.env.PDF_SERVICE_API_KEY)
      .send({ ...validPayload, type: 'invalid_type' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/pdf/bulk', () => {
  test('returns 400 for empty documents array', async () => {
    const res = await request(app)
      .post('/api/pdf/bulk')
      .set('X-API-Key', process.env.PDF_SERVICE_API_KEY)
      .send({ documents: [] });

    expect(res.status).toBe(400);
  });

  test('returns 400 for more than 100 documents', async () => {
    const documents = Array.from({ length: 101 }, (_, i) => ({
      type: 'purchase_order',
      documentId: `PO-${i}`,
      data: {},
    }));

    const res = await request(app)
      .post('/api/pdf/bulk')
      .set('X-API-Key', process.env.PDF_SERVICE_API_KEY)
      .send({ documents });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Maximum 100');
  });
});

describe('GET /health', () => {
  beforeEach(() => {
    jest.spyOn(singleQueue, 'getJobCounts').mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });
    jest.spyOn(bulkQueue, 'getJobCounts').mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns healthy status', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body).toHaveProperty('queues');
    expect(res.body).toHaveProperty('memory');
    expect(res.body).toHaveProperty('uptime');
  });
});
