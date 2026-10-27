/* login-otp.js — one-time code on EVERY sign-in (second factor). OWASP A07 Identification & Authentication Failures, ASVS V2.8 / V3.3.

   Flow
     1) POST /api/auth/login (server.js) checks email + password (+ lockout, + account verification). When the password is right it does
        NOT start a session. It answers 403 { code: 'OTP_REQUIRED', challengeToken, email: {masked}|null, sms: {masked}|null }.
     2) The person picks where the code goes: their EMAIL or a TEXT to their registered mobile number.
          POST /api/auth/login-otp/send    { token, channel: 'email'|'sms' }   -> sends a 6-digit code (60 s between sends, 5 per hour)
     3) POST /api/auth/login-otp/verify    { token, code }                      -> right code: the session cookie is issued (same as a normal sign-in)

   The challengeToken is a signed, short-lived (10 min) token made only after the password was right. It is NOT a session and
   cannot open any page or API route. Only an HMAC of each code is stored; a code works once, expires after LOGIN_OTP_TTL_MIN minutes
   (default 5), and 5 wrong tries cancel it. Wrong codes are written to the audit log and feed the failed-sign-in alerts.

   .env:  LOGIN_OTP=off   turns the second step off (development/test harnesses only — production should keep it on)
          LOGIN_OTP_TTL_MIN=5 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mailer = require('./mailer');
const sms = require('./sms');

const TTL_MIN = Math.min(Math.max(Number(process.env.LOGIN_OTP_TTL_MIN) || 5, 1), 15);
const RESEND_SECONDS = 60, MAX_SENDS_PER_HOUR = 5, MAX_WRONG = 5;
const CHALLENGE_TTL = '10m';
const CHANNELS = ['email', 'sms'];
const isProd = () => process.env.NODE_ENV === 'production';

module.exports = function ({ app, pool, wrap, tx, audit, str }) {
  const enabled = () => String(process.env.LOGIN_OTP || '').trim().toLowerCase() !== 'off';
  const key = () => String(process.env.JWT_SECRET) + ':login-otp';
  const hmac = (uid, code) => crypto.createHmac('sha256', key()).update(uid + ':' + code).digest('hex');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const maskEmail = (e) => { const [l, d] = String(e || '').split('@'); return l && d ? l.slice(0, 2) + '***@' + d : ''; };
  const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length < 4 ? '' : '+63 *** *** ' + d.slice(-4); };

  const issueChallenge = (uid) => jwt.sign({ uid, purpose: 'login-otp' }, key(), { expiresIn: CHALLENGE_TTL });
  function readChallenge(token) {
    try {
      const p = jwt.verify(String(token || ''), key());
      return p && p.purpose === 'login-otp' && Number.isInteger(p.uid) ? p.uid : null;
    } catch { return null; }
  }
  const BAD = 'Your sign-in session expired. Please sign in again.';

  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(k, list); next();
  };

  const ready = pool.query(`CREATE TABLE IF NOT EXISTS login_otps (
      otp_id      BIGSERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      channel     TEXT NOT NULL,                  -- 'email' | 'sms'
      destination TEXT NOT NULL,
      code_hash   TEXT NOT NULL,                  -- HMAC of the code, never the code
      expires_at  TIMESTAMPTZ NOT NULL,
      wrong_tries INT NOT NULL DEFAULT 0,
      used_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps (user_id, created_at DESC)'))
    .catch((e) => console.warn('[db] could not prepare the sign-in code table:', e.message));

  const loadUser = async (uid) => (await pool.query(
    `SELECT u.*, r.role_key, r.label FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1`, [uid])).rows[0];   // u.* includes token_version for the session

  // the ways this account can receive its code. The login route has already required a verified email / mobile where that feature is on.
  const canEmail = (u) => !!u.email;
  const canSms = (u) => !!sms.toE164(u.phone) && (u.role_key !== 'customer' || !!u.phone_verified_at);
  const channelsOf = (u) => ({
    email: canEmail(u) ? { masked: maskEmail(u.email) } : null,
    sms: canSms(u) ? { masked: maskPhone(u.phone) } : null });

  async function issue(u, channel) {
    await ready;
    if (!CHANNELS.includes(channel)) return { ok: false, message: 'Choose email or text message.' };
    if (channel === 'email' && !canEmail(u)) return { ok: false, message: 'There is no email on this account.' };
    if (channel === 'sms' && !canSms(u)) return { ok: false, message: 'There is no verified mobile number on this account.' };

    const recent = (await pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last,
              (SELECT floor(extract(epoch FROM o.expires_at - now()))::int FROM login_otps o
                WHERE o.user_id = $1 AND o.used_at IS NULL ORDER BY o.created_at DESC LIMIT 1) AS expires_in,
              (SELECT o3.channel FROM login_otps o3 WHERE o3.user_id = $1 ORDER BY o3.created_at DESC LIMIT 1) AS last_channel
         FROM login_otps WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.user_id])).rows[0];
    if (recent.last) {
      const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(recent.last).getTime()) / 1000);
      // the code sent a moment ago is still valid: tell the page WHERE it went, so it never shows the wrong destination
      if (wait > 0) return { ok: true, sent: false, recent: true, channel: recent.last_channel, waitSeconds: wait, expiresIn: Math.max(recent.expires_in || 0, 0),
        message: channel !== recent.last_channel
          ? 'A code was just sent by ' + (recent.last_channel === 'sms' ? 'text message' : 'email') + '. Use it, or wait ' + wait + ' seconds to switch.'
          : 'A code was just sent. You can ask for another in ' + wait + ' seconds.' };
    }
    if (recent.n >= MAX_SENDS_PER_HOUR) return { ok: false, waitSeconds: 600, message: 'Too many codes were sent. Please try again in about an hour.' };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const dest = channel === 'email' ? u.email : u.phone;
    await pool.query('UPDATE login_otps SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [u.user_id]);   // an older code stops working
    await pool.query(`INSERT INTO login_otps (user_id, channel, destination, code_hash, expires_at)
                      VALUES ($1,$2,$3,$4, now() + ($5 || ' minutes')::interval)`, [u.user_id, channel, dest, hmac(u.user_id, code), String(TTL_MIN)]);

    let r;
    if (channel === 'sms') {
      r = await sms.sendSms({ to: u.phone, message: `Triple E Metal Products: your sign-in code is ${code}. It expires in ${TTL_MIN} minutes. Do not share this code with anyone.` });
    } else {
      const name = u.first_name || u.full_name || 'there';
      const text = `Hi ${name},\n\nYour Triple E Metal Products sign-in code is ${code}.\nIt expires in ${TTL_MIN} minutes. Do not share this code with anyone.\n\nIf you did not try to sign in, change your password now.`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c2430">`
        + `<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f6fb8;font-weight:bold">Triple E Metal Products</div>`
        + `<p style="margin:14px 0 6px">Hi ${mailer.escapeHtml(name)},</p><p style="margin:0 0 14px">Your sign-in code is:</p>`
        + `<p style="font-size:30px;letter-spacing:8px;font-weight:bold;margin:0 0 14px">${code}</p>`
        + `<p style="margin:0 0 8px">It expires in ${TTL_MIN} minutes. Do not share this code with anyone.</p>`
        + `<p style="margin:0;color:#5a6677;font-size:13px">If you did not try to sign in, change your password now.</p></div>`;
      r = await mailer.sendMail({ to: u.email, subject: 'Your Triple E sign-in code', html, text, tag: 'login-otp' });
    }
    // the code itself is only ever printed on a developer computer; production logs never contain it
    if (!r.sent) console.warn(`[login-otp] ${channel} to ${maskDest(channel, dest)} not sent: ${r.reason}` + (isProd() ? '' : `  (test code: ${code})`));
    return { ok: true, sent: !!r.sent, channel, waitSeconds: RESEND_SECONDS, expiresIn: TTL_MIN * 60,
      message: r.sent ? '' : (channel === 'sms' ? 'The text message could not be sent. Try email instead, or resend in a minute.' : 'The email could not be sent. Try a text message instead, or resend in a minute.') };
  }
  const maskDest = (channel, d) => (channel === 'email' ? maskEmail(d) : maskPhone(d));

  /* what server.js sends after a correct password */
  function challengeFor(u) { return { code: 'OTP_REQUIRED', challengeToken: issueChallenge(u.user_id), ...channelsOf(u),
    expiresIn: TTL_MIN * 60, error: 'Enter the one-time code to finish signing in.' }; }
  app.locals.loginOtp = { enabled, challengeFor, TTL_MIN };

  app.post('/api/auth/login-otp/send', limit('lotp-send', 20, 60 * 60 * 1000), wrap(async (req, res) => {
    const uid = readChallenge(req.body && req.body.token);
    if (!uid) return res.status(401).json({ error: BAD });
    const u = await loadUser(uid);
    if (!u || u.status !== 'active') return res.status(401).json({ error: BAD });
    const r = await issue(u, str(req.body && req.body.channel));
    if (!r.ok) return res.status(r.waitSeconds ? 429 : 400).json({ error: r.message, waitSeconds: r.waitSeconds || 0 });
    res.json({ ok: true, sent: r.sent, recent: !!r.recent, channel: r.channel, waitSeconds: r.waitSeconds || 0, expiresIn: r.expiresIn || 0, message: r.message || '' });
  }));

  app.post('/api/auth/login-otp/verify', limit('lotp-verify', 30, 15 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const uid = readChallenge(req.body && req.body.token);
    if (!uid) return res.status(401).json({ error: BAD });
    const u = await loadUser(uid);
    if (!u || u.status !== 'active') return res.status(401).json({ error: BAD });
    const code = str(req.body && req.body.code);
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code.' });

    const out = await tx(async (client) => {
      const o = (await client.query(
        `SELECT otp_id, channel, code_hash, wrong_tries FROM login_otps
          WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [uid])).rows[0];
      if (!o) return { status: 400, error: 'That code has expired. Tap Resend to get a new one.' };
      if (o.wrong_tries >= MAX_WRONG) {
        await client.query('UPDATE login_otps SET expires_at = now() WHERE otp_id = $1', [o.otp_id]);
        return { status: 400, error: 'Too many wrong tries. Tap Resend to get a new code.' };
      }
      if (!same(o.code_hash, hmac(uid, code))) {
        await client.query('UPDATE login_otps SET wrong_tries = wrong_tries + 1 WHERE otp_id = $1', [o.otp_id]);
        const left = MAX_WRONG - o.wrong_tries - 1;
        return { status: 400, wrong: true, tries: o.wrong_tries + 1,
          error: left > 0 ? 'Wrong code. ' + left + (left === 1 ? ' try' : ' tries') + ' left.' : 'Too many wrong tries. Tap Resend to get a new code.' };
      }
      const used = await client.query('UPDATE login_otps SET used_at = now() WHERE otp_id = $1 AND used_at IS NULL RETURNING otp_id', [o.otp_id]);   // a code works once, even with two requests at the same time
      if (!used.rowCount) return { status: 400, error: 'This code was already used. Ask for a new one.' };
      return { ok: true, channel: o.channel };
    });
    if (!out.ok) {
      if (out.wrong) {
        await audit(pool, { id: u.user_id, name: u.full_name, roleLabel: u.label }, 'Login failed', 'Wrong one-time code (attempt ' + out.tries + ' of ' + MAX_WRONG + ')').catch(() => {});
        if (app.locals.alerts) app.locals.alerts.failedLogin({ ip: req.ip, email: u.email }).catch(() => {});
      }
      return res.status(out.status).json({ error: out.error });
    }
    res.json(await app.locals.completeLogin(res, u, out.channel === 'sms' ? 'text message' : 'email'));
  }));
};
