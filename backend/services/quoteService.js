/**
 * Quotes & Invoicing business logic — AI, convert, PDF, send, share, CRM, intelligence.
 */
const path = require('path');
const crypto = require('crypto');
const quoteStorage = require('../utils/quoteStorage');
const leadStorage = require('../utils/leadStorage');
const timelineStorage = require('../utils/timelineStorage');
const userStorage = require('../utils/userStorage');
const personalContactStorage = require('../utils/personalContactStorage');
const openAiKeyService = require('./openAiKeyService');
const aiProvider = require('./aiProvider');
const unifiedSend = require('./unifiedSend');
const emailService = require('./emailService');
const { sendSms } = require('./smsService');
const integrationStorage = require('../utils/integrationStorage');
const { generateDocumentPdf } = require('./quotePdf');
const quoteIntelligence = require('./quoteIntelligence');
const conversationStorage = require('../utils/conversationStorage');

function buildCustomerFromLead(lead) {
  if (!lead) return {};
  return {
    name: lead.name || lead.contactName || '',
    company: lead.company || lead.businessName || lead.name || '',
    email: lead.email && lead.email !== 'N/A' ? lead.email : '',
    phone: lead.phone || lead.whatsapp || '',
    address: [lead.address, lead.city, lead.country].filter(Boolean).join(', '),
    city: lead.city || '',
    country: lead.country || '',
    niche: lead.niche || '',
  };
}

function companyFromProfile(profile) {
  if (!profile) return {};
  return {
    companyName: profile.companyName || '',
    name: profile.companyName || '',
    logoUrl: profile.logoUrl || '',
    signatureUrl: profile.signatureUrl || '',
    address: profile.address || '',
    city: profile.city || '',
    country: profile.country || '',
    phone: profile.phone || '',
    email: profile.email || '',
    website: profile.website || '',
    taxId: profile.taxId || '',
    headerText: profile.headerText || '',
    footerText: profile.footerText || '',
  };
}

async function resolveOpenAiConfig(userId) {
  const user = await userStorage.findById(userId);
  if (!user) {
    const masterKey = process.env.OPENAI_API_KEY;
    if (!masterKey) return { blocked: true, reason: 'MASTER_KEY_NOT_CONFIGURED' };
    return {
      apiKey: masterKey,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      source: 'master',
      blocked: false,
    };
  }
  return openAiKeyService.getOpenAiConfig(userId);
}

function aiNum(v, d = 0) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    const m = parseFloat(cleaned);
    if (Number.isFinite(m)) return m;
  }
  return d;
}

function parseAiDocument(raw, docType) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const items = Array.isArray(data.lineItems) ? data.lineItems : (Array.isArray(data.items) ? data.items : []);
  const discountPct = aiNum(data.discountPct ?? data.discount_pct ?? 0);
  // When a document-level discount % is present, ignore AI line discounts and absolute amounts
  // to prevent double-discounting (e.g. 50 → 40 line, then −20% again → 32).
  return {
    customer: data.customer || {},
    lineItems: items.map((it) => ({
      description: it.description || it.name || 'Item',
      quantity: aiNum(it.quantity ?? it.qty ?? 1, 1) || 1,
      unitPrice: aiNum(it.unitPrice ?? it.unit_price ?? it.price ?? 0),
      discount: discountPct > 0 ? 0 : aiNum(it.discount || 0),
      unit: it.unit || '',
    })),
    currency: data.currency || 'MYR',
    discountPct,
    discountAmount: 0,
    taxPct: aiNum(data.taxPct ?? data.tax_pct ?? 0),
    shipping: aiNum(data.shipping || 0),
    notes: data.notes || '',
    terms: data.terms || '',
    paymentTerms: data.paymentTerms || data.payment_terms || '',
    template: data.template || 'corporate',
    docType: docType === 'invoice' ? 'invoice' : 'quote',
  };
}

async function buildConversationContext(leadId, workspaceId) {
  const messages = await conversationStorage.getUnifiedMessagesForLead(leadId, { workspaceId });
  if (!messages.length) return null;
  const transcript = messages.slice(-50).map((m) => {
    const who = m.direction === 'inbound' ? 'Customer' : 'Sales';
    const ch = m.channel || m.conversationChannel || 'unknown';
    return `[${ch}] ${who}: ${String(m.body || '').trim()}`;
  }).join('\n');
  const channels = {};
  for (const m of messages) {
    const ch = m.channel || m.conversationChannel;
    if (ch) channels[ch] = (channels[ch] || 0) + 1;
  }
  const primaryChannel = Object.entries(channels).sort((a, b) => b[1] - a[1])[0]?.[0] || 'email';
  return { transcript, primaryChannel, messageCount: messages.length };
}

function transcriptFromMessages(messages, fallbackChannel = 'email') {
  const transcript = messages.slice(-50).map((m) => {
    const who = m.direction === 'inbound' ? 'Customer' : 'Sales';
    const ch = m.channel || m.conversationChannel || fallbackChannel;
    return `[${ch}] ${who}: ${String(m.body || '').trim()}`;
  }).join('\n');
  const channels = {};
  for (const m of messages) {
    const ch = m.channel || m.conversationChannel || fallbackChannel;
    if (ch) channels[ch] = (channels[ch] || 0) + 1;
  }
  const primaryChannel = Object.entries(channels).sort((a, b) => b[1] - a[1])[0]?.[0] || fallbackChannel;
  return { transcript, primaryChannel, messageCount: messages.length };
}

function buildCustomerFromEntity(entity) {
  if (!entity) return {};
  return {
    name: entity.name || entity.contactName || '',
    company: entity.company || entity.businessName || entity.name || '',
    email: entity.email && entity.email !== 'N/A' ? entity.email : '',
    phone: entity.phone || entity.whatsapp || '',
    address: [entity.address, entity.city, entity.country].filter(Boolean).join(', '),
  };
}

async function buildConversationContextById(conversationId, workspaceId) {
  const conv = await conversationStorage.getConversation(conversationId, { workspaceId });
  if (!conv) throw new Error('Conversation not found');
  let messages = await conversationStorage.getMessages(conversationId, { workspaceId });
  const isContact = String(conv.leadId || '').startsWith('contact:');
  if (conv.leadId && !isContact) {
    const unified = await conversationStorage.getUnifiedMessagesForLead(conv.leadId, { workspaceId });
    if (unified.length > messages.length) messages = unified;
  }
  if (!messages.length) return null;
  const parsed = transcriptFromMessages(messages, conv.channel || 'email');
  return { ...parsed, conversation: conv };
}

async function resolveLeadForConversation(conv, workspaceId) {
  const leadId = conv.leadId;
  if (!leadId || String(leadId).startsWith('preview_')) {
    return { lead: null, leadId: null, customer: buildCustomerFromEntity(conv.contact || conv.lead) };
  }
  if (String(leadId).startsWith('contact:')) {
    const contactId = String(leadId).slice('contact:'.length);
    let contact = conv.contact || null;
    if (!contact) {
      try {
        const personalContactStorage = require('../utils/personalContactStorage');
        contact = await personalContactStorage.get(contactId, { workspaceId });
      } catch (_) { /* ignore */ }
    }
    return {
      lead: null,
      leadId: null,
      customer: buildCustomerFromEntity(contact || conv.lead),
    };
  }
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  const lead = leads.find((l) => l.id === leadId);
  return { lead, leadId, customer: buildCustomerFromLead(lead) };
}

async function generateFromConversationId({ conversationId, workspaceId, docType = 'quote', oaConfig, extraPrompt }) {
  const ctx = await buildConversationContextById(conversationId, workspaceId);
  if (!ctx) throw new Error('No messages in this conversation yet');
  const { lead, leadId, customer } = await resolveLeadForConversation(ctx.conversation, workspaceId);
  const kind = docType === 'invoice' ? 'invoice' : 'quotation';
  const prompt = [
    `Create a professional ${kind} from this ongoing sales conversation.`,
    'Extract customer details, products, quantities, unit prices, currency, discounts, tax, shipping, and notes.',
    'Use only information present or reasonably implied in the conversation.',
    extraPrompt ? `Additional instruction: ${extraPrompt}` : '',
    `\nConversation (${ctx.messageCount} messages):\n${ctx.transcript}`,
  ].filter(Boolean).join('\n\n');
  const generated = await generateWithAI({ prompt, docType, oaConfig });
  generated.customer = {
    ...generated.customer,
    ...Object.fromEntries(
      Object.entries(customer || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''),
    ),
  };
  generated.leadId = leadId;
  generated.meta = { ...(generated.meta || {}), sourceConversationId: conversationId };
  return {
    generated,
    primaryChannel: ctx.primaryChannel || ctx.conversation.channel || 'email',
    messageCount: ctx.messageCount,
    conversationId,
    leadId,
  };
}

async function generateFromConversation({ leadId, workspaceId, docType = 'quote', oaConfig, extraPrompt }) {
  const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) throw new Error('Lead not found');
  const ctx = await buildConversationContext(leadId, workspaceId);
  if (!ctx) throw new Error('No conversation history for this lead yet');
  const kind = docType === 'invoice' ? 'invoice' : 'quotation';
  const prompt = [
    `Create a professional ${kind} from this ongoing sales conversation.`,
    'Extract customer details, products, quantities, unit prices, currency, discounts, tax, shipping, and notes.',
    'Use only information present or reasonably implied in the conversation.',
    extraPrompt ? `Additional instruction: ${extraPrompt}` : '',
    `\nConversation (${ctx.messageCount} messages):\n${ctx.transcript}`,
  ].filter(Boolean).join('\n\n');
  const generated = await generateWithAI({ prompt, docType, oaConfig });
  generated.customer = { ...generated.customer, ...buildCustomerFromLead(lead) };
  generated.leadId = leadId;
  return { generated, primaryChannel: ctx.primaryChannel, messageCount: ctx.messageCount };
}

async function scheduleQuoteFollowUp(id, workspaceId, channel) {
  const doc = await quoteStorage.get(id, workspaceId);
  if (!doc || !doc.leadId) return null;
  const hours = Number(process.env.QUOTE_FOLLOWUP_HOURS || 36);
  const dueAt = new Date(Date.now() + hours * 3600000).toISOString();
  const customerName = doc.customer?.name || doc.customer?.company || 'there';
  const updated = await quoteStorage.update(id, workspaceId, {
    meta: {
      ...(doc.meta || {}),
      quoteFollowUp: {
        dueAt,
        channel: channel || 'email',
        sent: false,
        customerName,
        documentNumber: doc.number,
        docType: doc.docType,
      },
    },
  });
  await quoteStorage.addEvent(id, workspaceId, 'follow_up_scheduled', channel, { dueAt, hours });
  return updated;
}

async function processQuoteFollowUp(doc, workspaceId) {
  const fu = doc.meta?.quoteFollowUp;
  if (!fu || fu.sent) return { skipped: true, reason: 'already_sent' };
  if (['viewed', 'accepted', 'rejected', 'paid', 'partially_paid'].includes(doc.status)) {
    await quoteStorage.update(doc.id, workspaceId, {
      meta: { ...(doc.meta || {}), quoteFollowUp: { ...fu, sent: true, skippedReason: doc.status } },
    });
    return { skipped: true, reason: doc.status };
  }
  const firstName = String(fu.customerName || 'there').split(/\s+/)[0];
  const label = doc.docType === 'invoice' ? 'invoice' : 'quotation';
  const body = `Hi ${firstName}, I'm just following up regarding the ${label} I sent earlier (${doc.number}). Let me know if you have any questions or would like to proceed.`;
  const channel = fu.channel || 'email';
  await sendDocument({
    id: doc.id,
    workspaceId,
    channel,
    body,
    subject: `Following up: ${doc.docType === 'invoice' ? 'Invoice' : 'Quotation'} ${doc.number}`,
    req: null,
    isFollowUp: true,
  }).catch(async (err) => {
    await quoteStorage.addEvent(doc.id, workspaceId, 'follow_up_failed', channel, { error: err.message });
    throw err;
  });
  await quoteStorage.update(doc.id, workspaceId, {
    meta: { ...(doc.meta || {}), quoteFollowUp: { ...fu, sent: true, sentAt: new Date().toISOString() } },
  });
  await quoteStorage.addEvent(doc.id, workspaceId, 'follow_up_sent', channel, { body });
  if (doc.leadId) {
    await timelineStorage.recordEvent({
      leadId: doc.leadId,
      type: 'ai_action',
      channel,
      referenceId: doc.id,
      payload: { action: 'quote_follow_up', number: doc.number },
    }, { workspaceId }).catch(() => null);
  }
  return { sent: true, channel };
}

async function generateWithAI({ prompt, docType = 'quote', oaConfig }) {
  if (!oaConfig || oaConfig.blocked) {
    const err = new Error(oaConfig?.reason || 'AI blocked');
    err.code = oaConfig?.reason || 'AI_BLOCKED';
    throw err;
  }
  const kind = docType === 'invoice' ? 'invoice' : 'quotation';
  const system = `You are a professional ${kind} generator for LeadFlow AI.
Return ONLY valid JSON with keys:
customer:{name,company,email,phone,address},
lineItems:[{description,quantity,unitPrice,discount,unit}],
currency, discountPct, taxPct, shipping, notes, terms, paymentTerms, template
(template one of: corporate,modern,minimal,medical,construction,manufacturing,real_estate).
Use realistic professional wording. Currency default MYR if unspecified.`;
  const response = await aiProvider.callOpenAI(
    [
      { role: 'system', content: system },
      { role: 'user', content: `Create a ${kind} from this request:\n${prompt}\n\nReturn JSON only.` },
    ],
    0.35,
    1800,
    { ...oaConfig, operation: 'quote.ai_generate', source: oaConfig.source || 'master' },
  );
  return parseAiDocument(response, docType);
}

async function regenerateWithAI({ document, instruction, oaConfig, replaceCustomer = false }) {
  if (!oaConfig || oaConfig.blocked) {
    const err = new Error(oaConfig?.reason || 'AI blocked');
    err.code = oaConfig?.reason || 'AI_BLOCKED';
    throw err;
  }
  const preserveNote = replaceCustomer
    ? 'You MAY update customer fields if the instruction asks.'
    : 'CRITICAL: Preserve customer exactly as provided. Do not change customer name/company/email/phone/address unless instruction explicitly says replaceCustomer=true.';
  const system = `You revise sales documents. Return ONLY JSON with the same schema:
customer, lineItems[{description,quantity,unitPrice,discount,unit}], currency, discountPct, taxPct, shipping, notes, terms, paymentTerms, template.
Apply the user instruction while keeping factual numbers unless asked to change them.
${preserveNote}`;
  const payload = {
    replaceCustomer: Boolean(replaceCustomer),
    current: {
      customer: document.customer,
      lineItems: document.lineItems,
      currency: document.currency,
      discountPct: document.discountPct,
      taxPct: document.taxPct,
      shipping: document.shipping,
      notes: document.notes,
      terms: document.terms,
      paymentTerms: document.paymentTerms,
      template: document.template,
    },
    instruction,
  };
  const response = await aiProvider.callOpenAI(
    [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    0.4,
    1800,
    { ...oaConfig, operation: 'quote.ai_regenerate', source: oaConfig.source || 'master' },
  );
  const generated = parseAiDocument(response, document.docType);
  if (!replaceCustomer) {
    generated.customer = { ...(document.customer || {}) };
  }
  return generated;
}

async function createDocument({ workspaceId, userId, input, useAi = false, prompt, oaConfig }) {
  const profile = await quoteStorage.getBillingProfile(workspaceId);
  let draft = { ...input };
  if (useAi && prompt) {
    const generated = await generateWithAI({ prompt, docType: input.docType || 'quote', oaConfig });
    draft = {
      ...generated,
      ...input,
      customer: { ...generated.customer, ...(input.customer || {}) },
      meta: { ...(generated.meta || {}), ...(input.meta || {}) },
      aiPrompt: prompt,
    };
    if (userId && oaConfig?.source) await openAiKeyService.consumeFreeMessage(userId, oaConfig.source).catch(() => null);
  }
  if (draft.leadId && (!draft.customer || !draft.customer.name)) {
    const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    const lead = leads.find((l) => l.id === draft.leadId);
    draft.customer = { ...buildCustomerFromLead(lead), ...(draft.customer || {}) };
  }
  draft.company = { ...companyFromProfile(profile), ...(draft.company || {}) };
  if (!draft.currency) draft.currency = profile.defaultCurrency || 'MYR';
  if (draft.taxPct == null) draft.taxPct = profile.defaultTaxPct || 0;
  if (!draft.terms) draft.terms = profile.defaultTerms || '';
  if (!draft.paymentTerms) draft.paymentTerms = profile.paymentTerms || '';
  const doc = await quoteStorage.create(draft, workspaceId);
  if (doc.leadId) {
    await timelineStorage.recordEvent({
      leadId: doc.leadId,
      type: 'ai_action',
      channel: null,
      referenceId: doc.id,
      payload: { action: `${doc.docType}_created`, number: doc.number, total: doc.total, status: doc.status },
    }, { workspaceId }).catch(() => null);
  }
  return doc;
}

async function duplicateDocument(id, workspaceId) {
  const src = await quoteStorage.get(id, workspaceId);
  if (!src) throw new Error('Document not found');
  const copy = await quoteStorage.create({
    docType: src.docType,
    status: 'draft',
    leadId: src.leadId,
    contactId: src.contactId,
    customer: src.customer,
    company: src.company,
    lineItems: src.lineItems,
    currency: src.currency,
    discountPct: src.discountPct,
    discountAmount: src.discountAmount,
    taxPct: src.taxPct,
    shipping: src.shipping,
    notes: src.notes,
    terms: src.terms,
    paymentTerms: src.paymentTerms,
    template: src.template,
    validUntil: src.validUntil,
    dueDate: src.dueDate,
    meta: {
      ...(src.meta || {}),
      duplicatedFrom: src.id,
      convertedFrom: undefined,
      convertedInvoiceId: undefined,
    },
  }, workspaceId);
  await quoteStorage.addEvent(copy.id, workspaceId, 'duplicated', null, { from: src.id });
  return copy;
}

/**
 * Create / attach CRM customer (lead + personal contact) from document customer fields.
 */
async function createOrLinkCustomer({ workspaceId, documentId, customer, saveToDocument = true, autoSave = true }) {
  const c = customer || {};
  const name = String(c.name || c.company || 'Customer').trim();
  const email = String(c.email || '').trim();
  const phone = String(c.phone || '').trim();
  if (!email && !phone) throw new Error('Customer needs email or phone');

  const [createdLead] = await leadStorage.addLeads([{
    name,
    company: c.company || name,
    email: email || 'N/A',
    phone: phone || '',
    whatsapp: phone || '',
    city: c.city || '',
    country: c.country || '',
    niche: c.niche || '',
    address: c.address || '',
    source: 'quotes_invoices',
  }], { workspaceId });
  let lead = createdLead;
  if (!lead) {
    const all = await leadStorage.getLeads({ workspaceId, limit: 10000 });
    lead = all.find((l) =>
      (email && l.email && String(l.email).toLowerCase() === email.toLowerCase())
      || (phone && (l.phone === phone || l.whatsapp === phone))
      || (name && String(l.name || '').toLowerCase() === name.toLowerCase())
    ) || null;
  }
  if (!lead) throw new Error('Could not create or locate CRM customer');

  let contact = null;
  if (autoSave) {
    try {
      contact = await personalContactStorage.create({
        name,
        company: c.company || '',
        email: email || undefined,
        whatsappNumber: phone || undefined,
        smsNumber: phone || undefined,
        notes: 'Created from Invoices & Quotations',
        source: 'quotes',
        metadata: { documentId, leadId: lead?.id },
      }, { workspaceId });
    } catch (err) {
      // Duplicate contact is OK — continue with lead link
      if (!/duplicate|already|required|Invalid/i.test(err.message)) throw err;
    }
  }

  let document = null;
  if (saveToDocument && documentId) {
    document = await quoteStorage.update(documentId, workspaceId, {
      leadId: lead?.id || null,
      contactId: contact?.id || null,
      customer: { ...c, name, company: c.company || name, email, phone },
    });
    await quoteStorage.addEvent(documentId, workspaceId, 'customer_linked', null, {
      leadId: lead?.id, contactId: contact?.id,
    });
  }
  return { lead, contact, document };
}

async function convertQuoteToInvoice(quoteId, workspaceId, { conversationId = null } = {}) {
  const quote = await quoteStorage.get(quoteId, workspaceId);
  if (!quote) throw new Error('Quote not found');
  if (quote.docType !== 'quote') throw new Error('Only quotations can be converted');
  const sourceConversationId = conversationId || quote.meta?.sourceConversationId || null;
  const invoice = await quoteStorage.create({
    docType: 'invoice',
    status: 'draft',
    leadId: quote.leadId,
    contactId: quote.contactId,
    customer: quote.customer,
    company: quote.company,
    lineItems: quote.lineItems,
    currency: quote.currency,
    discountPct: quote.discountPct,
    discountAmount: quote.discountAmount,
    taxPct: quote.taxPct,
    shipping: quote.shipping,
    notes: quote.notes,
    terms: quote.terms,
    paymentTerms: quote.paymentTerms,
    template: quote.template,
    quoteId: quote.id,
    dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    meta: {
      ...(quote.meta || {}),
      convertedFrom: quote.id,
      sourceConversationId,
      editorSections: quote.meta?.editorSections,
      introText: quote.meta?.introText,
      footerText: quote.meta?.footerText,
    },
  }, workspaceId);
  await quoteStorage.update(quote.id, workspaceId, {
    status: 'converted',
    acceptedAt: quote.acceptedAt || new Date().toISOString(),
    meta: { ...(quote.meta || {}), convertedInvoiceId: invoice.id },
  });
  await quoteStorage.addEvent(quote.id, workspaceId, 'converted_to_invoice', null, { invoiceId: invoice.id, number: invoice.number });
  await quoteStorage.addEvent(invoice.id, workspaceId, 'created_from_quote', null, { quoteId: quote.id, number: quote.number });
  if (quote.leadId) {
    await timelineStorage.recordEvent({
      leadId: quote.leadId,
      type: 'ai_action',
      referenceId: invoice.id,
      payload: {
        action: 'invoice_from_quote',
        quoteId: quote.id,
        invoiceId: invoice.id,
        number: invoice.number,
        fromNumber: quote.number,
      },
    }, { workspaceId }).catch(() => null);
  }
  if (sourceConversationId) {
    await conversationStorage.addMessage(sourceConversationId, {
      direction: 'outbound',
      channel: 'system',
      body: `Quotation ${quote.number} converted to Invoice ${invoice.number}`,
      source: 'quotes',
      messageType: 'quote',
      status: 'sent',
      metadata: {
        quoteCard: true,
        quoteId: invoice.id,
        docType: 'invoice',
        number: invoice.number,
        total: invoice.total,
        currency: invoice.currency,
        status: 'draft',
        customerName: invoice.customer?.company || invoice.customer?.name || '',
        convertedFrom: quote.id,
        journey: 'quote_invoice',
      },
    }).catch((err) => {
      console.warn('[Quotes] Failed to attach converted invoice card:', err.message);
    });
  }
  const accepted = await quoteStorage.get(quote.id, workspaceId);
  await quoteIntelligence.publishDocumentMilestone(accepted, 'quote_accepted', { workspaceId }).catch(() => null);
  await quoteIntelligence.publishDocumentMilestone(invoice, 'invoice_generated', { workspaceId }).catch(() => null);
  return { quote: accepted, invoice };
}

async function setStatus(id, workspaceId, status, { channel = null } = {}) {
  const doc = await quoteStorage.get(id, workspaceId);
  if (!doc) throw new Error('Document not found');
  const allowed = doc.docType === 'invoice' ? quoteStorage.INVOICE_STATUSES : quoteStorage.QUOTE_STATUSES;
  if (!allowed.includes(status)) throw new Error(`Invalid status '${status}' for ${doc.docType}`);
  const patch = { status };
  const now = new Date().toISOString();
  if (status === 'sent') patch.sentAt = now;
  if (status === 'viewed') patch.viewedAt = now;
  if (status === 'accepted') patch.acceptedAt = now;
  if (status === 'paid') { patch.paidAt = now; patch.amountPaid = doc.total; }
  if (channel) patch.meta = { ...(doc.meta || {}), lastChannel: channel };
  const updated = await quoteStorage.update(id, workspaceId, patch);
  await quoteStorage.addEvent(id, workspaceId, `status_${status}`, channel, { from: doc.status, to: status });
  if (doc.leadId) {
    await timelineStorage.recordEvent({
      leadId: doc.leadId,
      type: 'status_changed',
      channel: channel || null,
      referenceId: id,
      payload: { action: `${doc.docType}_status`, from: doc.status, to: status, number: doc.number },
    }, { workspaceId }).catch(() => null);
  }
  const milestone =
    status === 'accepted' ? 'quote_accepted'
      : status === 'rejected' ? 'quote_rejected'
        : status === 'paid' ? 'invoice_paid'
          : status === 'viewed' ? 'quote_viewed'
            : status === 'sent' ? (doc.docType === 'invoice' ? 'invoice_sent' : 'quote_sent')
              : null;
  if (milestone) {
    await quoteIntelligence.publishDocumentMilestone(updated, milestone, { channel, workspaceId }).catch(() => null);
  }
  return updated;
}

async function recordPayment({ id, workspaceId, amount, method = 'manual', note = '' }) {
  const doc = await quoteStorage.get(id, workspaceId);
  if (!doc) throw new Error('Document not found');
  if (doc.docType !== 'invoice') throw new Error('Payments apply to invoices only');
  const payAmount = amount != null ? Number(amount) : Number(doc.total);
  if (!(payAmount > 0)) throw new Error('Invalid payment amount');
  const payment = await quoteStorage.addPayment({
    invoiceId: id,
    workspaceId,
    amount: payAmount,
    currency: doc.currency,
    method,
    status: 'completed',
    meta: { note },
  });
  const paidTotal = Number(doc.amountPaid || 0) + payAmount;
  let status = 'partially_paid';
  if (paidTotal + 0.001 >= Number(doc.total)) status = 'paid';
  const updated = await quoteStorage.update(id, workspaceId, {
    amountPaid: Math.min(paidTotal, Number(doc.total)),
    status,
    paidAt: status === 'paid' ? new Date().toISOString() : doc.paidAt,
  });
  await quoteStorage.addEvent(id, workspaceId, 'payment_recorded', method, { amount: payAmount, paymentId: payment.id });
  if (status === 'paid') {
    await quoteIntelligence.publishDocumentMilestone(updated, 'invoice_paid', { channel: method, workspaceId }).catch(() => null);
  }
  return { document: updated, payment };
}

async function exportPdf(id, workspaceId, opts = {}) {
  const doc = await quoteStorage.get(id, workspaceId);
  if (!doc) throw new Error('Document not found');
  const enriched = {
    ...doc,
    shareUrl: opts.shareUrl || null,
    publicUrl: opts.publicUrl || null,
  };
  const pdf = await generateDocumentPdf(enriched);
  const updated = await quoteStorage.update(id, workspaceId, { pdfPath: pdf.urlPath });
  await quoteStorage.addEvent(id, workspaceId, 'pdf_exported', null, { path: pdf.urlPath });
  return { document: updated, pdf };
}

function publicBaseUrl(req) {
  const env = process.env.PUBLIC_API_URL || process.env.API_BASE_URL || process.env.APP_URL;
  if (env) return String(env).replace(/\/$/, '');
  if (req) {
    const host = req.get('host');
    const proto = req.protocol || 'http';
    if (host) return `${proto}://${host}`;
  }
  return `http://127.0.0.1:${process.env.PORT || 5001}`;
}

function frontendBaseUrl(req) {
  const env = process.env.FRONTEND_URL || process.env.APP_FRONTEND_URL || process.env.PUBLIC_APP_URL;
  if (env) return String(env).replace(/\/$/, '');
  if (req) {
    const origin = req.get('origin');
    if (origin) return origin.replace(/\/$/, '');
  }
  return 'http://127.0.0.1:3000';
}

async function createShareLink({ id, workspaceId, req }) {
  const doc = await quoteStorage.ensurePublicToken(id, workspaceId);
  if (!doc) throw new Error('Document not found');
  const token = doc.publicToken || doc.meta?.publicToken;
  if (!token) {
    // JSON fallback: store token in meta
    const t = `sh_${crypto.randomBytes(16).toString('hex')}`;
    const updated = await quoteStorage.update(id, workspaceId, {
      publicToken: t,
      meta: { ...(doc.meta || {}), publicToken: t },
    });
    await quoteStorage.addEvent(id, workspaceId, 'share_link_created', null, { token: t });
    const shareUrl = `${frontendBaseUrl(req)}/share/quote/${t}`;
    const apiUrl = `${publicBaseUrl(req)}/api/public/quotes/${t}`;
    return { document: updated, token: t, shareUrl, apiUrl };
  }
  await quoteStorage.addEvent(id, workspaceId, 'share_link_created', null, { token });
  return {
    document: doc,
    token,
    shareUrl: `${frontendBaseUrl(req)}/share/quote/${token}`,
    apiUrl: `${publicBaseUrl(req)}/api/public/quotes/${token}`,
  };
}

async function getPublicDocument(token) {
  const doc = await quoteStorage.getByPublicToken(token);
  if (!doc && token) {
    // JSON meta fallback scan
    const { items } = await quoteStorage.list({ workspaceId: process.env.DEFAULT_WORKSPACE_ID || 'default', limit: 200 }).catch(() => ({ items: [] }));
    // Can't scan all workspaces easily in JSON — try getByPublicToken only
  }
  let found = doc;
  if (!found) {
    // Scan via postgres already done; for JSON try loading all
    const fs = require('fs');
    const p = path.join(__dirname, '..', 'data', 'sales_documents.json');
    if (fs.existsSync(p)) {
      try {
        const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
        const hit = (rows || []).find((d) => (d.public_token || d.publicToken || d.meta?.publicToken) === token);
        if (hit) found = require('../utils/quoteStorage').get
          ? await quoteStorage.get(hit.id, hit.workspace_id || hit.workspaceId)
          : null;
        if (!found && hit) {
          const map = quoteStorage; // use get
          found = await quoteStorage.get(hit.id, hit.workspace_id || hit.workspaceId);
        }
      } catch (_) { /* ignore */ }
    }
  }
  if (!found) return null;
  if (found.status === 'draft' || found.status === 'sent') {
    found = await setStatus(found.id, found.workspaceId, 'viewed').catch(() => found);
  } else if (!found.viewedAt) {
    found = await quoteStorage.update(found.id, found.workspaceId, { viewedAt: new Date().toISOString() });
    await quoteStorage.addEvent(found.id, found.workspaceId, 'viewed_via_share', null, {}).catch(() => null);
    await quoteIntelligence.publishDocumentMilestone(found, 'quote_viewed', { workspaceId: found.workspaceId }).catch(() => null);
  }
  // Public payload — no internal ids beyond what's needed
  return {
    id: found.id,
    docType: found.docType,
    number: found.number,
    status: found.status,
    customer: found.customer,
    company: found.company,
    lineItems: found.lineItems,
    currency: found.currency,
    subtotal: found.subtotal,
    discountPct: found.discountPct,
    discountAmount: found.discountAmount,
    taxPct: found.taxPct,
    taxAmount: found.taxAmount,
    shipping: found.shipping,
    total: found.total,
    notes: found.notes,
    terms: found.terms,
    paymentTerms: found.paymentTerms,
    template: found.template,
    validUntil: found.validUntil,
    dueDate: found.dueDate,
    viewedAt: found.viewedAt,
  };
}

function buildCustomerDocumentEmailHtml({
  label,
  number,
  customerName,
  totalLabel,
  viewUrl,
  pdfUrl,
  companyName,
}) {
  const safe = (v) => String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:Georgia,'Times New Roman',serif;color:#0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">${safe(companyName)}</td></tr>
        <tr><td style="padding:0 32px 8px;font-size:28px;font-weight:700;">${safe(label)} ${safe(number)}</td></tr>
        <tr><td style="padding:0 32px 20px;font-size:15px;line-height:1.6;color:#334155;">
          Hello ${safe(customerName)},<br/><br/>
          Your ${safe(String(label || '').toLowerCase())} is ready. Total due: <strong>${safe(totalLabel)}</strong>.
          A PDF copy is attached for your records.
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <a href="${safe(viewUrl)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-family:Arial,sans-serif;font-size:14px;font-weight:600;margin-right:10px;">View ${safe(label)}</a>
          <a href="${safe(pdfUrl)}" style="display:inline-block;background:#fff;color:#0f172a;text-decoration:none;padding:11px 18px;border-radius:8px;border:1px solid #cbd5e1;font-family:Arial,sans-serif;font-size:14px;font-weight:600;">Download PDF</a>
        </td></tr>
        <tr><td style="padding:16px 32px 28px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;font-family:Arial,sans-serif;">
          This message was sent for you only. Management actions are available to the sender inside LeadFlow AI Inbox.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendDocument({ id, workspaceId, channel, subject, body, req, isFollowUp = false, conversationId = null }) {
  let doc = await quoteStorage.get(id, workspaceId);
  if (!doc) throw new Error('Document not found');

  // Recompute totals with the corrected engine before PDF/send (fixes older double-discounted drafts).
  doc = await quoteStorage.update(id, workspaceId, {
    lineItems: doc.lineItems,
    discountPct: doc.discountPct,
    discountAmount: 0,
    taxPct: doc.taxPct,
    shipping: doc.shipping,
  }) || doc;

  // Ensure CRM lead exists (contact-thread quotes may only have customer fields)
  if (!doc.leadId || String(doc.leadId).startsWith('contact:') || String(doc.leadId).startsWith('preview_')) {
    const linked = await createOrLinkCustomer({
      workspaceId,
      documentId: id,
      customer: doc.customer || {},
      saveToDocument: true,
      autoSave: true,
    });
    doc = linked.document || (await quoteStorage.get(id, workspaceId));
  }
  if (!doc.leadId) throw new Error('Attach a lead/customer before sending');

  const share = await createShareLink({ id, workspaceId, req }).catch((err) => {
    console.error('[Quotes] Share link creation failed — email buttons would point at the API host:', err.message);
    return null;
  });
  const { pdf } = await exportPdf(id, workspaceId);
  const abs = path.join(__dirname, '..', 'uploads', pdf.filename);
  const publicUrl = share?.shareUrl || `${publicBaseUrl(req)}${pdf.urlPath}`;
  const customerPdfUrl = share?.token
    ? `${publicBaseUrl(req)}/api/public/quotes/${share.token}/pdf`
    : publicUrl;
  const label = doc.docType === 'invoice' ? 'Invoice' : 'Quotation';
  const customerLabel = doc.customer?.company || doc.customer?.name || 'you';
  const totalLabel = `${doc.currency || 'MYR'} ${Number(doc.total || 0).toFixed(2)}`;
  const defaultBody = body || [
    `Hello ${customerLabel},`,
    '',
    `Please find your ${label.toLowerCase()} ${doc.number} attached.`,
    `Total: ${totalLabel}`,
    '',
    `View online: ${publicUrl}`,
    `Download PDF: ${customerPdfUrl}`,
    '',
    'Thank you for your business.',
  ].join('\n');
  const defaultSubject = subject || `${label} ${doc.number}`;
  const customerHtml = body ? undefined : buildCustomerDocumentEmailHtml({
    label,
    number: doc.number,
    customerName: customerLabel,
    totalLabel,
    viewUrl: publicUrl,
    pdfUrl: customerPdfUrl,
    companyName: doc.company?.companyName || doc.company?.name || 'LeadFlow AI',
  });

  const sourceConversationId = conversationId
    || doc.meta?.sourceConversationId
    || null;

  const quoteMeta = {
    quoteCard: true,
    quoteId: doc.id,
    docType: doc.docType,
    number: doc.number,
    total: doc.total,
    currency: doc.currency,
    status: 'sent',
    pdfPath: pdf.urlPath,
    shareUrl: publicUrl,
    publicToken: share?.token || null,
    customerName: customerLabel,
    journey: 'quote_invoice',
    subject: defaultSubject,
    items: (doc.lineItems || []).slice(0, 3).map((it) => ({
      name: it.name || it.description || 'Item',
      qty: Number(it.qty ?? it.quantity ?? 1),
      total: Number(it.lineTotal ?? it.total ?? ((Number(it.qty ?? it.quantity ?? 1) * Number(it.unitPrice || 0)) - Number(it.discount || 0))),
    })),
    itemCount: (doc.lineItems || []).length,
    subtotal: doc.subtotal,
    discountTotal: doc.discountTotal || 0,
    taxTotal: doc.taxTotal || 0,
    sentAt: new Date().toISOString(),
  };

  async function attachQuoteCard(status = 'sent', sendError = null) {
    if (!sourceConversationId) return null;
    try {
      return await conversationStorage.addMessage(sourceConversationId, {
        direction: 'outbound',
        channel,
        body: defaultBody,
        source: 'quotes',
        messageType: 'quote',
        status: status === 'sent' ? 'sent' : 'failed',
        metadata: {
          ...quoteMeta,
          status,
          sendError: sendError || undefined,
        },
      }, { workspaceId });
    } catch (err) {
      console.warn('[Quotes] Failed to attach quote card to conversation:', err.message);
      return null;
    }
  }

  let result;
  try {
    if (channel === 'email') {
      result = await unifiedSend.send({
        leadId: doc.leadId,
        channel: 'email',
        body: defaultBody,
        subject: defaultSubject,
        workspaceId,
        conversationId: sourceConversationId,
        metadata: quoteMeta,
        scheduleFollowUps: false,
        providerSend: async () => {
          const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
          const lead = leads.find((l) => l.id === doc.leadId);
          if (!lead) throw new Error('Lead not found');
          return emailService.sendEmailToLead(lead, {
            message: defaultBody,
            subject: defaultSubject,
            workspaceId,
            htmlOverride: customerHtml,
            attachments: [{ filename: `${doc.number}.pdf`, path: abs }],
          });
        },
      });
    } else if (channel === 'whatsapp') {
      const whatsappTransport = require('./whatsappTransport');
      result = await unifiedSend.send({
        leadId: doc.leadId,
        channel: 'whatsapp',
        body: defaultBody,
        workspaceId,
        conversationId: sourceConversationId,
        metadata: quoteMeta,
        scheduleFollowUps: false,
        providerSend: async () => {
          const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
          const lead = leads.find((l) => l.id === doc.leadId);
          const to = lead?.whatsapp || lead?.phone;
          if (!to) throw new Error('Lead has no WhatsApp/phone');
          if (!whatsappTransport.isConfigured(workspaceId)) throw new Error('WhatsApp not connected');
          const documentUrl = `${publicBaseUrl(req)}${pdf.urlPath}`;
          try {
            return await whatsappTransport.sendDocument({
              workspaceId,
              to,
              documentUrl,
              filename: `${doc.number}.pdf`,
              caption: defaultBody.slice(0, 900),
            });
          } catch (_) {
            return whatsappTransport.sendText({ workspaceId, to, message: defaultBody });
          }
        },
      });
    } else if (channel === 'sms') {
      const short = `${label} ${doc.number}: ${doc.currency} ${Number(doc.total).toFixed(2)}. ${publicUrl}`.slice(0, 320);
      result = await unifiedSend.send({
        leadId: doc.leadId,
        channel: 'sms',
        body: body || short,
        workspaceId,
        conversationId: sourceConversationId,
        metadata: { ...quoteMeta, pdfPath: undefined },
        scheduleFollowUps: false,
        providerSend: async () => {
          const leads = await leadStorage.getLeads({ workspaceId, limit: 10000 });
          const lead = leads.find((l) => l.id === doc.leadId);
          const to = lead?.phone || lead?.whatsapp;
          if (!to) throw new Error('Lead has no phone');
          return sendSms({ to, body: body || short, workspaceId });
        },
      });
    } else {
      throw new Error('channel must be email, whatsapp, or sms');
    }
  } catch (err) {
    const raw = err.message || String(err);
    await attachQuoteCard('send_failed', raw);
    await quoteStorage.addEvent(id, workspaceId, 'send_failed', channel, {
      publicUrl,
      error: raw,
      conversationId: sourceConversationId,
    }).catch(() => null);
    if (/invalid_grant/i.test(raw)) {
      throw new Error('Gmail connection expired. Reconnect Gmail in Settings → Integrations, then click Approve & Send again.');
    }
    throw err;
  }

  // If unifiedSend posted to a different thread, also ensure the source Inbox thread has the card
  if (sourceConversationId && result?.conversationId && result.conversationId !== sourceConversationId) {
    await attachQuoteCard('sent');
  }

  const updated = await setStatus(id, workspaceId, isFollowUp ? doc.status : 'sent', { channel });
  await quoteStorage.addEvent(id, workspaceId, 'sent', channel, {
    publicUrl,
    result: result?.id || result?.sid || result?.messageId || true,
    followUp: isFollowUp,
    conversationId: result?.conversationId || sourceConversationId,
  });
  await quoteStorage.addEvent(id, workspaceId, 'delivered', channel, { publicUrl }).catch(() => null);
  if (!isFollowUp) {
    await timelineStorage.recordEvent({
      leadId: doc.leadId,
      type: doc.docType === 'invoice' ? 'invoice_sent' : 'quote_sent',
      channel,
      conversationId: result?.conversationId || sourceConversationId,
      referenceId: id,
      payload: {
        number: doc.number,
        total: doc.total,
        currency: doc.currency,
        shareUrl: publicUrl,
        pdfPath: pdf.urlPath,
      },
    }, { workspaceId }).catch(() => null);
    const convId = result?.conversationId || sourceConversationId;
    if (convId) {
      await conversationStorage.updateConversation(
        convId,
        { status: doc.docType === 'invoice' ? 'invoice_sent' : 'quote_sent' },
        { workspaceId }
      ).catch(() => null);
    }
    await scheduleQuoteFollowUp(id, workspaceId, channel);
  }
  return {
    document: updated,
    result,
    pdfUrl: publicUrl,
    shareUrl: share?.shareUrl || publicUrl,
    token: share?.token,
    conversationId: result?.conversationId || sourceConversationId,
  };
}

module.exports = {
  buildCustomerFromLead,
  companyFromProfile,
  resolveOpenAiConfig,
  buildConversationContext,
  generateFromConversation,
  generateFromConversationId,
  buildConversationContextById,
  generateWithAI,
  regenerateWithAI,
  createDocument,
  duplicateDocument,
  createOrLinkCustomer,
  convertQuoteToInvoice,
  setStatus,
  recordPayment,
  exportPdf,
  createShareLink,
  getPublicDocument,
  sendDocument,
  scheduleQuoteFollowUp,
  processQuoteFollowUp,
  publicBaseUrl,
  frontendBaseUrl,
};
