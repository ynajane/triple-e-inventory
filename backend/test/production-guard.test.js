// The server refuses to start in production with a placeholder JWT secret or no database address (OWASP A02 / A05, CIS 4).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { productionProblems } = require('../security');

const strong = 'a'.repeat(64);
const good = { NODE_ENV: 'production', JWT_SECRET: strong, DATABASE_URL: 'postgresql://u:p@db.example.com:5432/postgres' };

test('a complete production configuration is accepted', () => {
  assert.deepStrictEqual(productionProblems(good), []);
  assert.deepStrictEqual(productionProblems({ NODE_ENV: 'production', JWT_SECRET: strong, PGHOST: 'h', PGUSER: 'u', PGDATABASE: 'd' }), []);
});

test('production refuses a placeholder or short JWT secret', () => {
  for (const JWT_SECRET of ['', 'short', 'replace-with-a-long-random-256-bit-hex-secret-string', 'changeme'.padEnd(40, 'x') + 'changeme'])
    assert.ok(productionProblems({ ...good, JWT_SECRET }).some((p) => /JWT_SECRET/.test(p)), JSON.stringify(JWT_SECRET));
});

test('production refuses to run without a database address (it would fall back to localhost)', () => {
  const { DATABASE_URL, ...noDb } = good;
  assert.ok(productionProblems(noDb).some((p) => /database is not configured/i.test(p)));
  assert.ok(productionProblems({ ...good, DATABASE_URL: 'mysql://x' }).some((p) => /postgresql/.test(p)));
});

test('development and tests are never blocked', () => {
  assert.deepStrictEqual(productionProblems({}), []);
  assert.deepStrictEqual(productionProblems({ NODE_ENV: 'development', JWT_SECRET: 'x' }), []);
});

test('server.js runs the guard before anything else connects', () => {
  const head = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').split(/\r?\n/).slice(0, 4).join('\n');
  assert.match(head, /productionProblems\(process\.env\)/);
  assert.match(head, /process\.exit\(1\)/);
});
