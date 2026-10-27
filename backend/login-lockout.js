/* Sign-in lockout with an emailed unlock link.

   1) Wrong password LOGIN_MAX_ATTEMPTS times in a row (default 3)  ->  the account is locked and an unlock link is emailed.
   2) While locked, signing in is refused (even with the right password). NO timer is running yet.
   3) The person opens the link  ->  only THEN the cooldown starts (LOGIN_COOLDOWN_SECONDS, default 120 = 2 minutes).
   4) When the cooldown is over they can sign in again. A successful sign-in clears everything.

     POST /api/auth/unlock          { token }   -> starts the cooldown, answers { email, secondsLeft }
     POST /api/auth/unlock/resend   { email }   -> sends a new link (60 s between emails; always answers the same)

   .env (all optional):  LOGIN_MAX_ATTEMPTS=3   LOGIN_COOLDOWN_SECONDS=120   UNLOCK_LINK_TTL_MIN=60

   The table is called login_lockouts (password-otp.js already clears it when a password is reset with a code). */
const crypto = require('crypto');
const mailer = require('./mailer');

const num = (v, d, lo, hi) => Math.min(Math.max(Number(v) || d, lo), hi);
const MAX_ATTEMPTS = num(process.env.LOGIN_MAX_ATTEMPTS, 3, 1, 20);
const COOLDOWN_SEC = num(process.env.LOGIN_COOLDOWN_SECONDS, 120, 10, 3600);
const LINK_TTL_MIN = num(process.env.UNLOCK_LINK_TTL_MIN, 60, 5, 1440);
const RESEND_SEC = 60;

module.exports = function ({ app, pool, wrap, audit, str, EMAIL_RE }) {
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const baseUrl = (req) => (process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');

  const ready = pool.query(`CREATE TABLE IF NOT EXISTS login_lockouts (
      user_id          INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
      failed_attempts  INT NOT NULL DEFAULT 0,
      locked_at        TIMESTAMPTZ,            -- set when the account gets locked
      token_hash       TEXT,                   -- the emailed unlock link (only a hash is stored)
      token_expires_at TIMESTAMPTZ,
      unlock_until     TIMESTAMPTZ,            -- set ONLY when the link is opened: now + cooldown
      last_email_at    TIMESTAMPTZ,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .catch((e) => console.warn('[db] could not prepare the login lockout table:', e.message));
  app.locals.lockoutReady = ready;

  const secondsUntil = (ts) => Math.max(0, Math.ceil((new Date(ts).getTime() - Date.now()) / 1000));

  /* Is this user allowed to try a password right now?  Returns null (yes) or an object to send with status 423. */
  async function status(userId) {
    await ready;
    const r = (await pool.query('SELECT * FROM login_lockouts WHERE user_id = $1', [userId])).rows[0];
    if (!r || !r.locked_at) return null;
    if (r.unlock_until) {
      const left = secondsUntil(r.unlock_until);
      if (left > 0) return { code: 'COOLDOWN', secondsLeft: left, totalSeconds: COOLDOWN_SEC,
        error: 'Your account was unlocked. You can sign in again in ' + fmt(left) + '.' };
      await pool.query('DELETE FROM login_lockouts WHERE user_id = $1', [userId]);     // cooldown finished: fresh start
      return null;
    }
    return { code: 'LOCKED', secondsLeft: 0,
      error: 'Too many failed attempts. We emailed you an unlock link. Open it to unlock your account.' };
  }
  const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');

  /* A wrong password. Returns { locked, attemptsLeft, emailSent }. */
  async function fail(u, req) {
    await ready;
    const r = (await pool.query(
      `INSERT INTO login_lockouts (user_id, failed_attempts) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET failed_attempts = login_lockouts.failed_attempts + 1, updated_at = now()
       RETURNING failed_attempts`, [u.user_id])).rows[0];
    // every wrong password is recorded in the audit log (OWASP A09), not only the lock-out event
    await audit(pool, { id: u.user_id, name: u.full_name, roleLabel: u.label }, 'Login failed',
      'Wrong password (attempt ' + r.failed_attempts + ' of ' + MAX_ATTEMPTS + ')').catch(() => {});
    if (r.failed_attempts < MAX_ATTEMPTS) return { locked: false, attemptsLeft: MAX_ATTEMPTS - r.failed_attempts };
    const sent = await lockAndEmail(u, req);
    await audit(pool, { id: u.user_id, name: u.full_name, roleLabel: u.label }, 'Login',
      'Account locked after ' + MAX_ATTEMPTS + ' failed sign-in attempts' + (sent ? '; unlock link emailed' : '; unlock email could not be sent')).catch(() => {});
    return { locked: true, emailSent: sent };
  }

  async function lockAndEmail(u, req) {
    const token = newToken();
    await pool.query(
      `UPDATE login_lockouts SET locked_at = now(), unlock_until = NULL, token_hash = $2, last_email_at = now(),
              token_expires_at = now() + ($3 || ' minutes')::interval, updated_at = now() WHERE user_id = $1`,
      [u.user_id, hashToken(token), String(LINK_TTL_MIN)]);
    const url = baseUrl(req) + '/Login_Inventory.html?unlock=' + token;
    const r = await mailer.sendUnlockEmail({ to: u.email, recipientName: u.first_name || u.full_name, unlockUrl: url,
      expiresMinutes: LINK_TTL_MIN, cooldownSeconds: COOLDOWN_SEC, attempts: MAX_ATTEMPTS }).catch((e) => ({ sent: false, reason: e.message }));
    if (!r.sent) console.warn('[lockout] unlock email to ' + u.email + ' not sent: ' + r.reason + '\n[lockout] test link: ' + url);
    return !!r.sent;
  }

  async function clear(userId) {
    await ready;
    await pool.query('DELETE FROM login_lockouts WHERE user_id = $1', [userId]).catch(() => {});
  }

  /* small per-IP limiter for the two public routes */
  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(k, list); next();
  };

  /* The link was opened: START the cooldown (once). Opening it again just shows the time that is left. */
  app.post('/api/auth/unlock', limit('unlock', 30, 15 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const token = str(req.body && req.body.token);
    if (!token || token.length > 200) return res.status(400).json({ error: 'This unlock link is invalid.' });
    const h = hashToken(token);
    // the first click claims the link and starts the timer; the UPDATE is atomic so two clicks cannot start it twice
    const first = (await pool.query(
      `UPDATE login_lockouts SET unlock_until = now() + ($2 || ' seconds')::interval, updated_at = now()
        WHERE token_hash = $1 AND locked_at IS NOT NULL AND unlock_until IS NULL AND token_expires_at > now()
        RETURNING user_id, unlock_until`, [h, String(COOLDOWN_SEC)])).rows[0];
    let row = first;
    if (!row) {
      row = (await pool.query('SELECT user_id, unlock_until, token_expires_at FROM login_lockouts WHERE token_hash = $1 AND locked_at IS NOT NULL', [h])).rows[0];
      if (!row || !row.unlock_until)
        return res.status(400).json({ error: 'This unlock link is invalid or has expired. Try signing in again to get a new one.' });
    }
    const u = (await pool.query('SELECT u.full_name, u.email, r.label FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1', [row.user_id])).rows[0];
    if (first && u) await audit(pool, { id: row.user_id, name: u.full_name, roleLabel: u.label }, 'Login', 'Unlock link opened; ' + COOLDOWN_SEC + '-second cooldown started').catch(() => {});
    res.json({ ok: true, email: u ? u.email : '', secondsLeft: secondsUntil(row.unlock_until), totalSeconds: COOLDOWN_SEC });
  }));

  /* "Send me the link again" - same answer whether or not the account exists */
  app.post('/api/auth/unlock/resend', limit('unlock-resend', 10, 60 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const email = str(req.body && req.body.email).toLowerCase();
    const same = { ok: true, waitSeconds: RESEND_SEC, message: 'If that account is locked, we sent a new unlock link to its email.' };
    if (!EMAIL_RE.test(email) || email.length > 254) return res.json(same);
    const u = (await pool.query(
      `SELECT u.user_id, u.full_name, u.first_name, u.email, u.status, r.label, l.locked_at, l.unlock_until, l.last_email_at
         FROM users u JOIN roles r USING (role_id) JOIN login_lockouts l ON l.user_id = u.user_id WHERE u.email = $1`, [email])).rows[0];
    if (u && u.status === 'active' && u.locked_at && !u.unlock_until) {
      const wait = u.last_email_at ? RESEND_SEC - Math.floor((Date.now() - new Date(u.last_email_at).getTime()) / 1000) : 0;
      if (wait > 0) return res.json({ ...same, waitSeconds: wait, message: 'A link was just sent. You can ask for another in ' + wait + ' seconds.' });
      await lockAndEmail(u, req);
    }
    res.json(same);
  }));

  app.locals.loginLock = { status, fail, clear, MAX_ATTEMPTS, COOLDOWN_SEC };
  return app.locals.loginLock;
};
