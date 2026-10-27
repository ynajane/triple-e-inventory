/* quote-desk.js — the Cashier Quotation Desk read/write API that the redesigned POS workspace talks to.

   shop-extras.js already owns the quotation life-cycle (create, clarify, price, approve, respond, pay, fulfil).
   This module only adds what the desk screen needs on top of it, without changing those routes:
     • GET    /api/pos/quote-desk                     full-width list: search, status/source filters, sorting, pagination, facet counts
     • GET    /api/pos/quote-desk/:no                 one quotation in full, with its whole clarification history
     • POST   /api/pos/quote-desk/:no/convert         accepted quotation -> order (online customer) or POS hand-off (walk-in)

   Mounted in server.js:  require('./quote-desk')({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo });
*/
const PAGE_SIZES = [10, 20, 50, 100];
const DEFAULT_PAGE_SIZE = 10;
const REQUEST_ID_RE = /^[a-zA-Z0-9-]{12,100}$/;

/* The quoted quantity must be in the unit the product is sold in. Without this, "5 kg" on a product sold by pcs would become
   5 pcs at (price / 5) each: the number crosses over but the unit does not. */
const sameUnit = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/* "200 pcs" / "12.5 linear m" as readQuote() stores them -> { qty, unit } */
function splitQuantity(text) {
  const m = /^([\d,.]+)\s+(.+)$/.exec(String(text || '').trim());
  if (!m) return null;
  const qty = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(qty) && qty > 0 ? { qty, unit: m[2] } : null;
}

module.exports = function mountQuoteDesk({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  // pg returns DATE columns as a JS Date at LOCAL midnight; toISOString() would shift it to the day before on a UTC+8 server
  const dateStr = (d) => { if (!d) return undefined; if (typeof d === 'string') return d.slice(0, 10);
    const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const ms = (d) => (d ? new Date(d).getTime() : undefined);
  const nc = () => app.locals.notifications;
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);

  /* ---------------- schema (runs on every start, nothing is dropped) ---------------- */
  const ready = (async () => {
    try {
      await require('./schema-retry')(async () => {   // quote_requests is created by shop-extras.js, which may not have run yet
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_order_id BIGINT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS converted_note TEXT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS convert_request_id TEXT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_sale_id BIGINT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS handover_at TIMESTAMPTZ');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS contact_email TEXT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS company_name TEXT');
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS flexible_date BOOLEAN NOT NULL DEFAULT FALSE');
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_convert_request ON quote_requests (convert_request_id) WHERE convert_request_id IS NOT NULL');
        console.log('[quote-desk] conversion columns ready');
      });
    } catch (err) { console.warn('[quote-desk] could not prepare the quotation desk tables:', err.message); }
  })();
  app.use('/api/pos/quote-desk', (req, res, next) => { ready.then(() => next(), next); });

  /* ---------------- the list ---------------- */
  // Only these columns can be sorted on; anything else is refused rather than interpolated.
  const SORTS = {
    created: 'q.created_at', needed: "COALESCE(q.needed_by, (current_date + interval '100 year'))", reference: 'q.quote_no',
    customer: 'q.contact_name', product: 'q.product_name', amount: 'COALESCE(q.quoted_amount, q.proposed_amount)',
    status: `CASE q.status WHEN 'new' THEN 0 WHEN 'awaiting_details' THEN 0 WHEN 'pending_approval' THEN 1 WHEN 'quoted' THEN 2
              WHEN 'accepted' THEN 3 WHEN 'preparing' THEN 4 WHEN 'ready' THEN 5 WHEN 'completed' THEN 6 ELSE 7 END`
  };
  const FILTERS = {
    open: ["q.status IN ('new','awaiting_details')"],
    approval: ["q.status = 'pending_approval'"],
    quoted: ["q.status = 'quoted'"],
    active: ["q.status IN ('accepted','preparing','ready')"],
    done: ["q.status IN ('completed','declined','closed')"],
    all: []
  };
  const SOURCES = { shop: ["q.source = 'shop'"], pos: ["q.source = 'pos'"], all: [] };
  const labelFor = (st, f, expired) => ({
    new: 'Pending Cashier Review', awaiting_details: 'Awaiting Customer Details', pending_approval: 'Awaiting Finance Approval',
    quoted: expired ? 'Quote Expired' : 'Quote Ready', accepted: 'Accepted', declined: 'Declined', closed: 'Closed',
    preparing: 'Preparing', ready: f === 'Delivery' ? 'Out for Delivery' : 'Ready for Pickup',
    completed: f === 'Delivery' ? 'Delivered' : 'Picked Up'
  })[st] || st;

  // null (never undefined) so every column key survives JSON and the table always has something to render
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : round2(Number(v)));
  const briefJson = (q) => {
    const total = q.quoted_amount == null ? null : round2(+q.quoted_amount), expired = q.status === 'quoted' && !!dateStr(q.valid_until) && dateStr(q.valid_until) < todayPH();
    return {
      id: q.quote_no, customer: q.contact_name, phone: q.phone, product: q.product_name || 'Custom item', sku: q.product_sku || null,
      quantity: q.quantity, specs: q.specs || null, neededBy: dateStr(q.needed_by) || null, neededMonths: q.needed_months || null,
      flexibleDate: q.flexible_date === true, company: q.company_name || null,
      fulfillment: q.fulfillment || null, area: q.area || null, source: q.source || 'shop', requestDate: ms(q.created_at),
      amount: money(total), proposedAmount: money(q.proposed_amount), leadTime: q.lead_time || null,
      costStale: q.cost_stale_note || null,          // recipe-costing.js: a material cost moved after this price was worked out
      estimatedReady: ((app.locals.quoteReadyBy && app.locals.quoteReadyBy(q)) || null),
      lateForNeededBy: !!(app.locals.quoteReadyBy && app.locals.quoteReadyBy(q) && dateStr(q.needed_by) && app.locals.quoteReadyBy(q) > dateStr(q.needed_by)),
      validUntil: dateStr(q.valid_until) || null, expired, status: q.status, statusLabel: labelFor(q.status, q.fulfillment, expired),
      paidAmount: money(q.paid_amount), balance: total == null ? null : Math.max(0, round2(total - (+q.paid_amount || 0))),
      // both come from the payment ledger trigger in PostgreSQL, never worked out here
      paymentState: q.payment_state || (+q.paid_amount > 0 && total != null && +q.paid_amount >= total ? 'paid' : +q.paid_amount > 0 ? 'partially_paid' : 'unpaid'),
      clarificationStatus: q.clarification_status || null,
      orderNo: q.order_no || null, converted: !!q.converted_order_id, handoverAt: ms(q.handover_at) || null, createdBy: q.created_by_name || null,
      financeNote: q.finance_note || null
    };
  };
  const detailJson = (q, clarifications, notes) => ({
    ...briefJson(q),
    details: q.details, replyNote: q.reply_note || null, approvalReason: q.approval_reason || null,
    closeReason: q.close_reason ? ({ customer_cancelled: 'The customer cancelled or no longer needs it', no_response: 'The customer did not respond', price_not_agreed: 'The customer did not agree with the price',
      cannot_make: 'We cannot make this item or get the material', duplicate: 'Duplicate of another request', other: 'Other reason' })[q.close_reason] || q.close_reason : null,
    contactEmail: q.contact_email || null,
    responseNote: q.response_note || null, respondedAt: ms(q.responded_at) || null, email: q.customer_email || null,
    customerId: q.customer_id || null, handledBy: q.handled_by_name || null, updatedAt: ms(q.updated_at),
    payments: Array.isArray(q.payments) ? q.payments : [], progress: Array.isArray(q.progress) ? q.progress : [],
    terms: (app.locals.paymentTerms || {}).quoteTerms ? app.locals.paymentTerms.quoteTerms(q) || undefined : undefined,
    // which payment scope applies is the ledger module's rule, so the desk asks it instead of judging from the sku
    madeToOrder: (app.locals.paymentTerms || {}).isMadeToOrder ? app.locals.paymentTerms.isMadeToOrder(q) : undefined,
    receivedBy: q.received_by || undefined, payMethod: q.pay_method || undefined,
    clarifications: clarifications.map((c) => ({
      id: c.clarification_id, fields: c.fields, message: c.message, responseDue: dateStr(c.response_due), status: c.status,
      response: c.response || undefined, submittedSpecs: c.submitted_specs || undefined, askedBy: c.asked_by_name || undefined,
      createdAt: ms(c.created_at), answeredAt: ms(c.answered_at)
    })),
    notes
  });

  const SEARCHABLE = 'LOWER(CONCAT(q.quote_no, \' \', q.contact_name, \' \', q.phone, \' \', COALESCE(q.product_name, \'\')))';

  app.get('/api/pos/quote-desk', auth('cashier'), wrap(async (req, res) => {
    const g = (k, d) => String(req.query[k] == null ? '' : req.query[k]).trim() || d || '';
    const filter = FILTERS[g('status', 'all').toLowerCase()] ? g('status', 'all').toLowerCase() : 'all';
    const source = SOURCES[g('source', 'all').toLowerCase()] ? g('source', 'all').toLowerCase() : 'all';
    const sortKey = SORTS[g('sort', 'created')] ? g('sort', 'created') : 'created';
    const dir = g('dir', 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const page = Math.max(1, Math.min(10000, Number(req.query.page) || 1) | 0);
    const sizeRaw = Number(req.query.pageSize);
    const pageSize = PAGE_SIZES.includes(sizeRaw) ? sizeRaw : DEFAULT_PAGE_SIZE;
    const term = g('q').toLowerCase().replace(/[^\S]+/g, ' ');
    const mine = g('mine').toLowerCase() === 'true';

    const where = ['1=1'], params = [];
    SOURCES[source].forEach((c) => where.push(c));
    if (mine) { params.push(req.user.id); where.push(`q.created_by = $${params.length}`); }
    if (term) { params.push('%' + term.replace(/[%_]/g, (c) => '\\' + c) + '%'); where.push(`${SEARCHABLE} LIKE $${params.length} ESCAPE '\\'`); }
    const clauseBase = where.join(' AND ');                       // search + source only, so the chips can show what else is waiting
    const clause = where.concat(FILTERS[filter]).join(' AND ');   // plus the status chip the cashier picked

    const [pageRows, facetRows, totals, baseTotals] = await Promise.all([
      pool.query(
        `SELECT q.*, c.full_name AS created_by_name, h.full_name AS handled_by_name, cu.email AS customer_email, o.order_no,
                (SELECT k.status FROM quote_clarifications k WHERE k.quote_id = q.quote_id AND k.status = 'awaiting_customer' LIMIT 1) AS clarification_status
           FROM quote_requests q
           LEFT JOIN users c ON c.user_id = q.created_by
           LEFT JOIN users h ON h.user_id = q.handled_by
           LEFT JOIN users cu ON cu.user_id = q.customer_id
           LEFT JOIN orders o ON o.order_id = q.converted_order_id
          WHERE ${clause}
          ORDER BY ${SORTS[sortKey]} ${dir}, q.quote_id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize]),
      pool.query(
        `SELECT q.status, count(*)::int AS n FROM quote_requests q
          WHERE ${clauseBase}
          GROUP BY q.status`, params),                         // same search + source as "All", so the chip numbers add up
      pool.query(`SELECT count(*)::int AS n FROM quote_requests q WHERE ${clause}`, params),
      pool.query(`SELECT count(*)::int AS n FROM quote_requests q WHERE ${clauseBase}`, params)
    ]);

    const counts = { all: baseTotals.rows[0].n, open: 0, approval: 0, quoted: 0, active: 0, done: 0 };
    facetRows.rows.forEach((r) => {
      if (['new', 'awaiting_details'].includes(r.status)) counts.open += r.n;
      else if (r.status === 'pending_approval') counts.approval += r.n;
      else if (r.status === 'quoted') counts.quoted += r.n;
      else if (['accepted', 'preparing', 'ready'].includes(r.status)) counts.active += r.n;
      else if (['completed', 'declined', 'closed'].includes(r.status)) counts.done += r.n;
    });
    res.json({
      rows: pageRows.rows.map(briefJson), page, pageSize, total: totals.rows[0].n,
      pageCount: Math.max(1, Math.ceil(totals.rows[0].n / pageSize)), counts,
      sort: sortKey, dir: dir.toLowerCase(), filter, source
    });
  }));

  app.get('/api/pos/quote-desk/:no', auth('cashier'), wrap(async (req, res) => {
    const no = str(req.params.no).slice(0, 40);
    const q = (await pool.query(
      `SELECT q.*, c.full_name AS created_by_name, h.full_name AS handled_by_name, cu.email AS customer_email, o.order_no, o.status AS order_status, o.payment_status,
              d.full_name AS terms_decided_by_name
         FROM quote_requests q
         LEFT JOIN users c ON c.user_id = q.created_by
         LEFT JOIN users h ON h.user_id = q.handled_by
         LEFT JOIN users cu ON cu.user_id = q.customer_id
         LEFT JOIN users d ON d.user_id = q.terms_decided_by
         LEFT JOIN orders o ON o.order_id = q.converted_order_id
        WHERE q.quote_no = $1`, [no])).rows[0];
    if (!q) throw bad('id', 'Quotation not found');
    const { rows: clar } = await pool.query(
      `SELECT k.*, u.full_name AS asked_by_name FROM quote_clarifications k LEFT JOIN users u ON u.user_id = k.created_by
        WHERE k.quote_id = $1 ORDER BY k.created_at DESC`, [q.quote_id]);
    const { rows: log } = await pool.query(
      `SELECT action, detail, user_name, role_label, occurred_at FROM audit_log
        WHERE detail LIKE '%' || $1 || '%' ORDER BY occurred_at DESC LIMIT 25`, [no]);
    res.json(detailJson(q, clar, log.map((l) => ({ at: ms(l.occurred_at), action: l.action, detail: l.detail, by: `${l.user_name || 'System'} (${l.role_label || ''})` }))));
  }));

  /* ---------------- accepted quotation -> order / POS transaction ----------------
     Exactly once: the same requestId retried returns the order that was already made; a second click with a fresh
     requestId is still refused once converted_order_id is set. Stock is only checked here, never taken out: goods leave
     inventory in the existing order-confirm / POS-sale paths, and the order is created unpaid. */
  app.post('/api/pos/quote-desk/:no/convert', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && REQUEST_ID_RE.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'A conversion identifier is required. Refresh the page and try again.');
    const out = await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [74120, req.user.id]);
      const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!q) throw bad('id', 'Quotation not found');
      if (q.converted_order_id) {                                   // already converted: hand back the same order
        const o = (await client.query('SELECT order_no, total, status FROM orders WHERE order_id = $1', [q.converted_order_id])).rows[0];
        return { kind: 'order', duplicate: true, orderNo: o && o.order_no, total: o ? +o.total : null };
      }
      if (q.status !== 'accepted') throw bad('status', 'Only a quotation the customer accepted can be converted');
      if (q.quoted_amount == null) throw bad('amount', 'This quotation has no approved price yet');
      if (!q.product_sku) throw bad('product', 'This is a custom item with no catalog product. Finance records it as a production order instead');
      const qv = splitQuantity(q.quantity);
      if (!qv) throw bad('quantity', 'The quoted quantity could not be read. Contact Finance');

      if (q.source === 'pos' || !q.customer_id) {                   // walk-in: the counter rings it up as a normal POS sale
        const p = (await client.query(
          `SELECT product_id, sku, name, unit, selling_price, on_hand FROM products
            WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [q.product_sku.toUpperCase()])).rows[0];
        if (!p) throw bad('product', 'That catalog product is no longer sold at the counter');
        if (!sameUnit(qv.unit, p.unit)) throw bad('quantity', `This quotation is in ${qv.unit}, but ${p.name} is sold by ${p.unit}. Ask Finance to correct the quotation before it goes to the counter`);
        if (+p.on_hand < qv.qty) throw bad('stock', `Only ${+p.on_hand} ${p.unit} of ${p.name} are in stock`);
        const hand = (await client.query(
          `UPDATE quote_requests SET handover_at = now(), updated_at = now() WHERE quote_id = $1 AND handover_at IS NULL RETURNING handover_at`,
          [q.quote_id])).rows[0];
        if (!hand) throw bad('status', 'This quotation was already handed to the counter. Finish that sale or void it first');
        await audit(client, req.user, 'Record added', `Quote ${q.quote_no} handed to the POS terminal (${qv.qty} ${qv.unit} of ${p.sku})`);
        return { kind: 'pos', sku: p.sku, name: p.name, unit: p.unit, qty: qv.qty, unitPrice: round2(+q.quoted_amount / qv.qty), stock: +p.on_hand, customer: q.contact_name, phone: q.phone, quoteNo: q.quote_no };
      }

      const p = (await client.query(
        `SELECT product_id, sku, name, unit, selling_price, on_hand, shop_visible FROM products
          WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [q.product_sku.toUpperCase()])).rows[0];
      if (!p) throw bad('product', 'That catalog product is no longer available');
      if (!sameUnit(qv.unit, p.unit)) throw bad('quantity', `This quotation is in ${qv.unit}, but ${p.name} is sold by ${p.unit}. Ask Finance to correct the quotation before converting it`);
      if (+p.on_hand < qv.qty) throw bad('stock', `Only ${+p.on_hand} ${p.unit} of ${p.name} are in stock. Ask the customer to adjust the quantity`);

      // an order needs the payment method and, for delivery, a structured address
      const method = q.pay_method === 'Xendit' ? 'Xendit' : (q.fulfillment === 'Delivery' ? 'Cash on Delivery' : 'Cash on Pickup');
      let ship = null;
      if (q.fulfillment === 'Delivery') {
        ship = await buildShipTo(client, q, b.shipTo || {});
      }
      const ins = await client.query(
        `INSERT INTO orders (customer_id, fulfillment, address, phone, payment_method, subtotal, delivery_fee, total,
                             recipient_name, address_line, landmark, barangay, city, province, region, zip_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [q.customer_id, q.fulfillment, ship ? ship.fullAddress : (q.area || null), q.phone, method, +q.quoted_amount, 0, +q.quoted_amount,
         ship && ship.recipient, ship && ship.addressLine, ship && ship.landmark || null, ship && ship.barangay, ship && ship.city,
         ship && ship.province, ship && ship.region, ship && ship.zip]);
      const o = ins.rows[0];
      await client.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit, qty, price, unit_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT unit_cost FROM products WHERE product_id = $2))`,
        [o.order_id, p.product_id, p.sku, p.name, p.unit, qv.qty, round2(+q.quoted_amount / qv.qty)]);
      await client.query(
        `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
        [o.order_id, o.status, o.status, req.user.id, `Created from accepted quotation ${q.quote_no} (${peso(q.quoted_amount)})`]);
      // the approved payment terms belong to the order now, and any money already paid on the quotation moves with it,
      // so the customer is never asked to pay the balance twice (payment-terms.js owns that ledger transfer)
      const pt = app.locals.paymentTerms;
      let movedMoney = null;
      if (pt) {
        await pt.inheritTerms(client, { quote: q, orderId: o.order_id, actor: req.user });
        movedMoney = await pt.moveQuotePaymentsToOrder(client, { quoteId: q.quote_id, quoteNo: q.quote_no, orderId: o.order_id, orderNo: o.order_no, actor: req.user });
        if (movedMoney && movedMoney.moved) {
          const after = (await client.query('SELECT paid_amount, payment_state FROM orders WHERE order_id = $1', [o.order_id])).rows[0];
          movedMoney.paidAmount = +((after || {}).paid_amount || 0);
          movedMoney.paymentState = (after || {}).payment_state;
        }
      }
      await client.query(
        `UPDATE quote_requests SET converted_order_id = $2, converted_at = now(), convert_request_id = $3, converted_note = $4, updated_at = now() WHERE quote_id = $1`,
        [q.quote_id, o.order_id, requestId, `Converted by ${req.user.name || 'cashier'}`]);
      await audit(client, req.user, 'Record added', `Quote ${q.quote_no} converted to order ${o.order_no} (${qv.qty} ${qv.unit} of ${p.sku}, ${peso(q.quoted_amount)})`);
      return { kind: 'order', orderNo: o.order_no, total: +o.total, status: o.status, method, customerId: q.customer_id, quoteNo: q.quote_no, duplicate: false,
        paymentsMoved: movedMoney && movedMoney.moved ? movedMoney.moved : 0, paidAmount: movedMoney && movedMoney.paidAmount != null ? movedMoney.paidAmount : 0 };
    });
    res.json(out);
    if (out.kind === 'order' && !out.duplicate) {
      Promise.resolve(pingFinance({ category: 'orders', title: 'Quotation converted to an order', body: `${out.quoteNo} is now order ${out.orderNo} (${peso(out.total)}), waiting for the normal payment and stock steps.`, link: 'Finance_Inventory.html#orders', entityType: 'order', entityId: out.orderNo })).catch(() => {});
    }
  }));

  /* Delivery orders need the structured Philippine address the shop uses. The quotation only stored a single text line, so
     the cashier confirms the parts in the convert dialog; anything already saved on the quote is offered first. */
  async function buildShipTo(client, q, typed) {
    const from = {
      recipient: str(typed.recipient) || str(q.contact_name), phone: str(typed.phone) || str(q.phone),
      addressLine: str(typed.addressLine), landmark: str(typed.landmark) || undefined,
      barangay: str(typed.barangay), city: str(typed.city), province: str(typed.province), region: str(typed.region), zip: str(typed.zip)
    };
    if (!validateShipTo) throw bad('address', 'Delivery details could not be checked right now. Convert this quote from the Online Orders screen');
    try {
      const ship = await validateShipTo(from);
      ship.fullAddress = formatShipTo ? formatShipTo(ship) : [ship.addressLine, ship.barangay, ship.city, ship.province, ship.zip].filter(Boolean).join(', ');
      return ship;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw bad('address', 'Enter the full delivery address (region, province, city, barangay, ZIP) before converting');
    }
  }

  /* Called by the POS sale when a cashier rings up a handed-over walk-in quote: keeps the reference and refuses a second
     link, so one quote can never cover two invoices. */
  app.locals.quoteDesk = {
    linkSale: async (client, quoteNo, saleId) => {
      const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [quoteNo])).rows[0];
      if (!q) throw bad('quote', 'That quotation reference was not found');
      if (q.handover_sale_id && Number(q.handover_sale_id) !== Number(saleId)) throw bad('quote', 'This quotation was already used on another invoice');
      await client.query('UPDATE quote_requests SET handover_sale_id = $2, updated_at = now() WHERE quote_id = $1', [q.quote_id, saleId]);
      return q;
    },
    ready
  };

  return { ready, briefJson, detailJson, splitQuantity, labelFor };
};
