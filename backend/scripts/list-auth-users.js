require('dotenv').config();
const { getPool } = require('../config/db');
const { loadExtraCaPems } = require('../config/tls');

(async () => {
  console.log('extra CAs loaded', loadExtraCaPems().length);
  const pool = getPool();
  const r = await pool.query(
    `select email, email_verified, role,
            (password_hash is not null and length(coalesce(password_hash,'')) > 20) as has_bcrypt
     from users
     where role in ('admin','super_admin')
        or email ilike '%leadflow%'
     order by email`
  );
  console.log(JSON.stringify(r.rows, null, 2));
  const c = await pool.query('select count(*)::int as c from users');
  console.log('total users', c.rows[0].c);
  await pool.end();
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(2);
});
