'use strict';
/* test/stock-count-rules.test.js — stock count: variance recount, weekly/monthly cadence, staff vs Finance permissions.
   Run:  node --no-warnings test/stock-count-rules.test.js
   1) the variance rule in JS and the same rule in SQL (run on sqlite) agree on every case
   2) the weekly / monthly planner
   3) who may call which route
   4) the submit -> recount -> submit -> post flow, against a stub database (checks the rules, not Postgres itself) */
const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const mount = require('../stock-count');
const { isOver, overSql, plan } = mount;

let passed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const okAsync = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

/* ---------- 1. variance rule: JS == SQL ---------- */
const th = (pct, value) => ({ pct, value });
const CASES = [
  // [system, counted, cost, threshold, expected, label]
  [100, 100, 10, th(5, 2000), false, 'no difference'],
  [100, 95, 10, th(5, 2000), false, 'exactly 5% is not ABOVE 5%'],
  [100, 94, 10, th(5, 2000), true, '6% is above 5%'],
  [1000, 990, 500, th(5, 2000), true, '1% but 10 x 500 = 5000 is above 2000 pesos'],
  [1000, 990, 100, th(5, 2000), false, '1% and 1000 pesos: both under'],
  [1000, 990, 200, th(5, 2000), false, 'exactly 2000 pesos is not above 2000'],
  [0, 3, 1, th(5, 0), true, 'system 0, something counted: above any percent'],
  [0, 0, 1, th(5, 0), false, 'system 0, counted 0'],
  [10, 12, 1, th(0, 0), true, 'both limits 0: any difference needs a recount'],
  [10, 10, 1, th(0, 0), false, 'both limits 0 and no difference'],
  [100, 50, 1, th(0, 2000), false, 'percent test off, 50 pesos is under'],
  [100, 50, 100, th(0, 2000), true, 'percent test off, 5000 pesos is above'],
  [100, 60, 1000, th(60, 0), false, 'value test off, 40% is under 60%'],
  [12.5, 12.75, 4, th(1, 0), true, 'decimals: 2% of 12.5 qty is above 1%'],
  [100, null, 10, th(5, 2000), false, 'not counted yet']
];
ok('variance rule (JS) gives the expected answer for every case', () => {
  for (const [s, c, cost, t, exp, label] of CASES) assert.equal(isOver(s, c, cost, t), exp, label);
});
ok('variance rule (SQL) gives the same answer as the JS rule', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE l (system_qty REAL, counted_qty REAL, unit_cost REAL); CREATE TABLE c (var_pct REAL, var_value REAL);');
  for (const [s, c, cost, t, exp, label] of CASES) {
    db.exec('DELETE FROM l; DELETE FROM c;');
    db.prepare('INSERT INTO l VALUES (?,?,?)').run(s, c, cost);
    db.prepare('INSERT INTO c VALUES (?,?)').run(t.pct, t.value);
    const row = db.prepare(`SELECT COUNT(*) FILTER (WHERE ${overSql('l', 'c')}) AS n FROM l, c`).get();
    assert.equal(row.n === 1, exp, 'SQL: ' + label);
  }
});

/* ---------- 2. cadence planner ---------- */
const SET = { highValue: 50000, fastMoves: 4, fastDays: 30, slowDays: 28 };
const P = (id, on, cost, moves, days) => ({ product_id: id, on_hand: on, unit_cost: cost, moves, days_since: days });
const rows = [
  P(1, 100, 600, 0, 7),      // 60,000 on hand -> high value, weekly
  P(2, 10, 5, 9, 7),         // 9 stock-outs -> fast, weekly
  P(3, 200, 400, 6, 7),      // both
  P(4, 10, 5, 1, 10),        // slow, counted 10 days ago -> not due
  P(5, 10, 5, 0, 26),        // slow, 26 days (28 - 3 grace = 25) -> due
  P(6, 10, 5, 0, null),      // slow, never counted -> due
  P(7, 10, 5, 3, 24)         // 3 stock-outs (< 4) is still slow; 24 days -> not due
];
ok('weekly items are always listed; slow items only when due', () => {
  const ids = plan(rows, SET, 'due').map((r) => r.product_id);
  assert.deepEqual(ids, [1, 2, 3, 5, 6]);
});
ok('mode "all" lists every product', () => assert.equal(plan(rows, SET, 'all').length, rows.length));
ok('each line says why it is weekly or monthly', () => {
  const by = Object.fromEntries(plan(rows, SET, 'all').map((r) => [r.product_id, r]));
  assert.deepEqual([by[1].cadence, by[1].why], ['weekly', 'High value']);
  assert.deepEqual([by[2].cadence, by[2].why], ['weekly', 'Fast moving']);
  assert.deepEqual([by[3].cadence, by[3].why], ['weekly', 'High value, fast moving']);
  assert.deepEqual([by[4].cadence, by[4].why], ['monthly', 'Slow moving']);
});
ok('a rule set to 0 is switched off (0 high-value limit does not make everything high value)', () => {
  const r = plan(rows, { ...SET, highValue: 0, fastMoves: 0 }, 'all');
  assert.ok(r.every((x) => x.cadence === 'monthly'));
});

/* ---------- 3 + 4. routes and flow against a stub database ---------- */
function makeApp() {
  const routes = [];
  const reg = (method) => (path, a, h) => routes.push({ method, path, roles: a.roles, handler: h });
  return { routes, app: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), locals: {} } };
}
class ValidationError extends Error { constructor(fields) { super(Object.values(fields)[0]); this.fields = fields; } }
const state = { count: null, lines: [], movements: [], audits: [], notified: [] };
const L = (id, sku, sys, counted, cost, extra) => ({ line_id: id, product_id: id, sku, name: 'Item ' + sku, unit: 'pc', system_qty: sys, counted_qty: counted, unit_cost: cost, note: null, needs_recount: false, recounts: 0, on_hand: sys, ...(extra || {}) });
function reset(status, lines) {
  state.count = { count_id: 1, count_no: 'SC-0001', status, var_pct: 5, var_value: 2000, recount_rounds: 0 };
  state.lines = lines; state.movements = []; state.audits = []; state.notified = [];
}
const client = {
  async query(sql, params) {
    if (/SELECT \* FROM stock_counts WHERE count_id/.test(sql)) return { rows: [state.count], rowCount: 1 };
    if (/FROM stock_count_lines l JOIN products p USING \(product_id\)\s+WHERE l.count_id = \$1 ORDER BY l.line_id FOR UPDATE OF l/.test(sql)) return { rows: state.lines.map((l) => ({ ...l })), rowCount: state.lines.length };
    if (/FROM stock_count_lines l JOIN products p USING \(product_id\)\s+WHERE l.count_id = \$1 ORDER BY l.product_id FOR UPDATE OF p/.test(sql)) return { rows: state.lines.map((l) => ({ ...l })), rowCount: state.lines.length };
    if (/SET first_qty = COALESCE/.test(sql)) { for (const l of state.lines) if (params[1].includes(l.line_id)) { l.first_qty = l.first_qty == null ? l.counted_qty : l.first_qty; l.counted_qty = null; l.needs_recount = true; l.recounts++; } return { rows: [], rowCount: 1 }; }
    if (/SET status = 'recount'/.test(sql)) { state.count.status = 'recount'; state.count.recount_rounds++; return { rows: [], rowCount: 1 }; }
    if (/SET needs_recount = FALSE/.test(sql)) { for (const l of state.lines) l.needs_recount = false; return { rows: [], rowCount: 1 }; }
    if (/SET status = 'submitted'/.test(sql)) { state.count.status = 'submitted'; return { rows: [], rowCount: 1 }; }
    if (/SET status = 'posted'/.test(sql)) { state.count.status = 'posted'; return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO stock_movements/.test(sql)) { state.movements.push(params); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  }
};
const { app, routes } = (() => { const a = makeApp(); return { app: a.app, routes: a.routes }; })();
app.locals.notifications = { notifyRole: async (role, spec) => { state.notified.push({ role, title: spec.title }); return 1; } };
mount({ app, pool: client, auth: (...roles) => ({ roles }), wrap: (fn) => fn, tx: (fn) => fn(client), audit: async (c, u, a, d) => { state.audits.push(d); }, ValidationError, str: (v) => String(v == null ? '' : v).trim(), TZ: 'Asia/Manila' });
const route = (method, path) => routes.find((r) => r.method === method && r.path === path);
const call = async (method, path, user, body) => {
  const r = route(method, path); const req = { user, params: { id: '1' }, body: body || {} }; let out; 
  await r.handler(req, { json: (v) => { out = v; }, status() { return this; } });
  return out;
};
const FIN = { id: 1, role: 'finance', name: 'Fin' }, STAFF = { id: 2, role: 'cashier', name: 'Staff' };
const fails = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return; } assert.fail('expected an error matching ' + re); };

ok('staff (cashier) may read the active count, enter counts and submit; nothing else', () => {
  const allowStaff = (m, p) => route(m, p).roles.includes('cashier');
  assert.ok(allowStaff('GET', '/api/stock-counts/active'));
  assert.ok(allowStaff('PUT', '/api/stock-counts/:id/lines'));
  assert.ok(allowStaff('POST', '/api/stock-counts/:id/submit'));
  for (const [m, p] of [['GET', '/api/stock-counts'], ['POST', '/api/stock-counts'], ['GET', '/api/stock-counts/:id'], ['POST', '/api/stock-counts/:id/post'],
    ['POST', '/api/stock-counts/:id/recount'], ['POST', '/api/stock-counts/:id/cancel'], ['GET', '/api/stock-counts/schedule'], ['PUT', '/api/stock-counts/schedule']])
    assert.deepEqual(route(m, p).roles, ['finance'], m + ' ' + p + ' must stay Finance only');
});
ok('/active and /schedule are registered before /:id', () => {
  const at = (m, p) => routes.findIndex((r) => r.method === m && r.path === p);
  assert.ok(at('GET', '/api/stock-counts/active') < at('GET', '/api/stock-counts/:id'));
  assert.ok(at('GET', '/api/stock-counts/schedule') < at('GET', '/api/stock-counts/:id'));
});

(async () => {
  await okAsync('submit is refused until every item is counted', async () => {
    reset('open', [L(1, 'A', 100, 100, 10), L(2, 'B', 50, null, 10)]);
    await fails(call('POST', '/api/stock-counts/:id/submit', STAFF), /1 item\(s\) are not counted yet/);
  });
  await okAsync('items above the threshold go back for a recount — only those items', async () => {
    reset('open', [L(1, 'A', 100, 100, 10), L(2, 'B', 100, 80, 10), L(3, 'C', 100, 99, 10)]);   // B is 20% off, C is 1%
    const r = await call('POST', '/api/stock-counts/:id/submit', STAFF);
    assert.deepEqual([r.status, r.recount], ['recount', 1]);
    assert.deepEqual(state.lines.map((l) => l.needs_recount), [false, true, false]);
    assert.equal(state.lines[1].counted_qty, null, 'the box is emptied so it is counted again from scratch');
    assert.equal(state.lines[1].first_qty, 80, 'the first count is kept');
    assert.ok(state.notified.some((n) => n.role === 'cashier' && /Recount needed/.test(n.title)));
  });
  await okAsync('Finance cannot post while a recount is in progress', async () => {
    await fails(call('POST', '/api/stock-counts/:id/post', FIN), /recount is not finished/);
  });
  await okAsync('recount submitted -> goes to Finance, who is notified', async () => {
    state.lines[1].counted_qty = 98;                            // recounted: now only 2% off
    const r = await call('POST', '/api/stock-counts/:id/submit', STAFF);
    assert.equal(r.status, 'submitted');
    assert.ok(state.notified.some((n) => n.role === 'finance' && /ready for review/.test(n.title)));
  });
  await okAsync('Finance posts: one movement per difference, in the right direction', async () => {
    const r = await call('POST', '/api/stock-counts/:id/post', FIN);
    assert.deepEqual([r.counted, r.increased, r.decreased], [3, 0, 2]);
    assert.deepEqual(state.movements.map((m) => [m[1], m[2], m[3]]), [['out', 'count_correction_down', 2], ['out', 'count_correction_down', 1]]);
    assert.equal(state.count.status, 'posted');
  });
  await okAsync('still above the limit after the recount: posting needs a note, then it works', async () => {
    reset('open', [L(1, 'A', 100, 70, 10)]);
    await call('POST', '/api/stock-counts/:id/submit', STAFF);                // sent back
    state.lines[0].counted_qty = 70;                                         // recounted: same number
    await call('POST', '/api/stock-counts/:id/submit', STAFF);                // no second automatic recount
    assert.equal(state.count.status, 'submitted');
    await fails(call('POST', '/api/stock-counts/:id/post', FIN), /Add a note explaining each one/);
    state.lines[0].note = 'Two pallets moved to the plating area';
    const r = await call('POST', '/api/stock-counts/:id/post', FIN);
    assert.equal(r.decreased, 1);
  });
  await okAsync('Finance cannot post an over-threshold item that was never recounted', async () => {
    reset('open', [L(1, 'A', 100, 50, 10)]);
    await fails(call('POST', '/api/stock-counts/:id/post', FIN), /must be recounted before posting/);
  });
  await okAsync('Finance can send over-threshold items back, naming only some SKUs', async () => {
    reset('submitted', [L(1, 'A', 100, 50, 10, { recounts: 1 }), L(2, 'B', 100, 40, 10, { recounts: 1 })]);
    const r = await call('POST', '/api/stock-counts/:id/recount', FIN, { skus: ['b'] });
    assert.equal(r.recount, 1);
    assert.deepEqual(state.lines.map((l) => l.needs_recount), [false, true]);
  });
  await okAsync('an item is sent back at most 3 times', async () => {
    reset('submitted', [L(1, 'A', 100, 50, 10, { recounts: 3 })]);
    await fails(call('POST', '/api/stock-counts/:id/recount', FIN), /already recounted 3 times/);
  });
  await okAsync('recount is refused when nothing is above the threshold', async () => {
    reset('submitted', [L(1, 'A', 100, 99, 10)]);
    await fails(call('POST', '/api/stock-counts/:id/recount', FIN), /No counted item is above/);
  });
  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' — SOME FAILED' : ''));
})();
