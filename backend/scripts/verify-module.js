require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');
const quoteStorage = require('../utils/quoteStorage');

(async () => {
  const ws = 'usr_super_admin_1783323507243';

  // 1. Owner Intelligence sales snapshot SQL (same query as ownerIntelligence.js)
  const salesMeta = await query(`
    SELECT workspace_id,
      COUNT(*) FILTER (WHERE doc_type='quote')::int AS quotes_total,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating','accepted','converted'))::int AS quotes_sent,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating'))::int AS quotes_pending,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='accepted')::int AS quotes_accepted,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='rejected')::int AS quotes_rejected,
      COUNT(*) FILTER (WHERE doc_type='quote' AND status='converted')::int AS quotes_converted,
      COUNT(*) FILTER (WHERE doc_type='invoice')::int AS invoices_total,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status IN ('sent','unpaid','overdue','partially_paid'))::int AS invoices_unpaid,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status='paid')::int AS invoices_paid,
      COUNT(*) FILTER (WHERE doc_type='invoice' AND status IN ('sent','unpaid','overdue','partially_paid') AND due_date IS NOT NULL AND due_date < NOW())::int AS invoices_overdue,
      COALESCE(SUM(total) FILTER (WHERE doc_type='quote' AND status IN ('sent','viewed','negotiating','accepted','converted')),0)::float AS quote_value,
      COALESCE(SUM(total) FILTER (WHERE doc_type='invoice'),0)::float AS invoice_value,
      COALESCE(SUM(amount_paid) FILTER (WHERE doc_type='invoice'),0)::float AS paid_value
    FROM sales_documents GROUP BY workspace_id
  `);
  console.log('1. Owner Intelligence sales snapshot rows:', salesMeta.rows.length);
  for (const r of salesMeta.rows) console.log('  ', JSON.stringify(r));

  // 2. PDF generation for an existing quote (customer-facing deliverable)
  const { generateDocumentPdf } = require('../services/quotePdf');
  const doc = await quoteStorage.get('qt_8851c295-125c-4b15-8e8d-ca006ac45e0c', ws); // QT-2026-0005 total 32
  console.log('2. Doc for PDF:', doc ? `${doc.number} total=${doc.total} ${doc.currency}` : 'NOT FOUND');
  const pdf = await generateDocumentPdf(doc);
  const pdfPath = pdf.absolutePath;
  const size = fs.existsSync(pdfPath) ? fs.statSync(pdfPath).size : 0;
  const head = fs.existsSync(pdfPath) ? fs.readFileSync(pdfPath).slice(0, 5).toString() : '';
  console.log('   PDF generated:', pdf.urlPath, '| size:', size, 'bytes | header:', head === '%PDF-' ? '%PDF- OK' : 'INVALID');

  // 3. Public customer endpoints (share view + public PDF) — no auth, exactly what the customer receives
  const http = require('http');
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 5001, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ctype: res.headers['content-type'] }));
    }).on('error', reject);
  });
  const token = 'sh_e24571bc625c4a87af8ee8e53fed4d3f'; // QT-2026-0007 share token
  const shareRes = await get(`/api/public/quotes/${token}`);
  console.log('3. Public share JSON status:', shareRes.status, shareRes.status === 200 ? 'OK' : shareRes.body.slice(0, 120).toString());
  const pdfRes = await get(`/api/public/quotes/${token}/pdf`);
  console.log('   Public PDF status:', pdfRes.status, '| content-type:', pdfRes.ctype,
    '| header:', pdfRes.body.slice(0, 5).toString() === '%PDF-' ? '%PDF- OK' : 'INVALID', '| size:', pdfRes.body.length);

  // 4. Invoice duplicate/convert endpoints exist on storage layer
  const stats = await quoteStorage.stats(ws);
  console.log('4. Workspace stats:', JSON.stringify(stats));

  console.log('ALL MODULE CHECKS DONE');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
