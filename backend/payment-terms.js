/* payment-terms.js — payment policies, the payment ledger, and the balances derived from it.

   Before this module existed, "how much has been paid" only lived on quotations: shop-extras.js kept a JSONB array
   in quote_requests.payments and added up into quote_requests.paid_amount by hand. Orders had nothing at all —
   just orders.payment_status, which tracks the online invoice (unpaid / pending / paid / expired), not the money.

   This module adds one source of truth, the append-only `payments` ledger (db/020_payment_terms.sql), and the two
   columns derived from it by a database trigger:
        paid_amount     = SUM(in) - SUM(out)                     (never trusted from a screen)
        payment_state   = unpaid | partially_paid | paid | partially_refunded | refunded
   Outstanding balance = total - paid_amount, computed server-side. Fulfilment status stays a separate axis.

   Routes:
     • GET   /api/finance/payment-terms              the policy table (percentages, where each term is allowed, who switched it on)
     • POST  /api/finance/payment-terms/:key         Finance enables / tunes one term  (cashier role is refused)
     • GET   /api/pos/payment-terms                  the terms a cashier may offer for a quote of a given kind
     • GET   /api/shop/payment-terms                 the terms a customer may pick at checkout for a basket total
     • POST  /api/pos/quotes/:no/terms               attach the proposed terms to a quotation before it is sent
     • POST  /api/finance/quotes/:no/terms           approve, change or refuse the terms on a quotation
     • POST  /api/shop/orders/:no/terms              the payment option chosen on an order that has not been paid yet
     • POST  /api/pos/orders/:no/payment             the counter records cash / GCash / bank money on an order
     • POST  /api/finance/orders/:no/refund          Finance reverses one recorded payment
     • POST  /api/finance/orders/:no/credit-exception  §8: let goods go out with a balance still on the order
     • GET   /api/{finance,pos}/payment-ledger/:kind/:no  the confirmed money events on one order or quotation
     • GET   /api/finance/receivables          every order / quotation with a balance still on it  (§9)
     • GET   /api/finance/payments             the ledger itself: payments, refunds, which drawer cash went into  (§9)
     • GET   /api/finance/payment-report       a period read: what was sold, what arrived, what is still owed  (§10)

   Shared with the other modules through app.locals.paymentTerms:
     applyPayment()   the ONLY way money enters the ledger (row lock, idempotency, overpayment guard, audit)
     orderMoney()     the money picture of one order row: total, collected, outstanding, due now, state
     termsOf() / quoteTerms()  what a screen may show and the amounts behind it

   The percentages seeded here are a PROPOSAL. Only Full Payment ships enabled; Half / Down / Custom stay switched
   off until Finance turns them on, so nothing in this file assumes management approved a 50% or 30% policy.

   Mounted in server.js, before pos-shop / shop-extras / quote-desk:
     require('./payment-terms')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });
*/

const TERMS = ['full', 'half', 'down', 'custom'];
// Same allowlist the quotation payments already use, plus 'Xendit' (what an online payment is confirmed as) and 'Card'.
const METHODS = ['Cash', 'Card', 'GCash', 'Maya', 'Bank transfer', 'Credit / debit card', 'Xendit'];
const PURPOSES = ['initial', 'balance', 'refund', 'correction'];
const REQUEST_ID_RE = /^[a-zA-Z0-9-]{12,100}$/;
const MAX_AMOUNT = 1e9;

// Mirrors the seed in db/020_payment_terms.sql. Used only when the payment_terms table cannot be read yet, so a
// database problem can never silently offer every term: the fallback has the partial terms switched OFF.
const DEFAULT_TERMS = [
  { term_key: 'full', label: 'Full Payment — 100%', basis: 'percent', percent: 100, fixed_amount: null, retail_allowed: true, made_to_order_allowed: true, balance_condition: 'nothing further to pay', enabled: true, note: null },
  { term_key: 'half', label: 'Half Payment — 50%', basis: 'percent', percent: 50, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'balance due before release', enabled: false, note: null },
  { term_key: 'down', label: 'Down Payment — 30%', basis: 'percent', percent: 30, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'balance due before release', enabled: false, note: null },
  { term_key: 'custom', label: 'Custom partial payment', basis: 'percent', percent: null, fixed_amount: null, retail_allowed: false, made_to_order_allowed: false, balance_condition: 'as approved by Finance', enabled: false, note: null }
];

const PARENTS = {
  order: { table: 'orders', idCol: 'order_id', noCol: 'order_no', totalCol: 'total', label: 'Order' },
  quote: { table: 'quote_requests', idCol: 'quote_id', noCol: 'quote_no', totalCol: 'quoted_amount', label: 'Quote' }
};

/* Converting a quotation into an order re-files the money already taken on it: an 'out' row on the quotation and a
   matching 'in' row on the order (see moveQuotePaymentsToOrder). No cash arrives at that moment, it only changes which
   parent owns it — so a report that adds up money events has to skip both halves of the pair, or every payment made on
   a quotation before it became an order is counted twice. §10. */
const NOT_A_MOVE = `(p.request_id IS NULL OR (p.request_id NOT LIKE 'transfer:%' AND p.request_id NOT LIKE 'transfer-in:%'))`;

// "No service (as is)" / "None" — nothing is being fabricated, so the stock on the shelf is what is sold.
const NO_SERVICE_RE = /^(none|as is|n\/?a|no|standard)\b/i;

/* A quotation is treated as made-to-order when there is no finished-goods SKU to pull off the shelf, or when the
   request asked for a fabrication service (cut, bend, weld, paint, galvanise...). Ready stock stays retail.
   This classification only decides WHICH enabled terms may be offered; it never enables a term by itself. */
function isMadeToOrder(q) {
  if (!q) return false;
  if (!q.product_sku) return true;
  const service = String((q.specs && q.specs.service) || '').trim();
  return !!service && !NO_SERVICE_RE.test(service.toLowerCase());
}

module.exports = function mountPaymentTerms({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ = 'Asia/Manila' }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(String(v))) ? String(v) : null);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const cents = (n) => Math.round(Number(n) * 100);                          // compare money in centavos, never as floats
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ms = (d) => (d ? new Date(d).getTime() : undefined);
  const nc = () => app.locals.notifications;
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);

  /* ---------------- schema: the same statements as db/020_payment_terms.sql ---------------- */
  // Best effort, on every start, additive only. If the database user cannot create a trigger the columns still
  // come up, applyPayment() detects that and refuses to write instead of keeping its own running total.
  async function ensureSchema() {
    const run = async (sql, label) => { try { await require('./schema-retry')(() => pool.query(sql)); return true; } catch (err) { console.warn(`[payment-terms] ${label} failed:`, err.message); return false; } };
    await run(`CREATE TABLE IF NOT EXISTS payment_terms (
      term_key TEXT PRIMARY KEY CHECK (term_key IN ('full','half','down','custom')),
      label TEXT NOT NULL, basis TEXT NOT NULL DEFAULT 'percent' CHECK (basis IN ('percent','fixed')),
      percent NUMERIC(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent <= 100)),
      fixed_amount NUMERIC(14,2) CHECK (fixed_amount IS NULL OR fixed_amount > 0),
      retail_allowed BOOLEAN NOT NULL DEFAULT FALSE, made_to_order_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      balance_condition TEXT NOT NULL DEFAULT 'balance due before release',
      enabled BOOLEAN NOT NULL DEFAULT FALSE, enabled_by INT REFERENCES users(user_id), enabled_at TIMESTAMPTZ,
      note TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`, 'payment_terms');
    for (const t of DEFAULT_TERMS) {
      try {
        await pool.query(`INSERT INTO payment_terms (term_key,label,basis,percent,retail_allowed,made_to_order_allowed,balance_condition,enabled)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (term_key) DO NOTHING`,
          [t.term_key, t.label, t.basis, t.percent, t.retail_allowed, t.made_to_order_allowed, t.balance_condition, t.enabled]);
      } catch (err) { console.warn('[payment-terms] could not seed', t.term_key, ':', err.message); }
    }
    await run(`UPDATE payment_terms SET enabled = false, retail_allowed = false, made_to_order_allowed = false WHERE term_key = 'custom' AND enabled`, 'switch off custom partial payment');
    await run(`CREATE TABLE IF NOT EXISTS payments (
      payment_id BIGSERIAL PRIMARY KEY,
      paid_for TEXT NOT NULL CHECK (paid_for IN ('order','quote')),
      order_id INT REFERENCES orders(order_id), quote_id BIGINT REFERENCES quote_requests(quote_id),
      direction TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in','out')),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL CHECK (method IN ('Cash','Card','GCash','Maya','Bank transfer','Credit / debit card','Xendit')),
      purpose TEXT NOT NULL DEFAULT 'balance' CHECK (purpose IN ('initial','balance','refund','correction')),
      provider_ref TEXT, request_id TEXT, sale_id BIGINT, cash_shift_id BIGINT REFERENCES pos_cash_shifts(shift_id),
      tendered NUMERIC(14,2), change_given NUMERIC(14,2), reversed_of BIGINT REFERENCES payments(payment_id),
      note TEXT, received_by INT REFERENCES users(user_id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((paid_for = 'order' AND order_id IS NOT NULL AND quote_id IS NULL)
          OR (paid_for = 'quote' AND quote_id IS NOT NULL AND order_id IS NULL)),
      CHECK (tendered IS NULL OR (method = 'Cash' AND tendered >= COALESCE(change_given, 0))),
      CHECK (change_given IS NULL OR tendered IS NOT NULL),
      CHECK ((direction = 'in') = (reversed_of IS NULL)))`, 'payments');
    await run('CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_provider_ref ON payments (provider_ref) WHERE provider_ref IS NOT NULL', 'provider-ref index');
    await run('CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_request_id ON payments (paid_for, request_id) WHERE request_id IS NOT NULL', 'request-id index');
    await run('CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id, created_at) WHERE order_id IS NOT NULL', 'order index');
    await run('CREATE INDEX IF NOT EXISTS idx_payments_quote ON payments (quote_id, created_at) WHERE quote_id IS NOT NULL', 'quote index');
    await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0)", 'orders.paid_amount');
    await run("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_state IN ('unpaid','partially_paid','paid','partially_refunded','refunded'))", 'orders.payment_state');
    await run("ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_state IN ('unpaid','partially_paid','paid','partially_refunded','refunded'))", 'quote_requests.payment_state');
    await run(`CREATE OR REPLACE FUNCTION payment_state_for(IN p_net NUMERIC, IN p_total NUMERIC, IN p_refunded BOOLEAN)
      RETURNS TEXT AS $$ BEGIN
        IF p_net > 0 AND p_net >= p_total THEN RETURN 'paid'; END IF;
        IF p_net > 0 THEN RETURN CASE WHEN p_refunded THEN 'partially_refunded' ELSE 'partially_paid' END; END IF;
        RETURN CASE WHEN p_refunded THEN 'refunded' ELSE 'unpaid' END;
      END $$ LANGUAGE plpgsql`, 'state function');
    const trigger = await run(`CREATE OR REPLACE FUNCTION apply_payment_totals() RETURNS trigger AS $$
      DECLARE net NUMERIC; v_total NUMERIC; refunded BOOLEAN;
      BEGIN
        IF NEW.paid_for = 'order' THEN
          SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0), bool_or(p.direction = 'out' AND p.purpose = 'refund')
            INTO net, refunded FROM payments p WHERE p.order_id = NEW.order_id;
          v_total := COALESCE((SELECT o.total FROM orders o WHERE o.order_id = NEW.order_id), 0);
          UPDATE orders SET paid_amount = GREATEST(net, 0), payment_state = payment_state_for(GREATEST(net, 0), v_total, refunded)
           WHERE order_id = NEW.order_id;
        ELSE
          SELECT COALESCE(SUM(CASE WHEN p.direction = 'in' THEN p.amount ELSE -p.amount END), 0), bool_or(p.direction = 'out' AND p.purpose = 'refund')
            INTO net, refunded FROM payments p WHERE p.quote_id = NEW.quote_id;
          v_total := COALESCE((SELECT q.quoted_amount FROM quote_requests q WHERE q.quote_id = NEW.quote_id), 0);
          UPDATE quote_requests SET paid_amount = GREATEST(net, 0), payment_state = payment_state_for(GREATEST(net, 0), v_total, refunded)
           WHERE quote_id = NEW.quote_id;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`, 'ledger trigger');
    if (trigger) {
      await run('DROP TRIGGER IF EXISTS trg_apply_payment_totals ON payments', 'drop old ledger trigger');
      await run(`CREATE TRIGGER trg_apply_payment_totals AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION apply_payment_totals()`, 'attach ledger trigger');
    }
    await run('CREATE OR REPLACE FUNCTION block_payment_changes() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'payments is append-only\'; END $$ LANGUAGE plpgsql', 'append-only function');
    await run('DROP TRIGGER IF EXISTS trg_payments_immutable ON payments', 'drop old immutability trigger');
    await run('CREATE TRIGGER trg_payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION block_payment_changes()', 'attach immutability trigger');

    // the terms a quotation carries, and the terms a customer chose at checkout
    for (const col of ['terms_key TEXT', 'terms_percent NUMERIC(5,2)', 'terms_amount NUMERIC(14,2)', 'terms_balance NUMERIC(14,2)',
      'terms_condition TEXT', 'terms_availability TEXT', 'terms_decided_by INT REFERENCES users(user_id)', 'terms_decided_at TIMESTAMPTZ',
      'terms_customer_seen_at TIMESTAMPTZ'])
      await run(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ${col}`, 'quote terms column');
    await run("ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS terms_state TEXT NOT NULL DEFAULT 'none' CHECK (terms_state IN ('none','proposed','approved','rejected'))", 'quote terms_state');
    for (const col of ['terms_key TEXT', 'terms_percent NUMERIC(5,2)', 'terms_amount NUMERIC(14,2)', 'terms_condition TEXT', 'terms_approved_by INT REFERENCES users(user_id)'])
      await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col}`, 'order terms column');
    // §8: the only way an order with money still outstanding can be released — Finance grants it, by name, with a reason.
    for (const col of ['credit_exception_by INT REFERENCES users(user_id)', 'credit_exception_note TEXT', 'credit_exception_at TIMESTAMPTZ'])
      await run(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col}`, 'order credit exception column');
    await run('CREATE INDEX IF NOT EXISTS idx_orders_payment_state ON orders (payment_state, created_at DESC)', 'orders state index');
    await run('CREATE INDEX IF NOT EXISTS idx_quotes_payment_state ON quote_requests (payment_state, updated_at DESC)', 'quotes state index');
    // One place for the Finance screens and the reports to read, so a down payment can never be counted as an extra sale.
    await run(`CREATE OR REPLACE VIEW v_receivables AS
      SELECT o.order_id, o.order_no, o.customer_id, o.status AS fulfilment_status, o.payment_status AS invoice_status,
             o.payment_state, o.terms_key, o.total AS order_value, o.paid_amount AS collected,
             GREATEST(o.total - o.paid_amount, 0) AS outstanding, o.created_at, o.status_updated_at
        FROM orders o WHERE o.status <> 'Cancelled'`, 'receivables view');
    await run(`CREATE OR REPLACE VIEW v_receivable_quotes AS
      SELECT q.quote_id, q.quote_no, q.customer_id, q.status, q.payment_state, q.terms_key, q.terms_percent,
             q.quoted_amount AS quoted_value, q.paid_amount AS collected,
             GREATEST(COALESCE(q.quoted_amount, 0) - q.paid_amount, 0) AS outstanding, q.updated_at
        FROM quote_requests q
       WHERE q.quoted_amount IS NOT NULL AND q.converted_order_id IS NULL
         AND q.status IN ('accepted','preparing','ready')`, 'quote receivables view');
  }
  const ready = ensureSchema().catch(() => {});

  // Is the database keeping paid_amount in step for us? Checked once, after the schema pass; if the trigger is
  // missing (a restricted database user) every write through this module refuses to run rather than keep a second,
  // disagreeing total in application code.
  let triggerLive = null;
  async function ledgerOwnsTotals(client) {
    if (triggerLive === true) return true;                 // only a positive answer is remembered: a failed check is retried, never cached
    let live = false;
    try {
      // pg_trigger.tgisinternal marks the triggers PostgreSQL creates itself (foreign keys); ours is a normal one
      const { rows } = await (client || pool).query(`SELECT COUNT(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'payments' AND t.tgname = 'trg_apply_payment_totals' AND NOT t.tgisinternal`);
      live = Number(rows[0] && rows[0].n) > 0;
    } catch (err) { console.warn('[payment-terms] could not check the ledger trigger:', err.message); }
    if (!live) console.error('[payment-terms] trg_apply_payment_totals is missing: run backend/db/020_payment_terms.sql — payments are refused until then.');
    triggerLive = live ? true : null;
    return live;
  }

  app.use('/api/finance/payment-terms', (req, res, next) => { ready.then(() => next(), next); });
  app.use('/api/finance/payment-report', (req, res, next) => { ready.then(() => next(), next); });
  app.use('/api/pos/payment-terms', (req, res, next) => { ready.then(() => next(), next); });
  app.use('/api/finance/payment-ledger', (req, res, next) => { ready.then(() => next(), next); });

  /* ---------------- the policy table ---------------- */
  const json = (t) => ({
    key: t.term_key, label: t.label, basis: t.basis, percent: t.percent == null ? null : +t.percent,
    fixedAmount: t.fixed_amount == null ? null : +t.fixed_amount,
    retailAllowed: t.retail_allowed === true, madeToOrderAllowed: t.made_to_order_allowed === true,
    balanceCondition: t.balance_condition || '', enabled: t.enabled === true,
    enabledBy: t.enabled_by_name || undefined, enabledAt: ms(t.enabled_at) || undefined, note: t.note || undefined
  });

  async function termRows(db) {
    await ready;
    try {
      const { rows } = await (db || pool).query(
        `SELECT pt.*, u.full_name AS enabled_by_name FROM payment_terms pt LEFT JOIN users u ON u.user_id = pt.enabled_by
          ORDER BY CASE pt.term_key WHEN 'full' THEN 0 WHEN 'half' THEN 1 WHEN 'down' THEN 2 ELSE 3 END`);
      if (rows.length) return rows;
      console.warn('[payment-terms] payment_terms is empty — only Full Payment is offered until Finance configures the rest.');
    } catch (err) { console.warn('[payment-terms] could not read payment_terms — falling back to the built-in policy:', err.message); }
    return DEFAULT_TERMS;
  }
  // "Custom partial payment" was removed: Finance only works with Full / Half / Down payment. Older records that used it still read correctly.
  const REMOVED_TERMS = ['custom'];
  const listTerms = async (db) => (await termRows(db)).filter((t) => !REMOVED_TERMS.includes(t.term_key)).map(json);

  /* The terms a customer or cashier may be offered for one purchase.
     'custom' is never returned here: a custom percentage is attached by Finance, not picked at the counter.
     fullOnly is what happens when the ledger cannot be trusted — never offer a partial term the maths is not keeping. */
  async function optionsFor({ madeToOrder = false, total = 0, db } = {}) {
    const rows = await termRows(db);
    const out = [];
    for (const t of rows) {
      if (t.term_key === 'custom' || t.enabled !== true) continue;
      if (!(madeToOrder ? t.made_to_order_allowed : t.retail_allowed)) continue;
      out.push({ ...json(t), ...amountFor(t, total) });
    }
    return out.sort((a, b) => (b.percent || 0) - (a.percent || 0));
  }

  /* Amounts for a policy against a total. Always recomputed server-side; a screen never sends these back as truth. */
  function amountFor(t, total) {
    const value = round2(Number(total) || 0);
    if (!(value > 0)) return { percent: null, dueNow: null, balance: null };
    if (t.basis === 'fixed') {
      const due = Math.min(round2(Number(t.fixed_amount) || 0), value);
      return { percent: due > 0 ? round2((due / value) * 100) : 0, dueNow: due, balance: round2(value - due) };
    }
    const pct = Math.max(0, Math.min(100, Number(t.percent) || 0));
    const due = pct >= 100 ? value : round2(value * pct / 100);
    return { percent: pct, dueNow: due, balance: round2(value - due) };
  }

  /* Terms as a screen should show them, from a row of quote_requests or orders. */
  function quoteTerms(q) {
    if (!q || !q.terms_key) return null;
    const total = q.quoted_amount != null ? round2(+q.quoted_amount) : (q.total != null ? round2(+q.total) : null);
    return {
      key: q.terms_key, percent: q.terms_percent == null ? null : +q.terms_percent,
      amount: q.terms_amount == null ? null : round2(+q.terms_amount),
      balance: q.terms_balance == null ? (total == null || q.terms_amount == null ? null : round2(total - +q.terms_amount)) : round2(+q.terms_balance),
      condition: q.terms_condition || undefined, availability: q.terms_availability || undefined,
      state: q.terms_state || 'none', decidedBy: q.terms_decided_by_name || undefined, decidedAt: ms(q.terms_decided_at) || undefined,
      seenAt: ms(q.terms_customer_seen_at) || undefined, total
    };
  }
  // A partial term only counts once Finance has approved it. Until then everything is Full Payment.
  const approvedDueOf = (q) => {
    const t = quoteTerms(q);
    if (!t || t.state !== 'approved' || t.key === 'full' || t.amount == null) return null;
    return t;
  };

  /* The parent's own money columns, read straight after the trigger has run. Screens never add the ledger rows up
     themselves, so every route that touches money answers with this shape. */
  async function readParent(client, P, id) {
    if (id == null) return null;
    const r = (await client.query(`SELECT ${P.noCol} AS no, ${P.totalCol} AS total, paid_amount, payment_state FROM ${P.table} WHERE ${P.idCol} = $1`, [id])).rows[0];
    if (!r) return null;
    const total = round2(Number(r.total) || 0), paid = round2(Number(r.paid_amount) || 0);
    return { id, no: r.no, total, paid, state: r.payment_state, balance: round2(Math.max(0, total - paid)) };
  }

  // A retried request returns the row that exists plus the parent's current totals — the caller shows the same numbers it would for a fresh payment.
  async function asReplay(client, P, seen) {
    return { payment: seen, paymentId: Number(seen.payment_id), amount: round2(+seen.amount), direction: seen.direction,
      method: seen.method, purpose: seen.purpose, tendered: seen.tendered == null ? null : round2(+seen.tendered),
      change: seen.change_given == null ? null : round2(+seen.change_given), parent: await readParent(client, P, seen[P.idCol]), replayed: true };
  }

  /* ---------------- the one way money enters the ledger ----------------
     applyPayment(client, {
       kind:'quote'|'order', no|id,                    which order / quotation the money is for
       amount, method, note, actor,                    what was received and who took it
       requestId?, providerRef?,                       idempotency: a retry adds nothing
       saleId?, cashShiftId?, tendered?,               POS receipt / cash drawer context
       direction?, reversedOf?, purpose?               'out' + reversedOf = a refund of a recorded payment
       allowOver?                                      only for money already captured online — see below
     }) -> { payment, parent:{id,no,total,paid,balance,state}, replayed }
     Locks the parent row, refuses 0/negative amounts, unknown methods, overpayment, and duplicate references.     */
  async function applyPayment(client, spec) {
    const kind = spec.kind, key = spec.no != null ? spec.no : spec.id;
    const P = PARENTS[kind];
    if (!P) throw bad('kind', 'Unknown payment target');
    if (key == null || key === '') throw bad('id', P.label + ' not found');
    const amount = round2(Number(spec.amount));
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) throw bad('amount', 'Enter a valid amount greater than 0');
    const method = str(spec.method);
    if (!METHODS.includes(method)) throw bad('method', 'Choose how it was paid');
    const direction = spec.direction === 'out' ? 'out' : 'in';
    const purposeReq = str(spec.purpose);
    if (purposeReq && !PURPOSES.includes(purposeReq)) throw bad('purpose', 'Unknown payment purpose');
    const requestId = str(spec.requestId) || null, providerRef = str(spec.providerRef) || null, note = str(spec.note).slice(0, 200) || null;
    if (requestId && !REQUEST_ID_RE.test(requestId)) throw bad('requestId', 'The payment reference must be 12-100 letters, digits or dashes');
    if (direction === 'out' && !spec.reversedOf) throw bad('reversedOf', 'A refund must point at the payment it reverses');

    // A retry of the same request, or the same provider invoice arriving twice, returns the row that already exists.
    if (requestId) {
      const seen = (await client.query(`SELECT * FROM payments WHERE paid_for = $1 AND request_id = $2`, [kind, requestId])).rows[0];
      if (seen) return await asReplay(client, P, seen);
    }
    if (providerRef) {
      const seen = (await client.query(`SELECT * FROM payments WHERE provider_ref = $1`, [providerRef])).rows[0];
      if (seen) {
        // the same provider event arriving twice for the SAME order / quote is a replay; on another one it is a reused reference
        const mine = seen.paid_for === kind && String(spec.no != null
          ? (await client.query(`SELECT ${P.noCol} AS no FROM ${P.table} WHERE ${P.idCol} = $1`, [seen[kind === 'order' ? 'order_id' : 'quote_id']])).rows.map((r) => r.no)[0]
          : seen[kind === 'order' ? 'order_id' : 'quote_id']) === String(key);
        if (!mine) throw bad('reference', 'That reference number is already recorded on another payment. Check the reference and try again');
        return await asReplay(client, P, seen);
      }
    }

    const findCol = spec.no != null ? P.noCol : P.idCol;
    const cur = (await client.query(`SELECT * FROM ${P.table} WHERE ${findCol} = $1 FOR UPDATE`, [key])).rows[0];
    if (!cur) throw bad('id', P.label + ' not found');
    if (!(await ledgerOwnsTotals(client))) throw bad('ledger', 'The payment ledger is not set up on this database yet. Ask IT to run backend/db/020_payment_terms.sql');

    const total = round2(Number(cur[P.totalCol]) || 0), paid = round2(Number(cur.paid_amount) || 0);
    const balance = round2(total - paid);
    if (direction === 'in') {
      if (!(total > 0)) throw bad('amount', P.label + ' has no amount to pay yet');
      // A cashier must never be able to take more than what is owed. Money already captured online is different:
      // it is in the account, so it is recorded as it is and Finance refunds the difference.
      if (cents(amount) > cents(balance) && !spec.allowOver) throw bad('amount', `The balance is only ${peso(balance)}`);
    } else {
      if (cents(amount) > cents(paid)) throw bad('amount', `Only ${peso(paid)} was received on this ${P.label.toLowerCase()}, so that is the most that can be refunded`);
      // One payment can be refunded at most once, in parts: what was already given back for it counts against it.
      const original = (await client.query('SELECT payment_id, amount FROM payments WHERE payment_id = $1', [Number(spec.reversedOf)])).rows[0];
      if (!original) throw bad('reversedOf', 'The payment being refunded is not in the ledger');
      const already = round2(Number((await client.query('SELECT COALESCE(SUM(amount), 0) AS refunded FROM payments WHERE reversed_of = $1', [Number(spec.reversedOf)])).rows[0].refunded));
      if (cents(amount) > cents(round2(Number(original.amount) - already)))
        throw bad('amount', already > 0
          ? `That payment was ${peso(already)} of refunds already — only ${peso(round2(Number(original.amount) - already))} of it is left to give back`
          : `That payment of ${peso(original.amount)} has already been refunded in full`);
    }

    let tendered = null, change = null;
    if (method === 'Cash' && spec.tendered != null && String(spec.tendered).trim() !== '') {
      tendered = round2(Number(spec.tendered));
      if (!Number.isFinite(tendered) || tendered < amount) throw bad('tendered', `Tendered cash must be at least ${peso(amount)}`);
      change = round2(tendered - amount);
    }

    const purpose = purposeReq || (direction === 'out' ? 'refund' : (paid > 0 ? 'balance' : 'initial'));
    const col = kind === 'order' ? 'order_id' : 'quote_id';
    const ins = await client.query(
      `INSERT INTO payments (paid_for, ${col}, direction, amount, method, purpose, provider_ref, request_id, sale_id, cash_shift_id,
                             tendered, change_given, reversed_of, note, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [kind, cur[P.idCol], direction, amount, method, purpose, providerRef, requestId,
       spec.saleId == null ? null : Number(spec.saleId), spec.cashShiftId == null ? null : Number(spec.cashShiftId),
       tendered, change, spec.reversedOf == null ? null : Number(spec.reversedOf), note,
       spec.actor && spec.actor.id != null ? spec.actor.id : null]);
    const payment = ins.rows[0];

    const parent = await readParent(client, P, cur[P.idCol]);
    if (!parent) throw bad('id', P.label + ' not found');
    // The trigger owns paid_amount / payment_state; the totals above are what it just computed, read back for the caller and the audit line.
    await audit(client, spec.actor || { id: null, name: spec.actorName || 'System', roleLabel: 'System' },
      direction === 'in' ? 'Record added' : 'Record edited',
      `${P.label} ${parent.no}: ${direction === 'in' ? 'payment of' : 'refund of'} ${peso(amount)} (${method}${purpose === 'initial' ? ', initial payment' : purpose === 'balance' ? ', balance' : ''})` +
      (direction === 'in' ? (parent.balance <= 0 ? ' — fully paid' : ` — balance ${peso(parent.balance)}`) : '') +
      (note ? ` (${note})` : ''));
    return { payment, paymentId: Number(payment.payment_id), amount, direction, method, purpose, tendered, change, parent, replayed: false };
  }

  /* ---------------- quotation -> order hand-over ----------------
     When an accepted quotation that already collected money is converted into an order, the money has to move with it:
     otherwise the customer pays the balance twice. The ledger is append-only, so a move is a matching pair of rows —
     an 'out' on the quotation (reversing each payment, purpose 'correction') and an 'in' on the order for the same
     amount, method and provider reference. Deterministic request ids make a retried conversion insert nothing.
     These inserts bypass applyPayment() on purpose: no money arrived here, it only changed which parent it belongs to. */
  async function moveQuotePaymentsToOrder(client, { quoteId, quoteNo, orderId, orderNo, actor }) {
    const rows = (await client.query(
      `SELECT p.* FROM payments p
        WHERE p.paid_for = 'quote' AND p.quote_id = $1 AND p.direction = 'in'
          AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.paid_for = 'order' AND x.request_id = 'transfer-in:' || p.payment_id)
        ORDER BY p.payment_id`, [quoteId])).rows;
    if (!rows.length) return { moved: 0, total: 0 };
    let sum = 0;
    for (const p of rows) {
      const paidOnOrder = (await client.query('SELECT paid_amount FROM orders WHERE order_id = $1 FOR UPDATE', [orderId])).rows[0];
      await client.query(`INSERT INTO payments (paid_for, quote_id, direction, amount, method, purpose, request_id, reversed_of, note, received_by)
        VALUES ('quote', $1, 'out', $2, $3, 'correction', $4, $5, $6, $7)`,
        [quoteId, p.amount, p.method, 'transfer:' + p.payment_id, p.payment_id, `Payment moved to order ${orderNo}`, actor && actor.id != null ? actor.id : null]);
      await client.query(`INSERT INTO payments (paid_for, order_id, direction, amount, method, purpose, provider_ref, request_id, note, received_by)
        VALUES ('order', $1, 'in', $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, p.amount, p.method, round2(Number(paidOnOrder && paidOnOrder.paid_amount) || 0) > 0 ? 'balance' : 'initial',
         p.provider_ref, 'transfer-in:' + p.payment_id, `Payment made on quotation ${quoteNo}`, actor && actor.id != null ? actor.id : null]);
      sum = round2(sum + Number(p.amount));
    }
    // the quotation's own display copy says where its payments went, so the quote screen never shows money that left
    const moved = new Set(rows.map((p) => Number(p.payment_id)));
    const display = (await client.query('SELECT payments FROM quote_requests WHERE quote_id = $1', [quoteId])).rows[0];
    const pays = Array.isArray(display && display.payments) ? display.payments : [];
    if (pays.some((e) => moved.has(Number(e.id)))) await client.query(`UPDATE quote_requests SET payments = $2::jsonb WHERE quote_id = $1`,
      [quoteId, JSON.stringify(pays.map((e) => (moved.has(Number(e.id)) ? { ...e, movedTo: orderNo } : e)))]);
    await audit(client, actor || { id: null, name: 'System', roleLabel: 'System' }, 'Record edited',
      `${peso(sum)} of payments on quote ${quoteNo} moved to order ${orderNo}`);
    return { moved: rows.length, total: sum };
  }

  /* The approved terms travel with the quotation into the order they became. Full Payment (and any quote from before
     this feature, which has no terms at all) leaves the columns NULL: the order is simply payable in full. */
  async function inheritTerms(client, { quote, orderId, actor }) {
    if (!quote || !quote.terms_key || quote.terms_state !== 'approved' || quote.terms_key === 'full') return null;
    const r = await client.query(`UPDATE orders SET terms_key = $2, terms_percent = $3, terms_amount = $4, terms_condition = $5, terms_approved_by = $6
           WHERE order_id = $1 RETURNING order_id, terms_key, terms_percent, terms_amount, terms_condition`,
      [orderId, quote.terms_key, quote.terms_percent, quote.terms_amount, quote.terms_condition, quote.terms_decided_by || (actor && actor.id)]);
    return r.rows[0] || null;
  }

  /* The confirmed money events on one parent, newest last. Screens read balances from the parent columns, never by
     adding these rows up in the browser. */
  async function ledgerFor(db, { kind, no }) {
    const P = PARENTS[kind];
    if (!P) throw bad('kind', 'Unknown payment target');
    const { rows } = await db.query(
      `SELECT p.*, u.full_name AS received_by_name, r.amount AS reversed_amount
         FROM payments p LEFT JOIN users u ON u.user_id = p.received_by LEFT JOIN payments r ON r.payment_id = p.reversed_of
        WHERE p.paid_for = $1 AND p.${P.idCol} = (SELECT ${P.idCol} FROM ${P.table} WHERE ${P.noCol} = $2)
        ORDER BY p.created_at, p.payment_id`, [kind, no]);       // payments holds the parent's id, not its order / quote number
    return rows.map((p) => ({
      id: Number(p.payment_id), direction: p.direction, amount: round2(+p.amount), method: p.method, purpose: p.purpose,
      providerRef: p.provider_ref || undefined, requestId: p.request_id || undefined, saleId: p.sale_id == null ? undefined : Number(p.sale_id),
      cashShiftId: p.cash_shift_id == null ? undefined : Number(p.cash_shift_id),
      tendered: p.tendered == null ? undefined : round2(+p.tendered), changeGiven: p.change_given == null ? undefined : round2(+p.change_given),
      reversedOf: p.reversed_of == null ? undefined : Number(p.reversed_of), note: p.note || undefined,
      receivedBy: p.received_by_name || undefined, at: ms(p.created_at)
    }));
  }

  /* ---------------- Finance: the policy screen ---------------- */
  app.get('/api/finance/payment-terms', auth('finance'), wrap(async (req, res) => {
    const rows = await listTerms();
    const live = await ledgerOwnsTotals(null);
    let receivables = null;
    if (live) {
      try {
        receivables = (await pool.query(`SELECT COUNT(*)::int AS open_orders, COALESCE(SUM(outstanding), 0) AS outstanding
                                           FROM v_receivables WHERE outstanding > 0`)).rows[0];
        receivables = { openOrders: Number(receivables.open_orders), outstanding: round2(Number(receivables.outstanding)) };
      } catch (err) { console.warn('[payment-terms] could not read v_receivables:', err.message); }
    }
    res.json({ terms: rows, ledgerReady: live, receivables });
  }));

  app.post('/api/finance/payment-terms/:key', auth('finance'), wrap(async (req, res) => {
    const key = str(req.params.key);
    if (!TERMS.includes(key) || REMOVED_TERMS.includes(key)) throw bad('key', key === 'custom' ? 'Custom partial payment is no longer offered' : 'Unknown payment term');
    const b = req.body || {};
    const current = (await termRows()).find((t) => t.term_key === key);
    if (!current) throw bad('key', 'Payment term not found');

    const on = (v) => v === true || v === 'true' || v === 1 || v === '1';
    const flag = (v, d) => (v === undefined || v === null || v === '' ? d : on(v));
    const enabled = on(b.enabled);
    let percent = current.percent == null ? null : +current.percent, fixed = current.fixed_amount == null ? null : +current.fixed_amount;
    const basis = ['percent', 'fixed'].includes(str(b.basis)) ? str(b.basis) : current.basis;
    if (b.percent !== undefined && String(b.percent).trim() !== '') {
      const raw = String(b.percent).replace(/[,\s%]/g, '');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw bad('percent', 'Enter the percentage as a number, e.g. 30');
      percent = Number(raw); fixed = null;
      if (!(key === 'full' ? percent === 100 : percent > 0 && percent < 100)) throw bad('percent', key === 'full' ? 'Full Payment is always 100%' : 'A partial payment must be more than 0% and less than 100%');
    }
    if (b.fixedAmount !== undefined && String(b.fixedAmount).trim() !== '') {
      const raw = String(b.fixedAmount).replace(/[,₱\s]/g, '');
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) throw bad('fixedAmount', 'Enter a fixed amount in pesos, e.g. 5000');
      fixed = round2(Number(raw)); percent = null;
      if (!(fixed > 0)) throw bad('fixedAmount', 'Enter an amount greater than 0');
    }
    if (key === 'custom' && fixed != null) throw bad('fixedAmount', 'A custom payment is agreed as a percentage of each quote');
    // 'full' has no percentage choice: whatever is stored, it must stay 100% / the whole amount.
    if (key === 'full') { percent = 100; fixed = null; }
    const retail = flag(b.retailAllowed, current.retail_allowed === true);
    const mto = flag(b.madeToOrderAllowed, current.made_to_order_allowed === true);
    const condition = str(b.balanceCondition).slice(0, 120) || current.balance_condition;
    const note = str(b.note).slice(0, 300);
    if (note.length > 0 && note.length < 3) throw bad('note', 'Write at least 3 characters, or leave the note empty');
    // Switching a partial term on without a scope is meaningless — it would never be offered anywhere.
    if (enabled && key !== 'full' && !retail && !mto) throw bad('scope', 'Choose which orders this term applies to before switching it on');

    const row = await tx(async (client) => {
      const r = await client.query(`UPDATE payment_terms SET basis=$2, percent=$3, fixed_amount=$4, retail_allowed=$5, made_to_order_allowed=$6,
              balance_condition=$7, enabled=$8, enabled_by=CASE WHEN $8::boolean THEN $9::int ELSE enabled_by END,
              enabled_at=CASE WHEN $8::boolean THEN now() ELSE enabled_at END, note=$10, updated_at=now()
             WHERE term_key=$1 RETURNING *`,
        [key, basis, percent, fixed, retail, mto, condition, enabled, req.user.id, note || null]);
      await audit(client, req.user, 'Record edited',
        `Payment term ${key}: ${enabled ? 'switched ON' : 'switched off'} — ${basis === 'fixed' ? 'fixed ' + peso(fixed || 0) : (percent || 0) + '%'}${key === 'full' ? '' : `, ${[retail && 'ready stock', mto && 'made-to-order'].filter(Boolean).join(' + ') || 'nowhere'}`}`);
      return r.rows[0];
    });
    const joined = await pool.query(`SELECT pt.*, u.full_name AS enabled_by_name FROM payment_terms pt LEFT JOIN users u ON u.user_id = pt.enabled_by WHERE pt.term_key = $1`, [key]);
    res.json({ ok: true, term: json(joined.rows[0] || row) });
    if (enabled && key !== 'full') Promise.resolve(pingFinance({ category: 'system', title: 'A payment term is now live',
      body: `${row.label} is switched on for ${[retail && 'ready stock', mto && 'made-to-order'].filter(Boolean).join(' and ') || 'no order type'}.`,
      link: 'Finance_Inventory.html#payment-terms', entityType: 'payment_term', entityId: key })).catch(() => {});
  }));

  /* ---------------- what may be offered ---------------- */
  app.get('/api/pos/payment-terms', auth('cashier'), wrap(async (req, res) => {
    const madeToOrder = str(req.query.madeToOrder) === 'true' || str(req.query.kind) === 'made_to_order';
    const raw = String(req.query.total == null ? '' : req.query.total).replace(/[,₱\s]/g, '');
    const total = raw ? Number(raw) : 0;
    res.json({ options: await optionsFor({ madeToOrder, total }), madeToOrder, total: total > 0 ? round2(total) : null });
  }));

  /* ---------------- quotation payment terms (§2) ----------------
     The cashier attaches terms while pricing, before the quotation is sent. Nothing here takes money: a quotation
     that is still pending has no payment, and the ledger stays empty until the customer accepts. */
  const TERMS_SETTABLE = ['new', 'awaiting_details', 'pending_approval', 'quoted'];
  async function readTermsBody(client, q, b, { actorIsFinance }) {
    const total = round2(Number(q.quoted_amount != null ? q.quoted_amount : q.proposed_amount) || 0);
    if (!(total > 0)) throw bad('amount', 'Set the price before choosing payment terms');
    const key = str(b.termKey);
    if (!TERMS.includes(key)) throw bad('termKey', 'Choose a payment term');
    if (REMOVED_TERMS.includes(key)) throw bad('termKey', 'Custom partial payment is no longer offered. Choose Full, Half or Down Payment');
    const policy = (await termRows(client)).find((t) => t.term_key === key);
    if (!policy) throw bad('termKey', 'Payment term not found');
    if (key === 'custom' && !actorIsFinance) throw bad('termKey', 'A custom payment percentage is set by Finance — send the quotation for approval instead');
    if (key !== 'full' && policy.enabled !== true) throw bad('termKey', `${policy.label} is not switched on. Ask Finance to enable it in Sales > Payment terms`);
    // Which order types a term covers is Finance's setting too. A cashier can only offer what that policy allows;
    // Finance may grant an exception on one quotation (§9), which is recorded with their name in terms_decided_by.
    const mto = isMadeToOrder(q);
    if (!actorIsFinance && key !== 'full' && !(mto ? policy.made_to_order_allowed : policy.retail_allowed))
      throw bad('termKey', `${policy.label} is not authorised for ${mto ? 'made-to-order' : 'ready-stock'} requests. Finance chooses which order types each term covers`);

    let percent = policy.percent == null ? null : +policy.percent;
    if (key === 'custom') {
      const raw = String(b.percent == null ? '' : b.percent).replace(/[,\s%]/g, '');
      if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw bad('percent', 'Enter the percentage as a number, e.g. 40');
      percent = Number(raw);
      if (!(percent > 0 && percent < 100)) throw bad('percent', 'A custom payment must be more than 0% and less than 100%');
    }
    if (key === 'full') percent = 100;
    const due = percent >= 100 ? total : round2(total * percent / 100);
    if (!(due > 0 && due <= total)) throw bad('percent', 'The initial payment must be part of the quoted amount');
    // when the balance is due: a step of the order flow from a fixed list (Finance may word one quotation differently)
    const BALANCE_DUE = ['balance due before release', 'balance due before pickup', 'balance due before delivery', 'balance due before production starts'];
    let condition = key === 'full' ? 'nothing further to pay' : str(b.condition).slice(0, 120) || policy.balance_condition;
    if (!actorIsFinance && key !== 'full' && !BALANCE_DUE.includes(condition) && condition !== policy.balance_condition)
      throw bad('condition', 'Choose when the balance is due from the list');
    const availability = str(b.availability).slice(0, 120) || q.lead_time || null;
    return { key, percent, due, balance: round2(total - due), condition, availability,
      label: policy.label, note: str(b.note).slice(0, 300) };
  }
  const termsSql = async (client, q, t, { state, user, note }) => {
    const decided = ['approved', 'rejected'].includes(state) ? user.id : null;
    const r = await client.query(`UPDATE quote_requests SET terms_key=$2, terms_percent=$3, terms_amount=$4, terms_balance=$5, terms_condition=$6,
            terms_availability=$7, terms_state=$8, terms_decided_by=$9, terms_decided_at=CASE WHEN $9::int IS NULL THEN terms_decided_at ELSE now() END,
            updated_at=now() WHERE quote_id=$1 RETURNING *`,
      [q.quote_id, t.key, t.percent, t.due, t.balance, t.condition, t.availability, state, decided]);
    await audit(client, user, 'Record edited', `Quote ${q.quote_no}: payment terms ${state} — ` +
      `${t.percent}% now (${peso(t.due)}), balance ${peso(t.balance)}, ${t.condition}` + (note ? ` — ${note}` : ''));
    return r.rows[0];
  };

  app.post('/api/pos/quotes/:no/terms', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (!TERMS_SETTABLE.includes(cur.status)) throw bad('status', 'The terms of a quotation can only be set before the customer accepts it');
      if (round2(Number(cur.paid_amount) || 0) > 0) throw bad('payment', 'A payment has already been recorded, so these terms are fixed');
      const t = await readTermsBody(client, cur, b, { actorIsFinance: false });
      const out = await termsSql(client, cur, t, { state: t.key === 'full' ? 'approved' : 'proposed', user: req.user, note: t.note });
      return { cur, t, out };
    });
    // A partial term the cashier proposed still has to be signed by Finance before it can be used.
    if (q.out.terms_state === 'proposed') Promise.resolve(pingFinance({ category: 'quote', title: 'Payment terms to approve',
      body: `${q.cur.quote_no}: ${q.t.percent}% (${peso(q.t.due)}) now, ${peso(q.t.balance)} balance.`, link: 'Finance_Inventory.html#payment-terms',
      entityType: 'quote', entityId: q.cur.quote_no })).catch(() => {});
    res.json({ ok: true, terms: quoteTerms(q.out) });
  }));

  app.post('/api/finance/quotes/:no/terms', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, action = str(b.action) || 'approve';
    if (!['approve', 'refuse'].includes(action)) throw bad('action', 'Choose approve or refuse');
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (round2(Number(cur.paid_amount) || 0) > 0 && action === 'refuse') throw bad('payment', 'A payment has already been recorded against these terms — settle the difference instead of changing them');
      if (!TERMS_SETTABLE.concat('accepted', 'preparing', 'ready').includes(cur.status)) throw bad('status', 'This quotation is closed and its terms cannot be changed');
      if (action === 'refuse') {
        if (!cur.terms_key) throw bad('terms', 'There are no proposed terms to refuse');
        const total = round2(Number(cur.quoted_amount != null ? cur.quoted_amount : cur.proposed_amount) || 0);
        if (!(total > 0)) throw bad('amount', 'Set the quoted amount before refusing the proposed terms');
        const full = { key: 'full', percent: 100, due: total, balance: 0, condition: 'nothing further to pay',
          availability: cur.lead_time || null, label: 'Full Payment — 100%', note: str(b.note).slice(0, 300) };
        return { out: await termsSql(client, cur, full, { state: 'approved', user: req.user, note: full.note || 'proposed terms refused' }), refused: true };
      }
      const t = await readTermsBody(client, cur, b, { actorIsFinance: true });
      return { out: await termsSql(client, cur, t, { state: 'approved', user: req.user, note: t.note }), refused: false };
    });
    res.json({ ok: true, terms: quoteTerms(q.out) });
    Promise.resolve((nc() && q.out.customer_id ? nc().notifyUser(q.out.customer_id, {
      category: 'quote', title: q.refused ? 'Payment terms for your quote' : 'Payment terms approved',
      body: `${q.out.quote_no}: ${q.out.terms_percent}% of ${peso(q.out.quoted_amount)} now, balance ${peso(q.out.terms_balance)}. ${q.out.terms_condition || ''}`.trim(),
      link: 'Shop_Customer.html', entityType: 'quote', entityId: q.out.quote_no }, 'customer') : null)).catch(() => {});
  }));

  /* ---------------- the money picture of one order ----------------
     §3 / §4 / §5: every screen and every release gate reads these numbers instead of working out their own.
     dueNow is the amount an online invoice may ask for: while the initial payment of an approved partial term is
     still short it is only that remainder, never the whole order. Once the initial is in, the rest is the balance
     the term's own condition says when it is due. A 'full' order has no partial term, so dueNow is simply the
     outstanding balance — which is what it was before this feature existed.                             */
  function orderMoney(o) {
    if (!o) return null;
    const total = round2(Number(o.total) || 0);
    const paid = round2(Number(o.paid_amount) || 0);
    const balance = round2(Math.max(0, total - paid));
    const partial = o.terms_key && o.terms_key !== 'full';
    let initial = balance;
    if (partial) {
      const fromRow = o.terms_amount == null ? null : round2(Number(o.terms_amount));
      initial = fromRow != null && fromRow > 0 ? fromRow : round2(total * (Number(o.terms_percent) || 100) / 100);
    }
    /* Cash on delivery / pickup with an ADVANCE paid online first: the delivery fee plus a down payment (COD) or the down payment (COP).
       That advance is what is "due now"; the rest is cash at the door or the counter. */
    const advance = /^Cash on /.test(o.payment_method || '') && Number(o.advance_amount) > 0 ? round2(Math.min(Number(o.advance_amount), total)) : 0;
    if (advance && !partial) initial = advance;
    initial = round2(Math.min(Math.max(initial, 0), total));
    const dueNow = cents(paid) < cents(initial) ? round2(initial - paid) : balance;
    return { key: o.terms_key || 'full', percent: o.terms_percent == null ? 100 : +o.terms_percent,
      initial, dueNow, balance, total, paid, state: o.payment_state || 'unpaid',
      advance: advance ? (() => {
        // COD: delivery fee + down payment; COP: the down payment. The label is what every screen and message calls it.
        const fee = o.advance_kind === 'shipping_fee' ? round2(Math.min(Number(o.delivery_fee) || 0, advance)) : 0, deposit = round2(advance - fee);
        const label = o.advance_kind === 'shipping_fee' ? (deposit > 0 ? (fee > 0 ? 'delivery fee and down payment' : 'down payment') : 'delivery fee') : 'down payment';
        return { kind: o.advance_kind || 'deposit', amount: advance, fee, deposit, label, paid: cents(paid) >= cents(advance), cash: round2(Math.max(0, total - Math.max(paid, advance))) };
      })() : null,
      condition: advance && !partial ? 'paid in cash ' + (o.fulfillment === 'Delivery' ? 'to the rider on delivery' : 'at the counter on pickup')
        : o.terms_condition || (partial ? 'balance due before release' : 'nothing further to pay'),
      outstanding: cents(balance) > 0 };
  }
  const owedOnOrder = (o) => { const m = orderMoney(o); return m ? m.dueNow : 0; };
  // the chosen option as a screen shows it (null for the orders that pre-date this feature — they are simply payable in full)
  const orderTerms = (o) => { const m = orderMoney(o); return m && m.key !== 'full' ? m : null; };

  /* §8: the money answer both release gates need, in one place so confirming and releasing cannot drift apart, and
     so the rules can be read (and tested) without a warehouse full of orders. Nothing here ever looks at a checkout
     redirect, a chosen method or a typed reference: only the ledger and the named credit exception Finance granted. */
  function releaseDecision(o, { action = 'confirm', role = 'cashier', verified = false } = {}) {
    const m = orderMoney(o);
    if (!m) return { ok: false, field: 'id', reason: 'Order not found' };
    const credit = o.credit_exception_by ? { by: o.credit_exception_by, note: o.credit_exception_note || 'credit exception granted by Finance' } : null;
    const cod = /^Cash on /.test(o.payment_method || '');
    if (action === 'release') {
      if (!m.outstanding) return { ok: true, money: m, credit, cod };
      if (credit) return { ok: true, money: m, credit, cod };
      if (role === 'cashier' && cod) return { ok: true, money: m, cod, collect: m.balance };   // the counter takes the cash on the spot
      return { ok: false, field: 'payment', money: m,
        reason: `${peso(m.balance)} is still outstanding on this order. Collect it at the counter first, or ask Finance to grant a credit exception` };
    }
    // confirming needs the part the terms ask for up front: everything on Full Payment, the initial % on a partial term
    // (dueNow alone is not enough: once the initial is in, dueNow becomes the balance, which is only due before release)
    const short = m.key === 'full' ? m.balance : round2(Math.max(0, m.initial - m.paid));
    // cash on delivery / pickup: the advance paid online (delivery fee or down payment) must be in before it is confirmed
    if (cod && m.advance && !m.advance.paid && !(role === 'finance' && credit))
      return { ok: false, field: 'payment', money: m, reason: `The ${peso(round2(m.advance.amount - m.paid))} ${m.advance.label} has not been paid online yet. The order is confirmed when it is` };
    if (cents(short) > 0 && !(role === 'finance' && credit) && !cod)
      return { ok: false, field: 'payment', money: m, reason: `${peso(short)} ${m.key === 'full' ? '(full payment)' : `(${m.percent}% initial payment)`} has not been received yet. Record it with Collect payment, or wait for the online payment, before confirming` };
    if (role === 'cashier' && !cod && !verified && cents(m.paid) <= 0)
      return { ok: false, field: 'payment', money: m, reason: 'Online payment must be verified before confirming the order' };
    return { ok: true, money: m, credit, cod };
  }

  /* The payment option a customer (or the counter) picks for one order. Only what Finance switched on for this kind
     of sale is offered, and 'custom' is never offered at all — an unusual percentage is attached by Finance, by name.
     The same rule as quotations: choosing a term moves no money, it only says how the order will be paid. */
  async function setOrderTerms(client, o, body, actor) {
    const total = round2(Number(o.total) || 0);
    if (!(total > 0)) throw bad('termKey', 'This order has no amount to pay yet');
    if (round2(Number(o.paid_amount) || 0) > 0) throw bad('termKey', 'A payment is already recorded on this order, so the payment option is fixed');
    const key = str(body && body.termKey);
    if (!TERMS.includes(key)) throw bad('termKey', 'Choose a payment option');
    const options = await optionsFor({ madeToOrder: false, total, db: client });
    const t = options.find((x) => x.key === key);
    if (!t) throw bad('termKey', key === 'full'
      ? 'Full Payment is the only option Finance has switched on right now'
      : `${key === 'custom' ? 'A custom payment percentage is set by Finance' : 'That payment option is not available for this order'}. Ask Finance to enable it in Sales > Payment terms`);
    const r = await client.query(`UPDATE orders SET terms_key = $2, terms_percent = $3, terms_amount = $4, terms_condition = $5, terms_approved_by = $6
           WHERE order_id = $1 RETURNING order_id, terms_key, terms_percent, terms_amount, terms_condition`,
      [o.order_id, t.key, t.percent, t.dueNow, t.balanceCondition, null]);
    await audit(client, actor, 'Record edited', `Order ${o.order_no}: payment option ${t.label} — ${peso(t.dueNow)} now, ${peso(t.balance)} balance (${t.balanceCondition})`);
    return r.rows[0];
  }

  /* Gives back up to `amount` of what the ledger holds for one order, newest payment first, one 'out' row per payment
     reversed. Returns what was actually written (0 when nothing was ever recorded, e.g. an old COD order). */
  async function refundOrderPayments(client, o, amount, actor, note) {
    let left = round2(Math.min(Number(amount) || 0, Number(o.paid_amount) || 0)), done = 0;
    if (!(left > 0)) return 0;
    const ins = (await client.query(
      `SELECT p.payment_id, p.amount, p.method, COALESCE((SELECT SUM(x.amount) FROM payments x WHERE x.reversed_of = p.payment_id), 0) AS back
         FROM payments p WHERE p.paid_for = 'order' AND p.order_id = $1 AND p.direction = 'in' ORDER BY p.payment_id DESC`, [o.order_id])).rows;
    for (const p of ins) {
      const room = round2(Number(p.amount) - Number(p.back));
      if (!(left > 0) || !(room > 0)) continue;
      const take = round2(Math.min(room, left));
      await applyPayment(client, { kind: 'order', no: o.order_no, amount: take, method: p.method, direction: 'out', reversedOf: p.payment_id,
        purpose: 'refund', note: note || 'Refunded by Finance', actor, requestId: `refund-${o.order_id}-${p.payment_id}-${Date.now()}` });
      left = round2(left - take); done = round2(done + take);
    }
    return done;
  }

  /* ---------------- the ledger as a screen needs it ---------------- */
  app.get('/api/finance/payment-ledger/:kind/:no', auth('finance'), wrap(ledgerView));

  /* ---------------- collecting money on an order at the counter ----------------
     §4: the cashier retrieves an order or accepted quotation, sees total / received / outstanding, then records the
     initial payment or a balance payment. Every figure written here comes from applyPayment (row lock + ledger);
     the order is never marked paid by this screen deciding it looks paid.                     */
  app.post('/api/pos/orders/:no/payment', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {}, method = str(b.method);
    if (!METHODS.includes(method)) throw bad('method', 'Choose how the money was received');
    // an online reference is typed in only for the online methods; cash never carries a provider reference
    const providerRef = ['Xendit', 'Card', 'Credit / debit card', 'GCash', 'Maya', 'Bank transfer'].includes(method) ? str(b.reference) : '';
    if (['Xendit', 'Card', 'Credit / debit card', 'GCash', 'Maya', 'Bank transfer'].includes(method) && providerRef.length < 4)
      throw bad('reference', 'Enter the reference from the app, receipt or statement (at least 4 characters)');
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Order not found');
      if (['Cancelled', 'Returned'].includes(cur.status)) throw bad('status', 'This order is closed, so no payment can be recorded on it');
      /* Cash belongs to a drawer, an online payment never does (§4: online money must not inflate the till).
         The shift is the one this cashier actually has open — not a number the page chose. */
      // an open Xendit invoice may still be paid by the customer: taking the same money at the counter would charge them twice
      if (cur.payment_method === 'Xendit' && cur.payment_status === 'pending')
        throw bad('payment', 'An online payment link is still open for this order. Tap Check payment first; collect at the counter only if it was not paid');
      let shiftId = null;
      if (method === 'Cash') {
        const shift = (await client.query('SELECT shift_id, opened_at FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL FOR UPDATE', [req.user.id])).rows[0];
        if (!shift) throw bad('method', 'Open your Cash Shift before taking cash for this order');
        // no cash goes into a drawer after the 5:00 PM closing time (rule lives in cash-shifts.js)
        const late = app.locals.cashShiftHours && app.locals.cashShiftHours.lateError(shift.opened_at);
        if (late) throw bad('method', late);
        shiftId = Number(shift.shift_id);
      }
      const paid = await applyPayment(client, {
        kind: 'order', no: cur.order_no, amount: b.amount, method, note: str(b.note), actor: req.user,
        requestId: str(b.requestId) || undefined, providerRef: providerRef || undefined,
        tendered: b.tendered, cashShiftId: shiftId, saleId: b.saleId
      });
      if (!paid.replayed && cents(paid.parent.balance) === 0)
        await client.query("UPDATE orders SET payment_status = 'paid' WHERE order_id = $1 AND payment_status <> 'paid'", [cur.order_id]);
      return { cur, paid };
    });
    const p = out.paid;
    res.json({ ok: true, replayed: !!p.replayed, paymentId: p.paymentId, receiptNo: 'RCP-' + out.cur.order_no + '-' + p.paymentId,
      amount: p.amount, method: p.method, purpose: p.purpose, tendered: p.tendered == null ? null : p.tendered, change: p.change == null ? null : p.change,
      providerRef: p.payment.provider_ref || undefined, cashShiftId: p.payment.cash_shift_id == null ? null : Number(p.payment.cash_shift_id),
      orderNo: out.cur.order_no, total: p.parent.total, paidAmount: p.parent.paid, balance: p.parent.balance, paymentState: p.parent.state });
    if (p.replayed) return;
    const body = `${peso(p.amount)} received on order ${out.cur.order_no} (${p.method}). ` +
      (p.parent.balance > 0 ? `Outstanding ${peso(p.parent.balance)}.` : 'Fully paid — it can be released.');
    Promise.resolve(pingFinance({ category: 'payment', title: 'Counter payment recorded', body, link: 'Finance_Inventory.html#sales',
      entityType: 'order', entityId: out.cur.order_no, dedupeKey: 'pos_pay:' + p.paymentId })).catch(() => {});
  }));

  /* A refund reverses one recorded payment; it is the only way money leaves the ledger and only Finance may do it.
     It never touches the fulfilment status — an order that was released stays released.          */
  app.post('/api/finance/orders/:no/refund', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Order not found');
      const target = Number(b.paymentId);
      if (!Number.isInteger(target) || target <= 0) throw bad('paymentId', 'Choose the payment being refunded');
      const original = (await client.query(`SELECT * FROM payments WHERE payment_id = $1 AND paid_for = 'order' AND order_id = $2`, [target, cur.order_id])).rows[0];
      if (!original) throw bad('paymentId', 'That payment is not on this order');
      if (original.direction !== 'in') throw bad('paymentId', 'Only a payment received can be refunded');
      const done = await applyPayment(client, {
        kind: 'order', no: cur.order_no, amount: b.amount != null ? b.amount : original.amount,
        method: str(b.method) || original.method, direction: 'out', reversedOf: target, purpose: 'refund',
        note: str(b.note) || 'Refunded by Finance', actor: req.user, requestId: str(b.requestId) || undefined
      });
      return done;
    });
    res.json({ ok: true, replayed: !!out.replayed, paymentId: out.paymentId, refunded: out.amount,
      paidAmount: out.parent.paid, balance: out.parent.balance, paymentState: out.parent.state });
  }));

  /* ---------------- §3 checkout: the options a customer may pick ----------------
     The shop asks this before it shows a payment method, so a partial option only ever appears for an order type
     Finance switched it on for. Reading it needs no session role beyond being a signed-in customer.            */
  app.get('/api/shop/payment-terms', auth('customer'), wrap(async (req, res) => {
    const raw = String(req.query.total == null ? '' : req.query.total).replace(/[,₱\s]/g, '');
    const total = raw ? Number(raw) : 0;
    if (!(total > 0)) throw bad('total', 'Put something in the cart first');
    const options = await optionsFor({ madeToOrder: false, total });
    res.json({ options, total: round2(total), madeToOrder: false });
  }));

  app.post('/api/shop/orders/:no/terms', auth('customer'), wrap(async (req, res) => {
    const out = await tx(async (client) => {
      const cur = (await client.query("SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE", [req.params.no, req.user.id])).rows[0];
      if (!cur) throw bad('id', 'Order not found');
      if (cur.status !== 'Pending Confirmation') throw bad('status', 'This order is no longer waiting for payment, so its payment option cannot be changed');
      const t = await setOrderTerms(client, cur, req.body || {}, req.user);
      return { cur, t };
    });
    res.json({ ok: true, terms: orderTerms(out.t), money: orderMoney(Object.assign({}, out.cur, out.t)) });
  }));

  /* ---------------- §8: releasing an order that still has money on it ----------------
     The only door past the release gate. Finance names the reason; the counter can then hand the goods over with the
     balance still outstanding. Revoking it puts the gate back up. Recorded on the order and in the audit log.      */
  app.post('/api/finance/orders/:no/credit-exception', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, action = str(b.action) || 'grant';
    if (!['grant', 'revoke'].includes(action)) throw bad('action', 'Choose grant or revoke');
    const note = str(b.note);
    if (action === 'grant' && (note.length < 5 || note.length > 300)) throw bad('note', 'Write why this order may go out with a balance (5–300 characters)');
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Order not found');
      if (['Cancelled', 'Returned'].includes(cur.status)) throw bad('status', 'This order is closed, so a credit exception makes no difference');
      const r = action === 'grant'
        ? await client.query(`UPDATE orders SET credit_exception_by = $2, credit_exception_note = $3, credit_exception_at = now() WHERE order_id = $1
                RETURNING credit_exception_by, credit_exception_note, credit_exception_at`, [cur.order_id, req.user.id, note])
        : await client.query(`UPDATE orders SET credit_exception_by = NULL, credit_exception_note = NULL, credit_exception_at = NULL WHERE order_id = $1
                RETURNING credit_exception_by, credit_exception_note, credit_exception_at`, [cur.order_id]);
      const m = orderMoney(Object.assign({}, cur, action === 'grant'
        ? { credit_exception_by: req.user.id, credit_exception_note: note } : { credit_exception_by: null }));
      await audit(client, req.user, 'Record edited', `Order ${cur.order_no}: credit exception ${action}` +
        (action === 'grant' ? ` — ${peso(m.balance)} still outstanding. ${note}` : ''));
      return { row: r.rows[0], money: m };
    });
    res.json({ ok: true, creditException: action === 'grant' ? { by: req.user.id, note } : null, outstanding: out.money.balance });
  }));

  /* ---------------- §9: who still owes money ----------------
     One read for the Finance screen: every order and every accepted quotation with a balance on it, the terms that
     balance sits under, and whether Finance already signed an exception for it. The figures are the ones the database
     trigger keeps on the parent row — this route does not add ledger rows up and call that the truth.            */
  const moneyJson = (x, extra) => Object.assign({
    no: x.no, kind: (extra && extra.kind) || 'order', customer: x.customer || '',
    customerId: x.customer_id == null ? null : Number(x.customer_id),
    total: round2(Number(x.total) || 0), paidAmount: round2(Number(x.paid_amount) || 0),
    outstanding: round2(Number(x.outstanding) || 0), paymentState: x.payment_state || 'unpaid',
    termsKey: x.terms_key || 'full', termsPercent: x.terms_percent == null ? null : +x.terms_percent,
    termsCondition: x.terms_condition || undefined, status: x.status,
    creditException: x.credit_exception_by ? { note: x.credit_exception_note || 'granted by Finance' } : undefined,
    at: ms(x.at) || undefined
  }, extra || {});

  app.get('/api/finance/receivables', auth('finance'), wrap(async (req, res) => {
    const open = await pool.query(`SELECT o.order_no AS no, o.customer_id, COALESCE(u.full_name, '') AS customer,
          o.total, o.paid_amount, o.payment_state, o.terms_key, o.terms_percent, o.terms_condition, o.status,
          o.payment_method, o.credit_exception_by, o.credit_exception_note, o.created_at AS at,
          GREATEST(o.total - COALESCE(o.paid_amount, 0), 0) AS outstanding
       FROM orders o LEFT JOIN users u ON u.user_id = o.customer_id
      WHERE o.status <> 'Cancelled' AND GREATEST(o.total - COALESCE(o.paid_amount, 0), 0) > 0.005
      ORDER BY outstanding DESC, o.created_at LIMIT 300`);
    const quoted = await pool.query(`SELECT q.quote_no AS no, q.customer_id, COALESCE(q.contact_name, '') AS customer,
          q.quoted_amount AS total, q.paid_amount, q.payment_state, q.terms_key, q.terms_percent, q.terms_condition, q.status,
          q.updated_at AS at, GREATEST(q.quoted_amount - COALESCE(q.paid_amount, 0), 0) AS outstanding
       FROM quote_requests q
      WHERE q.quoted_amount IS NOT NULL AND q.converted_order_id IS NULL AND q.status IN ('accepted', 'preparing', 'ready')
        AND GREATEST(q.quoted_amount - COALESCE(q.paid_amount, 0), 0) > 0.005
      ORDER BY outstanding DESC, q.updated_at LIMIT 300`);
    const orders = open.rows.map((x) => moneyJson(x, { kind: 'order', method: x.payment_method }));
    const quotes = quoted.rows.map((x) => moneyJson(x, { kind: 'quote' }));
    const sum = (list) => round2(list.reduce((n, x) => n + x.outstanding, 0));
    res.json({ asOf: Date.now(), ledgerReady: await ledgerOwnsTotals(null), orders, quotes,
      totals: { openOrders: orders.length, openQuotes: quotes.length,
        ordersOwed: sum(orders), quotesOwed: sum(quotes), allOwed: round2(sum(orders) + sum(quotes)) } });
  }));

  /* ---------------- §9: the money events themselves ----------------
     The monitoring list behind the receivables: every payment and every refund, which order or quotation it belongs
     to, how it came in, who recorded it and into which drawer. Amounts are read straight off the ledger rows; the
     totals beside them are the same rows summed once, server-side.                                            */
  app.get('/api/finance/payments', auth('finance'), wrap(async (req, res) => {
    const kind = ['order', 'quote'].includes(str(req.query.kind)) ? str(req.query.kind) : null;
    const rows = (await pool.query(
      `SELECT p.payment_id, p.paid_for, COALESCE(o.order_no, q.quote_no) AS no, p.direction, p.amount, p.method, p.purpose,
              p.provider_ref, p.request_id, p.cash_shift_id, p.tendered, p.change_given, p.reversed_of, p.received_by, ru.full_name AS actor,
              p.note, p.created_at
         FROM payments p
         LEFT JOIN orders o ON o.order_id = p.order_id
         LEFT JOIN quote_requests q ON q.quote_id = p.quote_id
         LEFT JOIN users ru ON ru.user_id = p.received_by
        WHERE ($1::text IS NULL OR p.paid_for = $1)
        ORDER BY p.created_at DESC, p.payment_id DESC LIMIT 200`, [kind])).rows;
    const list = rows.map((x) => ({ id: Number(x.payment_id), kind: x.paid_for, ref: x.no, direction: x.direction,
      amount: round2(Number(x.amount) || 0), method: x.method, purpose: x.purpose, providerRef: x.provider_ref || undefined,
      cashShiftId: x.cash_shift_id == null ? null : Number(x.cash_shift_id),
      tendered: x.tendered == null ? undefined : round2(+x.tendered), changeGiven: x.change_given == null ? undefined : round2(+x.change_given),
      reversedOf: x.reversed_of == null ? undefined : Number(x.reversed_of),
      // the re-filing half of a quotation -> order hand-over. Listed, because it is real history; never added up.
      moved: /^transfer(-in)?:/.test(String(x.request_id || '')),
      actor: x.actor || undefined, note: x.note || undefined, at: ms(x.created_at) || undefined }));
    const sum = (rows) => round2(rows.reduce((n, x) => n + x.amount, 0));
    const inRows = list.filter((x) => x.direction === 'in' && !x.moved);
    res.json({ asOf: Date.now(), count: list.length, payments: list,
      totals: { collected: sum(inRows), refunded: sum(list.filter((x) => x.direction === 'out' && !x.moved)),
        moved: sum(list.filter((x) => x.moved)),
        // cash that landed in a drawer is the only part of this that belongs in the till count (§4)
        cashInDrawer: sum(inRows.filter((x) => x.cashShiftId != null)), onlineAndOther: sum(inRows.filter((x) => x.cashShiftId == null)) } });
  }));

  /* ---------------- §10: what was sold, what arrived, what is still owed ----------------
     Three figures the Reports screen keeps apart, because merging them is how a down payment turns into a second
     sale. "Booked" is one line per order raised in the period — however many payments settle it later, the order is
     counted once, at its own value. "Collected" is money events on the ledger, each counted once on the day the money
     actually arrived; the quotation -> order re-filing is left out of it. "Receivables" reads the two views the
     trigger feeds. Everything is added up here, on the server, so the screen only prints numbers.               */
  app.get('/api/finance/payment-report', auth('finance'), wrap(async (req, res) => {
    const live = await ledgerOwnsTotals(null);
    const today = (await pool.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [TZ])).rows[0].d;
    if (req.query.from && !ymd(req.query.from)) throw bad('from', 'Use dates like 2026-10-14.');
    if (req.query.to && !ymd(req.query.to)) throw bad('to', 'Use dates like 2026-10-14.');
    const f = ymd(req.query.from) || ymd(req.query.to) || today, t = ymd(req.query.to) || ymd(req.query.from) || today;
    if (f > t) throw bad('to', 'The start date must not be after the end date.');
    if ((Date.parse(t) - Date.parse(f)) / 86400000 > 92) throw bad('to', 'Choose a range of 92 days or less.');
    // without the trigger there is no ledger total to report, and zeros would read as a quiet month rather than a gap
    if (!live) return res.json({ from: f, to: t, asOf: Date.now(), ledgerReady: false, booked: null, collections: null, receivables: null });

    // one line per order booked in the period, with the money already on it and the money that landed during the period
    const { rows: booked } = await pool.query(
      `SELECT (o.created_at AT TIME ZONE $1)::date::text AS day, o.order_no AS no, o.customer_id, COALESCE(u.full_name, '') AS customer,
              o.total, o.paid_amount, o.payment_state, o.terms_key, o.terms_percent, o.terms_condition, o.status,
              o.payment_method, o.created_at AS at,
              GREATEST(o.total - COALESCE(o.paid_amount, 0), 0) AS outstanding,
              COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.paid_for = 'order' AND p.order_id = o.order_id AND p.direction = 'in' AND ${NOT_A_MOVE}
                           AND (p.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date), 0) AS in_period
         FROM orders o LEFT JOIN users u ON u.user_id = o.customer_id
        WHERE o.status <> 'Cancelled' AND (o.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        ORDER BY o.created_at, o.order_no LIMIT 500`, [TZ, f, t]);

    // money events in the period, grouped once by day / parent / direction / method / purpose / drawer
    const { rows: events } = await pool.query(
      `SELECT (p.created_at AT TIME ZONE $1)::date::text AS day, p.paid_for AS kind, p.direction, p.method, p.purpose,
              (p.cash_shift_id IS NOT NULL) AS in_drawer, COUNT(*)::int AS count, COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p
        WHERE ${NOT_A_MOVE} AND (p.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
        GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 4`, [TZ, f, t]);

    const owedRes = await pool.query(
      `SELECT 'order' AS kind, COUNT(*)::int AS open, COALESCE(SUM(outstanding), 0) AS owed FROM v_receivables WHERE outstanding > 0.005
       UNION ALL
       SELECT 'quote', COUNT(*)::int, COALESCE(SUM(outstanding), 0) FROM v_receivable_quotes WHERE outstanding > 0.005`).catch(() => null);
    const owed = {};
    ((owedRes && owedRes.rows) || []).forEach((x) => { owed[x.kind] = { open: Number(x.open), owed: round2(Number(x.owed)) }; });

    const rows = booked.map((r) => Object.assign(moneyJson(r, { kind: 'order', method: r.payment_method }), { day: r.day, inPeriod: round2(+r.in_period) }));
    const total = (list, of) => round2(list.reduce((n, x) => n + Number(of(x)), 0));
    const on = (list, col, v) => list.filter((x) => String(x[col]) === String(v));
    const ins = events.filter((e) => e.direction === 'in'), outs = events.filter((e) => e.direction === 'out');
    const names = (col) => [...new Set(events.map((x) => String(x[col])))].sort();
    res.json({
      from: f, to: t, asOf: Date.now(), ledgerReady: live, timeZone: TZ,
      booked: {
        count: rows.length, rows,
        value: total(rows, (r) => r.total), collected: total(rows, (r) => r.paidAmount),
        inPeriod: total(rows, (r) => r.inPeriod), stillOwed: total(rows, (r) => r.outstanding)
      },
      collections: {
        arrived: total(ins, (e) => e.amount), refunded: total(outs, (e) => e.amount),
        net: round2(total(ins, (e) => e.amount) - total(outs, (e) => e.amount)),
        drawer: total(ins.filter((e) => e.in_drawer === true), (e) => e.amount),
        outside: total(ins.filter((e) => e.in_drawer !== true), (e) => e.amount),
        byDay: names('day').map((day) => ({ day,
          arrived: total(on(ins, 'day', day), (e) => e.amount), refunded: total(on(outs, 'day', day), (e) => e.amount) })),
        byMethod: names('method').map((method) => ({ method,
          count: on(ins, 'method', method).reduce((n, e) => n + Number(e.count), 0),
          arrived: total(on(ins, 'method', method), (e) => e.amount), refunded: total(on(outs, 'method', method), (e) => e.amount),
          drawer: total(on(ins, 'method', method).filter((e) => e.in_drawer === true), (e) => e.amount),
          forOrders: total(on(ins, 'method', method).filter((e) => e.kind === 'order'), (e) => e.amount),
          forQuotes: total(on(ins, 'method', method).filter((e) => e.kind === 'quote'), (e) => e.amount) })),
        byPurpose: names('purpose').map((purpose) => ({ purpose,
          count: on(events, 'purpose', purpose).reduce((n, e) => n + Number(e.count), 0),
          amount: total(on(events, 'purpose', purpose), (e) => e.amount) })),
        byKind: ['order', 'quote'].map((kind) => ({ kind,
          arrived: total(on(ins, 'kind', kind), (e) => e.amount), refunded: total(on(outs, 'kind', kind), (e) => e.amount) }))
      },
      receivables: live ? {
        openOrders: (owed.order || {}).open || 0, ordersOwed: (owed.order || {}).owed || 0,
        openQuotes: (owed.quote || {}).open || 0, quotesOwed: (owed.quote || {}).owed || 0,
        allOwed: round2(((owed.order || {}).owed || 0) + ((owed.quote || {}).owed || 0))
      } : null
    });
  }));

  // the counter reads total / received / outstanding before it hands anything over
  async function ledgerView(req, res) {
    const kind = str(req.params.kind);
    if (!PARENTS[kind]) throw bad('kind', 'Choose an order or a quotation');
    const P = PARENTS[kind];
    const parent = (await pool.query(`SELECT ${P.idCol} AS id, ${P.noCol} AS no, ${P.totalCol} AS total, paid_amount, payment_state FROM ${P.table} WHERE ${P.noCol} = $1`, [req.params.no])).rows[0];
    if (!parent) throw bad('id', P.label + ' not found');
    res.json({ kind, no: req.params.no, total: round2(Number(parent.total) || 0), paidAmount: round2(Number(parent.paid_amount) || 0),
      paymentState: parent.payment_state, outstanding: round2(Math.max(0, round2(Number(parent.total) || 0) - Number(parent.paid_amount) || 0)),
      payments: await ledgerFor(pool, { kind, no: req.params.no }) });
  };
  app.get('/api/pos/payment-ledger/:kind/:no', auth('cashier'), wrap(ledgerView));

  app.locals.paymentTerms = {
    ready, listTerms, optionsFor, amountFor, quoteTerms, approvedDueOf, isMadeToOrder,
    applyPayment, ledgerFor, termRows, moveQuotePaymentsToOrder, inheritTerms, DEFAULT_TERMS, METHODS, TERMS,
    orderMoney, owedOnOrder, orderTerms, setOrderTerms, releaseDecision, refundOrderPayments,
    ledgerForOrder: (no) => ledgerFor(pool, { kind: 'order', no }),
    markTermsSeen: (client, quoteId) => client.query(`UPDATE quote_requests SET terms_customer_seen_at = now() WHERE quote_id = $1 AND terms_customer_seen_at IS NULL`, [quoteId])
  };
};
