/**
 * Automation Engine API
 *
 * GET    /api/automations              list
 * GET    /api/automations/stats        real execution stats
 * GET    /api/automations/runs         recent runs
 * GET    /api/automations/logs         recent logs
 * POST   /api/automations              create
 * GET    /api/automations/:id
 * PUT    /api/automations/:id          update
 * DELETE /api/automations/:id
 * POST   /api/automations/:id/enable
 * POST   /api/automations/:id/disable
 * POST   /api/automations/:id/run      manual execute
 */

const express = require('express');
const router = express.Router();
const automationStorage = require('../utils/automationStorage');
const { runAutomation } = require('../services/automationEngine');

const { workspaceOf } = require('../utils/workspaceContext');

router.get('/stats', async (req, res) => {
  try {
    const stats = await automationStorage.getStats({ workspaceId: workspaceOf(req) });
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[Automations] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs', async (req, res) => {
  try {
    const runs = await automationStorage.listRuns({
      workspaceId: workspaceOf(req),
      limit: req.query.limit,
    });
    res.json({ success: true, runs });
  } catch (err) {
    console.error('[Automations] runs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/logs', async (req, res) => {
  try {
    const logs = await automationStorage.listLogs({
      workspaceId: workspaceOf(req),
      runId: req.query.runId,
      limit: req.query.limit,
    });
    res.json({ success: true, logs });
  } catch (err) {
    console.error('[Automations] logs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const automations = await automationStorage.list({ workspaceId: workspaceOf(req) });
    res.json({ success: true, automations });
  } catch (err) {
    console.error('[Automations] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, description, enabled, triggerType, triggerConfig, conditions, actions, color } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ error: 'actions array is required' });
    }
    const created = await automationStorage.create({
      name: String(name).trim(),
      description: description || '',
      enabled: !!enabled,
      triggerType: triggerType || 'manual',
      triggerConfig: triggerConfig || {},
      conditions: conditions || [],
      actions,
      color,
    }, { workspaceId: workspaceOf(req) });
    res.status(201).json({ success: true, automation: created });
  } catch (err) {
    console.error('[Automations] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const automation = await automationStorage.getById(req.params.id, { workspaceId: workspaceOf(req) });
    if (!automation) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, automation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await automationStorage.update(req.params.id, req.body || {}, { workspaceId: workspaceOf(req) });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, automation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const ok = await automationStorage.remove(req.params.id, { workspaceId: workspaceOf(req) });
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/enable', async (req, res) => {
  try {
    const updated = await automationStorage.update(req.params.id, { enabled: true }, { workspaceId: workspaceOf(req) });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, automation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/disable', async (req, res) => {
  try {
    const updated = await automationStorage.update(req.params.id, { enabled: false }, { workspaceId: workspaceOf(req) });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, automation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const workspaceId = workspaceOf(req);
    const context = {
      ...(req.body || {}),
      workspaceId,
      userId: (req.auth && req.auth.userId) || workspaceId,
      triggerType: 'manual',
    };
    const run = await runAutomation(req.params.id, context, { workspaceId });
    res.json({ success: true, run });
  } catch (err) {
    console.error('[Automations] run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
