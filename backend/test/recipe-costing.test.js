/* recipe-costing.test.js — Task 3: recipe-based costing (materials only).
   Pure rules (units, exact cost maths, price = cost x (1 + markup on cost), margin) plus the real recipe-costing.js running against a small
   scripted database that answers exactly the statements the module sends (no PostgreSQL needed; it never touches a real database).
   Run:  node backend/test/recipe-costing.test.js */
const path = require('path');
const fs = require('fs');
const mount = require(path.join(__dirname, '..', 'recipe-costing.js'));
const P = mount.pure;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => { if (cond) { pass++; console.log('  PASS  ' + label); } else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };
const near = (a, b) => Math.abs(a - b) < 0.0051;

/* ---------------- 1. pure rules ---------------- */
console.log('\n1. Cost maths and units');
{
  const row = (o) => Object.assign({ sku: 'M', name: 'Mat', department: 'Raw Materials', unit: 'kg', unit_cost: 100, is_archived: false, qty_per_unit: 1, req_unit: 'kg' }, o);
  let c = P.computeCost([row({ sku: 'A', name: 'ADC12', qty_per_unit: 0.35, unit_cost: 150 }), row({ sku: 'B', name: 'Powder', department: 'Finishing Supplies', qty_per_unit: 0.05, unit_cost: 90 })]);
  ok('cost = sum of (qty per piece x unit cost): 0.35 x 150 + 0.05 x 90 = 57.00', c.ok && c.cost === 57, c);
  c = P.computeCost([row({ qty_per_unit: 0.0007, unit_cost: 0.1 }), row({ sku: 'N', qty_per_unit: 0.0003, unit_cost: 0.2 })]);
  ok('the maths is exact (no 0.1 + 0.2 drift)', c.ok && P.lineCost(0.1, 0.2) === 0.02 && P.lineCost(0.2, 0.1) === 0.02, [c.cost, P.lineCost(0.1, 0.2)]);
  c = P.computeCost([row({ sku: 'A' }), row({ sku: 'Z', name: 'Scrap tin', unit_cost: 0 })]);
  ok('a material with no cost: "cannot calculate", and NO number is given', !c.ok && c.cost === null && /Scrap tin has no cost/.test(c.problems[0].message), c);
  c = P.computeCost([row({ is_archived: true, name: 'Old ingot' })]);
  ok('an archived material blocks the calculation', !c.ok && c.problems[0].code === 'archived', c);
  c = P.computeCost([]);
  ok('no recipe: nothing to calculate', !c.ok && c.problems[0].code === 'no_recipe', c);
  c = P.computeCost([row({ name: 'Flux', qty_per_unit: 500, req_unit: 'g', unit: 'kg', unit_cost: 200 })]);
  ok('recipe in g, stock in kg: converted (500 g = 0.5 kg x ₱200 = ₱100)', c.ok && c.cost === 100 && c.lines[0].convertedQty === 0.5, c);
  c = P.computeCost([row({ name: 'Flux', qty_per_unit: 2, req_unit: 'pcs', unit: 'kg', unit_cost: 200 })]);
  ok('recipe in pcs, stock in kg: blocked with a clear message', !c.ok && /recipe is in pcs but the item is stocked in kg/.test(c.problems[0].message) && /cannot be converted/.test(c.problems[0].message), c);
  ok('g -> kg', P.convert(250, 'g', 'kg').qty === 0.25);
  ok('kg -> g', P.convert(0.25, 'kg', 'g').qty === 250);
  ok('lb -> kg', P.convert(10, 'lb', 'kg').qty === 4.5359);
  ok('"L" is read as liter', P.convert(500, 'ml', 'L').qty === 0.5);
  ok('mass cannot become length', !P.convert(1, 'kg', 'm').ok);
  ok('sheet cannot become kg', /cannot be converted/.test(P.convert(1, 'sheet', 'kg').reason));
  ok('a quantity too small to store is refused, not rounded to 0', !P.convert(0.01, 'g', 'kg').ok && /too small/.test(P.convert(0.01, 'g', 'kg').reason));
  ok('same unit passes straight through', P.convert(1.2345, 'kg', 'KG').qty === 1.2345);
}

console.log('\n2. Selling price = cost x (1 + markup on COST), margin shown beside it');
{
  ok('20% markup on ₱100 cost = ₱120.00', P.priceFromCost(100, 20) === 120);
  ok('markup is on cost, not margin: 20% markup is a 16.7% margin (not 20%)', P.marginPct(120, 100) === 16.7);
  ok('₱57.00 cost -> ₱68.40 price', P.priceFromCost(57, 20) === 68.4);
  ok('margin of a price below cost is negative', P.marginPct(90, 100) < 0);
}

/* ---------------- 3. the module on a scripted database ---------------- */
function makeDb() {
  const D = { markup: 20, audit: [], products: new Map(), recipe: [], quotes: [] };
  const add = (o) => D.products.set(o.product_id, Object.assign({ unit: 'kg', is_archived: false, price_auto: true, cost_mode: 'auto', selling_price: 0, on_hand: 100, cost_note: null, cost_override_reason: null }, o));
  add({ product_id: 1, sku: 'RM-ADC12', name: 'Aluminum ADC12', department: 'Raw Materials', unit_cost: 150 });
  add({ product_id: 2, sku: 'FS-POWDER', name: 'Powder coat', department: 'Finishing Supplies', unit_cost: 90 });
  add({ product_id: 3, sku: 'RM-BRASS', name: 'Brass C377', department: 'Raw Materials', unit_cost: 400 });
  add({ product_id: 4, sku: 'RM-NOCOST', name: 'New alloy', department: 'Raw Materials', unit_cost: 0 });
  const fg = (id, sku, cost, extra) => add(Object.assign({ product_id: id, sku, name: sku + ' part', department: 'Finished Goods', unit: 'pcs', unit_cost: cost, selling_price: Math.round(cost * 120) / 100 }, extra || {}));
  fg(10, 'FG-A', 100); fg(11, 'FG-B', 40, { price_auto: false, selling_price: 50 }); fg(12, 'FG-C', 300); fg(13, 'FG-D', 80); fg(14, 'FG-E', 999, { cost_mode: 'override', cost_override_reason: 'quoted price from the foundry' });
  const r = (f, m, q, u) => D.recipe.push({ finished_product_id: f, material_product_id: m, qty_per_unit: q, unit: u || 'kg' });
  r(10, 1, 0.35); r(10, 2, 0.05); r(11, 1, 0.2); r(12, 3, 0.5); r(12, 4, 0.1); r(14, 1, 1);
  D.quotes = [
    { quote_no: 'QR-1', product_sku: 'FG-A', status: 'quoted', quantity: '200 pcs', suggested_cost: 11400, cost_stale_note: null },        // priced on cost 57.00 x 200
    { quote_no: 'QR-2', product_sku: 'FG-A', status: 'pending_approval', quantity: '10 pcs', suggested_cost: null, cost_stale_note: null },
    { quote_no: 'QR-3', product_sku: 'FG-A', status: 'new', quantity: '5 pcs', suggested_cost: null, cost_stale_note: null },            // not priced yet
    { quote_no: 'QR-4', product_sku: 'FG-A', status: 'accepted', quantity: '50 pcs', suggested_cost: 5000, cost_stale_note: null },        // already accepted: price is committed
    { quote_no: 'QR-5', product_sku: 'FG-D', status: 'quoted', quantity: '10 pcs', suggested_cost: 800, cost_stale_note: null }
  ];
  const trigger = (p) => { if (p.department === 'Finished Goods' && p.price_auto) p.selling_price = Math.round(p.unit_cost * (1 + D.markup / 100) * 100) / 100; };
  const rowsFor = (fid) => D.recipe.filter((x) => x.finished_product_id === fid).map((x) => { const m = D.products.get(x.material_product_id); return Object.assign({}, m, { qty_per_unit: x.qty_per_unit, req_unit: x.unit }); });
  const q = async (sql, p) => {
    const s = sql.replace(/\s+/g, ' ').trim(); p = p || [];
    if (/^(ALTER|CREATE|DO)\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/information_schema/.test(s)) return { rows: [{ x: 1 }], rowCount: 1 };
    if (/FROM pricing_rules/.test(s)) return { rows: [{ fg_markup_pct: D.markup }], rowCount: 1 };
    if (/^SELECT product_id, sku, name, department, unit, unit_cost, selling_price, price_auto, cost_mode, is_archived FROM products WHERE product_id = \$1/.test(s)) { const x = D.products.get(p[0]); return { rows: x ? [Object.assign({}, x)] : [], rowCount: x ? 1 : 0 }; }
    if (/FROM product_materials pm JOIN products m/.test(s)) { const rows = rowsFor(p[0]); return { rows, rowCount: rows.length }; }
    if (/^UPDATE products SET cost_note = \$2 WHERE product_id = \$1 AND cost_note IS DISTINCT/.test(s)) { D.products.get(p[0]).cost_note = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE products SET unit_cost = \$2, cost_note = NULL/.test(s)) { const x = D.products.get(p[0]); x.unit_cost = p[1]; x.cost_note = null; trigger(x); return { rows: [{ selling_price: x.selling_price }], rowCount: 1 }; }
    if (/^UPDATE products SET cost_note = NULL, cost_calculated_at/.test(s)) { D.products.get(p[0]).cost_note = null; return { rows: [], rowCount: 1 }; }
    if (/SELECT DISTINCT pm.finished_product_id AS id FROM product_materials pm JOIN products fg ON fg.product_id = pm.finished_product_id WHERE pm.material_product_id/.test(s)) {
      const ids = [...new Set(D.recipe.filter((x) => x.material_product_id === p[0] && !D.products.get(x.finished_product_id).is_archived).map((x) => x.finished_product_id))].sort((a, b) => a - b);
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    if (/SELECT DISTINCT pm.finished_product_id AS id FROM product_materials pm JOIN products fg ON fg.product_id = pm.finished_product_id WHERE NOT fg.is_archived/.test(s)) {
      const ids = [...new Set(D.recipe.map((x) => x.finished_product_id))].sort((a, b) => a - b); return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    if (/^UPDATE quote_requests SET cost_stale_at/.test(s)) {
      const hit = D.quotes.filter((x) => x.product_sku === p[0] && ['pending_approval', 'quoted'].includes(x.status) &&
        (x.suggested_cost == null || Math.abs(x.suggested_cost - p[2] * (parseFloat(x.quantity) || 0)) > 0.005));
      hit.forEach((x) => { x.cost_stale_note = p[1]; });
      return { rows: hit.map((x) => ({ quote_no: x.quote_no })), rowCount: hit.length };
    }
    if (/^SELECT product_id, sku, name, department, unit, unit_cost, selling_price, price_auto, cost_mode, cost_override_reason, cost_note FROM products WHERE sku = \$1/.test(s)) { const x = [...D.products.values()].find((y) => y.sku === p[0] && !y.is_archived); return { rows: x ? [Object.assign({}, x)] : [], rowCount: x ? 1 : 0 }; }
    if (/^SELECT product_id, unit_cost, cost_mode, department FROM products WHERE sku = \$1/.test(s)) { const x = [...D.products.values()].find((y) => y.sku === p[0]); return { rows: x ? [Object.assign({}, x)] : [], rowCount: x ? 1 : 0 }; }
    if (/^SELECT 1 FROM product_materials WHERE finished_product_id = \$1/.test(s)) { const n = D.recipe.filter((x) => x.finished_product_id === p[0]).length; return { rows: n ? [{ x: 1 }] : [], rowCount: n ? 1 : 0 }; }
    if (/^UPDATE products SET cost_mode = 'override'/.test(s)) { const x = D.products.get(p[0]); x.cost_mode = 'override'; x.cost_override_reason = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE products SET cost_override_reason = \$2/.test(s)) { D.products.get(p[0]).cost_override_reason = p[1]; return { rows: [], rowCount: 1 }; }
    if (/^UPDATE products SET cost_mode = 'auto'/.test(s)) { const x = D.products.get(p[0]); x.cost_mode = 'auto'; x.cost_override_reason = null; return { rows: [], rowCount: 1 }; }
    throw new Error('the scripted database does not know this statement: ' + s.slice(0, 140));
  };
  return { D, db: { query: q }, trigger };
}
class ValidationError extends Error { constructor(f) { super(Object.values(f)[0]); this.fields = f; } }
function boot() {
  const w = makeDb(), app = { locals: {}, get() {}, post() {}, put() {}, delete() {} };
  const audit = async (c, user, action, detail) => { w.D.audit.push({ user: user.name, action, detail }); };
  const rc = mount({ app, pool: w.db, auth: () => (q, r, n) => n(), wrap: (f) => f, tx: (fn) => fn(w.db), audit, ValidationError, str: (v) => String(v == null ? '' : v).trim() });
  return Object.assign(w, { rc, audit, user: { id: 4, name: 'Finance Fiona', roleLabel: 'Finance' } });
}
const byName = (D, a) => D.audit.filter((x) => x.action === a);

(async () => {
  console.log('\n3. A finished good gets its cost from the recipe');
  {
    const w = boot(); await w.rc.ready;
    const r = await w.rc.recalcOne(w.db, 10, { user: w.rc.SYSTEM, why: 'test' });
    const fg = w.D.products.get(10);
    ok('FG-A cost becomes ₱57.00 (0.35 kg x 150 + 0.05 kg x 90), not the typed ₱100', r.status === 'updated' && fg.unit_cost === 57, [r, fg.unit_cost]);
    ok('its automatic price follows: ₱68.40 (cost x 1.20)', fg.selling_price === 68.4 && r.repriced === true, fg.selling_price);
    ok('the decision is in the audit log, by the system, with old and new cost', byName(w.D, 'Cost recalculated').length === 1 && /₱100\.00 → ₱57\.00/.test(w.D.audit[0].detail) && w.D.audit[0].user === 'System (automatic)', w.D.audit);
    const again = await w.rc.recalcOne(w.db, 10, { user: w.rc.SYSTEM });
    ok('recalculating again changes nothing and writes no second audit line', again.status === 'unchanged' && byName(w.D, 'Cost recalculated').length === 1);
    const man = await w.rc.recalcOne(w.db, 11, { user: w.rc.SYSTEM, why: 'test' });
    ok('a manual price is never touched (₱50.00 stays) but the cost still follows (₱30.00)', man.status === 'updated' && w.D.products.get(11).selling_price === 50 && w.D.products.get(11).unit_cost === 30 && man.repriced === false, man);
    w.D.products.get(1).unit_cost = 300; await w.rc.recalcOne(w.db, 11, { user: w.rc.SYSTEM, why: 'test' });
    ok('a manual price that falls BELOW the new cost is called out (cost ₱60 > price ₱50)', byName(w.D, 'Cost recalculated').some((a) => /BELOW the cost/.test(a.detail)));
    const noRec = await w.rc.recalcOne(w.db, 13, { user: w.rc.SYSTEM });
    ok('no recipe: the typed cost stays (₱80.00)', noRec.status === 'no_recipe' && w.D.products.get(13).unit_cost === 80);
    const ov = await w.rc.recalcOne(w.db, 14, { user: w.rc.SYSTEM });
    ok('an overridden cost is left alone', ov.status === 'override' && w.D.products.get(14).unit_cost === 999);
  }

  console.log('\n4. Cannot price yet: never a wrong number');
  {
    const w = boot(); await w.rc.ready;
    const r = await w.rc.recalcOne(w.db, 12, { user: w.rc.SYSTEM, why: 'test' });
    ok('a material with no cost: the FG keeps its last cost (₱300.00) and is marked blocked', r.status === 'blocked' && w.D.products.get(12).unit_cost === 300, r);
    ok('the reason is saved on the product and in the audit log', /New alloy has no cost/.test(w.D.products.get(12).cost_note) && byName(w.D, 'Cost not calculated').length === 1);
    w.D.products.get(4).unit_cost = 200;
    const fixed = await w.rc.recalcOne(w.db, 12, { user: w.rc.SYSTEM, why: 'test' });
    ok('once the material has a cost the FG is calculated and the note clears (0.5 x 400 + 0.1 x 200 = ₱220.00)', fixed.status === 'updated' && w.D.products.get(12).unit_cost === 220 && w.D.products.get(12).cost_note === null, fixed);
    w.D.recipe.push({ finished_product_id: 13, material_product_id: 3, qty_per_unit: 2, unit: 'pcs' });       // recipe saved in pcs, the item is stocked in kg
    const u = await w.rc.recalcOne(w.db, 13, { user: w.rc.SYSTEM, why: 'test' });
    ok('a unit that cannot be converted blocks with a clear message', u.status === 'blocked' && /recipe is in pcs but the item is stocked in kg/.test(u.problems[0].message), u);
  }

  console.log('\n5. Cost ripple');
  {
    const w = boot(); await w.rc.ready;
    await w.rc.reconcileAll(w.rc.SYSTEM, 'setup');                    // FG-A is now ₱57.00 / ₱68.40, FG-B ₱30.00
    w.D.quotes.forEach((x) => { x.cost_stale_note = null; });
    w.D.audit.length = 0;
    w.D.products.get(1).unit_cost = 180;                              // ADC12 moves from ₱150 to ₱180 (moving average on a new delivery)
    const rip = await w.rc.ripple(w.db, 1, { user: w.user, name: 'Aluminum ADC12', oldCost: 150, newCost: 180 });
    ok('every finished good that uses the material is recalculated (FG-A, FG-B), others are not', rip.affected === 3 && rip.recalculated === 2 && w.D.products.get(10).unit_cost === 67.5 && w.D.products.get(11).unit_cost === 36, rip);
    ok('FG-A: 0.35 x 180 + 0.05 x 90 = ₱67.50 and its price is repriced to ₱81.00', w.D.products.get(10).selling_price === 81 && rip.repriced === 1, w.D.products.get(10));
    ok('FG-B keeps its manual price (₱50.00)', w.D.products.get(11).selling_price === 50);
    ok('FG-D (no recipe) and FG-C (other materials) are untouched', w.D.products.get(13).unit_cost === 80 && w.D.products.get(12).unit_cost === 300);
    ok('the overridden FG-E keeps ₱999.00', w.D.products.get(14).unit_cost === 999);
    const flagged = w.D.quotes.filter((x) => x.cost_stale_note).map((x) => x.quote_no).sort();
    ok('open quotes priced on the old cost are flagged: the quoted one and the one waiting for approval', JSON.stringify(flagged) === JSON.stringify(['QR-1', 'QR-2']), flagged);
    ok('a quote not priced yet, an accepted quote and another product\'s quote are NOT flagged', !w.D.quotes.find((x) => x.quote_no === 'QR-3').cost_stale_note && !w.D.quotes.find((x) => x.quote_no === 'QR-4').cost_stale_note && !w.D.quotes.find((x) => x.quote_no === 'QR-5').cost_stale_note);
    ok('the flag says what changed (old cost, new cost)', /₱57\.00 to ₱67\.50/.test(w.D.quotes[0].cost_stale_note), w.D.quotes[0].cost_stale_note);
    ok('one audit line per finished good plus one ripple summary, all by the Finance user', byName(w.D, 'Cost recalculated').length === 2 && byName(w.D, 'Cost ripple').length === 1 && /2 recalculated, 1 repriced, 2 open quotes flagged/.test(byName(w.D, 'Cost ripple')[0].detail), w.D.audit);
    const second = await w.rc.ripple(w.db, 1, { user: w.user, name: 'Aluminum ADC12', oldCost: 180, newCost: 180 });
    ok('running the ripple twice changes nothing the second time', second.recalculated === 0 && second.quotesFlagged === 0, second);
    w.D.products.get(4).unit_cost = 0;
    const blockRip = await w.rc.ripple(w.db, 3, { user: w.user, name: 'Brass', oldCost: 400, newCost: 410 });
    ok('a ripple that cannot price a finished good reports it instead of guessing', blockRip.blocked === 1 && w.D.products.get(12).unit_cost === 300, blockRip);
  }

  console.log('\n6. Typed cost is refused; override needs a reason');
  {
    const w = boot(); await w.rc.ready; await w.rc.reconcileAll(w.rc.SYSTEM, 'setup'); w.D.audit.length = 0;
    const p = (cost) => ({ sku: 'FG-A', name: 'FG-A part', department: 'Finished Goods', unitCost: cost });
    let err = null; try { await w.rc.guardProductCost(w.db, p(70), {}, w.user); } catch (e) { err = e; }
    ok('typing a different cost on a recipe-costed finished good is refused', err && err.fields.unitCost && /calculated from the recipe/.test(err.fields.unitCost), err && err.fields);
    err = null; try { await w.rc.guardProductCost(w.db, p(70), { costOverrideReason: 'abc' }, w.user); } catch (e) { err = e; }
    ok('a reason under 5 characters is not enough', !!err && !!err.fields.costOverrideReason);
    const same = await w.rc.guardProductCost(w.db, p(57), {}, w.user);
    ok('saving the form with the calculated cost unchanged is fine', same.unitCost === 57 && same.mode === 'auto');
    const noCost = await w.rc.guardProductCost(w.db, { sku: 'FG-A', name: 'FG-A part', department: 'Finished Goods', unitCost: null }, {}, w.user);
    ok('a form that does not send the cost keeps the calculated one', noCost.unitCost === 57);
    const o = await w.rc.guardProductCost(w.db, p(70), { costOverrideReason: 'Foundry quoted a fixed price' }, w.user);
    ok('with a reason the override is accepted, saved and logged', o.mode === 'override' && w.D.products.get(10).cost_mode === 'override' && byName(w.D, 'Cost override').length === 1 && /Foundry quoted a fixed price/.test(byName(w.D, 'Cost override')[0].detail), w.D.audit);
    const kept = await w.rc.recalcOne(w.db, 10, { user: w.rc.SYSTEM });
    ok('while overridden, recipe changes and ripples do not overwrite it', kept.status === 'override');
    const back = await w.rc.guardProductCost(w.db, p(70), { costBackToAuto: true }, w.user);
    ok('"back to auto" is logged and recalculates from the recipe', back.recalc === true && w.D.products.get(10).cost_mode === 'auto' && byName(w.D, 'Cost override removed').length === 1);
    const detail = await w.rc.breakdown(w.db, 'FG-A');
    ok('the breakdown shows markup on cost with the margin beside it, and the suggested price', detail.markupPct === 20 && detail.suggestedPrice === 68.4 && detail.lines.length === 2, detail);
  }

  console.log('\n7. Wiring (source contracts; the production and stock-in paths need PostgreSQL to run for real)');
  {
    const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const prod = src('production.js'), srv = src('server.js'), shop = src('shop-extras.js');
    ok('production confirm recalculates the cost and blocks if it cannot be worked out', /recalcOne\(client, fgInfo\.product_id/.test(prod) && /cannot be worked out yet/.test(prod));
    ok('production books the finished batch at the recipe cost (not the typed standard cost)', /COALESCE\(\$6::numeric/.test(prod) && !/keeps Finance's standard cost/.test(prod));
    ok('saving the recipe recalculates straight away', /recalcOne\(client, fg\.product_id, \{ user: req\.user, why: 'recipe changed' \}\)/.test(prod));
    ok('recipe lines in another unit are converted or refused', /rcPure\.convert\(c\.q, c\.entryUnit, m\.unit\)/.test(prod));
    ok('a stock-in that moves the moving average ripples in the same transaction', /rc\.ripple\(client, prod\.product_id/.test(srv));
    ok('editing a material cost by hand ripples too', /rc\.ripple\(client, before\.product_id/.test(srv));
    ok('re-pricing a quote clears its "cost changed" flag', /cost_stale_at=NULL, cost_stale_note=NULL/.test(shop));
    ok('the fg_auto_price trigger and fg_markup_pct are still the only price formula', !/selling_price\s*=/.test(src('recipe-costing.js').replace(/\/\*[\s\S]*?\*\//g, '')) && /fg_markup_pct/.test(src('pricing.js')));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
