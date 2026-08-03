/**
 * Email Template Storage — file-based JSON (sufficient for MVP).
 * Future: migrate to Postgres when multi-workspace template sharing is needed.
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_FILE = path.join(__dirname, '..', 'data', 'email_templates.json');

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function save(templates) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(templates, null, 2));
}

const emailTemplateStorage = {
  async list() {
    return load();
  },

  async get(id) {
    return load().find((t) => t.id === id) || null;
  },

  async create(data) {
    const templates = load();
    const template = { id: uuidv4(), ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    templates.push(template);
    save(templates);
    return template;
  },

  async update(id, updates) {
    const templates = load();
    const idx = templates.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    templates[idx] = { ...templates[idx], ...updates, updatedAt: new Date().toISOString() };
    save(templates);
    return templates[idx];
  },

  async delete(id) {
    const templates = load();
    const filtered = templates.filter((t) => t.id !== id);
    if (filtered.length === templates.length) return false;
    save(filtered);
    return true;
  },
};

module.exports = emailTemplateStorage;
