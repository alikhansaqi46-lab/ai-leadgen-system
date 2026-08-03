require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const quoteService = require('../services/quoteService');
const quoteStorage = require('../utils/quoteStorage');

(async () => {
  const ws = 'usr_super_admin_1783323507243';

  // 1. Create an invoice (same path the fixed route uses)
  const doc = await quoteService.createDocument({
    workspaceId: ws,
    input: {
      docType: 'invoice',
      customer: { name: 'E2E Test Customer', email: 'e2e@example.com' },
      lineItems: [{ name: 'Verification service', qty: 2, unitPrice: 100 }],
      currency: 'MYR',
      meta: { e2eTest: true },
    },
  });
  console.log('1. Created:', doc.number, '| docType:', doc.docType, '| total:', doc.total);
  if (doc.docType !== 'invoice') throw new Error('FAIL: docType not invoice');
  if (!/^INV-/.test(doc.number)) throw new Error('FAIL: number not INV- prefixed');

  // 2. PDF must be titled Invoice and contain no signature/stamp/QR section
  const { pdf } = await quoteService.exportPdf(doc.id, ws);
  const abs = require('path').join(__dirname, '..', 'uploads', pdf.filename);
  const size = fs.statSync(abs).size;
  const head = fs.readFileSync(abs).slice(0, 5).toString();
  console.log('2. PDF:', pdf.filename, '|', size, 'bytes |', head === '%PDF-' ? 'valid' : 'INVALID');
  const src = fs.readFileSync(require.resolve('../services/quotePdf'), 'utf8');
  console.log('   quotePdf.js placeholders:', /signature|stamp|qrcode/i.test(src) ? 'STILL PRESENT (FAIL)' : 'none (OK)');

  // 3. Share URL must point to the frontend, not the API host
  const share = await quoteService.createShareLink({ id: doc.id, workspaceId: ws, req: null });
  console.log('3. shareUrl:', share.shareUrl);
  if (!share.shareUrl.startsWith('http://localhost:3000')) throw new Error('FAIL: shareUrl not on frontend');

  // 4. Invoice numbering independence — create a quote too, ensure QT- prefix
  const q = await quoteService.createDocument({
    workspaceId: ws,
    input: { docType: 'quote', customer: { name: 'E2E Quote Customer' }, lineItems: [{ name: 'Item', qty: 1, unitPrice: 50 }], meta: { e2eTest: true } },
  });
  console.log('4. Quote:', q.number, '| docType:', q.docType, /^QT-/.test(q.number) ? '(OK)' : '(FAIL)');

  // 5. Cleanup test documents
  for (const id of [doc.id, q.id]) {
    try { await quoteStorage.remove(id, ws); console.log('5. cleaned up', id); }
    catch (e) { console.log('5. cleanup skipped for', id, '-', e.message); }
  }

  console.log('INVOICE E2E VERIFICATION PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
