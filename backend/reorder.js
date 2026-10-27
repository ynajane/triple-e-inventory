/* reorder.js — automatic reorder level.

   Reorder level = average daily use  x  (lead-time days + safety days)

   • Average daily use = what left stock through sales, online orders and "Used in production" over the last
     REORDER_LOOKBACK_DAYS (or since the product's first stock record, if it is newer than that).
     Damaged / lost / returned-to-supplier / count corrections are NOT use, so they do not raise the level.
   • A product needs at least REORDER_MIN_HISTORY_DAYS of history first. Until then its level is left as it is
     (0 for a brand-new product) and the form says so. "Set manually" on the product form switches this off for that product.
   • Recalculated when the server starts, every 6 hours, and when a product is saved.

   Lead time: the main (primary) supplier's own lead time (Supplier Management > Lead time) when it has one, otherwise REORDER_LEAD_DAYS.
   .env (all optional):  REORDER_LEAD_DAYS=7  REORDER_SAFETY_DAYS=3  REORDER_LOOKBACK_DAYS=90  REORDER_MIN_HISTORY_DAYS=14
   The two new product columns are created automatically when the server starts (backend/db/014_reorder_auto.sql is the same thing for running by hand).
   Products that already exist keep reorder_auto = FALSE, so their current levels do not change until someone edits them and unticks "Set manually". */
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
const USE_REASONS = ['sale', 'online_order', 'production_use'];

module.exports = function makeReorder({ pool }) {
  const LEAD = num(process.env.REORDER_LEAD_DAYS, 7);
  const SAFETY = num(process.env.REORDER_SAFETY_DAYS, 3);
  const LOOKBACK = Math.max(1, num(process.env.REORDER_LOOKBACK_DAYS, 90));
  const MIN_HISTORY = Math.max(1, num(process.env.REORDER_MIN_HISTORY_DAYS, 14));
  const settings = { leadDays: LEAD, safetyDays: SAFETY, lookbackDays: LOOKBACK, minHistoryDays: MIN_HISTORY };

  const ready = (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_auto BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_basis TEXT');
      await pool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INT CHECK (lead_time_days BETWEEN 0 AND 365)');   // per-supplier lead time
    } catch (err) { console.warn('[db] could not prepare the reorder columns:', err.message); }
  })();

  const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });

  // `db` = a pool or a transaction client. `sku` = only that product (otherwise every automatic product).
  async function recalc(db, sku) {
    await ready;
    const { rows } = await db.query(
      `SELECT p.product_id, p.unit,
              (SELECT s.lead_time_days FROM product_suppliers ps JOIN suppliers s USING (supplier_id)
                WHERE ps.product_id = p.product_id AND ps.is_primary AND s.status = 'active' LIMIT 1) AS supplier_lead,
              (SELECT min(m.created_at) FROM stock_movements m WHERE m.product_id = p.product_id) AS first_mv,
              COALESCE((SELECT sum(m.quantity) FROM stock_movements m
                         WHERE m.product_id = p.product_id AND m.movement_type = 'out' AND m.reason = ANY($1)
                           AND m.created_at >= now() - ($2::int * interval '1 day')), 0) AS used,
              EXTRACT(EPOCH FROM (now() - (SELECT min(m.created_at) FROM stock_movements m WHERE m.product_id = p.product_id))) / 86400 AS age_days
         FROM products p
        WHERE p.reorder_auto AND NOT p.is_archived AND ($3::text IS NULL OR p.sku = $3)`,
      [USE_REASONS, LOOKBACK, sku || null]);
    for (const r of rows) {
      const days = r.first_mv ? Math.min(LOOKBACK, Number(r.age_days)) : 0;
      if (days < MIN_HISTORY) {
        await db.query('UPDATE products SET reorder_basis = $2 WHERE product_id = $1 AND reorder_auto',
          [r.product_id, `Not enough usage history yet (needs ${MIN_HISTORY} days). The level stays as it is until then. Tick "Set manually" to enter one now.`]);
        continue;
      }
      const lead = r.supplier_lead == null ? LEAD : Number(r.supplier_lead);
      const used = Number(r.used), daily = used / days, cover = lead + SAFETY;
      const level = Math.ceil(daily * cover * 100) / 100;
      const basis = used > 0
        ? `Average use ${fmt(daily)} ${r.unit}/day over the last ${Math.round(days)} days × ${cover} days (${lead} lead time${r.supplier_lead == null ? '' : ' from the main supplier'} + ${SAFETY} safety) = ${fmt(level)} ${r.unit}`
        : `No use recorded in the last ${Math.round(days)} days, so the level is 0.`;
      await db.query('UPDATE products SET reorder_level = $2, reorder_basis = $3 WHERE product_id = $1 AND reorder_auto', [r.product_id, level, basis]);
    }
  }

  let timer = null;
  function start() {
    if (timer) return;
    const run = () => recalc(pool).catch((e) => console.warn('[reorder] recalculation failed:', e.message));
    run();
    timer = setInterval(run, 6 * 3600 * 1000);
    if (timer.unref) timer.unref();
  }

  return { ready, recalc, start, settings };
};
