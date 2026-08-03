/**
 * Super Admin gate — Owner only.
 * Requires authenticated user with role === 'super_admin'
 * (or email in SUPER_ADMIN_EMAILS allowlist).
 */

const userStorage = require('../utils/userStorage');
const { isSuperAdminEmail } = require('../services/authService');

async function requireSuperAdmin(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const user = await userStorage.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'User not found' });
    }

    const role = user.role || 'subscriber';
    const allowed = role === 'super_admin' || isSuperAdminEmail(user.email);
    if (!allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Super Admin access required. This console is for the Owner only.',
      });
    }

    if (user.account_status === 'suspended') {
      return res.status(403).json({ error: 'Forbidden', message: 'Account suspended' });
    }

    req.auth = {
      ...(req.auth || {}),
      userId: user.id,
      role: 'super_admin',
      email: user.email,
      isSuperAdmin: true,
    };
    return next();
  } catch (err) {
    console.error('[Admin] requireSuperAdmin error:', err.message);
    return res.status(500).json({ error: 'Admin auth failed' });
  }
}

module.exports = { requireSuperAdmin };
