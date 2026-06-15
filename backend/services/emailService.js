/**
 * Email service — Gmail/nodemailer transporter + lead email rendering.
 *
 * Extracted so the S4.3 /api/email routes share one implementation. Configuration
 * is env-driven (EMAIL_USER + EMAIL_PASS); when unset, isEmailConfigured() is false
 * and live sends are blocked (callers may still preview with testMode).
 */

const nodemailer = require('nodemailer');

function isEmailConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return transporter;
}

// Substitute {name} / {city} / {niche} / {company} placeholders in custom copy.
function personalize(template, lead, campaign) {
  return String(template)
    .replace(/{name}/g, lead.name || 'there')
    .replace(/{city}/g, lead.city || '')
    .replace(/{niche}/g, lead.niche || lead.business || 'business')
    .replace(/{company}/g, (campaign && campaign.companyName) || 'our company');
}

// Build { subject, text, html } for a lead, honoring an optional custom message/subject
// (with placeholder substitution) and falling back to a campaign-aware default.
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

  const html = message
    ? `<p>${personalize(message, lead, campaign).replace(/\n/g, '</p><p>')}</p>`
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
 */
async function sendEmailToLead(lead, { message, subject, campaign, testMode = false } = {}) {
  const email = lead && lead.email;
  if (!email || email === 'N/A' || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  const rendered = renderEmail(lead, { message, subject, campaign });

  if (testMode) {
    return { messageId: `test-${Date.now()}`, testMode: true };
  }

  const t = getTransporter();
  if (!t) {
    throw new Error('Email not configured. Set EMAIL_USER and EMAIL_PASS environment variables.');
  }

  const companyName = (campaign && campaign.companyName) || 'our company';
  const result = await t.sendMail({
    from: `"${companyName}" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });
  return { messageId: result.messageId };
}

module.exports = { isEmailConfigured, renderEmail, sendEmailToLead };
