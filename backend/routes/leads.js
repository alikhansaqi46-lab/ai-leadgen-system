const express = require('express');
const router = express.Router();
const storage = require('../utils/leadStorage');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Get all leads with filters
router.get('/', async (req, res) => {
  try {
    const { country, niche, limit = 100 } = req.query;
    const leads = await storage.getLeads({ country, niche, limit: parseInt(limit) });
    res.json({ leads, count: leads.length });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ leads: [], error: error.message });
  }
});

// Get unique countries and niches for filters
router.get('/filters', async (req, res) => {
  try {
    const filters = await storage.getFilters();
    res.json(filters);
  } catch (error) {
    console.error('Error fetching filters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export leads to CSV
router.get('/export', async (req, res) => {
  try {
    const { country, niche } = req.query;
    const leads = await storage.exportLeads({ country, niche });

    if (leads.length === 0) {
      return res.status(404).json({ error: 'No leads found for export' });
    }

    const filename = `leads_export_${uuidv4()}.csv`;
    const filepath = path.join(__dirname, '..', 'temp', filename);

    if (!fs.existsSync(path.dirname(filepath))) {
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
    }

    const csvWriter = createCsvWriter({
      path: filepath,
      header: [
        { id: 'name', title: 'Business Name' },
        { id: 'phone', title: 'Phone' },
        { id: 'whatsapp', title: 'WhatsApp' },
        { id: 'email', title: 'Email' },
        { id: 'website', title: 'Website' },
        { id: 'address', title: 'Full Address' },
        { id: 'city', title: 'City' },
        { id: 'area', title: 'Area' },
        { id: 'country', title: 'Country' },
        { id: 'niche', title: 'Niche' },
        { id: 'category', title: 'Category' },
        { id: 'rating', title: 'Rating' },
        { id: 'reviews', title: 'Reviews' },
        { id: 'mapsUrl', title: 'Google Maps URL' },
        { id: 'createdAt', title: 'Created At' }
      ]
    });

    await csvWriter.writeRecords(leads);

    res.download(filepath, filename, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      fs.unlink(filepath, () => {});
    });
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a lead
router.delete('/:id', async (req, res) => {
  try {
    await storage.deleteLeads([req.params.id]);
    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk save leads
router.post('/bulk', async (req, res) => {
  try {
    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }

    const saved = await storage.addLeads(leads);
    res.json({ message: 'Leads saved successfully', count: saved.length, leads: saved });
  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk delete leads
router.post('/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    await storage.deleteLeads(ids);
    res.json({ message: 'Leads deleted successfully', count: ids.length });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
