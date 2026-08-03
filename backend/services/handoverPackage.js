/**
 * Customer handover package — real CRM snapshot for a won deal.
 * No invented fields; missing data stays null/empty.
 */

const leadStorage = require('../utils/leadStorage');
const campaignStorage = require('../utils/campaignStorage');
const scoreStorage = require('../utils/scoreStorage');
const conversationStorage = require('../utils/conversationStorage');
const timelineStorage = require('../utils/timelineStorage');
const contactStorage = require('../utils/contactStorage');

async function buildHandoverPackage(leadId, { workspaceId }) {
  if (!leadId) throw new Error('leadId required');

  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  const lead = (leads || []).find((l) => l.id === leadId) || null;
  if (!lead) throw new Error('Lead not found');

  const campaign = await campaignStorage.getByLeadId(leadId, { workspaceId }).catch(() => null);
  const scores = await scoreStorage.getScores({ workspaceId }).catch(() => []);
  const score = (scores || []).find((s) => s.leadId === leadId) || null;

  const conversations = await conversationStorage.getConversationsForLead(leadId, { workspaceId }).catch(() => []);
  const recentMessages = [];
  for (const conv of (conversations || []).slice(0, 5)) {
    const msgs = await conversationStorage.getMessages(conv.id, { workspaceId }).catch(() => []);
    const last = (msgs || []).slice(-10).map((m) => ({
      id: m.id,
      direction: m.direction,
      channel: m.channel || conv.channel,
      body: m.body,
      status: m.status || null,
      createdAt: m.createdAt,
    }));
    recentMessages.push({
      conversationId: conv.id,
      channel: conv.channel,
      subject: conv.subject || null,
      messages: last,
    });
  }

  const timeline = await timelineStorage.getEvents(leadId, { workspaceId }).catch(() => []);
  const notes = typeof contactStorage.getNotes === 'function'
    ? await contactStorage.getNotes(leadId, { workspaceId }).catch(() => [])
    : [];
  const contacts = [];

  const packageDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspaceId,
    lead: {
      id: lead.id,
      name: lead.name || null,
      phone: lead.phone || null,
      whatsapp: lead.whatsapp || lead.phone || null,
      email: lead.email && lead.email !== 'N/A' ? lead.email : null,
      website: lead.website && lead.website !== 'N/A' ? lead.website : null,
      address: lead.address || null,
      city: lead.city || null,
      country: lead.country || null,
      niche: lead.niche || null,
      rating: lead.rating ?? null,
      reviews: lead.reviews ?? null,
    },
    pipeline: campaign
      ? {
          status: campaign.status,
          sentAt: campaign.sentAt || null,
          repliedAt: campaign.repliedAt || null,
          interestedAt: campaign.interestedAt || null,
          meetingAt: campaign.meetingAt || null,
          dealAt: campaign.dealAt || null,
          lostAt: campaign.lostAt || null,
          messageCount: campaign.messageCount || 0,
          replyCount: campaign.replyCount || 0,
          revenue: campaign.revenue ?? campaign.data?.revenue ?? null,
        }
      : null,
    qualification: score
      ? {
          score: score.score,
          priority: score.priority,
          reasons: score.reasons || score.reason || null,
          model: score.model || null,
        }
      : null,
    contacts: contacts || [],
    notes: (notes || []).slice(0, 20).map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.createdAt,
    })),
    conversations: recentMessages,
    timeline: (timeline || []).slice(0, 50).map((e) => ({
      type: e.type,
      channel: e.channel,
      createdAt: e.createdAt,
      payload: e.payload || null,
    })),
    nextSteps: [
      campaign?.status === 'deal'
        ? 'Deal won — assign account owner and confirm kickoff.'
        : `Pipeline status is "${campaign?.status || 'new'}" — move to deal when closed.`,
      lead.email && lead.email !== 'N/A' ? 'Confirm preferred email for onboarding.' : 'Email missing — collect a working address.',
      lead.phone ? 'Confirm WhatsApp/phone for support channel.' : 'Phone missing — collect a contact number.',
    ],
  };

  return packageDoc;
}

module.exports = { buildHandoverPackage };
