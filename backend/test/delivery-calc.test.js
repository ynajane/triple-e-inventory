#!/usr/bin/env node
/* test/delivery-calc.test.js — delivery fee by weight and the estimated arrival date. No database needed.
   Run:  node --no-warnings test/delivery-calc.test.js */
const assert = require('assert');
const { DEFAULTS, totalWeightKg, computeFee, addWorkingDays, estimateArrival, rangeText, cleanSettings, isMetro } = require('../delivery-calc');
let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '  ->  ' + e.message); } };

console.log('1. Weight');
ok('piece weight x quantity, added across lines', () => assert.equal(totalWeightKg([{ qty: 10, unit: 'pcs', weight_kg: 1.5 }, { qty: 2, unit: 'pcs', weight_kg: 0.25 }]), 15.5));
ok('a product with no weight adds nothing', () => assert.equal(totalWeightKg([{ qty: 5, unit: 'pcs', weight_kg: null }]), 0));
ok('a line sold by the kg weighs its quantity', () => assert.equal(totalWeightKg([{ qty: 7.5, unit: 'kg' }]), 7.5));

console.log('2. Fee');
const S = { freeWeightKg: 20, perKgFee: 5, freeOverAmount: 0 };
ok('within the free allowance: just the area rate', () => assert.deepEqual([computeFee({ base: 150, weightKg: 20, goodsTotal: 100 }, S).fee, computeFee({ base: 150, weightKg: 20, goodsTotal: 100 }, S).weightCharge], [150, 0]));
ok('over it: every started kg is charged (20.1 kg = 1 kg over)', () => assert.equal(computeFee({ base: 150, weightKg: 20.1, goodsTotal: 100 }, S).fee, 155));
ok('45 kg: 25 kg over x 5 = 125 on top of 150', () => { const f = computeFee({ base: 150, weightKg: 45, goodsTotal: 100 }, S); assert.deepEqual([f.extraKg, f.weightCharge, f.fee], [25, 125, 275]); });
ok('no weights recorded: the fee is exactly the old flat rate', () => assert.equal(computeFee({ base: 150, weightKg: 0, goodsTotal: 999 }, S).fee, 150));
ok('free-delivery amount: reached = 0, not reached = normal', () => {
  const s = { ...S, freeOverAmount: 5000 };
  assert.equal(computeFee({ base: 150, weightKg: 50, goodsTotal: 5000 }, s).fee, 0);
  assert.equal(computeFee({ base: 150, weightKg: 0, goodsTotal: 4999.99 }, s).fee, 150);
});
ok('centavo-safe (0.1 + 0.2 style)', () => assert.equal(computeFee({ base: 150.1, weightKg: 21, goodsTotal: 1 }, { ...S, perKgFee: 0.2 }).fee, 150.3));

console.log('3. Working days');
// 2026-10-22 is a Thursday
ok('Thu + 1 = Fri', () => assert.equal(addWorkingDays('2026-10-22', 1), '2026-10-23'));
ok('Fri + 1 skips Sunday: = Sat? Saturdays count, so Sat', () => assert.equal(addWorkingDays('2026-10-23', 1), '2026-10-24'));
ok('Sat + 1 skips Sunday = Mon', () => assert.equal(addWorkingDays('2026-10-24', 1), '2026-10-26'));
ok('0 days on a Sunday moves to Monday', () => assert.equal(addWorkingDays('2026-10-25', 0), '2026-10-26'));
ok('a fixed holiday is skipped (Dec 24 -> Dec 26; 24, 25 are off)', () => assert.equal(addWorkingDays('2026-12-23', 1), '2026-12-26'));
ok('year end: Dec 29 + 1 skips Dec 30, 31 and Jan 1, Jan 2', () => assert.equal(addWorkingDays('2026-12-29', 1), '2027-01-02'));

console.log('4. Estimated arrival');
ok('Metro Manila is recognised, a province is not', () => assert.deepEqual([isMetro({ region: 'NCR' }), isMetro({ region: 'Region IV-A', province: 'Cavite' })], [true, false]));
ok('Thu 10:00, Metro: pack 1 + transit 2 = 3 working days -> Mon Oct 26, latest +2 -> Wed Oct 28', () => {
  const e = estimateArrival({ region: 'NCR' }, '2026-10-22', DEFAULTS, 10);
  assert.deepEqual([e.earliest, e.latest], ['2026-10-26', '2026-10-28']);
});
ok('an order after the 3 pm cut-off counts from the next working day', () => assert.equal(estimateArrival({ region: 'NCR' }, '2026-10-22', DEFAULTS, 16).earliest, '2026-10-27'));
ok('provinces take longer (1 + 5 = 6 working days)', () => assert.equal(estimateArrival({ region: 'Region VII' }, '2026-10-22', DEFAULTS, 10).workingDays, 6));
ok('reads as a short range', () => assert.equal(rangeText({ earliest: '2026-10-26', latest: '2026-10-28' }), 'Oct 26\u201328'));
ok('a range across two months shows both', () => assert.equal(rangeText({ earliest: '2026-10-30', latest: '2026-11-03' }), 'Oct 30 \u2013 Nov 3'));

console.log('5. Settings are checked');
ok('good numbers pass', () => assert.deepEqual(cleanSettings({ ...DEFAULTS }).errors, {}));
ok('a blank, a negative, half a day and text are all refused', () => {
  const r = cleanSettings({ ...DEFAULTS, perKgFee: '', freeWeightKg: -1, packDays: 1.5, transitMetro: 'abc' }).errors;
  assert.deepEqual(Object.keys(r).sort(), ['freeWeightKg', 'packDays', 'perKgFee', 'transitMetro']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

