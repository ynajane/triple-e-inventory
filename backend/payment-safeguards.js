/* Finance decisions share parent locks with the append-only payment ledger. */
const DAY = 86400000;
const setting = (value, fallback, min = 0) => value == null || value === '' ? fallback
  : Number.isFinite(Number(value)) && Number(value) >= min ? Number(value) : fallback;
module.exports = function safeguards({ app, pool, auth, wrap, tx, audit, bad, str, ready, orderMoney, releaseDecision, approvedDueOf, isMadeToOrder }) {
  const dueDays = Math.floor(setting(process.env.BALANCE_DUE_DAYS, 7, 1));
  const graceDays = Math.floor(setting(process.env.BALANCE_GRACE_DAYS, 7));
  const creditLimit = setting(process.env.CREDIT_EXCEPTION_LIMIT_PHP, 10000);
  const system = { id: null, name: 'System', roleLabel: 'System' };
  const noteOf = (body) => {
    const note = str(body.note);
    if (note.length < 5 || note.length > 300) throw bad('note', 'Write a reason (5–300 characters)');
    return note;
  };
  const closed = (o) => ['Cancelled', 'Returned', 'Delivered', 'Picked Up', 'Out for Delivery'].includes(o.status);
  async function dueAt(db, o) {
    if (o.balance_due_at) return new Date(o.balance_due_at).getTime();
    const f = (await db.query("SELECT MIN(created_at) AS first_paid FROM payments WHERE order_id = $1 AND direction = 'in'", [o.order_id])).rows[0];
    return f?.first_paid ? new Date(f.first_paid).getTime() + dueDays * DAY : null;
  }
  async function resume(db, o, actor, reason) {
    if (o.status !== 'On Hold' || !o.balance_hold_from) return;
    await db.query('UPDATE orders SET status = balance_hold_from, balance_hold_from = NULL, balance_held_at = NULL, status_updated_at = now() WHERE order_id = $1', [o.order_id]);
    await audit(db, actor, 'Record edited', `Order ${o.order_no}: balance hold released — ${reason}`);
  }
  async function holdOverdue(no) {
    await ready;
    return tx(async (db) => {
      const o = (await db.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [no])).rows[0];
      if (!o || closed(o)) return null;
      const m = orderMoney(o);
      if (o.credit_exception_by || m.balance <= 0) {
        await resume(db, o, system, o.credit_exception_by ? 'credit exception granted' : 'balance paid');
        return null;
      }
      if (!(m.paid > 0)) return null;
      const due = await dueAt(db, o);
      if (due == null || Date.now() < due + graceDays * DAY) return null;
      if (o.status !== 'On Hold') {
        await db.query("UPDATE orders SET balance_hold_from = status, status = 'On Hold', balance_held_at = now(), status_updated_at = now() WHERE order_id = $1", [o.order_id]);
        await audit(db, system, 'Record edited', `Order ${o.order_no}: On Hold — balance unpaid after ${graceDays} grace days`);
      }
      return { no: o.order_no, due, balance: m.balance };
    });
  }
  // Uses the order's ledger-backed terms; quotations use approved initial terms or the established 50% deposit.
  function productionDecision(q) {
    if (q.converted_order_id) return { ok: false, field: 'payment', reason: 'This quotation was converted to an order. Use the order workflow.' };
    if (!['accepted', 'preparing'].includes(q.status)) return { ok: false, field: 'status', reason: 'Production and quote purchases require an accepted, open quotation.' };
    if (q.terms_key && q.terms_key !== 'full' && q.terms_state !== 'approved' && !q.production_override_by) return { ok: false, field: 'payment', reason: 'Finance must approve the partial-payment terms before production or material purchasing.' };
    const due = q.terms_key === 'full' && q.terms_state === 'approved' ? null : approvedDueOf(q);
    const total = Number(q.quoted_amount) || 0;
    if (!(total > 0)) return { ok: false, field: 'payment', reason: 'Set an approved price and record the initial payment before production or material purchasing.' };
    const o = { ...q, total, payment_method: 'Xendit', terms_key: due?.key || 'full', terms_amount: due?.amount || total, terms_percent: due ? (due.amount / total * 100) : 100 };
    const gate = releaseDecision(o, { action: q.terms_condition === 'balance due before production starts' ? 'release' : 'confirm', role: 'finance', verified: true });
    if (gate.ok || q.production_override_by) return { ok: true, money: gate.money, override: q.production_override_by || undefined };
    return { ...gate, reason: 'Production and material purchasing are blocked: ' + gate.reason + '. Finance may record a named override with a reason.' };
  }
  async function assertProduction(db, q) {
    const gate = productionDecision(q);
    if (!gate.ok) throw bad(gate.field || 'payment', gate.reason);
    return gate;
  }
  app.post('/api/finance/quotes/:no/production-override', auth('finance'), wrap(async (req, res) => {
    await ready;
    const b = req.body || {}, note = noteOf(b), revoke = b.action === 'revoke';
    if (b.action && !['grant', 'revoke'].includes(b.action)) throw bad('action', 'Choose grant or revoke');
    if (!str(req.user.name)) throw bad('name', 'The Finance account must have a recorded name');
    await tx(async (db) => {
      const q = (await db.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!q) throw bad('id', 'Quote request not found');
      if (q.converted_order_id || !['accepted','preparing'].includes(q.status)) throw bad('status', 'Only an accepted, open quotation can receive a production override');
      await db.query(`UPDATE quote_requests SET production_override_by=$2, production_override_name=$3, production_override_note=$4,
        production_override_at=now() WHERE quote_id=$1`, [q.quote_id, revoke ? null : req.user.id, revoke ? null : req.user.name, revoke ? null : note]);
      await audit(db, req.user, 'Record edited', `Quote ${q.quote_no}: production override ${revoke ? 'revoked' : 'granted'} by ${req.user.name} — ${note}`);
    });
    res.json({ ok: true });
  }));
  app.post('/api/finance/orders/:no/balance-extension', auth('finance'), wrap(async (req, res) => {
    await ready;
    const b = req.body || {}, note = noteOf(b);
    if (typeof b.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(b.dueAt) || !Number.isFinite(Date.parse(b.dueAt)) || Date.parse(b.dueAt) <= Date.now() || new Date(b.dueAt.slice(0, 10)).toISOString().slice(0, 10) !== b.dueAt.slice(0, 10))
      throw bad('dueAt', 'Choose a future balance due date and time');
    await tx(async (db) => {
      const o = (await db.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!o) throw bad('id', 'Order not found');
      if (closed(o) || orderMoney(o).balance <= 0) throw bad('status', 'Only an open order with an unpaid balance can be extended');
      const old = await dueAt(db, o);
      if (old && Date.parse(b.dueAt) <= old) throw bad('dueAt', 'The extension must be later than the current due date');
      await db.query('UPDATE orders SET balance_due_at = $2 WHERE order_id = $1', [o.order_id, b.dueAt]);
      await resume(db, o, req.user, 'due date extended');
      await audit(db, req.user, 'Record edited', `Order ${o.order_no}: balance extended to ${b.dueAt} — ${note}`);
    });
    res.json({ ok: true });
  }));
  app.post('/api/finance/orders/:no/credit-exception', auth('finance'), wrap(async (req, res) => {
    await ready;
    const b = req.body || {}, action = str(b.action) || 'grant';
    if (!['grant','approve','revoke'].includes(action)) throw bad('action', 'Choose grant, approve or revoke');
    const note = action === 'revoke' ? str(b.note) : noteOf(b);
    const result = await tx(async (db) => {
      const o = (await db.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!o) throw bad('id', 'Order not found');
      if (['Cancelled','Returned'].includes(o.status)) throw bad('status', 'This order is closed');
      const balance = orderMoney(o).balance;
      if (action === 'revoke') {
        await db.query(`UPDATE orders SET credit_exception_by=NULL, credit_exception_note=NULL, credit_exception_at=NULL,
          credit_pending_by=NULL, credit_pending_note=NULL, credit_pending_balance=NULL, credit_second_by=NULL, credit_second_note=NULL WHERE order_id=$1`, [o.order_id]);
      } else if (action === 'grant' && balance > creditLimit) {
        if (o.credit_exception_by) throw bad('action', 'Revoke the existing exception before requesting another');
        if (o.credit_pending_by) throw bad('action', 'A second Finance approver must approve or revoke the pending request');
        await db.query('UPDATE orders SET credit_pending_by=$2, credit_pending_note=$3, credit_pending_balance=$4 WHERE order_id=$1', [o.order_id, req.user.id, note, balance]);
        await audit(db, req.user, 'Record edited', `Order ${o.order_no}: credit exception pending second approval for ${balance} (single-user limit ${creditLimit}) — ${note}`);
        return { pending: true, outstanding: balance };
      } else {
        if (action === 'approve') {
          if (!o.credit_pending_by) throw bad('action', 'There is no pending credit exception');
          if (Number(o.credit_pending_by) === Number(req.user.id)) throw bad('approver', 'A different signed-in Finance user must approve this exception');
          if (balance > Number(o.credit_pending_balance)) throw bad('balance', 'The balance increased. Revoke and submit a new request');
          const first = (await db.query("SELECT u.user_id FROM users u JOIN roles r USING(role_id) WHERE u.user_id=$1 AND u.status='active' AND r.role_key='finance' FOR SHARE OF u", [o.credit_pending_by])).rows[0];
          if (!first) throw bad('approver', 'The requesting Finance user is no longer active. Submit a new request');
        } else if (o.credit_pending_by) throw bad('action', 'Approve or revoke the pending request first');
        const firstId = action === 'approve' ? o.credit_pending_by : req.user.id;
        const firstNote = action === 'approve' ? o.credit_pending_note : note;
        await db.query(`UPDATE orders SET credit_exception_by=$2, credit_exception_note=$3, credit_exception_at=now(),
          credit_second_by=$4, credit_second_note=$5, credit_pending_by=NULL, credit_pending_note=NULL, credit_pending_balance=NULL WHERE order_id=$1`,
        [o.order_id, firstId, firstNote, action === 'approve' ? req.user.id : null, action === 'approve' ? note : null]);
        await resume(db, o, req.user, 'credit exception approved');
      }
      await audit(db, req.user, 'Record edited', `Order ${o.order_no}: credit exception ${action}, outstanding ${balance} — ${note}`);
      return { pending: false, outstanding: balance, creditException: action === 'revoke' ? null : { by: action === 'approve' ? o.credit_pending_by : req.user.id, note: action === 'approve' ? o.credit_pending_note : note } };
    });
    res.json({ ok: true, ...result });
  }));
  app.get('/api/finance/orders/:no/cancellation-policy', auth('finance'), wrap(async (req, res) => {
    await ready;
    const o = (await pool.query('SELECT * FROM orders WHERE order_no = $1', [req.params.no])).rows[0];
    if (!o) throw bad('id', 'Order not found');
    const quotes = (await pool.query('SELECT * FROM quote_requests WHERE converted_order_id = $1', [o.order_id])).rows;
    const pending = (await pool.query("SELECT reason_code FROM order_cancel_requests WHERE order_id=$1 AND status='pending'", [o.order_id])).rows[0];
    res.json({ madeToOrder: quotes.some(isMadeToOrder), paid: Number(o.paid_amount) || 0, requestedReason: pending?.reason_code || null });
  }));
  async function cancellationPolicy(db, o, code, body, actor) {
    const quotes = (await db.query('SELECT * FROM quote_requests WHERE converted_order_id = $1', [o.order_id])).rows;
    const applicable = ['balance_unpaid','changed_mind'].includes(code) && quotes.some(isMadeToOrder) && Number(o.paid_amount) > 0;
    if (code === 'balance_unpaid' && !(o.status === 'On Hold' && o.balance_hold_from)) throw bad('reasonCode', 'Balance-unpaid cancellation requires an overdue balance hold');
    let kept = 0;
    if (applicable) {
      if (!['forfeit','refund'].includes(body.depositDisposition)) throw bad('depositDisposition', 'Finance must choose forfeit down payment or refund');
      const note = noteOf(body);
      const m = orderMoney(o);
      // Retain at most the agreed initial deposit; any excess remains refundable.
      kept = body.depositDisposition === 'forfeit' ? Math.round(Math.min(m.paid, Math.max(0, o.terms_amount == null ? m.total * 0.5 : Number(o.terms_amount))) * 100) / 100 : 0;
      await db.query(`UPDATE orders SET deposit_disposition=$2, deposit_decision_note=$3, deposit_decided_by=$4,
        deposit_decided_at=now(), forfeited_amount=$5 WHERE order_id=$1`, [o.order_id, body.depositDisposition, note, actor.id, kept]);
      await audit(db, actor, 'Record edited', `Order ${o.order_no}: ${code}, down payment ${body.depositDisposition}, retained ${kept} — ${note}`);
    }
    await db.query('UPDATE orders SET cancel_reason_code=$2 WHERE order_id=$1', [o.order_id, code]);
    return kept;
  }
  return { holdOverdue, dueAt, productionDecision, assertProduction, cancellationPolicy, balanceSettings: { dueDays, graceDays, creditLimit } };
};
