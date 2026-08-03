/**
 * NON-DESTRUCTIVE: insert one isolated success event + library row for V2 UI checks.
 * Does not update/delete any existing rows.
 */
require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/db');
const oi = require('../services/ownerIntelligence');
const {
  computeAiScore,
  buildRecommendations,
} = require('../services/ownerIntelligenceScore');

async function main() {
  await oi.ensureTables();
  const ws = 'ws_intel_isolated_v2_verify';
  const id = `ose_isolated_${uuidv4()}`;
  const libId = `ocl_${id}`;
  const scored = computeAiScore({
    revenue: 4800,
    conversionRate: 42,
    replyRate: 28,
    meetings: 4,
    deals: 2,
    leadQuality: 80,
    messageQuality: 0.7,
    timingScore: 0.8,
    followUpSuccess: 0.85,
  });
  const recs = buildRecommendations({
    aiScore: scored.aiScore,
    industry: 'Optometry',
    country: 'Singapore',
    channel: 'email',
    conversionRate: 42,
    replyRate: 28,
    revenue: 4800,
    deals: 2,
    timing: { avgSendHourUtc: 9 },
    copyStyle: 'offer-led',
    whyItWorked: 'Isolated V2 verify record — high conversion email sequence.',
  });
  const now = new Date().toISOString();
  await query(
    `INSERT INTO owner_success_events
     (id, fingerprint, workspace_id, customer_email, customer_name, event_type, severity, title, summary,
      country, industry, campaign_name, revenue, lead_count, replies, meetings, deals, conversion_rate, channel,
      metrics, created_at, ai_score, score_label, pinned, archived, ignored, is_test, recommendations, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'success',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$22,FALSE,FALSE,FALSE,TRUE,$23::jsonb,$20)
     ON CONFLICT (fingerprint) DO NOTHING`,
    [
      id,
      `${ws}:isolated_v2:${now.slice(0, 10)}`,
      ws,
      'isolated-v2@verify.test',
      'Isolated V2 Clinic',
      'revenue_generated',
      'Isolated V2 high performer',
      `Isolated verify · AI ${scored.aiScore}/10 · Optometry · Singapore`,
      'Singapore',
      'Optometry',
      'Isolated V2 Email Growth',
      4800,
      40,
      12,
      4,
      2,
      42,
      'email',
      JSON.stringify({ replyRate: 28, leadQuality: 80, timing: { avgSendHourUtc: 9 }, copyStyle: 'offer-led' }),
      now,
      scored.aiScore,
      scored.scoreLabel,
      JSON.stringify(recs),
    ],
  );
  await query(
    `INSERT INTO owner_campaign_library
     (id, success_event_id, workspace_id, name, industry, country, channel, revenue, conversion_rate,
      why_it_worked, assets, sequences, funnel, timeline, offer, copy_style, prompts, tags,
      searchable, status, created_at, updated_at, ai_score, score_label, pinned, archived, ignored, is_test,
      recommendations, reply_rate, lead_quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'[]'::jsonb,$11,$12,'[]'::jsonb,$13,$14,'active',$15,$15,$16,$17,FALSE,FALSE,FALSE,TRUE,$18::jsonb,$19,$20)
     ON CONFLICT (id) DO NOTHING`,
    [
      libId,
      id,
      ws,
      'Isolated V2 Email Growth',
      'Optometry',
      'Singapore',
      'email',
      4800,
      42,
      'Isolated V2 verify record — high conversion email sequence.',
      'Free eye exam offer',
      'offer-led',
      ['test', 'isolated', 'optometry'],
      'isolated v2 email growth optometry singapore email',
      now,
      scored.aiScore,
      scored.scoreLabel,
      JSON.stringify(recs),
      28,
      80,
    ],
  );
  console.log(JSON.stringify({ inserted: true, successEventId: id, libraryId: libId, aiScore: scored.aiScore, workspace: ws }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
