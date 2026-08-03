require('dotenv').config();
const { query } = require('../config/db');

(async () => {
  const r = await query(`
    SELECT id, campaign_name, pinned, archived, ignored, workspace_id
    FROM owner_success_events
    WHERE COALESCE(pinned,false) OR COALESCE(archived,false) OR COALESCE(ignored,false)
    ORDER BY updated_at DESC NULLS LAST
  `);
  console.log(JSON.stringify(r.rows, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
