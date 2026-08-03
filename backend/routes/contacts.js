const express = require('express');
const router = express.Router();
const personalContacts = require('../utils/personalContactStorage');

const { workspaceOf } = require('../utils/workspaceContext');

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

router.get('/', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const { search, limit, offset } = req.query;
    const result = await personalContacts.list({ workspaceId, search, limit, offset });
    res.json({ success: true, count: result.contacts.length, ...result });
  } catch (error) {
    console.error('[Contacts] list error:', error.message);
    res.status(500).json({ error: 'Failed to list contacts', message: error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const contact = await personalContacts.create(req.body || {}, { workspaceId });
    res.status(201).json({ success: true, contact });
  } catch (error) {
    console.error('[Contacts] create error:', error.message);
    res.status(400).json({ error: 'Failed to create contact', message: error.message });
  }
});

router.get('/export.csv', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const result = await personalContacts.list({
      workspaceId,
      search: req.query.search,
      limit: Math.min(parseInt(req.query.limit, 10) || 5000, 10000),
      offset: parseInt(req.query.offset, 10) || 0,
    });
    const headers = ['Contact ID', 'Name', 'Company', 'WhatsApp Number', 'SMS Number', 'Email', 'Duplicate', 'Notes', 'Source', 'Created At'];
    const rows = result.contacts.map((contact) => [
      contact.id,
      contact.name,
      contact.company,
      contact.whatsappNumber,
      contact.smsNumber,
      contact.email,
      contact.isDuplicate ? 'Yes' : 'No',
      contact.notes,
      contact.source,
      contact.createdAt || '',
    ]);
    const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts_export_${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('[Contacts] CSV export error:', error.message);
    res.status(500).json({ error: 'Failed to export contacts', message: error.message });
  }
});

router.post('/bulk-import', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const rows = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : personalContacts.parseLines(req.body?.text || '', req.body?.mode || 'mixed');
    const limited = rows.slice(0, 10000);
    const result = await personalContacts.bulkCreate(limited, { workspaceId, source: req.body?.source || 'bulk' });
    res.json({ success: true, parsed: rows.length, ...result });
  } catch (error) {
    console.error('[Contacts] bulk import error:', error.message);
    res.status(500).json({ error: 'Failed to import contacts', message: error.message });
  }
});

router.post('/bulk-delete', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const deleted = await personalContacts.bulkDelete(req.body?.ids || [], { workspaceId });
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[Contacts] bulk delete error:', error.message);
    res.status(500).json({ error: 'Failed to delete contacts', message: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const contact = await personalContacts.get(req.params.id, { workspaceId });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (error) {
    console.error('[Contacts] get error:', error.message);
    res.status(500).json({ error: 'Failed to load contact', message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const contact = await personalContacts.update(req.params.id, req.body || {}, { workspaceId });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, contact });
  } catch (error) {
    console.error('[Contacts] update error:', error.message);
    res.status(400).json({ error: 'Failed to update contact', message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const deleted = await personalContacts.bulkDelete([req.params.id], { workspaceId });
    if (!deleted) return res.status(404).json({ error: 'Contact not found' });
    res.json({ success: true, deleted });
  } catch (error) {
    console.error('[Contacts] delete error:', error.message);
    res.status(500).json({ error: 'Failed to delete contact', message: error.message });
  }
});

module.exports = router;
