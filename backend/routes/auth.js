/**
 * Authentication Routes
 * POST /api/auth/signup
 * POST /api/auth/login
 * POST /api/auth/verify-email
 * POST /api/auth/resend-verification
 * POST /api/auth/forgot-password
 * POST /api/auth/reset-password
 * GET  /api/auth/me          (requires Bearer token)
 * PUT  /api/auth/me          (requires Bearer token)
 * POST /api/auth/change-password (requires Bearer token)
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const userStorage = require('../utils/userStorage');

/* ---------------- helpers ---------------- */
function getBearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice('Bearer '.length).trim();
}

/* ---------------- public routes ---------------- */

router.post('/signup', async (req, res) => {
  try {
    const { fullName, businessName, email, whatsappNumber, password } = req.body;
    console.log('[Auth Route] Signup email received:', email);
    if (!fullName || !businessName || !email || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const result = await authService.signup({ fullName, businessName, email, whatsappNumber, password });
    res.status(201).json(result);
  } catch (err) {
    console.error('[Auth] Signup error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const result = await authService.login(email, password, {
      rememberMe: !!rememberMe,
      ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || null,
      userAgent: req.headers['user-agent'] || null,
      country: req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country'] || null,
    });
    res.json(result);
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    try {
      require('../utils/errorLogger').logAdminError(err, { source: 'auth.login', level: 'warn' });
    } catch (_) { /* ignore */ }
    res.status(401).json({ error: err.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = getBearer(req);
    if (token) {
      try {
        const payload = authService.verifyToken(token);
        if (payload?.sid) {
          await require('../services/sessionService').revokeSession(payload.sid, 'logout');
        }
      } catch (_) { /* ignore invalid token on logout */ }
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

router.post('/verify-email', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required.' });
    }
    const ok = await authService.verifyEmail(email, code);
    if (!ok) return res.status(400).json({ error: 'Invalid or expired code.' });
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    console.error('[Auth] Verify email error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const userStorage = require('../utils/userStorage');
    const userRow = await userStorage.findByEmail(email);
    if (!userRow) return res.json({ message: 'If an account exists, a new code has been sent.' });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await userStorage.setEmailCode(email, code);
    await authService.sendVerificationEmail(email, code, userRow.full_name);
    res.json({ message: 'If an account exists, a new code has been sent.' });
  } catch (err) {
    console.error('[Auth] Resend error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    await authService.forgotPassword(email);
    res.json({ message: 'If an account exists, a reset code has been sent.' });
  } catch (err) {
    console.error('[Auth] Forgot password error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: 'Email, code and new password are required.' });
    }
    const ok = await authService.resetPassword(email, code, newPassword);
    if (!ok) return res.status(400).json({ error: 'Invalid or expired reset code.' });
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[Auth] Reset password error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- protected routes ---------------- */

router.get('/me', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const user = await authService.getUserByToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token.' });
    console.log('[Auth] Returning user profile for:', user.email, 'with WhatsApp number:', user.whatsappNumber);
    res.json(user);
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    res.status(401).json({ error: 'Invalid token.' });
  }
});

router.put('/me', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = authService.verifyToken(token);
    const user = await authService.updateProfile(payload.sub, req.body);
    res.json(user);
  } catch (err) {
    console.error('[Auth] Update profile error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = authService.verifyToken(token);
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }
    const ok = await authService.changePassword(payload.sub, currentPassword, newPassword);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect.' });
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

/* ---------------- sender email management ---------------- */

router.get('/me/sender-email', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = authService.verifyToken(token);
    const email = await userStorage.getSenderEmail(payload.sub);
    res.json({ senderEmail: email });
  } catch (err) {
    console.error('[Auth] Get sender email error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

router.put('/me/sender-email', async (req, res) => {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = authService.verifyToken(token);
    const { senderEmail } = req.body;
    await userStorage.setSenderEmail(payload.sub, senderEmail);
    res.json({ message: 'Sender email updated.', senderEmail });
  } catch (err) {
    console.error('[Auth] Set sender email error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
