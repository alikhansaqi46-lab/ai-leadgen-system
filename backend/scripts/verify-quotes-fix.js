require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const quoteStorage = require('../utils/quoteStorage');

(async () => {
  const ws = 'usr_super_admin_1783323507243';

  // 1. Driver check — must be postgres, no fallback
  console.log('STORAGE_DRIVER =', process.env.STORAGE_DRIVER);

  // 2. List docs from Postgres
  const { items, total } = await quoteStorage.list({ workspaceId: ws, limit: 20 });
  console.log(`Postgres docs for ${ws}: ${total}`);
  for (const d of items) console.log(' ', d.number, d.docType, d.status, 'total=', d.total, d.currency);

  // 3. Migrated doc retrievable by its JSON-era ID (Inbox card opens this)
  const migrated = await quoteStorage.get('qt_92a9d3e2-1218-4b79-bbd9-a7e708f94672', ws);
  console.log('Migrated QT-2026-0001 in Postgres:', migrated ? `YES (total=${migrated.total} ${migrated.currency}, token=${migrated.publicToken})` : 'NO');

  // 4. computeTotals with currency-formatted strings
  const t = quoteStorage.computeTotals({
    lineItems: [
      { description: 'Toothpaste', quantity: '2', unitPrice: 'RM50', discount: 0 },
      { description: 'Kit', quantity: 1, unitPrice: 'MYR 1,200.50' },
    ],
    discountPct: '10%', taxPct: 6, shipping: 'RM15',
  });
  console.log('computeTotals currency-string test:', JSON.stringify({ subtotal: t.subtotal, discount: t.discountAmount, tax: t.taxAmount, total: t.total }));
  // expected: subtotal = 100 + 1200.50 = 1300.50; discount 10% = 130.05; taxable 1170.45; tax 70.43 (1170.45*0.06=70.227→70.23); total = 1170.45+70.23+15 = 1255.68

  // 5. aiNum-style parse via quoteService parseAiDocument is internal; emulate AI output through create path not needed.
  console.log('All checks done.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
