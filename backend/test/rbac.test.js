/* rbac.test.js — evidence for OWASP A01 (Broken Access Control) and A07 (Authentication Failures). No database needed.
     node test/rbac.test.js
   1) the real auth() middleware: every role against every route, 401 vs 403, and 403 BEFORE any database query
   2) a route audit: every /api route in backend/*.js is protected by auth() unless it is on the reviewed public list */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
const ROLES = ['finance', 'cashier', 'customer'];

function start(dbRow) {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push(sql); return { rows: dbRow === undefined ? [{ status: 'active', role_key: currentRole.value }] : (dbRow ? [dbRow] : []) }; } };
  const { auth } = require('../auth-middleware')(pool);
  const app = express();
  app.use(cookieParser());
  app.get('/finance-only', auth('finance'), (req, res) => res.json({ ok: true }));
  app.get('/cashier-only', auth('cashier'), (req, res) => res.json({ ok: true }));
  app.get('/customer-only', auth('customer'), (req, res) => res.json({ ok: true }));
  app.get('/staff', auth('finance', 'cashier'), (req, res) => res.json({ ok: true }));
  app.get('/any-user', auth(), (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ server, queries, base: 'http://127.0.0.1:' + server.address().port })); });
}
const currentRole = { value: 'finance' };
let uid = 1000;
const token = (role, opts, extra) => jwt.sign({ id: ++uid, name: 'T', role, roleLabel: role, ...(extra || {}) }, process.env.JWT_SECRET, opts || { expiresIn: '1h' });
const get = (base, p, cookie) => fetch(base + p, { headers: cookie ? { cookie: 'session=' + cookie } : {} });

test('no session cookie -> 401 on every protected route', async () => {
  const { server, base } = await start();
  for (const p of ['/finance-only', '/cashier-only', '/customer-only', '/staff', '/any-user']) assert.equal((await get(base, p)).status, 401, p);
  server.close();
});

test('forged, tampered, expired and alg=none tokens -> 401', async () => {
  const { server, base } = await start();
  const good = token('finance');
  const forged = jwt.sign({ id: 1, role: 'finance' }, 'attacker-secret-attacker-secret-1234');
  const tampered = good.slice(0, -4) + (good.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  const expired = token('finance', { expiresIn: -10 });
  const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + Buffer.from('{"id":1,"role":"finance"}').toString('base64url') + '.';
  for (const [name, t] of [['forged', forged], ['tampered', tampered], ['expired', expired], ['alg none', none], ['garbage', 'abc.def.ghi']])
    assert.equal((await get(base, '/finance-only', t)).status, 401, name);
  server.close();
});

test('role matrix: allowed role -> 200, any other role -> 403 Forbidden', async () => {
  const routes = { '/finance-only': ['finance'], '/cashier-only': ['cashier'], '/customer-only': ['customer'], '/staff': ['finance', 'cashier'], '/any-user': ROLES };
  for (const role of ROLES) {
    currentRole.value = role;
    const { server, base } = await start();
    for (const [p, allowed] of Object.entries(routes)) {
      const r = await get(base, p, token(role));
      assert.equal(r.status, allowed.includes(role) ? 200 : 403, role + ' -> ' + p);
      if (!allowed.includes(role)) assert.deepEqual(await r.json(), { error: 'Forbidden' });
    }
    server.close();
  }
});

test('403 is returned BEFORE the database is touched (OWASP A01)', async () => {
  const { server, base, queries } = await start();
  await new Promise((r) => setTimeout(r, 20));          // let the one start-up query (adds users.token_version) finish
  const before = queries.length;
  assert.equal((await get(base, '/finance-only', token('customer'))).status, 403);
  assert.equal((await get(base, '/finance-only', token('cashier'))).status, 403);
  assert.equal(queries.length, before, 'no query may run for a forbidden request');
  server.close();
});

test('session revocation: a session older than users.token_version is refused; current and pre-upgrade sessions work', async () => {
  const revoked = await start({ status: 'active', role_key: 'finance', token_version: 1 });
  const r = await get(revoked.base, '/finance-only', token('finance', null, { tv: 0 }));        // password was changed on another device
  assert.equal(r.status, 401); assert.equal((await r.json()).code, 'SESSION_REPLACED');
  assert.match(r.headers.get('set-cookie') || '', /signedout=replaced/, 'the login page is told why the person was signed out');
  assert.equal((await get(revoked.base, '/finance-only', token('finance'))).status, 401, 'a session with no tv counts as version 0');
  assert.equal((await get(revoked.base, '/finance-only', token('finance', null, { tv: 1 }))).status, 200, 'the session issued after the change works');
  revoked.server.close();
  const fresh = await start({ status: 'active', role_key: 'finance', token_version: 0 });
  assert.equal((await get(fresh.base, '/finance-only', token('finance'))).status, 200, 'sessions issued before the upgrade keep working until a password change');
  fresh.server.close();
});

test('regression: an old session being refused must not make the same user\'s NEW session look invalid (validity cache)', async () => {
  const t = await start({ status: 'active', role_key: 'finance', token_version: 1 });
  const same = { id: 5150 };
  assert.equal((await get(t.base, '/finance-only', token('finance', null, { ...same, tv: 0 }))).status, 401, 'other device, refused first');
  assert.equal((await get(t.base, '/finance-only', token('finance', null, { ...same, tv: 1 }))).status, 200, 'this device, straight after, within the cache window');
  t.server.close();
});

test('bump() raises the version inside the password-change transaction and returns the new number', async () => {
  const calls = [];
  const pool = { query: async () => ({ rows: [] }) };
  const { revocation } = require('../auth-middleware')(pool);
  assert.equal(await revocation.ready, true);
  const client = { query: async (sql, p) => { calls.push([sql, p]); return { rows: [{ token_version: 4 }] }; } };
  assert.equal(await revocation.bump(client, 7), 4);
  assert.match(calls[0][0], /SET token_version = token_version \+ 1 WHERE user_id = \$1 RETURNING token_version/); assert.deepEqual(calls[0][1], [7]);
  const noCol = require('../auth-middleware')({ query: async () => { throw new Error('permission denied'); } });
  const quiet = console.warn; console.warn = () => {};
  try { assert.equal(await noCol.revocation.ready, false); assert.equal(await noCol.revocation.bump(client, 7), 0, 'no column: password change still works, just without revocation'); }
  finally { console.warn = quiet; }
});

test('a disabled account loses access on its next request (401 ACCOUNT_DISABLED)', async () => {
  const { server, base } = await start({ status: 'disabled', role_key: 'finance' });
  const r = await get(base, '/finance-only', token('finance'));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'ACCOUNT_DISABLED');
  server.close();
});

test('a changed role invalidates the old token (cashier token after demotion/promotion)', async () => {
  const { server, base } = await start({ status: 'active', role_key: 'customer' });
  assert.equal((await get(base, '/staff', token('finance'))).status, 401);   // token says finance, database says customer
  server.close();
});

test('a deleted account (no database row) -> 401', async () => {
  const { server, base } = await start(null);
  assert.equal((await get(base, '/any-user', token('customer'))).status, 401);
  server.close();
});

/* ---------- route audit ---------- */
// Every route below was reviewed and is public ON PURPOSE (sign-in/sign-up/OTP flows, payment webhook, public shop data,
// secret-key cron endpoints that answer 404 without the key). Adding an unprotected /api route makes this test fail.
const PUBLIC = new Set([
  'GET /api/signup/check-email', 'GET /api/signup/check-phone', 'POST /api/signup/customer', 'POST /api/auth/verify-email',
  'POST /api/auth/resend-verification', 'GET /api/signup/invite/:token', 'POST /api/signup/invite/:token',
  'POST /api/auth/unlock', 'POST /api/auth/unlock/resend', 'POST /api/auth/forgot/send', 'POST /api/auth/forgot/reset',
  'POST /api/auth/verification-status', 'POST /api/auth/phone-otp/send', 'POST /api/auth/phone-otp/verify',
  'POST /api/auth/login', 'POST /api/auth/logout',
  'POST /api/auth/login-otp/send', 'POST /api/auth/login-otp/verify',    // second step of sign-in: signed 10-minute challenge token (made only after a right password) + one-time code
  'GET /api/shop/info', 'GET /api/shop/images/:id',
  'POST /api/payments/xendit/webhook',                                    // shared-secret header, constant-time compare
  'GET /api/low-stock/check', 'POST /api/low-stock/check', 'GET /api/automation/run', 'POST /api/automation/run'   // x-cron-key, 404 without it
]);

test('route audit: every /api route uses auth() unless reviewed as public', () => {
  const dir = path.join(__dirname, '..');
  const re = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(['`])(\/[^'`]*)\2([^\n]*)/g;
  let total = 0; const unprotected = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8'); let m;
    while ((m = re.exec(src))) {
      if (!m[3].startsWith('/api')) continue;
      total++;
      if (!/\bauth\(/.test(m[4]) && !PUBLIC.has(m[1].toUpperCase() + ' ' + m[3])) unprotected.push(f + ': ' + m[1].toUpperCase() + ' ' + m[3]);
    }
  }
  assert.ok(total > 200, 'expected to find the API routes, found ' + total);
  assert.deepEqual(unprotected, [], 'unprotected /api routes:\n' + unprotected.join('\n'));
});

test('the public webhook and cron routes compare secrets in constant time', () => {
  const { safeEqual } = require('../security');
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', undefined), false);
  for (const f of ['pos-shop.js', 'low-stock.js', 'server.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /safeEqual\(/, f + ' must use safeEqual for secret comparison');
  }
});

test('finance changes roles only: the server refuses personal-data edits and the Customers screen offers no edit form', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const patch = server.slice(server.indexOf("app.patch('/api/users/:id', auth('finance')"), server.indexOf("app.delete('/api/users/:id'"));
  assert.match(patch, /PROFILE_FIELDS\.filter\(\(k\) => b\[k\] !== undefined\)/, 'any personal field in the request is detected');
  assert.match(patch, /if \(sent\.length\) throw new ValidationError/, '...and refused');
  for (const f of ['name', 'email', 'phone', 'birthdate', 'gender', 'companyTin']) assert.ok(server.includes("'" + f + "'"), f + ' is on the protected list');
  assert.match(patch, /You cannot change your own role/); assert.match(patch, /At least one active Finance-Admin must remain/);
  const ui = path.join(__dirname, '..', '..', 'Finance_Inventory');
  const js = fs.readFileSync(path.join(ui, 'customer-profiles-admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(ui, 'Finance_Inventory.html'), 'utf8');
  assert.ok(!/data-customer-edit|customerEditModal|ProfileEdit/.test(js + html), 'the Customers screen must not show an editable form the server would refuse');
  assert.match(js, /data-customer-toggle/, 'view + disable/enable still work');
});

test('session check: a revoked or unknown device session is refused (SESSION_REPLACED) even when the account and password are fine; sessions without a sid keep working', async () => {
  const live = new Set(['11111111-1111-4111-8111-111111111111']);
  const pool = { query: async (sql, p) => {
    if (/user_sessions s ON s.session_id = \$2::uuid/.test(sql)) return { rows: [{ status: 'active', role_key: 'cashier', token_version: 0, session_ok: live.has(p[1]) }] };
    return { rows: [{ status: 'active', role_key: 'cashier', token_version: 0 }] };
  } };
  const { auth } = require('../auth-middleware')(pool);
  const app = express(); app.use(cookieParser()); app.get('/pos', auth('cashier'), (req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const tok = (extra) => token('cashier', null, { id: 321, ...extra });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await get(base, '/pos', tok({ sid: '11111111-1111-4111-8111-111111111111' }))).status, 200, 'a live device session works');
  const gone = await get(base, '/pos', tok({ sid: '22222222-2222-4222-8222-222222222222' }));
  assert.equal(gone.status, 401); assert.equal((await gone.json()).code, 'SESSION_REPLACED');
  assert.equal((await get(base, '/pos', tok({ sid: 'not-a-uuid' }))).status, 401, 'a malformed sid is treated as no session, never as a database error');
  assert.equal((await get(base, '/pos', tok({}))).status, 200, 'a session made before device tracking existed keeps working until it expires');
  assert.equal((await get(base, '/pos', tok({ sid: '11111111-1111-4111-8111-111111111111' }))).status, 200, 'the live one is still fine after the others were refused (cache is per session)');
  server.close();
});

test('wiring: device limits per role (finance 1, cashier 1, customer 3 by default), sign-in ends the oldest, logout and password change free places, and the login page explains it', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /process\.env\.SESSION_LIMITS === undefined \? 'finance=1,cashier=1,customer=3' : process\.env\.SESSION_LIMITS/, 'defaults');
  const complete = server.slice(server.indexOf('app.locals.completeLogin'), server.indexOf("require('./login-otp')"));
  const iCreate = complete.indexOf('sessions.create('), iLimit = complete.indexOf('sessions.enforceLimit(u.user_id, limit)'), iStart = complete.indexOf('startSession(res, user, tv, sid)');
  assert.ok(iCreate > 0 && iLimit > iCreate && iStart > iLimit, 'the device is recorded, the oldest ones over the limit end, then the new cookie is written');
  assert.match(complete, /forgetAccountCheck\(u\.user_id\)/, 'no grace period for an ended device');
  assert.match(complete, /older device\(s\) signed out/, 'recorded in the audit log');
  assert.match(server, /sessions\.revoke\(u\.sid, 'logout'\)/, 'logout frees the place');
  assert.match(server, /sessions\.revokeOthers\(pool, req\.user\.id, req\.user\.sid, 'password'\)/, 'a password change frees the other places');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'password-otp.js'), 'utf8'), /userSessions\.revokeOthers\(client, u\.user_id, null, 'password'\)/, 'so does a reset');
  const login = fs.readFileSync(path.join(__dirname, '..', '..', 'Finance_Inventory', 'Login_Inventory.html'), 'utf8');
  assert.match(login, /signedout=\(\[\^;\]\*\)/); assert.match(login, /signed in on another device/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8'), /SESSION_LIMITS=finance=1,cashier=1,customer=3/);
});
