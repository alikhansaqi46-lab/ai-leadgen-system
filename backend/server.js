const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

// Fail closed on insecure production configuration (AUTH_MODE, secrets, TLS).
const {
  assertProductionConfig,
  createHelmetMiddleware,
  apiLimiter,
  authLimiter,
  sendLimiter,
  webhookLimiter,
  isProduction,
} = require('./middleware/security');
assertProductionConfig();

// Foundation Hardening imports
const { sendEmailToLead, isEmailConfigured } = require('./services/emailService');
const unifiedSend = require('./services/unifiedSend');
const leadStorage = require('./utils/leadStorage');
const contactStorage = require('./utils/contactStorage');

const app = express();
const PORT = process.env.PORT || 5001;

// Trust proxy when behind nginx/load balancer (correct req.ip for rate limits)
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security headers (Helmet-equivalent)
app.use(createHelmetMiddleware());

// Middleware
// CORS allow-list is environment-driven. Set ALLOWED_ORIGINS to a comma-separated
// list of origins (e.g. "https://app.example.com,https://staging.example.com").
// FRONTEND_URL is kept as a single-origin fallback for backwards compatibility.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Capture raw body for Meta WhatsApp signature verification on webhook POSTs.
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    const url = req.originalUrl || req.url || '';
    if (url.includes('/api/whatsapp/webhook')) {
      req.rawBody = Buffer.from(buf);
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Maintenance mode — block non–Super-Admin API traffic when enabled
app.use(async (req, res, next) => {
  try {
    if (req.path === '/health') return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/admin')) return next();
    if (req.path === '/api/auth/login' || req.path === '/api/auth/me') return next();

    const adminAudit = require('./utils/adminAudit');
    const maint = await adminAudit.getSetting('maintenance_mode', { enabled: false });
    if (!maint?.enabled) return next();

    const header = req.headers.authorization || req.headers.Authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (token) {
      try {
        const authService = require('./services/authService');
        const user = await authService.getUserByToken(token);
        if (user && (user.role === 'super_admin' || authService.isSuperAdminEmail(user.email))) {
          return next();
        }
      } catch (_) { /* fall through */ }
    }

    return res.status(503).json({
      error: 'Maintenance',
      message: maint.message || 'System maintenance in progress',
      maintenance: true,
    });
  } catch (_) {
    return next();
  }
});

// Global API rate limit
app.use('/api', apiLimiter);

// Authentication & workspace resolution (S2).
// AUTH_MODE=disabled (default) is a no-op that sets req.auth to the default workspace,
// preserving pre-S2 behavior. supabase/dev modes require a valid Bearer token.
const { requireAuth, requireEmailVerified } = require('./middleware/auth');
const { requireSubscription } = require('./middleware/subscription');

// The WhatsApp webhook must stay UNAUTHENTICATED (Meta optional mode).
function whatsappAuthGate(req, res, next) {
  if (req.path === '/webhook') return next();
  return requireAuth(req, res, next);
}

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Auth routes (S7) — mounted at /api/auth, no global requireAuth (individual endpoints enforce)
try {
  app.use('/api/auth', authLimiter, require('./routes/auth'));
  console.log('✅ Auth routes mounted at /api/auth');
} catch (err) {
  console.error('❌ Failed to load auth routes:', err);
}

// Routes with error logging
try {
  app.use('/api/leads', requireEmailVerified, require('./routes/leads'));
  console.log('✅ leads routes loaded');
} catch (err) {
  console.error('❌ Failed to load leads routes:', err);
}

// Universal Contact Manager routes — normalized contact methods, tags, notes, custom fields.
try {
  app.use('/api/contacts', requireEmailVerified, require('./routes/contacts'));
  console.log('✅ contacts routes loaded');
} catch (err) {
  console.error('❌ Failed to load contacts routes:', err);
}

// Scrape routes — mounted at /api/scrape
// MUST be before static files and catch-all
try {
  app.use('/api/scrape', requireEmailVerified, requireSubscription, sendLimiter, require('./routes/scrape'));
  console.log('✅ scrape routes mounted at /api/scrape');
} catch (err) {
  console.error('❌ Failed to load scrape routes:', err);
}

// AI Sales Agent routes (S5) — qualification, outreach, inbox
try {
  app.use('/api/ai', requireEmailVerified, requireSubscription, (req, res, next) => {
    if (req.method === 'POST' && /send|auto-reply|autonomous/i.test(req.path)) {
      return sendLimiter(req, res, next);
    }
    return next();
  }, require('./routes/ai'));
  console.log('✅ AI routes mounted at /api/ai');
} catch (err) {
  console.error('❌ Failed to load AI routes:', err);
}

// WhatsApp routes — Official Meta WhatsApp Cloud API only
// whatsappAuthGate already bypasses /webhook; also bypass subscription for webhook + status reads.
function whatsAppSubGate(req, res, next) {
  if (req.path === '/webhook') return next();
  // Allow status/credentials reads without subscription so users can configure WhatsApp before upgrade.
  const openGet = ['/status', '/credentials', '/diagnostics', '/business-info', '/workspace', '/stats', '/logs', '/campaign-control'];
  const openPost = ['/credentials', '/validate', '/test-connection'];
  if (req.method === 'GET' && openGet.includes(req.path)) return next();
  if (req.method === 'POST' && openPost.includes(req.path)) return next();
  return requireSubscription(req, res, next);
}
try {
  const { verifyWhatsAppSignature } = require('./middleware/whatsappWebhook');
  app.use('/api/whatsapp', whatsappAuthGate, whatsAppSubGate, (req, res, next) => {
    if (req.path === '/webhook') return webhookLimiter(req, res, () => verifyWhatsAppSignature(req, res, next));
    if (req.method === 'POST' && (req.path === '/send' || req.path === '/send-bulk')) {
      return sendLimiter(req, res, next);
    }
    return next();
  }, require('./routes/whatsapp'));
  console.log('✅ WhatsApp routes loaded (Meta Cloud API)');
} catch (err) {
  console.error('❌ Failed to load WhatsApp routes:', err);
}

// WhatsApp CRM Campaign routes (S6)
// Start Campaign + bulk sends require subscription; read stats remain open to verified users.
function campaignSubGate(req, res, next) {
  const paidPaths = ['/start', '/bulk-send', '/send', '/send-bulk'];
  if (req.method === 'POST' && paidPaths.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
    return requireSubscription(req, res, next);
  }
  return next();
}
try {
  app.use('/api/campaign', requireEmailVerified, campaignSubGate, require('./routes/campaign'));
  console.log('✅ Campaign CRM routes mounted at /api/campaign');
} catch (err) {
  console.error('❌ Failed to load campaign routes:', err);
}

// Email outreach routes (S4.3) — status, single + bulk send
// Tracking pixels + click redirects must stay PUBLIC (email clients have no JWT).
function emailAuthGate(req, res, next) {
  if (req.method === 'GET' && (req.path === '/tracking/open' || req.path === '/tracking/click')) {
    return next();
  }
  // Inbound receive webhook: require WEBHOOK_SECRET / EMAIL_WEBHOOK_SECRET header.
  // Never leave this open without a shared secret (even in development).
  if (req.method === 'POST' && req.path === '/receive') {
    const crypto = require('crypto');
    const secret = process.env.WEBHOOK_SECRET || process.env.EMAIL_WEBHOOK_SECRET;
    const provided = req.headers['x-webhook-secret'];
    if (secret && provided) {
      const a = Buffer.from(String(provided));
      const b = Buffer.from(String(secret));
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    }
    if (!secret) {
      console.warn('[Email] /receive rejected: WEBHOOK_SECRET or EMAIL_WEBHOOK_SECRET not configured');
    }
    return res.status(401).json({ error: 'Unauthorized webhook' });
  }
  return requireEmailVerified(req, res, next);
}
function emailSubGate(req, res, next) {
  if (req.method === 'GET' && (req.path === '/status' || req.path === '/tracking/open' || req.path === '/tracking/click')) {
    return next();
  }
  if (req.method === 'POST' && (req.path === '/receive' || req.path === '/sync')) return next();
  return requireSubscription(req, res, next);
}
try {
  app.use('/api/email', emailAuthGate, emailSubGate, (req, res, next) => {
    if (req.method === 'POST' && (req.path === '/send' || req.path === '/send-bulk')) {
      return sendLimiter(req, res, next);
    }
    return next();
  }, require('./routes/email'));
  console.log('✅ Email routes mounted at /api/email');
} catch (err) {
  console.error('❌ Failed to load email routes:', err);
}

// Unified integration routes — credential storage, status, OAuth for all channels
// The OAuth callback route must be PUBLIC (Google redirects to it without a Bearer token).
// All other integration routes require auth + email verification.
function integrationsAuthGate(req, res, next) {
  if (req.path.match(/\/[^/]+\/oauth\/callback$/)) return next();
  return requireEmailVerified(req, res, next);
}
try {
  app.use('/api/integrations', integrationsAuthGate, require('./routes/integrations'));
  console.log('✅ Integration routes mounted at /api/integrations');
} catch (err) {
  console.error('❌ Failed to load integration routes:', err);
}

// SMS routes (Twilio) — webhook + status-callback must stay PUBLIC (Twilio has no JWT)
// but MUST verify X-Twilio-Signature in production.
const { verifyTwilioSignature } = require('./middleware/twilioWebhook');
function smsAuthGate(req, res, next) {
  if (req.path === '/webhook' || req.path === '/status-callback') return next();
  return requireEmailVerified(req, res, next);
}
function smsSubGate(req, res, next) {
  if (req.path === '/webhook' || req.path === '/status-callback') return next();
  return requireSubscription(req, res, next);
}
try {
  app.use('/api/sms', smsAuthGate, smsSubGate, (req, res, next) => {
    if (req.path === '/webhook' || req.path === '/status-callback') {
      return webhookLimiter(req, res, () => verifyTwilioSignature(req, res, next));
    }
    if (req.method === 'POST' && (req.path === '/send' || req.path === '/send-bulk')) {
      return sendLimiter(req, res, next);
    }
    return next();
  }, require('./routes/sms'));
  console.log('✅ SMS routes mounted at /api/sms');
} catch (err) {
  console.error('❌ Failed to load SMS routes:', err);
}

// PayPal subscription routes — webhook + public plan catalog stay PUBLIC
function paypalAuthGate(req, res, next) {
  if (req.path === '/webhook' || req.path === '/plans') return next();
  return requireAuth(req, res, next);
}
try {
  app.use('/api/paypal', paypalAuthGate, (req, res, next) => {
    if (req.path === '/webhook') return webhookLimiter(req, res, next);
    return next();
  }, require('./routes/paypal'));
  console.log('✅ PayPal routes mounted at /api/paypal');
} catch (err) {
  console.error('❌ Failed to load PayPal routes:', err);
}

// External webhook routes (Zapier / Make / Fiverr / Upwork)
// Intentionally PUBLIC — protected by WEBHOOK_SECRET header inside the route
try {
  app.use('/api/webhook', webhookLimiter, require('./routes/webhook'));
  console.log('✅ Webhook routes mounted at /api/webhook');
} catch (err) {
  console.error('❌ Failed to load webhook routes:', err);
}

// Channel Brain Configuration routes (per-channel independent AI brains)
try {
  app.use('/api/channel-brains', requireAuth, require('./routes/channelBrains'));
  console.log('✅ Channel Brain routes mounted at /api/channel-brains');
} catch (err) {
  console.error('❌ Failed to load channel brain routes:', err);
}

// Settings routes (Preview & Trust Mode)
try {
  app.use('/api/settings', requireAuth, require('./routes/settings'));
  console.log('✅ Settings routes mounted at /api/settings');
} catch (err) {
  console.error('❌ Failed to load settings routes:', err);
}

// Automation Engine (backend source of truth for workflows/runs/logs)
try {
  app.use('/api/automations', requireEmailVerified, require('./routes/automations'));
  console.log('✅ Automations routes mounted at /api/automations');
} catch (err) {
  console.error('❌ Failed to load Automations routes:', err);
}

// AI Quotes & Invoicing
try {
  app.use('/api/quotes', requireEmailVerified, require('./routes/quotes'));
  console.log('✅ Quotes routes mounted at /api/quotes');
} catch (err) {
  console.error('❌ Failed to load Quotes routes:', err);
}

try {
  app.use('/api/public/quotes', require('./routes/publicQuotes'));
  console.log('✅ Public quote share routes mounted at /api/public/quotes');
} catch (err) {
  console.error('❌ Failed to load public quote routes:', err);
}

// Enterprise Dashboard metrics (real KPIs only)
try {
  app.use('/api/dashboard', requireEmailVerified, require('./routes/dashboard'));
  console.log('✅ Dashboard routes mounted at /api/dashboard');

  app.use('/api/reports', requireEmailVerified, require('./routes/reports'));
  console.log('✅ Reports routes mounted at /api/reports');
} catch (err) {
  console.error('❌ Failed to load Dashboard/Reports routes:', err);
}

// OpenAI API Key Management routes
try {
  app.use('/api/openai', requireAuth, require('./routes/openai'));
  console.log('✅ OpenAI routes mounted at /api/openai');
} catch (err) {
  console.error('❌ Failed to load OpenAI routes:', err);
}

// Super Admin console (Owner only) — separate from workspace product APIs
try {
  const { requireSuperAdmin } = require('./middleware/admin');
  app.use('/api/admin', requireEmailVerified, requireSuperAdmin, require('./routes/admin'));
  console.log('✅ Super Admin routes mounted at /api/admin');
} catch (err) {
  console.error('❌ Failed to load Super Admin routes:', err);
}

// Scrape / email discovery live in routes/scrape.js + utils/emailExtractor.js (SSRF-guarded).
// Dead inline extractEmail/processBatch helpers were removed.

// ==================== EMAIL SENDING SYSTEM (Foundation Hardening) ====================
// Inline email endpoint now delegates to unifiedSend so email activity appears
// in the Inbox, CRM pipeline, and unified timeline.

app.post('/api/send-email', requireAuth, sendLimiter, async (req, res) => {
  try {
    const { lead, message, subject, campaign } = req.body;

    if (!lead || !lead.email) {
      return res.status(400).json({ error: 'Lead email is required' });
    }

    if (!isEmailConfigured()) {
      return res.status(503).json({
        error: 'Email not configured',
        message: 'Please connect your business email via OAuth in Settings.'
      });
    }

    const { workspaceOf } = require('./utils/workspaceContext');
    const workspaceId = workspaceOf(req);

    // Resolve leadId (frontend may not send it)
    let leadId = lead.id;
    if (!leadId) {
      const matched = await contactStorage.findLeadByContact({ workspaceId, channel: 'email', value: lead.email });
      if (matched) leadId = matched.id;
    }

    let result;
    if (leadId) {
      result = await unifiedSend.send({
        leadId,
        channel: 'email',
        body: message,
        subject,
        providerSend: async () => sendEmailToLead(lead, { message, subject, campaign }),
        metadata: { campaignName: campaign?.companyName },
        scheduleFollowUps: true,
        workspaceId,
      });
    } else {
      // Fallback if lead not found in workspace
      const r = await sendEmailToLead(lead, { message, subject, campaign });
      result = { success: true, messageId: r.messageId };
    }

    res.json({
      success: true,
      message: `Email sent to ${lead.email}`,
      messageId: result.messageId,
      conversationId: result.conversationId || null,
    });
  } catch (error) {
    console.error('❌ Email send failed:', error.message);
    res.status(500).json({
      error: 'Failed to send email',
      message: error.message
    });
  }
});

// ==================== WHATSAPP BUSINESS API ====================

// Legacy WhatsApp helpers — delegate to transport facade (Meta Cloud API)
const whatsappTransport = require('./services/whatsappTransport');

const isWhatsAppConfigured = (workspaceId = process.env.DEFAULT_WORKSPACE_ID || 'default') => (
  whatsappTransport.isConfigured(workspaceId)
);

console.log(
  `ℹ️ WhatsApp transport mode: ${whatsappTransport.DEFAULT_TRANSPORT} (Meta Cloud API — configure credentials in the WhatsApp module)`
);

const sendWhatsAppMessage = async (phone, message, testMode = false, workspaceId = process.env.DEFAULT_WORKSPACE_ID || 'default') => {
  if (testMode) {
    console.log(`🧪 TEST MODE: Would send to ${phone}:`, message.substring(0, 50) + '...');
    return {
      success: true,
      messageId: 'test-' + Date.now(),
      status: 'test',
      testMode: true,
    };
  }
  return whatsappTransport.sendText({ workspaceId, to: phone, message, testMode: false });
};

// WhatsApp sending endpoint (legacy) — requires auth; prefer /api/whatsapp/send
app.post('/api/send-whatsapp', requireAuth, sendLimiter, async (req, res) => {
  try {
    const { phone, message, testMode = false } = req.body;
    const workspaceId = req.auth?.workspaceId || process.env.DEFAULT_WORKSPACE_ID || 'default';

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (!isWhatsAppConfigured(workspaceId) && !testMode) {
      return res.status(503).json({
        error: 'WhatsApp not configured',
        message: 'Configure Meta Cloud API credentials in the WhatsApp module',
        provider: 'meta',
      });
    }

    const result = await sendWhatsAppMessage(phone, message, testMode, workspaceId);

    res.json({
      success: true,
      message: testMode ? 'Test: Message would be sent' : `WhatsApp message sent to ${phone}`,
      messageId: result.messageId,
      status: result.status,
      testMode: result.testMode || false,
    });
  } catch (error) {
    console.error('❌ WhatsApp send failed:', error.message);
    const notOnWhatsApp = error.message.includes('not on WhatsApp') || error.message.includes('not a valid');
    res.status(500).json({
      error: 'Failed to send WhatsApp message',
      message: error.message,
      notOnWhatsApp,
    });
  }
});

// Bulk WhatsApp status endpoint (for frontend polling) — auth required
app.get('/api/whatsapp-status', requireAuth, (req, res) => {
  const workspaceId = req.auth?.workspaceId || process.env.DEFAULT_WORKSPACE_ID || 'default';
  res.json({
    configured: isWhatsAppConfigured(workspaceId),
    provider: 'meta',
    testMode: process.env.WHATSAPP_TEST_MODE === 'true',
  });
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// =====================================================================
// Image Upload — used by CRM composers for campaign image attachments
// =====================================================================
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use('/uploads', express.static(UPLOADS_DIR, {
  index: false,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
  },
}));

const UPLOAD_ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']);
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 5 * 1024 * 1024); // 5MB default
const UPLOAD_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

app.post('/api/upload-image', requireEmailVerified, (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== 'string') {
      console.error('[Upload] rejected: missing or non-string image body');
      return res.status(400).json({ error: 'image base64 string is required' });
    }
    if (image.length > UPLOAD_MAX_BYTES * 1.4) {
      // base64 expands ~33%; reject oversized payloads early
      return res.status(413).json({ error: `Image too large (max ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB)` });
    }
    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      console.error('[Upload] rejected: invalid base64 format. Received prefix:', image.slice(0, 60));
      return res.status(400).json({ error: 'Invalid base64 image format. Expected data:image/png;base64,...' });
    }
    const mimeType = match[1].toLowerCase();
    if (!UPLOAD_ALLOWED_MIME.has(mimeType)) {
      return res.status(400).json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed' });
    }
    const base64Data = match[2].replace(/\s+/g, '');
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length || buffer.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: `Image too large (max ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB)` });
    }
    // Magic-byte sanity (reject obvious non-images)
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
    const isWebp = buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    const magicOk =
      (mimeType.includes('jpeg') || mimeType.includes('jpg') ? isJpeg : false)
      || (mimeType === 'image/png' ? isPng : false)
      || (mimeType === 'image/gif' ? isGif : false)
      || (mimeType === 'image/webp' ? isWebp : false);
    if (!magicOk) {
      return res.status(400).json({ error: 'File content does not match declared image type' });
    }

    const ext = UPLOAD_EXT[mimeType] || 'bin';
    const filename = `${uuidv4()}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }

    fs.writeFileSync(filePath, buffer);
    const baseUrl = process.env.API_BASE_URL || `http://localhost:${PORT}`;
    const url = `${baseUrl}/uploads/${filename}`;
    console.log('[Upload] success:', filename, mimeType, `${(buffer.length / 1024).toFixed(1)}KB`);
    res.json({ success: true, url, filename, mimeType });
  } catch (err) {
    console.error('[Upload] error:', err.message);
    const body = { error: 'Failed to upload image' };
    if (!isProduction()) body.message = err.message;
    res.status(500).json(body);
  }
});

// Debug endpoints — require auth; hidden in production
app.get('/api/debug/version', requireAuth, (req, res) => {
  if (isProduction()) return res.status(404).json({ error: 'Not found' });
  res.json({
    version: '2026-07-23-security-v2',
    features: ['helmet-lite', 'rate-limit', 'webhook-verify', 'twilio-sig', 'email-tracking-hmac', 'credential-encryption', 'upload-harden'],
  });
});

app.get('/api/debug/conversation/:id/messages', requireAuth, async (req, res) => {
  if (isProduction()) return res.status(404).json({ error: 'Not found' });
  try {
    const conversationStorage = require('./utils/conversationStorage');
    const workspaceId = (req.auth && req.auth.workspaceId) || (req.auth && req.auth.sub) || 'default';
    const messages = await conversationStorage.getMessages(req.params.id, { workspaceId });
    res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    console.error('[Debug] conversation messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/conversation/:id/raw', requireAuth, async (req, res) => {
  if (isProduction()) return res.status(404).json({ error: 'Not found' });
  try {
    const { query } = require('./config/db');
    const workspaceId = (req.auth && req.auth.workspaceId) || (req.auth && req.auth.sub) || 'default';
    const { rows } = await query(
      'SELECT id, conversation_id, direction, body, metadata, message_type, created_at FROM messages WHERE conversation_id = $1 AND workspace_id = $2 ORDER BY created_at ASC',
      [req.params.id, workspaceId]
    );
    res.json({ success: true, count: rows.length, messages: rows });
  } catch (err) {
    console.error('[Debug] raw conversation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve React frontend build (monorepo deployment)
const buildPath = path.join(__dirname, '../frontend/build');
app.use(express.static(buildPath));

// Catch-all: serve React's index.html for non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  // Always log full detail server-side for debugging.
  console.error('GLOBAL ERROR:', err);
  console.error('Stack:', err.stack);

  try {
    const { logAdminError } = require('./utils/errorLogger');
    logAdminError(err, {
      level: 'error',
      source: `http.${req.method}.${req.path}`,
      meta: {
        method: req.method,
        path: req.path,
        userId: req.auth?.userId || null,
      },
    }).catch(() => null);
  } catch (_) { /* ignore */ }

  // Never leak stack traces / internal messages to clients in production.
  const isProduction = process.env.NODE_ENV === 'production';
  const body = { error: 'Internal Server Error' };
  if (!isProduction) {
    body.message = err.message;
    body.stack = err.stack;
  }
  res.status(500).json(body);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('[Server] Code version: 2026-08-03-whatsapp-cloud-api');
  try {
    require('./services/followUpWorker').startFollowUpWorker();
  } catch (err) {
    console.error('[FollowUpWorker] failed to start:', err.message);
  }
  try {
    require('./services/quoteFollowUpWorker').startQuoteFollowUpWorker();
  } catch (err) {
    console.error('[QuoteFollowUpWorker] failed to start:', err.message);
  }
  try {
    require('./services/automationScheduler').startAutomationScheduler();
  } catch (err) {
    console.error('[AutomationScheduler] failed to start:', err.message);
  }

  // Owner Success Intelligence — scan customer workspaces periodically
  try {
    const ownerIntelligence = require('./services/ownerIntelligence');
    ownerIntelligence.ensureTables().catch(() => null);
    const intelMs = Number(process.env.OWNER_INTELLIGENCE_INTERVAL_MS || 5 * 60 * 1000);
    setInterval(() => {
      ownerIntelligence.scanAndNotify()
        .then((r) => {
          if (r.created > 0) console.log(`[OwnerIntelligence] created ${r.created} success event(s)`);
        })
        .catch((err) => console.warn('[OwnerIntelligence] scan failed:', err.message));
    }, Math.max(60000, intelMs));
    setTimeout(() => {
      ownerIntelligence.scanAndNotify().catch(() => null);
    }, 20000);
    console.log(`[OwnerIntelligence] scheduler started (interval=${Math.max(60000, intelMs)}ms)`);
  } catch (err) {
    console.error('[OwnerIntelligence] failed to start:', err.message);
  }
});
