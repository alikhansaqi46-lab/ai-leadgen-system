/**
 * Extract Supabase pooler TLS chain and verify Postgres with Supabase Root CA.
 * Run: node --use-system-ca scripts/fix-supabase-pg-tls.js
 */
require('dotenv').config();
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const CERT_DIR = path.join(__dirname, '..', 'certs');
fs.mkdirSync(CERT_DIR, { recursive: true });

function extractChain(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => {
      const buf = Buffer.alloc(8);
      buf.writeInt32BE(8, 0);
      buf.writeInt32BE(80877103, 4);
      sock.write(buf);
    });
    sock.once('data', (d) => {
      if (d.toString('utf8')[0] !== 'S') {
        reject(new Error('Server refused SSL'));
        return;
      }
      const secure = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
        const pems = [];
        let c = secure.getPeerCertificate(true);
        const seen = new Set();
        while (c && c.raw) {
          const fp = c.fingerprint256 || c.fingerprint;
          if (seen.has(fp)) break;
          seen.add(fp);
          const b64 = c.raw.toString('base64');
          const body = b64.match(/.{1,64}/g).join('\n');
          pems.push({
            cn: (c.subject && c.subject.CN) || '',
            issuer: (c.issuer && c.issuer.CN) || '',
            pem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
          });
          c = c.issuerCertificate && c.issuerCertificate !== c ? c.issuerCertificate : null;
        }
        secure.end();
        resolve(pems);
      });
      secure.on('error', reject);
    });
    sock.on('error', reject);
  });
}

(async () => {
  const cs = process.env.DATABASE_URL || '';
  const m = cs.match(/@([^:/]+):(\d+)/);
  if (!m) throw new Error('Cannot parse DATABASE_URL host');
  const host = m[1];
  const port = Number(m[2]);

  const chain = await extractChain(host, port);
  console.log('Chain:');
  chain.forEach((c, i) => console.log(`  [${i}] CN=${c.cn} issuer=${c.issuer}`));

  const bundlePath = path.join(CERT_DIR, 'supabase-pooler-chain.pem');
  const rootPath = path.join(CERT_DIR, 'supabase-root-2021.pem');
  fs.writeFileSync(bundlePath, chain.map((c) => c.pem).join('\n'));
  const root = chain[chain.length - 1];
  fs.writeFileSync(rootPath, root.pem);
  console.log('Wrote', bundlePath);
  console.log('Wrote', rootPath, 'CN=', root.cn);

  const ca = tls.rootCertificates.concat(chain.map((c) => c.pem));
  const pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: true, ca },
  });
  try {
    const r = await pool.query(
      `select current_database() as db,
              (select count(*)::int from users) as users`
    );
    console.log('DB_OK', r.rows[0]);
    const users = await pool.query(
      `select id, email, email_verified, role,
              (password_hash is not null and length(coalesce(password_hash,'')) > 20) as has_bcrypt
       from users order by created_at nulls last limit 10`
    );
    console.log('USERS', JSON.stringify(users.rows, null, 2));
  } catch (e) {
    console.log('DB_FAIL', e.message);
    process.exitCode = 2;
  } finally {
    await pool.end().catch(() => {});
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
