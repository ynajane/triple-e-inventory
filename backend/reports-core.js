'use strict';
/* reports-core.js — every figure on the Finance Reports screens is worked out here, in SQL, on the server.

   The browser only prints what comes back. Nothing here is hardcoded: each number is a query over the real
   tables (pos_sales, orders, payments, stock_movements, quote_requests, ...).

   The queries are written once and run in two dialects:
     PG    production PostgreSQL (what reports.js uses)
     LITE  SQLite, used by test/reports.test.js so the SAME query text can be checked against hand-worked sample
           records in an environment without a Postgres server. The only differences are the date/time helpers
           and GREATEST/LEAST, all of them isolated in the two dialect objects below.

   DEFINITIONS (shown to the user in the Reports screen as "What counts"):
   - Realized sale: a POS sale that is not voided, or an online order that is not cancelled AND fully paid.
     A Cash-on-Delivery order is "Paid" in the fulfilment flow when confirmed, but the cash is only collected at
     handover, so it is NOT realized until payment_status becomes 'paid' (or the ledger shows it fully paid).
   - Date of a sale: POS = the sale time; online = orders.paid_at (when the money arrived), else created_at.
     All days are Philippine days (Asia/Manila, UTC+8, no daylight saving).
   - Refunds/returns are deducted from the sale they belong to, so net sales and the product ranking agree.
   - Money collected on an order = the larger of (ledger payments in) and (legacy invoice flag => full total).
     Using the larger, never the sum, is what stops an order that exists in both records being counted twice.
   - A quotation is never a sale. Its money is counted once, on the order or POS invoice it becomes.        */

const MAX_DAYS = 1100;
const TZ_NAME = 'Asia/Manila';

/* ---------------------------------------------------------------- dialects */
const PG = {
  name: 'pg',
  day: (c) => `((${c}) AT TIME ZONE '${TZ_NAME}')::date::text`,
  between: (c, f, t) => `((${c}) >= ((${f}::date)::timestamp AT TIME ZONE '${TZ_NAME}') AND (${c}) < (((${t}::date + 1))::timestamp AT TIME ZONE '${TZ_NAME}'))`,
  greatest: (...a) => `GREATEST(${a.join(', ')})`,
  least: (...a) => `LEAST(${a.join(', ')})`
};
const LITE = {
  name: 'lite',
  day: (c) => `date(${c}, '+8 hours')`,
  between: (c, f, t) => `(date(${c}, '+8 hours') BETWEEN ${f} AND ${t})`,
  greatest: (...a) => `MAX(${a.join(', ')})`,
  least: (...a) => `MIN(${a.join(', ')})`
};

/* ---------------------------------------------------------------- small helpers */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;
const parseYmd = (s) => { const p = String(s).split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
const fmtYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => fmtYmd(parseYmd(s) + n * 86400000);
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const todayPH = (now) => new Date((now || new Date()).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const weekStart = (s) => addDays(s, -((new Date(parseYmd(s)).getUTCDay() + 6) % 7));   // Monday
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const autoGrain = (from, to) => { const n = daysBetween(from, to) + 1; return n <= 45 ? 'day' : n <= 180 ? 'week' : n <= 800 ? 'month' : 'year'; };
const bucketKey = (day, grain) => (grain === 'day' ? day : grain === 'week' ? weekStart(day) : grain === 'month' ? day.slice(0, 7) : day.slice(0, 4));
const nextBucket = (k, grain) => {
  if (grain === 'day') return addDays(k, 1);
  if (grain === 'week') return addDays(k, 7);
  if (grain === 'month') { const y = +k.slice(0, 4), m = +k.slice(5, 7); return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0'); }
  return String(+k + 1);
};
const bucketLabel = (k, grain) => {
  if (grain === 'day') return MON[+k.slice(5, 7) - 1] + ' ' + (+k.slice(8, 10));
  if (grain === 'week') return 'Wk of ' + MON[+k.slice(5, 7) - 1] + ' ' + (+k.slice(8, 10));
  if (grain === 'month') return MON[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);
  return k;
};
function bucketList(from, to, grain) {
  const out = [], last = bucketKey(to, grain);
  for (let k = bucketKey(from, grain); k <= last && out.length < 2000; k = nextBucket(k, grain)) out.push(k);
  return out;
}
const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

/* ledger rows that only move a payment from a quotation to the order it became (no money arrived) */
const NOT_A_MOVE = `(p.request_id IS NULL OR (p.request_id NOT LIKE 'transfer:%' AND p.request_id NOT LIKE 'transfer-in:%'))`;

/* ---------------------------------------------------------------- the shared transaction view
   tx has one row per POS sale and per online order, with the realized/unrealized class worked out once, so the
   sales overview, the product ranking and the payment report can never disagree about what a "sale" is.
   cls: realized | voided (POS) | cancelled (online) | partial | unpaid                                            */
function txCtes(dx, o) {
  const hasLedger = o.hasLedger !== false, hasPaidAt = o.hasPaidAt !== false;
  const paidTs = hasPaidAt ? 'COALESCE(o.paid_at, o.created_at)' : 'o.created_at';
  const ledIn = hasLedger ? `COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.order_id AND p.direction = 'in'), 0)` : '0';
  const ledRef = hasLedger ? `COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.order_id AND p.direction = 'out' AND p.purpose = 'refund'), 0)` : '0';
  return `
  pos_tx AS (
    SELECT 'POS' AS channel, s.sale_id AS src_id, s.receipt_no AS ref, s.created_at AS ts, s.method AS method,
           CASE WHEN s.status = 'Voided' THEN 'voided' ELSE 'realized' END AS cls, s.status AS raw_status,
           s.total AS total, COALESCE(s.delivery_fee, 0) AS delivery_fee,
           COALESCE((SELECT SUM(r.amount) FROM pos_return_requests r WHERE r.sale_id = s.sale_id AND r.status = 'approved'), 0) AS refunded,
           s.total AS collected, s.created_at AS placed_at
      FROM pos_sales s
  ),
  ord_money AS (
    SELECT o.order_id, ${ledIn} AS led_in, ${ledRef} AS led_refund,
           COALESCE((SELECT SUM(r.amount) FROM order_refund_requests r WHERE r.order_id = o.order_id AND r.status = 'approved'), 0) AS req_refund
      FROM orders o
  ),
  ord_base AS (
    SELECT 'Online' AS channel, o.order_id AS src_id, o.order_no AS ref, o.payment_method AS method, o.status AS raw_status,
           o.total AS total, COALESCE(o.delivery_fee, 0) AS delivery_fee, o.created_at AS placed_at, ${paidTs} AS paid_ts,
           ${dx.greatest('m.led_in', `CASE WHEN o.payment_status = 'paid' THEN o.total ELSE 0 END`)} AS collected,
           ${dx.greatest('m.led_refund', 'm.req_refund')} AS refund_any, m.led_in AS led_in
      FROM orders o JOIN ord_money m ON m.order_id = o.order_id
  ),
  ord_tx AS (
    SELECT b.channel, b.src_id, b.ref, b.method, b.raw_status, b.total, b.delivery_fee, b.placed_at, b.paid_ts, b.collected, b.led_in,
           ${dx.least('b.refund_any', 'b.collected')} AS refunded,
           CASE WHEN b.raw_status = 'Cancelled' THEN 'cancelled'
                WHEN b.total > 0 AND b.collected >= b.total - 0.005 THEN 'realized'
                WHEN b.collected > 0.004 THEN 'partial'
                ELSE 'unpaid' END AS cls
      FROM ord_base b
  ),
  tx AS (
    SELECT channel, src_id, ref, ts, method, cls, raw_status, total, delivery_fee, refunded, collected, placed_at FROM pos_tx
    UNION ALL
    SELECT channel, src_id, ref, CASE WHEN cls = 'realized' THEN paid_ts ELSE placed_at END, method, cls, raw_status, total, delivery_fee, refunded, collected, placed_at FROM ord_tx
  )`;
}

/* ================================================================ 1. SALES OVERVIEW */
const foldSales = (rows) => {
  const blank = () => ({ count: 0, gross: 0, refunds: 0, net: 0, deliveryFees: 0, voidPending: 0 });
  const ch = { POS: blank(), Online: blank() }, status = [];
  for (const r of rows) {
    const c = ch[r.channel]; if (!c) continue;
    if (r.cls === 'realized') {
      c.count += num(r.n); c.gross = r2(c.gross + num(r.total)); c.refunds = r2(c.refunds + num(r.refunded));
      c.deliveryFees = r2(c.deliveryFees + num(r.delivery_fee)); c.voidPending += num(r.void_pending);
    }
    status.push({ channel: r.channel, cls: r.cls, count: num(r.n), amount: r2(num(r.total)), collected: r2(num(r.collected)) });
  }
  for (const k of Object.keys(ch)) ch[k].net = r2(ch[k].gross - ch[k].refunds);
  const all = blank();
  for (const k of Object.keys(ch)) for (const f of ['count', 'gross', 'refunds', 'net', 'deliveryFees']) all[f] = r2(all[f] + ch[k][f]);
  all.avgSale = all.count ? r2(all.net / all.count) : 0;
  return { channels: ch, all, status };
};

async function salesOverview(q, dx, p, o = {}) {
  const { from, to } = p, grain = p.grain || autoGrain(from, to);
  const span = daysBetween(from, to) + 1, pFrom = addDays(from, -span), pTo = addDays(from, -1);
  const W = `WITH ${txCtes(dx, o)}`;
  const sumSql = `${W} SELECT channel, cls, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(refunded), 0) AS refunded,
       COALESCE(SUM(delivery_fee), 0) AS delivery_fee, COALESCE(SUM(collected), 0) AS collected,
       COALESCE(SUM(CASE WHEN raw_status = 'Void Pending' THEN 1 ELSE 0 END), 0) AS void_pending
     FROM tx WHERE ${dx.between('ts', '$1', '$2')} GROUP BY channel, cls`;
  const trendSql = `${W} SELECT ${dx.day('ts')} AS day, channel, COUNT(*) AS n, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(refunded), 0) AS refunded
     FROM tx WHERE cls = 'realized' AND ${dx.between('ts', '$1', '$2')} GROUP BY ${dx.day('ts')}, channel`;
  const methodSql = `${W} SELECT channel, method, COUNT(*) AS n, COALESCE(SUM(total), 0) AS gross, COALESCE(SUM(refunded), 0) AS refunded
     FROM tx WHERE cls = 'realized' AND ${dx.between('ts', '$1', '$2')} GROUP BY channel, method ORDER BY channel, method`;
  const quoteSql = o.hasLedger === false ? null : `SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0) AS net, COUNT(DISTINCT q.quote_id) AS quotes
     FROM payments p JOIN quote_requests q ON q.quote_id = p.quote_id
    WHERE p.paid_for = 'quote' AND q.converted_order_id IS NULL AND q.handover_sale_id IS NULL AND ${NOT_A_MOVE} AND ${dx.between('p.created_at', '$1', '$2')}`;
  // cash orders cancelled because the customer did not show: the delivery fee / down payment paid online was kept (not refunded)
  const keptSql = o.hasForfeit ? `SELECT COALESCE(SUM(forfeited_amount), 0) AS kept, COUNT(*) AS n FROM orders WHERE forfeited_amount > 0 AND ${dx.between('status_updated_at', '$1', '$2')}` : null;
  const [cur, prev, trend, methods, quote, kept] = await Promise.all([
    q(sumSql, [from, to]), q(sumSql, [pFrom, pTo]), q(trendSql, [from, to]), q(methodSql, [from, to]), quoteSql ? q(quoteSql, [from, to]) : Promise.resolve([{ net: 0, quotes: 0 }]),
    keptSql ? q(keptSql, [from, to]) : Promise.resolve([{ kept: 0, n: 0 }])]);
  const c = foldSales(cur), pv = foldSales(prev);

  const keys = bucketList(from, to, grain), idx = new Map(keys.map((k, i) => [k, i]));
  const buckets = keys.map((k) => ({ key: k, label: bucketLabel(k, grain), pos: 0, online: 0, net: 0, count: 0 }));
  for (const r of trend) {
    const b = buckets[idx.get(bucketKey(r.day, grain))]; if (!b) continue;
    const net = num(r.gross) - num(r.refunded);
    if (r.channel === 'POS') b.pos = r2(b.pos + net); else b.online = r2(b.online + net);
    b.net = r2(b.net + net); b.count += num(r.n);
  }
  const labelOf = { realized: { POS: 'Completed', Online: 'Paid' }, voided: { POS: 'Voided' }, cancelled: { Online: 'Cancelled' }, partial: { Online: 'Partly paid' }, unpaid: { Online: 'Unpaid' } };
  const statuses = c.status.map((s) => ({ ...s, label: (labelOf[s.cls] || {})[s.channel] || s.cls }));
  const bucketOf = (cls) => (cls === 'realized' ? 'completed' : (cls === 'voided' || cls === 'cancelled') ? 'cancelled' : 'pending');
  const outcome = { completed: { count: 0, amount: 0 }, cancelled: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 } };
  for (const s of statuses) { const b = outcome[bucketOf(s.cls)]; b.count += s.count; b.amount = r2(b.amount + s.amount); }
  const decided = outcome.completed.count + outcome.cancelled.count;
  outcome.cancellationRate = decided ? r2(outcome.cancelled.count / decided * 100) : 0;
  const pct = (a, b) => (b ? r2((a - b) / b * 100) : null);
  return {
    range: { from, to, days: span, grain, previous: { from: pFrom, to: pTo } },
    kpis: { grossSales: c.all.gross, refunds: c.all.refunds, netSales: c.all.net, transactions: c.all.count, avgSale: c.all.avgSale,
      deliveryFees: c.all.deliveryFees, productSales: r2(c.all.net - c.all.deliveryFees),
      previousNetSales: pv.all.net, netSalesChangePct: pct(c.all.net, pv.all.net), previousTransactions: pv.all.count },
    channels: [{ channel: 'POS', ...c.channels.POS }, { channel: 'Online', ...c.channels.Online }],
    statuses, outcome,
    methods: methods.map((m) => ({ channel: m.channel, method: m.method, count: num(m.n), gross: r2(num(m.gross)), refunds: r2(num(m.refunded)), net: r2(num(m.gross) - num(m.refunded)) })),
    trend: buckets,
    customQuotes: { received: r2(num((quote[0] || {}).net)), quotes: num((quote[0] || {}).quotes) },
    keptAdvances: { amount: r2(num((kept[0] || {}).kept)), orders: num((kept[0] || {}).n) }
  };
}

/* ================================================================ 2. TOP-SELLING PRODUCTS */
async function topProducts(q, dx, p, o = {}) {
  const { from, to } = p, channel = ['pos', 'online'].includes(p.channel) ? p.channel : 'all';
  const sort = p.sort === 'units' ? 'units' : 'revenue', limit = Math.min(Math.max(parseInt(p.limit, 10) || 20, 1), 200);
  const sql = `WITH ${txCtes(dx, o)},
  pos_items AS (
    SELECT 'POS' AS channel, i.sale_id AS src_id, i.sku, i.name, i.unit, i.qty, ROUND(i.qty * i.price, 2) AS line_amount,
           COALESCE(i.unit_cost, (SELECT p.unit_cost FROM products p WHERE p.sku = i.sku)) AS unit_cost,
           COALESCE((SELECT SUM(ri.qty) FROM pos_return_items ri JOIN pos_return_requests r ON r.return_id = ri.return_id
                      WHERE ri.sale_item_id = i.item_id AND r.status = 'approved'), 0) AS ret_qty,
           COALESCE((SELECT SUM(ri.amount) FROM pos_return_items ri JOIN pos_return_requests r ON r.return_id = ri.return_id
                      WHERE ri.sale_item_id = i.item_id AND r.status = 'approved'), 0) AS ret_amount
      FROM pos_sale_items i
  ),
  ord_items AS (
    SELECT 'Online' AS channel, i.order_id AS src_id, i.sku, i.name, i.unit, i.qty, ROUND(i.qty * i.price, 2) AS line_amount,
           COALESCE(i.unit_cost, (SELECT p.unit_cost FROM products p WHERE p.sku = i.sku)) AS unit_cost, 0 AS ret_qty, 0 AS ret_amount
      FROM order_items i
  ),
  lines AS (
    SELECT it.channel, it.src_id, it.sku, it.name, it.unit, it.unit_cost,
           CASE WHEN it.channel = 'POS' THEN it.qty - it.ret_qty
                WHEN t.total > 0 AND (t.refunded * 1.0 / t.total) >= 0.995 THEN 0 ELSE it.qty END AS units_net,
           CASE WHEN it.channel = 'POS' THEN it.line_amount - it.ret_amount
                WHEN t.total > 0 THEN it.line_amount * (1 - (t.refunded * 1.0 / t.total)) ELSE it.line_amount END AS rev_net
      FROM (SELECT * FROM pos_items UNION ALL SELECT * FROM ord_items) it
      JOIN tx t ON t.channel = it.channel AND t.src_id = it.src_id
     WHERE t.cls = 'realized' AND ${dx.between('t.ts', '$1', '$2')}${channel === 'all' ? '' : ` AND it.channel = '${channel === 'pos' ? 'POS' : 'Online'}'`}
  )
  SELECT l.sku, MAX(l.name) AS name, MAX(l.unit) AS unit, MAX(pr.department) AS department, MAX(pr.unit_cost) AS unit_cost,
         SUM(l.units_net * COALESCE(l.unit_cost, 0)) AS cost, MAX(CASE WHEN COALESCE(l.unit_cost, 0) > 0 THEN 1 ELSE 0 END) AS has_cost,
         SUM(l.units_net) AS units, SUM(l.rev_net) AS revenue,
         SUM(CASE WHEN l.channel = 'POS' THEN l.units_net ELSE 0 END) AS pos_units, SUM(CASE WHEN l.channel = 'POS' THEN l.rev_net ELSE 0 END) AS pos_revenue,
         SUM(CASE WHEN l.channel = 'Online' THEN l.units_net ELSE 0 END) AS online_units, SUM(CASE WHEN l.channel = 'Online' THEN l.rev_net ELSE 0 END) AS online_revenue,
         COUNT(DISTINCT l.channel || ':' || l.src_id) AS transactions
    FROM lines l LEFT JOIN products pr ON pr.sku = l.sku
   GROUP BY l.sku HAVING SUM(l.units_net) > 0`;
  const rows = (await q(sql, [from, to])).map((r) => {
    const units = num(r.units), rev = num(r.revenue);
    return { sku: r.sku, name: r.name, unit: r.unit, department: r.department || null, units: r2(units), revenue: r2(rev),
      posUnits: r2(num(r.pos_units)), posRevenue: r2(num(r.pos_revenue)), onlineUnits: r2(num(r.online_units)), onlineRevenue: r2(num(r.online_revenue)),
      transactions: num(r.transactions), avgPrice: units ? r2(rev / units) : 0,
      estProfit: num(r.has_cost) > 0 ? r2(rev - num(r.cost)) : null };   // cost saved on each sale line; null = no cost recorded (a 0 cost would show a false 100% margin)   // null = no cost recorded (a 0 cost would show a false 100% margin)
  });
  rows.sort((a, b) => (sort === 'units' ? b.units - a.units || b.revenue - a.revenue : b.revenue - a.revenue || b.units - a.units) || String(a.sku || '').localeCompare(String(b.sku || '')));
  const totalRev = r2(rows.reduce((n, r) => n + r.revenue, 0)), totalUnits = r2(rows.reduce((n, r) => n + r.units, 0));
  rows.forEach((r, i) => { r.rank = i + 1; r.sharePct = totalRev ? r2(r.revenue / totalRev * 100) : 0; });
  return { range: { from, to }, channel, sort, totals: { products: rows.length, revenue: totalRev, units: totalUnits }, rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/* ================================================================ 3. LOW-STOCK
   Read-only. It uses the same rule as the Notification Center / email alert (low-stock.js):
   not archived AND reorder_level > 0 AND on_hand <= reorder_level.  It never writes a notification.          */
const DEPTS = ['Raw Materials', 'Finishing Supplies', 'Finished Goods'];
const STATUS_ORDER = { out: 0, low: 1, watch: 2, ok: 3, no_level: 4 };
async function lowStock(q, dx, p, o = {}) {
  const dept = DEPTS.includes(p.dept) ? p.dept : 'all';
  const status = ['attention', 'out', 'low', 'watch', 'ok', 'no_level', 'all'].includes(p.status) ? p.status : 'attention';
  const sort = ['shortage', 'status', 'name', 'on_hand', 'cover', 'cost'].includes(p.sort) ? p.sort : 'status';
  const search = String(p.q || '').trim().toLowerCase().slice(0, 60);
  // asc = smallest first, desc = largest first, for every column. Names and days-of-cover default to asc, the rest to desc (worst first).
  const dirName = ['asc', 'desc'].includes(p.dir) ? p.dir : (sort === 'name' || sort === 'cover' ? 'asc' : 'desc'), dir = dirName === 'asc' ? 1 : -1;
  const since = p.since || new Date(Date.now() - 30 * 86400000).toISOString();
  const alerts = o.hasAlerts ? `EXISTS (SELECT 1 FROM low_stock_alerts a WHERE a.product_id = p.product_id)` : '0';
  const sql = `SELECT p.sku, p.name, p.department, c.name AS category, p.unit, p.on_hand, p.reorder_level, p.unit_cost, p.location,
      CASE WHEN p.reorder_level <= 0 THEN 'no_level' WHEN p.on_hand <= 0 THEN 'out' WHEN p.on_hand <= p.reorder_level THEN 'low'
           WHEN p.on_hand <= p.reorder_level * 1.2 THEN 'watch' ELSE 'ok' END AS status,
      (SELECT s.name FROM product_suppliers ps JOIN suppliers s ON s.supplier_id = ps.supplier_id WHERE ps.product_id = p.product_id ORDER BY ps.is_primary DESC, s.name LIMIT 1) AS supplier,
      (SELECT MAX(m.created_at) FROM stock_movements m WHERE m.product_id = p.product_id AND m.movement_type = 'in' AND m.reason = 'supplier_receipt') AS last_receipt,
      COALESCE((SELECT SUM(m.quantity) FROM stock_movements m WHERE m.product_id = p.product_id AND m.movement_type = 'out' AND m.created_at >= $1), 0) AS out_30d,
      ${alerts} AS alerted
    FROM products p LEFT JOIN categories c ON c.category_id = p.category_id
   WHERE p.is_archived = FALSE`;
  const all = (await q(sql, [since])).map((r) => {
    const onHand = num(r.on_hand), level = num(r.reorder_level), out30 = num(r.out_30d), perDay = out30 / 30;
    return { sku: r.sku, name: r.name, department: r.department, category: r.category || null, unit: r.unit, onHand, reorderLevel: level,
      shortage: r.status === 'low' || r.status === 'out' ? r2(level - onHand) : 0, status: r.status,
      coveragePct: level > 0 ? r2(onHand / level * 100) : null, unitCost: num(r.unit_cost), location: r.location || null, supplier: r.supplier || null,
      lastReceipt: r.last_receipt || null, usedLast30Days: r2(out30), daysOfCover: perDay > 0 ? r2(onHand / perDay) : null,
      restockCost: r2((r.status === 'low' || r.status === 'out' ? level - onHand : 0) * num(r.unit_cost)), notified: !!num(r.alerted) };
  });
  // the summary cards always describe the whole catalogue, whatever the table below is filtered to
  const summary = { total: all.length, out: 0, low: 0, watch: 0, ok: 0, no_level: 0, needAttention: 0, restockCost: 0, byDepartment: DEPTS.map((d) => ({ department: d, out: 0, low: 0, watch: 0, ok: 0, no_level: 0, total: 0 })) };
  for (const r of all) {
    summary[r.status]++; const d = summary.byDepartment.find((x) => x.department === r.department);
    if (d) { d[r.status]++; d.total++; }
    if (r.status === 'low' || r.status === 'out') { summary.needAttention++; summary.restockCost = r2(summary.restockCost + r.restockCost); }
  }
  let rows = all.filter((r) => (dept === 'all' || r.department === dept)
    && (status === 'all' || (status === 'attention' ? (r.status === 'low' || r.status === 'out') : r.status === status))
    && (!search || r.sku.toLowerCase().includes(search) || r.name.toLowerCase().includes(search)));
  const key = { shortage: (r) => r.shortage, status: (r) => -STATUS_ORDER[r.status] * 1e6 + r.shortage, name: (r) => r.name.toLowerCase(), on_hand: (r) => r.onHand,
    cover: (r) => (r.daysOfCover == null ? Infinity : r.daysOfCover), cost: (r) => r.restockCost }[sort];
  rows.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -dir : x > y ? dir : String(a.sku).localeCompare(String(b.sku)); });
  return { filters: { dept, status, sort, dir: dirName, q: search }, rule: 'Low = reorder level is set and on-hand is at or below it. Watch = within 20% above it.', summary, count: rows.length, rows };
}

/* ================================================================ 4. INVENTORY REPORTS */
const REASON_GROUPS = {
  'Supplier receipts': { in: ['supplier_receipt'] },
  'Finished goods produced': { in: ['produced_batch', 'production_output'] },
  'Returns and restocking': { in: ['return', 'refund', 'customer_return'] },
  'Stock adjustments': { in: ['count_correction_up', 'correction', 'opening_balance'], out: ['count_correction_down'] },
  'Sales': { out: ['sale', 'online_order'] },
  'Material consumption': { out: ['production_use'] },
  'Losses and write-offs': { out: ['rust_corrosion', 'damaged', 'damage', 'scrap_cutting_waste', 'quality_rejection', 'lost_missing', 'write_off'] },
  'Returned to supplier': { out: ['returned_to_supplier'] }
};
const groupOf = (type, reason) => { for (const [g, m] of Object.entries(REASON_GROUPS)) if ((m[type] || []).includes(reason)) return g; return 'Other'; };
const reasonsOfGroup = (g) => { const m = REASON_GROUPS[g]; return m ? [...(m.in || []), ...(m.out || [])] : null; };

async function inventoryReport(q, dx, p) {
  const { from, to } = p, dept = DEPTS.includes(p.dept) ? p.dept : 'all';
  const type = ['in', 'out'].includes(p.type) ? p.type : 'all', group = REASON_GROUPS[p.group] ? p.group : 'all';
  const page = Math.max(parseInt(p.page, 10) || 1, 1), size = Math.min(Math.max(parseInt(p.pageSize, 10) || 50, 10), 200), search = String(p.q || '').trim().slice(0, 60);
  const BASE = `FROM stock_movements m JOIN products pr ON pr.product_id = m.product_id WHERE ${dx.between('m.created_at', '$1', '$2')}`;
  const cost = 'COALESCE(m.unit_cost, pr.unit_cost, 0)';

  const [byReason, byDay, consumption, production, usage, returnsRows] = await Promise.all([
    q(`SELECT m.movement_type AS type, m.reason, pr.department, COUNT(*) AS n, SUM(m.quantity) AS qty, SUM(m.quantity * ${cost}) AS value ${BASE} GROUP BY m.movement_type, m.reason, pr.department`, [from, to]),
    q(`SELECT ${dx.day('m.created_at')} AS day, m.movement_type AS type, SUM(m.quantity * ${cost}) AS value ${BASE} GROUP BY ${dx.day('m.created_at')}, m.movement_type`, [from, to]),
    q(`SELECT pr.sku, pr.name, pr.unit, pr.department, SUM(m.quantity) AS qty, SUM(m.quantity * ${cost}) AS value, COUNT(*) AS n ${BASE} AND m.movement_type = 'out' AND m.reason = 'production_use' GROUP BY pr.sku, pr.name, pr.unit, pr.department ORDER BY value DESC, pr.sku`, [from, to]),
    q(`SELECT r.product_sku AS sku, r.product_name AS name, r.unit, COUNT(*) AS batches, SUM(r.quantity) AS qty FROM production_records r WHERE ${dx.between('r.created_at', '$1', '$2')} GROUP BY r.product_sku, r.product_name, r.unit ORDER BY qty DESC, r.product_sku`, [from, to]),
    q(`SELECT i.material_sku AS sku, MAX(i.material_name) AS name, MAX(i.unit) AS unit, SUM(i.calculated_qty) AS planned, SUM(i.actual_qty) AS actual
         FROM production_items i JOIN production_records r ON r.production_id = i.production_id WHERE ${dx.between('r.created_at', '$1', '$2')} GROUP BY i.material_sku ORDER BY i.material_sku`, [from, to]),
    q(`SELECT 'POS return' AS source, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(CASE WHEN restock THEN 1 ELSE 0 END), 0) AS restocked
         FROM pos_return_requests WHERE status = 'approved' AND ${dx.between('COALESCE(decided_at, created_at)', '$1', '$2')}
       UNION ALL
       SELECT 'Online refund', COUNT(*), COALESCE(SUM(amount), 0), COALESCE(SUM(CASE WHEN restocked THEN 1 ELSE 0 END), 0)
         FROM order_refund_requests WHERE status = 'approved' AND ${dx.between('COALESCE(decided_at, created_at)', '$1', '$2')}`, [from, to])]);

  const groups = new Map(), depts = new Map(), tot = { inQty: 0, outQty: 0, inValue: 0, outValue: 0, movements: 0 };
  for (const r of byReason) {
    const g = groupOf(r.type, r.reason), k = g + '|' + r.type, v = r2(num(r.value));
    const e = groups.get(k) || groups.set(k, { group: g, type: r.type, movements: 0, value: 0 }).get(k);
    e.movements += num(r.n); e.value = r2(e.value + v);
    const d = depts.get(r.department) || depts.set(r.department, { department: r.department, inValue: 0, outValue: 0, movements: 0 }).get(r.department);
    d.movements += num(r.n); if (r.type === 'in') d.inValue = r2(d.inValue + v); else d.outValue = r2(d.outValue + v);
    tot.movements += num(r.n); if (r.type === 'in') tot.inValue = r2(tot.inValue + v); else tot.outValue = r2(tot.outValue + v);
  }
  const grain = p.grain || autoGrain(from, to), keys = bucketList(from, to, grain), idx = new Map(keys.map((k, i) => [k, i]));
  const trend = keys.map((k) => ({ key: k, label: bucketLabel(k, grain), in: 0, out: 0 }));
  for (const r of byDay) { const b = trend[idx.get(bucketKey(r.day, grain))]; if (b) b[r.type] = r2(b[r.type] + num(r.value)); }

  // paged movement list (filters applied in SQL; quantities stay per product because units differ)
  let where = '', params = [from, to];
  if (dept !== 'all') { params.push(dept); where += ` AND pr.department = $${params.length}`; }
  if (type !== 'all') { params.push(type); where += ` AND m.movement_type = $${params.length}`; }
  if (group !== 'all') { const rs = reasonsOfGroup(group); where += ` AND m.reason IN (${rs.map((x) => `'${x}'`).join(', ')})`; if (REASON_GROUPS[group].in && !REASON_GROUPS[group].out) where += ` AND m.movement_type = 'in'`; if (REASON_GROUPS[group].out && !REASON_GROUPS[group].in) where += ` AND m.movement_type = 'out'`; }
  if (search) { params.push('%' + likeEscape(search.toLowerCase()) + '%'); where += ` AND (LOWER(pr.sku) LIKE $${params.length} ESCAPE '\\' OR LOWER(pr.name) LIKE $${params.length} ESCAPE '\\' OR LOWER(m.ref) LIKE $${params.length} ESCAPE '\\')`; }
  const total = num((await q(`SELECT COUNT(*) AS n ${BASE}${where}`, params))[0].n);
  const lim = params.length;
  const list = await q(`SELECT m.ref, m.created_at, ${dx.day('m.created_at')} AS day, m.movement_type AS type, m.reason, m.quantity, pr.sku, pr.name, pr.unit, pr.department, ${cost} AS unit_cost, m.note, u.full_name AS handled_by
       ${BASE.replace('WHERE', 'LEFT JOIN users u ON u.user_id = m.handled_by WHERE')}${where} ORDER BY m.created_at DESC, m.movement_id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  void lim;

  return {
    range: { from, to, grain }, totals: tot,
    groups: [...groups.values()].sort((a, b) => b.value - a.value),
    departments: DEPTS.map((d) => depts.get(d) || { department: d, inValue: 0, outValue: 0, movements: 0 }),
    trend,
    consumption: consumption.map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, department: r.department, qty: r2(num(r.qty)), value: r2(num(r.value)), movements: num(r.n) })),
    materialUsage: usage.map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, planned: r2(num(r.planned)), actual: r2(num(r.actual)), variance: r2(num(r.actual) - num(r.planned)) })),
    production: { batches: production.reduce((n, r) => n + num(r.batches), 0), units: r2(production.reduce((n, r) => n + num(r.qty), 0)),
      products: production.map((r) => ({ sku: r.sku, name: r.name, unit: r.unit, batches: num(r.batches), qty: r2(num(r.qty)) })) },
    returns: returnsRows.map((r) => ({ source: r.source, count: num(r.n), amount: r2(num(r.amount)), restocked: num(r.restocked) })),
    movements: { page, pageSize: size, total, pages: Math.max(1, Math.ceil(total / size)),
      rows: list.map((r) => ({ ref: r.ref, at: r.created_at, day: r.day, type: r.type, group: groupOf(r.type, r.reason), reason: r.reason, qty: num(r.quantity), sku: r.sku, name: r.name, unit: r.unit,
        department: r.department, value: r2(num(r.quantity) * num(r.unit_cost)), note: r.note || '', by: r.handled_by || '' })) }
  };
}

/* ================================================================ 5. PAYMENTS AND TRANSACTIONS
   "Money" view: every money event once, on the day the money actually moved.
   (The Sales view books a sale on its sale day; the two meet in the summary lines, they are not added.)   */
async function paymentsReport(q, dx, p, o = {}) {
  const { from, to, today } = p;
  const hasLedger = o.hasLedger !== false, paidTs = o.hasPaidAt === false ? 'o.created_at' : 'COALESCE(o.paid_at, o.created_at)';
  const methodOf = `CASE WHEN o.payment_method LIKE 'Cash on%' THEN 'Cash' ELSE o.payment_method END`;
  const ledgerEv = hasLedger ? `
    UNION ALL
    SELECT p.created_at, p.direction, CASE WHEN p.paid_for = 'quote' THEN 'Quotation payment' ELSE 'Order payment' END, p.method, p.amount,
           CASE WHEN p.cash_shift_id IS NOT NULL THEN 1 ELSE 0 END, COALESCE(o2.order_no, q2.quote_no)
      FROM payments p LEFT JOIN orders o2 ON o2.order_id = p.order_id LEFT JOIN quote_requests q2 ON q2.quote_id = p.quote_id
     WHERE ${NOT_A_MOVE}` : '';
  const W = `WITH ${txCtes(dx, o)},
  ev AS (
    SELECT s.created_at AS ts, 'in' AS dir, 'POS sale' AS src, s.method AS method, s.total AS amount,
           CASE WHEN s.method = 'Cash' AND s.cash_shift_id IS NOT NULL THEN 1 ELSE 0 END AS drawer, s.receipt_no AS ref
      FROM pos_sales s WHERE s.status <> 'Voided'
    UNION ALL
    SELECT COALESCE(r.decided_at, r.created_at), 'out', 'POS return', r.refund_method, r.amount,
           CASE WHEN r.refund_method = 'Cash' AND r.refund_shift_id IS NOT NULL THEN 1 ELSE 0 END, s.receipt_no
      FROM pos_return_requests r JOIN pos_sales s ON s.sale_id = r.sale_id WHERE r.status = 'approved'
    UNION ALL
    SELECT ${paidTs}, 'in', 'Online order', ${methodOf}, o.total - m.led_in, CASE WHEN o.cash_shift_id IS NOT NULL THEN 1 ELSE 0 END, o.order_no
      FROM orders o JOIN ord_money m ON m.order_id = o.order_id WHERE o.payment_status = 'paid' AND o.total - m.led_in > 0.004
    UNION ALL
    SELECT COALESCE(r.decided_at, r.created_at), 'out', 'Online refund', ${methodOf}, r.amount - m.led_refund, 0, o.order_no
      FROM order_refund_requests r JOIN orders o ON o.order_id = r.order_id JOIN ord_money m ON m.order_id = o.order_id WHERE r.status = 'approved' AND r.amount - m.led_refund > 0.004${ledgerEv}
  )`;
  const IN = dx.between('ts', '$1', '$2');
  const [byMethod, bySource, byDay, voids, open, cancelledPaid, handoverDeposit] = await Promise.all([
    q(`${W} SELECT method, dir, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(CASE WHEN drawer = 1 THEN amount ELSE 0 END), 0) AS drawer FROM ev WHERE ${IN} GROUP BY method, dir`, [from, to]),
    q(`${W} SELECT src, dir, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM ev WHERE ${IN} GROUP BY src, dir`, [from, to]),
    q(`${W} SELECT ${dx.day('ts')} AS day, dir, COALESCE(SUM(amount), 0) AS amount FROM ev WHERE ${IN} GROUP BY ${dx.day('ts')}, dir`, [from, to]),
    q(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM pos_sales WHERE status IN ('Voided', 'Void Pending') AND ${dx.between('created_at', '$1', '$2')} GROUP BY status`, [from, to]),
    q(`WITH ${txCtes(dx, o)} SELECT ref, raw_status, method, cls, total, collected, placed_at, ${dx.day('placed_at')} AS day FROM tx WHERE channel = 'Online' AND cls IN ('unpaid', 'partial') ORDER BY (total - collected) DESC, placed_at LIMIT 500`, []),
    q(`WITH ${txCtes(dx, o)} SELECT ref, method, total, collected, ${dx.day('placed_at')} AS day FROM tx WHERE channel = 'Online' AND cls = 'cancelled' AND collected > 0.004 ORDER BY collected DESC LIMIT 50`, []),
    hasLedger ? q(`SELECT q.quote_no AS ref, q.paid_amount AS paid, q.handover_sale_id AS sale_id FROM quote_requests q WHERE q.handover_sale_id IS NOT NULL AND q.paid_amount > 0 ORDER BY q.paid_amount DESC LIMIT 50`, []) : Promise.resolve([])]);

  const sum = (rows, f) => r2(rows.reduce((n, r) => n + num(f(r)), 0));
  const inRows = byMethod.filter((r) => r.dir === 'in'), outRows = byMethod.filter((r) => r.dir === 'out');
  const methods = [...new Set(byMethod.map((r) => r.method))].sort().map((m) => {
    const i = inRows.find((r) => r.method === m) || {}, x = outRows.find((r) => r.method === m) || {};
    return { method: m, payments: num(i.n), received: r2(num(i.amount)), drawerCash: r2(num(i.drawer)), refunds: r2(num(x.amount)), refundCount: num(x.n), net: r2(num(i.amount) - num(x.amount)) };
  });
  const sources = [...new Set(bySource.map((r) => r.src))].sort().map((s) => {
    const i = bySource.find((r) => r.src === s && r.dir === 'in') || {}, x = bySource.find((r) => r.src === s && r.dir === 'out') || {};
    return { source: s, received: r2(num(i.amount)), refunds: r2(num(x.amount)), net: r2(num(i.amount) - num(x.amount)) };
  });
  const grain = p.grain || autoGrain(from, to), keys = bucketList(from, to, grain), idx = new Map(keys.map((k, i) => [k, i]));
  const trend = keys.map((k) => ({ key: k, label: bucketLabel(k, grain), received: 0, refunds: 0 }));
  for (const r of byDay) { const b = trend[idx.get(bucketKey(r.day, grain))]; if (!b) continue; if (r.dir === 'in') b.received = r2(b.received + num(r.amount)); else b.refunds = r2(b.refunds + num(r.amount)); }
  const today_ = today || todayPH();
  const openRows = open.map((r) => ({ ref: r.ref, status: r.raw_status, method: r.method, state: r.cls, total: r2(num(r.total)), collected: r2(num(r.collected)), outstanding: r2(num(r.total) - num(r.collected)), day: r.day, ageDays: Math.max(0, daysBetween(r.day, today_)) }));
  const xendit = methods.find((m) => m.method === 'Xendit') || { payments: 0, received: 0, refunds: 0, net: 0 };
  const cash = methods.find((m) => m.method === 'Cash') || { payments: 0, received: 0, refunds: 0, net: 0, drawerCash: 0 };
  const voidRow = (s) => { const r = voids.find((v) => v.status === s) || {}; return { count: num(r.n), amount: r2(num(r.amount)) }; };
  return {
    range: { from, to, grain },
    totals: { received: sum(methods, (m) => m.received), refunds: sum(methods, (m) => m.refunds), net: sum(methods, (m) => m.net), drawerCash: sum(methods, (m) => m.drawerCash) },
    methods, sources, trend,
    cash: { payments: cash.payments, received: cash.received, refunds: cash.refunds, net: cash.net, inDrawer: cash.drawerCash || 0 },
    xendit: { payments: xendit.payments, received: xendit.received, refunds: xendit.refunds, net: xendit.net,
      awaiting: { count: openRows.filter((r) => r.method === 'Xendit').length, amount: sum(openRows.filter((r) => r.method === 'Xendit'), (r) => r.outstanding) } },
    refundsAndVoids: { posVoided: voidRow('Voided'), posVoidPending: voidRow('Void Pending'), refundedTotal: sum(methods, (m) => m.refunds),
      bySource: sources.filter((s) => s.refunds > 0).map((s) => ({ source: s.source, amount: s.refunds })) },
    unpaid: { count: openRows.length, outstanding: sum(openRows, (r) => r.outstanding), unpaidCount: openRows.filter((r) => r.state === 'unpaid').length, partialCount: openRows.filter((r) => r.state === 'partial').length,
      partialCollected: sum(openRows.filter((r) => r.state === 'partial'), (r) => r.collected), rows: openRows.slice(0, 100) },
    needsReview: {
      cancelledButPaid: cancelledPaid.map((r) => ({ ref: r.ref, method: r.method, total: r2(num(r.total)), collected: r2(num(r.collected)), day: r.day })),
      quoteDepositsOnPosReceipt: handoverDeposit.map((r) => ({ ref: r.ref, paid: r2(num(r.paid)), saleId: num(r.sale_id) }))
    },
    shifts: null
  };
}

/* ================================================================ 6. QUOTATIONS
   Counted by the day the request was made. Statuses are the ones the Quote Desk uses; "expired" is a quoted
   quotation whose valid-until date has passed (same rule as quote-desk.js).                                  */
async function quotationReport(q, dx, p) {
  const { from, to } = p, today = p.today || todayPH();
  const bucket = `CASE WHEN q.status = 'new' THEN 'pending_review' WHEN q.status = 'awaiting_details' THEN 'awaiting_details' WHEN q.status = 'pending_approval' THEN 'pending_approval'
      WHEN q.status = 'quoted' AND q.valid_until IS NOT NULL AND q.valid_until < $3 THEN 'expired' WHEN q.status = 'quoted' THEN 'quoted'
      WHEN q.status IN ('accepted', 'preparing', 'ready', 'completed') THEN 'accepted' WHEN q.status = 'declined' THEN 'declined' WHEN q.status = 'closed' THEN 'closed' ELSE 'other' END`;
  const W = `FROM quote_requests q WHERE ${dx.between('q.created_at', '$1', '$2')}`;
  const [byBucket, bySource, conv, detail, byDay] = await Promise.all([
    q(`SELECT ${bucket} AS bucket, COUNT(*) AS n, COALESCE(SUM(q.quoted_amount), 0) AS value ${W} GROUP BY ${bucket}`, [from, to, today]),
    q(`SELECT COALESCE(q.source, 'shop') AS source, COUNT(*) AS n ${W} GROUP BY COALESCE(q.source, 'shop')`, [from, to]),
    q(`SELECT COALESCE(SUM(CASE WHEN q.converted_order_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS to_order, COALESCE(SUM(CASE WHEN q.handover_sale_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS to_pos,
              COALESCE(SUM(CASE WHEN q.status IN ('accepted', 'preparing', 'ready', 'completed') THEN 1 ELSE 0 END), 0) AS accepted ${W}`, [from, to]),
    q(`SELECT q.quote_no AS ref, q.status, ${bucket} AS bucket, q.contact_name AS customer, q.product_name AS product, q.quoted_amount AS amount, q.valid_until, ${dx.day('q.created_at')} AS day,
              CASE WHEN q.converted_order_id IS NOT NULL THEN 'order' WHEN q.handover_sale_id IS NOT NULL THEN 'pos' ELSE '' END AS converted_to
         ${W} ORDER BY q.created_at DESC LIMIT 200`, [from, to, today]),
    q(`SELECT ${dx.day('q.created_at')} AS day, COUNT(*) AS n ${W} GROUP BY ${dx.day('q.created_at')}`, [from, to])]);
  const get = (b) => byBucket.find((r) => r.bucket === b) || {}, n = (b) => num(get(b).n);
  const total = byBucket.reduce((s, r) => s + num(r.n), 0), c = conv[0] || {};
  const funnel = [
    { key: 'pending_review', label: 'Pending review', count: n('pending_review') }, { key: 'awaiting_details', label: 'Awaiting customer details', count: n('awaiting_details') },
    { key: 'pending_approval', label: 'Pending approval', count: n('pending_approval') }, { key: 'quoted', label: 'Quoted', count: n('quoted'), value: r2(num(get('quoted').value)) },
    { key: 'accepted', label: 'Accepted', count: n('accepted'), value: r2(num(get('accepted').value)) }, { key: 'declined', label: 'Declined', count: n('declined') },
    { key: 'expired', label: 'Expired', count: n('expired'), value: r2(num(get('expired').value)) }, { key: 'closed', label: 'Closed by staff', count: n('closed') }];
  const grain = p.grain || autoGrain(from, to), keys = bucketList(from, to, grain), idx = new Map(keys.map((k, i) => [k, i]));
  const trend = keys.map((k) => ({ key: k, label: bucketLabel(k, grain), count: 0 }));
  for (const r of byDay) { const b = trend[idx.get(bucketKey(r.day, grain))]; if (b) b.count += num(r.n); }
  const acc = num(c.accepted), conv_ = num(c.to_order) + num(c.to_pos);
  return {
    range: { from, to, today, grain }, total, funnel,
    converted: { toOrder: num(c.to_order), toPosReceipt: num(c.to_pos), total: conv_, ofAcceptedPct: acc ? r2(conv_ / acc * 100) : 0 },
    acceptedValue: r2(num(get('accepted').value)), quotedValue: r2(num(get('quoted').value)),
    sources: bySource.map((r) => ({ source: r.source, count: num(r.n) })), trend,
    rows: detail.map((r) => ({ ref: r.ref, status: r.status, bucket: r.bucket, customer: r.customer || '', product: r.product || '', amount: r.amount == null ? null : r2(num(r.amount)), validUntil: r.valid_until ? String(r.valid_until).slice(0, 10) : null, day: r.day, convertedTo: r.converted_to })),
    note: 'Accepted includes quotations already converted. Converted quotations are counted once as sales, on the order or POS invoice they became.'
  };
}

/* ---------------------------------------------------------------- validation shared by the routes */
function checkRange(from, to, today) {
  const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) && fmtYmd(parseYmd(v)) === v;
  const t = today || todayPH();
  const f = ok(from) ? from : (ok(to) ? to : t), e = ok(to) ? to : (ok(from) ? from : t);
  if ((from && !ok(from)) || (to && !ok(to))) return { error: 'Use dates like 2026-10-14.' };
  if (f > e) return { error: 'The start date must not be after the end date.' };
  if (daysBetween(f, e) + 1 > MAX_DAYS) return { error: `Choose a range of ${MAX_DAYS} days or less.` };
  return { from: f, to: e };
}

module.exports = { PG, LITE, MAX_DAYS, DEPTS, REASON_GROUPS, salesOverview, topProducts, lowStock, inventoryReport, paymentsReport, quotationReport,
  checkRange, todayPH, addDays, daysBetween, autoGrain, bucketList, bucketKey, groupOf, r2 };