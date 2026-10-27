'use strict';
const path = require('node:path');
const fs = require('node:fs');

// A read-only release check. It does not print configuration values or contact providers.
function check(env) {
  const issues = [];
  if (env.NODE_ENV !== 'production') issues.push('Set NODE_ENV=production for the release check.');
  const secret = env.JWT_SECRET || '';
  if (secret.length < 32 || /replace-with|changeme|secret$/i.test(secret)) issues.push('Configure a strong JWT_SECRET of at least 32 random characters.');
  for (const name of ['LOGIN_OTP', 'EMAIL_VERIFICATION', 'PHONE_VERIFICATION']) {
    if (String(env[name] || '').trim().toLowerCase() === 'off') issues.push(name + ' must be enabled in production.');
  }
  if (String(env.COOKIE_SECURE || '').trim().toLowerCase() === 'false') issues.push('COOKIE_SECURE must not be false in production.');
  try {
    const url = new URL(env.APP_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch { issues.push('Set APP_BASE_URL to the public HTTPS application URL.'); }
  const hops = env.TRUST_PROXY;
  if (hops != null && hops !== '' && (!/^\d+$/.test(hops) || !Number.isSafeInteger(Number(hops))))
    issues.push('TRUST_PROXY must be a non-negative integer matching the actual proxy topology.');
  let host = env.PGHOST || env.DB_HOST || 'localhost';
  if (env.DATABASE_URL) {
    try { const url = new URL(env.DATABASE_URL); if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(); host = url.hostname; }
    catch { issues.push('DATABASE_URL must be a valid PostgreSQL URL.'); }
  } else if (!(env.PGUSER || env.DB_USER) || !(env.PGDATABASE || env.DB_NAME)) {
    issues.push('Configure a database URL or database user and name.');
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !host.startsWith('/')) {
    const mode = String(env.DB_SSL || '').trim().toLowerCase();
    if (!mode || ['off', 'false', '0', 'disable', 'no'].includes(mode) || !env.DB_SSL_CA)
      issues.push('Remote databases require DB_SSL and DB_SSL_CA for verified TLS.');
    else if (!fs.existsSync(path.resolve(__dirname, '..', env.DB_SSL_CA)))
      issues.push('DB_SSL_CA must point to an existing certificate file.');
  }
  return issues;
}
if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const issues = check(process.env);
  for (const issue of issues) console.error('- ' + issue);
  if (issues.length) process.exitCode = 1;
  else console.log('Production configuration checks passed. Verify hosted controls and provider delivery separately.');
}
module.exports = check;
