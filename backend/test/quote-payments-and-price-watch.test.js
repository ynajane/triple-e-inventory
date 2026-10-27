/* quote-payments-and-price-watch.test.js — the pure rules behind the quote payment reminders and the automatic price watch.
   Run with:  node backend/test/quote-payments-and-price-watch.test.js   (no database needed) */
const path = require('path');
const { paymentReminderPlan } = require(path.join(__dirname, '..', 'shop-extras.js')).pure;
const { priceWatchAction } = require(path.join(__dirname, '..', 'quote-automation.js')).pure;
let PASS = 0, FAIL = 0;
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log('  PASS  ' + name); } else { FAIL++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const H = 3600000, NOW = Date.parse('2026-10-23T05:00:00Z');
const online = (over) => Object.assign({ status: 'accepted', pay_method: 'Xendit', quoted_amount: 25000, paid_amount: 0, accepted_at: NOW, has_account: true }, over || {});
const ready = (over) => Object.assign({ status: 'ready', pay_method: 'Pay on pickup', quoted_amount: 25000, paid_amount: 12500, ready_at: NOW, has_account: true }, over || {});
const who = (plan) => plan.map((a) => a.to + ':' + a.kind).join(',');

console.log('payment reminders: online payment not made yet');
ok('nothing in the first 6 hours', paymentReminderPlan(online({ accepted_at: NOW - 5 * H }), NOW).length === 0);
ok('customer reminded after 6 h', who(paymentReminderPlan(online({ accepted_at: NOW - 7 * H }), NOW)) === 'customer:online');
ok('a new reminder key each 24 h, so the same one is never sent twice', (() => {
  const k = (h) => paymentReminderPlan(online({ accepted_at: NOW - h * H }), NOW).map((a) => a.key).join();
  return k(7) === k(20) && k(7) !== k(31) && k(31) !== k(55); })());
ok('at most 3 customer reminders', paymentReminderPlan(online({ accepted_at: NOW - 400 * H }), NOW).filter((a) => a.to === 'customer')[0].n === 3);
ok('Finance told once after 72 h', who(paymentReminderPlan(online({ accepted_at: NOW - 80 * H }), NOW)).includes('finance:online_stale'));
ok('a walk-in (no account) is not messaged online', !paymentReminderPlan(online({ accepted_at: NOW - 30 * H, has_account: false }), NOW).some((a) => a.to === 'customer'));
ok('no online reminder once money was paid', paymentReminderPlan(online({ accepted_at: NOW - 30 * H, paid_amount: 100 }), NOW).length === 0);
ok('fully paid: nothing at all', paymentReminderPlan(ready({ paid_amount: 25000 }), NOW).length === 0);
ok('pay-on-pickup quote that is only accepted gets no online reminder', paymentReminderPlan(online({ pay_method: 'Pay on pickup', accepted_at: NOW - 40 * H }), NOW).length === 0);

console.log('payment reminders: ready, balance still owed');
ok('cashier told straight away', who(paymentReminderPlan(ready(), NOW)) === 'cashier:collect');
ok('customer joins after 48 h (the "it is ready" message already went out)', who(paymentReminderPlan(ready({ ready_at: NOW - 49 * H }), NOW)) === 'cashier:collect,customer:pickup');
ok('Finance told after 7 days', who(paymentReminderPlan(ready({ ready_at: NOW - 170 * H }), NOW)).includes('finance:ready_stale'));
ok('walk-in: only the cashier is reminded', who(paymentReminderPlan(ready({ ready_at: NOW - 100 * H, has_account: false }), NOW)) === 'cashier:collect');
ok('the amount owed is the balance', paymentReminderPlan(ready(), NOW)[0].owed === 12500);

console.log('price watch');
const W = (o) => priceWatchAction(Object.assign({ quoted: 25000, oldCost: 20806, newCost: 20500, newTotal: 24600, route: 'quoted', costMovePct: 5, maxDropPct: 25 }, o));
ok('cost inside the limit: nothing happens', W().action === 'none');
ok('cost fell past the limit, small cut, routes straight out: refresh', W({ newCost: 18000, newTotal: 21600 }).action === 'refresh');
ok('cost fell but the cut is over the cap: a person decides', W({ newCost: 9230, newTotal: 11076 }).action === 'notify_review');
ok('cost fell but the new price would need Finance: a person decides', W({ newCost: 18000, newTotal: 21600, route: 'pending_approval' }).action === 'notify_review');
ok('cost rose: never raised behind the customer', W({ newCost: 24000, newTotal: 28800 }).action === 'notify_up');
ok('cost fell but the system price is not lower than what the customer holds: no automatic change', W({ newCost: 18000, newTotal: 26000 }).action === 'notify_review');
ok('no recorded cost to compare with: untouched', W({ oldCost: null }).action === 'none');
ok('the screenshot case (-55.6%) is flagged for a person, not auto-cut', W({ oldCost: 20806, newCost: 9230.76, newTotal: 11077 }).action === 'notify_review');

console.log(`\n${PASS} passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
