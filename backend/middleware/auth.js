/**
 * middleware/auth.js — Role-Based Access Control (RBAC) & JWT Verification Layer
 *
 * Security & OWASP Alignment:
 * - OWASP A01:2021 (Broken Access Control):
 *   1. `verifyToken`: Intercepts every protected request, extracts the JWT from either the
 *      `Authorization: Bearer <token>` header or the `HttpOnly` session cookie, verifies
 *      the cryptographic HMAC-SHA256 signature and expiration claim (`exp`), and optionally
 *      verifies live database account status so deactivated users or rotated roles are
 *      rejected immediately.
 *   2. `authorizeRoles(...allowedRoles)`: Enforces strict least-privilege Role-Based Access
 *      Control across the 3 system roles (`finance`, `cashier`, `customer` / `Admin`,
 *      `Finance-Admin Officer`, `Regular User`). Unauthorized requests are terminated at
 *      the application tier with HTTP `403 Forbidden` BEFORE any business logic or database
 *      mutation can execute.
 * - OWASP A07:2021 (Identification and Authentication Failures):
 *   Rejects missing, malformed, expired, or tampered tokens with HTTP `401 Unauthorized`.
 */
const jwt = require('jsonwebtoken');

/**
 * Extracts a bearer token from the Authorization header or falls back to the HttpOnly session cookie.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const raw = authHeader.slice(7).trim();
    if (raw) return raw;
  }
  if (req.cookies && typeof req.cookies.session === 'string' && req.cookies.session.trim()) {
    return req.cookies.session.trim();
  }
  return null;
}

/**
 * Factory to configure the auth middleware with a secret and optional live-account validator.
 * Can also be used directly via the default exported `verifyToken` and `authorizeRoles`.
 */
function createAuthMiddleware(options = {}) {
  const getSecret = () => options.secret || process.env.JWT_SECRET;
  const validateAccount = typeof options.validateAccount === 'function' ? options.validateAccount : null;

  /**
   * Primary Authentication Interceptor: Verifies JWT signature, expiry, and active status.
   */
  async function verifyToken(req, res, next) {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'Not signed in',
        message: 'Authentication required. Please provide a valid Bearer token or session cookie.'
      });
    }

    const secret = getSecret();
    if (!secret) {
      return res.status(500).json({ error: 'Server authentication configuration error' });
    }

    try {
      const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
      if (!decoded || !decoded.id || !decoded.role) {
        return res.status(401).json({ error: 'Invalid session token payload' });
      }

      if (validateAccount) {
        const stillValid = await validateAccount(decoded);
        if (!stillValid) {
          if (typeof res.clearCookie === 'function') res.clearCookie('session');
          return res.status(401).json({ error: 'Account disabled or role changed — please sign in again' });
        }
      }

      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({
        error: 'Session expired',
        message: 'Invalid or expired authentication token.'
      });
    }
  }

  /**
   * Secondary Authorization Factory: Enforces Role-Based Access Control (RBAC).
   * Instantly intercepts unauthorized roles and returns HTTP 403 Forbidden before
   * reaching controller or database tiers (OWASP A01:2021).
   *
   * @param {...string} allowedRoles - Permitted roles (e.g., 'finance', 'cashier', 'customer')
   */
  function authorizeRoles(...allowedRoles) {
    const normalizedAllowed = allowedRoles.flat().filter(Boolean);
    return (req, res, next) => {
      if (!req.user || !req.user.role) {
        return res.status(401).json({ error: 'Not signed in' });
      }
      if (normalizedAllowed.length > 0 && !normalizedAllowed.includes(req.user.role)) {
        return res.status(403).json({
          error: 'Forbidden (role: ' + req.user.role + ')',
          message: 'Access Denied: Insufficient role privileges for this resource.'
        });
      }
      return next();
    };
  }

  /**
   * Combined helper preserving backward compatibility with `auth(...allowedRoles)` in server.js.
   */
  function requireAuth(...allowedRoles) {
    const roleGuard = authorizeRoles(...allowedRoles);
    return async (req, res, next) => {
      await verifyToken(req, res, (err) => {
        if (err) return next(err);
        return roleGuard(req, res, next);
      });
    };
  }

  return { verifyToken, authorizeRoles, requireAuth, extractToken };
}

const defaultInstance = createAuthMiddleware();

module.exports = {
  verifyToken: defaultInstance.verifyToken,
  authorizeRoles: defaultInstance.authorizeRoles,
  requireAuth: defaultInstance.requireAuth,
  extractToken,
  createAuthMiddleware
};

