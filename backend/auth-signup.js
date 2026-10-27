/* Sign-up routes.

   Customers  : sign up directly on the sign-in page (no code).             POST /api/signup/customer
   Staff      : an admin (finance) invites them by email; the email holds a
                one-time sign-up link, sent through Mailgun (mailer.js).     POST /api/invitations ...
                The link opens Login_Inventory.html?invite=<token>           GET/POST /api/signup/invite/:token
                Verification is the same two steps as a customer: 1) email - done by opening the invitation link
                (it was sent to that address), 2) mobile number - 6-digit text code (phone-otp.js), then sign in.

   Only a SHA-256 hash of the invite token is stored, so a copy of the database cannot be used to sign up.
   A link works once, expires (INVITE_TTL_HOURS, default 72) and is replaced when the admin resends it. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mailer = require('./mailer');

const INVITE_TTL_HOURS = Math.min(Math.max(Number(process.env.INVITE_TTL_HOURS) || 72, 1), 24 * 14);
// Finance can also set up a CUSTOMER account (User Management); the customer chooses their own password from the link
// Staff only: customers register themselves on the sign-in page, so Finance cannot invite them.
const INVITE_ROLES = { finance: 'Finance-Admin Officer', cashier: 'Sales Staff / Cashier' };
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NAME_RE = /^\p{L}[\p{L}\p{M} ]*$/u;          // letters and spaces only (no digits, symbols, dots, dashes)
const titleCase = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase());
const ADULT_AGE = 18;
const BAD_LINK = 'This sign-up link is invalid or has expired. Ask your administrator to send a new one.';

const SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];
const GENDERS = ['Male', 'Female', 'Other', 'Prefer Not to Say'];
const TERMS_VERSION = process.env.TERMS_VERSION || '2026-10';          // bump when the Terms / Privacy text changes
const VERIFY_TTL_HOURS = Math.min(Math.max(Number(process.env.EMAIL_VERIFY_TTL_HOURS) || 24, 1), 24 * 7);
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword1', 'qwerty123',
  'qwertyuiop', 'qwerty12345', '12345678', '123456789', '1234567890', 'iloveyou', 'admin123', 'letmein123', 'welcome1', 'welcome123',
  'abc12345', 'triplee123', 'tripleemetal', 'metal123']);

module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str, text, EMAIL_FORMAT, phoneError, phMobile, assertEmailDomain, emailVerificationOn, phoneVerificationOn, TZ }) {

  /* ---------- helpers ---------- */
  const newToken = () => crypto.randomBytes(32).toString('base64url');
  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

  // very small per-IP limiter for the public routes (resets when the server restarts)
  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const key = name + ':' + req.ip, now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
    next();
  };

  // ctx = { email, names[] } so a password cannot simply be the person's own email / name
  function passwordProblem(pw, ctx = {}) {
    if (typeof pw !== 'string' || !pw) return 'Choose a password';
    if (pw.length < 8) return 'Password must be at least 8 characters';
    if (Buffer.byteLength(pw, 'utf8') > 72) return 'Password is too long (72 characters at most)';   // bcrypt ignores everything after 72 bytes
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/\d/.test(pw) || !/[^A-Za-z0-9]/.test(pw))
      return 'Password needs an uppercase letter, a lowercase letter, a number and a symbol';
    const low = pw.toLowerCase();
    if (COMMON_PASSWORDS.has(low) || COMMON_PASSWORDS.has(low.replace(/[^a-z0-9]/g, ''))) return 'That password is too common. Choose something harder to guess';
    const local = String(ctx.email || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && low.includes(local)) return 'Password must not contain your email name';
    for (const n of (ctx.names || [])) if (String(n).length >= 4 && low.includes(String(n).toLowerCase())) return 'Password must not contain your name';
    return '';
  }
  app.locals.passwordProblem = passwordProblem;     // password-otp.js uses the same rules for "forgot password"

  /* Name: new form sends firstName / middleName / lastName / suffix; the old form sent one `name` (still accepted). */
  function nameParts(e, b) {
    const label = { firstName: 'First name', middleName: 'Middle name', lastName: 'Last name' };
    let first, middle = '', last = '', suffix = '', structured = false;
    if (b.firstName !== undefined || b.lastName !== undefined || b.middleName !== undefined) {
      structured = true;
      first = text(e, 'firstName', b.firstName, label.firstName, { min: 2, max: 50 });
      middle = text(e, 'middleName', b.middleName, label.middleName, { min: 2, max: 50, required: false });
      last = text(e, 'lastName', b.lastName, label.lastName, { min: 2, max: 50 });
      for (const [k, v] of [['firstName', first], ['middleName', middle], ['lastName', last]])
        if (v && !e[k] && !NAME_RE.test(v)) e[k] = label[k] + ' can only have letters and spaces';
      if (middle && !e.middleName && (middle.match(/\p{L}/gu) || []).length < 2) e.middleName = 'Middle name must have at least 2 letters (or leave it empty)';
      // stored in Title Case ("juan DELA cruz" -> "Juan Dela Cruz")
      if (!e.firstName) first = titleCase(first);
      if (!e.middleName) middle = titleCase(middle);
      if (!e.lastName) last = titleCase(last);
      suffix = str(b.suffix);
      if (suffix && !SUFFIXES.includes(suffix)) e.suffix = 'Choose a valid suffix';
    } else {
      first = text(e, 'name', b.name, 'Full name', { min: 2, max: 100 });
      if (first && !e.name && !NAME_RE.test(first)) e.name = 'Full name can only have letters and spaces';
      if (first && !e.name) first = titleCase(first);
    }
    const full = [first, middle, last, suffix].filter(Boolean).join(' ');
    if (structured && full.length > 100 && !e.firstName && !e.lastName) e.lastName = 'Full name is too long';
    return { first, middle, last, suffix, full, structured };
  }

  function birthdateError(s, today) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return 'Enter a valid birthdate';
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return 'Enter a valid birthdate';
    if (+m[1] < 1900) return 'Enter a valid birthdate';
    if (s > today) return 'Birthdate cannot be in the future';
    return '';
  }
  // latest birthdate that is still 18 or older today (Feb 29 -> Feb 28 in non-leap years)
  function adultCutoff(today) {
    const y = +today.slice(0, 4) - ADULT_AGE, md = today.slice(5);
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return y + '-' + (md === '02-29' && !leap ? '02-28' : md);
  }
  // personal details: birthdate + gender. { adult: true } (sign-up) = birthdate is required and the person must be 18 or older.
  function optionalDetails(e, b, { adult = false } = {}) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const birthdate = str(b.birthdate);
    if (!birthdate && adult) e.birthdate = 'Birthdate is required';
    if (birthdate) {
      const m = birthdateError(birthdate, today);
      if (m) e.birthdate = m;
      else if (adult && birthdate > adultCutoff(today)) e.birthdate = `You must be at least ${ADULT_AGE} years old to register`;
    }
    const g = str(b.gender);
    let gender = null;
    if (g) { gender = GENDERS.find((x) => x.toLowerCase() === g.toLowerCase()) || null; if (!gender) e.gender = 'Choose one of the listed options'; }
    return { birthdate: birthdate && !e.birthdate ? birthdate : null, gender };
  }
  // optional company information (My Profile)
  function companyDetails(e, b) {
    const companyName = text(e, 'companyName', b.companyName, 'Company name', { min: 2, max: 120, required: false });
    const companyPosition = text(e, 'companyPosition', b.companyPosition, 'Position', { max: 80, required: false });
    const companyTin = str(b.companyTin);
    if (companyTin && !/^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/.test(companyTin)) e.companyTin = 'TIN must be 9 or 12 digits, e.g. 123-456-789-000';
    return { companyName: companyName || null, companyPosition: companyPosition || null, companyTin: companyTin || null };
  }
  function mobileField(e, raw) {
    const r = phMobile(raw);
    if (r.error) { e.phone = r.error; return ''; }
    return r.value;
  }
  function consent(e, b) {
    if (b.acceptTerms !== true) e.acceptTerms = 'You must agree to the Terms and Conditions to continue';
    if (b.acceptPrivacy !== true) e.acceptPrivacy = 'Please acknowledge the Privacy Policy to continue';
  }
  app.locals.accountHelpers = { nameParts, optionalDetails, companyDetails, mobileField, SUFFIXES, GENDERS };

  // username is required by the users table; build one from the email and make it unique
  async function makeUsername(client, email) {
    let base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 24);
    if (base.length < 3) base = (base + 'user').slice(0, 24);
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : base.slice(0, 24) + Math.floor(100 + Math.random() * 9000);
      const taken = await client.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
      if (!taken.rowCount) return candidate;
    }
    return base + crypto.randomBytes(3).toString('hex');
  }

  async function createUser(client, { name, parts, email, phone, hash, roleKey, details = {}, verified }) {
    const taken = await client.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    if (taken.rowCount) throw new ValidationError({ email: emailTakenMsg(taken.rows[0]) });
    const username = await makeUsername(client, email);
    try {
      const r = await client.query(
        `INSERT INTO users (full_name, username, email, password_hash, role_id, phone,
                            first_name, middle_name, last_name, suffix, birthdate, gender,
                            terms_accepted_at, privacy_accepted_at, terms_version, email_verified_at)
         VALUES ($1,$2,$3,$4,(SELECT role_id FROM roles WHERE role_key = $5),$6,$7,$8,$9,$10,$11,$12, now(), now(), $13,
                 CASE WHEN $14::boolean THEN now() END)
         RETURNING user_id`,
        [name, username, email, hash, roleKey, phone, parts.structured ? parts.first : null, parts.middle || null,
         parts.structured ? parts.last : null, parts.suffix || null, details.birthdate || null, details.gender || null,
         TERMS_VERSION + '-' + roleKey, !!verified]);   // e.g. 2026-10-customer / 2026-10-cashier / 2026-10-finance
      return r.rows[0].user_id;
    } catch (err) {
      if (err.code === '23505') throw new ValidationError({ email: 'That email already has an account. Try signing in instead.' });
      throw err;
    }
  }
  const emailTakenMsg = (row) => row && !row.email_verified_at
    ? 'That email is registered but not verified yet. Sign in to request a new verification email.'
    : 'That email already has an account. Try signing in instead.';

  /* ---------- email verification ---------- */
  const baseUrl = (req) => (process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const verifyLink = (req, token) => baseUrl(req) + '/Login_Inventory.html?verify=' + token;
  // new link for this user; any older unused link stops working
  async function issueVerification(db, userId, newEmail) {
    const token = newToken();
    await db.query('UPDATE email_verifications SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [userId]);
    await db.query(
      `INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at)
       VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval)`, [userId, newEmail || null, hashToken(token), String(VERIFY_TTL_HOURS)]);
    return token;
  }
  const mailVerification = (req, { to, name, token, change }) =>
    mailer.sendVerificationEmail({ to, recipientName: name, verifyUrl: verifyLink(req, token), expiresHours: VERIFY_TTL_HOURS, change: !!change });
  // used by My Profile when a customer asks to change their email
  app.locals.startEmailVerification = async (req, { userId, name, to, change }) => {
    const token = await issueVerification(pool, userId, change ? to : null);
    return mailVerification(req, { to, name, token, change });
  };

  /* =====================================================
     Database: make the invitations table fit link-based invites (safe to run every time)
  ===================================================== */
  async function ensureAccountSchema() {
    try {
      // existing accounts count as verified; only accounts created from now on must verify (runs the backfill once, when the column is added)
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified_at') THEN
          ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
          UPDATE users SET email_verified_at = COALESCE(created_at, now());
        END IF; END $$`);
      for (const col of ['first_name TEXT', 'middle_name TEXT', 'last_name TEXT', 'suffix TEXT', 'birthdate DATE', 'gender TEXT',
        'company_name TEXT', 'company_position TEXT', 'company_tin TEXT', 'terms_accepted_at TIMESTAMPTZ', 'privacy_accepted_at TIMESTAMPTZ', 'terms_version TEXT'])
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col}`);
      await pool.query(`CREATE TABLE IF NOT EXISTS email_verifications (
        verification_id BIGSERIAL PRIMARY KEY,
        user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        new_email       TEXT,
        token_hash      TEXT NOT NULL UNIQUE,
        expires_at      TIMESTAMPTZ NOT NULL,
        used_at         TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_email_verif_user ON email_verifications (user_id)');
    } catch (err) { console.warn('[db] could not prepare the customer account tables:', err.message); }
  }
  const ready = ensureAccountSchema();
  app.locals.accountReady = ready;

  (async function ensureInvitationColumns() {
    try {
      await pool.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invitations' AND column_name = 'code') THEN
          ALTER TABLE invitations ALTER COLUMN code DROP NOT NULL;   -- the old 6-digit code is no longer used
        END IF; END $$`);
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS token_hash TEXT');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS full_name TEXT');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NOT NULL DEFAULT now()');
      await pool.query('ALTER TABLE invitations ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_key ON invitations (token_hash)');
    } catch (err) { console.warn('[db] could not check the invitations columns:', err.message); }
  })();

  /* =====================================================
     CUSTOMERS — direct sign-up, no code
  ===================================================== */
  // live "is this email free?" check for the sign-up form
  app.get('/api/signup/check-email', limit('check-email', 40, 10 * 60 * 1000), wrap(async (req, res) => {
    const email = str(req.query.email).toLowerCase();
    if (!email || email.length > 254 || !EMAIL_FORMAT.test(email)) return res.json({ available: false, message: 'Enter a valid email address' });
    try { await assertEmailDomain(email); }
    catch (err) { if (err instanceof ValidationError) return res.json({ available: false, message: err.message }); throw err; }
    const r = await pool.query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
    res.json({ available: !r.rowCount, message: r.rowCount ? emailTakenMsg(r.rows[0]) : '' });
  }));

  // live "is this mobile number already on an account?" check (a warning on the form, not a block: a shared business line is allowed)
  app.get('/api/signup/check-phone', limit('check-phone', 40, 10 * 60 * 1000), wrap(async (req, res) => {
    const m = phMobile(str(req.query.phone));
    if (m.error) return res.json({ valid: false, used: false, message: m.error });
    const key = m.value.replace(/\D/g, '').slice(-10);
    const r = await pool.query(`SELECT 1 FROM users WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = $1 LIMIT 1`, [key]);
    res.json({ valid: true, phone: m.value, used: r.rowCount > 0,
      message: r.rowCount ? 'This mobile number is already on another account. If it is yours, sign in instead (or use Forgot password).' : '' });
  }));

  app.post('/api/signup/customer', limit('signup', 10, 60 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const b = req.body || {};
    const asked = str(b.role) || str(b.roleKey);
    if (asked && asked !== 'customer') throw new ValidationError({ role: 'Staff accounts are created by invitation only.' });   // the role is never chosen here
    const e = {};
    const parts = nameParts(e, b);
    const details = optionalDetails(e, b, { adult: true });
    const email = str(b.email).toLowerCase();
    if (!email) e.email = 'Email is required';
    else if (email.length > 254 || !EMAIL_FORMAT.test(email)) e.email = 'Enter a valid email address';
    const phone = mobileField(e, b.phone);
    const pw = passwordProblem(b.password, { email, names: [parts.first, parts.last] });
    if (pw) e.password = pw;
    else if (b.confirmPassword !== b.password) e.confirmPassword = 'Passwords do not match';
    consent(e, b);
    if (Object.keys(e).length) throw new ValidationError(e);
    await assertEmailDomain(email);                         // personal address that can really receive mail

    const hash = await bcrypt.hash(b.password, 12);
    const needVerify = !!emailVerificationOn;
    let token = null;
    await tx(async (client) => {
      const id = await createUser(client, { name: parts.full, parts, email, phone, hash, roleKey: 'customer', details, verified: !needVerify });
      if (needVerify) token = await issueVerification(client, id, null);
      await audit(client, { id, name: parts.full, roleLabel: 'Customer' }, 'Account created', 'Customer signed up');
    });
    let sent = { sent: false };
    if (needVerify) sent = await mailVerification(req, { to: email, name: parts.first || parts.full, token });
    // step 2 (mobile code) is only texted after the email is verified; the page asks for it then. Here we only hand out the pending token.
    let phoneRequired = false, pendingToken = null;
    if (phoneVerificationOn) {
      await app.locals.phoneReady;
      const uid = (await pool.query('SELECT user_id FROM users WHERE email = $1', [email])).rows[0].user_id;
      phoneRequired = true;
      pendingToken = app.locals.phoneOtp.issuePendingToken(uid);
    }
    res.status(201).json({ ok: true, verificationRequired: needVerify || phoneRequired, emailRequired: needVerify, phoneRequired, pendingToken,
      emailSent: !!sent.sent, email,
      message: needVerify && !sent.sent ? 'Your account was created, but the verification email could not be sent (' + sent.reason + '). Use Resend in a minute.' : '' });
  }));

  /* ---------- verify an email address (public) ---------- */
  const BAD_VERIFY = 'This verification link is invalid or has expired. Sign in to request a new one.';
  app.post('/api/auth/verify-email', limit('verify', 20, 15 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const token = str(req.body && req.body.token);
    if (!TOKEN_RE.test(token)) return res.status(400).json({ error: BAD_VERIFY });
    const out = await tx(async (client) => {
      const r = await client.query(
        `SELECT v.verification_id, v.user_id, v.new_email, u.full_name, ro.label
           FROM email_verifications v JOIN users u ON u.user_id = v.user_id JOIN roles ro ON ro.role_id = u.role_id
          WHERE v.token_hash = $1 AND v.used_at IS NULL AND v.expires_at > now() FOR UPDATE OF v`, [hashToken(token)]);
      const v = r.rows[0];
      if (!v) return null;
      if (v.new_email) {
        const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND user_id <> $2', [v.new_email, v.user_id]);
        if (taken.rowCount) throw new ValidationError({ email: 'That email is now used by another account.' });
        await client.query('UPDATE users SET email = $1, email_verified_at = now() WHERE user_id = $2', [v.new_email, v.user_id]);
      } else {
        await client.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE user_id = $1', [v.user_id]);
      }
      await client.query('UPDATE email_verifications SET used_at = now() WHERE verification_id = $1', [v.verification_id]);
      await client.query('UPDATE email_verifications SET expires_at = now() WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()', [v.user_id]);
      await audit(client, { id: v.user_id, name: v.full_name, roleLabel: v.label }, v.new_email ? 'Profile updated' : 'Account verified',
        v.new_email ? 'Changed email (verified)' : 'Email address verified');
      return { emailChanged: !!v.new_email, userId: v.user_id };
    });
    if (!out) return res.status(400).json({ error: BAD_VERIFY });
    // A new customer who still has to confirm the mobile number goes straight on to the code step: the link proves the email is theirs,
    // so they get a pending token that can only be used for the mobile-code step (never a login session).
    const reply = { ok: true, emailChanged: out.emailChanged, phoneRequired: false };
    if (!out.emailChanged && phoneVerificationOn) {
      await app.locals.phoneReady;
      const u = (await pool.query('SELECT email, phone, phone_verified_at FROM users WHERE user_id = $1 AND status = \'active\'', [out.userId])).rows[0];
      if (u && u.phone && !u.phone_verified_at) {
        reply.phoneRequired = true; reply.email = u.email;
        reply.pendingToken = app.locals.phoneOtp.issuePendingToken(out.userId);
      }
    }
    res.json(reply);
  }));

  // sign-in page: "send me a new link". Same answer whether or not the account exists.
  app.post('/api/auth/resend-verification', limit('resend-verify', 6, 60 * 60 * 1000), wrap(async (req, res) => {
    await ready;
    const email = str(req.body && req.body.email).toLowerCase();
    const reply = { ok: true, message: 'If that account is waiting for verification, we sent a new link. Check your inbox (and spam).' };
    if (!email || email.length > 254 || !EMAIL_FORMAT.test(email)) return res.json(reply);
    const r = await pool.query(
      `SELECT u.user_id, u.full_name, u.first_name,
              (SELECT max(created_at) FROM email_verifications v WHERE v.user_id = u.user_id) AS last_sent
         FROM users u JOIN roles ro ON ro.role_id = u.role_id
        WHERE u.email = $1 AND ro.role_key = 'customer' AND u.email_verified_at IS NULL AND u.status = 'active'`, [email]);
    const u = r.rows[0];
    if (u && !(u.last_sent && Date.now() - new Date(u.last_sent).getTime() < 60 * 1000)) {      // at most one email a minute per account
      const token = await issueVerification(pool, u.user_id, null);
      await mailVerification(req, { to: email, name: u.first_name || u.full_name, token });
    }
    res.json(reply);
  }));

  /* =====================================================
     STAFF — admin sends an invite link by email
  ===================================================== */
  const linkFor = (req, token) => baseUrl(req) + '/Login_Inventory.html?invite=' + token;

  async function sendInvite(req, { email, name, roleKey, token }) {
    return mailer.sendCashierInvite({
      to: email, recipientName: name, roleLabel: INVITE_ROLES[roleKey], inviterName: req.user.name,
      signupUrl: linkFor(req, token), expiresHours: INVITE_TTL_HOURS
    });
  }
  const mailNote = (r) => r.sent ? '' : 'The invitation was saved, but the email could not be sent (' + r.reason + '). Use Resend once this is fixed.';

  // invite a new team member
  app.post('/api/invitations', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const e = {};
    const name = text(e, 'name', b.name, 'Full name', { min: 2, max: 100 });
    if (name && !e.name && !NAME_RE.test(name)) e.name = 'Full name can only have letters, spaces, . \' and -';
    const email = str(b.email).toLowerCase();
    if (!email) e.email = 'Email is required';
    else if (email.length > 254 || !EMAIL_FORMAT.test(email)) e.email = 'Enter a valid email address';
    const roleKey = str(b.role);
    if (!INVITE_ROLES[roleKey]) e.role = 'Choose a role';
    if (Object.keys(e).length) throw new ValidationError(e);
    await assertEmailDomain(email);

    const token = newToken();
    const id = await tx(async (client) => {
      if ((await client.query('SELECT 1 FROM users WHERE email = $1', [email])).rowCount)
        throw new ValidationError({ email: 'That email already has an account' });
      // a newer invite replaces any older unused one for the same email
      await client.query('UPDATE invitations SET revoked_at = now() WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL', [email]);
      const r = await client.query(
        `INSERT INTO invitations (email, full_name, role_id, token_hash, expires_at, created_by)
         VALUES ($1,$2,(SELECT role_id FROM roles WHERE role_key = $3),$4, now() + ($5 || ' hours')::interval, $6)
         RETURNING invitation_id`, [email, name, roleKey, hashToken(token), String(INVITE_TTL_HOURS), req.user.id]);
      await audit(client, req.user, 'Record added', `Invitation sent to ${email} (${INVITE_ROLES[roleKey]})`);
      return r.rows[0].invitation_id;
    });
    const sent = await sendInvite(req, { email, name, roleKey, token });
    res.status(201).json({ id, emailSent: sent.sent, message: mailNote(sent) });
  }));

  // pending invitations (not used, not cancelled)
  app.get('/api/invitations', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT i.invitation_id, i.email, i.full_name, r.role_key, r.label, i.expires_at < now() AS expired,
              to_char(i.sent_at AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS sent_at
         FROM invitations i JOIN roles r USING (role_id)
        WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.token_hash IS NOT NULL
        ORDER BY i.sent_at DESC`, [TZ]);
    res.json(rows.map((i) => ({ id: i.invitation_id, name: i.full_name || '', email: i.email, role: i.label,
      roleKey: i.role_key, sent: i.sent_at, status: i.expired ? 'expired' : 'pending' })));
  }));

  // send a fresh link (the old one stops working)
  app.post('/api/invitations/:id/resend', auth('finance'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Invitation not found' });
    const token = newToken();
    const inv = await tx(async (client) => {
      const r = await client.query(
        `SELECT i.email, i.full_name, r.role_key FROM invitations i JOIN roles r USING (role_id)
          WHERE i.invitation_id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL FOR UPDATE OF i`, [id]);
      if (!r.rowCount) throw new ValidationError({ invitation: 'That invitation is no longer pending' });
      if ((await client.query('SELECT 1 FROM users WHERE email = $1', [r.rows[0].email])).rowCount)
        throw new ValidationError({ invitation: 'That email already has an account' });
      await client.query(
        `UPDATE invitations SET token_hash = $2, expires_at = now() + ($3 || ' hours')::interval, sent_at = now() WHERE invitation_id = $1`,
        [id, hashToken(token), String(INVITE_TTL_HOURS)]);
      await audit(client, req.user, 'Record edited', `Invitation re-sent to ${r.rows[0].email}`);
      return r.rows[0];
    });
    const sent = await sendInvite(req, { email: inv.email, name: inv.full_name, roleKey: inv.role_key, token });
    res.json({ emailSent: sent.sent, message: mailNote(sent) });
  }));

  // cancel an invitation
  app.delete('/api/invitations/:id', auth('finance'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Invitation not found' });
    const r = await pool.query(
      'UPDATE invitations SET revoked_at = now() WHERE invitation_id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING email', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'That invitation is no longer pending' });
    await audit(pool, req.user, 'Record edited', `Invitation cancelled for ${r.rows[0].email}`);
    res.json({ ok: true });
  }));

  /* ---------- the person opening the link (public) ---------- */
  const PENDING_SQL = `SELECT i.invitation_id, i.email, i.full_name, r.role_key, r.label
      FROM invitations i JOIN roles r USING (role_id)
     WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`;

  app.get('/api/signup/invite/:token', limit('invite-look', 30, 15 * 60 * 1000), wrap(async (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: BAD_LINK });
    const { rows } = await pool.query(PENDING_SQL, [hashToken(req.params.token)]);
    const i = rows[0];
    if (!i) return res.status(404).json({ error: BAD_LINK });
    res.json({ name: i.full_name || '', email: i.email, role: i.role_key, roleLabel: i.label,
      department: i.role_key === 'finance' ? 'Finance' : 'Sales' });
  }));

  app.post('/api/signup/invite/:token', limit('invite-accept', 15, 15 * 60 * 1000), wrap(async (req, res) => {
    if (!TOKEN_RE.test(req.params.token)) return res.status(404).json({ error: BAD_LINK });
    const b = req.body || {};
    const e = {};
    await ready;
    await app.locals.phoneReady;                          // the phone_verified_at column must exist before the account is made
    // the invited address is known up front, so the password can be checked against it (same rule as customers)
    const invited = (await pool.query(PENDING_SQL, [hashToken(req.params.token)])).rows[0];
    if (!invited) return res.status(404).json({ error: BAD_LINK });
    const parts = nameParts(e, b);
    const details = optionalDetails(e, b, { adult: true });
    const name = parts.full;
    const phone = mobileField(e, b.phone);
    const pw = passwordProblem(b.password, { email: invited.email, names: [parts.first, parts.last] });
    if (pw) e.password = pw;
    else if (b.confirmPassword !== undefined && b.confirmPassword !== b.password) e.confirmPassword = 'Passwords do not match';
    consent(e, b);
    if (Object.keys(e).length) throw new ValidationError(e);

    const hash = await bcrypt.hash(b.password, 12);
    const made = await tx(async (client) => {
      const r = await client.query(PENDING_SQL + ' FOR UPDATE OF i', [hashToken(req.params.token)]);
      const i = r.rows[0];
      if (!i) { const err = new Error('bad link'); err.badLink = true; throw err; }
      // Step 1 (email) is done: the invitation went to this address and the link was opened, so it is already proven.
      // Step 2 (mobile code) is still owed - phone_verified_at stays empty until the 6-digit code is entered.
      const id = await createUser(client, { name, parts, email: i.email, phone, hash, roleKey: i.role_key, details, verified: true });
      await client.query('UPDATE invitations SET used_at = now() WHERE invitation_id = $1', [i.invitation_id]);
      await audit(client, { id, name, roleLabel: i.label }, 'Account created', 'Signed up from an invitation link (email verified by the invitation)');
      return { id, roleKey: i.role_key, email: i.email };
    }).catch((err) => { if (err.badLink) return null; throw err; });
    if (!made) return res.status(404).json({ error: BAD_LINK });

    // same hand-off as a customer: a short-lived pending token that can only be used for the mobile-code step (never a login session)
    const phoneRequired = !!phoneVerificationOn;
    const pendingToken = phoneRequired ? app.locals.phoneOtp.issuePendingToken(made.id) : null;
    res.status(201).json({ ok: true, role: made.roleKey, email: made.email,
      verificationRequired: phoneRequired, emailRequired: false, phoneRequired, pendingToken });
  }));
};