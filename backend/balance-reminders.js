/* balance-reminders.js — due date and reminders for orders that are only partly paid.

   Rule (all of it from the payments ledger, nothing is stored or guessed in the browser):
     due date = the day the FIRST payment was confirmed on the order  +  BALANCE_DUE_DAYS  (default 7)

   Who is told, and when. The customer gets an in-app notice (saved in the notifications table), an email (mailer.js)
   and a text (sms.js, TextBee). Email and text go out only when the in-app notice was newly saved, so the table is
   also what stops a restart or a second server instance from sending the same one twice. Finance gets in-app only.
     • customer  BALANCE_REMIND_BEFORE_DAYS (default 2) days before the due date, once
     • customer  on the due date, and again every BALANCE_REPEAT_DAYS (default 3) days while it stays unpaid
     • Finance   the day it becomes overdue, and again every 7 days — so someone decides what to do

   After BALANCE_GRACE_DAYS (default 7) overdue days, orders are put On Hold. It will not cancel or refund by itself. The customer has already paid real money,
   so cancelling means a refund / forfeiture decision. That stays with Finance, who sees the overdue list below.
   Orders Finance granted a credit exception on are skipped: the balance was agreed to be paid later.

   Endpoints
     GET /api/shop/balance-due        (customer) due date of this customer's own partly paid orders
     GET /api/finance/balance-overdue (finance)  every partly paid order with its due date, overdue first

   .env (all optional):  BALANCE_GRACE_DAYS=7  BALANCE_DUE_DAYS=7  BALANCE_REMIND_BEFORE_DAYS=2  BALANCE_REPEAT_DAYS=3  BALANCE_CHECK_MINUTES=60
   Mounted in server.js after payment-terms (it needs the ledger columns that module creates). Policy columns are prepared by payment-terms.js. */
const mailer = require('./mailer');
const sms = require('./sms');
const { escapeHtml: esc } = mailer;
const num = (v, d, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : d; };
const DAY = 86400000;

module.exports = function makeBalanceReminders({ app, pool, auth, wrap }) {
  const DUE_DAYS = Math.floor(num(process.env.BALANCE_DUE_DAYS, 7, 1));
  const BEFORE = Math.floor(num(process.env.BALANCE_REMIND_BEFORE_DAYS, 2, 0));
  const REPEAT = Math.floor(num(process.env.BALANCE_REPEAT_DAYS, 3, 1));
  const EVERY = Math.max(5, num(process.env.BALANCE_CHECK_MINUTES, 60, 1)) * 60000;
  const nc = () => app.locals.notifications;
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const day = (d) => new Date(d).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });

  // every order that has had some money but still owes some, with the date the balance falls due
  const OPEN_SQL = `
    SELECT o.order_id, o.order_no, o.customer_id, o.total, o.paid_amount, o.status,
           u.email, u.full_name, u.phone AS account_phone,
           COALESCE(o.balance_due_at, f.first_paid + make_interval(days => $1::int)) AS due_at
      FROM orders o
      JOIN (SELECT order_id, MIN(created_at) AS first_paid
              FROM payments WHERE order_id IS NOT NULL AND direction = 'in' GROUP BY order_id) f ON f.order_id = o.order_id
      JOIN users u ON u.user_id = o.customer_id
     WHERE o.paid_amount > 0
       AND o.total - o.paid_amount > 0.004
       AND o.status NOT IN ('Cancelled', 'Returned', 'Delivered', 'Picked Up')
       AND o.credit_exception_by IS NULL`;

  const view = (r, now = Date.now()) => {
    const due = new Date(r.due_at).getTime();
    return { orderNo: r.order_no, total: +r.total, paid: +r.paid_amount, balance: Math.round((+r.total - +r.paid_amount) * 100) / 100,
      status: r.status, dueAt: due, daysLeft: Math.ceil((due - now) / DAY), overdueDays: now >= due ? Math.floor((now - due) / DAY) : 0 };
  };

  // Email + text for the customer. Called ONLY when the in-app notice was newly saved (notifyUser returns 0 for a
  // duplicate), so the notifications table is also what stops a second email or SMS. One channel failing never
  // stops the other, and nothing here can break the check.
  async function deliver(r, v, { subject, line, textMsg }) {
    const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const link = base ? base + '/Shop_Customer.html#orders' : '';
    if (r.email) {
      try {
        const html = `<div style="font:15px/1.55 Arial,sans-serif;color:#16202b;max-width:520px"><p>Hi ${esc(r.full_name || 'there')},</p><p>${esc(line)}</p>`
          + `<p style="background:#f1f6fb;padding:10px 14px;border-radius:8px">Order <b>${esc(r.order_no)}</b><br>Paid ${esc(peso(v.paid))} of ${esc(peso(v.total))}<br><b>Balance ${esc(peso(v.balance))}</b></p>`
          + (link ? `<p><a href="${esc(link)}">View my orders and pay the balance</a></p>` : '') + `<p style="color:#7a8794;font-size:13px">If you already paid, please ignore this message.</p></div>`;
        const m = await mailer.sendMail({ to: r.email, subject, html, text: `Hi ${r.full_name || 'there'},\n\n${line}\nOrder ${r.order_no}: paid ${peso(v.paid)} of ${peso(v.total)}, balance ${peso(v.balance)}.\n${link}\n\nIf you already paid, please ignore this message.`, tag: 'balance-reminder' });
        if (m && m.sent === false) console.warn(`[balance-reminders] email for ${r.order_no} not sent: ${m.reason}`);
      } catch (err) { console.error(`[balance-reminders] email for ${r.order_no} failed:`, err.message); }
    }
    if (sms.eventEnabled('balance_reminder')) {
      try {
        const m = await sms.sendSms({ to: r.account_phone, message: textMsg });
        if (!m.sent) console.warn(`[balance-reminders] text for ${r.order_no} not sent: ${m.reason}`);
      } catch (err) { console.error(`[balance-reminders] text for ${r.order_no} failed:`, err.message); }
    }
  }

  let running = false;
  async function check() {
    if (running) return { checked: false };
    running = true;
    let sent = 0;
    try {
      const pt = app.locals.paymentTerms;
      if (!pt) return { checked: false };
      await pt.ready;
      // Include held orders even after final payment, so a restart can recover and release their hold.
      const candidates = (await pool.query("SELECT order_no FROM orders WHERE status = 'On Hold' OR (paid_amount > 0 AND total - paid_amount > 0.004 AND status NOT IN ('Cancelled','Returned','Delivered','Picked Up','Out for Delivery'))")).rows;
      for (const c of candidates) {
        const held = await pt.holdOverdue(c.order_no);
        if (held && nc()) sent += await nc().notifyRole('finance', { category: 'payment', severity: 'critical',
          title: 'On Hold — balance unpaid', body: `${held.no}: ${peso(held.balance)} remains unpaid after the grace period. Choose extend, grant a credit exception, or cancel and decide the down payment.`,
          link: 'Finance_Inventory.html#payment-terms', entityType: 'order', entityId: held.no,
          dedupeKey: `balance_hold:${held.no}:${held.due}`,
          meta: { actions: ['extend','credit-exception','cancel'] } });
      }
      const { rows } = await pool.query(OPEN_SQL, [DUE_DAYS]);
      if (!nc()) return { checked: true, orders: rows.length, sent };
      const now = Date.now();
      for (const r of rows) {
        const v = view(r, now), no = r.order_no, owe = peso(v.balance), by = day(v.dueAt);
        const link = 'Shop_Customer.html#orders';
        if (now >= v.dueAt) {
          const n = Math.floor(v.overdueDays / REPEAT);
          const first = v.overdueDays < REPEAT;
          const added = await nc().notifyUser(r.customer_id, { category: 'payment', severity: 'warn', link, entityType: 'order', entityId: no,
            title: first ? 'Your balance is due' : 'Your balance is overdue',
            body: `Order ${no}: ${owe} was due on ${by}. Please settle it so we can release your order. If you already paid, ignore this.`,
            dedupeKey: `bal_over:${no}:${v.dueAt}:${n}` }, 'customer');
          sent += added;
          if (added) await deliver(r, v, { subject: first ? `Your balance for order ${no} is due` : `Your balance for order ${no} is overdue`,
            line: `The remaining balance on your order was due on ${by}. Please settle it so we can release your order.`,
            textMsg: `Triple E Metal: Order ${no} balance of ${owe} was due on ${by}. Please pay it in My Orders. Ignore this if you already paid.` });
          sent += await nc().notifyRole('finance', { category: 'payment', severity: v.overdueDays >= 7 ? 'critical' : 'warn',
            link: 'Finance_Inventory.html#sales', entityType: 'order', entityId: no,
            title: 'Order balance overdue',
            body: `${no} is ${v.overdueDays} day${v.overdueDays === 1 ? '' : 's'} past its due date (${by}); ${owe} still unpaid of ${peso(v.total)}. Chase the customer, grant a credit exception, or cancel and settle the down payment.`,
            dedupeKey: `balfin:${no}:${v.dueAt}:${Math.floor(v.overdueDays / 7)}` });
        } else if (v.daysLeft <= BEFORE) {
          const when = v.daysLeft <= 1 ? 'tomorrow' : 'in ' + v.daysLeft + ' days';
          const added = await nc().notifyUser(r.customer_id, { category: 'payment', severity: 'info', link, entityType: 'order', entityId: no,
            title: 'Balance due soon',
            body: `Order ${no}: ${owe} is due on ${by} (${when}).`,
            dedupeKey: `bal_soon:${no}:${v.dueAt}` }, 'customer');
          sent += added;
          if (added) await deliver(r, v, { subject: `Balance for order ${no} is due ${when}`,
            line: `The remaining balance on your order is due on ${by} (${when}).`,
            textMsg: `Triple E Metal: Order ${no} balance of ${owe} is due ${by}. Pay it in My Orders. Ignore this if you already paid.` });
        }
      }
      return { checked: true, orders: rows.length, sent };
    } catch (err) {
      console.warn('[balance-reminders] check failed:', err.message);
      return { checked: false, error: true };
    } finally { running = false; }
  }

  // the customer's own due dates, for the balance bar on My Orders
  app.get('/api/shop/balance-due', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(OPEN_SQL + ' AND o.customer_id = $2', [DUE_DAYS, req.user.id]);
    const out = {}; for (const r of rows) { const v = view(r); out[v.orderNo] = { dueAt: v.dueAt, daysLeft: v.daysLeft, overdueDays: v.overdueDays }; }
    res.json(out);
  }));

  /* Counter: what does this customer still owe? Matched by the phone typed on the sale (last 10 digits), against the
     account phone and the phone saved on each order. Read-only: nothing is posted from here. */
  app.get('/api/pos/customer-account', auth('cashier'), wrap(async (req, res) => {
    const key = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
    if (key.length < 10) return res.json({ found: false, phone: key });
    const acct = (await pool.query(
      `SELECT user_id, full_name, email, phone, created_at FROM users
        WHERE role = 'customer' AND right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = $1 LIMIT 1`, [key])).rows[0] || null;
    const ids = acct ? acct.user_id : null;
    const orders = (await pool.query(
      `SELECT o.order_no, o.total, o.paid_amount, o.status, o.payment_state, o.terms_key, o.terms_percent, o.terms_condition,
              o.credit_exception_by, o.created_at, o.balance_due_at,
              (SELECT MIN(p.created_at) FROM payments p WHERE p.order_id = o.order_id AND p.direction = 'in') AS first_paid
         FROM orders o
        WHERE o.status NOT IN ('Cancelled','Returned')
          AND ($1::int IS NOT NULL AND o.customer_id = $1 OR right(regexp_replace(coalesce(o.phone,''), '\D', '', 'g'), 10) = $2)
        ORDER BY o.created_at DESC LIMIT 60`, [ids, key])).rows;
    const quotes = (await pool.query(
      `SELECT quote_no, quoted_amount, paid_amount, status, terms_key, terms_percent FROM quote_requests
        WHERE converted_order_id IS NULL AND status IN ('accepted','preparing','ready') AND quoted_amount - paid_amount > 0.005
          AND ($1::int IS NOT NULL AND customer_id = $1 OR right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 10) = $2)
        ORDER BY created_at DESC LIMIT 30`, [ids, key])).rows;
    const now = Date.now(), r2 = (n) => Math.round(n * 100) / 100;
    const open = orders.filter((o) => +o.total - +o.paid_amount > 0.004 && +o.paid_amount > 0 && !['Delivered', 'Picked Up'].includes(o.status) || (o.payment_state === 'partially_paid' && +o.total - +o.paid_amount > 0.004))
      .map((o) => {
        const due = o.balance_due_at ? new Date(o.balance_due_at).getTime() : o.first_paid ? new Date(o.first_paid).getTime() + DUE_DAYS * DAY : null;
        return { kind: 'order', no: o.order_no, total: +o.total, paid: +o.paid_amount, balance: r2(+o.total - +o.paid_amount), status: o.status,
          termsKey: o.terms_key || 'full', termsPercent: o.terms_percent == null ? null : +o.terms_percent, condition: o.terms_condition || null,
          dueAt: due, daysLeft: due ? Math.ceil((due - now) / DAY) : null, overdueDays: due && now >= due ? Math.floor((now - due) / DAY) : 0,
          creditException: !!o.credit_exception_by };
      });
    const q = quotes.map((x) => ({ kind: 'quote', no: x.quote_no, total: +x.quoted_amount, paid: +x.paid_amount, balance: r2(+x.quoted_amount - +x.paid_amount),
      status: x.status, termsKey: x.terms_key || 'full', termsPercent: x.terms_percent == null ? null : +x.terms_percent }));
    const items = open.concat(q);
    const owed = r2(items.reduce((s, i) => s + i.balance, 0));
    const spent = r2(orders.filter((o) => !['Cancelled', 'Returned'].includes(o.status)).reduce((s, o) => s + (+o.paid_amount || 0), 0));
    const pt = app.locals.paymentTerms;
    let terms = [];
    try { if (pt && pt.optionsFor) terms = (await pt.optionsFor({ madeToOrder: false, total: 1000 })).map((t) => ({ key: t.key, label: t.label, percent: t.percent == null ? null : +t.percent, condition: t.balanceCondition || t.balance_condition || null })); } catch (e) { terms = []; }
    res.json({ found: !!acct || items.length > 0 || orders.length > 0, phone: key,
      customer: acct ? { id: acct.user_id, name: acct.full_name, email: acct.email, since: acct.created_at } : null,
      owed, overdue: items.filter((i) => i.overdueDays > 0).length, items, orders: orders.length, paidToDate: spent, dueDays: DUE_DAYS, terms });
  }));

  // Finance: who owes what, and since when
  app.get('/api/finance/balance-overdue', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(OPEN_SQL + ' ORDER BY due_at', [DUE_DAYS]);
    const list = rows.map((r) => view(r));
    res.json({ dueDays: DUE_DAYS, graceDays: app.locals.paymentTerms.balanceSettings.graceDays, overdue: list.filter((x) => x.overdueDays > 0 || x.daysLeft <= 0), upcoming: list.filter((x) => x.overdueDays === 0 && x.daysLeft > 0) });
  }));

  const timer = setInterval(check, EVERY); timer.unref && timer.unref();
  const first = setTimeout(check, 20000); first.unref && first.unref();   // after the ledger schema has come up
  return { check, settings: { dueDays: DUE_DAYS, remindBeforeDays: BEFORE, repeatDays: REPEAT } };
};