/* stock-count.js — physical inventory (stock count).
   Flow:  start a count  ->  the system quantities are frozen as a snapshot  ->  STAFF (cashier role) type what was really counted
          (blind: they never see the system quantity)  ->  submit  ->  items whose difference is above the variance threshold are sent
          back for a RECOUNT of only those items  ->  submit again  ->  FINANCE reviews the differences and posts.
   Who can do what:
     cashier (staff)  see the open count without system quantities or costs, enter counts, add a note, submit.
     finance          everything staff can do, plus start / schedule / cancel a count, request a recount, review and POST.
                      Only Finance can post, so the person who counted never approves their own numbers.
   Which items are counted when (when "cadence" is on):
     high-value items (stock value on hand >= high_value) and fast-moving items (>= fast_moves stock-outs in fast_days days) -> every week
     everything else (slow movers)                                                                                        -> about once a month
   Posting writes one Stock In / Stock Out line per difference (reason "Stock count correction"), so the movement log,
   audit log and reports all show it. The tables are created / upgraded automatically the first time the server starts. */

const DEPARTMENTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];
const ACTIVE = ['open', 'recount', 'submitted'];          // a count in one of these states is "in progress"; only one can exist at a time
const ACTIVE_SQL = "('open','recount','submitted')";
const MAX_RECOUNTS = 3;                                    // one item can be sent back for a recount at most this many times
const SLOW_GRACE_DAYS = 3;                                 // a slow item is "due" this many days before its month is up, so a late-posted count does not push it a whole week later
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ---------- pure rules (also used by test/stock-count-rules.test.js) ---------- */
// Is this counted line ABOVE the variance threshold?  th = { pct, value }.
//  - by percent of the system quantity (a system quantity of 0 with anything counted is always above), or
//  - by the peso value of the difference (difference x unit cost);  a limit of 0 switches that test off;
//  - both limits 0 = every difference needs a recount.
function isOver(systemQty, countedQty, unitCost, th) {
  if (countedQty === null || countedQty === undefined) return false;
  const diff = round2(Number(countedQty) - Number(systemQty));
  if (diff === 0) return false;
  const pct = Number(th.pct) || 0, val = Number(th.value) || 0;
  if (pct <= 0 && val <= 0) return true;
  return (pct > 0 && Math.abs(diff) * 100 > pct * Number(systemQty)) || (val > 0 && Math.abs(diff) * Number(unitCost) > val);
}
// The same rule as SQL (l = lines alias, c = counts alias). No division, so a system quantity of 0 cannot fail.
const overSql = (l, c) => `(${l}.counted_qty IS NOT NULL AND ${l}.counted_qty <> ${l}.system_qty AND (
    (${c}.var_pct > 0 AND abs(${l}.counted_qty - ${l}.system_qty) * 100 > ${c}.var_pct * ${l}.system_qty)
 OR (${c}.var_value > 0 AND abs(${l}.counted_qty - ${l}.system_qty) * ${l}.unit_cost > ${c}.var_value)
 OR (${c}.var_pct = 0 AND ${c}.var_value = 0)))`;
// Decide, for each product, whether it is counted weekly or monthly and whether it is due.
//  rows: { product_id, on_hand, unit_cost, moves (stock-outs in the look-back window), days_since (days since last posted count, null = never) }
//  mode 'all' = every product;  mode 'due' = weekly items + slow items that are due (never counted, or counted long enough ago)
function plan(rows, set, mode) {
  return rows.map((r) => {
    const hv = set.highValue > 0 && Number(r.on_hand) * Number(r.unit_cost) >= set.highValue;
    const fast = set.fastMoves > 0 && Number(r.moves) >= set.fastMoves;
    const cadence = hv || fast ? 'weekly' : 'monthly';
    const why = hv && fast ? 'High value, fast moving' : hv ? 'High value' : fast ? 'Fast moving' : 'Slow moving';
    const never = r.days_since === null || r.days_since === undefined;
    const due = mode !== 'due' || cadence === 'weekly' || never || Number(r.days_since) >= set.slowDays - SLOW_GRACE_DAYS;
    return { ...r, cadence, why, due };
  }).filter((r) => r.due);
}

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const isFinance = (req) => req.user.role === 'finance';

  async function ensureSchema() {
    try {
      await pool.query('CREATE SEQUENCE IF NOT EXISTS stock_count_seq START 1');
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_counts (
        count_id    BIGSERIAL PRIMARY KEY,
        count_no    TEXT UNIQUE NOT NULL DEFAULT ('SC-' || lpad(nextval('stock_count_seq')::text, 4, '0')),
        scope       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
        note        TEXT,
        created_by  INT REFERENCES users(user_id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_by   INT REFERENCES users(user_id),
        closed_at   TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_count_lines (
        line_id     BIGSERIAL PRIMARY KEY,
        count_id    BIGINT NOT NULL REFERENCES stock_counts(count_id) ON DELETE CASCADE,
        product_id  INT NOT NULL REFERENCES products(product_id),
        system_qty  NUMERIC(14,2) NOT NULL,
        counted_qty NUMERIC(14,2) CHECK (counted_qty >= 0),
        unit_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,
        note        TEXT,
        UNIQUE (count_id, product_id))`);
      // weekly schedule: the system starts a count by itself on the chosen day (see weeklyCount below)
      await pool.query('ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS scheduled BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_count_schedule (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        weekday INT NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
        scope TEXT NOT NULL DEFAULT '',
        due_days INT NOT NULL DEFAULT 2 CHECK (due_days BETWEEN 1 AND 6),
        last_run DATE,
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('INSERT INTO stock_count_schedule (id) VALUES (1) ON CONFLICT (id) DO NOTHING');

      // ---- recount / review / cadence upgrade ----
      // new states: 'recount' (flagged items are being counted again) and 'submitted' (counted, waiting for Finance to review and post)
      const hasStates = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'stock_counts_status_check' AND pg_get_constraintdef(oid) LIKE '%submitted%'`);
      if (!hasStates.rowCount) {
        await pool.query('ALTER TABLE stock_counts DROP CONSTRAINT IF EXISTS stock_counts_status_check');
        await pool.query(`ALTER TABLE stock_counts ADD CONSTRAINT stock_counts_status_check CHECK (status IN ('open','recount','submitted','posted','cancelled'))`);
      }
      await pool.query('DROP INDEX IF EXISTS uq_one_open_stock_count');
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_stock_count ON stock_counts ((1)) WHERE status IN ${ACTIVE_SQL}`);
      for (const sql of [
        // the variance threshold is copied onto the count when it starts, so changing the settings never changes a count already in progress
        'ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS var_pct NUMERIC(6,2) NOT NULL DEFAULT 5',
        'ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS var_value NUMERIC(12,2) NOT NULL DEFAULT 2000',
        'ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS recount_rounds INT NOT NULL DEFAULT 0',
        'ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS submitted_by INT REFERENCES users(user_id)',
        'ALTER TABLE stock_counts ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS first_qty NUMERIC(14,2)',            // the first count, kept when the item is sent back for a recount
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS needs_recount BOOLEAN NOT NULL DEFAULT FALSE',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS recounts INT NOT NULL DEFAULT 0',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS cadence TEXT',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS cadence_why TEXT',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS counted_by INT REFERENCES users(user_id)',
        'ALTER TABLE stock_count_lines ADD COLUMN IF NOT EXISTS counted_at TIMESTAMPTZ',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS cadence_on BOOLEAN NOT NULL DEFAULT TRUE',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS high_value NUMERIC(12,2) NOT NULL DEFAULT 50000',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS fast_moves INT NOT NULL DEFAULT 4',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS fast_days INT NOT NULL DEFAULT 30',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS slow_days INT NOT NULL DEFAULT 28',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS var_pct NUMERIC(6,2) NOT NULL DEFAULT 5',
        'ALTER TABLE stock_count_schedule ADD COLUMN IF NOT EXISTS var_value NUMERIC(12,2) NOT NULL DEFAULT 2000'
      ]) await pool.query(sql);
    } catch (err) { console.warn('[db] could not prepare the stock count tables:', err.message); }
  }
  const ready = ensureSchema();

  /* ---------- settings (one row, shared by the weekly schedule and by counts started by hand) ---------- */
  async function settings(db) {
    await ready;
    const r = (await (db || pool).query('SELECT * FROM stock_count_schedule WHERE id = 1')).rows[0] || {};
    return {
      cadenceOn: r.cadence_on !== false, highValue: r.high_value == null ? 50000 : +r.high_value, fastMoves: r.fast_moves == null ? 4 : +r.fast_moves,
      fastDays: r.fast_days || 30, slowDays: r.slow_days || 28, varPct: r.var_pct == null ? 5 : +r.var_pct, varValue: r.var_value == null ? 2000 : +r.var_value
    };
  }

  /* ---------- which products go on a new count ---------- */
  async function candidates(db, scope, set) {
    const { rows } = await db.query(
      `WITH use AS (
         SELECT product_id, COUNT(*)::int AS moves FROM stock_movements
          WHERE movement_type = 'out' AND reason <> 'count_correction_down' AND created_at >= now() - ($2 || ' days')::interval GROUP BY product_id),
       last AS (
         SELECT l.product_id, MAX(c.closed_at) AS last_counted FROM stock_count_lines l JOIN stock_counts c USING (count_id)
          WHERE c.status = 'posted' AND l.counted_qty IS NOT NULL GROUP BY l.product_id)
       SELECT p.product_id, p.on_hand, p.unit_cost, COALESCE(u.moves, 0) AS moves,
              EXTRACT(EPOCH FROM (now() - ls.last_counted)) / 86400 AS days_since
         FROM products p LEFT JOIN use u USING (product_id) LEFT JOIN last ls USING (product_id)
        WHERE NOT p.is_archived AND ($1::text = '' OR p.department = $1) ORDER BY p.product_id`, [scope, String(set.fastDays)]);
    return rows.map((r) => ({ ...r, days_since: r.days_since === null ? null : +r.days_since }));
  }
  // Creates the count and its lines inside the caller's transaction. Returns null when there is nothing to count.
  async function createCount(client, { scope, note, userId, scheduled, mode, set }) {
    const rows = plan(await candidates(client, scope, set), set, mode);
    if (!rows.length) return null;
    const c = await client.query(
      `INSERT INTO stock_counts (scope, note, created_by, scheduled, var_pct, var_value) VALUES ($1,$2,$3,$4,$5,$6) RETURNING count_id, count_no`,
      [scope || 'All departments', note || null, userId, !!scheduled, set.varPct, set.varValue]);
    await client.query(
      `INSERT INTO stock_count_lines (count_id, product_id, system_qty, unit_cost, cadence, cadence_why)
       SELECT $1, t.pid, t.qty, t.cost, t.cad, t.why FROM unnest($2::int[], $3::numeric[], $4::numeric[], $5::text[], $6::text[]) AS t(pid, qty, cost, cad, why)`,
      [c.rows[0].count_id, rows.map((r) => r.product_id), rows.map((r) => r.on_hand), rows.map((r) => r.unit_cost), rows.map((r) => r.cadence), rows.map((r) => r.why)]);
    return { id: c.rows[0].count_id, no: c.rows[0].count_no, lines: rows.length, weekly: rows.filter((r) => r.cadence === 'weekly').length, monthly: rows.filter((r) => r.cadence === 'monthly').length };
  }
  const activeCount = async (client) => (await client.query(`SELECT count_no FROM stock_counts WHERE status IN ${ACTIVE_SQL} LIMIT 1`)).rows[0];

  /* ---------- JSON shapes ---------- */
  const countJson = (c) => ({
    id: String(c.count_id), no: c.count_no, scope: c.scope, status: c.status, note: c.note || undefined, scheduled: !!c.scheduled,
    createdBy: c.created_by_name || (c.scheduled ? 'System (weekly schedule)' : '\u2014'), closedBy: c.closed_by_name || undefined, submittedBy: c.submitted_by_name || undefined,
    createdAt: new Date(c.created_at).getTime(), closedAt: c.closed_at ? new Date(c.closed_at).getTime() : undefined, submittedAt: c.submitted_at ? new Date(c.submitted_at).getTime() : undefined,
    lines: +c.lines, counted: +c.counted, differences: +c.differences, netValue: round2(+c.net_value || 0),
    varPct: +c.var_pct, varValue: +c.var_value, recountRounds: +c.recount_rounds,
    overThreshold: +c.over_threshold,            // counted lines above the threshold right now
    mustRecount: +c.must_recount,                // ... of which have not been recounted yet (these block posting)
    needRecount: +c.need_recount,                // lines waiting for staff to count them again
    unexplained: +c.unexplained                  // still above the threshold after a recount and without a note
  });
  // one query that gives every count with its totals (value of differences = qty difference x cost at the time of the count)
  const SUMMARY_SQL = `
    SELECT c.*, cu.full_name AS created_by_name, xu.full_name AS closed_by_name, su.full_name AS submitted_by_name,
           COUNT(l.line_id) AS lines,
           COUNT(l.counted_qty) AS counted,
           COUNT(*) FILTER (WHERE l.counted_qty IS NOT NULL AND l.counted_qty <> l.system_qty) AS differences,
           COALESCE(SUM((l.counted_qty - l.system_qty) * l.unit_cost) FILTER (WHERE l.counted_qty IS NOT NULL), 0) AS net_value,
           COUNT(*) FILTER (WHERE ${overSql('l', 'c')}) AS over_threshold,
           COUNT(*) FILTER (WHERE ${overSql('l', 'c')} AND l.recounts = 0) AS must_recount,
           COUNT(*) FILTER (WHERE l.needs_recount) AS need_recount,
           COUNT(*) FILTER (WHERE ${overSql('l', 'c')} AND l.recounts > 0 AND COALESCE(btrim(l.note), '') = '') AS unexplained
      FROM stock_counts c
      LEFT JOIN stock_count_lines l USING (count_id)
      LEFT JOIN users cu ON cu.user_id = c.created_by
      LEFT JOIN users xu ON xu.user_id = c.closed_by
      LEFT JOIN users su ON su.user_id = c.submitted_by`;
  const GROUP = ' GROUP BY c.count_id, cu.full_name, xu.full_name, su.full_name';

  const lineJson = (l, th) => ({
    sku: l.sku, name: l.name, unit: l.unit, department: l.department, location: l.location || '',
    systemQty: +l.system_qty, countedQty: l.counted_qty === null ? null : +l.counted_qty,
    unitCost: +l.unit_cost, note: l.note || '', onHandNow: +l.on_hand,
    cadence: l.cadence || '', why: l.cadence_why || '', firstQty: l.first_qty === null || l.first_qty === undefined ? null : +l.first_qty,
    recounts: +l.recounts, needsRecount: !!l.needs_recount, countedBy: l.counted_by_name || '',
    over: isOver(l.system_qty, l.counted_qty, l.unit_cost, th)
  });
  async function loadCount(client, id) {
    if (!/^\d+$/.test(String(id))) throw bad('id', 'Stock count not found');
    const { rows } = await client.query(SUMMARY_SQL + ' WHERE c.count_id = $1' + GROUP, [id]);
    if (!rows.length) throw bad('id', 'Stock count not found');
    return rows[0];
  }
  async function financeView(client, c) {
    const { rows } = await client.query(
      `SELECT p.sku, p.name, p.unit, p.department, p.location, p.on_hand, l.system_qty, l.counted_qty, l.unit_cost, l.note,
              l.cadence, l.cadence_why, l.first_qty, l.recounts, l.needs_recount, bu.full_name AS counted_by_name
         FROM stock_count_lines l JOIN products p USING (product_id) LEFT JOIN users bu ON bu.user_id = l.counted_by
        WHERE l.count_id = $1 ORDER BY p.department, p.name`, [c.count_id]);
    const th = { pct: +c.var_pct, value: +c.var_value };
    return { ...countJson(c), items: rows.map((r) => lineJson(r, th)) };
  }
  // What STAFF see: no system quantity, no cost, no difference. In a recount only the flagged items are listed.
  async function staffView(client, c) {
    const onlyFlagged = c.status === 'recount';
    if (c.status === 'submitted') return { id: String(c.count_id), no: c.count_no, scope: c.scope, status: c.status, note: c.note || undefined, scheduled: !!c.scheduled, createdAt: new Date(c.created_at).getTime(),
      recount: false, round: +c.recount_rounds, total: +c.lines, counted: +c.counted, items: [] };   // already handed in: nothing left for staff to do
    const { rows } = await client.query(
      `SELECT p.sku, p.name, p.unit, p.department, p.location, l.counted_qty, l.note, l.needs_recount
         FROM stock_count_lines l JOIN products p USING (product_id)
        WHERE l.count_id = $1 AND ($2::boolean = FALSE OR l.needs_recount) ORDER BY p.location NULLS LAST, p.department, p.name`, [c.count_id, onlyFlagged]);
    const items = rows.map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, department: r.department, location: r.location || '', countedQty: r.counted_qty === null ? null : +r.counted_qty, note: r.note || '' }));
    return { id: String(c.count_id), no: c.count_no, scope: c.scope, status: c.status, note: c.note || undefined, scheduled: !!c.scheduled, createdAt: new Date(c.created_at).getTime(),
      recount: onlyFlagged, round: +c.recount_rounds, total: items.length, counted: items.filter((i) => i.countedQty !== null).length, items };
  }

  /* ---------- schedule + settings ---------- */
  // (the schedule routes come before /:id so "schedule" is not read as a count id)
  app.get('/api/stock-counts/schedule', auth('finance'), wrap(async (req, res) => res.json(await schedule())));
  app.put('/api/stock-counts/schedule', auth('finance'), wrap(async (req, res) => {
    await ready;
    const b = req.body || {}, cur = await settings(), scope = str(b.scope);
    const wd = Number(b.weekday), due = Number(b.dueDays);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw bad('weekday', 'Choose the day of the week');
    if (!Number.isInteger(due) || due < 1 || due > 6) throw bad('dueDays', 'Choose 1 to 6 days to finish the count');
    if (scope && !DEPARTMENTS.includes(scope)) throw bad('scope', 'Choose a department from the list');
    // a field that is not sent keeps its current value, so an older screen cannot wipe the new settings
    const pick = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const highValue = pick(b.highValue, cur.highValue), fastMoves = pick(b.fastMoves, cur.fastMoves), fastDays = pick(b.fastDays, cur.fastDays),
      slowDays = pick(b.slowDays, cur.slowDays), varPct = pick(b.varPct, cur.varPct), varValue = pick(b.varValue, cur.varValue);
    if (!Number.isFinite(highValue) || highValue < 0 || highValue > 1e9) throw bad('highValue', 'High-value limit must be 0 or more (0 = do not use this rule)');
    if (!Number.isInteger(fastMoves) || fastMoves < 0 || fastMoves > 1000) throw bad('fastMoves', 'Fast-moving needs a whole number of stock-outs, 0 to 1000 (0 = do not use this rule)');
    if (!Number.isInteger(fastDays) || fastDays < 7 || fastDays > 180) throw bad('fastDays', 'Look back 7 to 180 days to judge how fast an item moves');
    if (!Number.isInteger(slowDays) || slowDays < 14 || slowDays > 90) throw bad('slowDays', 'Count slow items every 14 to 90 days');
    if (!Number.isFinite(varPct) || varPct < 0 || varPct > 100 || round2(varPct) !== varPct) throw bad('varPct', 'Variance percent must be 0 to 100 with at most 2 decimals (0 = do not use this rule)');
    if (!Number.isFinite(varValue) || varValue < 0 || varValue > 1e9 || round2(varValue) !== varValue) throw bad('varValue', 'Variance amount must be 0 or more with at most 2 decimals (0 = do not use this rule)');
    await pool.query(`UPDATE stock_count_schedule SET enabled = $1, weekday = $2, scope = $3, due_days = $4, cadence_on = $5, high_value = $6, fast_moves = $7, fast_days = $8,
                        slow_days = $9, var_pct = $10, var_value = $11, updated_by = $12, updated_at = now() WHERE id = 1`,
      [b.enabled !== false, wd, scope, due, b.cadenceOn !== false, highValue, fastMoves, fastDays, slowDays, varPct, varValue, req.user.id]);
    await audit(pool, req.user, 'Record edited', `Weekly stock count: ${b.enabled === false ? 'switched off' : 'every ' + DAYS[wd] + ', ' + (scope || 'all departments') + ', post within ' + due + ' day(s)'}; ` +
      `${b.cadenceOn === false ? 'every product each time' : 'weekly = stock value >= ' + highValue + ' or ' + fastMoves + '+ stock-outs in ' + fastDays + ' days, slow items every ' + slowDays + ' days'}; recount when a difference is over ${varPct}% or ${varValue}`);
    res.json(await schedule());
  }));

  /* ---------- lists, start, detail ---------- */
  app.get('/api/stock-counts', auth('finance'), wrap(async (req, res) => {
    await ready;
    const { rows } = await pool.query(SUMMARY_SQL + GROUP + ' ORDER BY c.created_at DESC LIMIT 100');
    res.json(rows.map(countJson));
  }));

  // The count that is in progress (if any). Finance gets the full sheet; staff get the blind sheet.
  app.get('/api/stock-counts/active', auth('finance', 'cashier'), wrap(async (req, res) => {
    await ready;
    const { rows } = await pool.query(SUMMARY_SQL + ` WHERE c.status IN ${ACTIVE_SQL}` + GROUP + ' LIMIT 1');
    if (!rows.length) return res.json({ count: null });
    res.json({ count: isFinance(req) ? await financeView(pool, rows[0]) : await staffView(pool, rows[0]) });
  }));

  app.post('/api/stock-counts', auth('finance'), wrap(async (req, res) => {
    await ready;
    const dept = str((req.body || {}).department), mode = str((req.body || {}).mode) || 'all';
    if (dept && !DEPARTMENTS.includes(dept)) throw bad('department', 'Choose a department from the list');
    if (!['all', 'due'].includes(mode)) throw bad('mode', 'Choose what to count');
    const note = str((req.body || {}).note).slice(0, 300);
    const set = await settings();
    const made = await tx(async (client) => {
      const open = await activeCount(client);
      if (open) throw bad('department', `Count ${open.count_no} is still in progress. Post or cancel it before starting a new one.`);
      const m = await createCount(client, { scope: dept, note, userId: req.user.id, scheduled: false, mode, set });
      if (!m) throw bad(mode === 'due' ? 'mode' : 'department', mode === 'due' ? 'Nothing is due for counting right now. Choose "All products" to count everything anyway.' : 'There are no products to count in that department');
      await audit(client, req.user, 'Record added', `Stock count ${m.no} started — ${dept || 'all departments'}, ${m.lines} product(s)` + (mode === 'due' ? ` (due items: ${m.weekly} weekly, ${m.monthly} monthly)` : ''));
      return m;
    });
    const nc = app.locals.notifications;
    if (nc) await nc.notifyRole('cashier', staffReadySpec(made, dept || 'All departments'));
    res.status(201).json({ id: String(made.id) });
  }));

  app.get('/api/stock-counts/:id', auth('finance'), wrap(async (req, res) => {
    await ready;
    res.json(await financeView(pool, await loadCount(pool, req.params.id)));
  }));

  /* ---------- entering counts: staff and Finance ---------- */
  // Save what has been counted so far (can be called many times while the count is open). Blank = not counted yet.
  // Staff: only while the count is open / in recount, and in a recount only the flagged items. Finance: any time before it is posted.
  app.put('/api/stock-counts/:id/lines', auth('finance', 'cashier'), wrap(async (req, res) => {
    await ready;
    const lines = (req.body || {}).lines;
    if (!Array.isArray(lines) || !lines.length) throw bad('lines', 'Nothing to save');
    if (lines.length > 5000) throw bad('lines', 'Too many lines in one save');
    await tx(async (client) => {
      const c = await client.query('SELECT status FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      const status = c.rows[0].status, fin = isFinance(req);
      if (!ACTIVE.includes(status)) throw bad('id', 'This count is closed and can no longer be changed');
      if (!fin && status === 'submitted') throw bad('id', 'This count was already submitted. Finance is reviewing it.');
      for (const l of lines) {
        const sku = str(l && l.sku).toUpperCase();
        if (!sku) throw bad('lines', 'Every line needs a SKU');
        let qty = null;
        if (l.countedQty !== null && l.countedQty !== undefined && l.countedQty !== '') {
          qty = Number(l.countedQty);
          if (!Number.isFinite(qty) || qty < 0 || qty > 1e8) throw bad('lines', `Counted quantity for ${sku} must be 0 or more`);
          if (round2(qty) !== qty) throw bad('lines', `Counted quantity for ${sku} can have at most 2 decimal places`);
        }
        const note = str(l.note).slice(0, 200) || null;
        const row = (await client.query(
          `SELECT l.line_id, l.needs_recount, l.counted_qty FROM stock_count_lines l JOIN products p USING (product_id) WHERE l.count_id = $1 AND upper(p.sku) = $2`, [req.params.id, sku])).rows[0];
        if (!row) throw bad('lines', `${sku} is not part of this count`);
        if (!fin && status === 'recount' && !row.needs_recount) throw bad('lines', `${sku} is not part of the recount`);
        // keep who typed it, and when, only if the number really changed (Finance's screen re-sends every line)
        const changed = (row.counted_qty === null ? null : +row.counted_qty) !== qty;
        await client.query(
          `UPDATE stock_count_lines SET counted_qty = $2, note = $3,
                  counted_by = CASE WHEN $4::boolean THEN (CASE WHEN $2::numeric IS NULL THEN NULL ELSE $5::int END) ELSE counted_by END,
                  counted_at = CASE WHEN $4::boolean THEN (CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END) ELSE counted_at END
            WHERE line_id = $1`, [row.line_id, qty, note, changed, req.user.id]);
      }
    });
    res.json({ ok: true });
  }));

  // Send the flagged lines back for a recount: the first count is kept (first_qty) and the box is emptied, so it is counted again from scratch.
  async function sendBack(client, c, flagged, user, why) {
    await client.query(
      `UPDATE stock_count_lines SET first_qty = COALESCE(first_qty, counted_qty), counted_qty = NULL, needs_recount = TRUE, recounts = recounts + 1, counted_by = NULL, counted_at = NULL
        WHERE count_id = $1 AND line_id = ANY($2::bigint[])`, [c.count_id, flagged.map((l) => l.line_id)]);
    await client.query(`UPDATE stock_counts SET status = 'recount', recount_rounds = recount_rounds + 1, submitted_by = NULL, submitted_at = NULL WHERE count_id = $1`, [c.count_id]);
    const names = flagged.slice(0, 5).map((l) => l.sku).join(', ') + (flagged.length > 5 ? ' and ' + (flagged.length - 5) + ' more' : '');
    await audit(client, user, 'Record edited', `Stock count ${c.count_no}: ${flagged.length} item(s) over the variance threshold (${c.var_pct}% or ${c.var_value}) sent back for a recount — ${names}${why ? ' (' + why + ')' : ''}`);
  }
  const linesOf = async (client, id) => (await client.query(
    `SELECT l.line_id, l.system_qty, l.counted_qty, l.unit_cost, l.note, l.needs_recount, l.recounts, p.sku, p.name, p.unit
       FROM stock_count_lines l JOIN products p USING (product_id) WHERE l.count_id = $1 ORDER BY l.line_id FOR UPDATE OF l`, [id])).rows;
  const names = (rows, n) => rows.slice(0, n || 4).map((l) => l.name).join(', ') + (rows.length > (n || 4) ? ' and ' + (rows.length - (n || 4)) + ' more' : '');

  // Submit: "I finished counting". Everything that must be counted has to be filled in.
  //   first submit  -> items over the threshold go straight back for a recount (only those items)
  //   after recount -> the count goes to Finance for review
  app.post('/api/stock-counts/:id/submit', auth('finance', 'cashier'), wrap(async (req, res) => {
    await ready;
    const out = await tx(async (client) => {
      const c = (await client.query('SELECT * FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!c) throw bad('id', 'Stock count not found');
      if (c.status === 'submitted') throw bad('id', 'This count was already submitted');
      if (!['open', 'recount'].includes(c.status)) throw bad('id', 'This count is closed');
      const lines = await linesOf(client, c.count_id);
      const pending = lines.filter((l) => (c.status === 'open' ? l.counted_qty === null : l.needs_recount && l.counted_qty === null));
      if (pending.length) throw bad('lines', `${pending.length} item(s) are not counted yet: ${names(pending)}. Enter every quantity (0 if there is none) before submitting.`);
      const th = { pct: +c.var_pct, value: +c.var_value };
      const flagged = c.status === 'open' ? lines.filter((l) => l.recounts === 0 && isOver(l.system_qty, l.counted_qty, l.unit_cost, th)) : [];
      if (flagged.length) {
        await sendBack(client, c, flagged, req.user, 'automatic');
        return { status: 'recount', recount: flagged.length, no: c.count_no, byStaff: !isFinance(req) };
      }
      await client.query('UPDATE stock_count_lines SET needs_recount = FALSE WHERE count_id = $1', [c.count_id]);
      await client.query(`UPDATE stock_counts SET status = 'submitted', submitted_by = $2, submitted_at = now() WHERE count_id = $1`, [c.count_id, req.user.id]);
      const still = lines.filter((l) => isOver(l.system_qty, l.counted_qty, l.unit_cost, th)).length;
      await audit(client, req.user, 'Record edited', `Stock count ${c.count_no} submitted for review — ${lines.filter((l) => l.counted_qty !== null).length} counted` + (still ? `, ${still} still over the variance threshold` : ''));
      return { status: 'submitted', overThreshold: still, no: c.count_no };
    });
    const nc = app.locals.notifications;
    if (nc && out.status === 'submitted') await nc.notifyRole('finance', { category: 'inventory', severity: out.overThreshold ? 'warn' : 'info', title: 'Stock count ' + out.no + ' is ready for review',
      body: out.no + ' was submitted by ' + (req.user.name || 'staff') + (out.overThreshold ? '. ' + out.overThreshold + ' item(s) are still above the variance limit after the recount \u2014 check them and add a note.' : '. Check the differences and post it.'),
      link: 'Finance_Inventory.html#stockcount', entityType: 'stock_count', entityId: out.no, dedupeKey: 'sc-submitted:' + out.no + ':' + Date.now() });
    if (nc && out.status === 'recount' && out.byStaff) await nc.notifyRole('cashier', staffRecountSpec(out.no, out.recount));
    res.json(out);
  }));

  // Finance: send items that are still above the threshold back for a recount (all of them, or just the SKUs given).
  app.post('/api/stock-counts/:id/recount', auth('finance'), wrap(async (req, res) => {
    await ready;
    const want = Array.isArray((req.body || {}).skus) ? req.body.skus.map((s) => str(s).toUpperCase()).filter(Boolean) : null;
    const out = await tx(async (client) => {
      const c = (await client.query('SELECT * FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!c) throw bad('id', 'Stock count not found');
      if (!['open', 'submitted'].includes(c.status)) throw bad('id', c.status === 'recount' ? 'A recount is already in progress' : 'This count is closed');
      const th = { pct: +c.var_pct, value: +c.var_value };
      let flagged = (await linesOf(client, c.count_id)).filter((l) => isOver(l.system_qty, l.counted_qty, l.unit_cost, th));
      if (want) flagged = flagged.filter((l) => want.includes(String(l.sku).toUpperCase()));
      if (!flagged.length) throw bad('lines', 'No counted item is above the variance threshold.');
      const eligible = flagged.filter((l) => l.recounts < MAX_RECOUNTS);
      if (!eligible.length) throw bad('lines', `These items were already recounted ${MAX_RECOUNTS} times. Check them on the shelf yourself, add a note and post.`);
      await sendBack(client, c, eligible, req.user, 'requested by Finance');
      return { status: 'recount', recount: eligible.length, no: c.count_no };
    });
    const nc = app.locals.notifications;
    if (nc) await nc.notifyRole('cashier', staffRecountSpec(out.no, out.recount));
    res.json(out);
  }));

  // Post: every counted line that differs from the snapshot becomes a Stock In / Stock Out entry.
  // The difference (counted - snapshot) is applied on top of the stock right now, so sales made while counting are not lost.
  // Only Finance posts. Items above the variance threshold must have been recounted first; if the recount is still off, the line needs a note.
  app.post('/api/stock-counts/:id/post', auth('finance'), wrap(async (req, res) => {
    await ready;
    const result = await tx(async (client) => {
      const c = await client.query('SELECT * FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      const cnt = c.rows[0];
      if (cnt.status === 'recount') throw bad('id', 'The recount is not finished yet. Staff must count the flagged items again and submit, or cancel the count.');
      if (!['open', 'submitted'].includes(cnt.status)) throw bad('id', 'This count was already closed');
      const { rows } = await client.query(
        `SELECT l.product_id, l.system_qty, l.counted_qty, l.unit_cost, l.note, l.recounts, p.sku, p.name, p.unit, p.on_hand
           FROM stock_count_lines l JOIN products p USING (product_id)
          WHERE l.count_id = $1 ORDER BY l.product_id FOR UPDATE OF p`, [req.params.id]);
      const counted = rows.filter(r => r.counted_qty !== null);
      if (!counted.length) throw bad('lines', 'Enter at least one counted quantity before posting');
      const th = { pct: +cnt.var_pct, value: +cnt.var_value };
      const over = counted.filter((r) => isOver(r.system_qty, r.counted_qty, r.unit_cost, th));
      const mustRecount = over.filter((r) => r.recounts === 0);
      if (mustRecount.length) throw bad('lines', `${mustRecount.length} item(s) are above the variance limit (${+cnt.var_pct}% or ₱${+cnt.var_value}) and must be recounted before posting: ${names(mustRecount)}.`);
      const unexplained = over.filter((r) => !String(r.note || '').trim());
      if (unexplained.length) throw bad('lines', `${unexplained.length} item(s) are still above the variance limit after the recount. Add a note explaining each one before posting: ${names(unexplained)}.`);
      let up = 0, down = 0, net = 0;
      const changes = counted.map(r => ({ ...r, diff: round2(+r.counted_qty - +r.system_qty) })).filter(r => r.diff !== 0);
      for (const r of changes)      // check everything first so nothing is half-posted
        if (r.diff < 0 && +r.on_hand < -r.diff)
          throw bad('lines', `${r.name}: the count is ${-r.diff} ${r.unit} lower than the system, but only ${+r.on_hand} ${r.unit} is on hand now. Recount it or check recent sales.`);
      for (const r of changes) {
        const isUp = r.diff > 0;
        await client.query(
          `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, note, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [r.product_id, isUp ? 'in' : 'out', isUp ? 'count_correction_up' : 'count_correction_down', Math.abs(r.diff), req.user.id,
           `Stock count ${cnt.count_no}: counted ${+r.counted_qty}, system had ${+r.system_qty}` + (r.note ? ` — ${r.note}` : ''), +r.unit_cost]);   // cost saved when the count started
        isUp ? up++ : down++; net += r.diff * +r.unit_cost;
      }
      await client.query(`UPDATE stock_counts SET status = 'posted', closed_by = $2, closed_at = now() WHERE count_id = $1`, [req.params.id, req.user.id]);
      await audit(client, req.user, 'Record edited',
        `Stock count ${cnt.count_no} posted — ${counted.length} counted, ${up} increased, ${down} decreased, net value ${round2(net)}` + (over.length ? `, ${over.length} accepted above the variance limit after recount` : ''));
      return { no: cnt.count_no, counted: counted.length, increased: up, decreased: down, unchanged: counted.length - changes.length, netValue: round2(net) };
    });
    res.json(result);
  }));

  app.post('/api/stock-counts/:id/cancel', auth('finance'), wrap(async (req, res) => {
    await ready;
    await tx(async (client) => {
      const c = await client.query('SELECT count_no, status FROM stock_counts WHERE count_id = $1 FOR UPDATE', [req.params.id]);
      if (!c.rowCount) throw bad('id', 'Stock count not found');
      if (!ACTIVE.includes(c.rows[0].status)) throw bad('id', 'Only a count in progress can be cancelled');
      await client.query(`UPDATE stock_counts SET status = 'cancelled', closed_by = $2, closed_at = now() WHERE count_id = $1`, [req.params.id, req.user.id]);
      await audit(client, req.user, 'Record edited', `Stock count ${c.rows[0].count_no} cancelled — no stock was changed`);
    });
    res.json({ ok: true });
  }));

  /* ---------- notification texts ---------- */
  function staffReadySpec(m, scopeLabel) {
    return { category: 'inventory', severity: 'info', title: 'Stock count ' + m.no + ' is ready to count',
      body: m.lines + ' item(s) to count (' + scopeLabel + (m.monthly ? ': ' + m.weekly + ' weekly, ' + m.monthly + ' monthly' : '') + '). Open Stock Count, enter what is on the shelf and submit it.',
      link: 'POS_Cashier.html#stockcount', entityType: 'stock_count', entityId: m.no, dedupeKey: 'sc-staff-start:' + m.no };
  }
  function staffRecountSpec(no, n) {
    return { category: 'inventory', severity: 'warn', title: 'Recount needed for ' + no,
      body: n + ' item(s) did not match closely enough. Count only those items again, from scratch, and submit.',
      link: 'POS_Cashier.html#stockcount', entityType: 'stock_count', entityId: no, dedupeKey: 'sc-recount:' + no + ':' + Date.now() };
  }

  /* ---------- weekly scheduled count ----------
     Every week on the chosen day (Monday by default), once the store opens (BUSINESS_OPEN, 8:00 AM), the automation starts a
     count, so nobody has to remember. With cadence on, the count lists the weekly items (high-value and fast-moving) and the slow items
     that are due this month. Finance and the staff are told it is ready; Finance (and staff, if still counting) are reminded if it is not
     posted within due_days; Finance is told if last week's count is still in progress on count day (then no second count is started). */
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const OPEN_MIN = (() => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.BUSINESS_OPEN || '')); return m ? +m[1] * 60 + +m[2] : 8 * 60; })();
  const tz = TZ || 'Asia/Manila';
  function today() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { date: p.year + '-' + p.month + '-' + p.day, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), minutes: (+p.hour % 24) * 60 + +p.minute };
  }
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  async function schedule(db) {
    await ready;
    // last_run as text: a DATE read as a JS Date shifts a day with the server time zone
    const r = (await (db || pool).query(`SELECT s.*, s.last_run::text AS last_run, u.full_name AS updated_by_name FROM stock_count_schedule s LEFT JOIN users u ON u.user_id = s.updated_by WHERE id = 1`)).rows[0] || {};
    const t = today(), set = await settings(db);
    let ahead = ((r.weekday == null ? 1 : r.weekday) - t.weekday + 7) % 7;
    const ranToday = r.last_run && String(r.last_run instanceof Date ? r.last_run.toISOString().slice(0, 10) : r.last_run).slice(0, 10) === t.date;
    if (ahead === 0 && (ranToday || t.minutes >= OPEN_MIN + 24 * 60)) ahead = 7;
    return { enabled: r.enabled !== false, weekday: r.weekday == null ? 1 : r.weekday, day: DAYS[r.weekday == null ? 1 : r.weekday],
      scope: r.scope || '', scopeLabel: r.scope || 'All departments', dueDays: r.due_days || 2,
      lastRun: r.last_run ? String(r.last_run instanceof Date ? r.last_run.toISOString().slice(0, 10) : r.last_run).slice(0, 10) : null,
      nextRun: r.enabled === false ? null : (ahead === 0 && ranToday ? addDays(t.date, 7) : addDays(t.date, ahead)),
      startsAt: OPEN_MIN, updatedBy: r.updated_by_name || null, ...set };
  }
  async function weeklyCount() {
    await ready;
    const nc = app.locals.notifications, out = { started: null, reminded: 0 };
    const s = await schedule(), t = today();
    // reminder: a scheduled count still in progress after its due days (Finance always; staff while they still have to count)
    const late = (await pool.query(`SELECT count_id, count_no, status, created_at FROM stock_counts WHERE status IN ${ACTIVE_SQL} AND scheduled
                                      AND created_at < now() - ($1 || ' days')::interval`, [String(s.dueDays)])).rows;
    for (const c of late) if (nc) {
      const since = new Date(c.created_at).toLocaleDateString('en-PH', { timeZone: tz, month: 'short', day: 'numeric' });
      out.reminded += await nc.notifyRole('finance', { category: 'inventory', severity: 'warn', title: 'Weekly stock count ' + c.count_no + ' is overdue',
        body: c.count_no + ' was started on ' + since + ' and is not posted yet. ' + (c.status === 'submitted' ? 'It is waiting for your review.' : 'Staff still have to finish counting' + (c.status === 'recount' ? ' the recount' : '') + ', then you review and post it.'),
        link: 'Finance_Inventory.html#stockcount', entityType: 'stock_count', entityId: c.count_no, dedupeKey: 'sc-late:' + c.count_id + ':' + t.date });
      if (c.status !== 'submitted') out.reminded += await nc.notifyRole('cashier', { category: 'inventory', severity: 'warn', title: 'Stock count ' + c.count_no + ' is overdue',
        body: 'Please finish counting ' + c.count_no + ' and submit it.', link: 'POS_Cashier.html#stockcount', entityType: 'stock_count', entityId: c.count_no, dedupeKey: 'sc-late-staff:' + c.count_id + ':' + t.date });
    }
    if (!s.enabled || t.weekday !== s.weekday || t.minutes < OPEN_MIN || s.lastRun === t.date) return out;
    const res = await tx(async (client) => {
      const lock = await client.query('UPDATE stock_count_schedule SET last_run = $1 WHERE id = 1 AND (last_run IS DISTINCT FROM $1::date) RETURNING id', [t.date]);
      if (!lock.rowCount) return null;                                    // another server already did it today
      const open = await activeCount(client);
      if (open) return { blocked: open.count_no };
      const m = await createCount(client, { scope: s.scope, note: 'Weekly scheduled count (' + DAYS[s.weekday] + ')', userId: null, scheduled: true, mode: s.cadenceOn ? 'due' : 'all', set: s });
      if (!m) return { empty: true };
      await audit(client, { id: null, name: 'System', role: 'system' }, 'Record added',
        `Stock count ${m.no} started automatically (weekly schedule) — ${s.scopeLabel}, ${m.lines} product(s)` + (s.cadenceOn ? ` (${m.weekly} weekly, ${m.monthly} monthly)` : ''));
      return m;
    });
    if (!res) return out;
    if (nc && res.no) {
      await nc.notifyRole('finance', { category: 'inventory', severity: 'info', title: 'Weekly stock count ' + res.no + ' is ready',
        body: 'Today is count day. ' + res.no + ' lists ' + res.lines + ' product(s) (' + s.scopeLabel + (s.cadenceOn ? ': ' + res.weekly + ' weekly, ' + res.monthly + ' monthly' : '') + '). Staff count the shelves; you review and post it within ' + s.dueDays + ' day(s).',
        link: 'Finance_Inventory.html#stockcount', entityType: 'stock_count', entityId: res.no, dedupeKey: 'sc-start:' + res.no });
      await nc.notifyRole('cashier', staffReadySpec(res, s.scopeLabel));
    }
    if (nc && res.blocked) await nc.notifyRole('finance', { category: 'inventory', severity: 'warn', title: 'Count day, but ' + res.blocked + ' is still in progress',
      body: 'The weekly stock count could not start because ' + res.blocked + ' is not posted yet. Post or cancel it, then start a new count.',
      link: 'Finance_Inventory.html#stockcount', entityType: 'stock_count', entityId: res.blocked, dedupeKey: 'sc-blocked:' + t.date });
    out.started = res.no || null; out.blocked = res.blocked || null;
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'weekly-stock-count', run: weeklyCount });
};
module.exports.isOver = isOver;
module.exports.overSql = overSql;
module.exports.plan = plan;
