/* quote-automation.test.js — Task 4 (quick recipe price) and Task 5 (automatic approval routing): the pure rules.
   No database. Run:  node backend/test/quote-automation.test.js */
const path = require('path');
const { priceLines, routeQuote } = require(path.join(__dirname, '..', 'quote-automation.js')).pure;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => { if (cond) { pass++; console.log('  PASS  ' + label); } else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };
const row = (o) => Object.assign({ sku: 'RM-AL-ADC12', name: 'ADC12 ingot', department: 'Raw Materials', unit: 'kg', unit_cost: 185, is_archived: false, on_hand: 1000, qty_per_unit: 0.5, req_unit: 'kg' }, o);
const S = { tolerancePct: 5, minMarginPct: 0, valueLimit: 50000 };

console.log('\n1. Quick recipe priced with the Task 3 formula');
{
  const d = priceLines([row({}), row({ sku: 'FS-PWD', name: 'Powder', department: 'Finishing Supplies', unit_cost: 350, qty_per_unit: 0.02 })], { quantity: 100, markupPct: 20 });
  ok('cost per piece = 0.5 x 185 + 0.02 x 350 = 99.50', d.ok && d.costPerPiece === 99.5, d);
  ok('suggested price = cost x 1.20 = 119.40 per piece', d.pricePerPiece === 119.4, d.pricePerPiece);
  ok('totals follow the quantity: cost 9,950, price 11,940', d.costTotal === 9950 && d.total === 11940, [d.costTotal, d.total]);
  ok('margin on price = 16.7%', d.marginPct === 16.7, d.marginPct);
  ok('materials for the full quantity: 50 kg ADC12, 2 kg powder', d.lines[0].needed === 50 && d.lines[1].needed === 2, d.lines);
  const d2 = priceLines([row({}), row({ sku: 'FS-PWD', name: 'Powder', department: 'Finishing Supplies', unit_cost: 350, qty_per_unit: 0.02 })], { quantity: 300, markupPct: 20 });
  ok('quantity x3 -> every figure x3', d2.costTotal === 29850 && d2.total === 35820 && d2.lines[0].needed === 150, d2);
  const g = priceLines([row({ qty_per_unit: 500, req_unit: 'g' })], { quantity: 10, markupPct: 20 });
  ok('a line typed in g is converted to the kg stock unit', g.ok && g.lines[0].qtyPerPiece === 0.5 && g.costPerPiece === 92.5, g);
  const tiny = priceLines([row({ qty_per_unit: 0.00008, unit_cost: 1000 })], { quantity: 10000, markupPct: 20 });
  ok('a light part on a big order is not rounded away (0.00008 x 10,000 = 0.8 kg)', tiny.lines[0].needed === 0.8 && tiny.costTotal === 800, tiny);
}

console.log('\n2. Never a wrong number');
{
  const d = priceLines([row({}), row({ sku: 'FS-X', name: 'Chromate dip', unit_cost: 0 })], { quantity: 50, markupPct: 20 });
  ok('a material with no cost: cannot price yet, no number', !d.ok && d.status === 'cannot_price' && d.total === null && /Chromate dip has no cost/.test(d.problems[0].message), d);
  const a = priceLines([row({ is_archived: true })], { quantity: 50, markupPct: 20 });
  ok('an archived material blocks the price', !a.ok && a.problems[0].code === 'archived');
  const u = priceLines([row({ req_unit: 'pcs' })], { quantity: 50, markupPct: 20 });
  ok('a unit that cannot be converted blocks the price', !u.ok && u.problems[0].code === 'unit');
  ok('no lines: cannot price yet', priceLines([], { quantity: 50, markupPct: 20 }).status === 'cannot_price');
  const s = priceLines([row({ on_hand: 30 })], { quantity: 100, markupPct: 20 });
  ok('stock that cannot cover the quantity: priced, but short by 20 kg', s.ok && s.status === 'short' && s.shortfalls[0].short === 20 && s.lines[0].short === 20, s.shortfalls);
}

console.log('\n3. Routing: the cashier never chooses');
{
  const d = priceLines([row({})], { quantity: 100, markupPct: 20 });              // cost 9,250, system 11,100
  let r = routeQuote({ amount: 11100, draft: d, settings: S });
  ok('system price, fully costed, stock OK, under the limit -> quoted', r.route === 'quoted' && !r.rules.length, r);
  r = routeQuote({ amount: 10600, draft: d, settings: S });
  ok('4.5% below the system price is inside the ±5% band -> quoted', r.route === 'quoted', r);
  r = routeQuote({ amount: 10500, draft: d, settings: S });
  ok('5.4% below -> Finance, outside the band, with the reason', r.route === 'pending_approval' && r.rules.join() === 'outside_band' && /5.4% below the system price/.test(r.reasons[0]), r);
  r = routeQuote({ amount: 12000, draft: d, settings: S });
  ok('8.1% above -> Finance too (the band works both ways)', r.rules.includes('outside_band') && /above/.test(r.summary), r);
  r = routeQuote({ amount: 9000, draft: d, settings: S });
  ok('below cost -> Finance, says the loss', r.rules.includes('below_cost') && /loss of/.test(r.summary), r);
  r = routeQuote({ amount: 10600, draft: d, settings: Object.assign({}, S, { minMarginPct: 15 }) });
  ok('margin 12.7% under a 15% minimum -> Finance', r.rules.join() === 'below_margin' && r.numbers.marginPct === 12.7, r);
  r = routeQuote({ amount: 11100, draft: d, settings: Object.assign({}, S, { valueLimit: 10000 }) });
  ok('over the value limit -> Finance', r.rules.join() === 'over_limit' && /over the cashier limit/.test(r.summary), r);
  r = routeQuote({ amount: 11100, draft: d, settings: Object.assign({}, S, { valueLimit: 0 }) });
  ok('no limit set is never "no limit": it goes to Finance', r.route === 'pending_approval' && r.rules.includes('over_limit'), r);
  const blocked = priceLines([row({ unit_cost: 0 })], { quantity: 100, markupPct: 20 });
  r = routeQuote({ amount: 11100, draft: blocked, settings: S });
  ok('missing material cost -> Finance', r.rules.join() === 'not_costed' && /has no cost/.test(r.summary), r);
  r = routeQuote({ amount: 11100, draft: { ok: false, status: 'incomplete', missing: ['size'] }, settings: S });
  ok('a request the system cannot read -> Finance', r.rules.includes('not_costed') && /does not give the size/.test(r.summary), r);
  const short = priceLines([row({ on_hand: 10 })], { quantity: 100, markupPct: 20 });
  r = routeQuote({ amount: 11100, draft: short, settings: S });
  ok('stock short -> Finance, with the shortfall per material', r.rules.join() === 'stock_short' && /short by 40 kg/.test(r.summary) && r.numbers.shortfalls[0].short === 40, r);
  r = routeQuote({ amount: 11100, draft: d, settings: S, terms: { key: 'half', label: 'Half Payment' } });
  ok('partial-payment terms -> Finance', r.rules.join() === 'partial_terms', r);
  r = routeQuote({ amount: 9000, draft: d, settings: Object.assign({}, S, { valueLimit: 5000 }) });
  ok('every failing rule is listed, and the batch key is the sorted set', r.rules.length === 3 && r.key === 'below_cost+outside_band+over_limit', r.key);
  ok('the decision keeps the numbers for the log', r.numbers.cashierTotal === 9000 && r.numbers.systemTotal === 11100 && r.numbers.costTotal === 9250 && r.numbers.limit === 5000, r.numbers);
}

/* ---------------- 4. the draft itself: the real pricing.js + quote-automation.js over a scripted database ----------------
   The pool answers only the statements these modules send; materials are the demo catalogue of db/017 (ADC12 ₱185/kg, powder ₱350/kg ...). */
(async () => {
  const MATS = [
    { product_id: 1, sku: 'RM-AL-ADC12', name: 'Aluminum Alloy Ingot ADC12', department: 'Raw Materials', grade: 'ADC12', unit: 'kg', unit_cost: 185, on_hand: 6000, is_archived: false },
    { product_id: 2, sku: 'RM-AL-A380', name: 'Aluminum Alloy Ingot A380', department: 'Raw Materials', grade: 'A380', unit: 'kg', unit_cost: 192, on_hand: 5, is_archived: false },
    { product_id: 3, sku: 'RM-BRS-C37700', name: 'Brass Forging Rod C37700 Ø25mm', department: 'Raw Materials', grade: 'C37700', unit: 'kg', unit_cost: 435, on_hand: 3800, is_archived: false },
    { product_id: 4, sku: 'FS-PWD-BLK', name: 'Powder Coat Black (Matte)', department: 'Finishing Supplies', grade: null, unit: 'kg', unit_cost: 350, on_hand: 200, is_archived: false },
    { product_id: 5, sku: 'FS-NI-SALT', name: 'Nickel Plating Salt', department: 'Finishing Supplies', grade: null, unit: 'kg', unit_cost: 0, on_hand: 120, is_archived: false }
  ];
  const pool = { query: async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM pricing_rules/.test(s) && /^SELECT/.test(s)) return { rows: [{ fg_markup_pct: 20, quote_markup_pct: 20, rates: {} }], rowCount: 1 };
    if (/FROM products WHERE department = ANY/.test(s)) return { rows: MATS, rowCount: MATS.length };
    if (/FROM quote_rules/.test(s)) return { rows: [{ tolerance_pct: 5, min_margin_pct: 0, value_limit_php: 50000, cost_move_pct: 5 }], rowCount: 1 };
    if (/information_schema/.test(s)) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const app = { locals: {}, use() {}, get() {}, post() {}, put() {} };
  const deps = { app, pool, auth: () => null, wrap: (f) => f, tx: (f) => f(pool), audit: async () => {},
    ValidationError: class extends Error { constructor(f) { super(Object.values(f)[0]); this.fields = f; } }, str: (v) => (v == null ? '' : String(v).trim()) };
  app.locals.pricing = require(path.join(__dirname, '..', 'pricing.js'))(deps);
  const QA = require(path.join(__dirname, '..', 'quote-automation.js'))(deps);
  const specs = { material: 'Aluminum ADC12', size: 'Medium: 51 to 150 mm', thickness: '3.0 mm', finish: 'Powder Coated', service: 'None (as is)' };
  console.log('\n4. The automatic draft of a custom quote');
  let d = await QA.draft(pool, { itemType: 'Die-cast part', specs, quantity: '200 pcs' });
  // medium aluminum part = 0.45 kg (estimate) -> ADC12 0.45 x 1.10 = 0.495 kg/pc ; powder 0.45 x 0.05 = 0.0225 kg/pc
  ok('the raw material is the ADC12 ingot in stock, 0.495 kg per piece (0.45 kg + 10% scrap)', d.ok && d.lines[0].sku === 'RM-AL-ADC12' && d.lines[0].qtyPerPiece === 0.495, d.lines && d.lines[0]);
  ok('the finishing supply is the powder coat, 0.0225 kg per piece', d.lines[1] && d.lines[1].sku === 'FS-PWD-BLK' && d.lines[1].qtyPerPiece === 0.0225, d.lines && d.lines[1]);
  ok('cost per piece = 0.495 x 185 + 0.0225 x 350 = 99.45; price x 1.20 = 119.34', d.costPerPiece === 99.45 && d.pricePerPiece === 119.34, [d.costPerPiece, d.pricePerPiece]);
  ok('for 200 pcs: 99 kg ADC12, 4.5 kg powder, total 23,868.00', d.lines[0].needed === 99 && d.lines[1].needed === 4.5 && d.total === 23868, [d.lines[0].needed, d.lines[1].needed, d.total]);
  ok('the first guess is labelled an estimate', d.auto === true && d.lines.every((l) => l.estimate) && d.estimates.length >= 1, d.estimates);
  const d2 = await QA.draft(pool, { itemType: 'Die-cast part', specs, quantity: '400 pcs' });
  ok('double the quantity, double everything', d2.total === 47736 && d2.costTotal === d.costTotal * 2 && d2.lines[0].needed === 198, [d2.total, d2.costTotal]);
  d = await QA.draft(pool, { itemType: 'Die-cast part', specs, quantity: '200 pcs', lines: [{ sku: 'RM-AL-ADC12', qtyPerPiece: 600, unit: 'g' }] });
  ok('edited lines replace the guess (600 g ADC12 only = ₱111.00 per piece)', d.ok && !d.auto && d.lines.length === 1 && d.costPerPiece === 111, d);
  d = await QA.draft(pool, { itemType: 'Die-cast part', specs: Object.assign({}, specs, { material: 'Aluminum A380' }), quantity: '200 pcs' });
  ok('A380 with only 5 kg on hand: priced, and short by 94 kg', d.ok && d.status === 'short' && d.shortfalls[0].sku === 'RM-AL-A380' && d.shortfalls[0].short === 94, d.shortfalls);
  d = await QA.draft(pool, { itemType: 'Forged part', specs: Object.assign({}, specs, { material: 'Brass C37700', finish: 'Nickel Plated' }), quantity: '50 pcs' });
  ok('nickel salt has no cost: cannot price yet, no number', !d.ok && d.status === 'cannot_price' && d.total === null && /Nickel Plating Salt has no cost/.test(d.problems.map((p) => p.message).join(' ')), d.problems);
  d = await QA.draft(pool, { itemType: 'Forged part', specs: Object.assign({}, specs, { material: 'Brass C36000', finish: 'Polished' }), quantity: '50 pcs' });
  ok('no stock item for a material or finish: cannot price yet, says what to add', !d.ok && d.problems.some((p) => /No raw material for Brass C36000/.test(p.message)) && d.problems.some((p) => /No finishing supply for "Polished"/.test(p.message)), d.problems);
  d = await QA.draft(pool, { itemType: 'Die-cast part', specs: Object.assign({}, specs, { size: '' }), quantity: '200 pcs' });
  ok('a request without a size is incomplete, not priced', !d.ok && d.status === 'incomplete' && d.missing.includes('size'), d);
  const c = QA.forCustomer(await QA.draft(pool, { itemType: 'Die-cast part', specs: Object.assign({}, specs, { material: 'Aluminum A380' }), quantity: '200 pcs' }));
  ok('the customer sees the same price, but no costs, margins or stock counts', c.total > 0 && c.costTotal === undefined && c.marginPct === undefined && c.lines === undefined && !!c.stockNote, c);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
