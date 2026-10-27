/* last-quote.js — "what did we quote this customer for the same product last time?" (Finance approvals, recurring customers)
   Pure functions, no database: shop-extras.js fetches the history rows and hands them here.
     lastQuoteFor(q, history) -> { id, amount, quantity, sameQuantity, at, status, unitPrice, priceDriftPct, costDriftPct, adjustedTotal, times } | null
   - same customer: the shop account when there is one, otherwise the phone number (walk-ins have no account; last 10 digits, so +63 / 0 prefixes match)
   - same product: the catalog SKU (custom items have none, so they are never matched)
   - only quotes that really carried a price are used, and only ones made before this request
   Drift is worked out per unit, so a different quantity does not hide a real change:
     priceDriftPct  the price now being asked (cashier's) per unit vs the last quoted price per unit
     costDriftPct   the recipe cost now per unit vs the recipe cost saved on the last quote per unit (null when that quote has no saved cost)
     adjustedTotal  last unit price moved by the cost drift, times today's quantity: a starting point for Finance, never applied by itself */
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const qtyOf = (t) => { const n = parseFloat(String(t == null ? '' : t).replace(/,/g, '')); return n > 0 ? n : null; };
const time = (d) => (d ? new Date(d).getTime() : NaN);

function sameCustomer(q, p) {
  if (q.customer_id != null) return p.customer_id != null && String(p.customer_id) === String(q.customer_id);
  const a = digits(q.phone);
  return a.length >= 7 && a === digits(p.phone);
}

function lastQuoteFor(q, history) {
  if (!q || !q.product_sku || !Array.isArray(history)) return null;
  const mine = time(q.created_at);
  const prior = history.filter((p) => p && p.quote_id !== q.quote_id && p.product_sku === q.product_sku && p.quoted_amount != null && +p.quoted_amount > 0 &&
    (!Number.isFinite(mine) || time(p.created_at) < mine) && sameCustomer(q, p)).sort((a, b) => time(b.created_at) - time(a.created_at));
  const p = prior[0];
  if (!p) return null;
  const amount = +p.quoted_amount, pq = qtyOf(p.quantity), nq = qtyOf(q.quantity);
  const unitPrice = pq ? round2(amount / pq) : null;
  const nowTotal = q.proposed_amount != null ? +q.proposed_amount : null;
  const priceDriftPct = unitPrice && nq && nowTotal != null ? round1(((nowTotal / nq) / unitPrice - 1) * 100) : null;
  const prevCost = p.suggested_cost != null && +p.suggested_cost > 0 ? +p.suggested_cost : null;
  const nowCost = q.suggested_cost != null && +q.suggested_cost > 0 ? +q.suggested_cost : null;
  const costDriftPct = prevCost && nowCost && pq && nq ? round1(((nowCost / nq) / (prevCost / pq) - 1) * 100) : null;
  const adjustedTotal = unitPrice && nq && costDriftPct != null ? round2(unitPrice * (1 + costDriftPct / 100) * nq) : null;
  return { id: p.quote_no, amount, quantity: p.quantity, sameQuantity: !!(pq && nq && pq === nq), at: time(p.created_at) || undefined, status: p.status,
    unitPrice, priceDriftPct, costDriftPct, adjustedTotal, times: prior.length };
}

module.exports = { lastQuoteFor, sameCustomer };
