/**
 * Email content helpers — quoted-reply stripping and display-safe HTML.
 */

function stripQuotedEmailText(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';

  const lines = raw.split(/\r?\n/);
  const kept = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^On .+ wrote:$/i.test(trimmed)) break;
    if (/^-+\s*Original Message\s*-+/i.test(trimmed)) break;
    if (/^From:\s/.test(trimmed) && i > 0 && /^Sent:\s/.test((lines[i + 1] || '').trim())) break;
    if (/^_{5,}$/.test(trimmed)) break;
    if (/^>/.test(trimmed)) continue;

    kept.push(line);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripQuotedEmailHtml(html) {
  let cleaned = String(html || '').trim();
  if (!cleaned) return '';

  cleaned = cleaned.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<div[^>]*class="[^"]*gmail_attr[^"]*"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
  cleaned = cleaned.replace(/<div[^>]*id="divRplyFwdMsg"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/<div[^>]*class="[^"]*OutlookMessageHeader[^"]*"[\s\S]*$/gi, '');
  cleaned = cleaned.replace(/(<br\s*\/?>|\n)*On .+ wrote:[\s\S]*$/i, '');
  cleaned = cleaned.replace(/(<br\s*\/?>|\n)*From:.+?Sent:.+?[\s\S]*$/i, '');

  return cleaned.trim();
}

function prepareInboundEmailContent({ text, html }) {
  const replyText = stripQuotedEmailText(text) || stripQuotedEmailText(stripHtmlToText(html));
  const replyHtml = stripQuotedEmailHtml(html);
  const displayHtml = replyHtml || (replyText ? `<p>${escapeHtml(replyText).replace(/\n/g, '<br/>')}</p>` : '');

  return {
    body: replyText || '',
    displayHtml,
    replyHtml: replyHtml || null,
    fullHtml: html || null,
    fullText: text || null,
  };
}

function stripHtmlToText(html) {
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  stripQuotedEmailText,
  stripQuotedEmailHtml,
  prepareInboundEmailContent,
  stripHtmlToText,
};
