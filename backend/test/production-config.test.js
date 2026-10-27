const test = require('node:test');
const assert = require('node:assert/strict');
const check = require('../scripts/check-production');
const baseline = { NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40), APP_BASE_URL: 'https://shop.example', DATABASE_URL: 'postgresql://test@localhost/triplee' };
test('production check accepts secure defaults without exposing secret values', () => {
  assert.deepEqual(check(baseline), []);
  const issues = check({ ...baseline, JWT_SECRET: 'secret-value' });
  assert.ok(issues.length); assert.ok(!issues.join().includes('secret-value'));
});
test('production check rejects unsafe overrides, missing HTTPS and unverified remote TLS', () => {
  for (const overrides of [{ NODE_ENV: 'development' }, { LOGIN_OTP: 'off' }, { EMAIL_VERIFICATION: 'off' },
    { PHONE_VERIFICATION: 'off' }, { COOKIE_SECURE: 'false' }, { APP_BASE_URL: 'http://shop.example' },
    { TRUST_PROXY: '-1' }, { DATABASE_URL: 'not a URL' }, { DATABASE_URL: 'postgresql://test@db.example/triplee', DB_SSL: 'require' }]) {
    assert.ok(check({ ...baseline, ...overrides }).length, JSON.stringify(overrides));
  }
});
