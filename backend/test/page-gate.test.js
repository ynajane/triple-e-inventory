// A customer who types a staff page address must not get the page (OWASP A01, ASVS V4). Reads the real gate table from server.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const block = (src.match(/const PRIVATE_PAGES = \{([\s\S]*?)\n\};/) || [])[1];
const gate = {};
for (const m of (block || '').matchAll(/'([^']+\.html)':\s*(null|\[[^\]]*\])/g)) gate[m[1]] = m[2] === 'null' ? null : JSON.parse(m[2].replace(/'/g, '"'));

test('the gate table was found', () => assert.ok(Object.keys(gate).length >= 4, 'PRIVATE_PAGES not found in server.js'));

test('every private page names the roles allowed in; none is open to any signed-in role', () => {
  for (const [page, roles] of Object.entries(gate)) assert.ok(Array.isArray(roles) && roles.length, page + ' must list its roles (null lets every role in)');
});

test('finance pages are finance only', () => {
  assert.deepStrictEqual(gate['finance_inventory.html'], ['finance']);
  assert.deepStrictEqual(gate['finance_cash_shifts.html'], ['finance']);
});

test('the shop is customer only, and a customer can never open a staff page', () => {
  assert.deepStrictEqual(gate['shop_customer.html'], ['customer']);
  for (const page of ['finance_inventory.html', 'finance_cash_shifts.html', 'pos_cashier.html'])
    assert.ok(!gate[page].includes('customer'), page + ' must not allow customers');
});

test('the cashier page is for cashier and finance, never customers', () => {
  assert.deepStrictEqual([...gate['pos_cashier.html']].sort(), ['cashier', 'finance']);
});

test('a wrong role is redirected, not served', () => {
  assert.match(src, /roles && !roles\.includes\(user\.role\)\) return res\.redirect\(/);
});
