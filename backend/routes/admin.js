/**
 * Super Admin API — Owner only (/api/admin/*).
 * Mounted behind requireEmailVerified + requireSuperAdmin.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();

const userStorage = require('../utils/userStorage');
const adminAudit = require('../utils/adminAudit');
const adminMetrics = require('../services/adminMetrics');
const openAiKeyService = require('../services/openAiKeyService');
const { query } = require('../config/db');

function clientMeta(req) {
  return {
    ip: req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

async function audit(req, action, targetType, targetId, details) {
  const meta = clientMeta(req);
  await adminAudit.recordAudit({
    actorId: req.auth?.userId,
    actorEmail: req.auth?.email,
    action,
    targetType,
    targetId,
    details,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// Ensure schema on first hit (non-blocking)
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  if (userStorage.resolveDriver() !== 'postgres') {
    schemaReady = true;
    return;
  }
  try {
    await userStorage.ensureAdminUserColumns();
    for (const file of ['super_admin.sql', 'owner_intelligence.sql']) {
      const sqlPath = path.join(__dirname, '..', 'db', file);
      if (!fs.existsSync(sqlPath)) continue;
      const sql = fs.readFileSync(sqlPath, 'utf8');
      const parts = sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('--'));
      for (const stmt of parts) {
        try { await query(stmt); } catch (err) {
          if (!/already exists|duplicate/i.test(err.message)) {
            console.warn('[Admin] schema stmt:', err.message);
          }
        }
      }
    }
    schemaReady = true;
  } catch (err) {
    console.warn('[Admin] ensureSchema:', err.message);
    schemaReady = true;
  }
}

router.use(async (req, res, next) => {
  await ensureSchema();
  next();
});

/* ---------- Overview / metrics ---------- */

router.get('/overview', async (req, res) => {
  try {
    const aiUsageTracker = require('../services/aiUsageTracker');
    const ownerIntelligence = require('../services/ownerIntelligence');
    const [business, revenue, leads, channels, legacyAi, ownerAi, health, expiry, activity, patterns, successFeed, campaigns, wins] = await Promise.all([
      adminMetrics.getBusinessOverview(),
      adminMetrics.getRevenueAnalytics(),
      adminMetrics.getLeadAnalytics(),
      adminMetrics.getChannelAnalytics(),
      adminMetrics.getAiUsage(),
      aiUsageTracker.getOwnerUsageSummary(),
      adminMetrics.getSystemHealth(),
      adminMetrics.getExpiryMonitoring(),
      adminMetrics.getLiveActivity(30),
      ownerIntelligence.getPatternInsights().catch(() => null),
      ownerIntelligence.getSuccessFeed(12).catch(() => []),
      adminMetrics.getCampaignRunMetrics().catch(() => null),
      adminMetrics.getIntelligenceWinMetrics().catch(() => null),
    ]);
    const ai = {
      ...legacyAi,
      ...ownerAi,
      remainingCredits: ownerAi.estimatedRemainingRequests,
      freeMessageCreditsLegacy: legacyAi.remainingCredits,
    };
    const executive = adminMetrics.buildExecutivePayload({
      business,
      revenue,
      leads,
      channels,
      ai,
      health,
      campaigns,
      wins,
    });
    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      business,
      revenue,
      leads,
      channels,
      ai,
      health,
      expiry,
      activity,
      patterns,
      successFeed,
      executive,
    });
  } catch (err) {
    console.error('[Admin] overview:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/metrics/business', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getBusinessOverview()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/metrics/revenue', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getRevenueAnalytics()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/metrics/executive', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getExecutiveDashboard()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/metrics/leads', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getLeadAnalytics()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/metrics/channels', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getChannelAnalytics()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/metrics/ai', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getAiUsage()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- Subscribers ---------- */

router.get('/users', async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase().trim();
    const status = String(req.query.status || '').toLowerCase();
    let users = await userStorage.listUsers();
    if (q) {
      users = users.filter((u) =>
        (u.email || '').toLowerCase().includes(q)
        || (u.full_name || '').toLowerCase().includes(q)
        || (u.business_name || '').toLowerCase().includes(q)
        || (u.id || '').toLowerCase().includes(q));
    }
    if (status) {
      users = users.filter((u) => String(u.subscription_status || '').toLowerCase() === status
        || String(u.account_status || '').toLowerCase() === status);
    }
    res.json({
      success: true,
      count: users.length,
      users: users.map((u) => userStorage.toPublicUser(u)),
    });
  } catch (err) {
    console.error('[Admin] users list:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/users/:id', async (req, res) => {
  try {
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, user: userStorage.toPublicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/suspend', async (req, res) => {
  try {
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'super_admin') return res.status(400).json({ error: 'Cannot suspend Super Admin' });
    await userStorage.updateUser(user.id, {
      accountStatus: 'suspended',
      suspendedAt: new Date().toISOString(),
      suspendedReason: req.body?.reason || 'Suspended by owner',
    });
    await audit(req, 'user.suspend', 'user', user.id, { reason: req.body?.reason });
    res.json({ success: true, user: userStorage.toPublicUser(await userStorage.findById(user.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/activate', async (req, res) => {
  try {
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await userStorage.updateUser(user.id, {
      accountStatus: 'active',
      suspendedAt: null,
      suspendedReason: null,
    });
    await audit(req, 'user.activate', 'user', user.id, {});
    res.json({ success: true, user: userStorage.toPublicUser(await userStorage.findById(user.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'super_admin' || user.id === req.auth.userId) {
      return res.status(400).json({ error: 'Cannot delete Super Admin / self' });
    }
    await userStorage.deleteUser(user.id);
    await audit(req, 'user.delete', 'user', user.id, { email: user.email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/extend', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.body?.days || '30', 10));
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const current = user.subscription_expires_at ? new Date(user.subscription_expires_at) : new Date();
    const base = current > new Date() ? current : new Date();
    base.setDate(base.getDate() + days);
    await userStorage.setSubscription(user.id, {
      subscription_status: 'active',
      subscription_expires_at: base.toISOString(),
      subscription_plan: req.body?.plan || user.subscription_plan || 'starter',
    });
    await audit(req, 'subscription.extend', 'user', user.id, { days, expiresAt: base.toISOString() });
    res.json({ success: true, user: userStorage.toPublicUser(await userStorage.findById(user.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/reset-ai-quota', async (req, res) => {
  try {
    const amount = parseInt(req.body?.amount || String(openAiKeyService.FREE_AI_MESSAGES || 100), 10);
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await userStorage.resetFreeAiMessages(user.id, amount);
    await audit(req, 'ai.quota_reset', 'user', user.id, { amount });
    res.json({
      success: true,
      freeAiMessagesRemaining: await userStorage.getFreeAiMessages(user.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const passwordHash = await bcrypt.hash(String(newPassword), 12);
    await userStorage.updateUser(user.id, { passwordHash });
    await audit(req, 'user.reset_password', 'user', user.id, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const user = await userStorage.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const body = req.body || {};
    const profile = {};
    if (body.fullName != null) profile.fullName = body.fullName;
    if (body.businessName != null) profile.businessName = body.businessName;
    if (body.whatsappNumber != null) profile.whatsappNumber = body.whatsappNumber;
    if (body.role != null && body.role !== 'super_admin') profile.role = body.role;
    if (Object.keys(profile).length) await userStorage.updateUser(user.id, profile);

    const sub = {};
    if (body.subscriptionStatus != null) sub.subscription_status = body.subscriptionStatus;
    if (body.subscriptionPlan != null) sub.subscription_plan = body.subscriptionPlan;
    if (body.subscriptionExpiresAt != null) sub.subscription_expires_at = body.subscriptionExpiresAt;
    if (Object.keys(sub).length) await userStorage.setSubscription(user.id, sub);

    await audit(req, 'user.update', 'user', user.id, body);
    res.json({ success: true, user: userStorage.toPublicUser(await userStorage.findById(user.id)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Health / expiry / notifications ---------- */

router.get('/health', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getSystemHealth()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/expiry', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getExpiryMonitoring()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/expiry', async (req, res) => {
  try {
    const item = await adminAudit.upsertExpiryItem(req.body || {});
    await audit(req, 'expiry.upsert', 'expiry', item.id, item);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/expiry/:id', async (req, res) => {
  try {
    await adminAudit.deleteExpiryItem(req.params.id);
    await audit(req, 'expiry.delete', 'expiry', req.params.id, {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const stored = await adminAudit.listNotifications({ limit: 80 });
    const live = await adminMetrics.buildNotificationsFromState();
    res.json({ success: true, notifications: stored, liveAlerts: live });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/refresh', async (req, res) => {
  try {
    const live = await adminMetrics.buildNotificationsFromState();
    for (const n of live.slice(0, 20)) {
      await adminAudit.pushNotification(n);
    }
    await audit(req, 'notifications.refresh', 'system', null, { count: live.length });
    res.json({ success: true, pushed: live.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/:id/ack', async (req, res) => {
  try {
    await adminAudit.acknowledgeNotification(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Activity / logs ---------- */

router.get('/activity', async (req, res) => {
  try { res.json({ success: true, ...(await adminMetrics.getLiveActivity(100)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/audit', async (req, res) => {
  try {
    const logs = await adminAudit.listAudit(parseInt(req.query.limit || '100', 10));
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/errors', async (req, res) => {
  try {
    const logs = await adminAudit.listErrorLogs(parseInt(req.query.limit || '100', 10));
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth-events', async (req, res) => {
  try {
    const events = await adminAudit.listAuthEvents(parseInt(req.query.limit || '100', 10));
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments', async (req, res) => {
  try {
    const events = await adminAudit.listPaymentEvents(parseInt(req.query.limit || '100', 10));
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Backup & maintenance ---------- */

router.get('/settings', async (req, res) => {
  try {
    const maintenance = await adminAudit.getSetting('maintenance_mode', { enabled: false });
    const security = await adminAudit.getSetting('security', {
      adminSessionTimeoutMinutes: 60,
      twoFactorEnabled: false,
      failedLoginAlertThreshold: 5,
    });
    res.json({ success: true, maintenance, security });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/security', async (req, res) => {
  try {
    const current = await adminAudit.getSetting('security', {});
    const next = { ...current, ...(req.body || {}) };
    await adminAudit.setSetting('security', next);
    await audit(req, 'settings.security', 'settings', 'security', next);
    res.json({ success: true, security: next });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/maintenance', async (req, res) => {
  try {
    const enabled = !!req.body?.enabled;
    const value = { enabled, message: req.body?.message || 'System maintenance in progress', updatedAt: new Date().toISOString() };
    await adminAudit.setSetting('maintenance_mode', value);
    await audit(req, enabled ? 'maintenance.on' : 'maintenance.off', 'system', null, value);
    res.json({ success: true, maintenance: value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cache/clear', async (req, res) => {
  try {
    const cleared = { jwksEntriesCleared: 0, sessionHints: [] };
    try {
      const auth = require('../middleware/auth');
      if (typeof auth.clearAuthCaches === 'function') {
        Object.assign(cleared, auth.clearAuthCaches());
      }
    } catch (_) { /* ignore */ }

    // Clear in-memory rate-limit / provider caches if present
    try {
      const security = require('../middleware/security');
      if (typeof security.clearRateLimitStores === 'function') {
        cleared.rateLimit = security.clearRateLimitStores();
      }
    } catch (_) { /* ignore */ }

    await audit(req, 'cache.clear', 'system', null, cleared);
    res.json({
      success: true,
      message: 'Caches cleared',
      cleared,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/queue/restart', async (req, res) => {
  try {
    const followUp = require('../services/followUpWorker');
    const automation = require('../services/automationScheduler');
    followUp.stopFollowUpWorker();
    if (typeof automation.stopAutomationScheduler === 'function') {
      automation.stopAutomationScheduler();
    }
    followUp.startFollowUpWorker();
    automation.startAutomationScheduler();

    await audit(req, 'queue.restart', 'system', null, {
      workers: ['followUpWorker', 'automationScheduler'],
      restartedAt: new Date().toISOString(),
    });
    await adminAudit.pushNotification({
      severity: 'info',
      category: 'ops',
      title: 'Background workers restarted',
      body: 'Follow-up worker and automation scheduler were stopped and started again.',
      source: 'admin',
    });
    res.json({
      success: true,
      message: 'Workers restarted: followUpWorker, automationScheduler',
      workers: ['followUpWorker', 'automationScheduler'],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup', async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(backupDir, `leadflow-backup-${stamp}.json`);

    let campaigns = [];
    let leads = [];
    try {
      if (userStorage.resolveDriver() === 'postgres') {
        const c = await query('SELECT * FROM campaigns ORDER BY updated_at DESC NULLS LAST LIMIT 5000');
        campaigns = c.rows;
        const l = await query('SELECT * FROM leads ORDER BY created_at DESC NULLS LAST LIMIT 5000');
        leads = l.rows;
      }
    } catch (err) {
      console.warn('[Admin] backup CRM snapshot:', err.message);
    }

    const payload = {
      version: 2,
      createdAt: new Date().toISOString(),
      scope: ['users', 'payments', 'expiry', 'settings', 'audit', 'notifications', 'campaigns', 'leads'],
      users: (await userStorage.listUsers()).map((u) => userStorage.toPublicUser(u)),
      payments: await adminAudit.listPaymentEvents(2000),
      expiry: await adminAudit.listExpiryItems(),
      settings: {
        maintenance_mode: await adminAudit.getSetting('maintenance_mode', { enabled: false }),
        security: await adminAudit.getSetting('security', {}),
      },
      notifications: await adminAudit.listNotifications({ limit: 200 }),
      audit: await adminAudit.listAudit(500),
      campaigns,
      leads,
    };

    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl && req.body?.pgDump) {
      const sqlFile = path.join(backupDir, `leadflow-${stamp}.sql`);
      await new Promise((resolve) => {
        exec(`pg_dump "${dbUrl}" > "${sqlFile}"`, { shell: true }, (err) => {
          if (err) console.warn('[Admin] pg_dump failed:', err.message);
          resolve();
        });
      });
      payload.pgDumpFile = path.basename(sqlFile);
    }

    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
    await audit(req, 'backup.create', 'system', null, {
      file: outFile,
      counts: {
        users: payload.users.length,
        payments: payload.payments.length,
        expiry: payload.expiry.length,
        campaigns: campaigns.length,
        leads: leads.length,
      },
    });
    res.json({
      success: true,
      file: path.basename(outFile),
      path: outFile,
      counts: {
        users: payload.users.length,
        payments: payload.payments.length,
        expiry: payload.expiry.length,
        campaigns: campaigns.length,
        leads: leads.length,
      },
    });
  } catch (err) {
    console.error('[Admin] backup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backups', async (req, res) => {
  try {
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) return res.json({ success: true, backups: [] });
    const backups = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('leadflow-'))
      .map((f) => {
        const st = fs.statSync(path.join(backupDir, f));
        return { file: f, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup/restore', async (req, res) => {
  try {
    const { file, mode } = req.body || {};
    if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
      return res.status(400).json({ error: 'Invalid backup file name' });
    }
    const full = path.join(__dirname, '..', 'backups', file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Backup not found' });
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));

    // Default safe restore: expiry + settings (never wipe users)
    // Optional mode=extended also re-imports payment events that are missing by id
    const restoreMode = mode === 'extended' ? 'extended' : 'safe';
    const restored = {
      expiry: 0,
      settings: 0,
      payments: 0,
      notifications: 0,
      usersSkipped: Array.isArray(data.users) ? data.users.length : 0,
      campaignsSkipped: Array.isArray(data.campaigns) ? data.campaigns.length : 0,
      leadsSkipped: Array.isArray(data.leads) ? data.leads.length : 0,
      mode: restoreMode,
      note: 'Users/campaigns/leads are NOT overwritten (destructive restore disabled).',
    };

    if (Array.isArray(data.expiry)) {
      for (const item of data.expiry) {
        await adminAudit.upsertExpiryItem(item);
        restored.expiry += 1;
      }
    }
    if (data.settings?.maintenance_mode) {
      await adminAudit.setSetting('maintenance_mode', data.settings.maintenance_mode);
      restored.settings += 1;
    }
    if (data.settings?.security) {
      await adminAudit.setSetting('security', data.settings.security);
      restored.settings += 1;
    }

    if (restoreMode === 'extended' && Array.isArray(data.payments)) {
      for (const p of data.payments) {
        try {
          await adminAudit.recordPaymentEvent({
            id: p.id,
            userId: p.user_id || p.userId,
            email: p.email,
            provider: p.provider,
            eventType: p.event_type || p.eventType,
            planKey: p.plan_key || p.planKey,
            amount: p.amount,
            currency: p.currency,
            status: p.status,
            externalId: p.external_id || p.externalId,
            raw: p.raw || {},
          });
          restored.payments += 1;
        } catch (_) { /* skip duplicates */ }
      }
    }

    await audit(req, 'backup.restore', 'system', null, { file, restored });
    res.json({
      success: true,
      message: `Safe restore applied: ${restored.expiry} expiry item(s), ${restored.settings} setting(s)`
        + (restoreMode === 'extended' ? `, ${restored.payments} payment event(s)` : '')
        + `. Users/campaigns/leads were not overwritten.`,
      restored,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/errors/test', async (req, res) => {
  try {
    const { logAdminError } = require('../utils/errorLogger');
    const row = await adminAudit.recordErrorLog({
      level: 'error',
      source: 'admin.test',
      message: req.body?.message || 'Owner Console test error — verification probe',
      meta: { triggeredBy: req.auth?.email, at: new Date().toISOString() },
    });
    await logAdminError('Companion log via logAdminError helper', {
      level: 'warn',
      source: 'admin.test',
      meta: { companion: true },
    });
    await audit(req, 'errors.test', 'system', null, { id: row.id });
    res.json({ success: true, error: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- OpenAI Owner Usage ---------- */

router.get('/openai-usage', async (req, res) => {
  try {
    const aiUsageTracker = require('../services/aiUsageTracker');
    const summary = await aiUsageTracker.getOwnerUsageSummary();
    res.json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Owner Intelligence ---------- */

router.get('/intelligence', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const filters = {
      q: req.query.q,
      industry: req.query.industry,
      country: req.query.country,
      workspace: req.query.workspace,
      channel: req.query.channel,
      status: req.query.status,
      pinned: req.query.pinned,
      showArchived: req.query.showArchived,
      showIgnored: req.query.showIgnored,
      showTest: req.query.showTest,
      minRevenue: req.query.minRevenue,
      minConversion: req.query.minConversion,
      minScore: req.query.minScore,
      minReplyRate: req.query.minReplyRate,
      minAppointments: req.query.minAppointments,
      minLeadQuality: req.query.minLeadQuality,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize || req.query.limit,
    };
    const [queried, patterns, feed] = await Promise.all([
      ownerIntelligence.queryIntelligence(filters),
      ownerIntelligence.getPatternInsights(),
      ownerIntelligence.getSuccessFeed(30),
    ]);
    res.json({
      success: true,
      events: queried.events,
      library: queried.library,
      patterns,
      feed,
      total: queried.total,
      page: queried.page,
      pageSize: queried.pageSize,
      totalPages: queried.totalPages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/scan', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const result = await ownerIntelligence.scanAndNotify();
    await audit(req, 'intelligence.scan', 'system', null, result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Admin] intelligence scan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/campaign/:id', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const detail = await ownerIntelligence.getCampaignIntelligence(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Success event not found' });
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/events/bulk', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const action = String(req.body?.action || '').toLowerCase();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const allowed = ['pin', 'unpin', 'archive', 'unarchive', 'ignore', 'unignore', 'delete'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Invalid action' });
    if (action === 'delete' && !req.body?.confirm) {
      return res.status(400).json({ error: 'Delete requires confirm: true' });
    }
    const result = await ownerIntelligence.bulkUpdateSuccessLifecycle(ids, action);
    await audit(req, `intelligence.events_bulk_${action}`, 'success_event', null, {
      action, count: result.count,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/events/:id/:action', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const action = String(req.params.action || '').toLowerCase();
    const allowed = ['pin', 'unpin', 'archive', 'unarchive', 'ignore', 'unignore', 'delete'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Invalid action' });
    if (action === 'delete' && !req.body?.confirm) {
      return res.status(400).json({ error: 'Delete requires confirm: true' });
    }
    const result = await ownerIntelligence.updateSuccessLifecycle(req.params.id, action);
    await audit(req, `intelligence.event_${action}`, 'success_event', req.params.id, { action });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/library', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const result = await ownerIntelligence.listCampaignLibrary({
      q: req.query.q,
      industry: req.query.industry,
      country: req.query.country,
      channel: req.query.channel,
      workspace: req.query.workspace,
      showArchived: String(req.query.showArchived || '') === 'true',
      showIgnored: String(req.query.showIgnored || '') === 'true',
      showTest: req.query.showTest == null ? true : String(req.query.showTest) !== 'false',
      pinnedOnly: String(req.query.pinned || '') === 'true',
      minRevenue: req.query.minRevenue,
      minConversion: req.query.minConversion,
      minScore: req.query.minScore,
      sort: req.query.sort,
      limit: req.query.limit || req.query.pageSize,
      offset: req.query.offset || ((Number(req.query.page) || 1) - 1) * (Number(req.query.pageSize) || 50),
    });
    res.json({ success: true, library: result.items || result, total: result.total || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/library/:id', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const item = await ownerIntelligence.getLibraryItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Library item not found' });
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/library/:id/duplicate', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const item = await ownerIntelligence.duplicateLibraryItem(req.params.id, {
      name: req.body?.name,
      adaptNotes: req.body?.adaptNotes,
    });
    if (!item) return res.status(404).json({ error: 'Library item not found' });
    await audit(req, 'intelligence.library_duplicate', 'campaign_library', item.id, {
      from: req.params.id,
    });
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/library/:id/launch-draft', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const draft = await ownerIntelligence.createLaunchDraft({
      libraryId: req.params.id,
      channel: req.body?.channel,
      targetWorkspaceId: req.body?.targetWorkspaceId,
      name: req.body?.name,
      subject: req.body?.subject,
      body: req.body?.body,
      settings: req.body?.settings,
    });
    await audit(req, 'intelligence.launch_draft_create', 'launch_draft', draft.id, {
      libraryId: req.params.id,
    });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/library/bulk', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const action = String(req.body?.action || '').toLowerCase();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const allowed = ['pin', 'unpin', 'archive', 'unarchive', 'ignore', 'unignore', 'delete'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Invalid action' });
    if (action === 'delete' && !req.body?.confirm) {
      return res.status(400).json({ error: 'Delete requires confirm: true' });
    }
    const result = await ownerIntelligence.bulkUpdateLibraryLifecycle(ids, action);
    await audit(req, `intelligence.library_bulk_${action}`, 'campaign_library', null, {
      action, count: result.count,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/library/:id/:action', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const action = String(req.params.action || '').toLowerCase();
    const allowed = ['pin', 'unpin', 'archive', 'unarchive', 'ignore', 'unignore', 'delete'];
    if (!allowed.includes(action)) return res.status(400).json({ error: 'Invalid action' });
    if (action === 'delete' && !req.body?.confirm) {
      return res.status(400).json({ error: 'Delete requires confirm: true' });
    }
    const result = await ownerIntelligence.updateLibraryLifecycle(req.params.id, action);
    await audit(req, `intelligence.library_${action}`, 'campaign_library', req.params.id, { action });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/launch-draft/:id', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const draft = await ownerIntelligence.getLaunchDraft(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Launch draft not found' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/intelligence/launch-draft/:id', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const draft = await ownerIntelligence.updateLaunchDraft(req.params.id, req.body || {});
    if (!draft) return res.status(404).json({ error: 'Launch draft not found' });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/launch-draft/:id/launch', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const draft = await ownerIntelligence.launchDraft(req.params.id);
    await audit(req, 'intelligence.launch', 'launch_draft', req.params.id, {
      workspace: draft.target_workspace_id,
      channel: draft.channel,
    });
    res.json({ success: true, draft });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/workspaces', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const workspaces = await ownerIntelligence.listWorkspacesForLaunch();
    res.json({ success: true, workspaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/test-data/delete', async (req, res) => {
  try {
    if (!req.body?.confirm) {
      return res.status(400).json({ error: 'Delete test data requires confirm: true' });
    }
    const ownerIntelligence = require('../services/ownerIntelligence');
    const result = await ownerIntelligence.deleteTestIntelligence();
    await audit(req, 'intelligence.delete_test_data', 'system', null, result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/facets', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const facets = await ownerIntelligence.getIntelligenceFacets();
    res.json({ success: true, ...facets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/intelligence/scores/recompute', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const result = await ownerIntelligence.recomputeScores({
      limit: req.body?.limit,
    });
    await audit(req, 'intelligence.scores_recompute', 'system', null, result);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/launch-drafts', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const drafts = await ownerIntelligence.listLaunchDrafts({
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json({ success: true, drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/intelligence/launch-draft/:id/outcomes', async (req, res) => {
  try {
    const ownerIntelligence = require('../services/ownerIntelligence');
    const outcomes = await ownerIntelligence.getLaunchDraftOutcomes(req.params.id);
    if (!outcomes) return res.status(404).json({ error: 'Launch draft not found' });
    res.json({ success: true, ...outcomes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------- Production user cleanup ---------- */

router.post('/users/cleanup-non-owner', async (req, res) => {
  try {
    const ownerEmail = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com')
      .split(',')[0].trim().toLowerCase();
    const users = await userStorage.listUsers();
    const keep = users.filter((u) => (u.email || '').toLowerCase() === ownerEmail);
    const remove = users.filter((u) => (u.email || '').toLowerCase() !== ownerEmail);
    if (!keep.length) {
      return res.status(400).json({ error: 'Owner account not found — aborting cleanup' });
    }
    if (!req.body?.confirm) {
      return res.json({
        success: true,
        dryRun: true,
        ownerEmail,
        willKeep: keep.map((u) => u.email),
        willRemove: remove.map((u) => ({ id: u.id, email: u.email, name: u.full_name })),
        message: 'Pass { "confirm": true } to execute.',
      });
    }

    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(backupDir, `users-pre-cleanup-${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ kept: keep, removed: remove, at: new Date().toISOString() }, null, 2));

    for (const u of remove) {
      await userStorage.deleteUser(u.id);
    }
    await audit(req, 'users.cleanup_non_owner', 'system', null, {
      removed: remove.length,
      backupFile: path.basename(backupFile),
    });
    res.json({
      success: true,
      dryRun: false,
      removed: remove.length,
      remaining: (await userStorage.listUsers()).map((u) => u.email),
      backup: path.basename(backupFile),
    });
  } catch (err) {
    console.error('[Admin] cleanup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
