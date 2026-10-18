const state = {
  currentType: 'purchase_order',
  items: [],
  currentPdfBase64: null,
  currentHmacHash: null,
  currentDocId: null,
  isGenerating: false,
};

const CATALOG_ITEMS = [
  {
    id: 'srv-dell-r750',
    icon: '🖥️',
    name: 'Dell PowerEdge R750 Server',
    desc: 'Intel Xeon Silver 4314, 64GB RAM, 2x 960GB SSD Enterprise',
    hsn: '8471',
    price: 285000,
    unit: 'Nos',
    gstRate: 18,
  },
  {
    id: 'net-cisco-9200',
    icon: '🌐',
    name: 'Cisco Catalyst 9200L 48-Port Switch',
    desc: '48 ports PoE+ Gigabit Data, 4x 10G SFP+ uplinks',
    hsn: '8517',
    price: 165000,
    unit: 'Nos',
    gstRate: 18,
  },
  {
    id: 'pwr-apc-6kva',
    icon: '⚡',
    name: 'APC Smart-UPS On-Line 6kVA 230V',
    desc: 'Rack/Tower double-conversion online power backup',
    hsn: '8504',
    price: 145000,
    unit: 'Nos',
    gstRate: 18,
  },
  {
    id: 'sto-netapp-48tb',
    icon: '💾',
    name: 'NetApp SAN Storage Array 48TB',
    desc: 'All-Flash NVMe Array, dual controller with 10GbE iSCSI',
    hsn: '8471',
    price: 420000,
    unit: 'Nos',
    gstRate: 18,
  },
  {
    id: 'lic-erp-cloud',
    icon: '☁️',
    name: 'Enterprise ERP Cloud User License',
    desc: 'Annual enterprise subscription (50 active concurrent seats)',
    hsn: '998313',
    price: 360000,
    unit: 'Year',
    gstRate: 18,
  },
  {
    id: 'srv-consulting',
    icon: '🛠️',
    name: 'ERP Implementation Consulting',
    desc: 'Senior systems architect & DB migration services (per block)',
    hsn: '998314',
    price: 70000,
    unit: 'Sets',
    gstRate: 18,
  },
];

const INITIAL_ITEMS = [
  {
    id: 'item-1',
    itemNumber: 1,
    name: 'Dell PowerEdge R750 Server',
    description: 'Intel Xeon Silver 4314, 64GB RAM, 2x 960GB SSD Enterprise',
    hsnCode: '8471',
    quantity: 2,
    unit: 'Nos',
    unitPrice: 285000,
    gstRate: 18,
  },
  {
    id: 'item-2',
    itemNumber: 2,
    name: 'Cisco Catalyst 9200L 48-Port Switch',
    description: '48 ports PoE+ Gigabit Data, 4x 10G SFP+ uplinks',
    hsnCode: '8517',
    quantity: 1,
    unit: 'Nos',
    unitPrice: 165000,
    gstRate: 18,
  },
];

document.addEventListener('DOMContentLoaded', () => {
  setupMobileMenu();
  setupNavigation();
  setupDocumentTypeToggle();
  setupCatalog();
  setupCustomItemForm();
  setupDates();
  setupActions();
  setupTamperVerifier();
  loadInitialItems();
  checkMicroserviceHealth();
  setInterval(checkMicroserviceHealth, 30000);
});

function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

function setupMobileMenu() {
  const btn = document.getElementById('mobileMenuBtn');
  const nav = document.getElementById('navTabs');
  if (!btn || !nav) return;

  btn.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    btn.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', isOpen);
  });

  nav.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (window.innerWidth <= 860) {
        nav.classList.remove('open');
        btn.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) {
      nav.classList.remove('open');
      btn.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }
  });
}

function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPane = document.getElementById(tab.dataset.tab);
      if (targetPane) targetPane.classList.add('active');

      if (tab.dataset.tab === 'monitorTab') {
        checkMicroserviceHealth();
      }
    });
  });
}

function setupDocumentTypeToggle() {
  const btnPO = document.getElementById('docTypePO');
  const btnInvoice = document.getElementById('docTypeInvoice');

  btnPO.addEventListener('click', () => setDocumentType('purchase_order'));
  btnInvoice.addEventListener('click', () => setDocumentType('invoice'));
}

function setDocumentType(type) {
  state.currentType = type;
  const btnPO = document.getElementById('docTypePO');
  const btnInvoice = document.getElementById('docTypeInvoice');
  const lblDocNum = document.getElementById('lblDocNumber');
  const lblDocDate = document.getElementById('lblDocDate');
  const lblDueDate = document.getElementById('lblDocDueDate');
  const docNumInput = document.getElementById('metaDocNumber');
  const summaryTitle = document.getElementById('summaryTitle');
  const btnText = document.getElementById('btnGenerateText');

  if (type === 'purchase_order') {
    btnPO.classList.add('active');
    btnInvoice.classList.remove('active');
    lblDocNum.textContent = 'Order Number';
    lblDocDate.textContent = 'Order Date';
    lblDueDate.textContent = 'Delivery Date';
    docNumInput.value = 'PO-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
    summaryTitle.textContent = 'Purchase Order Items';
    btnText.textContent = 'Generate Purchase Order PDF';
  } else {
    btnInvoice.classList.add('active');
    btnPO.classList.remove('active');
    lblDocNum.textContent = 'Invoice Number';
    lblDocDate.textContent = 'Invoice Date';
    lblDueDate.textContent = 'Due Date';
    docNumInput.value = 'INV-' + new Date().getFullYear() + '-' + Math.floor(1000 + Math.random() * 9000);
    summaryTitle.textContent = 'Tax Invoice Items';
    btnText.textContent = 'Generate Tax Invoice PDF';
  }
}

function setupDates() {
  const today = new Date();
  const nextMonth = new Date();
  nextMonth.setDate(today.getDate() + 30);

  const format = (d) => d.toISOString().split('T')[0];
  document.getElementById('metaDocDate').value = format(today);
  document.getElementById('metaDocDueDate').value = format(nextMonth);
}

function setupCatalog() {
  const container = document.getElementById('catalogGrid');
  container.innerHTML = '';

  CATALOG_ITEMS.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'catalog-item';
    el.innerHTML = `
      <div class="item-top">
        <span class="item-icon">${item.icon}</span>
        <div class="item-meta">
          <h4>${item.name}</h4>
          <p>${item.desc}</p>
        </div>
      </div>
      <div class="item-bottom">
        <span class="item-price">₹${item.price.toLocaleString('en-IN')}</span>
        <button class="btn-add-item" data-id="${item.id}">+ Add</button>
      </div>
    `;

    el.querySelector('.btn-add-item').addEventListener('click', (e) => {
      e.stopPropagation();
      addItemFromCatalog(item);
    });

    el.addEventListener('click', () => {
      addItemFromCatalog(item);
    });

    container.appendChild(el);
  });
}

function addItemFromCatalog(catalogItem) {
  const existing = state.items.find((i) => i.name === catalogItem.name);
  if (existing) {
    existing.quantity += 1;
    showToast(`${catalogItem.name} — quantity increased to ${existing.quantity}`, 'info', 2000);
  } else {
    state.items.push({
      id: 'item-' + Date.now() + Math.random(),
      itemNumber: state.items.length + 1,
      name: catalogItem.name,
      description: catalogItem.desc,
      hsnCode: catalogItem.hsn,
      quantity: 1,
      unit: catalogItem.unit,
      unitPrice: catalogItem.price,
      gstRate: catalogItem.gstRate,
    });
    showToast(`${catalogItem.name} added to document`, 'success', 2000);
  }
  renderItemsTable();
}

function setupCustomItemForm() {
  const form = document.getElementById('customItemForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('customItemName').value.trim();
    const hsn = document.getElementById('customItemHsn').value.trim();
    const qty = parseInt(document.getElementById('customItemQty').value) || 1;
    const unit = document.getElementById('customItemUnit').value;
    const price = parseFloat(document.getElementById('customItemPrice').value) || 0;
    const gstRate = parseFloat(document.getElementById('customItemGst').value) || 18;

    if (!name || price <= 0) {
      showToast('Please enter a valid item name and price.', 'error');
      return;
    }

    state.items.push({
      id: 'custom-' + Date.now(),
      itemNumber: state.items.length + 1,
      name,
      description: name,
      hsnCode: hsn,
      quantity: qty,
      unit,
      unitPrice: price,
      gstRate,
    });

    form.reset();
    document.getElementById('customItemQty').value = '1';
    document.getElementById('customItemHsn').value = '8471';
    renderItemsTable();
    showToast(`Custom item "${name}" added`, 'success', 2500);
  });
}

function loadInitialItems() {
  state.items = JSON.parse(JSON.stringify(INITIAL_ITEMS));
  renderItemsTable();
}

function renderItemsTable() {
  const tbody = document.getElementById('itemsTableBody');
  const countBadge = document.getElementById('summaryCountBadge');
  tbody.innerHTML = '';

  countBadge.textContent = `${state.items.length} item${state.items.length === 1 ? '' : 's'}`;

  if (state.items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-subtle); padding: 24px;">
          No items added yet. Click an item from the catalog above to add.
        </td>
      </tr>
    `;
    updateTotals(0, 0, 0);
    return;
  }

  let subtotal = 0;
  let totalTax = 0;

  state.items.forEach((item, index) => {
    item.itemNumber = index + 1;
    const itemSubtotal = item.quantity * item.unitPrice;
    const itemGst = (itemSubtotal * item.gstRate) / 100;
    const itemTotal = itemSubtotal + itemGst;

    subtotal += itemSubtotal;
    totalTax += itemGst;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <div style="font-weight: 600; color: #fff;">${item.name}</div>
        <div style="font-size: 10px; color: var(--text-subtle);">HSN: ${item.hsnCode}</div>
      </td>
      <td>
        <div class="qty-control">
          <button class="btn-qty btn-minus" data-id="${item.id}" aria-label="Decrease quantity">-</button>
          <span style="font-family: var(--font-mono); font-weight: 600; width: 18px; text-align: center;">${item.quantity}</span>
          <button class="btn-qty btn-plus" data-id="${item.id}" aria-label="Increase quantity">+</button>
        </div>
      </td>
      <td style="font-family: var(--font-mono);">₹${item.unitPrice.toLocaleString('en-IN')}</td>
      <td style="font-family: var(--font-mono); color: var(--text-muted);">${item.gstRate}%</td>
      <td style="font-family: var(--font-mono); font-weight: 600; color: var(--accent);">₹${itemTotal.toLocaleString('en-IN')}</td>
      <td>
        <button class="btn-remove-row" data-id="${item.id}" title="Remove item" aria-label="Remove ${item.name}">✕</button>
      </td>
    `;

    row.querySelector('.btn-minus').addEventListener('click', () => {
      if (item.quantity > 1) {
        item.quantity -= 1;
      } else {
        state.items = state.items.filter((i) => i.id !== item.id);
      }
      renderItemsTable();
    });

    row.querySelector('.btn-plus').addEventListener('click', () => {
      item.quantity += 1;
      renderItemsTable();
    });

    row.querySelector('.btn-remove-row').addEventListener('click', () => {
      state.items = state.items.filter((i) => i.id !== item.id);
      renderItemsTable();
    });

    tbody.appendChild(row);
  });

  const grandTotal = subtotal + totalTax;
  updateTotals(subtotal, totalTax, grandTotal);
}

function updateTotals(subtotal, tax, grandTotal) {
  document.getElementById('totalSubtotal').textContent = `₹${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  document.getElementById('totalTax').textContent = `₹${tax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  document.getElementById('totalGrand').textContent = `₹${grandTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const inWords = numberToWordsINR(Math.round(grandTotal));
  document.getElementById('totalInWords').textContent = inWords ? `${inWords} Only` : 'Zero Rupees Only';
}

function numberToWordsINR(num) {
  if (!num || num === 0) return 'Zero Rupees';
  const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function inWords(n) {
    if (n < 20) return a[n];
    const digit = n % 10;
    return b[Math.floor(n / 10)] + (digit ? ' ' + a[digit] : ' ');
  }

  let str = '';
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;
  const hundred = Math.floor(num / 100);
  const rest = num % 100;

  if (crore) str += inWords(crore) + 'Crore ';
  if (lakh) str += inWords(lakh) + 'Lakh ';
  if (thousand) str += inWords(thousand) + 'Thousand ';
  if (hundred) str += inWords(hundred) + 'Hundred ';
  if (rest) str += inWords(rest);

  return str.trim() + ' Rupees';
}

function setupActions() {
  document.getElementById('btnClearItems').addEventListener('click', () => {
    state.items = [];
    renderItemsTable();
    showToast('All items cleared', 'info', 2000);
  });

  let presetIndex = 0;
  const presets = [
    {
      name: 'V Power Logistics (Tax Invoice Spec)',
      company: 'V POWER LOGISTICS',
      gstin: '06AAUFV9038P1Z0',
      pan: 'AAUFV9038P',
      address: 'C-14, Udyog Vihar Phase V, Sector 19, V Power Logistics, Gurugram, Haryana 122008',
      vendor: 'ABC Supplies',
      vendorGstin: '06AAACS1234F1Z8',
      vendorContact: 'Harsh Pathak (+91 70784 52542)',
      vendorAddress: 'Ground Floor, C 14, Phase V, Udyog Vihar, Sector 19, Gurugram, Haryana 122016',
      items: [
        { id: 101, name: 'Ocean Freight', description: 'SAC 996521 · Booking: EID0987917 · Container: AXIU8485054', hsnCode: '996521', quantity: 1, unit: 'Trip', unitPrice: 9000, gstRate: 5 },
        { id: 102, name: 'Trucking', description: 'SAC 996799 · Trucking (Overseas / DAP) · Booking: EID0987917 · Container: AXIU8485054', hsnCode: '996799', quantity: 1, unit: 'Trip', unitPrice: 18000, gstRate: 18 }
      ]
    },
    {
      name: 'Acme ERP Solutions (Standard)',
      company: 'Acme ERP Solutions Pvt Ltd',
      gstin: '29AABCU9603R1ZX',
      pan: 'AABCU9603R',
      address: '101, Tech Park, Whitefield, Bengaluru - 560066',
      vendor: 'Global Tech Suppliers LLP',
      vendorGstin: '27AAPFU0939F1ZV',
      vendorContact: 'Rajesh Sharma (+91 98765 43210)',
      vendorAddress: '42, Industrial Area, Andheri East, Mumbai - 400093',
      items: null
    },
    {
      name: 'Tata Enterprise Solutions',
      company: 'Tata Enterprise Solutions Ltd',
      gstin: '27AAACT2727Q1ZW',
      pan: 'AAACT2727Q',
      address: 'Bombay House, 24 Homi Mody Street, Mumbai - 400001',
      vendor: 'Dell Global Technologies India',
      vendorGstin: '29AABCD1234E1ZX',
      vendorContact: 'Priya Nair (+91 80 4455 6677)',
      vendorAddress: 'Bagmane Tech Park, CV Raman Nagar, Bengaluru - 560093',
      items: null
    }
  ];

  document.getElementById('btnFillPreset').addEventListener('click', () => {
    const p = presets[presetIndex % presets.length];
    document.getElementById('metaCompanyName').value = p.company;
    document.getElementById('metaCompanyGstin').value = p.gstin;
    if (document.getElementById('metaCompanyPan')) document.getElementById('metaCompanyPan').value = p.pan;
    document.getElementById('metaCompanyAddress').value = p.address;
    document.getElementById('metaVendorName').value = p.vendor;
    document.getElementById('metaVendorGstin').value = p.vendorGstin;
    document.getElementById('metaVendorContact').value = p.vendorContact;
    document.getElementById('metaVendorAddress').value = p.vendorAddress;

    if (p.items && p.items.length > 0) {
      state.items = JSON.parse(JSON.stringify(p.items));
      renderItemsTable();
    }

    showToast(`Loaded Preset: ${p.name}`, 'success', 2500);
    presetIndex++;
  });

  document.getElementById('btnGeneratePdf').addEventListener('click', handleGeneratePdf);

  document.getElementById('btnDownloadPdf').addEventListener('click', downloadCurrentPdf);
  document.getElementById('btnPrintPdf').addEventListener('click', printCurrentPdf);
  document.getElementById('btnOpenNewTab').addEventListener('click', openPdfInNewTab);

  document.getElementById('btnCopyHmac').addEventListener('click', () => {
    if (state.currentHmacHash) {
      navigator.clipboard.writeText(state.currentHmacHash).then(() => {
        showToast('HMAC hash copied to clipboard', 'success', 2500);
      }).catch(() => {
        showToast('Failed to copy — please select and copy manually', 'error');
      });
    }
  });

  document.getElementById('btnRefreshHealth').addEventListener('click', checkMicroserviceHealth);
}

const progressSteps = ['stepValidate', 'stepTemplate', 'stepRender', 'stepSign', 'stepComplete'];

function resetProgress() {
  const el = document.getElementById('generationProgress');
  el.classList.remove('active');
  document.getElementById('progressBarFill').style.width = '0%';
  document.getElementById('progressPercent').textContent = '0%';
  document.getElementById('progressTitle').textContent = 'Preparing document…';

  progressSteps.forEach((stepId) => {
    const step = document.getElementById(stepId);
    step.classList.remove('active', 'done');
    step.querySelector('.progress-step-icon').textContent = '○';
  });
}

function showProgress() {
  const el = document.getElementById('generationProgress');
  el.classList.add('active');
}

function setProgressStep(stepIndex, label) {
  const percentages = [10, 25, 50, 80, 100];
  const percent = percentages[stepIndex] || 0;

  document.getElementById('progressBarFill').style.width = percent + '%';
  document.getElementById('progressPercent').textContent = percent + '%';
  document.getElementById('progressTitle').textContent = label;

  progressSteps.forEach((stepId, i) => {
    const step = document.getElementById(stepId);
    if (i < stepIndex) {
      step.classList.remove('active');
      step.classList.add('done');
      step.querySelector('.progress-step-icon').textContent = '✓';
    } else if (i === stepIndex) {
      step.classList.add('active');
      step.classList.remove('done');
      step.querySelector('.progress-step-icon').textContent = '●';
    } else {
      step.classList.remove('active', 'done');
      step.querySelector('.progress-step-icon').textContent = '○';
    }
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleGeneratePdf() {
  if (state.isGenerating) return;

  if (state.items.length === 0) {
    showToast('Add at least one line item before generating.', 'error');
    return;
  }

  state.isGenerating = true;
  const btn = document.getElementById('btnGeneratePdf');
  const spinner = document.getElementById('btnSpinner');
  const btnText = document.getElementById('btnGenerateText');
  const resultCard = document.getElementById('pdfResultCard');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  btnText.textContent = 'Rendering…';

  resetProgress();
  showProgress();

  setProgressStep(0, 'Validating document data…');
  await delay(200);

  let subtotal = 0;
  let totalTax = 0;
  const processedItems = state.items.map((item, idx) => {
    const itemSubtotal = item.quantity * item.unitPrice;
    const itemGst = (itemSubtotal * item.gstRate) / 100;
    subtotal += itemSubtotal;
    totalTax += itemGst;

    return {
      itemNumber: idx + 1,
      name: item.name,
      description: item.description || item.name,
      hsnCode: item.hsnCode || '8471',
      quantity: item.quantity,
      unit: item.unit || 'Nos',
      unitPrice: item.unitPrice,
      rate: item.unitPrice,
      taxableValue: Math.round(itemSubtotal),
      gstRate: item.gstRate,
      cgst: Math.round(itemGst / 2),
      sgst: Math.round(itemGst / 2),
      igst: Math.round(itemGst),
      gstAmount: Math.round(itemGst),
      total: Math.round(itemSubtotal + itemGst),
      totalAmount: Math.round(itemSubtotal + itemGst),
    };
  });

  const grandTotal = subtotal + totalTax;
  const docId = document.getElementById('metaDocNumber').value || 'DOC-' + Date.now();
  state.currentDocId = docId;

  setProgressStep(1, 'Compiling Handlebars template…');
  await delay(150);

  const payloadData = {
    orderNumber: docId,
    invoiceNumber: docId,
    status: 'Approved',
    orderDate: document.getElementById('metaDocDate').value,
    invoiceDate: document.getElementById('metaDocDate').value,
    deliveryDate: document.getElementById('metaDocDueDate').value,
    dueDate: document.getElementById('metaDocDueDate').value,
    poReference: 'EID0987917',
    bookingReference: 'EID0987917',
    containerNumber: 'AXIU8485054',
    hsCode: processedItems[0]?.hsnCode || '870830',
    paymentStatus: 'Pending',
    placeOfSupply: 'Haryana (06)',
    reverseCharge: 'To confirm',
    paymentTerms: document.getElementById('metaPaymentTerms').value,
    currency: 'INR',
    usdReferenceTotal: '$' + (Math.round(grandTotal) / 90).toFixed(2),
    company: {
      name: document.getElementById('metaCompanyName').value,
      address: document.getElementById('metaCompanyAddress').value,
      gstin: document.getElementById('metaCompanyGstin').value,
      pan: document.getElementById('metaCompanyPan') ? document.getElementById('metaCompanyPan').value : 'AAUFV9038P',
      phone: '+91 80 1234 5678',
      email: 'finance@vpowerlogistics.com',
      bankDetails: {
        accountName: document.getElementById('metaCompanyName').value,
        accountNumber: '5020 0063 9289 82',
        accountType: 'Current Account',
        ifscCode: 'HDFC0002024',
        branch: 'Gurugram Sector 19'
      }
    },
    vendor: {
      name: document.getElementById('metaVendorName').value,
      address: document.getElementById('metaVendorAddress').value,
      gstin: document.getElementById('metaVendorGstin').value,
      contact: document.getElementById('metaVendorContact').value,
    },
    customer: {
      name: document.getElementById('metaVendorName').value,
      address: document.getElementById('metaVendorAddress').value,
      gstin: document.getElementById('metaVendorGstin').value,
      contact: document.getElementById('metaVendorContact').value,
      email: 'harshpathaksmt@gmail.com',
      phone: '+917078452542'
    },
    shipTo: {
      name: document.getElementById('metaCompanyName').value + ' — Logistics Hub',
      address: 'Plot 48, Industrial Logistic Corridor, Phase 2',
      contact: 'Warehouse Operations'
    },
    line_items: processedItems,
    totals: {
      subtotal: Math.round(subtotal),
      cgst: Math.round(totalTax / 2),
      sgst: Math.round(totalTax / 2),
      igst: Math.round(totalTax),
      totalTax: Math.round(totalTax),
      grandTotal: Math.round(grandTotal),
      amountInWords: numberToWordsINR(Math.round(grandTotal)) + ' Only'
    },
    notes: 'Exchange rate: USD charges converted at INR 90 per USD, as stated in the source invoice.'
  };

  setProgressStep(2, 'Rendering PDF via Puppeteer headless browser…');

  try {
    const res = await fetch('/api/web/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: state.currentType,
        documentId: docId,
        data: payloadData,
      }),
    });

    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || result.message || 'Generation failed');
    }

    setProgressStep(3, 'Computing HMAC-SHA256 cryptographic signature…');
    await delay(250);

    state.currentPdfBase64 = result.pdfBase64;
    state.currentHmacHash = result.hmacHash;

    setProgressStep(4, 'PDF generation complete!');
    await delay(300);

    document.getElementById('pdfRenderTime').textContent = `⚡ ${(result.renderTimeMs / 1000).toFixed(2)}s`;
    document.getElementById('pdfFileSize').textContent = `${(result.fileSize / 1024).toFixed(1)} KB`;
    document.getElementById('hmacDisplayCode').textContent = result.hmacHash;

    const byteCharacters = atob(result.pdfBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);

    const pdfFrame = document.getElementById('pdfFrame');
    pdfFrame.src = blobUrl;

    document.getElementById('verifyExpectedHash').value = result.hmacHash;

    resultCard.classList.remove('hidden');

    setTimeout(() => {
      resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    const docTypeLabel = state.currentType === 'invoice' ? 'Tax Invoice' : 'Purchase Order';
    showToast(`${docTypeLabel} ${docId} generated in ${(result.renderTimeMs / 1000).toFixed(2)}s`, 'success', 5000);

    setTimeout(() => {
      document.getElementById('generationProgress').classList.remove('active');
    }, 1500);

  } catch (err) {
    showToast('PDF Generation Error: ' + err.message, 'error', 6000);
    resetProgress();
  } finally {
    state.isGenerating = false;
    btn.disabled = false;
    spinner.style.display = 'none';
    btnText.textContent = state.currentType === 'invoice' ? 'Generate Tax Invoice PDF' : 'Generate Purchase Order PDF';
  }
}

function downloadCurrentPdf() {
  if (!state.currentPdfBase64) return;
  const link = document.createElement('a');
  link.href = 'data:application/pdf;base64,' + state.currentPdfBase64;
  link.download = `${state.currentDocId || 'document'}.pdf`;
  link.click();
  showToast(`${state.currentDocId}.pdf downloaded`, 'success', 2500);
}

function printCurrentPdf() {
  const frame = document.getElementById('pdfFrame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.print();
  }
}

function openPdfInNewTab() {
  if (!state.currentPdfBase64) return;
  const byteCharacters = atob(state.currentPdfBase64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, '_blank');
}

function setupTamperVerifier() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('verifyFileInput');
  const btnSelect = document.getElementById('btnSelectFile');
  const fileInfo = document.getElementById('selectedFileInfo');
  const btnVerify = document.getElementById('btnExecuteVerify');

  btnSelect.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target !== btnSelect && !btnSelect.contains(e.target)) {
      fileInput.click();
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      handleFileSelected(fileInput.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      handleFileSelected(fileInput.files[0]);
    }
  });

  function handleFileSelected(file) {
    fileInfo.classList.remove('hidden');
    document.getElementById('selectedFileName').textContent = file.name;
    document.getElementById('selectedFileSize').textContent = `(${(file.size / 1024).toFixed(1)} KB)`;
    showToast(`File "${file.name}" selected for verification`, 'info', 2500);
  }

  btnVerify.addEventListener('click', async () => {
    const expectedHash = document.getElementById('verifyExpectedHash').value.trim();

    if (!expectedHash) {
      showToast('Enter the expected 64-character HMAC-SHA256 signature.', 'error');
      return;
    }

    let pdfBase64 = null;

    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      pdfBase64 = btoa(binary);
    } else if (state.currentPdfBase64) {
      pdfBase64 = state.currentPdfBase64;
    } else {
      showToast('Upload a PDF file or generate one first.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/web/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64, expectedHash }),
      });

      const data = await res.json();
      displayVerificationResult(data);
    } catch (err) {
      showToast('Verification request failed: ' + err.message, 'error');
    }
  });
}

function displayVerificationResult(data) {
  const alertEl = document.getElementById('verificationResultAlert');
  const badgeEl = document.getElementById('resultBadge');
  const msgEl = document.getElementById('resultMessage');
  const computedEl = document.getElementById('resultComputedHash');
  const expectedEl = document.getElementById('resultExpectedHash');

  alertEl.classList.remove('hidden', 'success', 'tampered');

  if (data.verified) {
    alertEl.classList.add('success');
    badgeEl.textContent = '🔒 Cryptographically Verified (Match)';
    badgeEl.style.color = 'var(--success)';
    msgEl.textContent = data.message;
    showToast('Document integrity verified — no tampering detected', 'success', 5000);
  } else {
    alertEl.classList.add('tampered');
    badgeEl.textContent = '⚠️ Tamper Detected (Mismatch)';
    badgeEl.style.color = 'var(--danger)';
    msgEl.textContent = data.message;
    showToast('Tamper alert! Document hash mismatch detected', 'error', 6000);
  }

  computedEl.textContent = data.computedHash;
  expectedEl.textContent = data.expectedHash;
}

async function checkMicroserviceHealth() {
  const startTime = Date.now();
  const pill = document.getElementById('serviceStatusPill');
  const text = document.getElementById('serviceStatusText');
  const latency = document.getElementById('serviceLatency');
  const pre = document.getElementById('healthJsonOutput');

  try {
    const res = await fetch('/health');
    const elapsed = Date.now() - startTime;
    const data = await res.json();

    if (res.ok) {
      text.textContent = 'Engine Online';
      latency.textContent = `${elapsed}ms`;
      pill.className = 'status-pill status-online';
      if (pre) pre.textContent = JSON.stringify(data, null, 2);
    } else {
      text.textContent = 'Engine Degraded';
      pill.className = 'status-pill status-degraded';
      if (pre) pre.textContent = JSON.stringify(data, null, 2);
    }
  } catch (err) {
    text.textContent = 'Engine Offline';
    latency.textContent = 'Err';
    pill.className = 'status-pill status-offline';
    if (pre) pre.textContent = 'Error connecting to /health endpoint:\n' + err.message;
  }
}
