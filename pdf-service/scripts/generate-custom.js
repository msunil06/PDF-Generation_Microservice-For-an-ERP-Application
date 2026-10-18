const fs = require('fs');
const path = require('path');
const { generatePDF } = require('../src/services/pdfGenerator');
const { computeHMAC } = require('../src/services/signer');

process.env.PDF_HMAC_SECRET = process.env.PDF_HMAC_SECRET || 'dev-hmac-secret-key-minimum-32-characters-long';

async function run() {
  const customFilePath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.resolve(__dirname, '../my-data.json');

  if (!fs.existsSync(customFilePath)) {
    console.error(`❌ Error: Data file not found at: ${customFilePath}`);
    console.log('Usage: npm run generate:custom [path/to/your-data.json]');
    process.exit(1);
  }

  console.log(`\n📖 Reading custom data from: ${customFilePath}`);
  let fileContent;
  try {
    fileContent = JSON.parse(fs.readFileSync(customFilePath, 'utf8'));
  } catch (err) {
    console.error(`❌ Error parsing JSON file: ${err.message}`);
    process.exit(1);
  }

  const type = fileContent.type || 'purchase_order';
  const data = fileContent.data || fileContent;
  const documentId = fileContent.documentId || data.orderNumber || data.invoiceNumber || 'DOC-CUSTOM-001';

  if (!['purchase_order', 'invoice'].includes(type)) {
    console.error(`❌ Invalid type: "${type}". Must be "purchase_order" or "invoice".`);
    process.exit(1);
  }

  console.log(`📄 Generating ${type === 'invoice' ? 'Tax Invoice' : 'Purchase Order'} PDF for document ID: ${documentId}...`);

  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    const pdfBuffer = await generatePDF({ type, documentId, data });
    const safeDocId = documentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(outputDir, `${safeDocId}.pdf`);

    fs.writeFileSync(outputPath, pdfBuffer);
    const hmac = computeHMAC(pdfBuffer);

    console.log(`\n✅ PDF generated successfully!`);
    console.log(`   File: ${outputPath}`);
    console.log(`   Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);
    console.log(`   HMAC-SHA256: ${hmac}\n`);
  } catch (err) {
    console.error(`❌ PDF generation failed: ${err.message}`);
    process.exit(1);
  }
}

run();
