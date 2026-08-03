/**
 * RecipientExecutor — prepares and executes the send for ONE campaign recipient.
 *
 * Scope (exactly one recipient, nothing else):
 *   1. Load the recipient (lead payload or personal contact record).
 *   2. Build the message payload (personalization, text vs media).
 *   3. Call the existing whatsappTransport (single source of truth).
 *   4. Return the transport result.
 *
 * No ACK logic, no JID resolution, no retry implementation, no socket
 * management — all of that lives exclusively in services/whatsappTransport.js.
 */

const whatsappTransport = require('../../whatsappTransport');
const personalContactStorage = require('../../../utils/personalContactStorage');

function isContactRecipient(recipient) {
  return recipient?.source === 'contacts' || !!recipient?.contactId || String(recipient?.id || '').startsWith('contact:');
}

function contactConversationId(contactId) {
  return `contact:${String(contactId || '').replace(/^contact:/, '')}`;
}

function contactAsRecipient(contact) {
  return {
    id: contactConversationId(contact.id),
    contactId: contact.id,
    name: contact.name || contact.email || contact.whatsappNumber || contact.smsNumber || 'Contact',
    email: contact.email || '',
    phone: contact.whatsappNumber || contact.smsNumber || '',
    smsPhone: contact.smsNumber || contact.whatsappNumber || '',
    city: '',
    niche: contact.company || 'Contact',
    company: contact.company || '',
    notes: contact.notes || '',
    source: 'contacts',
  };
}

function buildMessagePayload(template, recipient, imageUrl) {
  const body = String(template)
    .replace(/{name}/g, recipient.name || 'there')
    .replace(/{city}/g, recipient.city || '')
    .replace(/{niche}/g, recipient.niche || recipient.business || 'business')
    .replace(/{company}/g, recipient.company || recipient.companyName || 'our company');
  return { body, imageUrl: imageUrl || null };
}

async function loadRecipient(recipient, { workspaceId }) {
  if (!isContactRecipient(recipient)) {
    return { kind: 'lead', recipient, contact: null };
  }
  const contactId = recipient.contactId || String(recipient.id || '').replace(/^contact:/, '');
  let contact = await personalContactStorage.get(contactId, { workspaceId });
  if (!contact) {
    const fallbackPhone = recipient.phone || recipient.whatsapp || recipient.whatsappNumber || recipient.smsNumber || '';
    if (!fallbackPhone) {
      throw new Error('Contact not found in this workspace and submitted recipient has no usable contact method');
    }
    contact = {
      id: contactId,
      name: recipient.name || 'Contact',
      email: recipient.email || '',
      whatsappNumber: fallbackPhone,
      smsNumber: fallbackPhone,
      company: recipient.company || recipient.niche || '',
      notes: 'Fallback recipient payload used because contact record was not found',
    };
    console.warn('[RecipientExecutor] Contact record missing; using submitted recipient payload', { contactId, leadId: recipient.id });
  }
  return { kind: 'contact', recipient: contactAsRecipient(contact), contact };
}

async function executeWhatsAppRecipient({ workspaceId, recipient, message, imageUrl = null }) {
  const tag = `[TRACE][${recipient?.name || recipient?.id || 'recipient'}]`;

  if (!whatsappTransport.isConfigured(workspaceId)) {
    console.error(`${tag} stage=8 final=failed error=whatsapp_not_connected`);
    throw new Error('WhatsApp not configured — set Meta Cloud API credentials in WhatsApp Settings');
  }

  const { kind, recipient: normalized, contact } = await loadRecipient(recipient, { workspaceId });
  console.log(`${tag} stage=1 recipient_loaded kind=${kind} id=${normalized?.id} contactId=${contact?.id || 'n/a'}`);

  const rawPhone = kind === 'contact'
    ? (contact.whatsappNumber || contact.smsNumber || '')
    : (normalized.whatsapp || normalized.phone || '');
  const to = String(rawPhone).replace(/\D/g, '');
  console.log(`${tag} stage=2 phone=${to || 'NONE'} raw=${rawPhone || 'NONE'} fields=${JSON.stringify({ whatsapp: normalized?.whatsapp || null, phone: normalized?.phone || null, contactWa: contact?.whatsappNumber || null, contactSms: contact?.smsNumber || null })}`);
  if (!to) {
    const reason = kind === 'contact' ? 'Contact has no WhatsApp number' : 'Lead has no phone number';
    console.error(`${tag} stage=8 final=failed error="${reason}"`);
    throw new Error(reason);
  }

  const payload = buildMessagePayload(message, normalized, imageUrl);
  const method = payload.imageUrl ? 'sendImage' : 'sendText';
  console.log(`${tag} stage=4 transport_call=whatsappTransport.${method} to=${to} hasImage=${Boolean(payload.imageUrl)}`);

  let transportResult;
  try {
    transportResult = payload.imageUrl
      ? await whatsappTransport.sendImage({ workspaceId, to, imageUrl: payload.imageUrl, caption: payload.body, testMode: false })
      : await whatsappTransport.sendText({ workspaceId, to, message: payload.body, testMode: false });
  } catch (err) {
    console.error(`${tag} stage=7 ack_error="${err.message}"`);
    console.error(`${tag} stage=8 final=failed error="${err.message}"`);
    throw err;
  }

  console.log(`${tag} stage=5 messageId=${transportResult?.messageId || 'NONE'}`);
  console.log(`${tag} stage=7 ack=${transportResult?.serverAck ?? 'n/a'} remoteJid=${transportResult?.remoteJid || 'n/a'} addressing=${transportResult?.addressing || 'n/a'} tctokenAttached=${transportResult?.tctokenAttached}`);
  console.log(`${tag} stage=8 final=sent`);

  return {
    kind,
    recipient: normalized,
    contact,
    phone: to,
    message: payload.body,
    transportResult,
  };
}

module.exports = {
  isContactRecipient,
  contactConversationId,
  contactAsRecipient,
  executeWhatsAppRecipient,
};
