/* auth-middleware.js — session verification + role-based access control (OWASP A01 Broken Access Control, A07 Authentication Failures).

   const { auth, forgetAccountCheck, revocation, sessions } = require('./auth-middleware')(pool);
   app.get('/api/x', auth('finance'), handler);      // only finance
   app.get('/api/y', auth(), handler);               // any signed-in user

   Order of checks (the 403 happens BEFORE any database work):
     1. signed session cookie (JWT) is valid        -> else 401
     2. the role in the token is allowed for route  -> else 403 Forbidden
     3. the account is still active and its role is unchanged                -> else 401 ACCOUNT_DISABLED
        the session was not ended (newer sign-in over the device limit, logout,
        password change)                                                      -> else 401 SESSION_REPLACED   (one small cached query)

   Two ways a session ends before its 8 hours are up:
     • users.token_version (db/025)  — a password change or reset ends EVERY session of the account at once.
     • user_sessions (db/026)        — one row per signed-in device (the cookie carries its id, "sid"). Each role has a limit on live devices
                                       (SESSION_LIMITS in server.js: finance 1, cashier 1, customer 3); signing in over the limit ends the oldest.
   Sessions made before these existed carry no tv / sid and keep working until they expire. */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCOUNT_CHECK_MS = 10000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_SESSION = '00000000-0000-0000-0000-000000000000';

module.exports = function createAuth(pool) {
  const accountCheck = new Map();                     // "user:session number:sid" -> { status, at }

  // db/025 adds users.token_version; the server also adds it at start-up so the app works before the migration is run by hand.
  // If it cannot be added, password changes cannot end other sessions (everything else keeps working).
  const tvReady = Promise.resolve()
    .then(() => pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0'))
    .then(() => true, (e) => { console.warn('[auth] session revocation is OFF (users.token_version missing and could not be added):', e.message); return false; });

  // db/026: one row per signed-in device. Also created here at start-up (same definition); if that fails, device limits are off.
  const sessReady = Promise.resolve()
    .then(() => pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (
      session_id     UUID PRIMARY KEY,
      user_id        INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at     TIMESTAMPTZ NOT NULL,
      revoked_at     TIMESTAMPTZ,
      revoked_reason TEXT,
      ip_address     TEXT,
      user_agent     TEXT)`))
    .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_user_sessions_live ON user_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL'))
    .then(() => pool.query('ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY'))
    .then(() => true, (e) => { console.warn('[auth] device limits are OFF (user_sessions could not be prepared):', e.message); return false; });

  // A disabled account (or one whose role changed, or whose sessions were ended) loses access on its next request, not when its 8-hour cookie runs out.
  // Answers 'ok', 'disabled' (account off, gone or role changed) or 'replaced' (a newer sign-in, a logout or a password change ended this session).
  // The cache is keyed by user AND session: an old session being refused must never make the user's new session look invalid.
  const cacheKey = (user) => user.id + ':' + (Number(user.tv) || 0) + ':' + (user.sid || '');
  async function accountStatus(user) {
    const key = cacheKey(user);
    const hit = accountCheck.get(key);
    if (hit && Date.now() - hit.at < ACCOUNT_CHECK_MS) return hit.status;
    try {
      const withTv = await tvReady;
      const withSess = (await sessReady) && !!user.sid;
      const sid = typeof user.sid === 'string' && UUID_RE.test(user.sid) ? user.sid : NO_SESSION;
      const r = (await pool.query(
        `SELECT u.status, r.role_key${withTv ? ', u.token_version' : ''}${withSess ? ', (s.session_id IS NOT NULL AND s.revoked_at IS NULL AND s.expires_at > now()) AS session_ok' : ''}
           FROM users u JOIN roles r USING (role_id)${withSess ? ' LEFT JOIN user_sessions s ON s.session_id = $2::uuid AND s.user_id = u.user_id' : ''}
          WHERE u.user_id = $1`, withSess ? [user.id, sid] : [user.id])).rows[0];
      let status = 'ok';
      if (!r || r.status !== 'active' || r.role_key !== user.role) status = 'disabled';
      // a session made before token_version existed carries no tv: it counts as version 0
      else if (withTv && (Number(user.tv) || 0) !== (Number(r.token_version) || 0)) status = 'replaced';
      else if (withSess && r.session_ok !== true) status = 'replaced';
      accountCheck.set(key, { status, at: Date.now() });
      if (accountCheck.size > 5000) accountCheck.clear();
      return status;
    } catch (e) {
      console.error('[auth] could not check the account, allowing the signed session:', e.message);
      return 'ok';                                    // a database hiccup must not sign everybody out
    }
  }

  const forgetAccountCheck = (id) => { const prefix = Number(id) + ':'; for (const k of accountCheck.keys()) if (k.startsWith(prefix)) accountCheck.delete(k); };

  const revocation = {
    ready: tvReady,
    /* Inside the password-change transaction: make every older session invalid. Returns the NEW version, which the caller puts into
       the fresh session cookie it hands back to the person who just changed the password (so they stay signed in on this device). */
    async bump(client, userId) {
      if (!(await tvReady)) return 0;
      const r = await client.query('UPDATE users SET token_version = token_version + 1 WHERE user_id = $1 RETURNING token_version', [userId]);
      return r.rows[0] ? Number(r.rows[0].token_version) : 0;
    }
  };

  const sessions = {
    ready: sessReady,
    /* A new sign-in: records the device and returns its id (put in the cookie as "sid"). null = device tracking is unavailable. */
    async create({ userId, ttlMs, ip, ua }) {
      if (!(await sessReady)) return null;
      const sid = crypto.randomUUID();
      await pool.query('INSERT INTO user_sessions (session_id, user_id, expires_at, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [sid, userId, new Date(Date.now() + ttlMs), ip ? String(ip).slice(0, 64) : null, ua ? String(ua).slice(0, 300) : null]);
      return sid;
    },
    /* Keep only the newest `limit` live sessions of this person; the older ones end (and are refused on their next request). Returns how many ended. */
    async enforceLimit(userId, limit) {
      if (!(limit > 0) || !(await sessReady)) return 0;
      const r = await pool.query(
        `UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'limit'
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND session_id NOT IN (SELECT session_id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
                                    ORDER BY created_at DESC, session_id LIMIT $2)`, [userId, limit]);
      forgetAccountCheck(userId);
      return r.rowCount;
    },
    /* Logout: frees this device's place. */
    async revoke(sid, reason) {
      if (!sid || !UUID_RE.test(String(sid)) || !(await sessReady)) return 0;
      const r = await pool.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = $2 WHERE session_id = $1 AND revoked_at IS NULL`, [sid, reason || 'logout']);
      return r.rowCount;
    },
    /* Password change / reset: every device except keepSid (or all, when keepSid is empty) ends. */
    async revokeOthers(client, userId, keepSid, reason) {
      if (!(await sessReady)) return 0;
      const keep = keepSid && UUID_RE.test(String(keepSid)) ? keepSid : null;
      const r = await client.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = $3
                                     WHERE user_id = $1 AND revoked_at IS NULL AND session_id IS DISTINCT FROM $2::uuid`, [userId, keep, reason || 'password']);
      forgetAccountCheck(userId);
      return r.rowCount;
    }
  };

  function auth(...allowed) {
    return (req, res, next) => {
      try {
        req.user = jwt.verify(req.cookies.session, process.env.JWT_SECRET);
      } catch { return res.status(401).json({ error: 'Not signed in' }); }
      if (allowed.length && !allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
      accountStatus(req.user).then((status) => {
        if (status === 'ok') return next();
        res.clearCookie('session');
        if (status === 'replaced') {
          // a short-lived, non-sensitive note the login page reads to explain why the person was signed out (the pages' own 401 handlers just redirect)
          res.cookie('signedout', 'replaced', { maxAge: 120000, sameSite: 'lax', secure: require('./security').cookieSecure() });
          return res.status(401).json({ code: 'SESSION_REPLACED', error: 'You were signed out because this account signed in on another device, or its password was changed. Please sign in again.' });
        }
        res.status(401).json({ code: 'ACCOUNT_DISABLED', error: 'This account is disabled or was changed. Please sign in again.' });
      }, next);
    };
  }

  return { auth, forgetAccountCheck, revocation, sessions };
};
