/**
 * Reports service — campaign / channel performance from real storage only.
 * Reuses dashboardStats for all-time KPIs so Dashboard and Reports never diverge.
 */

const timelineStorage = require('../utils/timelineStorage');
const { getDashboardMetrics } = require('./dashboardStats');

function inRange(iso, from, to) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < from.getTime()) return false;
  if (to && t > to.getTime()) return false;
  return true;
}

async function buildPerformanceReport({ workspaceId, days = 30 } = {}) {
  const dayCount = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
  const to = new Date();
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  from.setUTCDate(from.getUTCDate() - (dayCount - 1));

  const [dash, timeline] = await Promise.all([
    getDashboardMetrics(workspaceId),
    timelineStorage.getWorkspaceEvents({ workspaceId, limit: 5000 }).catch(() => []),
  ]);

  const events = (timeline || []).filter((e) => inRange(e.createdAt || e.created_at, from, to));
  const m = dash.metrics || {};
  const channels = dash.channels || {};

  const emailOpens = events.filter((e) => e.type === 'email_opened').length;
  const emailClicks = events.filter((e) => e.type === 'link_clicked').length;
  const emailBounces = events.filter((e) => e.type === 'email_bounced').length;
  const waDelivered = events.filter((e) => e.type === 'message_delivered' && e.channel === 'whatsapp').length;
  const waRead = events.filter((e) => e.type === 'message_read' && e.channel === 'whatsapp').length;
  const messagesSent = events.filter((e) => e.type === 'message_sent' || e.type === 'email_sent' || e.type === 'follow_up_sent').length;
  const replies = events.filter((e) => e.type === 'message_received').length;
  const leadsCreatedInRange = events.filter((e) => e.type === 'lead_created').length;

  return {
    workspaceId,
    generatedAt: new Date().toISOString(),
    range: { from: from.toISOString(), to: to.toISOString(), days: dayCount },
    summary: {
      totalLeads: m.totalLeads || 0,
      leadsCreatedInRange,
      hot: m.hotLeads || 0,
      warm: m.warmLeads || 0,
      cold: m.coldLeads || 0,
      dealsWon: m.dealsWon || 0,
      dealsLost: m.dealsLost || 0,
      meetings: m.meetingsBooked || 0,
      revenue: m.revenue || 0,
      conversionRate: m.conversionRate || 0,
      replyRate: m.replyRate || 0,
      pipelineValue: m.pipelineValue || 0,
      aiSuccessRate: m.aiSuccessRate || 0,
    },
    pipeline: dash.pipeline || {},
    channels: {
      email: {
        sent: Number(channels.email?.sent || 0),
        replies: Number(channels.email?.replies || 0),
        delivered: Number(channels.email?.delivered || 0),
        opensInRange: emailOpens,
        clicksInRange: emailClicks,
        bouncesInRange: emailBounces,
      },
      whatsapp: {
        sent: Number(channels.whatsapp?.sent || 0),
        replies: Number(channels.whatsapp?.replies || 0),
        delivered: Number(channels.whatsapp?.delivered || 0),
        deliveredInRange: waDelivered,
        readInRange: waRead,
      },
      sms: {
        sent: Number(channels.sms?.sent || 0),
        replies: Number(channels.sms?.replies || 0),
        delivered: Number(channels.sms?.delivered || 0),
      },
    },
    activityInRange: {
      messagesSent,
      replies,
      emailOpens,
      emailClicks,
      emailBounces,
      waDelivered,
      waRead,
    },
    automations: {
      enabled: dash.automations?.enabledAutomations || 0,
      runsSucceeded: dash.automations?.runsSucceeded || 0,
      runsFailed: dash.automations?.runsFailed || 0,
    },
  };
}

module.exports = { buildPerformanceReport };
