'use strict';
// The server side of "one browser, one account": a page opened for one account cannot act as another (security.js sessionGuard).
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'test-secret';
const jwt = require('jsonwebtoken');
const { sessionGuard } = require('../security');

const guard = sessionGuard(), cookie = 'session=' + jwt.sign({ id: 7 }, process.env.JWT_SECRET);
function run(method, path, headers, withCookie = true) {
  let out = 'next';
  const h = Object.assign({}, headers);
  guard({ method, path, headers: withCookie ? { cookie } : {}, get: (k) => h[k.toLowerCase()] },
    { status: (c) => ({ json: (b) => { out = c + ' ' + b.code; } }) }, () => {});
  return out;
}
const browser = { 'sec-fetch-site': 'same-origin' };

test('a browser change request must say which account its page belongs to', () => {
  assert.equal(run('POST', '/orders', browser), '409 SESSION_CHANGED');
});
test('the matching account passes, a different one is refused (reads too)', () => {
  assert.equal(run('POST', '/orders', { ...browser, 'x-session-user': '7' }), 'next');
  assert.equal(run('GET', '/sales', { 'x-session-user': '9' }), '409 SESSION_CHANGED');
});
test('scripts without browser headers, sign-in routes and signed-out requests are not affected', () => {
  assert.equal(run('POST', '/orders', {}), 'next');
  assert.equal(run('POST', '/auth/login', browser), 'next');
  assert.equal(run('POST', '/orders', browser, false), 'next');
});
test('a forged or expired cookie is left to the normal sign-in check', () => {
  let out = 'next';
  guard({ method: 'POST', path: '/orders', headers: { cookie: 'session=garbage' }, get: (k) => ({ 'x-session-user': '7', 'sec-fetch-site': 'same-origin' })[k.toLowerCase()] },
    { status: () => ({ json: () => { out = 'blocked'; } }) }, () => {});
  assert.equal(out, 'next');
});
