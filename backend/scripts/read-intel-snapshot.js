/**
 * Read-only snapshot of Owner Intelligence tables (no writes).
 */
require('dotenv').config();
const { query } = require('../config/db');

async function main() {
  const ev = await query(`
    SELECT COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE COALESCE(is_test,false))::int AS test_n,
      COUNT(*) FILTER (WHERE COALESCE(pinned,false))::int AS pinned_n,
      COUNT(*) FILTER (WHERE COALESCE(archived,false))::int AS arch_n,
      ROUND(AVG(COALESCE(ai_score,0))::numeric,2) AS avg_score,
      MAX(ai_score) AS max_score
    FROM owner_success_events
  `);
  const lib = await query('SELECT COUNT(*)::int AS n FROM owner_campaign_library');
  const sample = await query(`
    SELECT id, campaign_name, industry, country, channel, revenue, conversion_rate,
           ai_score, score_label, pinned, archived, ignored, is_test, workspace_id, created_at
    FROM owner_success_events
    ORDER BY created_at DESC
    LIMIT 10
  `);
  let notifs = { rows: [] };
  try {
    notifs = await query(`
      SELECT id, title, LEFT(body, 140) AS body, source, category, created_at
      FROM admin_notifications
      WHERE category = 'success' OR source LIKE 'ose_%'
      ORDER BY created_at DESC
      LIMIT 8
    `);
  } catch (_) {
    try {
      notifs = await query(`
        SELECT id, title, LEFT(body, 140) AS body, source, category, created_at
        FROM owner_notifications
        WHERE category = 'success' OR source LIKE 'ose_%'
        ORDER BY created_at DESC
        LIMIT 8
      `);
    } catch (e2) {
      notifs = { rows: [], error: e2.message };
    }
  }
  console.log(JSON.stringify({
    events: ev.rows[0],
    library: lib.rows[0],
    sample: sample.rows,
    notifs: notifs.rows,
    notifError: notifs.error || null,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
