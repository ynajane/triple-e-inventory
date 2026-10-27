/* job-orders.js — making a CUSTOM quoted item (a quote with no catalog product).

   A catalog finished good is made with "Produced Internally" (production.js): its saved materials list is deducted and the
   finished good goes into stock. A custom item has no saved materials list and is never sold from stock, so it gets a
   JOB ORDER instead:

     customer accepts the quote  ->  a DRAFT job order is made automatically (quote-automation.js), with the materials list of
                                     the quote's recipe for the whole quantity; nothing leaves stock yet
       ->  Finance, the cashier or production staff "Issue materials": the draft quantities are offered, editable — ONE transaction:
             the quote moves to Preparing (the payment gates of that step apply),
             a Stock Out movement per material (reason "Used in production", source 'job_order'),
             the job order and its lines (with the cost of each material at that moment)
       ->  "Job finished": the job order is marked finished and the quote moves to Ready for pickup / Out for delivery
           ("ready" is refused for a custom quote until its materials were really issued; a draft does not count)
       ->  completed: the item goes straight to the customer (it never enters Finished Goods stock).
     Every step notifies the customer (shop-extras.js afterStep).

   Every quantity is checked against stock while the rows are locked; anything short stops the whole job (nothing deducted).
   A one-time request key stops a double click from deducting twice.
   GET/POST /api/{finance,pos}/quotes/:no/job · POST /api/{finance,pos}/quotes/:no/job/finish                          */
module.exports = function mountJobOrders({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const fmt = (n) => String(+Number(n).toFixed(4));
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MATERIAL_DEPTS = ['Raw Materials', 'Finishing Supplies'];

  const ready = (async () => {
    try {
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS job_order_ref_seq START 1`);
      await pool.query(`CREATE TABLE IF NOT EXISTS job_orders (
        job_id        BIGSERIAL PRIMARY KEY,
        ref           TEXT UNIQUE NOT NULL,
        quote_id      BIGINT NOT NULL UNIQUE REFERENCES quote_requests(quote_id),
        note          TEXT,
        material_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
        request_key   TEXT UNIQUE,
        issued_by     INT REFERENCES users(user_id),
        issued_by_name TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
      // draft (planned at acceptance, nothing deducted) -> issued (materials out of stock) -> finished (item ready)
      await pool.query(`ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'issued'`);
      await pool.query(`ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS planned JSONB`);
      await pool.query(`ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE job_orders ADD COLUMN IF NOT EXISTS finished_by_name TEXT`);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_orders_status_check') THEN
          ALTER TABLE job_orders ADD CONSTRAINT job_orders_status_check CHECK (status IN ('draft','issued','finished'));
        END IF; END $$`);
      await pool.query(`CREATE TABLE IF NOT EXISTS job_order_items (
        item_id     BIGSERIAL PRIMARY KEY,
        job_id      BIGINT NOT NULL REFERENCES job_orders(job_id),
        product_id  INT NOT NULL REFERENCES products(product_id),
        sku         TEXT NOT NULL,
        name        TEXT NOT NULL,
        department  TEXT NOT NULL,
        unit        TEXT NOT NULL,
        quantity    NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
        unit_cost   NUMERIC(12,2),
        movement_ref TEXT)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS ix_job_items_job ON job_order_items (job_id)`);
      // the stock ledger may now point at a job order: widen the source_type check (keeps every value allowed before)
      await pool.query(`DO $$ DECLARE c record; BEGIN
        FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) ILIKE '%source_type%' AND pg_get_constraintdef(oid) NOT ILIKE '%job_order%'
        LOOP EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c.conname); END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                          AND pg_get_constraintdef(oid) ILIKE '%source_type%') THEN
          ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_source_type_check
            CHECK (source_type IS NULL OR source_type IN ('pos_sale','order','production','purchase_order','job_order'));
        END IF;
      END $$`);
      for (const t of ['job_orders', 'job_order_items']) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    } catch (err) { console.warn('[db] could not prepare the job order tables:', err.message); }
  })();

  // the materials that can be issued: every active raw material and finishing supply, with what is on hand
  async function materials(db) {
    return (await (db || pool).query(
      `SELECT product_id, sku, name, department, unit, on_hand, unit_cost FROM products
        WHERE department = ANY($1) AND NOT is_archived ORDER BY department, name`, [MATERIAL_DEPTS])).rows
      .map((p) => ({ sku: p.sku, name: p.name, department: p.department, unit: p.unit, onHand: +p.on_hand, unitCost: p.unit_cost == null ? null : +p.unit_cost }));
  }
  // with no draft (a quote accepted before drafts existed): the raw material named by its grade, the supply named by its finish, no quantity
  function suggest(q, mats) {
    const sp = q.specs || {}, out = [];
    const words = (v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['not', 'specified', 'sure', 'advise', 'raw', 'unfinished', 'none'].includes(w));
    const pick = (dept, v) => {
      const w = words(v); if (!w.length) return;
      const hit = mats.filter((m) => m.department === dept).map((m) => ({ m, score: w.filter((x) => (m.name + ' ' + m.sku).toLowerCase().includes(x)).length }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0];
      if (hit && !out.some((o) => o.sku === hit.m.sku)) out.push({ sku: hit.m.sku, why: (dept === 'Raw Materials' ? 'material: ' : 'finish: ') + v });
    };
    pick('Raw Materials', sp.material);
    pick('Finishing Supplies', sp.finish);
    return out;
  }
  async function jobFor(db, quoteId) {
    const j = (await (db || pool).query(`SELECT j.*, to_char(COALESCE(j.issued_at, j.created_at) AT TIME ZONE $2, 'Mon DD, YYYY HH12:MI AM') AS at_text,
        to_char(j.finished_at AT TIME ZONE $2, 'Mon DD, YYYY HH12:MI AM') AS fin_text FROM job_orders j WHERE j.quote_id = $1`, [quoteId, TZ])).rows[0];
    if (!j) return null;
    const items = (await (db || pool).query('SELECT * FROM job_order_items WHERE job_id = $1 ORDER BY department, name', [j.job_id])).rows;
    return { jobId: j.job_id, ref: j.ref, status: j.status || 'issued', note: j.note || undefined, materialCost: +j.material_cost, issuedBy: j.issued_by_name || '—', issuedAt: j.at_text,
      finishedAt: j.fin_text || undefined, finishedBy: j.finished_by_name || undefined, planned: Array.isArray(j.planned) ? j.planned : [],
      items: items.map((i) => ({ sku: i.sku, name: i.name, department: i.department, unit: i.unit, quantity: +i.quantity, unitCost: i.unit_cost == null ? null : +i.unit_cost, movementRef: i.movement_ref })) };
  }
  const isCustom = (q) => !q.product_sku;

  /* At acceptance (quote-automation.js, inside the acceptance transaction): the plan for the job, nothing is deducted.
     lines = the priced recipe lines of the quote ({ sku, name, department, unit, needed, onHand, short, unitCost }). */
  async function createDraft(client, q, lines) {
    await ready;
    const planned = (lines || []).map((l) => ({ sku: l.sku, name: l.name, department: l.department, unit: l.unit,
      quantity: Math.ceil(Number(l.needed) * 100) / 100, onHand: l.onHand, short: l.short || 0, unitCost: l.unitCost == null ? null : l.unitCost }));
    const r = (await client.query(
      `INSERT INTO job_orders (ref, quote_id, status, planned, note)
       VALUES ('JOB-' || lpad(nextval('job_order_ref_seq')::text, 5, '0'), $1, 'draft', $2::jsonb, $3)
       ON CONFLICT (quote_id) DO UPDATE SET planned = EXCLUDED.planned WHERE job_orders.status = 'draft'
       RETURNING ref, status`, [q.quote_id, JSON.stringify(planned), 'Draft made when the customer accepted the quote'])).rows[0];
    if (r) await audit(client, { id: null, name: 'System (automatic)', roleLabel: 'System' }, 'Record added',
      `${r.ref} draft for custom quote ${q.quote_no}: ` + (planned.length ? planned.map((p) => `${p.name} ${fmt(p.quantity)} ${p.unit}` + (p.short > 0 ? ` (short by ${fmt(p.short)})` : '')).join(', ') : 'no materials listed yet'));
    return r || null;
  }
  app.locals.jobOrders = { jobFor, ready, createDraft };

  const loadQuote = async (db, no, lock) => (await db.query('SELECT * FROM quote_requests WHERE quote_no = $1' + (lock ? ' FOR UPDATE' : ''), [no])).rows[0];
  for (const [base, role] of [['/api/finance', 'finance'], ['/api/pos', 'cashier']]) {
    app.get(base + '/quotes/:no/job', auth(role), wrap(async (req, res) => {
      await ready;
      const q = await loadQuote(pool, req.params.no);
      if (!q) throw bad('id', 'Quote request not found');
      const mats = await materials(), job = await jobFor(null, q.quote_id);
      const fromDraft = job && job.status === 'draft' && job.planned.length
        ? job.planned.map((p) => ({ sku: p.sku, quantity: p.quantity, why: 'the quote recipe, for the whole quantity' + (p.short > 0 ? ' — short by ' + fmt(p.short) + ' ' + p.unit : '') }))
        : null;
      const quoted = q.quoted_amount == null ? null : +q.quoted_amount;
      const paid = +q.paid_amount || 0;
      const decision = app.locals.paymentTerms?.productionDecision(q);
      const reqDeposit = decision?.money?.initial || 0;
      const paymentBlocked = !decision?.ok;
      const canIssue = isCustom(q) && ['accepted', 'preparing'].includes(q.status) && (!job || job.status === 'draft') && !paymentBlocked;
      res.json({ custom: isCustom(q), status: q.status, job, canIssue, paymentBlocked,
        paymentNeeded: paymentBlocked ? { required: reqDeposit, paid, balance: Math.max(0, round2((quoted || 0) - paid)) } : null,
        canFinish: isCustom(q) && q.status === 'preparing' && !!job && job.status === 'issued',
        quoted, suggestions: fromDraft || suggest(q, mats), materials: mats });
    }));

    app.post(base + '/quotes/:no/job', auth(role), wrap(async (req, res) => {
      await ready;
      const b = req.body || {}, e = {};
      const key = str(b.requestKey);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) e.requestKey = 'This form is out of date. Reload and try again';
      const note = str(b.note);
      if (note.length > 300) e.note = 'Keep the note within 300 characters';
      const lines = new Map();
      if (!Array.isArray(b.items) || !b.items.length) e.items = 'Add at least one raw material or finishing supply';
      else if (b.items.length > 30) e.items = 'At most 30 materials on one job order';
      else for (const it of b.items) {
        const sku = str((it || {}).sku).toUpperCase(), raw = String((it || {}).quantity == null ? '' : it.quantity).replace(/,/g, '').trim();
        if (!sku) { e.items = 'Choose the material on every line'; break; }
        if (lines.has(sku)) { e.items = `${sku} is listed twice. Put the whole quantity on one line`; e['item:' + sku] = 'Listed twice'; break; }
        if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw) || !(Number(raw) > 0)) { e.items = `Enter how much ${sku} the job uses (a number above 0, up to 2 decimals)`; e['item:' + sku] = 'Enter a quantity above 0'; break; }
        lines.set(sku, Number(raw));
      }
      if (Object.keys(e).length) throw new ValidationError(e);

      const out = await tx(async (client) => {
        let q = await loadQuote(client, req.params.no, true);
        if (!q) throw bad('id', 'Quote request not found');
        if (!isCustom(q)) throw bad('status', 'This quotation is for a catalog product: it is sold from Finished Goods stock, not made with a job order');
        const prior = await jobFor(client, q.quote_id);
        if (prior && prior.status !== 'draft') return { q, job: prior, duplicate: true };
        if (!['accepted', 'preparing'].includes(q.status)) throw bad('status', 'Materials can only be issued once the customer accepted and before the item is ready');
        const pt = app.locals.paymentTerms;
        if (!pt) throw bad('payment', 'Payment checks are unavailable. Try again before issuing materials.');
        await pt.assertProduction(client, q);
        // issuing the materials IS the start of the work: an accepted quote moves to Preparing here (its payment gate applies)
        let stepped = null;
        if (q.status === 'accepted') {
          if (!app.locals.quoteFlow) throw bad('status', 'Start preparing this quote first, then issue its materials');
          q = stepped = await app.locals.quoteFlow.advance(client, q, 'preparing', req.user, { note: 'Materials issued' });
        }
        let job;
        if (prior) {
          job = (await client.query(`UPDATE job_orders SET status = 'issued', note = COALESCE(NULLIF($2, ''), note), request_key = $3, issued_by = $4, issued_by_name = $5, issued_at = now()
              WHERE job_id = $1 AND status = 'draft' RETURNING job_id, ref`, [prior.jobId, note, key, req.user.id, req.user.name])).rows[0];
          if (!job) return { q, job: await jobFor(client, q.quote_id), duplicate: true };
        } else {
          const ins = await client.query(
            `INSERT INTO job_orders (ref, quote_id, note, request_key, issued_by, issued_by_name, status, issued_at)
             VALUES ('JOB-' || lpad(nextval('job_order_ref_seq')::text, 5, '0'), $1, $2, $3, $4, $5, 'issued', now())
             ON CONFLICT (request_key) DO NOTHING RETURNING job_id, ref`, [q.quote_id, note || null, key, req.user.id, req.user.name]);
          if (!ins.rowCount) return { q, job: await jobFor(client, q.quote_id), duplicate: true };
          job = ins.rows[0];
        }
        // lock the material rows in one fixed order (never deadlocks with production / sales) and check them all
        const rows = (await client.query(
          `SELECT product_id, sku, name, department, unit, on_hand, unit_cost, is_archived FROM products WHERE upper(sku) = ANY($1) ORDER BY product_id FOR UPDATE`,
          [[...lines.keys()]])).rows;
        const bySku = new Map(rows.map((r) => [r.sku.toUpperCase(), r]));
        const f = {};
        for (const [sku, qty] of lines) {
          const p = bySku.get(sku);
          if (!p || p.is_archived) f['item:' + sku] = 'Not an active product';
          else if (!MATERIAL_DEPTS.includes(p.department)) f['item:' + sku] = `${p.name} is ${p.department}: only raw materials and finishing supplies are issued to a job`;
          else if (qty > +p.on_hand) f['item:' + sku] = `Only ${fmt(p.on_hand)} ${p.unit} on hand (short by ${fmt(qty - p.on_hand)})`;
        }
        if (Object.keys(f).length) {
          f.items = 'Some materials cannot be issued: ' + Object.keys(f).map((k) => k.slice(5) + ' (' + f[k] + ')').join('; ');
          throw new ValidationError(f);
        }
        let cost = 0;
        for (const [sku, qty] of lines) {
          const p = bySku.get(sku);
          const mv = await client.query(
            `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost)
             VALUES ($1,'out','production_use',$2,$3,'job_order',$4,$5,$6) RETURNING ref`,
            [p.product_id, qty, req.user.id, job.job_id, `${job.ref} — used for custom quote ${q.quote_no} (${q.product_name || 'custom item'})`, p.unit_cost]);
          await client.query(
            `INSERT INTO job_order_items (job_id, product_id, sku, name, department, unit, quantity, unit_cost, movement_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [job.job_id, p.product_id, p.sku, p.name, p.department, p.unit, qty, p.unit_cost, mv.rows[0].ref]);
          cost = round2(cost + qty * (Number(p.unit_cost) || 0));
        }
        await client.query('UPDATE job_orders SET material_cost = $2 WHERE job_id = $1', [job.job_id, cost]);
        if (!stepped) await client.query(`UPDATE quote_requests SET progress = COALESCE(progress, '[]'::jsonb) || $2::jsonb, updated_at = now() WHERE quote_id = $1`,
          [q.quote_id, JSON.stringify([{ s: 'preparing', at: Date.now(), note: `Materials issued (${job.ref})` }])]);
        await audit(client, req.user, 'Production recorded', `${job.ref} for custom quote ${q.quote_no}: ` +
          [...lines].map(([sku, qty]) => `${bySku.get(sku).name} -${fmt(qty)} ${bySku.get(sku).unit}`).join(', ') + ` — material cost ${peso(cost)}`);
        return { q, job: await jobFor(client, q.quote_id), duplicate: false, stepped };
      });
      res.status(out.duplicate ? 200 : 201).json({ ok: true, duplicate: out.duplicate, job: out.job, status: out.q.status });
      if (out.stepped && app.locals.quoteFlow) app.locals.quoteFlow.afterStep(out.stepped);
      if (!out.duplicate && app.locals.lowStock && typeof app.locals.lowStock.check === 'function')
        app.locals.lowStock.check().catch((err) => console.warn('[notify] job order low-stock:', err.message));
    }));

    // the job is done: the job order is finished and the quote moves to Ready for pickup / Out for delivery (the customer is told)
    app.post(base + '/quotes/:no/job/finish', auth(role), wrap(async (req, res) => {
      await ready;
      const note = str((req.body || {}).note);
      if (note.length > 200) throw bad('note', 'Keep the note within 200 characters');
      const flow = app.locals.quoteFlow; if (!flow) throw bad('status', 'Steps are not available right now');
      const q = await tx(async (client) => {
        const cur = await loadQuote(client, req.params.no, true);
        if (!cur) throw bad('id', 'Quote request not found');
        if (!isCustom(cur)) throw bad('status', 'A catalog product has no job order');
        const job = await jobFor(client, cur.quote_id);
        if (!job || job.status === 'draft') throw bad('status', 'Issue the materials for this job first');
        if (job.status === 'finished') throw bad('status', `${job.ref} is already finished`);
        if (cur.status !== 'preparing') throw bad('status', 'Only a quote that is being prepared can be finished');
        await client.query(`UPDATE job_orders SET status = 'finished', finished_at = now(), finished_by_name = $2 WHERE job_id = $1`, [job.jobId, req.user.name]);
        await audit(client, req.user, 'Production recorded', `${job.ref} for custom quote ${cur.quote_no} finished` + (note ? `: ${note}` : ''));
        return flow.advance(client, cur, 'ready', req.user, { note: note || `${job.ref} finished` });
      });
      res.json({ ok: true, status: q.status });
      flow.afterStep(q);
    }));
  }
};
