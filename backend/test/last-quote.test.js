/* last-quote.test.js — "last quoted" hint for recurring customers.   node test/last-quote.test.js */
const assert = require('node:assert');
const { lastQuoteFor } = require('../last-quote');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  PASS  ' + name); };
const cur = { quote_id: 9, customer_id: 5, phone: '09171234567', product_sku: 'BR-100', quantity: '200', proposed_amount: 167280, suggested_cost: 140000, created_at: '2026-10-22T02:00:00Z' };
const old = { quote_id: 3, quote_no: 'QR-3', customer_id: 5, phone: '09171234567', product_sku: 'BR-100', quantity: '200 pcs', quoted_amount: 164000, suggested_cost: 137120, status: 'completed', created_at: '2026-10-01T02:00:00Z' };

t('finds the last price for the same customer and SKU', () => { const r = lastQuoteFor(cur, [old]); assert.equal(r.id, 'QR-3'); assert.equal(r.amount, 164000); assert.equal(r.sameQuantity, true); });
t('cost drift +2.1% and adjusted total', () => { const r = lastQuoteFor(cur, [old]); assert.equal(r.costDriftPct, 2.1); assert.equal(r.adjustedTotal, 167444.0); assert.equal(r.priceDriftPct, 2); });
t('uses the newest of several earlier quotes and counts them', () => {
  const older = { ...old, quote_id: 1, quote_no: 'QR-1', quoted_amount: 150000, created_at: '2026-08-01T02:00:00Z' };
  const r = lastQuoteFor(cur, [older, old]); assert.equal(r.id, 'QR-3'); assert.equal(r.times, 2);
});
t('different quantity is compared per unit', () => { const r = lastQuoteFor({ ...cur, quantity: '400', proposed_amount: 334560, suggested_cost: 280000 }, [old]); assert.equal(r.sameQuantity, false); assert.equal(r.costDriftPct, 2.1); assert.equal(r.priceDriftPct, 2); });
t('another customer, another SKU, a custom item, or a later quote never match', () => {
  assert.equal(lastQuoteFor(cur, [{ ...old, customer_id: 6 }]), null);
  assert.equal(lastQuoteFor(cur, [{ ...old, product_sku: 'BR-200' }]), null);
  assert.equal(lastQuoteFor({ ...cur, product_sku: null }, [old]), null);
  assert.equal(lastQuoteFor(cur, [{ ...old, created_at: '2026-10-23T02:00:00Z' }]), null);
  assert.equal(lastQuoteFor(cur, [{ ...old, quoted_amount: null }]), null);
  assert.equal(lastQuoteFor(cur, []), null);
});
t('walk-in matches by phone (+63 and 0 formats) and never by an empty phone', () => {
  const w = { ...cur, customer_id: null, phone: '+63 917 123 4567' }, o = { ...old, customer_id: null };
  assert.equal(lastQuoteFor(w, [o]).id, 'QR-3');
  assert.equal(lastQuoteFor({ ...w, phone: '' }, [{ ...o, phone: '' }]), null);
});
t('no saved cost on the old quote: drift and adjusted price stay empty, nothing is guessed', () => { const r = lastQuoteFor(cur, [{ ...old, suggested_cost: null }]); assert.equal(r.costDriftPct, null); assert.equal(r.adjustedTotal, null); });
console.log('\n' + passed + ' passed');
