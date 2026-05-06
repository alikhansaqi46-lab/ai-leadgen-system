const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Get all leads with filters
router.get('/', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const { country, niche, limit = 100 } = req.query;
    let query = db.collection('leads').orderBy('createdAt', 'desc');

    if (country) {
      query = query.where('country', '==', country);
    }
    if (niche) {
      query = query.where('niche', '==', niche);
    }

    query = query.limit(parseInt(limit));
    const snapshot = await query.get();

    const leads = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ leads, count: leads.length });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get unique countries and niches for filters
router.get('/filters', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const snapshot = await db.collection('leads').get();
    const countries = new Set();
    const niches = new Set();

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.country) countries.add(data.country);
      if (data.niche) niches.add(data.niche);
    });

    res.json({
      countries: Array.from(countries).sort(),
      niches: Array.from(niches).sort()
    });
  } catch (error) {
    console.error('Error fetching filters:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export leads to CSV
router.get('/export', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const { country, niche } = req.query;
    let query = db.collection('leads');

    if (country) {
      query = query.where('country', '==', country);
    }
    if (niche) {
      query = query.where('niche', '==', niche);
    }

    const snapshot = await query.get();
    const leads = snapshot.docs.map(doc => doc.data());

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
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    await db.collection('leads').doc(req.params.id).delete();
    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk save leads
router.post('/bulk', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const { leads } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'No leads provided' });
    }

    const batch = db.batch();
    const savedLeads = [];

    for (const lead of leads) {
      const docRef = db.collection('leads').doc();
      const leadData = {
        ...lead,
        id: docRef.id,
        createdAt: new Date().toISOString(),
        source: 'scraped'
      };
      batch.set(docRef, leadData);
      savedLeads.push(leadData);
    }

    await batch.commit();
    console.log(`✅ Saved ${savedLeads.length} leads to database`);
    res.json({ message: 'Leads saved successfully', count: savedLeads.length, leads: savedLeads });
  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk delete leads
router.post('/bulk-delete', async (req, res) => {
  try {
    if (!db) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No IDs provided' });
    }

    const batch = db.batch();

    for (const id of ids) {
      const docRef = db.collection('leads').doc(id);
      batch.delete(docRef);
    }

    await batch.commit();
    console.log(`🗑️ Bulk deleted ${ids.length} leads`);
    res.json({ message: 'Leads deleted successfully', count: ids.length });
  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
