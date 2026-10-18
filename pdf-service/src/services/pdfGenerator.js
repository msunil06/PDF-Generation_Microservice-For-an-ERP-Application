const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const templates = {};

const loadTemplate = (templateName) => {
  if (process.env.NODE_ENV === 'production' && templates[templateName]) {
    return templates[templateName];
  }

  const templatePath = path.join(__dirname, '../../templates', `${templateName}.hbs`);
  const source = fs.readFileSync(templatePath, 'utf8');
  templates[templateName] = handlebars.compile(source);
  return templates[templateName];
};

handlebars.registerHelper('formatCurrency', (value) => {
  const num = parseFloat(value);
  if (isNaN(num)) return 'INR 0.00';
  return 'INR ' + num.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
});

handlebars.registerHelper('formatDate', (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
});

handlebars.registerHelper('multiply', (a, b) => (parseFloat(a || 0) * parseFloat(b || 0)).toFixed(2));
handlebars.registerHelper('add', (a, b) => (parseFloat(a || 0) + parseFloat(b || 0)).toFixed(2));
handlebars.registerHelper('or', (a, b) => a || b);
handlebars.registerHelper('coalesce', (...args) => {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== undefined && args[i] !== null && args[i] !== '') return args[i];
  }
  return '';
});

const MAX_ROWS_BEFORE_CHUNKING = 200;
const CHUNK_SIZE = 150;

async function generatePDF(jobData) {
  const { type, data } = jobData;
  const lineItems = data.line_items || data.lineItems || [];

  logger.info('Starting PDF generation', {
    documentId: jobData.documentId,
    type,
    lineItemCount: lineItems.length,
  });

  if (lineItems.length > MAX_ROWS_BEFORE_CHUNKING) {
    logger.info('Large document detected, using chunked rendering', {
      documentId: jobData.documentId,
      lineItemCount: lineItems.length,
    });
    return renderChunked(jobData, lineItems);
  }

  return renderSingle(jobData);
}

async function renderSingle(jobData) {
  const { type, data } = jobData;

  const templateName = type === 'invoice' ? 'invoice' : 'purchase_order';
  const template = loadTemplate(templateName);
  const renderData = {
    isFirstPage: data.isFirstPage !== undefined ? data.isFirstPage : true,
    isLastPage: data.isLastPage !== undefined ? data.isLastPage : true,
    ...data,
  };
  const html = template(renderData);

  return renderHtmlToPdf(html);
}

async function renderChunked(jobData, lineItems) {
  const { type, data } = jobData;
  const templateName = type === 'invoice' ? 'invoice' : 'purchase_order';
  const template = loadTemplate(templateName);

  const chunks = [];
  for (let i = 0; i < lineItems.length; i += CHUNK_SIZE) {
    chunks.push(lineItems.slice(i, i + CHUNK_SIZE));
  }

  logger.info('Rendering document in chunks', {
    documentId: jobData.documentId,
    totalChunks: chunks.length,
  });

  const pdfBuffers = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkData = {
      ...data,
      line_items: chunks[i],
      isFirstPage: i === 0,
      isLastPage: i === chunks.length - 1,
      chunkIndex: i,
      totalChunks: chunks.length,
    };

    const html = template(chunkData);

    try {
      const pdfBuffer = await renderHtmlToPdf(html);
      pdfBuffers.push(pdfBuffer);
      logger.debug(`Rendered chunk ${i + 1}/${chunks.length}`, {
        documentId: jobData.documentId,
      });
    } catch (err) {
      logger.error(`Failed to render chunk ${i + 1}`, {
        documentId: jobData.documentId,
        error: err.message,
      });
      throw err;
    }
  }

  return mergePdfs(pdfBuffers);
}

async function renderHtmlToPdf(html) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--js-flags=--max-old-space-size=384',
      ],
    });

    const page = await browser.newPage();

    await page.setViewport({ width: 1240, height: 1754, deviceScaleFactor: 1 });

    await page.setJavaScriptEnabled(false);

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: 20000,
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '20mm',
        right: '15mm',
        bottom: '20mm',
        left: '15mm',
      },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `
        <div style="font-size:9px; color:#999; width:100%; text-align:center; padding: 0 15mm;">
          Page <span class="pageNumber"></span> of <span class="totalPages"></span>
        </div>
      `,
    });

    return pdfBuffer;

  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function mergePdfs(pdfBuffers) {
  const mergedPdf = await PDFDocument.create();

  for (const pdfBuffer of pdfBuffers) {
    const pdf = await PDFDocument.load(pdfBuffer);
    const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    pages.forEach((page) => mergedPdf.addPage(page));
  }

  const mergedBytes = await mergedPdf.save();
  return Buffer.from(mergedBytes);
}

module.exports = { generatePDF };
