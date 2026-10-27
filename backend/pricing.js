/* pricing.js — automatic prices, so nobody has to work them out by hand.

   1. Finished goods: selling price = unit cost x (1 + markup %). Markup is 20% by default (Finance can change it).
      A database trigger keeps the price right whenever the unit cost changes, from ANY screen or job, so it never goes stale.
      A product can be switched to a manual price (price_auto = false) when there is a reason; the trigger then leaves it alone.

   2. Custom made-to-order quotes (Task 4): there is no saved recipe, so quote-automation.js builds a QUICK RECIPE on the quote
      and prices it with the Task 3 formula (sum of quantity per piece x current unit cost, then cost x (1 + quote markup %)).
      This module only keeps the ESTIMATES that first guess uses, all of them edited by Finance on "Pricing rules":
        weight per piece   from the size: a size range (table), a pipe size (table) or typed dimensions (volume x density x fill factor)
        raw material       weight x (1 + scrap %), in the stock unit of the matching raw material
        finishing supply   weight x the supply used per kg of the piece for that finish (0 = the finish uses no stock item)
      They are estimates, and every screen that uses them says so. Rates for process, labour and tooling are not part of the
      cost (same rule as Task 3); they can be added to a quote as extra recipe lines.
   Every rate lives in one row (pricing_rules) that Finance edits on the Products page ("Pricing rules"). */
module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  const DEFAULT_RATES = {
    density: { Aluminum: 2.7, Brass: 8.5 },                                       // g/cm3
    fillFactor: 0.35,                                                               // a cast / forged part is not a solid block
    rangeWeightKg: { 'Small': 0.08, 'Medium': 0.45, 'Large': 2.0, 'Extra large': 7.5 },     // aluminum; brass is scaled by density
    pipeWeightKg: { '1/4"': 0.06, '3/8"': 0.09, '1/2"': 0.14, '3/4"': 0.22, '1"': 0.36, '1-1/4"': 0.55, '1-1/2"': 0.75, '2"': 1.2 },
    scrapPct: 10,
    thicknessRefMm: 3,
    // finishing supply used per kg of the piece, in the supply's own stock unit (kg of powder, kg of plating salt ...)
    finishUsePerKg: { 'Raw / Unfinished': 0, 'Shot Blasted': 0, 'Powder Coated': 0.05, 'Painted': 0.04, 'Chromate Conversion': 0.01, 'Polished': 0.01,
                      'Satin / Brushed': 0.008, 'Nickel Plated': 0.012, 'Chrome Plated': 0.01 }
  };
  // every number above is a first guess, not a measured value: the screens label them "estimate"
  const ESTIMATES = Object.keys(DEFAULT_RATES);
  const ITEM_FAMILY = { 'Die-cast part': 'Aluminum', 'Forged part': 'Brass', 'Fitting / valve': 'Brass' };
  const FAMILY_DEFAULT = { Aluminum: 'Aluminum ADC12', Brass: 'Brass C37700' };
  const PIPE_IN = { '1/4"': 0.25, '3/8"': 0.375, '1/2"': 0.5, '3/4"': 0.75, '1"': 1, '1-1/4"': 1.25, '1-1/2"': 1.5, '2"': 2 };
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /* ---------- database ---------- */
  async function ensure() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pricing_rules (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        fg_markup_pct NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (fg_markup_pct >= 0 AND fg_markup_pct <= 500),
        quote_markup_pct NUMERIC(6,2) NOT NULL DEFAULT 20 CHECK (quote_markup_pct >= 0 AND quote_markup_pct <= 500),
        rates JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`INSERT INTO pricing_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      const had = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'price_auto'`)).rowCount;
      await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price_auto BOOLEAN NOT NULL DEFAULT TRUE`);
      await pool.query(`CREATE OR REPLACE FUNCTION fg_auto_price() RETURNS trigger AS $$
        DECLARE m NUMERIC;
        BEGIN
          IF NEW.department = 'Finished Goods' AND NEW.price_auto THEN
            SELECT fg_markup_pct INTO m FROM pricing_rules WHERE id = 1;
            NEW.selling_price := round(COALESCE(NEW.unit_cost, 0) * (1 + COALESCE(m, 20) / 100.0), 2);
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await pool.query(`DROP TRIGGER IF EXISTS trg_fg_auto_price ON products`);
      await pool.query(`CREATE TRIGGER trg_fg_auto_price BEFORE INSERT OR UPDATE OF unit_cost, price_auto, department, selling_price ON products
        FOR EACH ROW EXECUTE FUNCTION fg_auto_price()`);
      // first start with this feature: every finished good is priced from its cost (touching unit_cost fires the trigger)
      if (!had) await pool.query(`UPDATE products SET unit_cost = unit_cost WHERE department = 'Finished Goods' AND price_auto`);
      // quote_requests.suggested_amount / suggested_cost are added by shop-extras.js, which creates that table
      return true;
    } catch (err) { console.warn('[pricing] setup failed:', err.message); return false; }
  }
  const ready = ensure();

  async function rules(db) {
    await ready;
    const r = (await (db || pool).query('SELECT fg_markup_pct, quote_markup_pct, rates, updated_at, u.full_name AS updated_by FROM pricing_rules LEFT JOIN users u ON u.user_id = pricing_rules.updated_by WHERE id = 1')).rows[0] || {};
    const saved = r.rates || {};
    const rates = {};
    Object.keys(DEFAULT_RATES).forEach((k) => {
      const d = DEFAULT_RATES[k];
      rates[k] = d && typeof d === 'object' ? Object.assign({}, d, saved[k] && typeof saved[k] === 'object' ? saved[k] : {}) : (saved[k] != null ? saved[k] : d);
    });
    return { fgMarkupPct: r.fg_markup_pct == null ? 20 : +r.fg_markup_pct, quoteMarkupPct: r.quote_markup_pct == null ? 20 : +r.quote_markup_pct,
      rates, updatedAt: r.updated_at || null, updatedBy: r.updated_by || null };
  }

  /* ---------- the weight estimate: the first guess of how much material one piece needs ---------- */
  const toMm = (v) => {
    const unit = (/(mm|cm|inches|inch|in|")\s*$/i.exec(v) || [])[1] || 'mm', f = /^mm$/i.test(unit) ? 1 : /^cm$/i.test(unit) ? 10 : 25.4;
    return (String(v).replace(/(mm|cm|inches|inch|in|")\s*$/i, '').match(/\d+(?:[-\s]\d+\/\d+|\/\d+|\.\d+)?/g) || []).map((t) => {
      const mx = /^(\d+)[-\s](\d+)\/(\d+)$/.exec(t), fr = /^(\d+)\/(\d+)$/.exec(t);
      return (mx ? +mx[1] + mx[2] / mx[3] : fr ? fr[1] / fr[2] : +t) * f;
    });
  };
  function pipeWeight(rates, size) {
    if (rates.pipeWeightKg[size] != null) return { kg: +rates.pipeWeightKg[size], basis: 'standard weight of a ' + size + ' fitting' };
    const mm = toMm(size)[0];
    if (!(mm > 0)) return null;
    const inch = mm / 25.4, pts = Object.keys(PIPE_IN).map((k) => [PIPE_IN[k], +rates.pipeWeightKg[k]]).sort((a, b) => a[0] - b[0]);
    let kg;
    if (inch <= pts[0][0]) kg = pts[0][1] * Math.pow(inch / pts[0][0], 2);
    else if (inch >= pts[pts.length - 1][0]) kg = pts[pts.length - 1][1] * Math.pow(inch / pts[pts.length - 1][0], 2);
    else for (let i = 1; i < pts.length; i++) if (inch <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; kg = a[1] + (b[1] - a[1]) * (inch - a[0]) / (b[0] - a[0]); break; }
    return { kg, basis: 'a ' + (+inch.toFixed(2)) + '" fitting, between the standard sizes' };
  }
  function partWeight(rates, family, size, thickness) {
    const ratio = rates.density[family] / rates.density.Aluminum;
    const range = Object.keys(rates.rangeWeightKg).sort((a, b) => b.length - a.length).find((k) => new RegExp('^' + k + '\\b', 'i').test(size));
    if (range) {
      const t = parseFloat(thickness), f = t > 0 ? clamp(t / rates.thicknessRefMm, 0.5, 2.5) : 1;
      return { kg: rates.rangeWeightKg[range] * ratio * f,
        basis: range.toLowerCase() + ' size' + (f !== 1 ? ', wall ' + t + ' mm (x' + r2(f) + ')' : '') + ', ' + family.toLowerCase() };
    }
    const n = toMm(size);
    if (!n.length || n.some((x) => !(x > 0))) return null;
    let vol;                                                   // mm3
    if (/^[Øø⌀]/.test(String(size).trim())) vol = Math.PI / 4 * n[0] * n[0] * (n[0] / 2);
    else if (n.length >= 3) vol = n[0] * n[1] * n[2];
    else if (n.length === 2) vol = n[0] * n[1] * Math.max(parseFloat(thickness) || Math.min(n[0], n[1]) / 4, 1);
    else vol = Math.pow(n[0], 3) / 4;
    return { kg: vol * rates.fillFactor * rates.density[family] / 1e6, basis: size + ' x ' + Math.round(rates.fillFactor * 100) + '% fill x ' + rates.density[family] + ' g/cm3' };
  }
  // { kg, basis } for one piece, or null when the size cannot be read
  function weightOf(rates, itemType, size, thickness) {
    const family = ITEM_FAMILY[itemType];
    if (!family) return null;
    const w = itemType === 'Fitting / valve' ? pipeWeight(rates, size) : partWeight(rates, family, size, thickness);
    return w && w.kg > 0 ? w : null;
  }
  const qtyOf = (q) => { const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(q || '')); return m ? Number(m[1].replace(/,/g, '')) : 0; };

  /* ---------- routes ---------- */
  app.get('/api/pricing', auth('finance', 'cashier'), wrap(async (req, res) => {
    const R = await rules();
    const qa = app.locals.quoteAutomation;
    res.json(Object.assign(R, { defaults: DEFAULT_RATES, estimates: ESTIMATES, materialItems: qa ? await qa.materialItems(pool) : {} }));
  }));

  const num = (e, key, v, label, max) => {
    const n = Number(v);
    if (v === '' || v == null || !Number.isFinite(n)) { e[key] = label + ' must be a number'; return null; }
    if (n < 0) { e[key] = label + ' cannot be negative'; return null; }
    if (n > max) { e[key] = label + ' is too large'; return null; }
    return Math.round(n * 10000) / 10000;
  };
  app.put('/api/finance/pricing', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, e = {};
    const fg = num(e, 'fgMarkupPct', b.fgMarkupPct, 'Finished goods markup', 500);
    const qm = num(e, 'quoteMarkupPct', b.quoteMarkupPct, 'Quote markup', 500);
    const cur = (await rules()).rates, rates = {};
    const inRates = b.rates && typeof b.rates === 'object' ? b.rates : {};
    Object.keys(DEFAULT_RATES).forEach((k) => {
      const d = DEFAULT_RATES[k];
      if (d && typeof d === 'object') {
        rates[k] = {};
        Object.keys(d).forEach((sub) => {
          const v = inRates[k] && inRates[k][sub] !== undefined ? inRates[k][sub] : cur[k][sub];
          const n = num(e, 'rates.' + k + '.' + sub, v, sub, k === 'finishUsePerKg' ? 10 : 1e7);
          rates[k][sub] = n == null ? cur[k][sub] : n;
        });
      } else {
        const v = inRates[k] !== undefined ? inRates[k] : cur[k];
        const n = num(e, 'rates.' + k, v, k, k === 'fillFactor' ? 1 : k === 'scrapPct' ? 100 : 1e7);
        rates[k] = n == null ? cur[k] : n;
      }
    });
    if (rates.fillFactor <= 0) e['rates.fillFactor'] = 'Fill factor must be more than 0';
    if (rates.thicknessRefMm <= 0) e['rates.thicknessRefMm'] = 'Reference wall must be more than 0';
    Object.keys(rates.density).forEach((k) => { if (!(rates.density[k] > 0)) e['rates.density.' + k] = 'Density must be more than 0'; });
    if (Object.keys(e).length) throw new ValidationError(e);
    const changed = await tx(async (client) => {
      const before = await rules(client);
      await client.query('UPDATE pricing_rules SET fg_markup_pct = $1, quote_markup_pct = $2, rates = $3, updated_by = $4, updated_at = now() WHERE id = 1',
        [fg, qm, JSON.stringify(rates), req.user.id]);
      // finished goods on automatic pricing follow the new markup straight away
      const n = (await client.query(`UPDATE products SET unit_cost = unit_cost WHERE department = 'Finished Goods' AND price_auto AND NOT is_archived`)).rowCount;
      const moved = ESTIMATES.filter((k) => JSON.stringify(before.rates[k]) !== JSON.stringify(rates[k]));
      await audit(client, req.user, 'Record edited', `Pricing rules: finished goods markup ${before.fgMarkupPct}% to ${fg}%, quote markup ${before.quoteMarkupPct}% to ${qm}%` +
        (moved.length ? `; estimates changed: ${moved.join(', ')}` : '') + (n ? `; ${n} finished good price${n === 1 ? '' : 's'} recalculated` : ''));
      return n;
    });
    res.json(Object.assign(await rules(), { repriced: changed, defaults: DEFAULT_RATES, estimates: ESTIMATES }));
  }));

  return { rules, ready, weightOf, qtyOf, ITEM_FAMILY, FAMILY_DEFAULT, DEFAULT_RATES, ESTIMATES };
};
