/* Production-based inventory deduction.

   Finance saves, for each Finished Good, the Raw Materials / Finishing Supplies needed to make ONE unit
   (table product_materials). When Finance confirms a "Produced Internally" Stock In, ONE database transaction:
     - saves a production record (+ a frozen copy of the materials actually used, so old records stay correct
       even if the requirements change later),
     - writes a Stock Out movement (reason "Used in production") for every material,
     - writes a Stock In movement (reason "Produced") for the finished product.
   products.on_hand is updated by the existing trigger on stock_movements, so every number stays consistent.
   If anything fails (not enough stock, bad quantity ...) the whole transaction is rolled back: nothing is deducted
   and no finished goods are added. A one-time request key stops a double click / retry from deducting twice.

   Tables are created automatically when the server starts. db/008_production.sql is the same thing for running by hand. */
const rcPure = require('./recipe-costing').pure;      // unit conversion shared with recipe costing
module.exports = function ({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ }) {
  const MATERIAL_DEPTS = ['Raw Materials', 'Finishing Supplies'];
  const MAX_MATERIALS = 30;

  /* ---------- database objects ---------- */
  async function ensure() {
    try {
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS production_ref_seq START 1`);
      await pool.query(`CREATE TABLE IF NOT EXISTS product_materials (
        requirement_id      BIGSERIAL PRIMARY KEY,
        finished_product_id INT NOT NULL REFERENCES products(product_id),
        material_product_id INT NOT NULL REFERENCES products(product_id),
        qty_per_unit        NUMERIC(14,4) NOT NULL CHECK (qty_per_unit > 0),
        unit                TEXT NOT NULL,
        updated_by          INT REFERENCES users(user_id),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (finished_product_id, material_product_id),
        CHECK (finished_product_id <> material_product_id)
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS production_records (
        production_id       BIGSERIAL PRIMARY KEY,
        ref                 TEXT UNIQUE NOT NULL,
        finished_product_id INT NOT NULL REFERENCES products(product_id),
        product_sku         TEXT NOT NULL,
        product_name        TEXT NOT NULL,
        unit                TEXT NOT NULL,
        quantity            NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
        status              TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed')),
        note                TEXT,
        request_key         TEXT UNIQUE,
        fg_movement_ref     TEXT,
        recorded_by         INT REFERENCES users(user_id),
        recorded_by_name    TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS production_items (
        item_id             BIGSERIAL PRIMARY KEY,
        production_id       BIGINT NOT NULL REFERENCES production_records(production_id),
        material_product_id INT NOT NULL REFERENCES products(product_id),
        material_sku        TEXT NOT NULL,
        material_name       TEXT NOT NULL,
        department          TEXT NOT NULL,
        unit                TEXT NOT NULL,
        qty_per_unit        NUMERIC(14,4) NOT NULL,
        calculated_qty      NUMERIC(14,2) NOT NULL,
        actual_qty          NUMERIC(14,2) NOT NULL CHECK (actual_qty >= 0),
        movement_ref        TEXT
      )`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_prod_items_prod ON production_items (production_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_prod_records_time ON production_records (created_at DESC)`);
      // the ledger may point at a production record (source_type 'production'); widen the old two-value check
      await pool.query(`DO $$ DECLARE c record; BEGIN
        FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) ILIKE '%source_type%' AND pg_get_constraintdef(oid) NOT ILIKE '%production%'
        LOOP EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c.conname); END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                          AND pg_get_constraintdef(oid) ILIKE '%source_type%') THEN
          ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
            CHECK (source_type IS NULL OR source_type IN ('pos_sale','order','production'));
        END IF;
      END $$`);
      return true;
    } catch (err) {
      console.warn('[db] could not set up the production tables:', err.message);
      return false;
    }
  }
  const ready = ensure();
  const needReady = async () => { if (!(await ready)) throw new Error('Production tables are not available'); };

  /* ---------- small helpers ---------- */
  // exact decimal maths with integers (no 0.1 + 0.2 surprises)
  const scaled = (n, dp) => Math.round(Number(n) * 10 ** dp);
  const lineQty = (perUnit, qty) => Math.round(scaled(perUnit, 4) * scaled(qty, 2) / 1e4) / 100;   // 2 decimals, like the ledger

  function num(e, key, v, label, { max, dp, gt = true } = {}) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) { e[key] = `${label} is required`; return null; }
    if ((typeof v !== 'number' && typeof v !== 'string') ||
        (typeof v === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()))) {
      e[key] = `${label} must be a number`; return null;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) { e[key] = `${label} must be a number`; return null; }
    if (gt ? n <= 0 : n < 0) { e[key] = gt ? `${label} must be more than 0` : `${label} cannot be negative`; return null; }
    if (max !== undefined && n > max) { e[key] = `${label} is too large`; return null; }
    if (dp !== undefined && Math.abs(n * 10 ** dp - Math.round(n * 10 ** dp)) > 1e-6) {
      e[key] = `${label} can have at most ${dp} decimal place${dp === 1 ? '' : 's'}`; return null;
    }
    return n;
  }
  const fmt = (n) => String(+Number(n).toFixed(4));

  async function finishedProduct(client, sku, lock) {
    const p = await client.query(
      `SELECT product_id, sku, name, department, unit, on_hand FROM products WHERE sku = $1 AND NOT is_archived${lock ? ' FOR UPDATE' : ''}`, [sku]);
    if (!p.rowCount) throw new ValidationError({ sku: 'That product does not exist' });
    if (p.rows[0].department !== 'Finished Goods')
      throw new ValidationError({ sku: `${p.rows[0].name} is not a Finished Good — only finished goods are produced` });
    return p.rows[0];
  }
  async function requirementRows(client, finishedId) {
    const { rows } = await client.query(
      `SELECT m.product_id, m.sku, m.name, m.department, m.unit, m.on_hand, m.unit_cost, m.is_archived, pm.qty_per_unit, pm.unit AS req_unit
         FROM product_materials pm JOIN products m ON m.product_id = pm.material_product_id
        WHERE pm.finished_product_id = $1 ORDER BY m.department, m.name`, [finishedId]);
    return rows;
  }

  /* ---------- material requirements (per ONE finished unit) ---------- */
  // finished goods + how many materials each one has saved
  app.get('/api/production/requirements', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const { rows } = await pool.query(
      `SELECT p.sku, p.name, p.unit, COUNT(pm.requirement_id)::int AS materials
         FROM products p LEFT JOIN product_materials pm ON pm.finished_product_id = p.product_id
        WHERE p.department = 'Finished Goods' AND NOT p.is_archived GROUP BY p.product_id ORDER BY p.name`);
    res.json(rows);
  }));

  app.get('/api/production/requirements/:sku', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const fg = await finishedProduct(pool, str(req.params.sku).toUpperCase(), false);
    const rows = await requirementRows(pool, fg.product_id);
    res.json({ sku: fg.sku, name: fg.name, unit: fg.unit,
      materials: rows.map((r) => ({ sku: r.sku, name: r.name, department: r.department, unit: r.unit, onHand: +r.on_hand,
        unitCost: +r.unit_cost, qtyPerUnit: +r.qty_per_unit, archived: r.is_archived, unitChanged: r.req_unit !== r.unit, recipeUnit: r.req_unit })) });
  }));

  // where-used: the finished goods that need this raw material / finishing supply (shown in the product details)
  app.get('/api/production/where-used/:sku', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const m = await pool.query(`SELECT product_id, sku, name, department, unit FROM products WHERE sku = $1`, [str(req.params.sku).toUpperCase()]);
    if (!m.rowCount) throw new ValidationError({ sku: 'That product does not exist' });
    const { rows } = await pool.query(
      `SELECT fg.sku, fg.name, fg.unit, fg.is_archived, pm.qty_per_unit
         FROM product_materials pm JOIN products fg ON fg.product_id = pm.finished_product_id
        WHERE pm.material_product_id = $1 ORDER BY fg.is_archived, fg.name`, [m.rows[0].product_id]);
    res.json({ sku: m.rows[0].sku, name: m.rows[0].name, unit: m.rows[0].unit,
      usedIn: rows.map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, qtyPerUnit: +r.qty_per_unit, archived: r.is_archived })) });
  }));

  // replaces the whole list for one finished product. Past production records keep their own copy, so they do not change.
  app.put('/api/production/requirements/:sku', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const list = (req.body || {}).materials;
    if (!Array.isArray(list)) throw new ValidationError({ materials: 'Send the list of materials' });
    if (list.length > MAX_MATERIALS) throw new ValidationError({ materials: `A product can have at most ${MAX_MATERIALS} materials` });
    const out = await tx(async (client) => {
      const fg = await finishedProduct(client, str(req.params.sku).toUpperCase(), true);
      const seen = new Set(), clean = [];
      for (let i = 0; i < list.length; i++) {
        const e = {}, row = list[i] || {};
        const sku = str(row.sku).toUpperCase();
        if (!sku) throw new ValidationError({ materials: `Line ${i + 1}: choose a material` });
        if (seen.has(sku)) throw new ValidationError({ materials: `${sku} is listed twice — each material can only appear once` });
        seen.add(sku);
        const entryUnit = str(row.unit);                                  // optional: the unit the quantity was typed in (g for a kg item ...)
        const q = num(e, 'q', row.qtyPerUnit, `Line ${i + 1}: quantity per unit`, { max: 1e6, dp: entryUnit ? 6 : 4 });
        if (e.q) throw new ValidationError({ materials: e.q, ['mat:' + sku]: e.q });
        clean.push({ sku, q, entryUnit });
      }
      const mats = clean.length ? (await client.query(
        `SELECT product_id, sku, name, department, unit, is_archived FROM products WHERE sku = ANY($1)`, [clean.map((c) => c.sku)])).rows : [];
      const bySku = new Map(mats.map((m) => [m.sku, m]));
      const converted = [];
      for (const c of clean) {
        const m = bySku.get(c.sku);
        if (!m) throw new ValidationError({ materials: `${c.sku} does not exist` });
        if (m.is_archived) throw new ValidationError({ materials: `${m.name} is archived — remove it or restore it first` });
        if (!MATERIAL_DEPTS.includes(m.department))
          throw new ValidationError({ materials: `${m.name} is ${m.department} — only Raw Materials and Finishing Supplies can be used as materials` });
        // unit mismatch (recipe in g, stock in kg): convert when the two units are the same kind, otherwise block with a clear message
        if (c.entryUnit && rcPure.normUnit(c.entryUnit) !== rcPure.normUnit(m.unit)) {
          const cv = rcPure.convert(c.q, c.entryUnit, m.unit);
          if (!cv.ok) throw new ValidationError({ materials: `${m.name}: ${cv.reason}`, ['mat:' + c.sku]: cv.reason });
          converted.push(`${m.name} ${fmt(c.q)} ${c.entryUnit} = ${fmt(cv.qty)} ${m.unit}`);
          c.q = cv.qty;
        } else if (Math.abs(c.q * 1e4 - Math.round(c.q * 1e4)) > 1e-6) throw new ValidationError({ materials: `${m.name}: use at most 4 decimal places`, ['mat:' + c.sku]: 'Use at most 4 decimal places' });
      }
      await client.query('DELETE FROM product_materials WHERE finished_product_id = $1', [fg.product_id]);
      for (const c of clean) {
        const m = bySku.get(c.sku);
        await client.query(
          `INSERT INTO product_materials (finished_product_id, material_product_id, qty_per_unit, unit, updated_by) VALUES ($1,$2,$3,$4,$5)`,
          [fg.product_id, m.product_id, c.q, m.unit, req.user.id]);
      }
      await audit(client, req.user, 'Material requirements',
        `${fg.name} (${fg.sku}) — ${clean.length ? clean.map((c) => `${bySku.get(c.sku).name} ${fmt(c.q)} ${bySku.get(c.sku).unit}`).join(', ') + ' per ' + fg.unit : 'all materials removed'}` +
        (converted.length ? ` (units converted: ${converted.join('; ')})` : ''));
      // the recipe changed, so the cost (and the automatic price) follows straight away
      const rc = app.locals.recipeCosting;
      let cost = null;
      if (clean.length && rc && (await rc.ready)) {
        cost = await rc.recalcOne(client, fg.product_id, { user: req.user, why: 'recipe changed' });
        if (cost.status === 'updated') await rc.flagQuotes(client, [cost], 'recipe changed');
      }
      return { saved: clean.length, converted, cost: cost ? { status: cost.status, oldCost: cost.oldCost, newCost: cost.newCost, oldPrice: cost.oldPrice, newPrice: cost.newPrice,
        problems: cost.problems ? cost.problems.map((p) => p.message) : undefined, belowCost: cost.belowCost || undefined, quotesFlagged: cost.quotesFlagged } : undefined };
    });
    res.json(out);
  }));

  /* ---------- preview (nothing is saved or deducted here) ---------- */
  app.post('/api/production/preview', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const e = {};
    const sku = str((req.body || {}).sku).toUpperCase();
    if (!sku) e.sku = 'Choose the finished product';
    const quantity = num(e, 'quantity', (req.body || {}).quantity, 'Quantity produced', { max: 1e6, dp: 2 });
    if (Object.keys(e).length) throw new ValidationError(e);
    const fg = await finishedProduct(pool, sku, false);
    const rows = await requirementRows(pool, fg.product_id);
    res.json({ sku: fg.sku, name: fg.name, unit: fg.unit, quantity, onHand: +fg.on_hand, hasRequirements: rows.length > 0,
      materials: rows.map((r) => ({ sku: r.sku, name: r.name, department: r.department, unit: r.unit, onHand: +r.on_hand,
        qtyPerUnit: +r.qty_per_unit, calculated: lineQty(r.qty_per_unit, quantity), archived: r.is_archived, unitChanged: r.req_unit !== r.unit })) });
  }));

  /* ---------- confirm production (the only place materials are deducted automatically) ---------- */
  app.post('/api/production', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const b = req.body || {};
    const e = {};
    const sku = str(b.sku).toUpperCase();
    if (!sku) e.sku = 'Choose the finished product';
    const quantity = num(e, 'quantity', b.quantity, 'Quantity produced', { max: 1e6, dp: 2 });
    const key = str(b.requestKey);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) e.requestKey = 'This form is out of date — reload the page and try again';
    const note = str(b.note);
    if (note.length > 300) e.note = 'Note is too long (300 characters at most)';
    const actual = new Map();
    if (!Array.isArray(b.items)) e.materials = 'The materials list is missing — reload the preview';
    else for (const it of b.items) {
      const k = str((it || {}).sku).toUpperCase();
      const ie = {};
      const q = num(ie, 'q', (it || {}).actualQty, 'Actual quantity', { max: 1e8, dp: 2, gt: false });
      if (!k || actual.has(k)) { e.materials = 'The materials list is invalid — reload the preview'; break; }
      if (ie.q) { e.materials = `${k}: ${ie.q}`; e['mat:' + k] = ie.q; break; }
      actual.set(k, q);
    }
    if (Object.keys(e).length) throw new ValidationError(e);

    const result = await tx(async (client) => {
      const fgInfo = await finishedProduct(client, sku, false);

      // 1) claim the request key FIRST. A second click / retry with the same key waits here, then sees the first one's record.
      const ins = await client.query(
        `INSERT INTO production_records (ref, finished_product_id, product_sku, product_name, unit, quantity, note, request_key, recorded_by, recorded_by_name)
         VALUES ('PRD-' || lpad(nextval('production_ref_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (request_key) DO NOTHING RETURNING production_id, ref`,
        [fgInfo.product_id, fgInfo.sku, fgInfo.name, fgInfo.unit, quantity, note || null, key, req.user.id, req.user.name]);
      if (!ins.rowCount) {
        const ex = await client.query('SELECT production_id FROM production_records WHERE request_key = $1', [key]);
        return { id: ex.rows[0].production_id, duplicate: true };
      }
      const prod = ins.rows[0];

      // 2) saved requirements, locked together with the stock rows (same order every time, so two productions never deadlock)
      const reqs = await requirementRows(client, fgInfo.product_id);
      if (!reqs.length)
        throw new ValidationError({ sku: `${fgInfo.name} has no material requirements yet — set them up first, then record the production` });
      const ids = reqs.map((r) => r.product_id);
      const locked = (await client.query(
        `SELECT product_id, sku, name, department, unit, on_hand, is_archived FROM products WHERE product_id = ANY($1) ORDER BY product_id FOR UPDATE`, [ids])).rows;
      const stock = new Map(locked.map((r) => [r.product_id, r]));

      // the form must list exactly the saved materials (only the quantities can be edited)
      const wanted = new Set(reqs.map((r) => r.sku));
      if (actual.size !== wanted.size || [...actual.keys()].some((k) => !wanted.has(k)))
        throw new ValidationError({ materials: 'The material requirements changed while you were working — reload the preview and check the quantities again' });

      const lines = reqs.map((r) => {
        const s = stock.get(r.product_id);
        return { r, s, calc: lineQty(r.qty_per_unit, quantity), qty: actual.get(r.sku) };
      });
      for (const l of lines) {
        if (l.s.is_archived) throw new ValidationError({ materials: `${l.s.name} is archived — update the material requirements first` });
        if (l.r.req_unit !== l.s.unit)
          throw new ValidationError({ materials: `The unit of ${l.s.name} changed from ${l.r.req_unit} to ${l.s.unit} — save the material requirements again` });
      }

      // 2b) the batch is booked at the RECIPE cost: recalculate from the materials' cost right now (they are locked), never a typed standard cost.
      //     A finished good whose cost Finance overrode (with a reason) keeps that cost. If a material has no cost the batch is NOT booked at a wrong number.
      const rc = app.locals.recipeCosting;
      let batchCost = null;
      if (rc && (await rc.ready)) {
        const r2 = await rc.recalcOne(client, fgInfo.product_id, { user: req.user, why: `production ${prod.ref} confirmed` });
        if (r2.status === 'blocked')
          throw new ValidationError({ materials: 'The cost of this batch cannot be worked out yet: ' + r2.problems.map((p) => p.message).join(' ') });
        batchCost = r2.newCost == null ? r2.oldCost : r2.newCost;
        if (r2.status === 'updated') await rc.flagQuotes(client, [r2], `production ${prod.ref}`);
      }

      // 3) enough stock? list EVERY material that is short, not just the first
      const short = lines.filter((l) => l.qty > +l.s.on_hand);
      if (short.length) {
        const f = { materials: 'Not enough stock: ' + short.map((l) => `${l.s.name} (needs ${fmt(l.qty)} ${l.s.unit}, only ${fmt(l.s.on_hand)} on hand)`).join('; ') };
        short.forEach((l) => { f['mat:' + l.s.sku] = `Only ${fmt(l.s.on_hand)} ${l.s.unit} on hand`; });
        throw new ValidationError(f);
      }

      // 4) deduct the materials (Stock Out, "Used in production"), linked to this production record
      for (const l of lines) {
        let mref = null;
        if (l.qty > 0) {
          const mv = await client.query(
            `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost)
             VALUES ($1,'out','production_use',$2,$3,'production',$4,$5,(SELECT unit_cost FROM products WHERE product_id = $1)) RETURNING ref`,   // material cost at this moment
            [l.s.product_id, l.qty, req.user.id, prod.production_id, `${prod.ref} — used to make ${quantity} ${fgInfo.unit} of ${fgInfo.name}`]);
          mref = mv.rows[0].ref;
        }
        await client.query(
          `INSERT INTO production_items (production_id, material_product_id, material_sku, material_name, department, unit, qty_per_unit, calculated_qty, actual_qty, movement_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [prod.production_id, l.s.product_id, l.s.sku, l.s.name, l.s.department, l.s.unit, l.r.qty_per_unit, l.calc, l.qty, mref]);
      }

      // 5) add the finished goods (Stock In, "Produced")
      const fgMv = await client.query(
        // the finished good is booked at its recipe cost (materials only: no labour, process or tooling)
        `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost)
         VALUES ($1,'in','produced_batch',$2,$3,'production',$4,$5,COALESCE($6::numeric, (SELECT unit_cost FROM products WHERE product_id = $1))) RETURNING ref`,
        [fgInfo.product_id, quantity, req.user.id, prod.production_id, `${prod.ref} — produced internally at the recipe cost`, batchCost]);
      await client.query('UPDATE production_records SET fg_movement_ref = $1, unit_cost = $3 WHERE production_id = $2', [fgMv.rows[0].ref, prod.production_id, batchCost]);

      await audit(client, req.user, 'Production recorded',
        `${prod.ref} — ${fgInfo.name} +${quantity} ${fgInfo.unit}` + (batchCost != null ? ` at the recipe cost of ₱${Number(batchCost).toFixed(2)} each` : '') + `; used ` +
        lines.map((l) => `${l.s.name} -${fmt(l.qty)} ${l.s.unit}`).join(', '));
      return { id: prod.production_id, duplicate: false };
    });

    const rec = (await history(result.id, 1))[0];
    res.status(result.duplicate ? 200 : 201).json({ ...rec, duplicate: result.duplicate });
    if (!result.duplicate && rec && app.locals.notifications)
      app.locals.notifications.notifyProduction(rec).catch((err) => console.warn('[notify] production:', err.message));
    if (!result.duplicate && app.locals.lowStock && typeof app.locals.lowStock.check === 'function')
      app.locals.lowStock.check().catch((err) => console.warn('[notify] production low-stock:', err.message));
  }));

  /* ---------- production history ---------- */
  async function history(onlyId, limit) {
    const { rows } = await pool.query(
      `SELECT pr.production_id, pr.ref, pr.product_sku, pr.product_name, pr.unit, pr.quantity, pr.status, pr.note, pr.fg_movement_ref,
              COALESCE(pr.recorded_by_name, '—') AS recorded_by,
              to_char(pr.created_at AT TIME ZONE $3, 'Mon DD, YYYY HH12:MI AM') AS dt,
              to_char(pr.created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS d, pr.unit_cost,
              COALESCE(json_agg(json_build_object('sku', pi.material_sku, 'name', pi.material_name, 'department', pi.department,
                         'unit', pi.unit, 'perUnit', pi.qty_per_unit, 'calculated', pi.calculated_qty, 'actual', pi.actual_qty,
                         'movementRef', pi.movement_ref) ORDER BY pi.department, pi.material_name) FILTER (WHERE pi.item_id IS NOT NULL), '[]') AS items
         FROM production_records pr LEFT JOIN production_items pi ON pi.production_id = pr.production_id
        WHERE ($1::bigint IS NULL OR pr.production_id = $1::bigint)
        GROUP BY pr.production_id ORDER BY pr.created_at DESC, pr.production_id DESC LIMIT $2`, [onlyId || null, limit, TZ]);
    return rows.map((r) => ({
      ref: r.ref, sku: r.product_sku, product: r.product_name, unit: r.unit, quantity: +r.quantity, status: r.status,
      note: r.note || undefined, unitCost: r.unit_cost == null ? undefined : +r.unit_cost, recordedBy: r.recorded_by, dateTime: r.dt, date: r.d, stockInRef: r.fg_movement_ref,
      rawMaterials: r.items.filter((i) => i.department === 'Raw Materials'),
      finishingSupplies: r.items.filter((i) => i.department === 'Finishing Supplies')
    }));
  }
  app.get('/api/production', auth('finance'), wrap(async (req, res) => {
    await needReady();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    res.json(await history(null, limit));
  }));

  // used by GET /api/movements to show the production reference + related finished product on each movement
  return {
    ready,
    async infoFor(productionIds) {
      if (!productionIds.length) return new Map();
      try {
        await ready;
        const { rows } = await pool.query('SELECT production_id, ref, product_name FROM production_records WHERE production_id = ANY($1)', [productionIds]);
        return new Map(rows.map((r) => [String(r.production_id), { ref: r.ref, product: r.product_name }]));
      } catch (err) { return new Map(); }
    }
  };
};
