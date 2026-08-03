require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const integrationStorage = require('../utils/integrationStorage');

const ws = 'usr_super_admin_1783323507243';
const rec = integrationStorage.get(ws, 'email');
if (!rec) {
  console.log('No email integration record for', ws);
  process.exit(0);
}
console.log('connected:', rec.connected);
console.log('needsReconnect:', rec.needsReconnect);
console.log('reconnectReason:', rec.reconnectReason);
console.log('account:', rec.account);
console.log('updatedAt:', rec.updatedAt);
console.log('connectedAt:', rec.connectedAt);
const c = rec.credentials || {};
console.log('credentials present:', !!rec.credentials);
console.log('has accessToken:', !!c.accessToken, c.accessToken ? `(len ${c.accessToken.length})` : '');
console.log('has refreshToken:', !!c.refreshToken, c.refreshToken ? `(len ${c.refreshToken.length})` : '');
console.log('expiryDate:', c.expiryDate);
console.log('scope:', c.scope);

// Also list every workspace that has an email record (in case of workspace mismatch)
for (const w of integrationStorage.listAllWorkspaces()) {
  const r = integrationStorage.get(w, 'email');
  if (r) console.log(`workspace ${w}: email connected=${r.connected} needsReconnect=${r.needsReconnect} hasRefresh=${!!r.credentials?.refreshToken} account=${r.account}`);
}
process.exit(0);
