/**
 * Deterministic Owner Intelligence scoring + recommendations (no network).
 */

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function scoreLabel(score) {
  const s = Number(score) || 0;
  if (s >= 9) return 'Excellent';
  if (s >= 8) return 'Very Good';
  if (s >= 6.5) return 'Average';
  return 'Weak';
}

/**
 * Compute 0–10 AI campaign score from outcome metrics.
 */
function computeAiScore(input = {}) {
  const revenue = Number(input.revenue) || 0;
  const conversionRate = Number(input.conversionRate) || 0;
  const replyRate = Number(input.replyRate) || 0;
  const meetings = Number(input.meetings) || 0;
  const deals = Number(input.deals) || 0;
  const leadQuality = Number(input.leadQuality) || 0;
  const messageQuality = Number(input.messageQuality) || 0; // 0–1
  const timingScore = Number(input.timingScore) || 0; // 0–1
  const followUpSuccess = Number(input.followUpSuccess) || 0; // 0–1

  let score = 0;
  score += clamp(revenue / 2000, 0, 2.5); // up to 2.5 for ~$5k+
  score += clamp(conversionRate / 50, 0, 2.0);
  score += clamp(replyRate / 40, 0, 1.5);
  score += clamp(meetings / 5, 0, 1.0);
  score += clamp(deals * 0.75, 0, 1.5);
  score += clamp(leadQuality / 100, 0, 0.5);
  score += clamp(messageQuality, 0, 0.5);
  score += clamp(timingScore, 0, 0.25);
  score += clamp(followUpSuccess, 0, 0.25);

  const aiScore = Math.round(clamp(score, 0, 10) * 10) / 10;
  return { aiScore, scoreLabel: scoreLabel(aiScore) };
}

function inferMessageQuality(metrics = {}, creative = {}) {
  const msgs = metrics.winningMessages || creative.winningMessages || [];
  const prompts = creative.prompts || [];
  let q = 0.2;
  if (msgs.length >= 2) q += 0.2;
  if (prompts.length >= 2) q += 0.2;
  if ((creative.copyStyle || metrics.copyStyle) === 'offer-led') q += 0.15;
  if ((creative.copyStyle || metrics.copyStyle) === 'question-led') q += 0.1;
  return clamp(q, 0, 1);
}

function inferTimingScore(metrics = {}, creative = {}) {
  const hour = metrics.timing?.avgSendHourUtc ?? creative.timing?.avgSendHourUtc;
  if (hour == null) return 0.1;
  // Business-friendly UTC hours get a bump
  if (hour >= 7 && hour <= 11) return 0.9;
  if (hour >= 13 && hour <= 17) return 0.75;
  return 0.35;
}

function buildRecommendations(payload = {}) {
  const score = Number(payload.aiScore) || 0;
  const industry = payload.industry || 'General';
  const country = payload.country || 'Multi-market';
  const channel = payload.channel || 'multi';
  const conversionRate = Number(payload.conversionRate) || 0;
  const replyRate = Number(payload.replyRate) || 0;
  const revenue = Number(payload.revenue) || 0;
  const timing = payload.timing?.avgSendHourUtc;
  const copyStyle = payload.copyStyle || 'direct';

  const weaknesses = [];
  if (conversionRate < 10) weaknesses.push('Conversion rate is below strong benchmarks (<10%).');
  if (replyRate < 15) weaknesses.push('Reply rate leaves room for stronger openers / CTAs.');
  if (revenue < 500) weaknesses.push('Revenue signal is still light — validate with more closes.');
  if (!payload.deals) weaknesses.push('No deals recorded yet — push harder on meeting→close.');
  if (!weaknesses.length) weaknesses.push('No major weaknesses detected — protect this playbook.');

  const reuseConfidence = clamp(
    Math.round((score / 10) * 55 + clamp(conversionRate, 0, 40) + (payload.deals ? 10 : 0)),
    15,
    96,
  );

  const expectedMultiplier = score >= 9 ? 1.35 : score >= 8 ? 1.2 : score >= 6.5 ? 1.05 : 0.85;
  const expectedPerformance = {
    expectedConversion: Math.round(conversionRate * expectedMultiplier * 10) / 10,
    expectedReplyRate: Math.round(Math.max(replyRate, 8) * expectedMultiplier * 10) / 10,
    expectedRevenueLiftPct: Math.round((expectedMultiplier - 1) * 100),
  };

  return {
    aiScore: score,
    scoreLabel: scoreLabel(score),
    whyItPerformed: payload.whyItWorked
      || `Strong ${channel} outcomes in ${industry} (${country}) with ${copyStyle} copy.`,
    weaknesses,
    bestAudience: `${industry} decision-makers actively evaluating growth offers`,
    bestCountry: country,
    bestIndustry: industry,
    bestSendTime: timing != null ? `${timing}:00 UTC (avg historical send hour)` : 'Weekday mornings local time',
    recommendedChannel: channel === 'multi' ? 'whatsapp' : channel,
    reuseConfidence,
    expectedPerformance,
    actionHint: score >= 8
      ? 'Pin and reuse via Launch Wizard for similar workspaces.'
      : score >= 6.5
        ? 'Study sequences, then adapt offer before relaunch.'
        : 'Ignore or archive — low reuse value unless niche is rare.',
  };
}

function isTestWorkspace(workspaceId, tags = []) {
  const ws = String(workspaceId || '');
  if (/^ws_intel_demo_/i.test(ws) || /demo|test|sandbox/i.test(ws)) return true;
  if ((tags || []).some((t) => /test|demo/i.test(String(t)))) return true;
  return false;
}

module.exports = {
  computeAiScore,
  scoreLabel,
  buildRecommendations,
  inferMessageQuality,
  inferTimingScore,
  isTestWorkspace,
};
