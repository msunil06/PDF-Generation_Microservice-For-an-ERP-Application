const fs = require('fs');
const path = require('path');
const { generatePDF } = require('../src/services/pdfGenerator');
const { computeHMAC } = require('../src/services/signer');

process.env.PDF_HMAC_SECRET = process.env.PDF_HMAC_SECRET || 'dev-hmac-secret-key-minimum-32-characters-long';

const samplePurchaseOrder = {
  orderNumber: 'PO-2024-001',
  status: 'Approved',
  orderDate: '2024-01-15',
  deliveryDate: '2024-01-30',
  paymentTerms: 'Net 30 Days',
  currency: 'INR',
  company: {
    name: 'Acme ERP Solutions Pvt Ltd',
    address: '101, Tech Park, Whitefield, Bengaluru, Karnataka - 560066',
    gstin: '29AABCU9603R1ZX',
    pan: 'AABCU9603R',
    phone: '+91 80 1234 5678',
    email: 'procurement@acme-erp.com'
  },
  vendor: {
    name: 'Global Tech Suppliers LLP',
    address: '42, Industrial Area, Andheri East, Mumbai, Maharashtra - 400093',
    gstin: '27AAPFU0939F1ZV',
    contact: 'Rajesh Sharma (+91 98765 43210)'
  },
  shipTo: {
    name: 'Acme Central Fulfillment Hub',
    address: 'Plot 12, Logistics Park, Bhiwandi, Maharashtra - 421302',
    contact: 'Warehouse Manager (+91 98222 11100)'
  },
  line_items: [
    {
      itemNumber: 1,
      name: 'Dell PowerEdge R750 Server',
      description: 'Intel Xeon Silver 4314, 64GB RAM, 2x 960GB SSD',
      hsnCode: '8471',
      quantity: 2,
      unit: 'Nos',
      unitPrice: 285000,
      gstRate: 18,
      gstAmount: 102600,
      totalAmount: 672600
    },
    {
      itemNumber: 2,
      name: 'Cisco Catalyst 9200L 48-Port PoE+ Switch',
      description: '48 ports data and PoE+, 4x 10G uplink',
      hsnCode: '8517',
      quantity: 1,
      unit: 'Nos',
      unitPrice: 165000,
      gstRate: 18,
      gstAmount: 29700,
      totalAmount: 194700
    }
  ],
  totals: {
    subtotal: 735000,
    cgst: 0,
    sgst: 0,
    igst: 132300,
    grandTotal: 867300,
    amountInWords: 'Eight Lakh Sixty-Seven Thousand Three Hundred Rupees Only'
  },
  notes: 'Please ensure tamper-proof delivery. Goods received subject to inspection.'
};

const sampleInvoice = {
  invoiceNumber: 'INV-2024-8891',
  invoiceDate: '2024-01-20',
  dueDate: '2024-02-19',
  poReference: 'PO-2024-001',
  paymentTerms: '30 Days Net',
  company: {
    name: 'Acme Technologies Ltd',
    address: '7th Floor, Innovation Tower, Outer Ring Road, Bangalore - 560103',
    gstin: '29AABCU9603R1ZX',
    pan: 'AABCU9603R',
    phone: '+91 80 9876 5432',
    email: 'billing@acmetechnologies.com',
    bankDetails: {
      bankName: 'HDFC Bank Ltd',
      accountNumber: '50200012345678',
      ifscCode: 'HDFC0001234',
      branch: 'Whitefield Branch'
    }
  },
  vendor: {
    name: 'Client Solutions Inc',
    address: 'Plot 45, Sector 18, Gurugram, Haryana - 122015',
    gstin: '06AAACS1234F1Z8',
    pan: 'AAACS1234F'
  },
  line_items: [
    {
      itemNumber: 1,
      name: 'Enterprise Cloud ERP Subscription',
      description: 'Annual license fee (50 users)',
      hsnCode: '998313',
      quantity: 1,
      unit: 'Year',
      unitPrice: 500000,
      gstRate: 18,
      gstAmount: 90000,
      totalAmount: 590000
    },
    {
      itemNumber: 2,
      name: 'ERP Data Migration & Implementation',
      description: 'Custom integration & onboarding support',
      hsnCode: '998314',
      quantity: 40,
      unit: 'Hours',
      unitPrice: 3500,
      gstRate: 18,
      gstAmount: 25200,
      totalAmount: 165200
    }
  ],
  totals: {
    subtotal: 640000,
    cgst: 0,
    sgst: 0,
    igst: 115200,
    grandTotal: 755200,
    amountInWords: 'Seven Lakh Fifty-Five Thousand Two Hundred Rupees Only'
  }
};

async function run() {
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('\n📄 [1/2] Generating Purchase Order PDF...');
  const poBuffer = await generatePDF({
    type: 'purchase_order',
    documentId: 'PO-2024-001',
    data: samplePurchaseOrder
  });
  const poPath = path.join(outputDir, 'sample_purchase_order.pdf');
  fs.writeFileSync(poPath, poBuffer);
  const poHmac = computeHMAC(poBuffer);
  console.log(`✅ Saved: ${poPath} (${(poBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`   HMAC-SHA256: ${poHmac}`);

  console.log('\n📄 [2/2] Generating Tax Invoice PDF...');
  const invBuffer = await generatePDF({
    type: 'invoice',
    documentId: 'INV-2024-8891',
    data: sampleInvoice
  });
  const invPath = path.join(outputDir, 'sample_invoice.pdf');
  fs.writeFileSync(invPath, invBuffer);
  const invHmac = computeHMAC(invBuffer);
  console.log(`✅ Saved: ${invPath} (${(invBuffer.length / 1024).toFixed(1)} KB)`);
  console.log(`   HMAC-SHA256: ${invHmac}`);

  console.log('\n🎉 Both sample PDFs generated successfully in the pdf-service/output/ folder!\n');
}

run().catch((err) => {
  console.error('Failed to generate sample PDFs:', err);
  process.exit(1);
});
