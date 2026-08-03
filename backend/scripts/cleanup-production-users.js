/**
 * Production cleanup: keep ONLY the Owner account (leadflow.my@gmail.com).
 * Archives deleted users to backend/backups before removal.
 *
 * Usage: node scripts/cleanup-production-users.js [--execute]
 * Default is dry-run.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query } = require('../config/db');

const OWNER = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com')
  .split(',')[0].trim().toLowerCase();

async function main() {
  const execute = process.argv.includes('--execute');
  const { rows } = await query(
    'SELECT id, email, full_name, role, subscription_status, created_at FROM users ORDER BY created_at',
  );
  const keep = rows.filter((u) => (u.email || '').toLowerCase() === OWNER);
  const remove = rows.filter((u) => (u.email || '').toLowerCase() !== OWNER);

  console.log(`[Cleanup] Owner keep: ${OWNER} (${keep.length})`);
  console.log(`[Cleanup] Will remove ${remove.length} accounts:`);
  remove.forEach((u) => console.log(`  - ${u.email} (${u.id}) role=${u.role}`));

  if (!execute) {
    console.log('[Cleanup] Dry-run only. Re-run with --execute to apply.');
    process.exit(0);
  }

  if (!keep.length) {
    console.error('[Cleanup] ABORT: Owner account not found. Refusing to delete users.');
    process.exit(1);
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `users-pre-cleanup-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ kept: keep, removed: remove, at: new Date().toISOString() }, null, 2));
  console.log('[Cleanup] Backup written:', backupFile);

  for (const u of remove) {
    await query('DELETE FROM users WHERE id = $1', [u.id]);
    console.log('[Cleanup] Deleted', u.email);
  }

  const left = await query('SELECT email, role FROM users');
  console.log('[Cleanup] Remaining users:', left.rows);
  process.exit(0);
}

main().catch((err) => {
  console.error('[Cleanup] Fatal:', err.message);
  process.exit(1);
});
