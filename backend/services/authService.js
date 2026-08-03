/**
 * Auth Service — real email verification, password reset, JWT tokens.
 * Uses bcryptjs for hashing and nodemailer (via existing emailService transporter).
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const userStorage = require('../utils/userStorage');
const { getSystemTransporter, isEmailConfigured } = require('./emailService');

function getSystemSenderEmail() {
  return process.env.EMAIL_USER || 'no-reply@leadflow.ai';
}

const JWT_SECRET = process.env.DEV_AUTH_SECRET || process.env.JWT_SECRET || 'lf-local-secret-change-in-production';
const SALT_ROUNDS = 12;

const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || 'leadflow.my@gmail.com')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function isSuperAdminEmail(email) {
  return SUPER_ADMIN_EMAILS.includes((email || '').toLowerCase());
}

async function ensureSuperAdmin(user) {
  if (!user) return null;
  if (!isSuperAdminEmail(user.email)) return user;
  const updates = {};
  if (!user.email_verified) updates.emailVerified = true;
  if (user.role !== 'super_admin') updates.role = 'super_admin';
  if (user.subscription_status !== 'active') updates.subscriptionStatus = 'active';
  if (user.subscription_plan !== 'enterprise') updates.subscriptionPlan = 'enterprise';
  if (Object.keys(updates).length > 0) {
    await userStorage.updateUser(user.id, updates);
  }
  return { ...user, ...updates };
}

function generateId() {
  return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function signToken(userId, options = {}) {
  const payload = { sub: userId, workspace_id: userId };
  if (options.role) payload.role = options.role;
  if (options.sessionId) payload.sid = options.sessionId;
  // Idle timeout is enforced via session last_seen; JWT hard expiry remains a backstop.
  const expiresIn = options.rememberMe ? '30d' : '7d';
  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

/* ==================== EMAIL SENDING ==================== */

function getSenderDomain() {
  const sender = getSystemSenderEmail();
  const match = sender.match(/@([\w.-]+)/);
  return match ? match[1] : 'gmail.com';
}

function buildEmailHeaders(type, senderEmail) {
  const domain = getSenderDomain();
  const messageId = `<${type}-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}>`;
  return {
    'Message-ID': messageId,
    'X-Mailer': 'LeadFlow AI',
    'X-Priority': '3',
    'Precedence': 'bulk',
    'Auto-Submitted': 'auto-generated',
    'List-Id': `<${type}.leadflow.ai>`,
    'List-Unsubscribe': `<mailto:${senderEmail}?subject=Unsubscribe>`,
    'X-Auto-Response-Suppress': 'OOF, DR, RN, NRN, OOFUnsubscribe',
  };
}

async function sendVerificationEmail(toEmail, code, fullName) {
  console.log('[Auth] sendVerificationEmail() called with toEmail:', toEmail);
  const t = getSystemTransporter();
  if (!t) {
    console.warn('[Auth] System email not configured (EMAIL_USER/EMAIL_PASS). Verification code:', code);
    return { sent: false, code };
  }
  const companyName = process.env.COMPANY_NAME || 'LeadFlow AI';
  const senderEmail = getSystemSenderEmail();
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:0}
.container{max-width:480px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.brand{font-size:20px;font-weight:700;color:#1e293b;margin-bottom:24px}
.title{font-size:22px;font-weight:700;color:#0f172a;margin-bottom:8px}
.subtitle{font-size:14px;color:#64748b;margin-bottom:24px}
.code{font-size:36px;font-weight:700;letter-spacing:8px;color:#7c3aed;background:#f3e8ff;padding:16px 24px;border-radius:8px;text-align:center;margin-bottom:24px}
.footer{font-size:12px;color:#94a3b8;margin-top:32px}
</style></head>
<body>
<div class="container">
  <div class="brand">${companyName}</div>
  <div class="title">Verify your email</div>
  <div class="subtitle">Hi ${fullName || 'there'}, use the code below to verify your email address.</div>
  <div class="code">${code}</div>
  <div class="subtitle">This code expires in 30 minutes. If you didn't request this, you can safely ignore this email.</div>
  <div class="footer">${companyName} — AI Lead Generation Platform</div>
</div>
</body>
</html>`;
  const text = `Hi ${fullName || 'there'},

Your verification code is: ${code}

This code expires in 30 minutes.

If you didn't request this, you can safely ignore this email.

Best regards,
${companyName}`;
  await t.sendMail({
    from: `"${companyName}" <${senderEmail}>`,
    to: toEmail,
    replyTo: `"${companyName} Support" <${senderEmail}>`,
    subject: `Your verification code — ${companyName}`,
    text,
    html,
    headers: buildEmailHeaders('verify', senderEmail),
  });
  console.log('[Auth] Verification email sent to:', toEmail);
  return { sent: true, code };
}

async function sendResetEmail(toEmail, code, fullName) {
  console.log('[Auth] sendResetEmail() called with toEmail:', toEmail);
  const t = getSystemTransporter();
  if (!t) {
    console.warn('[Auth] System email not configured (EMAIL_USER/EMAIL_PASS). Reset code:', code);
    return { sent: false, code };
  }
  const companyName = process.env.COMPANY_NAME || 'LeadFlow AI';
  const senderEmail = getSystemSenderEmail();
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#f8fafc;margin:0;padding:0}
.container{max-width:480px;margin:40px auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.brand{font-size:20px;font-weight:700;color:#1e293b;margin-bottom:24px}
.title{font-size:22px;font-weight:700;color:#0f172a;margin-bottom:8px}
.subtitle{font-size:14px;color:#64748b;margin-bottom:24px}
.code{font-size:36px;font-weight:700;letter-spacing:8px;color:#dc2626;background:#fee2e2;padding:16px 24px;border-radius:8px;text-align:center;margin-bottom:24px}
.footer{font-size:12px;color:#94a3b8;margin-top:32px}
</style></head>
<body>
<div class="container">
  <div class="brand">${companyName}</div>
  <div class="title">Reset your password</div>
  <div class="subtitle">Hi ${fullName || 'there'}, use the code below to reset your password.</div>
  <div class="code">${code}</div>
  <div class="subtitle">This code expires in 30 minutes. If you didn't request this, you can safely ignore this email.</div>
  <div class="footer">${companyName} — AI Lead Generation Platform</div>
</div>
</body>
</html>`;
  const text = `Hi ${fullName || 'there'},

Your password reset code is: ${code}

This code expires in 30 minutes.

If you didn't request this, you can safely ignore this email.

Best regards,
${companyName}`;
  const mailOptions = {
    from: `"${companyName}" <${senderEmail}>`,
    to: toEmail,
    replyTo: `"${companyName} Support" <${senderEmail}>`,
    subject: `Your password reset code — ${companyName}`,
    text,
    html,
    headers: buildEmailHeaders('reset', senderEmail),
  };
  console.log('[Auth] SMTP sendMail -> from:', senderEmail, '| to:', toEmail, '| subject:', mailOptions.subject);
  const info = await t.sendMail(mailOptions);
  console.log('[Auth] SMTP response:', JSON.stringify({ messageId: info.messageId, response: info.response, accepted: info.accepted, rejected: info.rejected, pending: info.pending }));
  console.log('[Auth] Reset email sent to:', toEmail);
  return { sent: true, code };
}

/* ==================== AUTH OPERATIONS ==================== */

async function signup({ fullName, businessName, email, whatsappNumber, password, role }) {
  console.log('[Auth Service] signup() called with email:', email);
  const existing = await userStorage.findByEmail(email);
  if (existing) throw new Error('An account with this email already exists.');

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const userId = generateId();
  await userStorage.createUser({
    id: userId, fullName, businessName, email, whatsappNumber, passwordHash, role
  });
  console.log('[Auth Service] User created in DB with email:', email);

  const code = generateCode();
  await userStorage.setEmailCode(email, code);
  console.log('[Auth Service] Calling sendVerificationEmail with email:', email);
  let emailSent = false;
  try {
    const result = await sendVerificationEmail(email, code, fullName);
    emailSent = result?.sent !== false;
  } catch (err) {
    console.warn('[Auth Service] Verification email send failed:', err.message);
  }

  return {
    userId,
    message: emailSent
      ? 'Account created. Please check your email for a verification code.'
      : 'Account created. Email delivery is temporarily unavailable — please use "Resend verification code" or contact support.',
    emailSent,
  };
}

async function login(email, password, options = {}) {
  const e = (email || '').toLowerCase();
  const meta = {
    ip: options.ip || null,
    userAgent: options.userAgent || null,
    country: options.country || null,
  };
  let adminAudit;
  try { adminAudit = require('../utils/adminAudit'); } catch (_) { adminAudit = null; }

  const user = await userStorage.findByEmail(e);
  if (!user) {
    if (adminAudit) {
      await adminAudit.recordAuthEvent({
        email: e, eventType: 'login_failed', success: false, ...meta,
        details: { reason: 'unknown_email' },
      }).catch(() => null);
    }
    throw new Error('Invalid email or password.');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    if (adminAudit) {
      await adminAudit.recordAuthEvent({
        email: e, userId: user.id, eventType: 'login_failed', success: false, ...meta,
        details: { reason: 'bad_password' },
      }).catch(() => null);
      const recent = await adminAudit.listAuthEvents(50).catch(() => []);
      const fails = recent.filter((ev) =>
        (ev.email || '').toLowerCase() === e
        && !ev.success
        && (ev.event_type || ev.eventType) === 'login_failed'
        && Date.now() - new Date(ev.created_at || ev.createdAt || 0).getTime() < 15 * 60 * 1000);
      if (fails.length >= 5) {
        await adminAudit.pushNotification({
          severity: 'critical',
          category: 'security',
          title: `Repeated failed logins for ${e}`,
          body: `${fails.length} failures in 15 minutes`,
          source: 'auth',
        }).catch(() => null);
      }
    }
    throw new Error('Invalid email or password.');
  }

  if ((user.account_status || 'active') === 'suspended') {
    if (adminAudit) {
      await adminAudit.recordAuthEvent({
        email: e, userId: user.id, eventType: 'login_blocked', success: false, ...meta,
        details: { reason: 'suspended' },
      }).catch(() => null);
    }
    throw new Error('This account has been suspended. Contact support.');
  }

  const adminEmail = isSuperAdminEmail(e);
  let effectiveUser = user;
  if (adminEmail) {
    effectiveUser = await ensureSuperAdmin(user);
  }

  if (!effectiveUser.email_verified && !adminEmail) {
    throw new Error('Please verify your email before logging in.');
  }

  await userStorage.recordLoginActivity(effectiveUser.id, meta).catch(() => null);
  if (adminAudit) {
    await adminAudit.recordAuthEvent({
      email: e,
      userId: effectiveUser.id,
      eventType: 'login_success',
      success: true,
      ...meta,
      details: { role: effectiveUser.role },
    }).catch(() => null);
  }

  const sessionService = require('./sessionService');
  const session = await sessionService.createSession({
    userId: effectiveUser.id,
    email: effectiveUser.email,
    ip: meta.ip,
    userAgent: meta.userAgent,
  }).catch(() => null);

  const token = signToken(effectiveUser.id, {
    rememberMe: options.rememberMe,
    role: effectiveUser.role || (adminEmail ? 'super_admin' : 'subscriber'),
    sessionId: session?.id,
  });
  return { token, user: userStorage.toPublicUser(effectiveUser), sessionId: session?.id || null };
}

async function verifyEmail(email, code) {
  return await userStorage.verifyEmail(email, code);
}

async function forgotPassword(email) {
  const user = await userStorage.findByEmail(email);
  if (!user) return { message: 'If an account exists, a reset code has been sent.' };

  const code = generateCode();
  await userStorage.setResetCode(email, code);
  try {
    await sendResetEmail(email, code, user.full_name);
  } catch (err) {
    console.error('[Auth] Failed to send reset email:', err.message);
  }
  return { message: 'If an account exists, a reset code has been sent.' };
}

async function resetPassword(email, code, newPassword) {
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  return await userStorage.resetPassword(email, code, passwordHash);
}

async function getUserByToken(token) {
  const payload = verifyToken(token);
  const user = await userStorage.findById(payload.sub);
  if (!user) return null;
  const effectiveUser = isSuperAdminEmail(user.email) ? await ensureSuperAdmin(user) : user;
  return userStorage.toPublicUser(effectiveUser);
}

async function updateProfile(userId, updates) {
  const allowed = {};
  if (updates.fullName !== undefined) allowed.fullName = updates.fullName;
  if (updates.businessName !== undefined) allowed.businessName = updates.businessName;
  if (updates.whatsappNumber !== undefined) allowed.whatsappNumber = updates.whatsappNumber;
  if (updates.role !== undefined) allowed.role = updates.role;
  await userStorage.updateUser(userId, allowed);
  const user = await userStorage.findById(userId);
  return userStorage.toPublicUser(user);
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await userStorage.findById(userId);
  if (!user) return false;
  const valid = await bcrypt.compare(currentPassword, user.password_hash);
  if (!valid) return false;
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await userStorage.updateUser(userId, { passwordHash });
  return true;
}

module.exports = {
  signup, login, verifyEmail, forgotPassword, resetPassword,
  getUserByToken, updateProfile, changePassword,
  signToken, verifyToken,
  sendVerificationEmail, sendResetEmail,
  isSuperAdminEmail, ensureSuperAdmin,
};
