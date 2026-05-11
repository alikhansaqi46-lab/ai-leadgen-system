/**
 * Lead Storage Module
 * Dual persistence: Firestore (when configured) → File-based JSON (universal fallback)
 * Provides unified CRUD regardless of which backend is active.
 */

const { db } = require('../config/firebase');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '..', 'data', 'leads.json');

/* ==================== FILE HELPERS ==================== */

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadLeadsFromFile() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[LeadStorage] Failed to load leads file:', err.message);
    return [];
  }
}

function saveLeadsToFile(leads) {
  ensureDataDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  } catch (err) {
    console.error('[LeadStorage] Failed to save leads file:', err.message);
  }
}

/* ==================== DEDUPLICATION ==================== */

function deduplicateLeads(existingLeads, newLeads) {
  const seenPhones = new Set();
  const seenNames = new Set();

  // Mark existing
  for (const lead of existingLeads) {
    const phone = (lead.phone || '').replace(/\D/g, '').trim();
    if (phone && phone !== 'N/A') seenPhones.add(phone);
    const name = (lead.name || '').toLowerCase().trim();
    if (name && name !== 'unknown') seenNames.add(name);
  }

  const unique = [];
  for (const lead of newLeads) {
    const phone = (lead.phone || '').replace(/\D/g, '').trim();
    const name = (lead.name || '').toLowerCase().trim();

    if (phone && phone !== 'N/A' && seenPhones.has(phone)) continue;
    if (name && name !== 'unknown' && seenNames.has(name)) continue;

    if (phone && phone !== 'N/A') seenPhones.add(phone);
    if (name && name !== 'unknown') seenNames.add(name);

    unique.push(lead);
  }
  return unique;
}

/* ==================== FIRESTORE HELPERS ==================== */

async function getLeadsFromFirestore({ country, niche, limit = 100 } = {}) {
  let query = db.collection('leads').orderBy('createdAt', 'desc');
  if (country) query = query.where('country', '==', country);
  if (niche) query = query.where('niche', '==', niche);
  query = query.limit(parseInt(limit));
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function saveLeadsToFirestore(leads) {
  const batch = db.batch();
  const saved = [];
  for (const lead of leads) {
    const docRef = db.collection('leads').doc();
    const data = { ...lead, id: docRef.id, createdAt: new Date().toISOString(), source: lead.source || 'scraped' };
    batch.set(docRef, data);
    saved.push(data);
  }
  await batch.commit();
  return saved;
}

async function deleteLeadsFromFirestore(ids) {
  const batch = db.batch();
  for (const id of ids) {
    batch.delete(db.collection('leads').doc(id));
  }
  await batch.commit();
}

/* ==================== UNIFIED API ==================== */

const storage = {
  /**
   * Get all leads (newest first)
   */
  async getLeads(options = {}) {
    if (db) {
      try {
        return await getLeadsFromFirestore(options);
      } catch (err) {
        console.error('[LeadStorage] Firestore get failed, falling back to file:', err.message);
      }
    }
    return loadLeadsFromFile();
  },

  /**
   * Add new leads, deduplicate against existing, generate UUIDs
   * Returns the actually-added leads
   */
  async addLeads(newLeads) {
    const enriched = newLeads.map(lead => ({
      ...lead,
      id: lead.id && !String(lead.id).startsWith('lead_') ? lead.id : uuidv4(),
      createdAt: lead.createdAt || new Date().toISOString(),
      source: lead.source || 'scraped'
    }));

    if (db) {
      try {
        // Read existing for dedup
        const existing = await getLeadsFromFirestore({ limit: 10000 });
        const unique = deduplicateLeads(existing, enriched);
        if (unique.length === 0) {
          console.log('[LeadStorage] All leads are duplicates, nothing added');
          return [];
        }
        const saved = await saveLeadsToFirestore(unique);
        console.log(`[LeadStorage] Saved ${saved.length} leads to Firestore`);
        return saved;
      } catch (err) {
        console.error('[LeadStorage] Firestore save failed, falling back to file:', err.message);
      }
    }

    // File-based fallback
    const existing = loadLeadsFromFile();
    const unique = deduplicateLeads(existing, enriched);
    if (unique.length === 0) {
      console.log('[LeadStorage] All leads are duplicates, nothing added');
      return [];
    }
    const merged = [...unique, ...existing];
    saveLeadsToFile(merged);
    console.log(`[LeadStorage] Saved ${unique.length} leads to file (total: ${merged.length})`);
    return unique;
  },

  /**
   * Delete leads by ID array
   */
  async deleteLeads(ids) {
    if (db) {
      try {
        await deleteLeadsFromFirestore(ids);
        console.log(`[LeadStorage] Deleted ${ids.length} leads from Firestore`);
        return;
      } catch (err) {
        console.error('[LeadStorage] Firestore delete failed, falling back to file:', err.message);
      }
    }

    const existing = loadLeadsFromFile();
    const filtered = existing.filter(lead => !ids.includes(lead.id));
    saveLeadsToFile(filtered);
    console.log(`[LeadStorage] Deleted ${ids.length} leads from file (removed ${existing.length - filtered.length})`);
  },

  /**
   * Get unique countries and niches for filters
   */
  async getFilters() {
    const leads = await this.getLeads({ limit: 10000 });
    const countries = new Set();
    const niches = new Set();
    for (const lead of leads) {
      if (lead.country) countries.add(lead.country);
      if (lead.niche) niches.add(lead.niche);
    }
    return {
      countries: Array.from(countries).sort(),
      niches: Array.from(niches).sort()
    };
  },

  /**
   * Export all leads (for CSV generation)
   */
  async exportLeads({ country, niche } = {}) {
    let leads = await this.getLeads({ limit: 10000 });
    if (country) leads = leads.filter(l => l.country === country);
    if (niche) leads = leads.filter(l => l.niche === niche);
    return leads;
  }
};

module.exports = storage;
