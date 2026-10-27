/* cash-shift-force-close.test.js — the end-of-day rule: from 15 minutes before closing (4:45 PM for a 5:00 PM close) an open shift MUST be
   counted and closed; the window cannot be dismissed and the server refuses sales on that shift. No database needed.
     node --test test/cash-shift-force-close.test.js
   Part 1: the pure rule.  Part 2: the real routes of cash-shifts.js with the clock set to Philippine time.  Part 3: the wiring in the source files. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.BUSINESS_OPEN = '08:00';
process.env.BUSINESS_CLOSE = '17:00';
delete process.env.SHIFT_FORCE_CLOSE_MINUTES;
delete process.env.ENFORCE_STORE_HOURS;
const R = require('../cash-shift-rules');
const mountShifts = require('../cash-shifts');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

const T = (h, m) => h * 60 + m;
const today = '2026-10-26';

/* ---------- Part 1: the rule ---------- */
test('rule: the window opens exactly at closing time minus 15 minutes (4:44 PM no, 4:45 PM yes) for a shift opened in the morning', () => {
  const shift = { openedDay: today, openedMinutes: T(8, 5) }, base = { shift, closeMinutes: T(17, 0), forceMinutes: 15 };
  assert.equal(R.mustCloseShift({ ...base, clock: { date: today, minutes: T(16, 44) } }), false);
  assert.equal(R.mustCloseShift({ ...base, clock: { date: today, minutes: T(16, 45) } }), true);
  assert.equal(R.mustCloseShift({ ...base, clock: { date: today, minutes: T(16, 59) } }), true);
  assert.equal(R.mustCloseShift({ ...base, clock: { date: today, minutes: T(17, 30) } }), true, 'and it stays forced after closing time');
});
test('rule: a shift left open from an earlier day must always close; no shift means nothing to close', () => {
  assert.equal(R.mustCloseShift({ clock: { date: today, minutes: T(9, 0) }, shift: { openedDay: '2026-10-25', openedMinutes: T(8, 0) }, closeMinutes: T(17, 0), forceMinutes: 15 }), true);
  assert.equal(R.mustCloseShift({ clock: { date: today, minutes: T(16, 50) }, shift: null, closeMinutes: T(17, 0), forceMinutes: 15 }), false);
});
test('rule: a shift opened inside the window is not forced (only possible with store hours not enforced), and 0 minutes switches it off', () => {
  const late = { openedDay: today, openedMinutes: T(16, 50) };
  assert.equal(R.mustCloseShift({ clock: { date: today, minutes: T(16, 55) }, shift: late, closeMinutes: T(17, 0), forceMinutes: 15 }), false);
  assert.equal(R.mustCloseShift({ clock: { date: today, minutes: T(16, 55) }, shift: { openedDay: today, openedMinutes: T(8, 0) }, closeMinutes: T(17, 0), forceMinutes: 0 }), false);
});
test('gate: a shift that must close gives the close_now screen; earlier-day shifts keep close_previous; the old results are unchanged', () => {
  const cur = { id: 1, openedDay: today };
  assert.equal(R.gateState({ clock: { state: 'open', date: today }, canOpenShift: true, current: cur, mustClose: true }), 'close_now');
  assert.equal(R.gateState({ clock: { state: 'open', date: today }, canOpenShift: true, current: cur, mustClose: false }), 'open');
  assert.equal(R.gateState({ clock: { state: 'open', date: today }, canOpenShift: true, current: cur }), 'open');
  assert.equal(R.gateState({ clock: { state: 'open', date: today }, canOpenShift: true, current: { id: 1, openedDay: '2026-10-25' }, mustClose: true }), 'close_previous');
});

/* ---------- Part 2: the real routes at a given Philippine time ---------- */
function build({ openedAt, enforce }) {
  if (enforce) process.env.ENFORCE_STORE_HOURS = 'true'; else delete process.env.ENFORCE_STORE_HOURS;
  const shiftRow = openedAt ? { id: 9, cashierId: 5, cashierName: 'Cara', openedAt, closedAt: null, expectedCash: 1000, openingCash: 1000, cashSales: 0, cashTransactions: 0, movements: [] } : null;
  const res = (rows) => ({ rows, rowCount: rows.length });
  const q = async (sql) => {
    const s = String(sql);
    if (/FROM \(.*\) x WHERE "cashierId"=\$1 AND "closedAt" IS NULL/s.test(s)) return res(shiftRow ? [{ ...shiftRow }] : []);
    if (/cash_shift_rules/.test(s) && /SELECT/.test(s)) return res([{ t: 20 }]);
    if (/FROM pos_cash_shifts WHERE cashier_id/.test(s)) return res(openedAt ? [{ shift_id: 9, opened_at: openedAt }] : []);
    if (/INSERT INTO pos_cash_movements/.test(s)) return res([{ movement_id: 1 }]);
    return res([]);
  };
  const pool = { query: q, connect: async () => ({ query: q, release() {} }) };
  const tx = async (fn) => fn({ query: q });
  const app = express(); app.use(express.json());
  const auth = () => (req, res, next) => { req.user = { id: 5, name: 'Cara', role: 'cashier' }; next(); };
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  mountShifts({ app, pool, auth, wrap, tx, audit: async () => {}, TZ: 'Asia/Manila' });
  return new Promise((resolve) => { const server = app.listen(0, () => resolve({ app, server, base: 'http://127.0.0.1:' + server.address().port })); });
}
const atPH = (h, m) => new Date(Date.UTC(2026, 9, 26, h - 8, m, 0));      // Philippine time is UTC+8
async function withClock(date, fn) {
  const real = Date, fixed = date.getTime();
  global.Date = class extends real { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } };
  try { return await fn(); } finally { global.Date = real; }
}
const gate = async (b) => (await fetch(b.base + '/api/pos/cash-shifts/gate')).json();
const OPENED_8AM = atPH(8, 5).toISOString();

test('routes: at 4:44 PM the morning shift is still open; at 4:45 PM the server says close_now', async () => {
  const b = await build({ openedAt: OPENED_8AM });
  assert.equal((await withClock(atPH(16, 44), () => gate(b))).state, 'open');
  const g = await withClock(atPH(16, 45), () => gate(b));
  assert.equal(g.state, 'close_now');
  assert.equal(g.hours.forceCloseMinutes, 15); assert.equal(g.hours.forceCloseFrom, '4:45 PM'); assert.equal(g.hours.close, '5:00 PM');
  assert.equal((await withClock(atPH(17, 20), () => gate(b))).state, 'close_now', 'still forced after closing time');
  b.server.close();
});

test('routes: while a shift must close, cash movements are refused (409) but a shift that does not must-close still accepts them', async () => {
  const b = await build({ openedAt: OPENED_8AM });
  const post = () => fetch(b.base + '/api/pos/cash-shifts/movements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'cash_in', amount: 100, reason: 'Change fund top-up' }) });
  const refused = await withClock(atPH(16, 46), post);
  assert.equal(refused.status, 409); assert.match((await refused.json()).error, /time to close your cash shift/i);
  const early = await withClock(atPH(12, 0), post);
  assert.equal(early.status, 201, 'at noon the same movement is accepted');
  b.server.close();
});

test('routes: a shift opened after 4:45 PM (store hours not enforced) is not forced; with hours enforced nobody can open inside the window', async () => {
  const dev = await build({ openedAt: atPH(16, 50).toISOString() });
  assert.equal((await withClock(atPH(16, 55), () => gate(dev))).state, 'open');
  dev.server.close();
  const prod = await build({ openedAt: null, enforce: true });
  const g = await withClock(atPH(16, 46), () => gate(prod));
  assert.equal(g.state, 'store_closed'); assert.equal(g.hours.canOpenShift, false);
  const open = await withClock(atPH(16, 46), () => fetch(prod.base + '/api/pos/cash-shifts/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ openingCash: 500 }) }));
  assert.equal(open.status, 409); assert.match((await open.json()).error, /too close to closing time \(5:00 PM\).*4:45 PM/);
  assert.equal((await withClock(atPH(16, 40), () => gate(prod))).state, 'can_open', 'still open for business at 4:40 PM');
  prod.server.close(); delete process.env.ENFORCE_STORE_HOURS;
});

/* ---------- Part 3: wiring ---------- */
test('wiring: the end-of-day window cannot be dismissed, and the server refuses sales and cash collection on that shift', () => {
  const ui = read('Finance_Inventory', 'cash-shift-ui.js');
  assert.match(ui, /function dialog\(html, \{ locked = false \} = \{\}\)/);
  assert.match(ui, /if \(locked\) m\.dataset\.locked = '1'/);
  assert.match(ui, /e\.key === 'Escape' && !m\.dataset\.locked/, 'Escape is ignored on a locked window');
  assert.match(ui, /e\.target === m && !m\.dataset\.locked/, 'clicking outside is ignored on a locked window');
  assert.match(ui, /\$\{forced \? '' : '<button class="btn-secondary" data-cancel>Cancel<\/button>'\}/, 'no Cancel button when forced');
  assert.match(ui, /\{ locked: forced \}/);
  assert.match(ui, /g\.state === 'close_now' && current && !document\.querySelector\('\.cs-modal'\)\) closeDialog\(\{ forced: true \}\)/, 'opens by itself');
  assert.match(ui, /gateShell\('Time to close your shift'/);
  assert.ok(!/Before 5:00 PM|\(hr === 16|prompted/.test(ui), 'no hard-coded 5 PM and no one-time "prompted" flag any more');
  const pos = read('backend', 'pos-shop.js'), shifts = read('backend', 'cash-shifts.js');
  assert.equal((pos.match(/app\.locals\.shiftMustClose\(/g) || []).length, 2, 'a sale and a cash payment are both refused');
  assert.match(shifts, /if\(mustClose\(shift\.rows\[0\]\.opened_at\)\)return \{error:MUST_CLOSE_MSG,status:409\}/, 'cash movements are refused');
  assert.match(shifts, /app\.post\('\/api\/pos\/cash-shifts\/close'/, 'closing itself is never blocked');
  const from = shifts.indexOf("app.post('/api/pos/cash-shifts/close'");
  const next = shifts.slice(from + 10).search(/\n\s*app\.(get|post|put|patch|delete)\(/);
  const closeRoute = shifts.slice(from, next > 0 ? from + 10 + next : undefined);
  assert.ok(closeRoute.length > 500 && closeRoute.includes('UPDATE pos_cash_shifts SET closed_at'), 'isolated the close route');
  assert.ok(!/mustClose\(/.test(closeRoute), 'the close route has no must-close refusal');
});
