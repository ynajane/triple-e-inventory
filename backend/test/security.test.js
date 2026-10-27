/* security.test.js — proves the hardening in security.js works (OWASP Top 10:2025 A01, A02, A04, A07, A09).
   No database needed.   node test/security.test.js      (or: node --test test/security.test.js)
   Evidence for tests T-03 (headers), T-04 (cookie), T-10 (rate limit), T-14 (no cache) and the CSRF origin check. */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const security = require('../security');

function start(limits, env) {
  Object.assign(process.env, env || {});
  const app = express();
  security.mount({ app, pool: null, limits });
  app.use(express.json());
  app.get('/page', (req, res) => res.send('ok'));
  app.get('/api/data', (req, res) => res.json({ ok: true }));
  app.post('/api/data', (req, res) => res.json({ saved: true }));
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/forgot/send', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/verification-status', (req, res) => res.json({ ok: true }));
  app.post('/api/invitations', (req, res) => res.json({ ok: true }));
  app.post('/api/invitations/:id/resend', (req, res) => res.json({ ok: true }));
  app.post('/api/signup/invite/:token', (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port })); });
}

test('security headers are on every response', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  const r = await fetch(base + '/page');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  const csp = r.headers.get('content-security-policy');
  for (const part of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "default-src 'self'"]) assert.ok(csp.includes(part), part);
  assert.equal(r.headers.get('x-powered-by'), null);
  server.close();
});

test('script-src uses a fresh per-request nonce and no unsafe-inline (XSS hardening)', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  const scriptSrc = (r) => r.headers.get('content-security-policy').split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
  const a = scriptSrc(await fetch(base + '/page')), b = scriptSrc(await fetch(base + '/page'));
  assert.match(a, /'nonce-[A-Za-z0-9+/=]{20,}'/);
  assert.ok(!a.includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
  assert.notEqual(a, b, 'the nonce must change on every request');
  server.close();
});

test('HSTS is sent in production only', async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const a = await start({ general: 1000, auth: 1000 });
  assert.match((await fetch(a.base + '/page')).headers.get('strict-transport-security'), /max-age=31536000/);
  a.server.close();
  process.env.NODE_ENV = 'development';
  const b = await start({ general: 1000, auth: 1000 });
  assert.equal((await fetch(b.base + '/page')).headers.get('strict-transport-security'), null);
  b.server.close();
  process.env.NODE_ENV = old;
});

test('API responses are never cached', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  assert.equal((await fetch(base + '/api/data')).headers.get('cache-control'), 'no-store');
  server.close();
});

test('a state-changing request from another site is blocked (CSRF)', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 });
  const evil = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evil.status, 403);
  const same = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(same.status, 200);
  const none = await fetch(base + '/api/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(none.status, 200, 'server-to-server calls without an Origin still work');
  const badRef = await fetch(base + '/api/data', { method: 'POST', headers: { Referer: 'https://evil.example/x', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(badRef.status, 403);
  const read = await fetch(base + '/api/data', { headers: { Origin: 'https://evil.example' } });
  assert.equal(read.status, 200, 'reading is not blocked by the origin check');
  server.close();
});

test('ALLOWED_ORIGINS lets a listed host through', async () => {
  const { server, base } = await start({ general: 1000, auth: 1000 }, { ALLOWED_ORIGINS: 'shop.example.com' });
  const r = await fetch(base + '/api/data', { method: 'POST', headers: { Origin: 'https://shop.example.com', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200);
  delete process.env.ALLOWED_ORIGINS;
  server.close();
});

test('forwarded hosts are ignored without a trusted proxy and keep ports when trusted', async () => {
  const previous = process.env.TRUST_PROXY;
  let current;
  try {
    for (const hops of ['0', '1']) {
      process.env.TRUST_PROXY = hops;
      current = await start({ general: 1000, auth: 1000 });
      const r = await fetch(current.base + '/api/data', { method: 'POST', headers: {
        Origin: 'https://shop.example:8443', 'X-Forwarded-Host': 'shop.example:8443',
      } });
      assert.equal(r.status, hops === '0' ? 403 : 200);
      const wrongPort = await fetch(current.base + '/api/data', { method: 'POST', headers: {
        Origin: 'https://shop.example:9443', 'X-Forwarded-Host': 'shop.example:8443',
      } });
      assert.equal(wrongPort.status, 403);
      await new Promise((resolve) => current.server.close(resolve)); current = null;
    }
  } finally {
    if (current) current.server.close();
    if (previous === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
  }
});

test('the general rate limit answers 429 with Retry-After', async () => {
  const { server, base } = await start({ general: 3, auth: 1000 });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(base + '/api/data')).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const r = await fetch(base + '/api/data');
  assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.equal((await fetch(base + '/page')).status, 200, 'pages outside /api are not limited');
  server.close();
});

test('sign-in and OTP routes have a stricter limit than the rest of the API', async () => {
  const { server, base } = await start({ general: 1000, auth: 2 });
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
  assert.deepEqual([await post('/api/auth/login'), await post('/api/auth/login'), await post('/api/auth/login')], [200, 200, 429]);
  assert.equal(await post('/api/auth/forgot/send'), 429, 'the limit is shared across the sensitive routes');
  assert.equal(await post('/api/data'), 200, 'ordinary routes are not affected');
  server.close();
});

test('the verify screen 3-second status poll does not use up the sign-in budget', async () => {
  const { server, base } = await start({ general: 100000, auth: 3, invite: 100 });
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status);
  for (let i = 0; i < 60; i++) assert.equal(await post('/api/auth/verification-status'), 200, 'poll ' + i);   // 3 minutes of polling
  assert.deepEqual([await post('/api/auth/login'), await post('/api/auth/login'), await post('/api/auth/login'), await post('/api/auth/login')], [200, 200, 200, 429], 'sign-in is still limited to its own budget');
  assert.equal(await post('/api/auth/verification-status'), 200, 'and the poll is not blocked by that limit either');
  server.close();
});

test('invitations have their own budget: sign-in traffic cannot block an administrator, and invitation floods are still stopped', async () => {
  const { server, base } = await start({ general: 100000, auth: 2, invite: 3 });
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  for (let i = 0; i < 3; i++) await post('/api/auth/login');                                   // use up the sign-in budget (2) completely
  assert.equal((await post('/api/auth/login')).status, 429, 'sign-in is blocked...');
  assert.equal((await post('/api/invitations')).status, 200, '...but sending an invitation still works');
  assert.equal((await post('/api/invitations')).status, 200); assert.equal((await post('/api/invitations/5/resend')).status, 200, 'resend shares the invitation budget');
  const blocked = await post('/api/invitations');
  assert.equal(blocked.status, 429); assert.match(blocked.body.error, /Too many invitations/);
  assert.equal((await post('/api/signup/invite/abc')).status, 429, 'accepting an invitation (not logged in) stays under the strict sign-in budget');
  server.close();
});

test('the session cookie is Secure in production unless switched off on purpose', () => {
  const keep = { n: process.env.NODE_ENV, c: process.env.COOKIE_SECURE };
  process.env.NODE_ENV = 'production'; delete process.env.COOKIE_SECURE;
  assert.equal(security.cookieSecure(), true);
  process.env.COOKIE_SECURE = 'false'; assert.equal(security.cookieSecure(), false);
  process.env.NODE_ENV = 'development'; delete process.env.COOKIE_SECURE;
  assert.equal(security.cookieSecure(), false);
  process.env.COOKIE_SECURE = 'true'; assert.equal(security.cookieSecure(), true);
  if (keep.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keep.n;
  if (keep.c === undefined) delete process.env.COOKIE_SECURE; else process.env.COOKIE_SECURE = keep.c;
});

test('the audit log trigger SQL refuses UPDATE and DELETE', () => {
  assert.match(security.AUDIT_SQL, /BEFORE UPDATE OR DELETE ON audit_log/);
  assert.match(security.AUDIT_SQL, /RAISE EXCEPTION 'audit_log is append-only/);
});
