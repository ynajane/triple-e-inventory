/* One-time codes for passwords: FORGOT password (not signed in) and CHANGE password (signed in).
   The person picks where the 6-digit code goes: their EMAIL or a TEXT to their registered mobile number
   (email = mailer.js, text = sms.js / TextBee). CHANGE password needs ONE code, sent to the email OR the mobile number (the person chooses).

     POST /api/auth/forgot/send     { email, channel: 'email'|'sms' }                 -> always answers the same (never says if the account exists)
     POST /api/auth/forgot/reset    { email, code, newPassword, confirmPassword }     -> checks the code, sets the new password
     POST /api/auth/password/check  { currentPassword, newPassword, confirmPassword } (signed in) -> step 1: the CURRENT password must be typed and right,
                                                                                         the new one must be valid; answers which ways the code can go (masked)
     GET  /api/auth/password/options                  (signed in)                      -> same masked options without checking anything
     POST /api/auth/password/otp    { channel, currentPassword }   (signed in)         -> step 2: sends the code to the chosen channel (refused when the current password is wrong)
     PUT  /api/auth/password        (in server.js)    { currentPassword, newPassword, confirmPassword, channel, code }
                                                                                       -> step 3: checks the current password again, then the code for that channel, then saves

   Codes: 6 digits, valid PASSWORD_OTP_TTL_MIN minutes (default 10), 60 s between sends, 5 sends per hour,
   5 wrong tries then a new code is needed. Only an HMAC of the code is stored. PASSWORD_OTP=off turns the
   code step off for CHANGE password (forgot password always needs a code). */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mailer = require('./mailer');
const sms = require('./sms');

const TTL_MIN = Math.min(Math.max(Number(process.env.PASSWORD_OTP_TTL_MIN) || 10, 1), 30);
const RESEND_SECONDS = 60, MAX_SENDS_PER_HOUR = 5, MAX_WRONG = 5;
const CHANNELS = ['email', 'sms'];

module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str, EMAIL_RE }) {
  const key = () => String(process.env.JWT_SECRET) + ':password-otp';
  const hmac = (uid, purpose, code) => crypto.createHmac('sha256', key()).update(uid + ':' + purpose + ':' + code).digest('hex');
  const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const maskEmail = (e) => { const [l, d] = String(e || '').split('@'); return l && d ? l.slice(0, 2) + '***@' + d : ''; };
  const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length < 4 ? '' : '+63 *** *** ' + d.slice(-4); };
  // The current password is never filled in by the system: the person types it, and it must be right.
  // 5 wrong tries in 15 minutes pause further tries for that account.
  const wrongCur = new Map();
  async function verifyCurrent(userId, plain) {
    const now = Date.now(), list = (wrongCur.get(userId) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (list.length >= 5) throw new ValidationError({ currentPassword: 'Too many wrong tries. Please wait a few minutes and try again.' });
    const cur = typeof plain === 'string' ? plain : '';
    if (!cur) throw new ValidationError({ currentPassword: 'Enter your current password' });
    const row = (await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [userId])).rows[0];
    if (!row || !(await bcrypt.compare(cur, row.password_hash))) {
      list.push(now); wrongCur.set(userId, list);
      throw new ValidationError({ currentPassword: 'Current password is incorrect' });
    }
    wrongCur.delete(userId);
  }
  const enabledForChange = () => String(process.env.PASSWORD_OTP || '').trim().toLowerCase() !== 'off';

  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(k, list); next();
  };

  const ready = pool.query(`CREATE TABLE IF NOT EXISTS password_otps (
      otp_id BIGSERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,                       -- 'reset' | 'change'
      channel TEXT NOT NULL,                       -- 'email' | 'sms'
      destination TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      wrong_tries INT NOT NULL DEFAULT 0,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
    .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_password_otps_user ON password_otps (user_id, purpose, created_at DESC)'))
    .catch((e) => console.warn('[db] could not prepare the password code table:', e.message));

  // can this account receive a code this way?  (a customer's mobile must be verified; staff numbers come from their invitation)
  const canEmail = (u) => !!u.email && !!u.email_verified_at;
  const canSms = (u) => !!sms.toE164(u.phone) && (u.role_key !== 'customer' || !!u.phone_verified_at);
  const loadUser = async (where, arg) => (await pool.query(
    `SELECT u.user_id, u.full_name, u.first_name, u.last_name, u.email, u.phone, u.email_verified_at, u.phone_verified_at, u.status, r.role_key, r.label
       FROM users u JOIN roles r USING (role_id) WHERE ${where}`, [arg])).rows[0];

  /* Make a code and send it. Returns { ok, sent, message, waitSeconds }. */
  async function issue(u, purpose, channel) {
    await ready;
    if (!CHANNELS.includes(channel)) return { ok: false, message: 'Choose email or text message.' };
    if (channel === 'email' && !canEmail(u)) return { ok: false, message: 'There is no verified email on this account.' };
    if (channel === 'sms' && !canSms(u)) return { ok: false, message: 'There is no verified mobile number on this account.' };
    const recent = (await pool.query(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM password_otps
        WHERE user_id = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`, [u.user_id, purpose])).rows[0];
    if (recent.last) {
      const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(recent.last).getTime()) / 1000);
      if (wait > 0) return { ok: true, sent: false, recent: true, waitSeconds: wait, message: 'A code was just sent. You can ask for another in ' + wait + ' seconds.' };
    }
    if (recent.n >= MAX_SENDS_PER_HOUR) return { ok: false, waitSeconds: 600, message: 'Too many codes were sent. Please try again in about an hour.' };

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const dest = channel === 'email' ? u.email : u.phone;
    await pool.query('UPDATE password_otps SET expires_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()', [u.user_id, purpose]);
    await pool.query(`INSERT INTO password_otps (user_id, purpose, channel, destination, code_hash, expires_at)
                      VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' minutes')::interval)`, [u.user_id, purpose, channel, dest, hmac(u.user_id, purpose, code), String(TTL_MIN)]);

    const why = purpose === 'reset' ? 'reset your password' : 'change your password';   // 'change-email' / 'change-sms' both say "change"
    let r;
    if (channel === 'sms') {
      r = await sms.sendSms({ to: u.phone, message: `Triple E Metal Products: your code to ${why} is ${code}. It expires in ${TTL_MIN} minutes. Do not share this code with anyone.` });
    } else {
      const name = u.first_name || u.full_name || 'there';
      const text = `Hi ${name},\n\nYour Triple E Metal Products code to ${why} is ${code}.\nIt expires in ${TTL_MIN} minutes. Do not share this code with anyone.\n\nIf you did not ask for this, ignore this email and your password stays the same.`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c2430">`
        + `<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f6fb8;font-weight:bold">Triple E Metal Products</div>`
        + `<p style="margin:14px 0 6px">Hi ${mailer.escapeHtml(name)},</p><p style="margin:0 0 14px">Your code to ${why} is:</p>`
        + `<p style="font-size:30px;letter-spacing:8px;font-weight:bold;margin:0 0 14px">${code}</p>`
        + `<p style="margin:0 0 8px">It expires in ${TTL_MIN} minutes. Do not share this code with anyone.</p>`
        + `<p style="margin:0;color:#5a6677;font-size:13px">If you did not ask for this, ignore this email and your password stays the same.</p></div>`;
      r = await mailer.sendMail({ to: u.email, subject: 'Your Triple E password code', html, text, tag: 'password-otp' });
    }
    if (!r.sent) console.warn(`[password-otp] ${channel} to ${dest} not sent: ${r.reason}  (test code: ${code})`);
    return { ok: true, sent: !!r.sent, waitSeconds: RESEND_SECONDS, expiresIn: TTL_MIN * 60,
      message: r.sent ? '' : (channel === 'sms' ? 'The text message could not be sent. Try email instead, or resend in a minute.' : 'The email could not be sent. Try a text message instead, or resend in a minute.') };
  }

  /* Check a code and (only when it is right) use it up. Throws ValidationError. */
  async function consume(client, userId, purpose, code) {
    await ready;
    code = str(code);
    if (!/^\d{6}$/.test(code)) throw new ValidationError({ code: 'Enter the 6-digit code.' });
    const o = (await client.query(
      `SELECT otp_id, code_hash, wrong_tries FROM password_otps
        WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`, [userId, purpose])).rows[0];
    if (!o) throw new ValidationError({ code: 'This code has expired. Ask for a new one.' });
    if (o.wrong_tries >= MAX_WRONG) throw new ValidationError({ code: 'Too many wrong tries. Ask for a new code.' });
    if (!same(o.code_hash, hmac(userId, purpose, code))) {
      await pool.query('UPDATE password_otps SET wrong_tries = wrong_tries + 1 WHERE otp_id = $1', [o.otp_id]);   // outside the transaction so the count survives a rollback
      throw new ValidationError({ code: 'That code is not right.' });
    }
    const used = await client.query('UPDATE password_otps SET used_at = now() WHERE otp_id = $1 AND used_at IS NULL RETURNING otp_id', [o.otp_id]);   // a code works once, even with two requests at the same time
    if (!used.rowCount) throw new ValidationError({ code: 'This code was already used. Ask for a new one.' });
  }
  // the ways this account can receive a CHANGE-password code (the person picks one)
  async function requiredChannels(userId) {
    const u = await loadUser('u.user_id = $1', userId);
    if (!u) return [];
    return [canEmail(u) ? 'email' : null, canSms(u) ? 'sms' : null].filter(Boolean);
  }
  app.locals.passwordOtp = { consume, enabledForChange, verifyCurrent, requiredChannels };

  /* ---------- FORGOT PASSWORD (not signed in) ---------- */
  const SAME_ANSWER = 'If that account exists and can receive a code that way, we sent one. It expires in ' + TTL_MIN + ' minutes.';

  app.post('/api/auth/forgot/send', limit('forgot-send', 15, 60 * 60 * 1000), wrap(async (req, res) => {
    const email = str(req.body && req.body.email).toLowerCase();
    const channel = str(req.body && req.body.channel);
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter the email address of your account.' });
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'Choose email or text message.' });
    const u = await loadUser('u.email = $1', email);
    let wait = RESEND_SECONDS;
    if (u && u.status === 'active') {
      const r = await issue(u, 'reset', channel).catch((e) => { console.warn('[password-otp]', e.message); return {}; });
      if (r.waitSeconds) wait = r.waitSeconds;
    }
    res.json({ ok: true, message: SAME_ANSWER, waitSeconds: wait, expiresIn: TTL_MIN * 60 });   // same answer whether or not the account exists
  }));

  app.post('/api/auth/forgot/reset', limit('forgot-reset', 20, 15 * 60 * 1000), wrap(async (req, res) => {
    const b = req.body || {};
    const email = str(b.email).toLowerCase();
    const next = typeof b.newPassword === 'string' ? b.newPassword : '';
    const generic = { code: 'That code is not right or has expired. Ask for a new one.' };
    if (!EMAIL_RE.test(email)) throw new ValidationError({ email: 'Enter the email address of your account.' });
    if (next !== b.confirmPassword) throw new ValidationError({ confirmPassword: 'Passwords do not match' });
    const u = await loadUser('u.email = $1', email);
    if (!u || u.status !== 'active') throw new ValidationError(generic);
    const problem = app.locals.passwordProblem ? app.locals.passwordProblem(next, { email: u.email, names: [u.first_name, u.last_name] }) : (next.length < 8 ? 'Password must be at least 8 characters' : '');
    if (problem) throw new ValidationError({ newPassword: problem });
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(next, 12);
    await tx(async (client) => {
      await consume(client, u.user_id, 'reset', b.code);
      await client.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, u.user_id]);
      if (app.locals.sessionRevocation) await app.locals.sessionRevocation.bump(client, u.user_id);   // a reset signs the account out everywhere (someone else may have had the old password)
      if (app.locals.userSessions) await app.locals.userSessions.revokeOthers(client, u.user_id, null, 'password');   // ...and frees every device's place
      await audit(client, { id: u.user_id, name: u.full_name, roleLabel: u.label }, 'Profile updated', 'Reset password with a one-time code');
      await client.query('DELETE FROM login_lockouts WHERE user_id = $1', [u.user_id]).catch(() => {});   // proving the email/phone also lifts a sign-in lock
    });
    if (app.locals.forgetAccountCheck) app.locals.forgetAccountCheck(u.user_id);
    res.json({ ok: true });
  }));

  /* ---------- CHANGE PASSWORD (signed in) ---------- */
  app.get('/api/auth/password/options', auth(), wrap(async (req, res) => {
    const u = await loadUser('u.user_id = $1', req.user.id);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    res.json({ required: enabledForChange(),
      email: canEmail(u) ? { masked: maskEmail(u.email) } : null,
      sms: canSms(u) ? { masked: maskPhone(u.phone) } : null });
  }));

  // step 1 of changing the password: nothing is changed and no code is sent until the current password is right
  app.post('/api/auth/password/check', auth(), limit('pw-check', 30, 60 * 60 * 1000), wrap(async (req, res) => {
    const b = req.body || {};
    const next = typeof b.newPassword === 'string' ? b.newPassword : '';
    const u = await loadUser('u.user_id = $1', req.user.id);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    await verifyCurrent(req.user.id, b.currentPassword);                       // current password FIRST
    const problem = app.locals.passwordProblem ? app.locals.passwordProblem(next, { email: u.email, names: [u.first_name, u.last_name] }) : (next.length < 8 ? 'Password must be at least 8 characters' : '');
    if (problem) throw new ValidationError({ newPassword: problem });
    if (next === b.currentPassword) throw new ValidationError({ newPassword: 'New password must be different from the current one' });
    if (next !== b.confirmPassword) throw new ValidationError({ confirmPassword: 'Passwords do not match' });
    res.json({ ok: true, required: enabledForChange(),
      email: canEmail(u) ? { masked: maskEmail(u.email) } : null,
      sms: canSms(u) ? { masked: maskPhone(u.phone) } : null });
  }));

  app.post('/api/auth/password/otp', auth(), limit('pw-otp', 20, 60 * 60 * 1000), wrap(async (req, res) => {
    const u = await loadUser('u.user_id = $1', req.user.id);
    if (!u) return res.status(401).json({ error: 'Not signed in' });
    await verifyCurrent(req.user.id, req.body && req.body.currentPassword);    // no code for someone who does not know the current password
    const channel = str(req.body && req.body.channel);
    if (!CHANNELS.includes(channel)) return res.status(400).json({ error: 'Choose email or text message.' });
    const r = await issue(u, 'change-' + channel, channel);          // each channel keeps its own code, so a code sent to one cannot be used for the other
    if (!r.ok) return res.status(r.waitSeconds ? 429 : 400).json({ error: r.message, waitSeconds: r.waitSeconds || 0 });
    res.json({ ok: true, sent: r.sent, recent: !!r.recent, waitSeconds: r.waitSeconds || 0, expiresIn: r.expiresIn || 0, message: r.message || '' });
  }));

};