/* recipe-costing.js — Task 3: the cost of a finished good comes from its recipe, so nobody types it.

     unit cost of a finished good  =  SUM( quantity per piece of each raw material / finishing supply  x  that item's CURRENT unit cost )

   Materials only. Process, finishing labour and tooling are NOT in this cost (they can be added later as extra recipe lines).
   The selling price is still made by the database trigger fg_auto_price (pricing.js): unit cost x (1 + markup %), markup ON COST.
   This module only keeps products.unit_cost right; the trigger then reprices every finished good on automatic pricing.

   When the cost is recalculated (every one is written to the audit log, with the system as the actor):
     - the recipe is saved                         (production.js  PUT /api/production/requirements/:sku)
     - a material's unit cost changes              (cost ripple: stock-in moving average, or a product edit)
     - a production is confirmed                   (the batch is booked at this cost)
     - the safety sweep (every 6 hours and on start) catches any path that bypassed the ripple
   A cost ripple also flags OPEN quotes (priced / waiting for approval) that were priced on the old cost.

   It never writes a wrong number: if a material has no cost, is archived, or its unit cannot be converted, the finished good
   keeps its last cost, is marked "cannot calculate" with the reason, and the audit log says why.
   A finished good can have its cost overridden by Finance WITH A REASON (cost_mode = 'override'); the override is logged and
   can be switched back to automatic at any time. */

/* ---------- pure helpers (no database; unit-tested in test/recipe-costing.test.js) ---------- */
const GROUPS = {
  mass:   { mg: 1e-6, g: 1e-3, kg: 1, lb: 0.45359237, tonne: 1000 },
  volume: { ml: 1e-3, liter: 1 },
  length: { mm: 1e-3, cm: 1e-2, m: 1, ft: 0.3048 }
};
const ALIASES = { l: 'liter', liters: 'liter', litre: 'liter', litres: 'liter', t: 'tonne', tonnes: 'tonne', kgs: 'kg', grams: 'g', gram: 'g', lbs: 'lb', pound: 'lb', meter: 'm', metre: 'm', feet: 'ft', foot: 'ft' };
const normUnit = (u) => { const k = String(u == null ? '' : u).trim().toLowerCase(); return ALIASES[k] || k; };
const groupOf = (u) => Object.keys(GROUPS).find((g) => GROUPS[g][normUnit(u)] != null) || null;
const convertibleUnits = (u) => { const g = groupOf(u); return g ? Object.keys(GROUPS[g]) : [normUnit(u)]; };
// how many `to` one `from` is (no rounding), or null when the two units cannot be converted
const unitFactor = (from, to) => { const f = normUnit(from), t = normUnit(to); if (f === t) return 1; const g = groupOf(f); return g && g === groupOf(t) ? GROUPS[g][f] / GROUPS[g][t] : null; };
const q4 = (n) => Math.round(Number(n) * 1e4) / 1e4;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// quantity written in `from`, converted into `to` (4 decimals, like product_materials.qty_per_unit). Never guesses.
function convert(qty, from, to) {
  const f = normUnit(from), t = normUnit(to), n = Number(qty);
  if (!Number.isFinite(n)) return { ok: false, reason: 'The quantity is not a number.' };
  if (f === t) return { ok: true, qty: q4(n), converted: false };
  const gf = groupOf(f), gt = groupOf(t);
  if (!gf || !gt || gf !== gt)
    return { ok: false, reason: `The recipe unit "${from}" cannot be converted to the stock unit "${to}". Enter the quantity in ${to}, or change the unit of the item.` };
  const out = n * GROUPS[gf][f] / GROUPS[gt][t], rounded = q4(out);
  if (n > 0 && (rounded <= 0 || Math.abs(rounded - out) / out > 0.01))
    return { ok: false, reason: `${n} ${from} is too small to keep in ${to} (the smallest recipe quantity is 0.0001 ${to}). Use a smaller unit for the item or a bigger quantity.` };
  return { ok: true, qty: rounded, converted: true, from: n + ' ' + f, to: rounded + ' ' + t };
}

// exact: quantity (4 dp) x cost (2 dp) with integers, no 0.1 + 0.2 surprises
const lineCost = (qty, cost) => Math.round(Number(qty) * 1e4) * Math.round(Number(cost) * 1e2) / 1e6;

/* rows: { sku, name, department, unit (stock unit now), unit_cost, is_archived, qty_per_unit, req_unit (unit the recipe was saved in) }
   -> { ok, cost, lines[], problems[] }. ok=false means "cannot calculate": no number is returned. */
function computeCost(rows) {
  const lines = [], problems = [];
  (rows || []).forEach((r) => {
    const base = { sku: r.sku, name: r.name, department: r.department, unit: r.unit, unitCost: +r.unit_cost || 0, qtyPerUnit: +r.qty_per_unit, recipeUnit: r.req_unit || r.unit };
    if (r.is_archived) { problems.push({ sku: r.sku, code: 'archived', message: `${r.name} is archived: remove it from the recipe or restore it.` }); lines.push(Object.assign(base, { cost: null })); return; }
    let qty = +r.qty_per_unit;
    if (normUnit(r.req_unit || r.unit) !== normUnit(r.unit)) {
      const c = convert(qty, r.req_unit, r.unit);
      if (!c.ok) { problems.push({ sku: r.sku, code: 'unit', message: `${r.name}: the recipe is in ${r.req_unit} but the item is stocked in ${r.unit}. ${c.reason}` }); lines.push(Object.assign(base, { cost: null })); return; }
      qty = c.qty; base.convertedQty = qty;
    }
    if (!(+r.unit_cost > 0)) { problems.push({ sku: r.sku, code: 'no_cost', message: `${r.name} has no cost yet. Record a delivery with its price, or set its unit cost.` }); lines.push(Object.assign(base, { cost: null })); return; }
    lines.push(Object.assign(base, { qtyUsed: qty, cost: lineCost(qty, r.unit_cost) }));
  });
  if (!lines.length) return { ok: false, cost: null, lines, problems: [{ code: 'no_recipe', message: 'There is no recipe yet.' }] };
  if (problems.length) return { ok: false, cost: null, lines, problems };
  return { ok: true, cost: r2(lines.reduce((s, l) => s + l.cost, 0)), lines, problems: [] };
}
const priceFromCost = (cost, markupPct) => r2(Number(cost) * (1 + Number(markupPct) / 100));         // same formula as the fg_auto_price trigger
const marginPct = (price, cost) => (Number(price) > 0 ? Math.round(((price - cost) / price) * 1000) / 10 : 0);   // margin on PRICE, shown beside the markup on COST
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SYSTEM = { id: null, name: 'System (automatic)', roleLabel: 'System' };
const MATERIAL_DEPTS = ['Raw Materials', 'Finishing Supplies'];

/* ---------- the module ---------- */
module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  async function ensure() {
    try {
      const had = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'cost_mode'`)).rowCount;
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_mode TEXT NOT NULL DEFAULT 'auto' CHECK (cost_mode IN ('auto','override'))`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_override_reason TEXT`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_override_by INT REFERENCES users(user_id)`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_override_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_note TEXT`);          // why the cost could not be calculated (empty when it is fine)
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_calculated_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE IF EXISTS production_records ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2)`);   // recipe cost the batch was booked at
      if (app.locals.pricing && app.locals.pricing.ready) await app.locals.pricing.ready;            // the price trigger must exist before costs are rewritten
      if (app.locals.production && app.locals.production.ready) await app.locals.production.ready;   // product_materials must exist
      if (!had) await reconcileAll(SYSTEM, 'first start with recipe costing');
      return true;
    } catch (err) { console.warn('[recipe-costing] setup failed:', err.message); return false; }
  }
  let quotesCols = null;
  const quoteColumns = () => quotesCols || (quotesCols = (async () => {
    try {
      await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS cost_stale_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS cost_stale_note TEXT`);
      return true;
    } catch (e) { quotesCols = null; return false; }
  })());
  const ready = ensure();

  async function recipeRows(db, fgId) {
    return (await db.query(
      `SELECT m.product_id, m.sku, m.name, m.department, m.unit, m.unit_cost, m.is_archived, m.on_hand, pm.qty_per_unit, pm.unit AS req_unit
         FROM product_materials pm JOIN products m ON m.product_id = pm.material_product_id
        WHERE pm.finished_product_id = $1 ORDER BY m.department, m.name`, [fgId])).rows;
  }
  async function markup(db) {
    const r = (await db.query('SELECT fg_markup_pct FROM pricing_rules WHERE id = 1')).rows[0];
    return r && r.fg_markup_pct != null ? +r.fg_markup_pct : 20;
  }
  const lock = async (db, id) => (await db.query(
    `SELECT product_id, sku, name, department, unit, unit_cost, selling_price, price_auto, cost_mode, is_archived FROM products WHERE product_id = $1 FOR UPDATE`, [id])).rows[0];

  /* Recalculate ONE finished good from its recipe and save the result. Returns what happened; never throws for "cannot calculate". */
  async function recalcOne(db, fgId, { user = SYSTEM, why = 'recipe' } = {}) {
    const fg = await lock(db, fgId);
    if (!fg || fg.department !== 'Finished Goods' || fg.is_archived) return { status: 'skipped' };
    const rows = await recipeRows(db, fgId);
    const base = { sku: fg.sku, name: fg.name, oldCost: +fg.unit_cost, oldPrice: +fg.selling_price, priceAuto: fg.price_auto !== false };
    if (!rows.length) return Object.assign(base, { status: 'no_recipe' });       // no recipe: a typed cost stays as it is
    if (fg.cost_mode === 'override') return Object.assign(base, { status: 'override', newCost: +fg.unit_cost, newPrice: +fg.selling_price });
    const c = computeCost(rows);
    if (!c.ok) {
      const note = c.problems.map((p) => p.message).join(' ');
      await db.query('UPDATE products SET cost_note = $2 WHERE product_id = $1 AND cost_note IS DISTINCT FROM $2', [fgId, note]);
      await audit(db, user, 'Cost not calculated', `${fg.name} (${fg.sku}) kept its cost of ${peso(fg.unit_cost)}: ${note} [${why}]`);
      return Object.assign(base, { status: 'blocked', problems: c.problems, newCost: +fg.unit_cost, newPrice: +fg.selling_price });
    }
    const changed = Math.abs(c.cost - +fg.unit_cost) >= 0.005;
    let price = +fg.selling_price;
    if (changed) {
      price = +(await db.query('UPDATE products SET unit_cost = $2, cost_note = NULL, cost_calculated_at = now() WHERE product_id = $1 RETURNING selling_price', [fgId, c.cost])).rows[0].selling_price;   // the trigger reprices automatic ones
    } else await db.query('UPDATE products SET cost_note = NULL, cost_calculated_at = now() WHERE product_id = $1', [fgId]);
    const repriced = changed && fg.price_auto !== false && Math.abs(price - +fg.selling_price) >= 0.005;
    const belowCost = fg.price_auto === false && price > 0 && price < c.cost;       // a manual price is never touched, but it must not silently lose money
    if (changed) await audit(db, user, 'Cost recalculated',
      `${fg.name} (${fg.sku}) unit cost ${peso(fg.unit_cost)} → ${peso(c.cost)} from its recipe [${why}]` +
      (repriced ? `; price ${peso(base.oldPrice)} → ${peso(price)} (automatic)` : fg.price_auto === false ? `; manual price ${peso(price)} left as it is` : '') +
      (belowCost ? `; WARNING: the manual price is now BELOW the cost` : ''));
    return Object.assign(base, { status: changed ? 'updated' : 'unchanged', newCost: c.cost, newPrice: price, repriced, belowCost, lines: c.lines });
  }

  /* Open quotes whose price was worked out on the old cost: say so, so the price gets looked at again. */
  async function flagQuotes(db, results, why) {
    if (!(await quoteColumns())) return 0;
    let n = 0;
    for (const r of results.filter((x) => x.status === 'updated')) {
      const note = `Cost of ${r.name} changed from ${peso(r.oldCost)} to ${peso(r.newCost)} on ${new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })}: this price was worked out on the old cost. Check it again.`;
      const { rows } = await db.query(
        `UPDATE quote_requests SET cost_stale_at = now(), cost_stale_note = $2
          WHERE product_sku = $1 AND status IN ('pending_approval','quoted')
            AND (suggested_cost IS NULL OR abs(suggested_cost - $3 * COALESCE(NULLIF(substring(quantity from '[0-9]+(\\.[0-9]+)?'), '')::numeric, 0)) > 0.005)
        RETURNING quote_no`, [r.sku, note, r.newCost]);
      n += rows.length; r.quotesFlagged = rows.map((q) => q.quote_no);
    }
    return n;
  }

  /* Cost ripple: a raw material / finishing supply changed cost, so every finished good that uses it is recalculated, repriced and its open quotes flagged. */
  async function ripple(db, materialId, { user = SYSTEM, name, oldCost, newCost, why } = {}) {
    const ids = (await db.query(
      `SELECT DISTINCT pm.finished_product_id AS id FROM product_materials pm JOIN products fg ON fg.product_id = pm.finished_product_id
        WHERE pm.material_product_id = $1 AND NOT fg.is_archived ORDER BY 1`, [materialId])).rows.map((r) => r.id);
    if (!ids.length) return { affected: 0, results: [], quotesFlagged: 0 };
    const label = why || `${name || 'material'} cost ${peso(oldCost)} → ${peso(newCost)}`;
    const results = [];
    for (const id of ids) results.push(await recalcOne(db, id, { user, why: 'cost ripple: ' + label }));     // ascending id: no two ripples lock in a different order
    const quotesFlagged = await flagQuotes(db, results, label);
    const upd = results.filter((r) => r.status === 'updated'), blocked = results.filter((r) => r.status === 'blocked');
    await audit(db, user, 'Cost ripple',
      `${label}: ${ids.length} finished good${ids.length === 1 ? '' : 's'} use it; ${upd.length} recalculated, ${upd.filter((r) => r.repriced).length} repriced, ` +
      `${quotesFlagged} open quote${quotesFlagged === 1 ? '' : 's'} flagged` + (blocked.length ? `, ${blocked.length} could not be calculated` : ''));
    return { affected: ids.length, recalculated: upd.length, repriced: upd.filter((r) => r.repriced).length, quotesFlagged, blocked: blocked.length,
      results: results.map((r) => ({ sku: r.sku, name: r.name, status: r.status, oldCost: r.oldCost, newCost: r.newCost, oldPrice: r.oldPrice, newPrice: r.newPrice, belowCost: r.belowCost || undefined, quotesFlagged: r.quotesFlagged })) };
  }

  /* The safety net: every finished good with a recipe, in id order. Idempotent; only writes what changed. */
  async function reconcileAll(user = SYSTEM, why = 'sweep') {
    const ids = (await pool.query(`SELECT DISTINCT pm.finished_product_id AS id FROM product_materials pm JOIN products fg ON fg.product_id = pm.finished_product_id WHERE NOT fg.is_archived ORDER BY 1`)).rows.map((r) => r.id);
    let updated = 0, blocked = 0;
    for (const id of ids) {
      const r = await tx(async (client) => { const x = await recalcOne(client, id, { user, why }); if (x.status === 'updated') await flagQuotes(client, [x], why); return x; });
      if (r.status === 'updated') updated++; else if (r.status === 'blocked') blocked++;
    }
    return { checked: ids.length, updated, blocked };
  }

  /* What the product form and the quote screens show: the breakdown, the price and the margin beside the markup. */
  async function breakdown(db, sku) {
    const fg = (await db.query(`SELECT product_id, sku, name, department, unit, unit_cost, selling_price, price_auto, cost_mode, cost_override_reason, cost_note FROM products WHERE sku = $1 AND NOT is_archived`, [sku])).rows[0];
    if (!fg || fg.department !== 'Finished Goods') throw new ValidationError({ sku: 'That finished good does not exist' });
    const rows = await recipeRows(db, fg.product_id), c = rows.length ? computeCost(rows) : null, m = await markup(db);
    const cost = fg.cost_mode === 'override' || !c || !c.ok ? +fg.unit_cost : c.cost;
    return { sku: fg.sku, name: fg.name, hasRecipe: rows.length > 0, mode: fg.cost_mode, overrideReason: fg.cost_override_reason || undefined,
      calculatedCost: c && c.ok ? c.cost : null, unitCost: +fg.unit_cost, problems: c ? c.problems : [], note: fg.cost_note || undefined,
      markupPct: m, priceAuto: fg.price_auto !== false, sellingPrice: +fg.selling_price, suggestedPrice: c && c.ok ? priceFromCost(c.cost, m) : null,
      marginPct: marginPct(+fg.selling_price, cost),
      lines: c ? c.lines.map((l) => ({ sku: l.sku, name: l.name, department: l.department, unit: l.unit, qtyPerUnit: l.qtyPerUnit, recipeUnit: l.recipeUnit, unitCost: l.unitCost, cost: l.cost })) : [] };
  }

  /* Product edit guard: a finished good with a recipe does not take a typed cost. Returns the cost to save. */
  async function guardProductCost(db, p, body, user) {
    if (p.department !== 'Finished Goods') return { unitCost: p.unitCost, mode: null };
    const cur = (await db.query('SELECT product_id, unit_cost, cost_mode, department FROM products WHERE sku = $1 AND NOT is_archived FOR UPDATE', [p.sku])).rows[0];
    if (!cur) return { unitCost: p.unitCost, mode: null };
    const hasRecipe = (await db.query('SELECT 1 FROM product_materials WHERE finished_product_id = $1 LIMIT 1', [cur.product_id])).rowCount > 0;
    if (!hasRecipe) return { unitCost: p.unitCost, mode: cur.cost_mode };
    const typed = p.unitCost == null ? +cur.unit_cost : p.unitCost, differs = Math.abs(typed - +cur.unit_cost) >= 0.005;
    const reason = str((body || {}).costOverrideReason);
    if ((body || {}).costBackToAuto === true && cur.cost_mode === 'override') {
      await db.query(`UPDATE products SET cost_mode = 'auto', cost_override_reason = NULL, cost_override_by = NULL, cost_override_at = NULL WHERE product_id = $1`, [cur.product_id]);
      await audit(db, user, 'Cost override removed', `${p.name} (${p.sku}) is back to the recipe cost`);
      return { unitCost: +cur.unit_cost, mode: 'auto', recalc: true };
    }
    if (cur.cost_mode === 'override') {
      if (differs) {
        if (reason.length < 5) throw new ValidationError({ unitCost: 'Give a reason for changing the overridden cost (at least 5 characters).', costOverrideReason: 'A reason is required' });
        await db.query('UPDATE products SET cost_override_reason = $2, cost_override_by = $3, cost_override_at = now() WHERE product_id = $1', [cur.product_id, reason, user.id]);
        await audit(db, user, 'Cost override', `${p.name} (${p.sku}) cost ${peso(cur.unit_cost)} → ${peso(typed)} typed by Finance. Reason: ${reason}`);
      }
      return { unitCost: typed, mode: 'override' };
    }
    if (!differs) return { unitCost: +cur.unit_cost, mode: 'auto' };
    if (reason.length < 5) throw new ValidationError({ unitCost: 'This cost is calculated from the recipe (auto). To type a different cost, use Override and give a reason.', costOverrideReason: 'A reason is required' });
    await db.query(`UPDATE products SET cost_mode = 'override', cost_override_reason = $2, cost_override_by = $3, cost_override_at = now() WHERE product_id = $1`, [cur.product_id, reason, user.id]);
    await audit(db, user, 'Cost override', `${p.name} (${p.sku}) cost ${peso(cur.unit_cost)} → ${peso(typed)} typed by Finance instead of the recipe cost. Reason: ${reason}`);
    return { unitCost: typed, mode: 'override' };
  }

  /* ---------- routes ---------- */
  app.get('/api/finance/recipe-cost/:sku', auth('finance'), wrap(async (req, res) => { await ready; res.json(await breakdown(pool, str(req.params.sku).toUpperCase())); }));

  app.post('/api/finance/recipe-cost/:sku/override', auth('finance'), wrap(async (req, res) => {
    await ready;
    const b = req.body || {}, reason = str(b.reason), cost = Number(b.cost), e = {};
    if (reason.length < 5) e.reason = 'Give a reason for overriding the recipe cost (at least 5 characters).';
    if (!Number.isFinite(cost) || cost <= 0 || cost > 1e7) e.cost = 'Enter the cost per piece in pesos (more than 0).';
    if (Object.keys(e).length) throw new ValidationError(e);
    const sku = str(req.params.sku).toUpperCase();
    await tx(async (client) => {
      const fg = (await client.query(`SELECT product_id, name, unit_cost FROM products WHERE sku = $1 AND department = 'Finished Goods' AND NOT is_archived FOR UPDATE`, [sku])).rows[0];
      if (!fg) throw new ValidationError({ sku: 'That finished good does not exist' });
      await client.query(`UPDATE products SET cost_mode = 'override', unit_cost = $2, cost_override_reason = $3, cost_override_by = $4, cost_override_at = now(), cost_note = NULL WHERE product_id = $1`, [fg.product_id, Math.round(cost * 100) / 100, reason, req.user.id]);
      await audit(client, req.user, 'Cost override', `${fg.name} (${sku}) cost ${peso(fg.unit_cost)} → ${peso(cost)} typed by Finance instead of the recipe cost. Reason: ${reason}`);
    });
    res.json(await breakdown(pool, sku));
  }));

  app.post('/api/finance/recipe-cost/:sku/auto', auth('finance'), wrap(async (req, res) => {
    await ready;
    const sku = str(req.params.sku).toUpperCase();
    const out = await tx(async (client) => {
      const fg = (await client.query(`SELECT product_id, name FROM products WHERE sku = $1 AND department = 'Finished Goods' AND NOT is_archived FOR UPDATE`, [sku])).rows[0];
      if (!fg) throw new ValidationError({ sku: 'That finished good does not exist' });
      await client.query(`UPDATE products SET cost_mode = 'auto', cost_override_reason = NULL, cost_override_by = NULL, cost_override_at = NULL WHERE product_id = $1`, [fg.product_id]);
      await audit(client, req.user, 'Cost override removed', `${fg.name} (${sku}) is back to the recipe cost`);
      return recalcOne(client, fg.product_id, { user: req.user, why: 'override removed' });
    });
    res.json(Object.assign(await breakdown(pool, sku), { result: out.status }));
  }));

  app.post('/api/finance/recipe-cost/recalculate', auth('finance'), wrap(async (req, res) => { await ready; res.json(await reconcileAll(req.user, 'Finance asked for a recalculation')); }));

  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'recipe-costs', run: () => reconcileAll(SYSTEM, 'sweep') });
  const sweep = setInterval(() => { reconcileAll(SYSTEM, 'sweep').catch((e) => console.warn('[recipe-costing] sweep:', e.message)); }, 6 * 3600 * 1000);
  if (sweep.unref) sweep.unref();

  return { ready, recalcOne, ripple, reconcileAll, breakdown, guardProductCost, flagQuotes, computeCost, convert, SYSTEM, MATERIAL_DEPTS };
};
module.exports.pure = { convert, convertibleUnits, normUnit, groupOf, unitFactor, lineCost, computeCost, priceFromCost, marginPct, MATERIAL_DEPTS };
