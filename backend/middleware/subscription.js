/**
 * Subscription middleware (Change 4).
 *
 * Checks that the authenticated user has an active subscription
 * before allowing access to paid features.
 *
 * Admin users (role === 'admin') bypass the check.
 *
 * Usage:
 *   const { requireSubscription } = require('./middleware/subscription');
 *   app.use('/api/scrape', requireAuth, requireSubscription, require('./routes/scrape'));
 */

const userStorage = require('../utils/userStorage');

function isActiveSubscription(user) {
  const status = user.subscription_status || 'none';
  if (status !== 'active' && status !== 'pending') return false;
  const expires = user.subscription_expires_at;
  if (expires) {
    const t = new Date(expires).getTime();
    if (!Number.isNaN(t) && t < Date.now() && status === 'active') {
      // Expired active → treat as inactive (pending checkouts still allowed)
      return false;
    }
  }
  return true;
}

async function requireSubscription(req, res, next) {
  const authMode = (process.env.AUTH_MODE || '').toLowerCase();
  if (authMode === 'disabled') {
    return next();
  }
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await userStorage.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found.' });
    }

    // Admins and super admins bypass subscription checks
    const role = user.role || 'subscriber';
    if (role === 'admin' || role === 'super_admin') {
      return next();
    }

    if (!isActiveSubscription(user)) {
      return res.status(403).json({
        error: 'Subscription required.',
        code: 'SUBSCRIPTION_REQUIRED',
        subscriptionStatus: user.subscription_status || 'none',
      });
    }

    next();
  } catch (err) {
    console.error('[Subscription] Check error:', err.message);
    res.status(500).json({ error: 'Subscription check failed.' });
  }
}

// Optional: attach subscription info to req.auth for downstream use
async function attachSubscription(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) return next();
    const user = await userStorage.findById(userId);
    if (user) {
      req.auth.role = user.role || 'subscriber';
      req.auth.subscriptionStatus = user.subscription_status || 'none';
      req.auth.subscriptionPlan = user.subscription_plan || null;
    }
    next();
  } catch {
    next();
  }
}

module.exports = { requireSubscription, attachSubscription, isActiveSubscription };
