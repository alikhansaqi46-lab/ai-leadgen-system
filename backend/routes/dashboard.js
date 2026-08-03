/**
 * GET /api/dashboard/metrics — enterprise KPI payload (real data only)
 * GET /api/dashboard/drilldown?metric=hotLeads — related record ids/links
 */

const express = require('express');
const router = express.Router();
const { getDashboardMetrics } = require('../services/dashboardStats');
const leadStorage = require('../utils/leadStorage');
const scoreStorage = require('../utils/scoreStorage');
const campaignStorage = require('../utils/campaignStorage');
const conversationStorage = require('../utils/conversationStorage');
const timelineStorage = require('../utils/timelineStorage');
const automationStorage = require('../utils/automationStorage');

const { workspaceOf } = require('../utils/workspaceContext');

router.get('/metrics', async (req, res) => {
  try {
    const data = await getDashboardMetrics(workspaceOf(req));
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('[Dashboard] metrics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/drilldown', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const metric = String(req.query.metric || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

    if (!metric) return res.status(400).json({ error: 'metric query param is required' });

    const [leads, scores, campaigns, timeline] = await Promise.all([
      leadStorage.getLeads({ workspaceId, limit: 10000 }).catch(() => []),
      scoreStorage.getScores({ workspaceId }).catch(() => []),
      campaignStorage.getAll({ workspaceId }).catch(() => []),
      timelineStorage.getWorkspaceEvents({ workspaceId, limit: 5000 }).catch(() => []),
    ]);
    const scoreByLead = new Map((scores || []).map((s) => [s.leadId, s]));
    const campByLead = new Map((campaigns || []).map((c) => [c.leadId, c]));

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const leadItem = (l, extra = {}) => ({
      id: l.id,
      name: l.name || l.id,
      score: scoreByLead.get(l.id)?.score,
      status: campByLead.get(l.id)?.status || 'new',
      href: `/app/leads?focus=${encodeURIComponent(l.id)}`,
      ...extra,
    });

    let items = [];

    switch (metric) {
      case 'totalLeads':
        items = leads.map((l) => leadItem(l));
        break;
      case 'emailsFound':
        items = leads
          .filter((l) => {
            const e = String(l.email || l.data?.email || '').trim();
            return e && e.toUpperCase() !== 'N/A' && e.includes('@');
          })
          .map((l) => leadItem(l));
        break;
      case 'phoneNumbers':
        items = leads
          .filter((l) => String(l.phone || '').replace(/\D/g, '').length >= 7)
          .map((l) => leadItem(l));
        break;
      case 'whatsappNumbers':
        items = leads
          .filter((l) => {
            const wa = String(l.whatsapp || l.data?.whatsapp || '').replace(/\D/g, '');
            const phone = String(l.phone || '').replace(/\D/g, '');
            return wa.length >= 7 || phone.length >= 7;
          })
          .map((l) => leadItem(l, { href: '/app/whatsapp' }));
        break;
      case 'websitesFound':
        items = leads
          .filter((l) => {
            const w = String(l.website || l.data?.website || '').trim();
            return w && w.toUpperCase() !== 'N/A' && w.includes('.');
          })
          .map((l) => leadItem(l));
        break;
      case 'newLeadsToday':
        items = leads
          .filter((l) => l.createdAt && new Date(l.createdAt) >= today)
          .map((l) => leadItem(l));
        break;
      case 'repliesReceived':
      case 'followUpsScheduled':
      case 'appointmentsBooked':
        if (metric === 'appointmentsBooked') {
          items = leads
            .filter((l) => campByLead.get(l.id)?.status === 'meeting')
            .map((l) => leadItem(l, { href: '/app/leads?status=meeting' }));
        } else if (metric === 'repliesReceived') {
          items = leads
            .filter((l) => ['replied', 'interested', 'meeting', 'deal'].includes(campByLead.get(l.id)?.status))
            .map((l) => leadItem(l, { href: '/app/inbox' }));
        } else {
          items = [];
        }
        break;
      case 'hotLeads':
      case 'warmLeads':
      case 'coldLeads': {
        const p = metric.replace('Leads', '');
        items = leads
          .filter((l) => String(scoreByLead.get(l.id)?.priority || '').toLowerCase() === p)
          .map((l) => leadItem(l, { href: `/app/leads?priority=${p}` }));
        break;
      }
      case 'qualifiedLeads':
        items = leads
          .filter((l) => scoreByLead.get(l.id)?.score != null)
          .map((l) => leadItem(l, { href: '/app/ai-agent' }));
        break;
      case 'meetingsBooked':
      case 'dealsWon':
      case 'dealsLost':
      case 'revenue':
      case 'conversionRate':
      case 'pipelineValue': {
        const statusMap = {
          meetingsBooked: ['meeting'],
          dealsWon: ['deal'],
          dealsLost: ['lost'],
          revenue: ['deal'],
          conversionRate: ['deal'],
          pipelineValue: ['interested', 'meeting', 'deal'],
        };
        const statuses = statusMap[metric] || [];
        items = leads
          .filter((l) => statuses.includes(campByLead.get(l.id)?.status))
          .map((l) => leadItem(l, {
            href: `/app/leads?status=${campByLead.get(l.id)?.status || 'deal'}`,
            status: campByLead.get(l.id)?.status,
            revenue: campByLead.get(l.id)?.revenue ?? null,
          }));
        break;
      }
      case 'emailsSent':
      case 'emailsDelivered':
      case 'emailsOpened':
      case 'emailReplies':
      case 'whatsappSent':
      case 'whatsappDelivered':
      case 'whatsappRead':
      case 'whatsappReplies':
      case 'smsSent':
      case 'smsDelivered': {
        const channel =
          metric.startsWith('email') ? 'email'
            : metric.startsWith('whatsapp') ? 'whatsapp'
              : 'sms';
        const typeMap = {
          emailsOpened: 'email_opened',
          emailsDelivered: null,
          whatsappDelivered: 'message_delivered',
          whatsappRead: 'message_read',
          smsDelivered: 'message_delivered',
        };
        const eventType = typeMap[metric];
        if (eventType) {
          const leadIds = new Set(
            (timeline || [])
              .filter((e) => e.type === eventType && (!e.channel || e.channel === channel || metric.startsWith('email')))
              .map((e) => e.leadId)
              .filter(Boolean)
          );
          items = leads.filter((l) => leadIds.has(l.id)).map((l) => leadItem(l, {
            href: `/app/inbox?channel=${channel}`,
          }));
        } else {
          // Channel activity: leads with outbound on channel via campaign or conversation
          const convs = conversationStorage.getConversations
            ? await conversationStorage.getConversations({ workspaceId, limit: 5000 }).catch(() => [])
            : [];
          const list = Array.isArray(convs) ? convs : (convs.conversations || []);
          const leadIds = new Set(
            list.filter((c) => c.channel === channel).map((c) => c.leadId).filter(Boolean)
          );
          // Also include replied/sent campaigns for reply metrics
          if (metric.endsWith('Replies')) {
            items = leads
              .filter((l) => {
                const st = campByLead.get(l.id)?.status;
                return leadIds.has(l.id) || ['replied', 'interested', 'meeting', 'deal'].includes(st);
              })
              .map((l) => leadItem(l, { href: `/app/inbox?channel=${channel}` }));
          } else {
            items = leads
              .filter((l) => leadIds.has(l.id) || (campByLead.get(l.id)?.messageCount > 0))
              .map((l) => leadItem(l, { href: `/app/${channel === 'email' ? 'email' : channel}` }));
          }
        }
        break;
      }
      case 'aiSuccessRate': {
        const runs = await automationStorage.listRuns({ workspaceId, limit }).catch(() => []);
        items = (runs || []).map((r) => ({
          id: r.id,
          name: `${r.triggerType || 'run'} · ${r.status}`,
          status: r.status,
          href: '/app/automations',
        }));
        break;
      }
      case 'openConversations': {
        const convs = conversationStorage.getConversations
          ? await conversationStorage.getConversations({ workspaceId, limit }).catch(() => [])
          : [];
        const list = Array.isArray(convs) ? convs : (convs.conversations || []);
        items = list
          .filter((c) => String(c.status || 'open') === 'open' && !c.archived)
          .map((c) => ({
            id: c.id,
            name: c.subject || c.leadId,
            channel: c.channel,
            href: '/app/inbox',
          }));
        break;
      }
      default:
        items = [];
    }

    res.json({ success: true, metric, count: items.length, items: items.slice(0, limit) });
  } catch (err) {
    console.error('[Dashboard] drilldown error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
