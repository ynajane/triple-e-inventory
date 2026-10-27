/* cash-shift-gate.test.js — Task 6, the cashier's cash shift gate.  No database needed.   node --test test/cash-shift-gate.test.js
   Part 1 proves the rules in cash-shift-rules.js (which screen, what to pre-fill, when a reason is needed, the deposit limit).
   Part 2 reads the real source files and proves the gate is wired the way the task says (no dismiss, sales blocked on a stale shift,
   sidebar shift card and the Finance reminders still there). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../cash-shift-rules');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const day = '2026-10-22';
const clock = (state) => ({ state, date: day });

test('gate: no shift, store open -> the open form', () => {
  assert.equal(R.gateState({ clock: clock('open'), canOpenShift: true, current: null }), 'can_open');
});
test('gate: after 17:00 with no shift -> Store closed', () => {
  assert.equal(R.gateState({ clock: clock('after'), canOpenShift: false, current: null }), 'store_closed');
});
test('gate: before the early-open window -> store not open yet', () => {
  assert.equal(R.gateState({ clock: clock('before'), canOpenShift: false, current: null }), 'too_early');
});
test("gate: today's open shift lifts the gate", () => {
  assert.equal(R.gateState({ clock: clock('open'), canOpenShift: true, current: { id: 7, openedDay: day } }), 'open');
});
test('gate: an unclosed shift from an earlier day forces count-and-close, before and after closing time', () => {
  for (const state of ['before', 'open', 'after'])
    assert.equal(R.gateState({ clock: clock(state), canOpenShift: state === 'open', current: { id: 3, openedDay: '2026-10-21' } }), 'close_previous');
});
test("gate: a shift opened today stays open after 17:00 (it must be closed, selling is not clock-blocked)", () => {
  assert.equal(R.gateState({ clock: clock('after'), canOpenShift: false, current: { id: 7, openedDay: day } }), 'open');
});

test('pre-fill: previous closing cash minus the deposit', () => {
  const s = R.suggestOpening({ id: 12, closingCash: 5200, closingDeposit: 4000, cashierName: 'Ana', closedAt: 'x' });
  assert.equal(s.amount, 1200); assert.equal(s.closingCash, 5200); assert.equal(s.deposit, 4000); assert.equal(s.fromShiftId, 12);
});
test('pre-fill: no deposit means the whole count carries over', () => {
  assert.equal(R.suggestOpening({ id: 1, closingCash: 1500.5, closingDeposit: 0 }).amount, 1500.5);
});
test('pre-fill: centavo-safe (0.1 + 0.2 style sums)', () => {
  assert.equal(R.suggestOpening({ id: 1, closingCash: 100.3, closingDeposit: 0.1 }).amount, 100.2);
});
test('pre-fill: never negative, nothing when there is no earlier shift', () => {
  assert.equal(R.suggestOpening({ id: 1, closingCash: 100, closingDeposit: 500 }).amount, 0);
  assert.equal(R.suggestOpening(undefined), null);
  assert.equal(R.suggestOpening({ id: 2, closingCash: null }), null);
});

test('reason: required only ABOVE the set difference, short or over', () => {
  assert.equal(R.reasonRequired(0, 20), false);
  assert.equal(R.reasonRequired(-19.99, 20), false);
  assert.equal(R.reasonRequired(20, 20), false);        // exactly the limit passes
  assert.equal(R.reasonRequired(-20.01, 20), true);
  assert.equal(R.reasonRequired(35, 20), true);
  assert.equal(R.reasonRequired(0.01, 0), true);        // a limit of 0 means any difference needs a reason
  assert.equal(R.reasonRequired(0, 0), false);
});

test('deposit: 0..counted only', () => {
  assert.equal(R.depositProblem(0, 100), null);
  assert.equal(R.depositProblem(100, 100), null);
  assert.ok(R.depositProblem(100.01, 100));
  assert.ok(R.depositProblem(-1, 100));
  assert.ok(R.depositProblem(NaN, 100));
});

/* ---------- wiring, read from the real files ---------- */
const html = read('Finance_Inventory', 'POS_Cashier.html');
const ui = read('Finance_Inventory', 'cash-shift-ui.js');
const srv = read('backend', 'cash-shifts.js');
const pos = read('backend', 'pos-shop.js');

test('gate markup: full screen modal with no close / dismiss button, only Log out is offered in its footer', () => {
  const gate = /<div class="sg" id="shiftGate"[^>]*>.*?<\/div><\/div>/s.exec(html)[0];
  assert.match(gate, /aria-modal="true"/);
  assert.doesNotMatch(gate, /close|dismiss|cancel|later|not now/i);
  assert.doesNotMatch(ui, /Not now/);                       // the old dismissible prompt is gone
  assert.doesNotMatch(ui, /function promptOpen/);
  assert.match(ui, /id="sgLogout"/);
});
test('gate: page behind it is inert, showPage refuses to move, Escape does nothing', () => {
  assert.match(ui, /\['main', 'sidebar', 'sidebarBackdrop'\]/);
  assert.match(ui, /setAttribute\('inert', ''\)/);
  assert.match(ui, /window\.showPage = function \(p\) \{ if \(gated\)/);
  assert.match(ui, /e\.key === 'Escape'.*preventDefault/);
});
test('gate: starts locked and only the server says it may lift', () => {
  assert.match(ui, /let gated = true/);
  assert.match(ui, /if \(g\.state === 'open'\) \{ lockApp\(false\)/);
});
test('gate screens: open form, Store closed, earlier shift first', () => {
  assert.match(ui, /'Open cash shift'/); assert.match(ui, /'Store closed'/); assert.match(ui, /'Close your earlier shift first'/);
});
test('close dialog: instant short/over, reason only above the set difference, deposit field', () => {
  assert.match(ui, /cents\(Math\.abs\(diff\)\) > cents\(THRESHOLD\)/);
  assert.match(ui, /'Short ' : 'Over '|\(diff < 0 \? 'Short ' : 'Over '\)/);
  assert.match(ui, /id="csDeposit"/);
});
test('server: a closing difference above the threshold needs a reason, deposit is stored, threshold is Finance-editable and audited', () => {
  assert.match(srv, /rules\.reasonRequired\(diff,limit\)&&note\.trim\(\)\.length<5/);
  assert.match(srv, /closing_deposit/);
  assert.match(srv, /app\.put\('\/api\/finance\/cash-shifts\/rules',auth\('finance'\)/);
  assert.match(srv, /Cash shift rule changed/);
  assert.match(srv, /CREATE TABLE IF NOT EXISTS cash_shift_rules/);
});
test('server: opening cash is checked against the carried-over amount and the difference is written to the audit log', () => {
  assert.match(srv, /carried over from shift #/);
});
test('server: sales and cash collection are refused while the open shift is from an earlier day', () => {
  assert.equal((pos.match(/app\.locals\.shiftIsStale/g) || []).length >= 4, true);   // guard + call, in both places
  assert.match(pos, /shift from an earlier day is still open/);
});
test('kept: sidebar shift card and the Finance / cashier reminders', () => {
  assert.match(ui, /box\.id = 'shiftSide'/);
  assert.match(srv, /name: 'shift-hours'/);
  assert.match(srv, /Cash shift still open after closing time/);
  assert.match(srv, /Close your cash shift by /);
});
