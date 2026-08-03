/**
 * Preview & Trust Mode Send Service.
 *
 * Orchestrates sending a preview copy to the user alongside the real lead send.
 * Preview sends are recorded as conversations tagged with preview: true so they
 * never pollute live campaign analytics.
 *
 * Usage:
 *   const result = await previewSend.sendPreviewCopy({
 *     channel: 'whatsapp',
 *     body,
 *     lead,
 *     previewSettings,
 *     providerSend,
 *     workspaceId,
 *   });
 */

const conversationStorage = require('../utils/conversationStorage');
const timelineStorage = require('../utils/timelineStorage');
const userStorage = require('../utils/userStorage');
const integrationStorage = require('../utils/integrationStorage');
const emailService = require('./emailService');
const { sendSms } = require('./smsService');
const { sendViaGmailApi } = require('./emailOAuthService');

/**
 * Build the preview copy with clear headers so the user knows exactly what the lead received.
 */
function buildPreviewBody(channel, body, lead) {
  const divider = channel === 'email'
    ? '\n━━━━━━━━━━━━━━━━━━\n'
    : '\n━━━━━━━━━━━━━━━━━━\n';
  const header = channel === 'email'
    ? '📋 Preview Copy\n━━━━━━━━━━━━━━━━━━\n'
    : '📋 Preview Copy\n';
  const meta = `Recipient: ${lead.name || 'Unknown'}\nBusiness: ${lead.niche || lead.business || 'N/A'}\n${channel === 'email' ? 'Email' : 'Phone'}: ${lead.email || lead.phone || 'N/A'}\n`;
  const footer = '\n━━━━━━━━━━━━━━━━━━\nThis is the exact message delivered to your selected lead.';
  return `${header}${meta}${divider}${body}${footer}`;
}

async function sendPreviewCopy({ channel, body, lead, previewSettings, providerSend, workspaceId, userId = null, senderEmail = null, html = null, displayHtml = null, subject = null, attachments = [] }) {
  console.log('[PreviewSend] sendPreviewCopy invoked:', { channel, hasPreviewSettings: !!previewSettings, workspaceId, userId, hasHtml: !!html, hasSubject: !!subject, attachmentsCount: attachments.length });
  if (!previewSettings) {
    console.log('[PreviewSend] ABORT: No preview settings');
    return { sent: false, reason: 'No preview settings' };
  }

  const shouldPreview =
    (channel === 'whatsapp' && previewSettings.whatsappPreview) ||
    (channel === 'email' && previewSettings.emailPreview) ||
    (channel === 'sms' && previewSettings.smsPreview);

  console.log('[PreviewSend] shouldPreview:', shouldPreview, '| channel:', channel, '| settings:', JSON.stringify({ whatsappPreview: previewSettings.whatsappPreview, emailPreview: previewSettings.emailPreview, smsPreview: previewSettings.smsPreview }));
  if (!shouldPreview) return { sent: false, reason: 'Preview disabled for this channel' };

  // Resolve preview destination — look up user by userId, fallback to workspaceId for legacy
  const lookupId = userId || workspaceId;
  console.log('[PreviewSend] Looking up user by id:', lookupId);
  const user = await userStorage.findById(lookupId).catch(() => null);
  const previewPhone = previewSettings.previewPhone || user?.whatsapp_number || user?.whatsappNumber || '';
  const previewEmail = previewSettings.previewEmail || user?.email || '';
  console.log('[PreviewSend] Resolved preview destination:', { channel, previewEmail, previewPhone, lookupId, userFound: !!user });

  const to = channel === 'email' ? previewEmail : previewPhone;
  if (!to) {
    console.log('[PreviewSend] ABORT: No preview destination. previewEmail:', previewEmail, '| previewPhone:', previewPhone);
    return { sent: false, reason: `No preview ${channel === 'email' ? 'email' : 'phone'} configured` };
  }

  // Build preview message with clear labeling
  const previewBody = buildPreviewBody(channel, body, lead);

  let result;
  try {
    if (channel === 'whatsapp') {
      // Use the same credentials as the lead send; caller passes them via providerSend
      result = await providerSend();
    } else if (channel === 'email') {
      const integrationRec = integrationStorage.get(workspaceId, 'email');
      const storedSender = await userStorage.getSenderEmail(workspaceId).catch(() => null);
      const fromEmail = senderEmail || (integrationRec && integrationRec.account) || storedSender || 'no-reply@leadflow.ai';
      const companyName = process.env.COMPANY_NAME || 'LeadFlow AI';
      const previewSubject = `[Preview] ${subject || 'Outreach'} — sent to ${lead.name || 'Lead'}`;

      // Use the actual campaign HTML if provided; wrap it with a preview header
      let previewHtml;
      if (html) {
        // Wrap the real customer HTML with a subtle preview banner
        previewHtml = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#f3e8ff;padding:10px 16px;border-radius:8px 8px 0 0;font-size:12px;color:#6b21a8;border:1px solid #e9d5ff;border-bottom:none">
<strong>📋 Preview Copy</strong> — This is exactly what your lead sees
</div>
<div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;overflow:hidden">
${html}
</div>
<div style="font-size:11px;color:#94a3b8;margin-top:8px;padding:0 4px">
Recipient: ${lead.name || 'Unknown'} | ${lead.email || 'N/A'}
</div>
</div>`;
      } else {
        // Fallback plain text preview
        previewHtml = `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto">
<div style="background:#f3e8ff;padding:12px 16px;border-radius:8px 8px 0 0;font-size:13px;color:#6b21a8">
<strong>📋 Preview Copy</strong><br>
Recipient: ${lead.name || 'Unknown'} | Business: ${lead.niche || lead.business || 'N/A'} | Email: ${lead.email || 'N/A'}
</div>
<div style="padding:16px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px">
<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;margin:0">${body}</pre>
</div>
<div style="font-size:11px;color:#94a3b8;margin-top:8px">This is the exact message delivered to your selected lead.</div>
</div>`;
      }

      console.log('[PreviewSend] Sending preview email via Gmail API to:', previewEmail, '| from:', fromEmail, '| attachments count:', (attachments || []).length);
      console.log('[PreviewSend] previewHtml length:', previewHtml.length, '| contains img:', previewHtml.includes('<img'));
      try {
        result = await sendViaGmailApi(workspaceId, {
          from: `"${companyName}" <${fromEmail}>`,
          to: previewEmail,
          subject: previewSubject,
          html: previewHtml,
          text: previewBody,
          attachments: attachments || [],
          preview: true,
        });
        console.log('[PreviewSend] Gmail API SUCCESS. result:', JSON.stringify(result));
        result = { messageId: result.messageId, status: 'sent' };
      } catch (gmailErr) {
        console.error('[PreviewSend] Gmail API FAILED:', gmailErr.message);
        throw gmailErr;
      }
    } else if (channel === 'sms') {
      result = await sendSms({ to: previewPhone, body: previewBody, workspaceId });
    } else {
      return { sent: false, reason: `Channel ${channel} not supported for preview` };
    }

    // Record preview conversation so the user can reply and test AI
    const previewLeadId = `preview_${workspaceId}`;
    let conv = await conversationStorage.findConversation({ workspaceId, leadId: previewLeadId, channel });
    if (!conv) {
      conv = await conversationStorage.createConversation(
        { leadId: previewLeadId, channel, subject: `[Preview] ${lead.name || 'Lead'} outreach` },
        { workspaceId }
      );
    }

    await conversationStorage.addMessage(conv.id, {
      direction: 'outbound',
      body: previewBody,
      channel,
      source: 'preview',
      messageType: channel === 'email' ? 'email' : 'text',
      metadata: {
        preview: true,
        originalLeadId: lead.id,
        originalLeadName: lead.name,
        originalBody: body,
        // Store displayHtml (HTTP URLs) for Inbox rendering, html (cid: refs) for reference
        html: displayHtml || html || null,
        subject: subject || null,
      },
    }, { workspaceId });

    // Timeline event (preview-tagged so analytics can filter it out)
    try {
      await timelineStorage.recordEvent({
        leadId: previewLeadId,
        type: 'preview_sent',
        channel,
        conversationId: conv.id,
        payload: { body: previewBody, originalLeadId: lead.id, originalLeadName: lead.name },
      }, { workspaceId });
    } catch (tlErr) {
      console.error('[PreviewSend] Timeline event failed (non-fatal):', tlErr.message);
    }

    return { sent: true, messageId: result?.messageId, conversationId: conv.id, channel };
  } catch (error) {
    console.error(`[PreviewSend] Failed to send ${channel} preview:`, error.message);
    return { sent: false, reason: error.message };
  }
}

module.exports = { sendPreviewCopy, buildPreviewBody };
