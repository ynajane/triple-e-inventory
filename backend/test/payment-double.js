/* payment-double.js — the in-memory PostgreSQL half for the payment ledger, shared by the test files and the
   browser harness (desk-browser-harness.js). It is DEV/TEST ONLY and is never required by server.js.

   backend/db/020_payment_terms.sql keeps quote_requests.paid_amount / payment_state and orders.paid_amount /
   payment_state in step with the payments table through a database trigger. There is no PostgreSQL in this
   environment, so the double answers the statements payment-terms.js really sends and re-runs that same trigger
   maths in JavaScript:

       net = SUM(direction 'in') - SUM(direction 'out')
       paid_amount = max(net, 0)
       payment_state = paid | partially_paid | partially_refunded | refunded | unpaid   (db/020 payment_state_for)

   What that proves: the route wiring, the validation, the row-lock/idempotency guards, the overpayment refusal and
   the balance arithmetic the screens show. What it does NOT prove: that the SQL itself parses, that the trigger
   fires, or that the unique indexes hold — those need a real PostgreSQL run (see README_DEPLOY.md). */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);

const stateFor = (net, total, refunded) => {
  if (net > 0 && cents(net) >= cents(total)) return 'paid';
  if (net > 0) return refunded ? 'partially_refunded' : 'partially_paid';
  return refunded ? 'refunded' : 'unpaid';
};

// Same starting policy as the migration: only Full Payment is switched on.
const seedTerms = () => ([
  { term_key: 'full', label: 'Full Payment — 100%', basis: 'percent', percent: 100, fixed_amount: null, retail_allowed: true, made_to_order_allowed: true, balance_condition: 'nothing further to pay', enabled: true, enabled_by: null, enabled_at: null, note: null },
  { term_key: 'half', label: 'Half Payment — 50%', basis: 'percent', percent: 50, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'balance due before release', enabled: false, enabled_by: null, enabled_at: null, note: null },
  { term_key: 'down', label: 'Down Payment — 30%', basis: 'percent', percent: 30, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'balance due before release', enabled: false, enabled_by: null, enabled_at: null, note: null },
  { term_key: 'custom', label: 'Custom partial payment', basis: 'percent', percent: null, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'as approved by Finance', enabled: false, enabled_by: null, enabled_at: null, note: null }
]);

/* DB needs: quotes (Map keyed by quote_no), orders (array), users (object keyed by id) — the same shapes the
   existing doubles already keep. seq.payment is added here. */
module.exports = function paymentDouble(DB, opts = {}) {
  DB.payments = DB.payments || [];
  DB.terms = DB.terms || seedTerms();
  DB.seq = DB.seq || {};
  DB.seq.payment = DB.seq.payment || 5000;
  if (DB.cashShiftId === undefined) DB.cashShiftId = 11;   // the drawer this cashier is assumed to have open
  const quoteByNo = opts.quoteByNo || ((no) => [...DB.quotes.values()].find((q) => String(q.quote_no).toUpperCase() === String(no).toUpperCase()));
  const quoteById = opts.quoteById || ((id) => [...DB.quotes.values()].find((q) => Number(q.quote_id) === Number(id)));
  const orderByNo = opts.orderByNo || ((no) => DB.orders.find((o) => String(o.order_no).toUpperCase() === String(no).toUpperCase()));
  const rowsOf = (rows) => ({ rows, rowCount: rows.length });

  const orderRow = (spec) => spec.kind === 'order'
    ? (spec.no != null ? orderByNo(spec.no) : DB.orders.find((o) => Number(o.order_id) === Number(spec.id)))
    : (spec.no != null ? quoteByNo(spec.no) : quoteById(spec.id));

  /* The period maths the §10 report route asks PostgreSQL for. The app works in Manila time (Asia/Manila, +8 and no
     daylight saving), so "(x AT TIME ZONE $1)::date" is the instant shifted by eight hours and cut to a day.
     created_at has DEFAULT now() in db/schema.sql, so a fixture row without one is read as "just now". */
  const dayIn = (t) => {
    const d = new Date(t == null || Number.isNaN(new Date(t).getTime()) ? Date.now() : t);
    return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  };
  const inDays = (t, from, to) => { const d = dayIn(t); return d >= from && d <= to; };
  const isMove = (p) => /^transfer(-in)?:/.test(String(p.request_id || ''));      // quote -> order re-filing, not cash
  const owedOn = (total, paid) => round2(Math.max(0, Number(total || 0) - Number(paid || 0)));

  /* the db/020 trigger body, re-run after every ledger insert */
  function recompute(kind, parent) {
    const col = kind === 'order' ? 'order_id' : 'quote_id';
    const rows = DB.payments.filter((p) => p.paid_for === kind && Number(p[col]) === Number(parent[kind === 'order' ? 'order_id' : 'quote_id']));
    const net = round2(rows.reduce((n, p) => n + (p.direction === 'in' ? Number(p.amount) : -Number(p.amount)), 0));
    const refunded = rows.some((p) => p.direction === 'out' && p.purpose === 'refund');   // a 'correction' move does not look like a refund
    const total = round2(Number(kind === 'order' ? parent.total : parent.quoted_amount) || 0);
    parent.paid_amount = Math.max(net, 0);
    parent.payment_state = stateFor(parent.paid_amount, total, refunded);
    return parent;
  }

  const PAY_COLUMNS = ['paid_for', 'order_id', 'quote_id', 'direction', 'amount', 'method', 'purpose', 'provider_ref', 'request_id',
    'sale_id', 'cash_shift_id', 'tendered', 'change_given', 'reversed_of', 'note', 'received_by'];

  /* The VALUES tuple, split into its items, with each item resolved. A parameter is NOT always in its column's
     position: the conversion transfer writes paid_for and direction as literals in the SQL, so mapping the columns
     straight onto $1..$n would put the amount in method and the note in received_by. */
  function valuesTuple(s) {
    const at = s.search(/VALUES\s*\(/i), open = s.indexOf('(', at);
    let depth = 0, q = false;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") q = !q;
      else if (!q && ch === '(') depth++;
      else if (!q && ch === ')') { if (--depth === 0) return s.slice(open + 1, i); }
    }
    return s.slice(open + 1);
  }
  function splitTuple(inner) {
    const out = []; let cur = '', depth = 0, q = false;
    for (const ch of inner) {
      if (ch === "'") q = !q;
      if (!q) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function tupleValue(tok, p) {
    const t = String(tok == null ? '' : tok).trim();
    if (/^\$\d+$/.test(t)) return p[Number(t.slice(1)) - 1];
    if (/^'/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
    if (/^null$/i.test(t)) return null;
    return t;
  }

  /* Returns {rows, rowCount} when the statement belongs to the ledger, or null so the caller keeps its own matching. */
  return function handle(sqlRaw, params) {
    const s = String(sqlRaw).replace(/\s+/g, ' ').trim(), p = params || [];

    // the module asks once whether the database is keeping the totals
    if (/^SELECT COUNT\(\*\)::int AS n FROM pg_trigger/i.test(s)) return rowsOf([{ n: 1 }]);

    /* ---------------- payment_terms ---------------- */
    if (/^SELECT pt\.\*.*FROM payment_terms/i.test(s)) {
      const one = /WHERE pt\.term_key = \$1/i.test(s);
      const list = one ? DB.terms.filter((t) => t.term_key === p[0]) : DB.terms;
      return rowsOf(list.map((t) => Object.assign({}, t, { enabled_by_name: t.enabled_by ? ((DB.users || {})[t.enabled_by] || {}).full_name || null : null })));
    }
    if (/^INSERT INTO payment_terms/i.test(s)) {
      if (!DB.terms.some((t) => t.term_key === p[0])) DB.terms.push({ term_key: p[0], label: p[1], basis: p[2], percent: p[3], fixed_amount: p[4], retail_allowed: p[5], made_to_order_allowed: p[6], balance_condition: p[7], enabled: p[8], enabled_by: null, enabled_at: null, note: null });
      return rowsOf([]);
    }
    if (/^UPDATE payment_terms SET/i.test(s)) {
      const t = DB.terms.find((x) => x.term_key === p[0]);
      if (!t) return rowsOf([]);
      t.basis = p[1]; t.percent = p[2]; t.fixed_amount = p[3]; t.retail_allowed = p[4]; t.made_to_order_allowed = p[5];
      t.balance_condition = p[6]; t.enabled = p[7];
      if (p[7]) { t.enabled_by = p[8]; t.enabled_at = new Date(); }
      t.note = p[9]; t.updated_at = new Date();
      return rowsOf([t]);
    }

    /* ---------------- the §9 Finance reads ----------------
       db/020 keeps orders.paid_amount / quote_requests.paid_amount current through its trigger, and every money event
       is a row in DB.payments. These two lists only show what those already say, so the double answers them from the
       stored rows — it does not re-derive a balance from the ledger here. */
    if (/^SELECT o\.order_no AS no, o\.customer_id/i.test(s) || /^SELECT q\.quote_no AS no, q\.customer_id/i.test(s)) {
      const isOrder = /^SELECT o\./.test(s);
      const src = isOrder ? DB.orders : [...DB.quotes.values()];
      const totalCol = isOrder ? 'total' : 'quoted_amount';
      const rows = src.filter((x) => x[totalCol] != null
        && (isOrder ? x.status !== 'Cancelled' : x.converted_order_id == null && ['accepted', 'preparing', 'ready'].includes(x.status))
        && round2(Math.max(0, Number(x[totalCol]) - Number(x.paid_amount || 0))) > 0.005)
        .map((x) => Object.assign({ no: isOrder ? x.order_no : x.quote_no, customer_id: x.customer_id,
          customer: isOrder ? ((DB.users || {})[x.customer_id] || {}).full_name || '' : (x.contact_name || ''),
          total: x[totalCol], paid_amount: Number(x.paid_amount || 0), payment_state: x.payment_state || 'unpaid',
          terms_key: x.terms_key, terms_percent: x.terms_percent, terms_condition: x.terms_condition, status: x.status,
          payment_method: x.payment_method, credit_exception_by: x.credit_exception_by, credit_exception_note: x.credit_exception_note,
          at: x.created_at || x.updated_at },
          { outstanding: round2(Math.max(0, Number(x[totalCol]) - Number(x.paid_amount || 0))) }))
        .sort((a, b) => b.outstanding - a.outstanding);
      return rowsOf(rows.slice(0, 300));
    }
    if (/^SELECT p\.payment_id, p\.paid_for, COALESCE\(o\.order_no/i.test(s)) {
      const name = (id) => ((DB.users || {})[id] || {}).full_name || null;
      const ref = (x) => x.paid_for === 'order'
        ? (DB.orders.find((o) => Number(o.order_id) === Number(x.order_id)) || {}).order_no
        : (quoteById(x.quote_id) || {}).quote_no;
      const rows = DB.payments.filter((x) => !p[0] || x.paid_for === p[0])
        .map((x) => Object.assign({}, x, { no: ref(x), actor: name(x.received_by) }))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0) || b.payment_id - a.payment_id);
      return rowsOf(rows.slice(0, 200));
    }

    /* ---------------- §10 the period report ----------------
       The three reads behind /api/finance/payment-report, answered from the same stored rows: orders raised in the
       period (one line each, never one per payment), the money events grouped the way the GROUP BY would group them,
       and the open balances the two receivables views would show. */
    if (/^SELECT \(now\(\) AT TIME ZONE \$1\)::date::text AS d/i.test(s)) return rowsOf([{ d: dayIn(new Date()) }]);
    if (/^SELECT \(o\.created_at AT TIME ZONE/i.test(s)) {
      const [, from, to] = p;
      return rowsOf(DB.orders.filter((o) => o.status !== 'Cancelled' && inDays(o.created_at, from, to))
        .map((o) => ({ day: dayIn(o.created_at), no: o.order_no, customer_id: o.customer_id,
          customer: ((DB.users || {})[o.customer_id] || {}).full_name || '',
          total: Number(o.total || 0), paid_amount: Number(o.paid_amount || 0), payment_state: o.payment_state || 'unpaid',
          terms_key: o.terms_key, terms_percent: o.terms_percent, terms_condition: o.terms_condition, status: o.status,
          payment_method: o.payment_method, at: o.created_at, outstanding: owedOn(o.total, o.paid_amount),
          in_period: round2(DB.payments.filter((x) => x.paid_for === 'order' && Number(x.order_id) === Number(o.order_id)
            && x.direction === 'in' && !isMove(x) && inDays(x.created_at, from, to)).reduce((n, x) => n + Number(x.amount), 0)) }))
        .sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.no).localeCompare(String(b.no)))
        .slice(0, 500));
    }
    if (/^SELECT \(p\.created_at AT TIME ZONE/i.test(s)) {
      const [, from, to] = p;
      const groups = new Map();
      DB.payments.filter((x) => !isMove(x) && inDays(x.created_at, from, to)).forEach((x) => {
        const key = [dayIn(x.created_at), x.paid_for, x.direction, x.method, x.purpose, x.cash_shift_id != null].join('|');
        const g = groups.get(key) || { day: dayIn(x.created_at), kind: x.paid_for, direction: x.direction, method: x.method,
          purpose: x.purpose, in_drawer: x.cash_shift_id != null, count: 0, amount: 0 };
        g.count += 1; g.amount = round2(g.amount + Number(x.amount));
        groups.set(key, g);
      });
      return rowsOf([...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind) || a.method.localeCompare(b.method)));
    }
    if (/^SELECT 'order' AS kind/i.test(s)) {
      const openOf = (rows) => rows.filter((x) => x.outstanding > 0.005);
      const orders = openOf(DB.orders.filter((o) => o.status !== 'Cancelled')
        .map((o) => ({ outstanding: owedOn(o.total, o.paid_amount) })));
      // db/020 v_receivable_quotes: only an accepted quotation that has not become an order yet can owe money
      const quotes = openOf([...DB.quotes.values()]
        .filter((q) => q.quoted_amount != null && q.converted_order_id == null && ['accepted', 'preparing', 'ready'].includes(q.status))
        .map((q) => ({ outstanding: owedOn(q.quoted_amount, q.paid_amount) })));
      const sum = (rows) => round2(rows.reduce((n, x) => n + x.outstanding, 0));
      return rowsOf([{ kind: 'order', open: orders.length, owed: sum(orders) }, { kind: 'quote', open: quotes.length, owed: sum(quotes) }]);
    }

    /* ---------------- the ledger ---------------- */
    if (/^INSERT INTO payments \(/i.test(s)) {
      const cols = /INSERT INTO payments \((.*?)\) VALUES/i.exec(s)[1].split(',').map((c) => c.trim());
      const vals = splitTuple(valuesTuple(s));
      const rec = { payment_id: ++DB.seq.payment, created_at: new Date() };
      cols.forEach((c, i) => { rec[c] = tupleValue(vals[i], p); });
      if (rec.amount != null) rec.amount = round2(rec.amount);
      ['tendered', 'change_given', 'reversed_of', 'sale_id', 'cash_shift_id'].forEach((k) => { if (rec[k] != null && rec[k] !== '') rec[k] = Number(rec[k]); });
      // the two database checks the routes rely on
      if (rec.provider_ref && DB.payments.some((x) => x.provider_ref === rec.provider_ref)) throw Object.assign(new Error('duplicate provider ref'), { code: '23505' });
      if (rec.request_id && DB.payments.some((x) => x.paid_for === rec.paid_for && x.request_id === rec.request_id)) throw Object.assign(new Error('duplicate request id'), { code: '23505' });
      DB.payments.push(rec);
      const parent = orderRow({ kind: rec.paid_for, id: rec.order_id != null ? rec.order_id : rec.quote_id });
      if (parent) recompute(rec.paid_for, parent);
      return rowsOf([rec]);
    }
    if (/^SELECT \* FROM payments WHERE paid_for = \$1 AND request_id = \$2/i.test(s)) return rowsOf(DB.payments.filter((x) => x.paid_for === p[0] && x.request_id === p[1]));
    if (/^SELECT \* FROM payments WHERE provider_ref = \$1/i.test(s)) return rowsOf(DB.payments.filter((x) => x.provider_ref === p[0]));
    // the refund route checks the payment being reversed really belongs to the order it is being refunded on
    const onePay = /^SELECT \* FROM payments WHERE payment_id = \$1 AND paid_for = '(\w+)' AND (\w+) = \$2/i.exec(s);
    if (onePay) return rowsOf(DB.payments.filter((x) => Number(x.payment_id) === Number(p[0]) && x.paid_for === onePay[1] && Number(x[onePay[2]]) === Number(p[1])).map(copy));
    if (/^SELECT payment_id, amount FROM payments WHERE payment_id = \$1/i.test(s)) {
      const x = DB.payments.find((y) => Number(y.payment_id) === Number(p[0]));
      return rowsOf(x ? [{ payment_id: x.payment_id, amount: x.amount }] : []);
    }
    if (/^SELECT COALESCE\(SUM\(amount\), 0\) AS refunded FROM payments WHERE reversed_of = \$1/i.test(s)) {
      return rowsOf([{ refunded: round2(DB.payments.filter((x) => Number(x.reversed_of) === Number(p[0])).reduce((n, x) => n + Number(x.amount), 0)) }]);
    }
    const led = /^SELECT p\.\*, u\.full_name AS received_by_name, r\.amount AS reversed_amount FROM payments p/i.exec(s);
    if (led) {
      const col = /WHERE (\w+_no) = \$2/i.exec(s)[1];                                       // order_no | quote_no, read through the parent's id
      return rowsOf(DB.payments.filter((x) => {
        if (x.paid_for !== p[0]) return false;
        const parent = x.paid_for === 'order' ? DB.orders.find((o) => Number(o.order_id) === Number(x.order_id)) : quoteById(x.quote_id);
        return !!parent && String(parent[col]).toUpperCase() === String(p[1]).toUpperCase();
      }).map(copy));
    }
    if (/^SELECT p\.\* FROM payments p WHERE p\.paid_for = 'quote'/i.test(s)) {          // the transfer query: quote payments not yet moved to an order
      const quote = quoteById(p[0]);
      const moved = (id) => DB.payments.some((x) => x.paid_for === 'order' && x.request_id === 'transfer-in:' + id);
      return rowsOf(quote ? DB.payments.filter((x) => x.paid_for === 'quote' && Number(x.quote_id) === Number(quote.quote_id) && x.direction === 'in' && !moved(x.payment_id)) : []);
    }
    if (/^SELECT .*FROM payments/i.test(s)) return rowsOf(DB.payments.filter((x) => Number(x.quote_id) === Number(p[0]) || Number(x.order_id) === Number(p[0])).map(copy));

    if (/^UPDATE quote_requests SET terms_key/i.test(s)) {                              // payment-terms.js writes the quotation's terms
      const q = quoteById(p[0]);
      if (!q) return rowsOf([]);
      q.terms_key = p[1]; q.terms_percent = p[2]; q.terms_amount = p[3]; q.terms_balance = p[4];
      q.terms_condition = p[5]; q.terms_availability = p[6]; q.terms_state = p[7];
      if (p[8] != null) { q.terms_decided_by = p[8]; q.terms_decided_at = new Date(); }
      q.updated_at = new Date();
      return rowsOf([q]);
    }
    if (/^SELECT payments FROM quote_requests/i.test(s)) { const q = quoteById(p[0]); return rowsOf(q ? [{ payments: q.payments }] : []); }
    if (/^UPDATE quote_requests SET payments/i.test(s)) { const q = quoteById(p[0]); if (q) q.payments = JSON.parse(p[1]); return rowsOf([]); }

    /* the cashier's own open drawer. The counter route looks it up instead of taking a shift id from the page, so
       cash can only land in a till that is actually open and online payments can never be attached to one. */
    if (/^SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = \$1 AND closed_at IS NULL FOR UPDATE/i.test(s)) {
      return rowsOf(DB.cashShiftId == null ? [] : [{ shift_id: DB.cashShiftId }]);
    }

    /* ---------------- parent reads the module needs ---------------- */
    const parentRead = /^SELECT (?:[a-z_]+ AS id, )?([a-z_]+) AS no, ([a-z_]+) AS total, paid_amount, payment_state FROM (\w+) WHERE ([a-z_]+) = \$1/i.exec(s);
    if (parentRead) {
      const kind = parentRead[3] === 'orders' ? 'order' : 'quote';
      const byNo = parentRead[4] === (kind === 'order' ? 'order_no' : 'quote_no');
      const row = orderRow(Object.assign({ kind }, byNo ? { no: p[0] } : { id: p[0] }));
      return rowsOf(row ? [{ no: row[parentRead[1]], total: row[parentRead[2]], paid_amount: row.paid_amount, payment_state: row.payment_state }] : []);
    }
    if (/^SELECT \* FROM quote_requests WHERE quote_id = \$1/i.test(s)) { const q = quoteById(p[0]); return rowsOf(q ? [copy(q)] : []); }
    if (/^SELECT \* FROM orders WHERE order_no = \$1 FOR UPDATE/i.test(s)) return rowsOf(DB.orders.filter((o) => String(o.order_no).toUpperCase() === String(p[0]).toUpperCase()).map(copy));
    if (/^SELECT \* FROM orders WHERE order_id = \$1 FOR UPDATE/i.test(s)) return rowsOf(DB.orders.filter((o) => Number(o.order_id) === Number(p[0])).map(copy));
    if (/^SELECT \* FROM orders WHERE order_no = \$1 AND customer_id = \$2 FOR UPDATE/i.test(s)) {
      const o = DB.orders.find((x) => String(x.order_no).toUpperCase() === String(p[0]).toUpperCase() && Number(x.customer_id) === Number(p[1]));
      return rowsOf(o ? [copy(o)] : []);
    }
    if (/^UPDATE orders SET credit_exception/i.test(s)) {
      const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0]));
      if (!o) return rowsOf([]);
      if (/SET credit_exception_by = NULL/i.test(s)) { o.credit_exception_by = null; o.credit_exception_note = null; o.credit_exception_at = null; }
      else { o.credit_exception_by = p[1]; o.credit_exception_note = p[2]; o.credit_exception_at = new Date(); }
      return rowsOf([o]);
    }
    if (/^SELECT paid_amount FROM orders WHERE order_id = \$1 FOR UPDATE/i.test(s)) { const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0])); return rowsOf(o ? [{ paid_amount: o.paid_amount }] : []); }
    if (/^SELECT paid_amount, payment_state FROM orders WHERE order_id = \$1/i.test(s)) { const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0])); return rowsOf(o ? [{ paid_amount: o.paid_amount, payment_state: o.payment_state }] : []); }
    if (/^UPDATE orders SET terms_key/i.test(s)) {
      const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0]));
      if (!o) return rowsOf([]);
      o.terms_key = p[1]; o.terms_percent = p[2]; o.terms_amount = p[3]; o.terms_condition = p[4]; o.terms_approved_by = p[5];
      return rowsOf([o]);
    }
    if (/^SELECT COUNT\(\*\)::int AS open_orders/i.test(s)) {
      const open = DB.orders.filter((o) => round2(Number(o.total) - Number(o.paid_amount || 0)) > 0 && o.status !== 'Cancelled');
      return rowsOf([{ open_orders: open.length, outstanding: round2(open.reduce((n, o) => n + round2(Number(o.total) - Number(o.paid_amount || 0)), 0)) }]);
    }
    return null;

    function copy(x) { return Object.assign({}, x); }
  };
};

module.exports.stateFor = stateFor;
module.exports.seedTerms = seedTerms;
module.exports.round2 = round2;
