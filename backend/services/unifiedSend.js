/**
 * Unified Send Service (Foundation Hardening).
 *
 * All channel sends (WhatsApp, Email, SMS, AI Calling) must flow through here.
 * This guarantees that EVERY outbound message is recorded in:
 *   1. conversationStorage (message thread)
 *   2. campaignStorage (CRM pipeline)
 *   3. timelineStorage (unified lead timeline)
 *
 * Usage:
 *   const result = await unifiedSend.send({
 *     leadId, channel: 'whatsapp', body: message,
 *     providerSend: async () => whatsappTransport.sendText({ workspaceId, to, message: body }),
 *     metadata: { templateName, language },
 *     workspaceId
 *   });
 */

const conversationStorage = require('../utils/conversationStorage');
const campaignStorage = require('../utils/campaignStorage');
const leadStorage = require('../utils/leadStorage');
const whatsappTransport = require('./whatsappTransport');
const emailService = require('./emailService');
const { sendSms } = require('./smsService');
const contactStorage = require('../utils/contactStorage');

function pickContactMethod(methods, channel) {
  const preferred = channel === 'sms' || channel === 'whatsapp' ? [channel, 'phone'] : [channel];
  return methods.find((m) => preferred.includes(m.channel) && m.isPrimary)
    || methods.find((m) => preferred.includes(m.channel))
    || null;
}

async function send({
  leadId,
  channel,
  body,
  subject,
  providerSend,
  metadata,
  scheduleFollowUps = true,
  workspaceId = 'default',
  conversationId = null,
}) {
  if (!leadId || !channel || !body) {
    throw new Error('unifiedSend requires leadId, channel, and body');
  }

  // Look up lead
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) {
    throw new Error(`Lead ${leadId} not found in workspace ${workspaceId}`);
  }

  const profile = await contactStorage.getProfile(leadId, { workspaceId }).catch(() => null);
  const contactMethod = profile ? pickContactMethod(profile.contactMethods || [], channel) : null;

  // Provider send (caller passes the channel-specific send function)
  let result;
  if (providerSend) {
    try {
      result = await providerSend();
    } catch (err) {
      // Provider send failed (e.g. ACK 463, number not registered).
      // Return a structured failure so the campaign loop continues to the next recipient.
      return {
        success: false,
        error: err.message,
        leadId,
        channel,
        status: 'failed',
        testMode: false,
      };
    }
  } else if (channel === 'whatsapp') {
    if (!whatsappTransport.isConfigured(workspaceId)) throw new Error('WhatsApp not configured');
    const to = contactMethod?.value || lead.whatsapp || lead.phone;
    if (!to) throw new Error('Lead has no phone number');
    result = await whatsappTransport.sendText({ workspaceId, to, message: body });
  } else if (channel === 'email') {
    const email = contactMethod?.value || lead.email;
    if (!email || email === 'N/A') throw new Error('Lead has no email');
    result = await emailService.sendEmailToLead({ ...lead, email }, { message: body, subject });
  } else if (channel === 'sms') {
    const to = contactMethod?.value || lead.phone;
    if (!to || to === 'N/A') throw new Error('Lead has no phone number');
    result = await sendSms({ to, body, workspaceId });
  } else {
    throw new Error(`Channel ${channel} not yet supported by unifiedSend`);
  }

  const externalMessageId = result?.messageId || result?.id || null;

  // Build rich metadata for email so the inbox can render HTML, subject, images
  let richMetadata = metadata || null;
  if (channel === 'email') {
    console.log('[unifiedSend] Building richMetadata. result.displayHtml?', !!result?.displayHtml, '| result.html?', !!result?.html);
    // Use displayHtml (HTTP URLs) for conversation rendering, not html (cid: refs)
    if (result?.displayHtml || result?.html) {
      richMetadata = {
        ...(metadata || {}),
        html: result.displayHtml || result.html,
        text: result.text || body,
        subject: result.subject || subject || metadata?.subject,
        messageId: result.messageId || null,
        rfcMessageId: result.rfcMessageId || null,
        gmailThreadId: result.gmailThreadId || null,
        imageUrl: metadata?.imageUrl || null,
        isInitialCampaign: metadata?.quoteCard ? false : true,
      };
      console.log('[unifiedSend] richMetadata.html length:', richMetadata.html?.length, '| has img:', richMetadata.html?.includes('<img'));
    } else {
      // Fallback: render email for metadata (no image)
      console.log('[unifiedSend] No displayHtml or html in result. Using fallback rendering.');
      try {
        const rendered = emailService.renderEmail(lead, { message: body, subject });
        richMetadata = {
          ...(metadata || {}),
          html: rendered.html,
          text: rendered.text,
          subject: rendered.subject,
          isInitialCampaign: metadata?.quoteCard ? false : true,
        };
      } catch (renderErr) {
        console.warn('[unifiedSend] Failed to render email metadata:', renderErr.message);
      }
    }
  } else if (channel === 'whatsapp' && (metadata?.imageUrl || metadata?.mediaUrl || metadata?.attachments)) {
    const imageUrl = metadata.imageUrl || metadata.mediaUrl || null;
    richMetadata = {
      ...(metadata || {}),
      imageUrl,
      mediaUrl: metadata.mediaUrl || imageUrl,
      attachments: metadata.attachments
        || (imageUrl ? [{ url: imageUrl, type: metadata.messageType || 'image', mime: metadata.mediaMime || null, name: metadata.fileName || null }] : undefined),
    };
  }

  // Prefer explicit conversationId (Inbox / Quotes flow) so contact threads stay linked
  let conv = null;
  if (conversationId) {
    conv = await conversationStorage.getConversation(conversationId, { workspaceId });
  }
  if (!conv) {
    conv = await conversationStorage.findConversation({ workspaceId, leadId, channel });
  }
  if (!conv) {
    conv = await conversationStorage.createConversation(
      { leadId, channel, subject: subject || null },
      { workspaceId }
    );
  }

  const messageType = richMetadata?.quoteCard
    ? 'quote'
    : (channel === 'email'
      ? 'email'
      : (richMetadata?.imageUrl || richMetadata?.mediaUrl || metadata?.messageType === 'image'
        ? (metadata?.messageType || 'image')
        : 'text'));
  const source = richMetadata?.quoteCard ? 'quotes' : 'campaign';

  console.log('[unifiedSend] Storing message in conv:', conv.id, '| metadata has html?', !!richMetadata?.html, '| metadata html length:', richMetadata?.html?.length);
  await conversationStorage.addMessage(conv.id, {
    direction: 'outbound',
    body: channel === 'email' && richMetadata?.text && !richMetadata?.quoteCard
      ? richMetadata.text
      : body,
    channel,
    source,
    externalMessageId,
    messageType,
    metadata: richMetadata,
  }, { workspaceId });

  // Update campaign pipeline
  await campaignStorage.recordSent(leadId, { workspaceId, channel });

  // Schedule follow-ups (current hardcoded 2-step system)
  if (scheduleFollowUps) {
    await campaignStorage.scheduleFollowUps(leadId, { days1: 2, days2: 5 }, { workspaceId });
  }

  return {
    success: true,
    messageId: externalMessageId,
    leadId,
    channel,
    conversationId: conv.id,
    status: result?.status || 'sent',
    testMode: result?.testMode || false,
    contact: result?.contact || contactMethod || null,
    html: result?.html || null,
    displayHtml: result?.displayHtml || null,
    text: result?.text || null,
    subject: result?.subject || null,
    rfcMessageId: result?.rfcMessageId || null,
    gmailThreadId: result?.gmailThreadId || null,
  };
}

module.exports = { send };
