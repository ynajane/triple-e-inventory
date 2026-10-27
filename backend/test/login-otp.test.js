/* login-otp.test.js — evidence for the second factor on every sign-in (OWASP A07, ASVS V2.8/V3.3). No database or network needed:
   the login_otps table is simulated in memory, mail and SMS senders are replaced so the test can read the code.
     node test/login-otp.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
delete process.env.LOGIN_OTP;
const mailer = require('../mailer');
const sms = require('../sms');

/* ---- in-memory stand-in for the few statements login-otp.js runs ---- */
function makeDb(user) {
  const db = { otps: [], audits: [], user, seq: 0 };
  const now = () => Date.now();
  db.run = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [], rowCount: 0 };
    if (/FROM users u JOIN roles r/i.test(s)) return { rows: db.user && db.user.user_id === p[0] ? [db.user] : [] };
    if (/count\(\*\)::int AS n, max\(created_at\)/i.test(s)) {
      const mine = db.otps.filter((o) => o.user_id === p[0] && now() - o.created_at < 3600000);
      const open = db.otps.filter((o) => o.user_id === p[0] && !o.used_at).sort((a, b) => b.created_at - a.created_at)[0];
      const latest = db.otps.filter((o) => o.user_id === p[0]).sort((a, b) => b.created_at - a.created_at || b.otp_id - a.otp_id)[0];
      return { rows: [{ n: mine.length, last: mine.length ? new Date(Math.max(...mine.map((o) => o.created_at))) : null, expires_in: open ? Math.floor((open.expires_at - now()) / 1000) : null, last_channel: latest ? latest.channel : null }] };
    }
    if (/^UPDATE login_otps SET expires_at = now\(\) WHERE user_id/i.test(s)) { db.otps.filter((o) => o.user_id === p[0] && !o.used_at && o.expires_at > now()).forEach((o) => { o.expires_at = now(); }); return { rows: [] }; }
    if (/^INSERT INTO login_otps/i.test(s)) { db.otps.push({ otp_id: ++db.seq, user_id: p[0], channel: p[1], destination: p[2], code_hash: p[3], expires_at: now() + Number(p[4]) * 60000, wrong_tries: 0, used_at: null, created_at: now() }); return { rows: [] }; }
    if (/FROM login_otps WHERE user_id = \$1 AND used_at IS NULL AND expires_at > now\(\)/i.test(s)) {
      const o = db.otps.filter((x) => x.user_id === p[0] && !x.used_at && x.expires_at > now()).sort((a, b) => b.created_at - a.created_at)[0];
      return { rows: o ? [o] : [] };
    }
    if (/^UPDATE login_otps SET expires_at = now\(\) WHERE otp_id/i.test(s)) { db.otps.find((o) => o.otp_id === p[0]).expires_at = now(); return { rows: [] }; }
    if (/SET wrong_tries = wrong_tries \+ 1/i.test(s)) { db.otps.find((o) => o.otp_id === p[0]).wrong_tries++; return { rows: [] }; }
    if (/SET used_at = now\(\) WHERE otp_id/i.test(s)) { const o = db.otps.find((x) => x.otp_id === p[0] && !x.used_at); if (o) o.used_at = now(); return { rows: o ? [{ otp_id: o.otp_id }] : [], rowCount: o ? 1 : 0 }; }
    if (/^INSERT INTO audit_log/i.test(s)) { db.audits.push({ action: p[3], detail: p[4] }); return { rows: [] }; }
    throw new Error('unexpected SQL in test: ' + s.slice(0, 100));
  };
  return db;
}

const CUSTOMER = { user_id: 7, full_name: 'Ana Cruz', first_name: 'Ana', email: 'ana@example.com', phone: '09171234567', phone_verified_at: new Date(), status: 'active', role_key: 'customer', label: 'Customer' };

async function start(userOverrides, opts = {}) {
  const db = makeDb({ ...CUSTOMER, ...(userOverrides || {}) });
  const sentMail = [], sentSms = [], alerts = [];
  mailer.sendMail = async (m) => { sentMail.push(m); return { sent: opts.mailFails ? false : true, reason: 'down' }; };
  sms.sendSms = async (m) => { sentSms.push(m); return { sent: true }; };
  const pool = { query: db.run, connect: async () => ({ query: db.run, release() {} }) };
  const tx = async (fn) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } finally { c.release(); } };
  const audit = async (client, user, action, detail) => { db.audits.push({ action, detail }); };
  const app = express();
  app.use(express.json(), cookieParser());
  app.locals.alerts = { failedLogin: async (a) => { alerts.push(a); } };
  app.locals.completeLogin = async (res, u, how) => {
    const user = { id: u.user_id, name: u.full_name, role: u.role_key, roleLabel: u.label };
    await audit(null, user, 'Login', 'Successful login (one-time code by ' + how + ')');
    res.cookie('session', jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '8h' }), { httpOnly: true, sameSite: 'lax' });
    return user;
  };
  require('../login-otp')({ app, pool, wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next), tx, audit, str: (v) => (typeof v === 'string' ? v.trim() : '') });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie') }; };
  const challenge = () => app.locals.loginOtp.challengeFor(db.user);
  const lastCode = (from) => { const m = (from.length ? from[from.length - 1] : {}); return ((m.text || m.message || '').match(/(\d{6})/) || [])[1]; };
  return { app, db, server, post, challenge, sentMail, sentSms, alerts, lastCode };
}

test('a correct password alone never starts a session: the challenge lists masked email/text options only', async () => {
  const t = await start();
  const c = t.challenge();
  assert.equal(c.code, 'OTP_REQUIRED');
  assert.ok(c.challengeToken);
  assert.equal(c.email.masked, 'an***@example.com');
  assert.match(c.sms.masked, /4567$/);
  assert.ok(!JSON.stringify(c).includes('ana@example.com') && !JSON.stringify(c).includes('09171234567'), 'full email/phone must not be disclosed');
  assert.equal(t.app.locals.loginOtp.enabled(), true, 'on by default');
  t.server.close();
});

test('email choice: code is mailed, right code starts the session (httpOnly cookie), wrong code does not', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  const s = await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  assert.equal(s.status, 200); assert.equal(s.body.sent, true);
  assert.equal(t.sentMail.length, 1); assert.equal(t.sentMail[0].to, 'ana@example.com'); assert.equal(t.sentSms.length, 0);
  const code = t.lastCode(t.sentMail);
  assert.match(code, /^\d{6}$/);
  const wrong = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code: code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400); assert.equal(wrong.cookie, null, 'no session on a wrong code');
  const ok = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code });
  assert.equal(ok.status, 200); assert.equal(ok.body.role, 'customer');
  assert.match(ok.cookie, /session=/); assert.match(ok.cookie, /HttpOnly/i);
  assert.ok(t.db.audits.some((a) => a.action === 'Login' && /by email/.test(a.detail)));
  t.server.close();
});

test('text-message choice: code is texted to the registered number, not emailed', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  assert.equal((await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'sms' })).status, 200);
  assert.equal(t.sentSms.length, 1); assert.equal(t.sentMail.length, 0); assert.equal(t.sentSms[0].to, '09171234567');
  const ok = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code: t.lastCode(t.sentSms) });
  assert.equal(ok.status, 200); assert.ok(t.db.audits.some((a) => /by text message/.test(a.detail)));
  t.server.close();
});

test('only a hash of the code is stored, and a code works once', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  const code = t.lastCode(t.sentMail);
  assert.ok(!JSON.stringify(t.db.otps).includes(code), 'the plain code must not be stored');
  assert.equal((await t.post('/api/auth/login-otp/verify', { token: challengeToken, code })).status, 200);
  const again = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code });
  assert.equal(again.status, 400); assert.equal(again.cookie, null, 'a used code cannot sign in again');
  t.server.close();
});

test('5 wrong tries cancel the code: even the right code is refused afterwards; failures feed audit + alerts', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  const code = t.lastCode(t.sentMail), bad = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await t.post('/api/auth/login-otp/verify', { token: challengeToken, code: bad })).status, 400);
  const late = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code });
  assert.equal(late.status, 400); assert.equal(late.cookie, null); assert.match(late.body.error, /Too many wrong tries/);
  assert.equal(t.db.audits.filter((a) => a.action === 'Login failed').length, 5);
  assert.equal(t.alerts.length, 5); assert.equal(t.alerts[0].email, 'ana@example.com');
  t.server.close();
});

test('an expired code is refused', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  const code = t.lastCode(t.sentMail);
  t.db.otps[0].expires_at = Date.now() - 1000;
  const r = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code });
  assert.equal(r.status, 400); assert.equal(r.cookie, null); assert.match(r.body.error, /expired/);
  t.server.close();
});

test('resend is limited to once per 60 seconds', async () => {
  const t = await start();
  const { challengeToken } = t.challenge();
  const a = await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  const b = await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'sms' });
  assert.equal(a.body.sent, true); assert.equal(b.body.sent, false); assert.equal(b.body.recent, true);
  assert.equal(t.sentMail.length + t.sentSms.length, 1, 'no second code inside the cooldown');
  // switching method inside the cooldown must say where the LIVE code went (email), not pretend a text was sent
  assert.equal(a.body.channel, 'email'); assert.equal(b.body.channel, 'email');
  assert.match(b.body.message, /by email/);
  const ok = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code: t.lastCode(t.sentMail) });
  assert.equal(ok.status, 200);
  t.server.close();
});

test('missing, forged, wrong-purpose and expired challenge tokens are all refused (401)', async () => {
  const t = await start();
  const sessionLike = jwt.sign({ id: 7, role: 'finance' }, process.env.JWT_SECRET);
  const forged = jwt.sign({ uid: 7, purpose: 'login-otp' }, 'attacker-secret-attacker-secret-1234');
  const otherPurpose = jwt.sign({ uid: 7, purpose: 'pending-verification' }, process.env.JWT_SECRET + ':login-otp');
  const expired = jwt.sign({ uid: 7, purpose: 'login-otp' }, process.env.JWT_SECRET + ':login-otp', { expiresIn: -5 });
  for (const [name, token] of [['none', undefined], ['session cookie value', sessionLike], ['forged', forged], ['wrong purpose', otherPurpose], ['expired', expired]]) {
    assert.equal((await t.post('/api/auth/login-otp/send', { token, channel: 'email' })).status, 401, name + ' send');
    assert.equal((await t.post('/api/auth/login-otp/verify', { token, code: '123456' })).status, 401, name + ' verify');
  }
  t.server.close();
});

test('channel rules: text is refused for a customer whose mobile is unverified; a disabled account loses its challenge', async () => {
  const t = await start({ phone_verified_at: null });
  const { challengeToken } = t.challenge();
  assert.equal(t.challenge().sms, null);
  assert.equal((await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'sms' })).status, 400);
  assert.equal((await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'carrier-pigeon' })).status, 400);
  t.db.user.status = 'disabled';
  assert.equal((await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' })).status, 401);
  t.server.close();
});

test('staff without a mobile number can still sign in with the email code', async () => {
  const t = await start({ role_key: 'cashier', label: 'Cashier', phone: null, phone_verified_at: null });
  assert.equal(t.challenge().sms, null);
  const { challengeToken } = t.challenge();
  await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
  const ok = await t.post('/api/auth/login-otp/verify', { token: challengeToken, code: t.lastCode(t.sentMail) });
  assert.equal(ok.status, 200); assert.equal(ok.body.role, 'cashier');
  t.server.close();
});

test('the code never reaches production logs when delivery fails', async () => {
  const warns = []; const orig = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  const oldEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    const t = await start({}, { mailFails: true });
    const { challengeToken } = t.challenge();
    const r = await t.post('/api/auth/login-otp/send', { token: challengeToken, channel: 'email' });
    assert.equal(r.body.sent, false);
    assert.ok(!warns.join('\n').match(/\b\d{6}\b/), 'no 6-digit code in the log');
    t.server.close();
  } finally { console.warn = orig; process.env.NODE_ENV = oldEnv; }
});

test('LOGIN_OTP=off switches the step off; the setting is read live', async () => {
  const t = await start();
  process.env.LOGIN_OTP = 'off'; assert.equal(t.app.locals.loginOtp.enabled(), false);
  process.env.LOGIN_OTP = 'ON'; assert.equal(t.app.locals.loginOtp.enabled(), true);
  delete process.env.LOGIN_OTP; t.server.close();
});

test('wiring: the login route cannot start a session without the OTP gate, and the only other cookie writer needs an existing session', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const login = src.slice(src.indexOf("app.post('/api/auth/login'"), src.indexOf("app.post('/api/auth/logout'"));
  assert.match(login, /loginOtp\.enabled\(\)[\s\S]*status\(403\)[\s\S]*challengeFor/, 'login must answer with a challenge when OTP is on');
  assert.ok(!/res\.cookie\(/.test(login), 'the login route itself must not set the session cookie');
  const writers = src.split("res.cookie('session'").length - 1;
  assert.equal(writers, 1, 'the session cookie is written in exactly one place: startSession()');
  const callers = [...src.matchAll(/(?<!function )startSession\(res, ([^)]*)\)/g)].length;
  assert.equal(callers, 3, 'startSession is used by completeLogin, the signed-in profile refresh and the password change only');
  const complete = src.slice(src.indexOf('app.locals.completeLogin'), src.indexOf("require('./login-otp')"));
  assert.match(complete, /let tv = u\.token_version/); assert.match(complete, /startSession\(res, user, tv, sid\)/);
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter((x) => x.endsWith('.js') && x !== 'server.js'))
    assert.ok(!/cookie\('session'/.test(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')), f + ' must not start sessions');
});
