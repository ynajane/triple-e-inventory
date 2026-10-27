/* quote-automation.js — Task 4 (custom / made-to-order price, fully automatic) and Task 5 (quote approval: automatic but correct).

   TASK 4 — a custom item has no saved recipe, so the quote gets a QUICK RECIPE:
     from the item type, material, size, thickness, finish and quantity the system proposes the raw material and the finishing
     supply, with a quantity per piece (first guess: the weight estimate of pricing.js, Finance edits those estimates), and prices
     them with the Task 3 formula:
         cost per piece   = SUM( quantity per piece x the item's CURRENT unit cost )         (materials only, like Task 3)
         suggested price  = cost per piece x (1 + quote markup %)                           (20% by default)
         margin           = (price - cost) / price
     plus a stock check (needed for the whole quantity vs on hand, shortfall per material). The cashier / Finance can change the
     lines (add / remove a material, change a quantity); the lines are saved on the quote (quote_requests.recipe).
     It never shows a wrong number: a material with no cost, an archived one or a unit that cannot be converted gives
     "cannot price yet" with the reason, and stock that cannot cover the quantity says "short by X".

   TASK 5 — the cashier presses "Confirm price" and the route is decided here (routeQuote), never by the cashier:
       fully costed AND within the tolerance band of the system price AND at or above the minimum margin (never below cost)
       AND under the cashier order-value limit AND stock covers the quantity AND no partial-payment terms waiting
           -> 'quoted' straight away
       anything else -> 'pending_approval', with a plain-language reason for every rule that failed.
     Finance edits the band, the minimum margin, the value limit, the cost-move % checked at acceptance and the reminder timings
     (quote_rules, GET/PUT /api/finance/quote-rules). Every decision is written to quote_decisions with the rule, the numbers and
     the user (and to the audit log). Waiting approvals are NEVER approved by a timer: they are reminded, then escalated.

   Routes:
     POST /api/pricing/quote-estimate          live draft for the request forms (customer sees the price only)
     GET  /api/pricing/quote/:no               the draft of a saved request (cashier / Finance)
     GET  /api/pricing/materials               raw materials + finishing supplies the recipe lines can use
     PUT  /api/{pos,finance}/quotes/:no/recipe save the adjusted lines (or { reset: true } = back to the automatic guess)
     POST /api/{pos,finance}/quotes/:no/refresh-price   one click: the same quote at today's costs
     GET  /api/pos/quote-rules · GET/PUT /api/finance/quote-rules
     POST /api/finance/quotes/approve-batch    approve several waiting prices that share the same reason
     GET  /api/finance/quotes/:no/decisions    the decision log of one quote
     GET  /api/finance/purchase-suggestions · POST /api/finance/purchase-suggestions/:id
   Mounted in server.js after pricing.js, job-orders.js, shop-extras.js and recipe-costing.js. */
const RC = require('./recipe-costing').pure;

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const q6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (n, unit) => (+Number(n).toFixed(4)).toLocaleString('en-PH', { maximumFractionDigits: 4 }) + ' ' + unit;
const MATERIAL_DEPTS = ['Raw Materials', 'Finishing Supplies'];
const SYSTEM = { id: null, name: 'System (automatic)', roleLabel: 'System' };
/* Reasons that can never be approved in a batch: selling below cost, with no cost, or without the stock each need a person to look at that one quote.
   (The Finance screen hides the "Approve all" button for these too; keep shop-extras-admin.js NO_BULK in step.) */
const NO_BULK = ['below_cost', 'not_costed', 'stock_short'];
const bulkBlocked = (key) => String(key || '').split('+').filter((r) => NO_BULK.includes(r));

/* ---------------- pure: price a list of recipe lines (unit-tested in test/quote-automation.test.js) ----------------
   rows: { sku, name, department, unit (stock unit), unit_cost, is_archived, on_hand, qty_per_unit, req_unit, why, estimate }
   Quantities are kept to 6 decimals so a light part x a big order is not rounded away; the formula is Task 3's. */
function priceLines(rows, { quantity, markupPct }) {
  const qty = Number(quantity) || 0, problems = [], lines = [];
  let cost = 0;
  (rows || []).forEach((r) => {
    const recipeUnit = r.req_unit || r.unit;
    const line = { sku: r.sku, name: r.name, department: r.department, unit: r.unit, recipeQty: +r.qty_per_unit, recipeUnit,
      unitCost: +r.unit_cost > 0 ? +r.unit_cost : null, onHand: +r.on_hand || 0, why: r.why || undefined, estimate: !!r.estimate || undefined };
    lines.push(line);
    if (r.is_archived) { problems.push({ sku: r.sku, code: 'archived', message: `${r.name} is archived: remove it from the recipe or restore it.` }); return; }
    const f = RC.unitFactor(recipeUnit, r.unit);
    if (f == null) { problems.push({ sku: r.sku, code: 'unit', message: `${r.name}: the recipe is in ${recipeUnit} but the item is stocked in ${r.unit}. Enter the quantity in ${r.unit}.` }); return; }
    line.qtyPerPiece = q6(+r.qty_per_unit * f);
    line.needed = q6(line.qtyPerPiece * qty);
    line.short = line.needed > line.onHand + 1e-9 ? q6(line.needed - line.onHand) : 0;
    if (!(+r.unit_cost > 0)) { problems.push({ sku: r.sku, code: 'no_cost', message: `${r.name} has no cost yet. Record a delivery with its price, or set its unit cost.` }); return; }
    line.costPerPiece = q6(line.qtyPerPiece * +r.unit_cost);
    cost += line.qtyPerPiece * +r.unit_cost;
  });
  const shortfalls = lines.filter((l) => l.short > 0).map((l) => ({ sku: l.sku, name: l.name, unit: l.unit, needed: l.needed, onHand: l.onHand, short: l.short }));
  if (!lines.length) problems.push({ code: 'no_recipe', message: 'There are no materials on the recipe yet. Add the raw material and the finishing supply.' });
  if (problems.length) return { ok: false, status: 'cannot_price', lines, problems, shortfalls, quantity: qty, markupPct,
    costPerPiece: null, costTotal: null, pricePerPiece: null, total: null, marginPct: null };
  const pricePerPiece = r2(cost * (1 + Number(markupPct) / 100));
  return { ok: true, status: shortfalls.length ? 'short' : 'ok', lines, problems, shortfalls, quantity: qty, markupPct,
    costPerPiece: r2(cost), costTotal: r2(cost * qty), pricePerPiece, total: r2(pricePerPiece * qty), marginPct: RC.marginPct(pricePerPiece, cost) };
}

/* ---------------- pure: where a confirmed price goes ----------------
   amount   the cashier's total     draft   the system's priced draft (priceLines / catalog)
   settings { tolerancePct, minMarginPct, valueLimit }     terms  { key, label } when partial-payment terms wait for Finance */
const RULE_LABEL = {
  not_costed: 'Cannot be priced yet', below_cost: 'Below cost', below_margin: 'Below the minimum margin', outside_band: 'Outside the tolerance band',
  over_limit: 'Over the cashier limit', stock_short: 'Not enough stock', partial_terms: 'Partial-payment terms', checks_unavailable: 'Automatic checks unavailable'
};
function routeQuote({ amount, draft, settings, terms }) {
  const S = settings || {}, total = r2(amount), rules = [], reasons = [];
  const numbers = { cashierTotal: total, systemTotal: null, costTotal: null, marginPct: null, deviationPct: null,
    bandPct: +S.tolerancePct, minMarginPct: +S.minMarginPct, limit: +S.valueLimit, shortfalls: [] };
  if (!draft || !draft.ok) {
    rules.push('not_costed');
    reasons.push(draft && draft.missing && draft.missing.length ? `The request does not give the ${draft.missing.join(', ')}, so the system cannot work out the cost`
      : 'Cannot price yet: ' + ((draft && draft.problems) || []).map((p) => p.message).join(' ').replace(/\.$/, '') || 'Cannot price yet');
  } else {
    numbers.systemTotal = draft.total; numbers.costTotal = draft.costTotal;
    numbers.marginPct = total > 0 ? r1((total - draft.costTotal) / total * 100) : null;
    numbers.deviationPct = draft.total > 0 ? r1((total - draft.total) / draft.total * 100) : null;
    if (total < draft.costTotal - 0.004) {
      rules.push('below_cost');
      reasons.push(`${peso(total)} is below the cost of ${peso(draft.costTotal)}: a loss of ${peso(draft.costTotal - total)}`);
    } else if (numbers.marginPct != null && numbers.marginPct < +S.minMarginPct) {
      rules.push('below_margin');
      reasons.push(`The margin is ${numbers.marginPct}%, below the minimum of ${+S.minMarginPct}%`);
    }
    if (numbers.deviationPct != null && Math.abs((total - draft.total) / draft.total * 100) > +S.tolerancePct + 1e-9) {
      rules.push('outside_band');
      reasons.push(`${Math.abs(numbers.deviationPct)}% ${numbers.deviationPct < 0 ? 'below' : 'above'} the system price of ${peso(draft.total)} (allowed: ±${+S.tolerancePct}%)`);
    }
    if ((draft.shortfalls || []).length) {
      numbers.shortfalls = draft.shortfalls.map((s) => ({ sku: s.sku, name: s.name, unit: s.unit, short: s.short }));
      rules.push('stock_short');
      reasons.push('Not enough stock: ' + draft.shortfalls.map((s) => `${s.name} short by ${amt(s.short, s.unit)}`).join('; '));
    }
  }
  if (!(+S.valueLimit > 0)) { rules.push('over_limit'); reasons.push('No cashier order-value limit is set, so Finance approves every price'); }
  else if (total > +S.valueLimit) { rules.push('over_limit'); reasons.push(`${peso(total)} is over the cashier limit of ${peso(S.valueLimit)}`); }
  if (terms) { rules.push('partial_terms'); reasons.push(`Partial-payment terms (${terms.label || terms.key}) are approved by Finance`); }
  const ok = !rules.length;
  return { route: ok ? 'quoted' : 'pending_approval', rules, reasons, numbers, key: rules.slice().sort().join('+'),
    summary: ok ? `Within ±${+S.tolerancePct}% of the system price, margin ${numbers.marginPct}%, under the ${peso(S.valueLimit)} limit, fully costed and in stock` : reasons.join('; ') };
}

/* ---------------- pure: what the automatic price watch does with ONE sent quote the customer has not answered ----------------
   The cost of its materials is checked again every automation run. Nothing is changed unless the cost moved by more than Finance's
   cost-move limit. Then:
     cost went DOWN, the new system price is lower, the drop is no more than maxDropPct of the price the customer holds, and the new
       price would go straight out under the normal rules (route 'quoted')                       -> 'refresh'  (customer gets the lower price, valid again)
     cost went UP                                                                                -> 'notify_up' (a price is never raised behind the customer's back)
     anything else (a big drop, or the new price would need Finance)                             -> 'notify_review' (a person decides)
   A quote with money on it, or one with no recorded cost to compare with, is never touched. */
function priceWatchAction({ quoted, oldCost, newCost, newTotal, route, costMovePct, maxDropPct }) {
  if (!(+oldCost > 0) || !(+newCost > 0) || !(+quoted > 0) || !(+newTotal > 0)) return { action: 'none' };
  const movedPct = r1((newCost - oldCost) / oldCost * 100);
  if (Math.abs(movedPct) <= +costMovePct) return { action: 'none', movedPct };
  if (movedPct > 0) return { action: 'notify_up', movedPct };
  const dropPct = r1((quoted - newTotal) / quoted * 100);
  if (newTotal < quoted - 0.004 && dropPct <= +maxDropPct && route === 'quoted') return { action: 'refresh', movedPct, dropPct };
  return { action: 'notify_review', movedPct, dropPct };
}

module.exports = function mountQuoteAutomation({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const pricing = () => app.locals.pricing;
  const nc = () => app.locals.notifications;
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);
  const pingUser = (id, n, role) => (nc() && id ? nc().notifyUser(id, n, role) : null);
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

  /* ---------------- schema (every start; nothing is dropped) ---------------- */
  const envLimit = Number(process.env.CASHIER_QUOTE_LIMIT_PHP);
  // ASSUMPTION until Finance confirms it on the Approval rules screen: ₱50,000 (or CASHIER_QUOTE_LIMIT_PHP when it is set above 0)
  const INITIAL_LIMIT = Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 50000;
  const ready = (async () => {
    try {
      await require('./schema-retry')(async () => {          // quote_requests is created by shop-extras.js
        for (const c of ['recipe JSONB', 'recipe_by INT REFERENCES users(user_id)', 'recipe_at TIMESTAMPTZ', 'approval_check JSONB', 'accept_check JSONB',
                         'approval_reminded_at TIMESTAMPTZ', 'approval_escalated_at TIMESTAMPTZ'])
          await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ' + c);
      });
      await pool.query(`CREATE TABLE IF NOT EXISTS quote_rules (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        tolerance_pct NUMERIC(6,2) NOT NULL DEFAULT 5 CHECK (tolerance_pct >= 0 AND tolerance_pct <= 50),
        min_margin_pct NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (min_margin_pct >= 0 AND min_margin_pct < 100),
        value_limit_php NUMERIC(14,2) NOT NULL CHECK (value_limit_php > 0),
        cost_move_pct NUMERIC(6,2) NOT NULL DEFAULT 5 CHECK (cost_move_pct > 0 AND cost_move_pct <= 100),
        expiry_reminder_days INT NOT NULL DEFAULT 2 CHECK (expiry_reminder_days BETWEEN 1 AND 14),
        approval_remind_hours INT NOT NULL DEFAULT 24 CHECK (approval_remind_hours BETWEEN 1 AND 720),
        approval_escalate_hours INT NOT NULL DEFAULT 48 CHECK (approval_escalate_hours BETWEEN 2 AND 1440),
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ)`);
      await pool.query('INSERT INTO quote_rules (id, value_limit_php) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [INITIAL_LIMIT]);
      await pool.query(`CREATE TABLE IF NOT EXISTS quote_decisions (
        decision_id BIGSERIAL PRIMARY KEY,
        quote_id    BIGINT REFERENCES quote_requests(quote_id) ON DELETE CASCADE,
        quote_no    TEXT NOT NULL,
        action      TEXT NOT NULL,
        rules       TEXT[] NOT NULL DEFAULT '{}',
        reason      TEXT,
        numbers     JSONB,
        user_id     INT REFERENCES users(user_id),
        user_name   TEXT,
        role_label  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quote_decisions_quote ON quote_decisions (quote_id, created_at DESC)');
      await pool.query(`CREATE TABLE IF NOT EXISTS purchase_suggestions (
        suggestion_id BIGSERIAL PRIMARY KEY,
        product_id  INT NOT NULL REFERENCES products(product_id),
        sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
        quantity    NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
        quote_id    BIGINT REFERENCES quote_requests(quote_id) ON DELETE CASCADE,
        quote_no    TEXT,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ordered','dismissed')),
        note        TEXT,
        decided_by  INT REFERENCES users(user_id),
        decided_at  TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (quote_id, product_id))`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'quote'`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS supplier_id INT REFERENCES suppliers(supplier_id) ON DELETE SET NULL`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS supplier_name TEXT`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(14,2)`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(14,2)`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD COLUMN IF NOT EXISTS lead_time_days INT`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_open_low_stock_suggestion ON purchase_suggestions (product_id) WHERE status = 'open' AND source = 'low_stock'`);
      await pool.query(`ALTER TABLE purchase_suggestions DROP CONSTRAINT IF EXISTS purchase_suggestions_status_check`);
      await pool.query(`ALTER TABLE purchase_suggestions ADD CONSTRAINT purchase_suggestions_status_check CHECK (status IN ('open','ordered','dismissed','received'))`);
      console.log('[quote-automation] draft recipes, approval rules and the decision log are ready');
      return true;
    } catch (err) { console.warn('[quote-automation] setup failed:', err.message); return false; }
  })();
  ['/api/pricing/quote', '/api/pricing/materials', '/api/finance/quote-rules', '/api/pos/quote-rules', '/api/finance/purchase-suggestions'].forEach((p) => app.use(p, (req, res, next) => { ready.then(() => next(), next); }));

  /* ---------------- Finance's approval rules ---------------- */
  async function settings(db) {
    await ready;
    const r = (await (db || pool).query(`SELECT q.*, u.full_name AS updated_by_name FROM quote_rules q LEFT JOIN users u ON u.user_id = q.updated_by WHERE q.id = 1`)).rows[0] || {};
    return { tolerancePct: r.tolerance_pct == null ? 5 : +r.tolerance_pct, minMarginPct: r.min_margin_pct == null ? 0 : +r.min_margin_pct,
      valueLimit: r.value_limit_php == null ? INITIAL_LIMIT : +r.value_limit_php, costMovePct: r.cost_move_pct == null ? 5 : +r.cost_move_pct,
      expiryReminderDays: r.expiry_reminder_days == null ? 2 : +r.expiry_reminder_days,
      approvalRemindHours: r.approval_remind_hours == null ? 24 : +r.approval_remind_hours, approvalEscalateHours: r.approval_escalate_hours == null ? 48 : +r.approval_escalate_hours,
      // until Finance saves this screen once, the value limit is the starting assumption, and the screens say so
      confirmed: !!r.updated_by, updatedBy: r.updated_by_name || null, updatedAt: r.updated_at || null };
  }

  /* ---------------- the decision log ---------------- */
  async function logDecision(db, { quote, action, decision, reason, numbers, rules, user }) {
    const u = user || SYSTEM, why = reason != null ? reason : decision ? decision.summary : '';
    const rl = rules || (decision ? decision.rules : []);
    await db.query(`INSERT INTO quote_decisions (quote_id, quote_no, action, rules, reason, numbers, user_id, user_name, role_label) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [quote.quote_id, quote.quote_no, action, rl, why || null, JSON.stringify(numbers || (decision ? decision.numbers : null) || null), u.id || null, u.name || null, u.roleLabel || null]);
    const n = numbers || (decision ? decision.numbers : null) || {};
    const fig = [n.cashierTotal != null ? 'price ' + peso(n.cashierTotal) : '', n.systemTotal != null ? 'system ' + peso(n.systemTotal) : '',
      n.costTotal != null ? 'cost ' + peso(n.costTotal) : '', n.marginPct != null ? 'margin ' + n.marginPct + '%' : ''].filter(Boolean).join(', ');
    await audit(db, u, 'Quote decision', `${quote.quote_no}: ${action.replace(/_/g, ' ')}` + (rl.length ? ` [rule: ${rl.join(', ')}]` : '') + (why ? ` — ${why}` : '') + (fig ? ` (${fig})` : ''));
  }

  /* ---------------- the stock items a recipe line can use ---------------- */
  const materialRows = async (db) => (await (db || pool).query(
    `SELECT product_id, sku, name, department, grade, unit, unit_cost, on_hand, is_archived FROM products
      WHERE department = ANY($1) AND NOT is_archived ORDER BY department, name`, [MATERIAL_DEPTS])).rows;
  // "Aluminum ADC12" -> the raw material whose grade (or name) is ADC12; the one with the most stock first
  const gradeOf = (material) => String(material || '').trim().split(/\s+/).pop().toUpperCase();
  function pickMaterial(rows, material) {
    const g = gradeOf(material); if (!g || g.length < 3) return null;
    const raw = rows.filter((r) => r.department === 'Raw Materials');
    const hit = raw.filter((r) => String(r.grade || '').toUpperCase() === g);
    const byName = raw.filter((r) => String(r.name).toUpperCase().includes(g));
    return (hit.length ? hit : byName).sort((a, b) => (RC.unitFactor('kg', b.unit) ? 1 : 0) - (RC.unitFactor('kg', a.unit) ? 1 : 0) || +b.on_hand - +a.on_hand)[0] || null;
  }
  // the finishing supply a finish uses up (the finish words in the supply's name)
  const FINISH_WORDS = { 'Powder Coated': ['powder'], 'Painted': ['paint'], 'Nickel Plated': ['nickel'], 'Chrome Plated': ['chrom'],
    'Chromate Conversion': ['chromate'], 'Polished': ['polishing'], 'Satin / Brushed': ['polishing', 'abrasive'], 'Shot Blasted': ['blast', 'shot'] };
  function pickFinish(rows, finish) {
    const words = FINISH_WORDS[finish] || []; if (!words.length) return null;
    return rows.filter((r) => r.department === 'Finishing Supplies' && words.some((w) => String(r.name).toLowerCase().includes(w)))
      .sort((a, b) => words.findIndex((w) => String(a.name).toLowerCase().includes(w)) - words.findIndex((w) => String(b.name).toLowerCase().includes(w)) || +b.on_hand - +a.on_hand)[0] || null;
  }
  async function materialItems(db) {
    const rows = await materialRows(db), out = {};
    ['Aluminum ADC12', 'Aluminum A380', 'Brass C37700', 'Brass C36000'].forEach((m) => { const p = pickMaterial(rows, m); out[m] = p ? { sku: p.sku, name: p.name, unit: p.unit, unitCost: +p.unit_cost } : null; });
    return out;
  }

  /* What a custom quote can really be made from, read from the stock records (Raw Materials + Finishing Supplies).
     The quote forms use this so they only offer a material / finish the shop has an item for, and the server repeats the check.
     A material is offered when an active Raw Material with that grade exists; a finish when it uses no supply (raw, shot blasted)
     or an active Finishing Supply for it exists. status 'out' = the item exists but none is on hand (we order it first). */
  async function inventoryFit(db, materialNames, finishNames) {
    const rows = await materialRows(db), R = pricing() ? await pricing().rules(db) : null;
    const use = (R && R.rates && R.rates.finishUsePerKg) || {};
    const stateOf = (p) => (+p.on_hand > 0 ? 'in' : 'out');
    const materials = {}, finishes = {};
    (materialNames || []).forEach((m) => { const p = pickMaterial(rows, m); materials[m] = p ? { sku: p.sku, name: p.name, unit: p.unit, onHand: +p.on_hand, status: stateOf(p) } : null; });
    (finishNames || []).forEach((f) => {
      if (!(+use[f] > 0)) { finishes[f] = { free: true, status: 'in' }; return; }
      const p = pickFinish(rows, f);
      finishes[f] = p ? { sku: p.sku, name: p.name, unit: p.unit, onHand: +p.on_hand, status: stateOf(p) } : null;
    });
    return { materials, finishes };
  }

  /* ---------------- the draft ---------------- */
  const ITEM_MATERIALS = { 'Die-cast part': ['Aluminum ADC12', 'Aluminum A380'], 'Forged part': ['Brass C37700', 'Brass C36000'], 'Fitting / valve': ['Brass C37700', 'Brass C36000'] };
  // the first guess: one raw-material line from the weight estimate, one finishing-supply line from the finish
  function autoLines(R, mats, itemType, specs) {
    const P = pricing(), rates = R.rates, notes = [], problems = [], lines = [];
    let material = str(specs.material);
    if (!(ITEM_MATERIALS[itemType] || []).includes(material)) { material = P.FAMILY_DEFAULT[P.ITEM_FAMILY[itemType]]; notes.push('Material not chosen yet: priced as ' + material + '.'); }
    const w = P.weightOf(rates, itemType, str(specs.size), str(specs.thickness));
    if (!w) return { missing: ['a size the calculator can read'] };
    const m = pickMaterial(mats, material);
    const kg = w.kg * (1 + rates.scrapPct / 100);
    if (!m) problems.push({ code: 'no_item', message: `No raw material for ${material} is in the stock records. Add it under Products (Raw Materials), or pick the material on the recipe lines.` });
    else lines.push({ sku: m.sku, qtyPerPiece: q6(kg), unit: 'kg', why: `estimate: ${+w.kg.toFixed(3)} kg per piece (${w.basis}) + ${rates.scrapPct}% scrap`, estimate: true });
    const finish = str(specs.finish), use = +(rates.finishUsePerKg || {})[finish] || 0;
    if (use > 0) {
      const s = pickFinish(mats, finish);
      if (!s) problems.push({ code: 'no_item', message: `No finishing supply for "${finish}" is in the stock records. Add the supply on the recipe lines, or set its use to 0 under Pricing rules.` });
      else lines.push({ sku: s.sku, qtyPerPiece: q6(w.kg * use), unit: s.unit, why: `estimate: ${use} ${s.unit} per kg of the piece for ${finish}`, estimate: true });
    }
    return { lines, notes, problems, material, weightKg: +w.kg.toFixed(3), weightBasis: w.basis };
  }
  const qtyOf = (q) => (pricing() ? pricing().qtyOf(q) : 0);

  /* input: { itemType, specs, quantity, productSku, lines } — lines (adjusted by staff) replace the automatic guess */
  async function draft(db, input) {
    const P = pricing(); if (!P) throw new Error('pricing module not mounted');
    const R = await P.rules(db), specs = input.specs || {};
    const quantity = Number(input.quantity) > 0 ? Number(input.quantity) : qtyOf(input.quantity);
    const sku = str(input.productSku).toUpperCase();
    if (sku) {                                           // a catalog finished good: sold from stock at its own (automatic) price
      const p = (await db.query(`SELECT sku, name, unit, unit_cost, selling_price, on_hand, department, cost_note, is_archived FROM products WHERE upper(sku) = $1`, [sku])).rows[0];
      if (!p || p.department !== 'Finished Goods' || p.is_archived) return { ok: false, status: 'incomplete', missing: ['a product that is still sold'] };
      if (!(quantity > 0)) return { ok: false, status: 'incomplete', missing: ['quantity'] };
      const line = { sku: p.sku, name: p.name, department: p.department, unit: p.unit, qtyPerPiece: 1, needed: quantity, onHand: +p.on_hand,
        short: quantity > +p.on_hand ? q6(quantity - +p.on_hand) : 0, unitCost: +p.unit_cost > 0 ? +p.unit_cost : null, costPerPiece: +p.unit_cost };
      const problems = [];
      if (!(+p.unit_cost > 0)) problems.push({ sku: p.sku, code: 'no_cost', message: `${p.name} has no cost yet, so its price cannot be checked.` });
      if (p.cost_note) problems.push({ sku: p.sku, code: 'blocked', message: p.cost_note });
      if (!(+p.selling_price > 0)) problems.push({ sku: p.sku, code: 'no_price', message: `${p.name} has no selling price yet.` });
      const shortfalls = line.short > 0 ? [{ sku: p.sku, name: p.name, unit: p.unit, needed: quantity, onHand: +p.on_hand, short: line.short }] : [];
      const base = { catalog: true, product: p.name, quantity, unit: p.unit, lines: [line], shortfalls, problems, markupPct: R.fgMarkupPct, notes: [], estimates: [] };
      if (problems.length) return Object.assign(base, { ok: false, status: 'cannot_price', costPerPiece: null, costTotal: null, pricePerPiece: null, total: null, marginPct: null });
      const per = r2(+p.selling_price);
      return Object.assign(base, { ok: true, status: shortfalls.length ? 'short' : 'ok', costPerPiece: r2(+p.unit_cost), costTotal: r2(+p.unit_cost * quantity),
        pricePerPiece: per, total: r2(per * quantity), marginPct: RC.marginPct(per, +p.unit_cost) });
    }
    const itemType = str(input.itemType || specs.itemType), missing = [];
    if (!ITEM_MATERIALS[itemType]) missing.push('item type');
    if (!str(specs.size)) missing.push('size');
    if (!(quantity > 0)) missing.push('quantity');
    if (missing.length) return { ok: false, status: 'incomplete', missing };
    const mats = await materialRows(db), bySku = new Map(mats.map((m) => [m.sku.toUpperCase(), m]));
    const guess = autoLines(R, mats, itemType, specs);
    if (guess.missing) return { ok: false, status: 'incomplete', missing: guess.missing };
    const edited = Array.isArray(input.lines);
    const chosen = edited ? input.lines : guess.lines;
    const rows = [], problems = edited ? [] : guess.problems.slice();
    for (const l of chosen) {
      const m = bySku.get(str(l.sku).toUpperCase());
      if (!m) { problems.push({ sku: l.sku, code: 'no_item', message: `${l.sku} is not an active raw material or finishing supply.` }); continue; }
      rows.push({ sku: m.sku, name: m.name, department: m.department, unit: m.unit, unit_cost: m.unit_cost, is_archived: m.is_archived, on_hand: m.on_hand,
        qty_per_unit: +l.qtyPerPiece, req_unit: l.unit || m.unit, why: l.why || (edited ? 'set on this quote' : undefined), estimate: !edited && l.estimate });
    }
    const priced = priceLines(rows, { quantity, markupPct: R.quoteMarkupPct });
    const all = problems.concat(priced.problems.filter((p) => p.code !== 'no_recipe' || !problems.length));
    const out = Object.assign(priced, { catalog: false, itemType, material: guess.material, weightKg: guess.weightKg, weightBasis: guess.weightBasis,
      auto: !edited, notes: guess.notes, problems: all,
      // what the first guess rests on, so every screen can label it an estimate
      estimates: [{ key: 'weight', label: 'Weight per piece', value: guess.weightKg + ' kg (' + guess.weightBasis + ')' }, { key: 'scrapPct', label: 'Scrap allowance', value: R.rates.scrapPct + '%' }] });
    if (all.length && out.ok) Object.assign(out, { ok: false, status: 'cannot_price', costPerPiece: null, costTotal: null, pricePerPiece: null, total: null, marginPct: null });
    return out;
  }
  const draftForQuote = (db, q) => draft(db, { specs: q.specs || {}, itemType: (q.specs || {}).itemType, quantity: q.quantity, productSku: q.product_sku,
    lines: Array.isArray(q.recipe) ? q.recipe : undefined });
  // what a customer may see: the price and whether we can make it from stock — never costs, margins or stock counts
  const forCustomer = (d) => ({ ok: d.ok, status: d.status, catalog: d.catalog, quantity: d.quantity, pricePerPiece: d.pricePerPiece, total: d.total,
    missing: d.missing, notes: d.notes || [], estimate: !d.catalog,
    cannotPrice: d.status === 'cannot_price' ? 'Our staff will work out this price: a material price is not on file yet.' : undefined,
    stockNote: (d.shortfalls || []).length ? 'Some material has to be ordered first, so this may take longer than usual.' : undefined });

  /* ---------------- reading / saving the recipe lines ---------------- */
  async function readLines(db, list) {
    if (!Array.isArray(list)) throw bad('recipe', 'Send the recipe lines as a list');
    if (list.length > 30) throw bad('recipe', 'At most 30 materials on one quote');
    const mats = await materialRows(db), bySku = new Map(mats.map((m) => [m.sku.toUpperCase(), m])), seen = new Set(), out = [], e = {};
    list.forEach((l, i) => {
      const sku = str((l || {}).sku).toUpperCase(), raw = String((l || {}).qtyPerPiece == null ? '' : l.qtyPerPiece).replace(/,/g, '').trim();
      const m = bySku.get(sku);
      if (!m) { e['line:' + i] = 'Choose a raw material or finishing supply'; return; }
      if (seen.has(sku)) { e['line:' + i] = `${m.name} is listed twice. Put the whole quantity on one line`; return; }
      seen.add(sku);
      if (!/^\d{1,7}(\.\d{1,6})?$/.test(raw) || !(Number(raw) > 0)) { e['line:' + i] = `Enter how much ${m.name} one piece uses (more than 0, up to 6 decimals)`; return; }
      const unit = str((l || {}).unit) || m.unit;
      if (RC.unitFactor(unit, m.unit) == null) { e['line:' + i] = `${m.name} is stocked in ${m.unit}: enter the quantity in ${RC.convertibleUnits(m.unit).join(' / ')}`; return; }
      out.push({ sku: m.sku, qtyPerPiece: Number(raw), unit: RC.normUnit(unit) === RC.normUnit(m.unit) ? m.unit : unit });
    });
    if (Object.keys(e).length) { e.recipe = 'Fix the highlighted recipe lines: ' + Object.values(e)[0]; throw new ValidationError(e); }
    return out;
  }
  const EDITABLE = ['new', 'pending_approval', 'awaiting_details'];
  // saves the lines on a locked quote row (inside the caller's transaction); null = back to the automatic guess
  async function saveRecipe(client, q, list, user) {
    if (!EDITABLE.includes(q.status)) throw bad('status', 'The recipe can only be changed before the price is sent to the customer');
    const lines = list === null ? null : await readLines(client, list);
    if (JSON.stringify(lines) === JSON.stringify(Array.isArray(q.recipe) ? q.recipe : null)) return q;
    const row = (await client.query('UPDATE quote_requests SET recipe = $2::jsonb, recipe_by = $3, recipe_at = now(), updated_at = now() WHERE quote_id = $1 RETURNING *',
      [q.quote_id, lines == null ? null : JSON.stringify(lines), user.id])).rows[0];
    await logDecision(client, { quote: q, action: lines == null ? 'recipe_reset' : 'recipe_edited', rules: [],
      reason: lines == null ? 'Back to the automatic draft recipe' : lines.map((l) => `${l.sku} ${l.qtyPerPiece} ${l.unit}/pc`).join(', '), user });
    return row || Object.assign({}, q, { recipe: lines });
  }

  /* ---------------- on acceptance: re-check, job order draft, purchase suggestions ----------------
     Runs inside the acceptance transaction behind a savepoint: if anything here fails, the customer's acceptance still stands. */
  async function onAccept(client, q, user) {
    await client.query('SAVEPOINT quote_accept_check');
    try {
      const S = await settings(client), d = await draftForQuote(client, q), flags = [], reasons = [];
      const old = q.suggested_cost == null ? null : +q.suggested_cost;
      let movedPct = null;
      if (!d.ok) { flags.push('not_costed'); reasons.push('The cost cannot be worked out at today’s prices: ' + (d.problems || []).map((p) => p.message).join(' ')); }
      else if (old > 0) {
        movedPct = r1((d.costTotal - old) / old * 100);
        if (Math.abs(movedPct) > S.costMovePct) { flags.push('cost_moved'); reasons.push(`Material cost moved ${movedPct > 0 ? 'up' : 'down'} ${Math.abs(movedPct)}% since the price was set (${peso(old)} → ${peso(d.costTotal)}; the limit is ${S.costMovePct}%)`); }
      }
      const shortfalls = d.shortfalls || [];
      if (shortfalls.length) { flags.push('stock_short'); reasons.push('Not enough stock: ' + shortfalls.map((s) => `${s.name} short by ${amt(s.short, s.unit)}`).join('; ')); }
      // only materials go on a purchase suggestion (a catalog shortfall is made with a production run, from its own recipe)
      const suggested = [];
      for (const s of shortfalls) {
        const p = (await client.query(`SELECT product_id, department FROM products WHERE sku = $1`, [s.sku])).rows[0];
        if (!p || !MATERIAL_DEPTS.includes(p.department)) continue;
        await client.query(`INSERT INTO purchase_suggestions (product_id, sku, name, unit, quantity, quote_id, quote_no) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (quote_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, status = 'open', created_at = now()`,
          [p.product_id, s.sku, s.name, s.unit, Math.max(0.0001, Math.round(s.short * 1e4) / 1e4), q.quote_id, q.quote_no]);
        suggested.push(s);
      }
      let job = null;
      if (!q.product_sku && app.locals.jobOrders && app.locals.jobOrders.createDraft)
        job = await app.locals.jobOrders.createDraft(client, q, (d.lines || []).filter((l) => l.needed > 0));
      const check = { at: Date.now(), flags, reasons, costBefore: old, costNow: d.ok ? d.costTotal : null, movedPct, limitPct: S.costMovePct, shortfalls, job: job && job.ref };
      await client.query(`UPDATE quote_requests SET accept_check = $2::jsonb,
          cost_stale_at = CASE WHEN $3 THEN now() ELSE cost_stale_at END, cost_stale_note = CASE WHEN $3 THEN $4 ELSE cost_stale_note END WHERE quote_id = $1`,
        [q.quote_id, JSON.stringify(check), flags.includes('cost_moved'), reasons.find((r) => /^Material cost moved/.test(r)) || null]);
      await logDecision(client, { quote: q, action: 'acceptance_check', rules: flags, user,
        reason: flags.length ? reasons.join('; ') : 'Cost and stock checked again at acceptance: no change beyond the limit, stock covers it',
        numbers: { cashierTotal: q.quoted_amount == null ? null : +q.quoted_amount, costTotal: check.costNow, costBefore: old, movedPct, shortfalls } });
      await client.query('RELEASE SAVEPOINT quote_accept_check');
      return Object.assign(check, { suggested });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT quote_accept_check');
      console.warn('[quote-automation] acceptance check failed for ' + q.quote_no + ':', err.message);
      return { flags: ['check_failed'], reasons: ['The automatic check at acceptance did not run: ' + err.message], shortfalls: [], suggested: [] };
    }
  }
  // after the acceptance is committed: tell Finance what needs a look
  function afterAccept(q, check) {
    if (!check) return;
    if (check.flags.some((f) => f !== 'stock_short'))
      Promise.resolve(pingFinance({ category: 'orders', severity: 'warn', title: 'Accepted quote needs a look', body: `${q.quote_no} (${q.contact_name}): ${check.reasons.join(' ')}`,
        link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qaccept:' + q.quote_no })).catch(() => {});
    if ((check.suggested || []).length)
      Promise.resolve(pingFinance({ category: 'stock', severity: 'warn', title: 'Purchase suggestion from an accepted quote',
        body: `${q.quote_no} needs more stock: ` + check.suggested.map((s) => `${s.name} ${amt(s.short, s.unit)}`).join(', ') + '.',
        link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qbuy:' + q.quote_no })).catch(() => {});
  }

  /* ---------------- routes: drafts ---------------- */
  app.post('/api/pricing/quote-estimate', auth('finance', 'cashier', 'customer'), wrap(async (req, res) => {
    const b = req.body || {}, staff = req.user.role !== 'customer';
    const lines = staff && Array.isArray(b.lines) ? await readLines(pool, b.lines) : undefined;
    const d = await draft(pool, { itemType: b.itemType, specs: b.specs || {}, quantity: b.quantity, productSku: b.productSku, lines });
    res.json(staff ? d : forCustomer(d));
  }));
  app.get('/api/pricing/quote/:no', auth('finance', 'cashier'), wrap(async (req, res) => {
    const q = (await pool.query('SELECT q.*, u.full_name AS recipe_by_name FROM quote_requests q LEFT JOIN users u ON u.user_id = q.recipe_by WHERE q.quote_no = $1', [str(req.params.no)])).rows[0];
    if (!q) throw bad('id', 'Quotation not found');
    const d = await draftForQuote(pool, q);
    res.json(Object.assign(d, { editedBy: q.recipe_by_name || undefined, editedAt: q.recipe_at || undefined, approvalRules: await settings() }));
  }));
  app.get('/api/pricing/materials', auth('finance', 'cashier'), wrap(async (req, res) => {
    res.json((await materialRows(pool)).map((m) => ({ sku: m.sku, name: m.name, department: m.department, unit: m.unit, units: RC.convertibleUnits(m.unit),
      unitCost: +m.unit_cost > 0 ? +m.unit_cost : null, onHand: +m.on_hand })));
  }));
  for (const [base, role] of [['/api/pos', 'cashier'], ['/api/finance', 'finance']]) {
    app.put(base + '/quotes/:no/recipe', auth(role), wrap(async (req, res) => {
      const b = req.body || {};
      const q = await tx(async (client) => {
        const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [str(req.params.no)])).rows[0];
        if (!cur) throw bad('id', 'Quotation not found');
        if (cur.product_sku) throw bad('recipe', 'A catalog product is priced from its own saved recipe (Products), not on the quote');
        return saveRecipe(client, cur, b.reset === true ? null : b.lines, req.user);
      });
      res.json(await draftForQuote(pool, q));
    }));
    app.post(base + '/quotes/:no/refresh-price', auth(role), wrap(async (req, res) => {
      const out = await refreshPrice(str(req.params.no), req.user);
      res.json(out);
    }));
  }

  /* ---------------- one click: the same quote at today's costs ----------------
     The system price is worked out again; it goes through exactly the same routing as a cashier's price. */
  async function refreshPrice(no, user) {
    const flow = app.locals.quoteFlow;
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [no])).rows[0];
      if (!cur) throw bad('id', 'Quotation not found');
      if (cur.status !== 'quoted') throw bad('status', 'Only a quote that was sent and not answered yet can be refreshed');
      if (+cur.paid_amount > 0) throw bad('payment', 'A payment was already recorded on this quote');
      const d = await draftForQuote(client, cur);
      if (!d.ok) throw bad('amount', d.status === 'incomplete' ? 'The request does not give the ' + d.missing.join(', ') : 'Cannot price yet: ' + d.problems.map((p) => p.message).join(' '));
      const S = await settings(client);
      const pendingTerms = cur.terms_key && cur.terms_key !== 'full' && cur.terms_state === 'proposed' ? { key: cur.terms_key, label: cur.terms_key } : null;
      const decision = routeQuote({ amount: d.total, draft: d, settings: S, terms: pendingTerms });
      const days = +cur.proposed_valid_days || 7, quoted = decision.route === 'quoted';
      const r = (await client.query(`UPDATE quote_requests SET status = $2, proposed_amount = $3, proposed_lead_time = COALESCE(lead_time, proposed_lead_time), proposed_valid_days = $4,
          quoted_amount = CASE WHEN $2 = 'quoted' THEN $3 ELSE quoted_amount END, valid_until = CASE WHEN $2 = 'quoted' THEN $5::date ELSE valid_until END,
          suggested_amount = $6, suggested_cost = $7, approval_check = $8::jsonb, approval_reason = $9, cost_stale_at = NULL, cost_stale_note = NULL,
          expiry_reminded_at = NULL, approval_reminded_at = NULL, approval_escalated_at = NULL, proposed_by = $10, proposed_at = now(), handled_by = $10, updated_at = now()
        WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, decision.route, d.total, days, addDays(todayPH(), days), d.total, d.costTotal, JSON.stringify(decision), quoted ? null : decision.reasons.join('; '), user.id])).rows[0];
      await logDecision(client, { quote: cur, action: quoted ? 'refreshed_quoted' : 'refreshed_to_finance', decision, user,
        reason: `Price refreshed at today's costs: ${peso(cur.quoted_amount)} → ${peso(d.total)}. ` + decision.summary });
      return { row: r, decision, before: +cur.quoted_amount };
    });
    if (out.row.status === 'quoted') { if (flow && flow.afterQuoted) flow.afterQuoted(out.row, { refreshed: true }); }
    else if (flow && flow.afterSentToFinance) flow.afterSentToFinance(out.row, user);
    return { ok: true, status: out.row.status, amount: +(out.row.quoted_amount != null && out.row.status === 'quoted' ? out.row.quoted_amount : out.row.proposed_amount),
      before: out.before, decision: out.decision };
  }

  /* ---------------- Finance: approval rules ---------------- */
  app.get('/api/pos/quote-rules', auth('cashier'), wrap(async (req, res) => res.json(await settings())));
  app.get('/api/finance/quote-rules', auth('finance'), wrap(async (req, res) => res.json(Object.assign(await settings(), { initialLimit: INITIAL_LIMIT }))));
  app.put('/api/finance/quote-rules', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, e = {};
    const n = (key, label, min, max, { whole, above } = {}) => {
      const raw = String(b[key] == null ? '' : b[key]).replace(/[,₱\s%]/g, ''), v = Number(raw);
      if (!raw || !Number.isFinite(v)) { e[key] = label + ' must be a number'; return null; }
      if (whole && !Number.isInteger(v)) { e[key] = label + ' must be a whole number'; return null; }
      if (above ? v <= min : v < min) { e[key] = `${label} must be ${above ? 'more than' : 'at least'} ${min}`; return null; }
      if (v > max) { e[key] = `${label} must be at most ${max}`; return null; }
      return Math.round(v * 100) / 100;
    };
    const v = { tolerancePct: n('tolerancePct', 'The tolerance band', 0, 50), minMarginPct: n('minMarginPct', 'The minimum margin', 0, 99.99),
      valueLimit: n('valueLimit', 'The cashier order-value limit', 0, 1e9, { above: true }), costMovePct: n('costMovePct', 'The cost-move limit', 0, 100, { above: true }),
      expiryReminderDays: n('expiryReminderDays', 'The expiry reminder', 1, 14, { whole: true }),
      approvalRemindHours: n('approvalRemindHours', 'The approval reminder', 1, 720, { whole: true }), approvalEscalateHours: n('approvalEscalateHours', 'The escalation', 2, 1440, { whole: true }) };
    if (v.approvalRemindHours != null && v.approvalEscalateHours != null && v.approvalEscalateHours <= v.approvalRemindHours) e.approvalEscalateHours = 'Escalate later than the first reminder';
    if (Object.keys(e).length) throw new ValidationError(e);
    await tx(async (client) => {
      const before = await settings(client);
      await client.query(`UPDATE quote_rules SET tolerance_pct = $1, min_margin_pct = $2, value_limit_php = $3, cost_move_pct = $4, expiry_reminder_days = $5,
          approval_remind_hours = $6, approval_escalate_hours = $7, updated_by = $8, updated_at = now() WHERE id = 1`,
        [v.tolerancePct, v.minMarginPct, v.valueLimit, v.costMovePct, v.expiryReminderDays, v.approvalRemindHours, v.approvalEscalateHours, req.user.id]);
      const ch = Object.keys(v).filter((k) => before[k] !== v[k]).map((k) => `${k} ${before[k]} → ${v[k]}`);
      await audit(client, req.user, 'Record edited', 'Quote approval rules: ' + (ch.length ? ch.join(', ') : 'confirmed without changes'));
    });
    res.json(Object.assign(await settings(), { initialLimit: INITIAL_LIMIT }));
  }));

  /* ---------------- Finance: batch approve the same reason ----------------
     Every quote must still be waiting AND carry exactly the same set of reasons as the one Finance picked, so a quote with a
     second, different problem is never approved in bulk. Each is approved in its own transaction and logged. */
  app.post('/api/finance/quotes/approve-batch', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, key = str(b.reasonKey), nos = Array.isArray(b.quotes) ? [...new Set(b.quotes.map((x) => str(x)).filter(Boolean))] : [];
    if (!key) throw bad('reasonKey', 'Choose which reason you are approving');
    if (!nos.length || nos.length > 50) throw bad('quotes', 'Pick 1 to 50 quotes');
    const blocked = bulkBlocked(key);
    if (blocked.length) throw bad('reasonKey', 'Cannot be approved in bulk (' + blocked.map((r) => RULE_LABEL[r] || r).join(', ') + '): open each quote and decide on it');
    const flow = app.locals.quoteFlow; if (!flow) throw bad('quotes', 'Approvals are not available right now');
    const done = [], skipped = [];
    for (const no of nos) {
      try {
        const row = await tx(async (client) => {
          const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [no])).rows[0];
          if (!cur || cur.status !== 'pending_approval') throw bad('status', 'no longer waiting for approval');
          const ck = cur.approval_check || {};
          if ((ck.rules || []).slice().sort().join('+') !== key) throw bad('reasonKey', 'its reason is different: ' + (cur.approval_reason || 'not given'));
          return flow.approvePrice(client, cur, req.user, { batch: key });
        });
        done.push(row.quote_no); flow.afterApproved(row);
      } catch (err) { skipped.push({ quote: no, why: err instanceof ValidationError ? Object.values(err.fields || {})[0] || err.message : err.message }); }
    }
    res.json({ ok: true, approved: done, skipped });
  }));

  app.get('/api/finance/quotes/:no/decisions', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(`SELECT d.* FROM quote_decisions d WHERE d.quote_no = $1 ORDER BY d.created_at DESC, d.decision_id DESC LIMIT 100`, [str(req.params.no)]);
    res.json(rows.map((d) => ({ action: d.action, rules: d.rules || [], reason: d.reason || undefined, numbers: d.numbers || undefined,
      by: d.user_name || 'System', role: d.role_label || undefined, at: d.created_at ? new Date(d.created_at).getTime() : undefined })));
  }));

  /* ---------------- Finance: purchase suggestions from accepted quotes & low stock ---------------- */
  app.get('/api/finance/purchase-suggestions', auth('finance'), wrap(async (req, res) => {
    const st = ['open', 'ordered', 'received', 'dismissed', 'all'].includes(str(req.query.status)) ? str(req.query.status) : 'open';
    const { rows } = await pool.query(`SELECT s.*, p.on_hand, COALESCE(s.unit_cost, p.unit_cost) AS effective_unit_cost, u.full_name AS decided_by_name FROM purchase_suggestions s
        JOIN products p ON p.product_id = s.product_id LEFT JOIN users u ON u.user_id = s.decided_by
       WHERE ($1 = 'all' OR s.status = $1) ORDER BY s.status = 'open' DESC, s.status = 'ordered' DESC, s.created_at DESC LIMIT 200`, [st]);
    const now = Date.now();
    res.json(rows.map((s) => {
      const lead = s.lead_time_days != null ? +s.lead_time_days : 7;
      const orderTime = s.decided_at ? new Date(s.decided_at).getTime() : (s.created_at ? new Date(s.created_at).getTime() : now);
      const expectedTime = s.status === 'ordered' ? orderTime + lead * 86400000 : null;
      const isOverdue = expectedTime != null && now > expectedTime;
      const daysOverdue = isOverdue ? Math.floor((now - expectedTime) / 86400000) : 0;
      return {
        id: +s.suggestion_id,
        sku: s.sku,
        name: s.name,
        unit: s.unit,
        quantity: +s.quantity,
        onHand: +s.on_hand,
        unitCost: +s.effective_unit_cost || null,
        estimatedCost: s.estimated_cost != null ? +s.estimated_cost : (s.effective_unit_cost ? Math.round(+s.quantity * +s.effective_unit_cost * 100) / 100 : null),
        supplierId: s.supplier_id ? +s.supplier_id : null,
        supplierName: s.supplier_name || null,
        leadTimeDays: lead,
        expectedArrival: expectedTime,
        isOverdue,
        daysOverdue,
        source: s.source || (s.quote_no ? 'quote' : 'low_stock'),
        quote: s.quote_no,
        status: s.status,
        note: s.note || undefined,
        decidedBy: s.decided_by_name || undefined,
        decidedAt: s.decided_at ? new Date(s.decided_at).getTime() : undefined,
        createdAt: s.created_at ? new Date(s.created_at).getTime() : undefined
      };
    }));
  }));
  app.post('/api/finance/purchase-suggestions/:id', auth('finance'), wrap(async (req, res) => {
    const id = Number(req.params.id), st = str((req.body || {}).status), note = str((req.body || {}).note);
    if (!Number.isInteger(id)) throw bad('id', 'Purchase suggestion not found');
    if (!['ordered', 'dismissed', 'open', 'received'].includes(st)) throw bad('status', 'Mark it ordered, received, dismissed or open');
    if (note.length > 200) throw bad('note', 'Keep the note within 200 characters');
    const r = await tx(async (client) => {
      const suggestion = (await client.query('SELECT * FROM purchase_suggestions WHERE suggestion_id=$1', [id])).rows[0];
      if (!suggestion) throw bad('id', 'Purchase suggestion not found');
      if (suggestion.quote_id && ['ordered','received'].includes(st)) {
        const q = (await client.query('SELECT * FROM quote_requests WHERE quote_id=$1 FOR UPDATE', [suggestion.quote_id])).rows[0];
        const pt = app.locals.paymentTerms;
        if (!q || !pt) throw bad('payment', 'Quote payment checks are unavailable. Material purchasing is blocked.');
        await pt.assertProduction(client, q);
      }
      const s = (await client.query(`UPDATE purchase_suggestions SET status = $2, note = COALESCE(NULLIF($3, ''), note), decided_by = $4, decided_at = now() WHERE suggestion_id = $1 RETURNING *`,
        [id, st, note, req.user.id])).rows[0];
      if (!s) throw bad('id', 'Purchase suggestion not found');
      await audit(client, req.user, 'Record edited', `Purchase suggestion for ${s.name} (${amt(s.quantity, s.unit)}, quote ${s.quote_no}) marked ${st}${note ? ': ' + note : ''}`);
      return s;
    });
    res.json({ ok: true, id: +r.suggestion_id, status: r.status });
  }));

  /* ---------------- automation: remind, then escalate. NEVER approve on a timer ---------------- */
  async function approvalReminders() {
    const S = await settings();
    const pick = (col, hours) => pool.query(`
      UPDATE quote_requests q SET ${col} = now()${col === 'approval_escalated_at' ? ', approval_reminded_at = COALESCE(q.approval_reminded_at, now())' : ''}
        FROM (SELECT q2.quote_id FROM quote_requests q2
               WHERE q2.status = 'pending_approval' AND q2.${col} IS NULL AND COALESCE(q2.proposed_at, q2.updated_at) < now() - make_interval(hours => $1::int)
               ORDER BY q2.quote_id LIMIT 100 FOR UPDATE SKIP LOCKED) p
       WHERE q.quote_id = p.quote_id
      RETURNING q.quote_id, q.quote_no, q.contact_name, q.proposed_amount, q.approval_reason, q.proposed_by, q.approval_check`, [hours]);
    const late = (await pick('approval_escalated_at', S.approvalEscalateHours)).rows;
    const due = (await pick('approval_reminded_at', S.approvalRemindHours)).rows.filter((r) => !late.some((x) => x.quote_id === r.quote_id));
    for (const q of due) {
      await pingFinance({ category: 'orders', severity: 'warn', title: 'Quote price still waiting for your approval',
        body: `${q.quote_no} (${q.contact_name}, ${peso(q.proposed_amount)}) has waited over ${S.approvalRemindHours} h. Reason: ${q.approval_reason || 'not given'}.`,
        link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qremind:' + q.quote_no });
      await logDecision(pool, { quote: q, action: 'reminder', rules: (q.approval_check || {}).rules || [], reason: `Still waiting after ${S.approvalRemindHours} h: Finance reminded (not approved)` });
    }
    for (const q of late) {
      await pingFinance({ category: 'orders', severity: 'error', title: 'Escalated: a quote price is overdue for approval',
        body: `${q.quote_no} (${q.contact_name}, ${peso(q.proposed_amount)}) has waited over ${S.approvalEscalateHours} h. It is never approved automatically. Reason: ${q.approval_reason || 'not given'}.`,
        link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qescalate:' + q.quote_no });
      await pingUser(q.proposed_by, { category: 'orders', severity: 'warn', title: 'Your price is still with Finance',
        body: `${q.quote_no} for ${q.contact_name} has not been approved yet. Finance was alerted again; call them if the customer is waiting.`,
        link: 'POS_Cashier.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qescalate:' + q.quote_no }, 'cashier');
      await logDecision(pool, { quote: q, action: 'escalated', rules: (q.approval_check || {}).rules || [], reason: `Still waiting after ${S.approvalEscalateHours} h: escalated to Finance (not approved)` });
    }
    return { reminded: due.length, escalated: late.length };
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'quote-approval-reminders', run: approvalReminders });

  /* ---------------- automation: keep the price a customer is looking at in step with today's material cost ----------------
     Every run, each sent quote that nobody has paid on is priced again at today's costs. Cost down -> the lower price goes out by itself
     (same routing as a cashier's price, logged as "System (automatic)", the customer is told). Cost up, or a drop too big to hand out
     unseen -> the cashier and Finance are told once and decide. QUOTE_AUTO_REFRESH=off turns the automatic refresh off (the alerts stay);
     QUOTE_AUTO_REFRESH_MAX_DROP_PCT (default 25) is the largest cut it will make on its own. */
  async function priceWatch() {
    const off = String(process.env.QUOTE_AUTO_REFRESH || 'on').toLowerCase() === 'off';
    const maxDropPct = Number(process.env.QUOTE_AUTO_REFRESH_MAX_DROP_PCT) > 0 ? Number(process.env.QUOTE_AUTO_REFRESH_MAX_DROP_PCT) : 25;
    const S = await settings(), out = { checked: 0, refreshed: 0, alerted: 0 };
    const { rows } = await pool.query(`SELECT * FROM quote_requests WHERE status = 'quoted' AND COALESCE(paid_amount, 0) = 0
        AND suggested_cost > 0 AND quoted_amount > 0 ORDER BY quote_id LIMIT 100`);
    for (const q of rows) {
      out.checked++;
      try {
        const d = await draftForQuote(pool, q);
        if (!d.ok) continue;
        const pendingTerms = q.terms_key && q.terms_key !== 'full' && q.terms_state === 'proposed' ? { key: q.terms_key, label: q.terms_key } : null;
        const route = routeQuote({ amount: d.total, draft: d, settings: S, terms: pendingTerms }).route;
        const w = priceWatchAction({ quoted: +q.quoted_amount, oldCost: +q.suggested_cost, newCost: d.costTotal, newTotal: d.total, route, costMovePct: S.costMovePct, maxDropPct });
        if (w.action === 'none') continue;
        if (w.action === 'refresh' && !off) {
          const r = await refreshPrice(q.quote_no, SYSTEM);
          if (r.status === 'quoted') {
            out.refreshed++;
            const to = q.proposed_by || q.handled_by || q.created_by;
            await pingUser(to, { category: 'orders', severity: 'info', title: 'Price lowered automatically', body: `${q.quote_no} (${q.contact_name}): material cost fell ${Math.abs(w.movedPct)}%, so the price went ${peso(r.before)} → ${peso(r.amount)} and the customer was told.`,
              link: 'POS_Cashier.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qauto:' + q.quote_no + ':' + Math.round(d.costTotal) }, 'cashier');
          }
          continue;
        }
        const up = w.action === 'notify_up', key = 'qcost:' + q.quote_no + ':' + Math.round(d.costTotal);
        const body = up ? `${q.quote_no} (${q.contact_name}): material cost rose ${w.movedPct}% since the price was set (${peso(q.suggested_cost)} → ${peso(d.costTotal)}). The customer still holds ${peso(q.quoted_amount)}; the system price is now ${peso(d.total)}. Refresh it only if you want to re-quote.`
          : `${q.quote_no} (${q.contact_name}): material cost fell ${Math.abs(w.movedPct)}%, but the new system price ${peso(d.total)} is ${w.dropPct}% below the ${peso(q.quoted_amount)} the customer holds${route === 'quoted' ? '' : ' and would need Finance'}, so it was not changed automatically. Review it.`;
        const spec = { category: 'orders', severity: 'warn', title: up ? 'Material cost went up on a sent quote' : 'Material cost fell on a sent quote: review the price', body, link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: key };
        out.alerted += (await pingFinance(spec)) || 0;
        await pingUser(q.proposed_by || q.handled_by || q.created_by, Object.assign({}, spec, { link: 'POS_Cashier.html#quotes' }), 'cashier');
      } catch (err) { console.warn('[quote-automation] price watch failed for ' + q.quote_no + ':', err.message); }
    }
    if (out.refreshed || out.alerted) console.log(`[auto] quote price watch: ${out.refreshed} refreshed, ${out.alerted} alert(s)`);
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'quote-price-watch', run: priceWatch });

  const api = { ready, settings, draft, draftForQuote, forCustomer, route: routeQuote, logDecision, saveRecipe, readLines, onAccept, afterAccept,
    refreshPrice, materialItems, inventoryFit, approvalReminders, priceWatch, RULE_LABEL, SYSTEM };
  app.locals.quoteAutomation = api;
  return api;
};
module.exports.pure = { priceLines, routeQuote, RULE_LABEL, NO_BULK, bulkBlocked, priceWatchAction };
