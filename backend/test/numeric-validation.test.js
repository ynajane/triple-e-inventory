const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const decimalNumber = require('../numeric-input');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const validate = vm.runInNewContext('(' + src.slice(src.indexOf('function number('), src.indexOf('const EMAIL_RE =')) + ')');
const movementContext = {};
const noteStart = src.indexOf('const NOTE_REQUIRED =');
vm.runInNewContext(src.slice(src.indexOf('class ValidationError'), src.indexOf('const DEPARTMENTS')) +
  src.slice(src.indexOf('const REASONS ='), src.indexOf('// Labels for reasons')) +
  src.slice(noteStart, src.indexOf('\n', noteStart)) +
  src.slice(src.indexOf('const str ='), src.indexOf('const EMAIL_RE =')) +
  src.slice(src.indexOf('function validateMovement('), src.indexOf('const wrap =')) +
  '\nthis.validateMovement = validateMovement;', movementContext);
const invalid = [true, false, [], [5], {}, '0x10', '0b10', '1e2', 'NaN', 'Infinity', Infinity, NaN];

test('business numbers reject malformed scalar types and non-decimal text', () => {
  for (const input of invalid) {
    const errors = {};
    assert.equal(validate(errors, 'quantity', input, 'Quantity'), null, String(input));
    assert.ok(errors.quantity, String(input));
    assert.ok(Number.isNaN(decimalNumber(input)), String(input));
  }
  const receipt = { sku: 'RM-TEST', type: 'in', reason: 'supplier_receipt', quantity: 1, supplier: 'SUP-TEST' };
  for (const unitCost of [true, [], [5], {}]) {
    assert.throws(() => movementContext.validateMovement({ ...receipt, unitCost }), (e) => !!e.fields?.unitCost);
  }
  assert.equal(movementContext.validateMovement({ ...receipt, unitCost: '₱145.50' }).unitCost, 145.5);
});

test('ordinary decimals preserve range, precision, required and optional rules', () => {
  for (const input of [0, 1.25, ' 1.25 ', '.5', '1.']) {
    const errors = {}, value = validate(errors, 'quantity', input, 'Quantity');
    assert.equal(value, Number(input)); assert.deepEqual(errors, {});
  }
  for (const [input, options] of [[-1, {}], [100, { max: 99 }], [1.234, { dp: 2 }], [0, { gt: true }]]) {
    const errors = {}; assert.equal(validate(errors, 'quantity', input, 'Quantity', options), null);
    assert.ok(errors.quantity);
  }
  const required = {}; validate(required, 'amount', '   ', 'Amount'); assert.ok(required.amount);
  const optional = {}; assert.equal(validate(optional, 'weight', '', 'Weight', { required: false }), null);
  assert.deepEqual(optional, {});
  assert.equal(decimalNumber('₱1,234.50', { money: true }), 1234.5);
  assert.ok(Number.isNaN(decimalNumber([1234.5], { money: true })));
});

test('payment ledger refuses malformed amounts before any database query', async () => {
  const app = { locals: {}, get() {}, post() {}, use() {} };
  const pool = { async query() { return { rows: [], rowCount: 0 }; } };
  class ValidationError extends Error { constructor(fields) { super(); this.fields = fields; } }
  require('../payment-terms')({ app, pool, auth() {}, wrap() {}, tx() {}, audit() {}, ValidationError,
    str: (v) => typeof v === 'string' ? v.trim() : '' });
  await app.locals.paymentTerms.ready;
  let queries = 0;
  const client = { query() { queries++; throw new Error('invalid input reached database'); } };
  for (const amount of invalid) {
    await assert.rejects(app.locals.paymentTerms.applyPayment(client, {
      kind: 'order', id: 1, amount, method: 'Cash',
    }), (e) => !!(e.fields && e.fields.amount));
  }
  assert.equal(queries, 0);
});
