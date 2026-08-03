/**
 * Autonomous Reply Service — Multi-Channel AI Architecture.
 *
 * Uses independent Channel Brains for each channel:
 * - WhatsApp Brain → WhatsApp conversations
 * - Email Brain → Email conversations
 * - SMS Brain → SMS conversations
 *
 * Each brain is COMPLETELY ISOLATED:
 * - Own conversation memory (only its channel's messages)
 * - Own prompt template (channel-optimized)
 * - Own tone configuration
 * - Own follow-up strategy
 * - Own reply generation
 * - Own context management
 * - Own campaign state tracking
 *
 * Cross-channel contamination is IMPOSSIBLE by design:
 * - WhatsApp never reads Email history
 * - Email never reads SMS history
 * - SMS never reads WhatsApp memory
 * - Each message carries channel-specific identifiers
 *
 * Conversation statuses:
 * - customer_replied: Customer has sent a new inbound message
 * - ai_thinking: AI is generating a response
 * - ai_replied: AI has sent a response
 * - waiting_for_customer: Waiting for customer to reply
 * - human_required: Human takeover requested (keywords or AI decision)
 * - ai_failed: AI failed to generate a reply
 */

const conversationStorage = require('../utils/conversationStorage');
const leadStorage = require('../utils/leadStorage');
const personalContactStorage = require('../utils/personalContactStorage');
const userStorage = require('../utils/userStorage');
const timelineStorage = require('../utils/timelineStorage');
const openAiKeyService = require('../services/openAiKeyService');
const { mergeAiAgentConfig } = require('../utils/aiAgentConfig');
const { resolveDeliveryEmail } = require('../utils/emailValidation');
const { getBrain, buildMessageContext, assertChannelMatch } = require('./channelBrains/brainFactory');

const inFlight = new Set();

function isContactConversationId(id) {
  return String(id || '').startsWith('contact:');
}

function isPreviewConversationId(id) {
  return String(id || '').startsWith('preview_');
}

function isOrphanLeadId(id) {
  return String(id || '').startsWith('orphan_');
}

async function contactProfileFromConversationId(leadId, workspaceId) {
  if (!isContactConversationId(leadId)) return null;
  const contactId = String(leadId).replace(/^contact:/, '');
  const contact = await personalContactStorage.get(contactId, { workspaceId }).catch(() => null);
  if (!contact) return null;
  const email = personalContactStorage.resolveDeliveryEmail(contact) || contact.email || '';
  return {
    id: `contact:${contact.id}`,
    contactId: contact.id,
    name: contact.name || email || 'Contact',
    email,
    phone: contact.whatsappNumber || contact.smsNumber || '',
    whatsapp: contact.whatsappNumber || contact.whatsappNormalized || '',
    niche: contact.company || 'Contact',
    company: contact.company || '',
    city: '',
    source: 'contacts',
  };
}

/**
 * Check whether a conversation allows auto-reply for a channel.
 * Uses the per-channel brain config (aiEnabled) — NOT the shared AI Agent config.
 *
 * @param {Object} conv - conversation record
 * @param {Object} brainConfig - channel brain config ({ aiEnabled, humanTakeoverKeywords, ... })
 * @param {'email'|'whatsapp'|'sms'} channel
 * @returns {{ ok: boolean, reason?: string }}
 */
function conversationAllowsAutoReply(conv, brainConfig, channel) {
  const meta = conv.metadata || {};
  if (meta.humanTakeover === true || conv.status === 'human_active' || conv.status === 'human_required') {
    return { ok: false, reason: 'human_takeover' };
  }
  if (conv.status === 'closed' || conv.archived) {
    return { ok: false, reason: 'conversation_closed' };
  }
  // Per-conversation override wins when explicitly set
  if (typeof meta.autoReplyEnabled === 'boolean') {
    return meta.autoReplyEnabled
      ? { ok: true }
      : { ok: false, reason: 'conversation_auto_reply_disabled' };
  }
  // Channel brain AI toggle — completely independent per channel
  if (brainConfig && typeof brainConfig.aiEnabled === 'boolean') {
    return brainConfig.aiEnabled
      ? { ok: true }
      : { ok: false, reason: 'auto_reply_disabled' };
  }
  // Default: enable for all channels (matching previous behavior)
  return { ok: true };
}

async function resolveLeadForConversation(conv, workspaceId) {
  if (isContactConversationId(conv.leadId)) {
    return contactProfileFromConversationId(conv.leadId, workspaceId);
  }
  if (isOrphanLeadId(conv.leadId)) {
    const phone = String(conv.leadId).replace(/^orphan_/, '');
    return {
      id: conv.leadId,
      name: phone || 'WhatsApp contact',
      phone,
      whatsapp: phone,
      niche: 'business',
      city: 'Unknown',
      source: 'whatsapp_orphan',
    };
  }
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 }).catch(() => []);
  const lead = leads.find((l) => l.id === conv.leadId) || null;
  if (!lead) return null;

  let phone = lead.whatsapp || lead.phone || '';
  if (!String(phone).replace(/\D/g, '')) {
    try {
      const contactStorage = require('../utils/contactStorage');
      const profile = await contactStorage.getProfile(lead.id, { workspaceId }).catch(() => null);
      const methods = profile?.contactMethods || [];
      const wa = methods.find((m) => m.channel === 'whatsapp' && m.value)
        || methods.find((m) => m.channel === 'phone' && m.value);
      if (wa?.value) phone = wa.value;
    } catch (_) { /* ignore */ }
  }
  if (!String(phone).replace(/\D/g, '')) {
    phone = conv.metadata?.phone || conv.metadata?.whatsapp || '';
  }
  if (!String(phone).replace(/\D/g, '')) {
    try {
      const messages = await conversationStorage.getMessages(conv.id, { workspaceId });
      const withPhone = [...messages].reverse().find((m) => m.metadata?.phone || m.metadata?.fromPhone);
      if (withPhone) phone = withPhone.metadata.phone || withPhone.metadata.fromPhone;
    } catch (_) { /* ignore */ }
  }

  return {
    ...lead,
    email: resolveDeliveryEmail(lead) || lead.email,
    whatsapp: phone || lead.whatsapp || lead.phone || '',
    phone: phone || lead.phone || lead.whatsapp || '',
  };
}

async function resolveOpenAiConfig(userId) {
  if (!userId) {
    const masterKey = process.env.OPENAI_API_KEY;
    if (!masterKey) return { blocked: true, reason: 'NO_AI_CONFIG' };
    return {
      apiKey: masterKey,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      source: 'master',
      blocked: false,
    };
  }
  const config = await openAiKeyService.getOpenAiConfig(userId);
  if (config.blocked) return config;
  return config;
}

// ==================== CHANNEL-SPECIFIC AUTO-REPLY HANDLERS ====================

/**
 * Handle WhatsApp auto-reply using the WhatsApp Brain.
 * Only loads WhatsApp conversation memory. Never reads Email/SMS.
 */
async function maybeAutoReplyToInboundWhatsApp({ workspaceId, conversationId, userId = workspaceId }) {
  return maybeAutoReplyToInbound({ workspaceId, conversationId, userId, expectedChannel: 'whatsapp' });
}

/**
 * Handle Email auto-reply using the Email Brain.
 * Only loads Email conversation memory. Never reads WhatsApp/SMS.
 */
async function maybeAutoReplyToInboundEmail({ workspaceId, conversationId, userId = workspaceId }) {
  return maybeAutoReplyToInbound({ workspaceId, conversationId, userId, expectedChannel: 'email' });
}

/**
 * Handle SMS auto-reply using the SMS Brain.
 * Only loads SMS conversation memory. Never reads WhatsApp/Email.
 */
async function maybeAutoReplyToInboundSms({ workspaceId, conversationId, userId = workspaceId }) {
  return maybeAutoReplyToInbound({ workspaceId, conversationId, userId, expectedChannel: 'sms' });
}

/**
 * Channel-agnostic entry used by inbound bridges.
 * Routes by conversation.channel when expectedChannel is omitted.
 */
async function handleInboundConversation(conversationId, { workspaceId, userId } = {}) {
  return maybeAutoReplyToInbound({
    workspaceId,
    conversationId,
    userId: userId || workspaceId,
  });
}

/**
 * Core auto-reply function — uses the appropriate Channel Brain.
 * 
 * Each channel gets its own brain with isolated memory, prompts, and transport.
 * The flow is:
 * 1. Detect channel from conversation
 * 2. Get the correct Channel Brain for that channel
 * 3. Brain loads ONLY its own channel's messages (isolation guarantee)
 * 4. Brain generates a reply using its own prompt template
 * 5. Reply is sent through the correct transport
 * 6. Response is saved with channel-specific identifiers
 * 7. Campaign and Timeline are updated with channel context
 */
async function maybeAutoReplyToInbound({
  workspaceId,
  conversationId,
  userId = workspaceId,
  expectedChannel = null,
}) {
  const lockKey = `${workspaceId}:${conversationId}`;
  if (inFlight.has(lockKey)) return { sent: false, reason: 'in_flight' };
  inFlight.add(lockKey);

  try {
    const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
    if (!conv) return { sent: false, reason: 'conversation_not_found' };

    const channel = expectedChannel || conv.channel;
    if (expectedChannel && conv.channel !== expectedChannel) {
      return { sent: false, reason: `not_${expectedChannel}_channel` };
    }
    if (!['email', 'whatsapp', 'sms'].includes(channel)) {
      return { sent: false, reason: 'unsupported_channel' };
    }
    if (isPreviewConversationId(conv.leadId)) return { sent: false, reason: 'preview_conversation' };

    // Get the isolated Channel Brain
    const brain = getBrain(channel, workspaceId);

    // Build message context with identifiers (prevents cross-channel contamination)
    const ctx = buildMessageContext({
      workspaceId,
      leadId: conv.leadId,
      channel,
      conversationId,
      campaignId: conv.metadata?.campaignId || null,
      workflowId: conv.metadata?.workflowId || null,
      automationId: conv.metadata?.automationId || null,
    });

    // CRITICAL: Assert channel match — this throws if channels are mismatched
    assertChannelMatch(ctx, channel);

    // Load the channel-specific brain config (independent per channel)
    const brainConfig = await userStorage.getChannelBrainConfig(userId, channel);
    const user = await userStorage.findById(userId).catch(() => null);
    
    // Merge the global agent config with the channel brain config.
    // The brain config fields override the global config so that each channel
    // uses its OWN business knowledge, products, FAQs, tone, etc.
    const globalConfig = mergeAiAgentConfig(await userStorage.getAiAgentConfig(userId), user);
    const agentConfig = { ...globalConfig, ...brainConfig };

    // Check if the channel brain allows auto-reply (uses brainConfig.aiEnabled)
    const allow = conversationAllowsAutoReply(conv, brainConfig, channel);
    if (!allow.ok) return { sent: false, reason: allow.reason };

    // Set status to "customer_replied" then "ai_thinking"
    await conversationStorage.updateConversation(
      conversationId,
      { status: 'ai_thinking' },
      { workspaceId }
    ).catch(() => {});

    // Load ALL messages (the brain will filter to its own channel)
    const messages = await conversationStorage.getMessages(conversationId, { workspaceId });

    // Use the brain to load only its channel's memory (isolation)
    const brainMessages = await brain.loadConversationMemory(conversationId, { workspaceId });
    const chronological = brainMessages.sort(
      (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    const lastMessage = chronological[chronological.length - 1];
    const lastInbound = [...chronological].reverse().find((m) => m.direction === 'inbound');

    if (!lastInbound || !lastMessage || lastMessage.direction !== 'inbound' || lastMessage.id !== lastInbound.id) {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'waiting_for_customer' },
        { workspaceId }
      ).catch(() => {});
      return { sent: false, reason: 'awaiting_customer_reply' };
    }

    const outboundsAfterInbound = chronological.filter(
      (m) => m.direction === 'outbound' && new Date(m.createdAt || 0).getTime() >= new Date(lastInbound.createdAt || 0).getTime()
    );
    if (outboundsAfterInbound.length > 0) {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'waiting_for_customer' },
        { workspaceId }
      ).catch(() => {});
      return { sent: false, reason: 'already_replied' };
    }

    let lead = await resolveLeadForConversation(conv, workspaceId);
    if (!lead) lead = { name: 'Lead', niche: 'business', city: 'Unknown' };

    // Validate recipient based on channel
    if (channel === 'email') {
      if (!lead.email || !resolveDeliveryEmail(lead)) {
        return { sent: false, reason: 'missing_recipient_email' };
      }
    } else if (channel === 'whatsapp') {
      const to = lead.whatsapp || lead.phone;
      if (!to) return { sent: false, reason: 'missing_recipient_phone' };
    } else if (channel === 'sms') {
      const to = lead.phone || lead.whatsapp;
      if (!to) return { sent: false, reason: 'missing_recipient_phone' };
    }

    // Check human takeover keywords from channel brain config (independent per channel)
    const customerMessage = lastInbound?.body || '';
    const takeoverKeywords = brainConfig.humanTakeoverKeywords || agentConfig.humanTakeoverKeywords || ['human', 'agent', 'call me', 'speak to someone', 'representative'];
    const hasTakeoverKeyword = takeoverKeywords.some(
      (kw) => customerMessage.toLowerCase().includes(kw.toLowerCase())
    );
    if (hasTakeoverKeyword) {
      const meta = { ...(conv.metadata || {}), humanTakeover: true, humanTakeoverReason: 'keyword_detected' };
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'human_required', metadata: meta },
        { workspaceId }
      ).catch(() => {});
      // Generate a polite handoff message
      const handoffMsg = `Thank you for your message. I've forwarded your request to our team who will assist you shortly.`;
      const saved = await brain.saveReply(conversationId, handoffMsg, {
        aiGenerated: true,
        autoReply: true,
        intent: 'human_handoff',
        requiresHuman: true,
        brain: channel,
        channel,
        workspaceId,
        conversationId,
      }, { workspaceId });
      console.log(`[AutonomousReply] Human takeover for ${channel} conversation ${conversationId} (keyword detected)`);
      return {
        sent: true,
        conversationId,
        messageId: saved?.id,
        channel,
        brain: channel,
        requiresHuman: true,
        intent: 'human_handoff',
      };
    }

    // Generate reply using the Channel Brain
    const oaConfig = await resolveOpenAiConfig(userId);
    let reply;
    try {
      reply = await brain.generateReply(messages, lead, {
        config: oaConfig,
        agentConfig,
        workspaceId,
      });
    } catch (err) {
      console.error(`[AutonomousReply] AI generation failed for ${channel}:`, err.message);
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'ai_failed' },
        { workspaceId }
      ).catch(() => {});
      return { sent: false, reason: `ai_generation_failed: ${err.message}` };
    }

    if (reply.error) {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'ai_failed' },
        { workspaceId }
      ).catch(() => {});
      return { sent: false, reason: reply.error };
    }
    if (!reply.body) {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'ai_failed' },
        { workspaceId }
      ).catch(() => {});
      return { sent: false, reason: 'empty_ai_reply' };
    }
    const requiresHuman = Boolean(reply.requiresHuman);

    // Send reply through the correct channel transport
    let sentResult = null;
    let outboundMeta = {
      aiGenerated: true,
      autoReply: true,
      intent: reply.intent,
      requiresHuman,
      brain: channel,
      channel,
      // Identifiers for isolation
      workspaceId,
      conversationId,
      campaignId: ctx.campaignId,
      workflowId: ctx.workflowId,
      automationId: ctx.automationId,
      isolationKey: ctx.isolationKey,
    };

    if (channel === 'email') {
      sentResult = await brain.sendReply(lead, reply.body, {
        workspaceId,
        subject: conv.subject,
        messages,
      });
      outboundMeta = {
        ...outboundMeta,
        messageId: sentResult?.messageId,
        rfcMessageId: sentResult?.rfcMessageId || null,
        gmailThreadId: sentResult?.gmailThreadId || null,
        subject: sentResult?.subject || conv.subject,
        recipientEmail: sentResult?.recipientEmail || lead.email,
        deliveryVerified: sentResult?.deliveryVerified,
      };
    } else if (channel === 'whatsapp') {
      const to = lead.whatsapp || lead.phone;
      sentResult = await brain.sendReply(to, reply.body, { workspaceId });
      outboundMeta = {
        ...outboundMeta,
        messageId: sentResult?.messageId || null,
        recipientPhone: to,
        addressing: sentResult?.addressing || null,
        serverAck: sentResult?.serverAck || null,
      };
    } else if (channel === 'sms') {
      const to = lead.phone || lead.whatsapp;
      sentResult = await brain.sendReply(to, reply.body, { workspaceId });
      outboundMeta = {
        ...outboundMeta,
        messageId: sentResult?.messageId || null,
        recipientPhone: to,
      };
    }

    // Update conversation status
    if (requiresHuman) {
      const meta = { ...(conv.metadata || {}), needsHuman: true };
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'human_required', metadata: meta },
        { workspaceId }
      ).catch(() => {});
    } else {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'ai_replied' },
        { workspaceId }
      ).catch(() => {});
    }

    // Save the reply using the brain's channel-specific save method
    const saved = await brain.saveReply(conversationId, reply.body, {
      ...outboundMeta,
      messageId: sentResult?.messageId || null,
    }, { workspaceId });

    // Update campaign (channel-specific)
    await brain.updateCampaign(conv.leadId, { workspaceId });

    // Update timeline (channel-specific)
    await brain.updateTimeline(conv.leadId, conversationId, {
      ...reply,
      messageId: saved?.id || sentResult?.messageId,
    }, { workspaceId });

    console.log(
      `[AutonomousReply] Sent AI ${channel} reply for conversation ${conversationId}`
      + ` (brain=${channel})`
      + `${requiresHuman ? ' (flagged for human follow-up)' : ''}`
    );

    return {
      sent: true,
      conversationId,
      messageId: saved?.id,
      channel,
      brain: channel,
      recipientEmail: outboundMeta.recipientEmail || null,
      recipientPhone: outboundMeta.recipientPhone || null,
      intent: reply.intent,
      requiresHuman,
    };
  } catch (err) {
    console.error('[AutonomousReply] Failed:', err.message);
    try {
      await conversationStorage.updateConversation(
        conversationId,
        { status: 'ai_failed' },
        { workspaceId }
      ).catch(() => {});
    } catch (_) {}
    return { sent: false, reason: err.message };
  } finally {
    inFlight.delete(lockKey);
  }
}

module.exports = {
  maybeAutoReplyToInbound,
  maybeAutoReplyToInboundEmail,
  maybeAutoReplyToInboundWhatsApp,
  maybeAutoReplyToInboundSms,
  handleInboundConversation,
  conversationAllowsAutoReply,
  contactProfileFromConversationId,
  isContactConversationId,
  resolveLeadForConversation,
};
