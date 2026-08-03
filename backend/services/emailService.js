/**
 * Email service — Gmail/nodemailer transporter + lead email rendering.
 *
 * Two transporter types:
 *   1. System transporter — uses EMAIL_USER/EMAIL_PASS env vars for platform-level
 *      emails (verification codes, password resets). Always available.
 *   2. OAuth2 transporter — per-workspace Gmail OAuth integration for campaign emails.
 *      Requires the user to connect Gmail in Settings.
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const integrationStorage = require('../utils/integrationStorage');
const userStorage = require('../utils/userStorage');
const { getOAuthTransporter, sendViaGmailApi, isOAuthEmailConfigured } = require('./emailOAuthService');
const { isValidEmail, parseEmailAddress, resolveDeliveryEmail } = require('../utils/emailValidation');
const { detectHtmlDirection } = require('../utils/languageDetection');
const { injectEmailTracking } = require('../utils/emailTracking');

function isEmailConfigured() {
  return isOAuthEmailConfigured('default');
}

function isEmailConfiguredForWorkspace(workspaceId = 'default') {
  return isOAuthEmailConfigured(workspaceId);
}

/** System transporter for platform emails (verification, password reset). */
let systemTransporter = null;
function getSystemTransporter() {
  if (systemTransporter) return systemTransporter;
  const emailUser = process.env.EMAIL_USER;
  const emailPass = process.env.EMAIL_PASS;
  if (!emailUser || !emailPass) return null;
  // Restore pre–Part-1 OTP delivery on this machine: corporate TLS inspection
  // breaks Gmail SMTP even with --use-system-ca / OS roots. Campaign OAuth
  // mail still uses getTlsOptions(); Postgres SSL is unchanged in config/tls.js.
  systemTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: emailUser, pass: emailPass },
    tls: { rejectUnauthorized: false },
  });
  return systemTransporter;
}

/** Get the OAuth2 transporter for a workspace (campaign emails). Throws if not configured. */
async function getTransporter(workspaceId = 'default') {
  const oauthT = await getOAuthTransporter(workspaceId);
  if (oauthT) return oauthT;
  throw new Error('Email not configured. Please connect your business email via OAuth in Settings.');
}

/**
 * Wrap a message body into a full HTML document for delivery.
 *
 * Sets dir="rtl"/"ltr"/"auto" on <html>/<body> based on the message content
 * itself (never on a hardcoded default) so RTL languages (Urdu, Arabic,
 * Persian, Hebrew) render correctly in Gmail/Outlook/Apple Mail — the same
 * BiDi detection used for the LeadFlow Inbox UI, applied to the actual
 * outgoing email markup.
 */
function wrapDeliverableHtml(bodyHtml, { companyName = 'LeadFlow AI', replyEmail = null, includeUnsubscribeFooter = false } = {}) {
  const inner = String(bodyHtml || '').trim();
  if (!inner) return inner;
  if (/<html[\s>]/i.test(inner)) return inner;
  const unsubscribe = includeUnsubscribeFooter && replyEmail
    ? `<p style="font-size:11px;color:#888;margin:16px 0 0;border-top:1px solid #eee;padding-top:10px;line-height:1.5;">You received this message from ${companyName}. To stop receiving emails, reply with "unsubscribe" or email <a href="mailto:${replyEmail}?subject=Unsubscribe" style="color:#888;">${replyEmail}</a>.</p>`
    : '';
  const dir = detectHtmlDirection(inner);
  const dirAttr = dir === 'rtl' ? ' dir="rtl"' : dir === 'ltr' ? ' dir="ltr"' : ' dir="auto"';
  return `<!DOCTYPE html>
<html${dirAttr}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${companyName}</title>
</head>
<body${dirAttr} style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#222222;margin:0;padding:12px;background:#ffffff;">
<div style="max-width:600px;margin:0 auto;">
${inner}
${unsubscribe}
</div>
</body>
</html>`;
}

/** Responsive campaign banner — full image visible, width scales, height capped without cropping. */
function buildCampaignBannerHtml(cid, altText = 'Campaign image') {
  const alt = String(altText || 'Campaign image').replace(/"/g, '&quot;');
  return `<img src="cid:${cid}" alt="${alt}" width="600" style="display:block;width:100%;max-width:100%;height:auto;max-height:280px;object-fit:contain;object-position:center;border:0;margin:0 0 8px 0;padding:0;" />`;
}

function buildCampaignBannerDisplayHtml(imageUrl, altText = 'Campaign image') {
  const alt = String(altText || 'Campaign image').replace(/"/g, '&quot;');
  return `<img src="${imageUrl}" alt="${alt}" width="600" style="display:block;width:100%;max-width:100%;height:auto;max-height:280px;object-fit:contain;object-position:center;border:0;margin:0 0 8px 0;padding:0;" />`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeReplacementForBracket(label, lead, campaign) {
  const key = String(label || '').toLowerCase();
  if (key.includes('name') || key.includes('clinic') || key.includes('business')) return lead.name || 'there';
  if (key.includes('email')) return lead.email || '';
  if (key.includes('phone') || key.includes('whatsapp') || key.includes('sms')) return lead.phone || '';
  if (key.includes('city') || key.includes('location')) return lead.city || '';
  if (key.includes('company')) return (campaign && campaign.companyName) || lead.company || 'our team';
  if (key.includes('niche') || key.includes('industry') || key.includes('type')) return lead.niche || lead.business || 'business';
  return '';
}

function removeUnresolvedPlaceholders(text, lead, campaign) {
  return String(text || '')
    .replace(/\[([^\]]+)\]/g, (_, label) => safeReplacementForBracket(label, lead, campaign))
    .replace(/\{(name|city|niche|company|business|email|phone)\}/gi, (_, key) => {
      const k = String(key).toLowerCase();
      if (k === 'name') return lead.name || 'there';
      if (k === 'city') return lead.city || '';
      if (k === 'niche' || k === 'business') return lead.niche || lead.business || 'business';
      if (k === 'company') return (campaign && campaign.companyName) || lead.company || 'our team';
      if (k === 'email') return lead.email || '';
      if (k === 'phone') return lead.phone || '';
      return '';
    })
    .replace(/\{[^}]+\}/g, '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

// Substitute known placeholders and remove unknown/raw template placeholders.
function personalize(template, lead, campaign) {
  const replaced = String(template)
    .replace(/{name}/g, lead.name || 'there')
    .replace(/{city}/g, lead.city || '')
    .replace(/{niche}/g, lead.niche || lead.business || 'business')
    .replace(/{company}/g, (campaign && campaign.companyName) || lead.company || 'our team');
  return removeUnresolvedPlaceholders(replaced, lead, campaign);
}

// Build { subject, text, html } for a lead, honoring an optional custom message/subject
// (with placeholder substitution) and falling back to a campaign-aware default.
function isHtml(str) {
  return /<(html|body|div|p|span|img|table|a|b|strong|i|em|br|h[1-6]|ul|ol|li|style|meta|head)[^>]*>/i.test(String(str));
}

function renderEmail(lead, { message, subject, campaign } = {}) {
  const businessName = lead.name || 'there';
  const businessCity = lead.city || '';
  const businessNiche = lead.niche || 'business';
  const companyName = (campaign && campaign.companyName) || 'our company';
  const productService = (campaign && campaign.productService) || 'our services';
  const offer = (campaign && campaign.offer) || 'help you grow';

  const text = message
    ? personalize(message, lead, campaign)
    : `Hi ${businessName},

I noticed your ${businessNiche} in ${businessCity} and wanted to reach out.

I help businesses like yours get more customers using ${productService}.

${offer ? `Currently offering: ${offer}` : ''}

Would you be open to a quick chat?

Best regards from ${companyName}`;

  const personalized = message ? personalize(message, lead, campaign) : null;

  const html = message
    ? (isHtml(personalized)
      ? personalized
      : `<p>${personalized.replace(/\n/g, '</p><p>')}</p>`)
    : `<p>Hi ${businessName},</p>
<p>I noticed your ${businessNiche} in ${businessCity} and wanted to reach out.</p>
<p>I help businesses like yours get more customers using ${productService}.</p>
${offer ? `<p><strong>Currently offering:</strong> ${offer}</p>` : ''}
<p>Would you be open to a quick chat?</p>
<p>Best regards from ${companyName}</p>`;

  const finalSubject = subject
    ? personalize(subject, lead, campaign)
    : `Quick question about ${businessName}`;

  return { subject: finalSubject, text, html };
}

/**
 * Render + send (or preview) an email to a single lead.
 * testMode short-circuits before delivery and returns a synthetic id.
 * attachments: Array<{ filename, path?, content?, cid? }> for inline images.
 */
async function sendEmailToLead(lead, { message, subject, campaign, testMode = false, workspaceId = 'default', attachments = [], senderEmail = null, threadId = null, inReplyTo = null, references = null, conversationId = null, messageId = null, trackOpens = true, htmlOverride = null } = {}) {
  const email = resolveDeliveryEmail(lead) || parseEmailAddress(lead && lead.email);
  if (!isValidEmail(email)) {
    throw new Error(`Invalid email address: ${lead?.email || 'missing'}`);
  }

  const rendered = renderEmail(lead, { message, subject, campaign });
  if (htmlOverride) {
    rendered.html = htmlOverride;
  }
  if (testMode) {
    return { messageId: `test-${Date.now()}`, testMode: true };
  }

  // Determine "from" address: explicit senderEmail > OAuth integration account
  const integrationRec = integrationStorage.get(workspaceId, 'email');
  const resolvedSender = senderEmail
    || (integrationRec && integrationRec.account)
    || null;
  if (!resolvedSender || !isValidEmail(parseEmailAddress(resolvedSender))) {
    throw new Error('Gmail is not connected. Connect your business Gmail account in Settings before sending.');
  }
  const fromEmail = parseEmailAddress(resolvedSender);
  const user = await userStorage.findById(workspaceId).catch(() => null);
  const companyName = (campaign && campaign.companyName) || user?.business_name || user?.businessName || process.env.COMPANY_NAME || 'LeadFlow AI';
  const emailSettings = await userStorage.getEmailSettings(workspaceId).catch(() => ({ includeUnsubscribeFooter: false }));
  // Cold outreach (no thread/reply headers) needs List-Unsubscribe + footer — major Gmail spam signal when missing.
  const isColdOutreach = !threadId && !inReplyTo;
  const includeUnsubscribeFooter = isColdOutreach
    || emailSettings.includeUnsubscribeFooter === true;

  let html = wrapDeliverableHtml(rendered.html, {
    companyName,
    replyEmail: fromEmail,
    includeUnsubscribeFooter,
  });
  let displayHtml = rendered.html;
  const mailAttachments = [];
  console.log('[EmailService] sendEmailToLead: attachments param:', JSON.stringify(attachments));

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (att.cid) {
        // Inline image attachment
        let attachmentPath = att.path;
        let attachmentContent = att.content;
        if (attachmentPath && String(attachmentPath).startsWith('/uploads/')) {
          const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
          const candidate = path.resolve(uploadsRoot, path.basename(String(attachmentPath)));
          // Jail: only files directly under uploads/ (no path traversal)
          if (candidate.startsWith(uploadsRoot + path.sep) && fs.existsSync(candidate)) {
            attachmentPath = candidate;
          } else {
            console.warn('[EmailService] Rejected attachment path outside uploads jail:', attachmentPath);
            attachmentPath = null;
          }
        }
        if (!attachmentContent && attachmentPath && !String(attachmentPath).startsWith('http') && !fs.existsSync(attachmentPath)) {
          console.warn('[EmailService] Inline attachment path not found:', attachmentPath);
        }
        mailAttachments.push({
          filename: att.filename || 'image.png',
          path: attachmentContent ? undefined : attachmentPath,
          content: attachmentContent,
          encoding: att.encoding || 'base64',
          cid: att.cid,
          contentType: att.contentType,
          contentDisposition: 'inline',
        });
      } else {
        mailAttachments.push(att);
      }
    }
    // Prepend inline images to HTML if cid references exist
    const inlineImages = mailAttachments
      .filter((a) => a.cid)
      .map((a) => buildCampaignBannerHtml(a.cid, companyName))
      .join('');
    console.log('[EmailService] inlineImages HTML:', inlineImages);
    if (inlineImages) {
      html = inlineImages + html;
    }
    // Build displayHtml with HTTP URLs for conversation storage (replace cid: with actual URL)
    const imageAtt = attachments.find((a) => a.cid);
    console.log('[EmailService] imageAtt found:', imageAtt ? { filename: imageAtt.filename, path: imageAtt.path, cid: imageAtt.cid } : 'null');
    if (imageAtt && imageAtt.path) {
      // Convert absolute URLs to relative paths so the frontend React proxy handles them correctly
      let imageUrl = imageAtt.path;
      if (imageUrl.startsWith('http')) {
        try {
          const url = new URL(imageUrl);
          imageUrl = url.pathname; // e.g., /uploads/abc123.jpeg
          console.log('[EmailService] Converted absolute URL to relative:', imageUrl);
        } catch {
          // keep original if parse fails
          console.log('[EmailService] URL parse failed, keeping original:', imageUrl);
        }
      }
      displayHtml = buildCampaignBannerDisplayHtml(imageUrl, companyName) + rendered.html;
      console.log('[EmailService] displayHtml built. Contains img src:', displayHtml.includes('<img src='), '| src value:', imageUrl);
    } else {
      console.log('[EmailService] imageAtt missing or has no path, displayHtml unchanged');
    }
  }

  // Inject signed open pixel + click-tracked links (delivery HTML only; displayHtml stays clean)
  if (trackOpens !== false && lead && lead.id) {
    html = injectEmailTracking(html, {
      leadId: lead.id,
      workspaceId,
      conversationId,
      messageId,
    });
  }

  const plainText = rendered.text || stripHtml(rendered.html);
  const mailOptions = {
    from: `"${companyName}" <${fromEmail}>`,
    replyTo: `"${companyName}" <${fromEmail}>`,
    to: email,
    subject: rendered.subject,
    text: plainText,
    html,
    threadId,
    inReplyTo,
    references,
    includeUnsubscribeFooter,
    isColdOutreach,
    skipDeliveryVerification: true,
    headers: {},
  };

  if (mailAttachments.length > 0) {
    mailOptions.attachments = mailAttachments;
  }

  // Send via Gmail API only — SMTP is disabled
  console.log('[EmailService] sendEmailToLead: calling sendViaGmailApi for workspace:', workspaceId, '| to:', email);
  const result = await sendViaGmailApi(workspaceId, mailOptions);
  console.log('[EmailService] sendViaGmailApi succeeded. Message ID:', result.messageId, '| deliveryVerified:', result.deliveryVerified, '| recipientEmail:', result.recipientEmail || email);
  console.log('[EmailService] RETURNING html length:', html.length, '| displayHtml length:', displayHtml.length, '| displayHtml has img:', displayHtml.includes('<img'));
  return { ...result, html, displayHtml, text: rendered.text, subject: rendered.subject, recipientEmail: result.recipientEmail || email };
}

module.exports = { isEmailConfigured, isEmailConfiguredForWorkspace, getTransporter, getSystemTransporter, renderEmail, sendEmailToLead };
