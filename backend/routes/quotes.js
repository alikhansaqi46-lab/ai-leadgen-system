const express = require('express');
const router = express.Router();
const { workspaceOf } = require('../utils/workspaceContext');
const quoteStorage = require('../utils/quoteStorage');
const quoteService = require('../services/quoteService');
const leadStorage = require('../utils/leadStorage');
const path = require('path');
const fs = require('fs');

function userIdOf(req) { return req.auth?.userId || null; }

router.get('/stats', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    res.json({ success: true, ...(await quoteStorage.stats(workspaceId)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/templates', (req, res) => {
  res.json({
    success: true,
    templates: quoteStorage.TEMPLATES.map((id) => ({
      id,
      label: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    })),
    quoteStatuses: quoteStorage.QUOTE_STATUSES,
    invoiceStatuses: quoteStorage.INVOICE_STATUSES,
  });
});

router.get('/billing-profile', async (req, res) => {
  try {
    const profile = await quoteStorage.getBillingProfile(workspaceOf(req));
    res.json({ success: true, profile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/billing-profile', async (req, res) => {
  try {
    const profile = await quoteStorage.upsertBillingProfile(workspaceOf(req), req.body || {});
    res.json({ success: true, profile });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/leads-options', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const leads = await leadStorage.getLeads({ workspaceId, limit: 500 });
    res.json({
      success: true,
      leads: leads.map((l) => ({
        id: l.id,
        name: l.name,
        company: l.company || l.businessName || '',
        email: l.email,
        phone: l.phone || l.whatsapp,
        city: l.city,
        country: l.country,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const result = await quoteStorage.list({
      workspaceId,
      docType: req.query.docType,
      status: req.query.status,
      leadId: req.query.leadId,
      q: req.query.q,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const doc = await quoteService.createDocument({
      workspaceId,
      userId: userIdOf(req),
      input: req.body || {},
    });
    res.status(201).json({ success: true, document: doc });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/ai-generate', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = userIdOf(req);
    const { prompt, leadId, template, customer, conversationId } = req.body || {};
    // Respect the selected document type (quotation or invoice).
    const docType = req.body.docType === 'invoice' ? 'invoice' : 'quote';
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });
    const oaConfig = await quoteService.resolveOpenAiConfig(userId);
    if (oaConfig.blocked) {
      return res.status(403).json({ error: 'AI access denied', code: oaConfig.reason });
    }
    const doc = await quoteService.createDocument({
      workspaceId,
      userId,
      useAi: true,
      prompt: String(prompt),
      oaConfig,
      input: {
        docType,
        leadId,
        template,
        customer,
        meta: conversationId ? { sourceConversationId: conversationId } : {},
      },
    });
    res.status(201).json({ success: true, document: doc });
  } catch (err) {
    res.status(err.code === 'FREE_MESSAGES_EXHAUSTED' ? 403 : 500).json({ error: err.message, code: err.code });
  }
});

router.post('/ai-from-conversation', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = userIdOf(req);
    const { conversationId, prompt, template, autoMode } = req.body || {};
    // Respect the selected document type (quotation or invoice).
    const docType = req.body.docType === 'invoice' ? 'invoice' : 'quote';
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
    const oaConfig = await quoteService.resolveOpenAiConfig(userId);
    if (oaConfig.blocked) {
      return res.status(403).json({ error: 'AI access denied', code: oaConfig.reason });
    }
    const { generated, primaryChannel, messageCount, leadId } = await quoteService.generateFromConversationId({
      conversationId,
      workspaceId,
      docType,
      oaConfig,
      extraPrompt: prompt || '',
    });
    if (userId && oaConfig.source) {
      await require('../services/openAiKeyService').consumeFreeMessage(userId, oaConfig.source).catch(() => null);
    }
    let linkedLeadId = leadId;
    if (!linkedLeadId && generated.customer && (generated.customer.email || generated.customer.phone)) {
      const linked = await quoteService.createOrLinkCustomer({
        workspaceId,
        customer: generated.customer,
        saveToDocument: false,
        autoSave: false,
      }).catch(() => null);
      linkedLeadId = linked?.lead?.id || null;
      if (linkedLeadId) generated.leadId = linkedLeadId;
    }
    const doc = await quoteService.createDocument({
      workspaceId,
      userId,
      input: {
        ...generated,
        docType,
        leadId: linkedLeadId || generated.leadId,
        template,
        aiPrompt: prompt || 'from-conversation-thread',
        meta: { ...(generated.meta || {}), sourceConversationId: conversationId },
      },
    });
    let sendResult = null;
    const sendChannel = ['whatsapp', 'email', 'sms'].includes(primaryChannel) ? primaryChannel : 'email';
    if (autoMode && doc.leadId && sendChannel !== 'sms') {
      sendResult = await quoteService.sendDocument({
        id: doc.id,
        workspaceId,
        channel: sendChannel,
        conversationId,
        req,
      });
    } else if (autoMode && doc.leadId && sendChannel === 'sms') {
      sendResult = await quoteService.sendDocument({
        id: doc.id,
        workspaceId,
        channel: 'sms',
        conversationId,
        req,
      });
    }
    res.status(201).json({
      success: true,
      document: sendResult?.document || doc,
      primaryChannel,
      messageCount,
      fromConversation: true,
      autoSent: Boolean(autoMode && sendResult),
      sendResult,
    });
  } catch (err) {
    res.status(err.code === 'FREE_MESSAGES_EXHAUSTED' ? 403 : 500).json({ error: err.message, code: err.code });
  }
});

router.post('/ai-from-lead', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = userIdOf(req);
    const { leadId, prompt, template, autoMode } = req.body || {};
    const docType = 'quote';
    if (!leadId) return res.status(400).json({ error: 'leadId is required' });
    const oaConfig = await quoteService.resolveOpenAiConfig(userId);
    if (oaConfig.blocked) {
      return res.status(403).json({ error: 'AI access denied', code: oaConfig.reason });
    }
    const { generated, primaryChannel, messageCount } = await quoteService.generateFromConversation({
      leadId,
      workspaceId,
      docType,
      oaConfig,
      extraPrompt: prompt || '',
    });
    if (userId && oaConfig.source) {
      await require('../services/openAiKeyService').consumeFreeMessage(userId, oaConfig.source).catch(() => null);
    }
    const doc = await quoteService.createDocument({
      workspaceId,
      userId,
      input: {
        ...generated,
        docType,
        leadId,
        template,
        aiPrompt: prompt || 'from-conversation',
      },
    });
    let sendResult = null;
    if (autoMode) {
      sendResult = await quoteService.sendDocument({
        id: doc.id,
        workspaceId,
        channel: ['whatsapp', 'email', 'sms'].includes(primaryChannel) ? primaryChannel : 'email',
        req,
      });
    }
    res.status(201).json({
      success: true,
      document: sendResult?.document || doc,
      primaryChannel,
      messageCount,
      fromConversation: true,
      autoSent: Boolean(autoMode && sendResult),
      sendResult,
    });
  } catch (err) {
    res.status(err.code === 'FREE_MESSAGES_EXHAUSTED' ? 403 : 500).json({ error: err.message, code: err.code });
  }
});

router.post('/customers', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const result = await quoteService.createOrLinkCustomer({
      workspaceId,
      documentId: req.body?.documentId || null,
      customer: req.body?.customer || req.body || {},
      saveToDocument: Boolean(req.body?.documentId),
      autoSave: req.body?.autoSave !== false,
    });
    res.status(201).json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const doc = await quoteStorage.get(req.params.id, workspaceOf(req));
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const events = await quoteStorage.listEvents(doc.id, workspaceOf(req));
    res.json({ success: true, document: doc, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/events', async (req, res) => {
  try {
    const events = await quoteStorage.listEvents(req.params.id, workspaceOf(req));
    res.json({ success: true, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const updated = await quoteStorage.update(req.params.id, workspaceId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Not found' });
    await quoteStorage.addEvent(updated.id, workspaceId, 'updated', null, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, document: updated });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/regenerate', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const userId = userIdOf(req);
    const doc = await quoteStorage.get(req.params.id, workspaceId);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const instruction = String(req.body?.instruction || '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction is required' });
    const replaceCustomer = Boolean(req.body?.replaceCustomer);
    const oaConfig = await quoteService.resolveOpenAiConfig(userId);
    if (oaConfig.blocked) return res.status(403).json({ error: 'AI access denied', code: oaConfig.reason });
    const generated = await quoteService.regenerateWithAI({ document: doc, instruction, oaConfig, replaceCustomer });
    if (userId && oaConfig.source) await require('../services/openAiKeyService').consumeFreeMessage(userId, oaConfig.source).catch(() => null);
    const updated = await quoteStorage.update(doc.id, workspaceId, {
      ...generated,
      customer: replaceCustomer ? generated.customer : { ...(doc.customer || {}) },
      company: doc.company,
      leadId: doc.leadId,
      contactId: doc.contactId,
    });
    await quoteStorage.addEvent(doc.id, workspaceId, 'ai_regenerated', null, { instruction, replaceCustomer });
    res.json({ success: true, document: updated });
  } catch (err) { res.status(500).json({ error: err.message, code: err.code }); }
});

router.post('/:id/status', async (req, res) => {
  try {
    const status = String(req.body?.status || '').toLowerCase();
    const updated = await quoteService.setStatus(req.params.id, workspaceOf(req), status, {
      channel: req.body?.channel || null,
    });
    res.json({ success: true, document: updated });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/convert', async (req, res) => {
  try {
    const result = await quoteService.convertQuoteToInvoice(
      req.params.id,
      workspaceOf(req),
      { conversationId: req.body?.conversationId || null },
    );
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/duplicate', async (req, res) => {
  try {
    const copy = await quoteService.duplicateDocument(req.params.id, workspaceOf(req));
    res.status(201).json({ success: true, document: copy });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/share', async (req, res) => {
  try {
    const result = await quoteService.createShareLink({
      id: req.params.id,
      workspaceId: workspaceOf(req),
      req,
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/payment', async (req, res) => {
  try {
    const result = await quoteService.recordPayment({
      id: req.params.id,
      workspaceId: workspaceOf(req),
      amount: req.body?.amount,
      method: req.body?.method || 'manual',
      note: req.body?.note || '',
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/:id/customer', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const doc = await quoteStorage.get(req.params.id, workspaceId);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const result = await quoteService.createOrLinkCustomer({
      workspaceId,
      documentId: doc.id,
      customer: req.body?.customer || doc.customer,
      saveToDocument: true,
      autoSave: req.body?.autoSave !== false,
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await quoteStorage.remove(req.params.id, workspaceOf(req));
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const { document, pdf } = await quoteService.exportPdf(req.params.id, workspaceOf(req));
    const abs = path.join(__dirname, '..', 'uploads', pdf.filename);
    if (!fs.existsSync(abs)) return res.status(500).json({ error: 'PDF missing' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.number || document.id}.pdf"`);
    fs.createReadStream(abs).pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/send', async (req, res) => {
  try {
    const channel = String(req.body?.channel || '').toLowerCase();
    const result = await quoteService.sendDocument({
      id: req.params.id,
      workspaceId: workspaceOf(req),
      channel,
      subject: req.body?.subject,
      body: req.body?.body,
      conversationId: req.body?.conversationId || null,
      req,
    });
    res.json({ success: true, ...result });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
