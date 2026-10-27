'use strict';
/* test/payment-terms-auto.test.js — automatic approval and the suggested payment term (payment-terms.js).  No database needed.
   Run:  node --no-warnings test/payment-terms-auto.test.js */
const assert = require('node:assert/strict');
const { autoApproval, recommendKey } = require('../payment-terms');

let passed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const half = (o) => Object.assign({ term_key: 'half', label: 'Half Payment', enabled: true, retail_allowed: true, made_to_order_allowed: true, auto_approve_limit: 50000 }, o);

console.log('\n1. Automatic approval of a part-payment');
ok('within the limit, allowed, nothing owed: approved by the system', () => assert.equal(autoApproval({ policy: half(), total: 30000, madeToOrder: true, owed: 0 }).ok, true));
ok('exactly at the limit is still within it', () => assert.equal(autoApproval({ policy: half(), total: 50000, madeToOrder: false, owed: 0 }).ok, true));
ok('over the limit goes to Finance, with the reason', () => {
  const r = autoApproval({ policy: half(), total: 50000.01, madeToOrder: true, owed: 0 });
  assert.equal(r.ok, false); assert.match(r.reasons.join(' '), /over the automatic limit/);
});
ok('no limit set: Finance signs every one (how it worked before)', () => {
  const r = autoApproval({ policy: half({ auto_approve_limit: null }), total: 100, madeToOrder: true, owed: 0 });
  assert.equal(r.ok, false); assert.match(r.reasons[0], /no automatic limit/);
});
ok('a customer who still owes money elsewhere goes to Finance', () => {
  const r = autoApproval({ policy: half(), total: 1000, madeToOrder: true, owed: 2500 });
  assert.equal(r.ok, false); assert.match(r.reasons.join(' '), /still owes/);
});
ok('a term switched off is never signed automatically', () => assert.equal(autoApproval({ policy: half({ enabled: false }), total: 1000, madeToOrder: true, owed: 0 }).ok, false));
ok('a term not allowed for made-to-order is never signed for one', () => assert.equal(autoApproval({ policy: half({ made_to_order_allowed: false }), total: 1000, madeToOrder: true, owed: 0 }).ok, false));
ok('a term not allowed for ready stock is never signed for it', () => assert.equal(autoApproval({ policy: half({ retail_allowed: false }), total: 1000, madeToOrder: false, owed: 0 }).ok, false));
ok('Full Payment needs no approval at all', () => assert.equal(autoApproval({ policy: { term_key: 'full' }, total: 1e9, madeToOrder: true, owed: 1e6 }).ok, true));
ok('several problems are all listed', () => assert.equal(autoApproval({ policy: half({ enabled: false }), total: 90000, madeToOrder: true, owed: 10 }).reasons.length, 3));

console.log('\n2. Suggested term');
const opts = [{ key: 'full', percent: 100 }, { key: 'half', percent: 50 }, { key: 'down', percent: 30 }];
ok('ready stock: Full Payment', () => assert.equal(recommendKey(opts, false), 'full'));
ok('made-to-order: the biggest deposit allowed', () => assert.equal(recommendKey(opts, true), 'half'));
ok('made-to-order with only a 30% term allowed: that one', () => assert.equal(recommendKey([opts[0], opts[2]], true), 'down'));
ok('made-to-order with no part-payment allowed: Full Payment', () => assert.equal(recommendKey([opts[0]], true), 'full'));
ok('custom is never suggested', () => assert.equal(recommendKey([opts[0], { key: 'custom', percent: 90 }], true), 'full'));

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
