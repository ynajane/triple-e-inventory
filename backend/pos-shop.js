const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const FG = 'Finished Goods';
// Units sold by measure (weight / length / volume) may be typed with up to 2 decimals; everything else (sheet, pcs, box...) is whole numbers only.
const MEASURED_UNIT = /^(kg|g|tonne|ton|lb|m|meter|metre|ft|foot|feet|liter|litre|l|linear m|linear meter|linear metre|lm)s?$/i;
const isMeasured = (unit) => MEASURED_UNIT.test(String(unit || '').trim());
const OVERRIDE_MINUTES = 10;     // how long a supervisor approval stays valid at the counter
const VAT_RATE = 0.12;
// Fallback delivery fee, used only when no delivery rate matches the address (rates are managed by Finance: Sales > Orders > Delivery rates).
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE) || 150;
// Starting rates, written to the delivery_rates table the first time the server runs. Finance can change every one of them afterwards.
const DEFAULT_DELIVERY_RATES = [
  // [scope, place, fee, do we deliver here?]  Starting coverage: NCR and the provinces next to it. Finance changes this in Sales > Orders > Delivery rates.
  ['default', 'All other areas', DELIVERY_FEE, false],
  ['region', 'NCR - National Capital Region', 150, true],
  ['region', 'Region III - Central Luzon', 250, true],
  ['region', 'Region IV-A - CALABARZON', 250, true],
  ['region', 'CAR - Cordillera Administrative Region', 350, false],
  ['region', 'Region I - Ilocos Region', 350, false],
  ['region', 'Region II - Cagayan Valley', 350, false],
  ['region', 'MIMAROPA - Region IV-B', 350, false],
  ['region', 'Region V - Bicol Region', 350, false],
  ['region', 'Region VI - Western Visayas', 450, false],
  ['region', 'NIR - Negros Island Region', 450, false],
  ['region', 'Region VII - Central Visayas', 450, false],
  ['region', 'Region VIII - Eastern Visayas', 450, false],
  ['region', 'Region IX - Zamboanga Peninsula', 550, false],
  ['region', 'Region X - Northern Mindanao', 550, false],
  ['region', 'Region XI - Davao Region', 550, false],
  ['region', 'Region XII - SOCCSKSARGEN', 550, false],
  ['region', 'Region XIII - Caraga', 550, false],
  ['region', 'BARMM - Bangsamoro Autonomous Region', 550, false]
];
// A region has many spellings: "Region VI - Western Visayas", "Western Visayas - Region VI", "Region IV-A (CALABARZON)", "NCR - National Capital Region"...
// They are all reduced to one key (its region number or its short name), so a rate saved under one spelling matches an address that uses another.
const REGION_NAMES = [['ncr', /\bncr\b|national capital/], ['car', /\bcar\b|cordillera/], ['nir', /\bnir\b|negros island/], ['barmm', /barmm|bangsamoro/],
  ['ivb', /mimaropa/], ['iva', /calabarzon/], ['i', /ilocos/], ['ii', /cagayan valley/], ['iii', /central luzon/], ['v', /bicol/], ['vi', /western visayas/],
  ['vii', /central visayas/], ['viii', /eastern visayas/], ['ix', /zamboanga/], ['x', /northern mindanao/], ['xi', /davao/], ['xii', /soccsksargen/], ['xiii', /caraga/]];
function regionKey(name) {
  const t = String(name || '').toLowerCase().replace(/[()]/g, ' ');
  const roman = t.match(/\bregion\s+([ivx]+)(?:\s*-?\s*([ab]))?\b/);
  if (roman) return 'r:' + roman[1] + (roman[2] || '');
  const hit = REGION_NAMES.find(([, re]) => re.test(t));
  return hit ? 'r:' + hit[0] : 'x:' + t.replace(/[^a-z0-9]/g, '');
}
const rateKey = (scope, name) => scope === 'region' ? regionKey(name)
  : String(name || '').toLowerCase().replace(/\b(province|city) of\b/g, '').replace(/[^a-z0-9]/g, '');
const ONLINE_METHODS = ['Online Banking', 'E-Wallet', 'Card', 'Xendit'];
// Order life-cycle. An order can only move one step forward; the last step ends it.
const FLOW = {
  Delivery: ['Pending Confirmation', 'Paid', 'Packed', 'Out for Delivery', 'Delivered'],
  Pickup:   ['Pending Confirmation', 'Paid', 'Packed', 'Ready for Pickup', 'Picked Up']
};
const FINAL_STATUS = ['Delivered', 'Picked Up'];
const ADMIN_CANCELLABLE = ['Pending Confirmation', 'Paid', 'Packed', 'On Hold'];   // once it is out for delivery / ready for pickup it can no longer be cancelled
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
// Refunds: a customer can ask for one after the order is Delivered / Picked Up, within this many days.
const REFUND_WINDOW_DAYS = Number(process.env.REFUND_WINDOW_DAYS) || 7;
const REFUND_REASONS = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item received',
  not_as_described: 'Not as described',
  missing_items: 'Missing items',
  other: 'Other',
  cancelled: 'Order cancelled — refund of the payment'      // created by the system when a paid order is cancelled; customers cannot pick it
};
// Cancellations: the customer picks a reason. Cancelling soon after ordering (and before we pack it) is approved on the spot;
// after that window the shop decides. Change the window with CANCEL_AUTO_HOURS in .env (default 24 hours).
const CANCEL_AUTO_HOURS = Number(process.env.CANCEL_AUTO_HOURS) || 24;
const CANCEL_REASONS = {
  balance_unpaid: 'Balance unpaid after grace period', // Finance/system only
  changed_mind: 'Changed my mind',
  ordered_by_mistake: 'Ordered by mistake',
  wrong_item_or_qty: 'Wrong item or quantity',
  found_better_price: 'Found a better price',
  too_slow: 'Delivery or pickup will take too long',
  wrong_details: 'Wrong address or contact details',
  payment_problem: 'Problem with payment',
  other: 'Other'
};
// Cashier asks Finance to void an invoice: pick a reason; "Other" needs a written explanation.
const VOID_REASONS = {
  wrong_item: 'Wrong item or quantity rung up',
  wrong_price: 'Wrong price',
  changed_mind: 'Customer changed their mind',
  payment_problem: 'Payment problem',
  duplicate: 'Duplicate sale',
  other: 'Other'
};
// Partial returns at the counter: the customer brings back some of the items on an invoice. The cashier requests it, Finance approves.
const RETURN_REASONS = {
  damaged: 'Damaged or defective',
  wrong_item: 'Wrong item given',
  not_as_described: 'Not as described',
  changed_mind: 'Customer changed their mind',
  other: 'Other'
};
const RETURN_WINDOW_DAYS = Number(process.env.POS_RETURN_WINDOW_DAYS) || 7;   // how long after the sale items can still be returned
const CUSTOMER_CANCELLABLE =['Pending Confirmation', 'Paid'];   // once we start packing, only the shop can cancel

const makeOrderMail = require('./order-mail');
const makeDelivery = require('./order-delivery');

module.exports = function mount({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const { notify, shopInfo } = makeOrderMail(pool, () => app.locals.notifications);
  // courier / rider details, dispatch + delivery times and proof photos for Delivery orders (also registers its own /api/orders/:no/delivery... routes)
  const delivery = makeDelivery({ app, pool, auth, wrap, tx, audit, ValidationError, str });
  // delivery fee by weight + estimated arrival date (also registers GET / PUT /api/delivery-settings)
  const dcalc = require('./delivery-calc')({ app, pool, auth, wrap, tx, audit, ValidationError, TZ });
  const later = (fn) => { Promise.resolve().then(fn).catch((e) => console.warn('[notify]', e.message)); };
  const nc = () => app.locals.notifications;
  const asPeso = (n) => (nc() && nc().peso ? nc().peso(n) : ('\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
  function pingFinance(n) { return nc() ? nc().notifyRole('finance', n) : Promise.resolve(0); }
  function pingUser(id, n, role) { return nc() ? nc().notifyUser(id, n, role) : Promise.resolve(0); }

  // Adds what the Sales Transactions page needs (safe to run every time the server starts).
  async function ensureSalesSchema() {
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS received_by TEXT');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ');
      await pool.query(`CREATE TABLE IF NOT EXISTS order_status_history (
        history_id  BIGSERIAL PRIMARY KEY,
        order_id    BIGINT NOT NULL REFERENCES orders(order_id),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        changed_by  INT REFERENCES users(user_id),
        note        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history (order_id, created_at)');
      // make sure the status column accepts every step of the flow (an older CHECK may only know a few)
      await pool.query(`DO $$
        DECLARE c record;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'orders'::regclass AND conname = 'orders_status_flow_check') THEN
            FOR c IN SELECT conname FROM pg_constraint
                      WHERE conrelid = 'orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
            LOOP
              EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname);
            END LOOP;
            ALTER TABLE orders ADD CONSTRAINT orders_status_flow_check CHECK (status IN
              ('Pending Confirmation','Paid','Packed','Out for Delivery','Ready for Pickup','Delivered','Picked Up','Cancelled','On Hold'));
          END IF;
        END $$`);
      await pool.query(`CREATE TABLE IF NOT EXISTS order_cancel_requests (
        request_id   BIGSERIAL PRIMARY KEY,
        order_id     BIGINT NOT NULL REFERENCES orders(order_id),
        reason       TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        requested_by INT REFERENCES users(user_id),
        decided_by   INT REFERENCES users(user_id),
        decided_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('ALTER TABLE order_cancel_requests ADD COLUMN IF NOT EXISTS reason_code TEXT');
      await pool.query('ALTER TABLE order_cancel_requests ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT FALSE');
      await pool.query('ALTER TABLE order_cancel_requests ALTER COLUMN decided_by DROP NOT NULL').catch(() => {});   // instant cancellations have no staff member
    } catch (err) { console.warn('[db] could not prepare the sales tables:', err.message); }
  }
  ensureSalesSchema();

  // Xendit invoice metadata. Payment is only confirmed by the signed server callback.
  async function ensureXenditSchema() {
    try {
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS xendit_invoice_id TEXT');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS xendit_external_id TEXT');
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'");
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_xendit_invoice ON orders (xendit_invoice_id) WHERE xendit_invoice_id IS NOT NULL');
    } catch (err) { console.warn('[db] could not prepare Xendit columns:', err.message); }
  }
  ensureXenditSchema();

  const xenditBaseUrl = 'https://api.xendit.co';
  const xenditAuth = () => {
    const key = process.env.XENDIT_SECRET_KEY;
    if (!key) throw new Error('XENDIT_SECRET_KEY is not configured');
    return 'Basic ' + Buffer.from(key + ':').toString('base64');
  };
  async function xenditRequest(url, options = {}) {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: { Authorization: xenditAuth(), 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.message || 'Xendit request failed');
      err.status = response.status;
      throw err;
    }
    return data;
  }

  // Cashier hosted-checkout requests. A pending request is NOT a sale or stock movement.
  async function ensurePosPayments() {
    await pool.query(`CREATE TABLE IF NOT EXISTS pos_xendit_payments (
      customer_name TEXT, customer_phone TEXT,
      payment_id BIGSERIAL PRIMARY KEY, cashier_id INT NOT NULL REFERENCES users(user_id),
      cashier_name TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE,
      invoice_id TEXT UNIQUE, checkout_url TEXT, amount NUMERIC(12,2) NOT NULL,
      items JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      sale_id BIGINT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query('ALTER TABLE pos_xendit_payments ADD COLUMN IF NOT EXISTS customer_name TEXT');
    await pool.query('ALTER TABLE pos_xendit_payments ADD COLUMN IF NOT EXISTS customer_phone TEXT');
    await pool.query('ALTER TABLE pos_xendit_payments ADD COLUMN IF NOT EXISTS request_id TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_checkout_request ON pos_xendit_payments(cashier_id, request_id) WHERE request_id IS NOT NULL');
    await pool.query('ALTER TABLE pos_xendit_payments ADD COLUMN IF NOT EXISTS delivery JSONB');      // POS delivery sale: fee + address, kept until the payment is verified
  }
  // Optional walk-in customer details typed by the cashier at checkout (name and/or phone). Blank = anonymous walk-in.
  function readCustomer(b) {
    const name = str(b && b.customerName).replace(/\s+/g, ' ');
    const phone = str(b && b.customerPhone).replace(/\s+/g, ' ');
    if (name && (name.length < 2 || name.length > 80)) throw bad('customerName', 'Customer name must be 2-80 characters');
    if (phone && !/^\+?[0-9][0-9 ()-]{5,18}[0-9]$/.test(phone)) throw bad('customerPhone', 'Enter a valid phone number (digits only, e.g. 09171234567)');
    return { name: name || null, phone: phone || null };
  }
  /* POS delivery mode. The cashier picks Pickup (default) or Delivery. Delivery needs the customer's name + Philippine mobile number
     (these become the customer record in Customer Management > Walk-in Customers) and the same structured address the online shop uses
     (house/street + Region > Province > City > Barangay + ZIP, checked by validateShipTo). The fee comes from the delivery rates by
     region / province, exactly like an online order, and is added to the sale total. Returns null for a normal counter sale. */
  async function readPosDelivery(db, b) {
    const f = str(b && b.fulfillment) || 'Pickup';
    if (!['Pickup', 'Delivery'].includes(f)) throw bad('fulfillment', 'Choose Pickup or Delivery');
    if (f === 'Pickup') return null;
    const name = str(b.customerName), phone = str(b.customerPhone).replace(/[\s().-]/g, '');
    if (name.length < 2 || name.length > 50 || !/^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(name)) throw bad('customerName', 'Enter the customer’s full name (2–50 characters: letters, spaces, . \' and -)');
    if (!/^(\+63|0)9\d{9}$/.test(phone)) throw bad('customerPhone', 'Enter a valid mobile number, e.g. 0917 123 4567');
    const ship = await validateShipTo(Object.assign({}, b.shipTo || {}, { recipient: name }));
    const q = await deliveryQuote(db, ship, await loadSellable(db, readLines(b.items), { lock: false }));   // area rate + weight charge
    if (!q.available) throw bad('region', `Sorry, we do not deliver to ${ship.province || ship.region} yet.`);
    return { name, phone, ship, fee: round2(q.fee) };
  }
  const posDeliveryCols = (d) => d ? { fee: d.fee, recipient: d.ship.recipient, line: d.ship.addressLine, landmark: d.ship.landmark || null, barangay: d.ship.barangay,
    city: d.ship.city, province: d.ship.province, region: d.ship.region, zip: d.ship.zip, full: d.ship.fullAddress } : null;
  const posPaymentsReady = ensurePosPayments().catch(e => { console.error('[db] POS Xendit schema:', e.message); throw e; });
  posPaymentsReady.catch(() => {});          // already logged above; without this a database that is not reachable yet at boot would crash the whole server (unhandled rejection)
  const posPaymentJson = (p) => ({ paymentId: p.payment_id, requestId: p.request_id,
    checkoutUrl: p.checkout_url, amount: +p.amount, status: p.status, sale_id: p.sale_id, items: p.items });
  // Recover only this cashier's unresolved checkouts and explicitly remembered requests.
  app.get('/api/pos/xendit-payments', auth('cashier'), wrap(async (req, res) => {
    await posPaymentsReady;
    const ids = String(req.query.ids || '').split(',').filter(Boolean);
    const requests = String(req.query.requests || '').split(',').filter(Boolean);
    if (ids.length > 50 || requests.length > 50 || ids.some(x => !/^\d{1,18}$/.test(x)) || requests.some(x => !/^[a-zA-Z0-9-]{12,100}$/.test(x)))
      throw bad('payments', 'Invalid payment recovery request');
    const { rows } = await pool.query(`SELECT * FROM pos_xendit_payments
      WHERE cashier_id=$1 AND (status IN ('pending','review') OR payment_id=ANY($2::bigint[]) OR request_id=ANY($3::text[]))
      ORDER BY payment_id DESC`, [req.user.id, ids, requests]);
    res.json(rows.map(posPaymentJson));
  }));
  app.post('/api/pos/xendit-checkout', auth('cashier'), wrap(async (req, res) => {
    await posPaymentsReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const previous = await pool.query('SELECT * FROM pos_xendit_payments WHERE cashier_id=$1 AND request_id=$2', [req.user.id, requestId]);
    if (previous.rowCount) return res.json(posPaymentJson(previous.rows[0]));
    // same rule as a cash sale: an online payment cannot even be started without an open cash shift that is still allowed to sell
    const openShift = await pool.query('SELECT opened_at FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL', [req.user.id]);
    if (!openShift.rowCount) throw bad('cashShift', 'Open your Cash Shift before taking a payment.');
    if (app.locals.shiftIsStale && app.locals.shiftIsStale(openShift.rows[0].opened_at)) throw bad('cashShift', 'Your cash shift from an earlier day is still open. Count and close it, then open a new shift, before taking a payment.');
    if (app.locals.shiftMustClose && app.locals.shiftMustClose(openShift.rows[0].opened_at)) throw bad('cashShift', 'It is time to close your cash shift. Count the drawer and close it first; no more payments can be taken on this shift.');
    const lines = readLines(b.items);
    const cust = readCustomer(b);
    const dlv = await readPosDelivery(pool, b);
    if (dlv) { cust.name = dlv.name; cust.phone = dlv.phone; }
    // Override prices are deliberately rejected here until approved override handling is implemented.
    if ((b.items || []).some(i => i && i.price !== undefined)) throw bad('items', 'Xendit checkout currently requires standard catalog prices');
    const items = await loadSellable(pool, lines, { lock: false });
    if (app.locals.shopExtras) await app.locals.shopExtras.checkMinimums(pool, items);          // minimum order (the maximum is the stock, checked above)
    const amount = round2(items.reduce((sum, i) => sum + lineCents(i.price, i.qty), 0) / 100 + (dlv ? dlv.fee : 0));
    if (!Number.isFinite(amount) || amount <= 0) throw bad('amount', 'Invalid checkout total');
    const crypto = require('crypto');
    const externalId = 'triplee-pos-' + crypto.randomUUID();
    const snapshot = items.map(i => ({ sku: i.sku, qty: i.qty, price: i.price }));
    const created = await pool.query(`INSERT INTO pos_xendit_payments (cashier_id,cashier_name,external_id,amount,items,customer_name,customer_phone,delivery,request_id)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9)
      ON CONFLICT (cashier_id,request_id) WHERE request_id IS NOT NULL DO NOTHING RETURNING payment_id`, [req.user.id,req.user.name,externalId,amount,JSON.stringify(snapshot),cust.name,cust.phone,dlv ? JSON.stringify(posDeliveryCols(dlv)) : null,requestId]);
    if (!created.rowCount) {
      const replay = await pool.query('SELECT * FROM pos_xendit_payments WHERE cashier_id=$1 AND request_id=$2', [req.user.id,requestId]);
      return res.json(posPaymentJson(replay.rows[0]));
    }
    const id = created.rows[0].payment_id;
    try {
      const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
      if (!base || !/^https?:\/\//.test(base)) throw new Error('APP_BASE_URL must be a valid frontend URL');
      const invoice = await xenditRequest(`${xenditBaseUrl}/v2/invoices`, { method:'POST', body: {
        external_id:externalId, amount, currency:'PHP', description:`Triple-E cashier payment ${id}`,
        success_redirect_url:`${base}/POS_Cashier.html?payment=return`,
        failure_redirect_url:`${base}/POS_Cashier.html?payment=failed`
      }});
      await pool.query(`UPDATE pos_xendit_payments SET invoice_id=$1,checkout_url=$2 WHERE payment_id=$3`, [invoice.id,invoice.invoice_url,id]);
      res.status(201).json({ paymentId:id, requestId, checkoutUrl:invoice.invoice_url, amount, status:'pending', items:snapshot });
    } catch(e) {
      await pool.query(`UPDATE pos_xendit_payments SET status='error',error_message=$1 WHERE payment_id=$2`, [String(e.message).slice(0,400),id]);
      throw e;
    }
  }));
  app.get('/api/pos/xendit-payments/:id', auth('cashier'), wrap(async (req,res) => {
    await posPaymentsReady;
    const sel = () => pool.query(`SELECT payment_id,status,amount,checkout_url,sale_id,error_message,invoice_id,external_id
      FROM pos_xendit_payments WHERE payment_id=$1 AND cashier_id=$2`, [req.params.id,req.user.id]);
    let {rows} = await sel();
    let checkError;
    if (!rows.length) return res.status(404).json({error:'Payment not found'});
    // Do not rely only on Xendit's callback (it cannot reach a local/offline server): ask Xendit for the invoice itself.
    if (rows[0].status === 'pending' && rows[0].invoice_id) {
      try {
        const inv = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(rows[0].invoice_id)}`);
        const st = inv.status === 'SETTLED' ? 'PAID' : inv.status;
        if (st === 'PAID' || st === 'EXPIRED') {
          await handlePosXenditWebhook({ ...inv, status: st }, rows[0].external_id, rows[0].invoice_id);
          ({rows} = await sel());
        }
      } catch (e) { checkError = e.message; console.warn('[xendit] POS status check failed:', e.message); }
    }
    const { invoice_id, external_id, ...out } = rows[0];
    res.json(checkError ? { ...out, checkError } : out);
  }));
  async function handlePosXenditWebhook(event, externalId, invoiceId) {
    await posPaymentsReady;
    await posSalesReady;
    const {rows} = await pool.query('SELECT payment_id FROM pos_xendit_payments WHERE external_id=$1 AND invoice_id=$2', [externalId,invoiceId]);
    if (!rows.length) return false;
    let kind = null, info = null;
    await tx(async client => {
      const {rows: locked} = await client.query('SELECT * FROM pos_xendit_payments WHERE payment_id=$1 FOR UPDATE', [rows[0].payment_id]);
      const p = locked[0];
      if (p.status === 'paid') return;
      if ((event.status === 'EXPIRED' || event.status === 'FAILED') && p.status === 'pending') {
        await client.query("UPDATE pos_xendit_payments SET status='expired' WHERE payment_id=$1",[p.payment_id]);
        kind = 'expired'; info = p; return;
      }
      if ((event.status === 'SETTLED' ? 'PAID' : event.status) !== 'PAID') return;
      if (Math.round(Number(event.paid_amount ?? event.amount)*100) !== Math.round(Number(p.amount)*100) || event.currency && event.currency !== 'PHP')
        throw new Error('POS Xendit paid amount/currency mismatch');
      const lines = readLines(p.items.map(i=>({sku:i.sku,qty:i.qty})));   // loadSellable needs the SKU -> qty Map that readLines builds (a plain array here caused "is not iterable")
      const items = await loadSellable(client,lines,{lock:true});
      const dl = p.delivery || null;                                  // delivery fee + address saved when the checkout was made
      const currentTotal = round2(items.reduce((sum,i)=>sum+lineCents(i.price,i.qty),0)/100 + (dl ? +dl.fee : 0));
      if (Math.round(currentTotal*100)!==Math.round(Number(p.amount)*100)) {
        await client.query("UPDATE pos_xendit_payments SET status='review',error_message='Price changed after payment; manual reconciliation required' WHERE payment_id=$1",[p.payment_id]);
        kind = 'review'; info = p; return;
      }
      const vat = round2(currentTotal * VAT_RATE / (1+VAT_RATE));
      const {rows:sales} = await client.query(`INSERT INTO pos_sales
        (cashier_id,cashier_name,method,total,vat,tendered,change_given,card_ref,customer_name,customer_phone,
         fulfillment,delivery_fee,delivery_recipient,delivery_address_line,delivery_landmark,delivery_barangay,delivery_city,delivery_province,delivery_region,delivery_zip,delivery_address)
        VALUES ($1,$2,'Xendit',$3,$4,NULL,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [p.cashier_id,p.cashier_name,currentTotal,vat,invoiceId,p.customer_name||null,p.customer_phone||null,
         dl ? 'Delivery' : 'Walk-in', dl ? +dl.fee : 0, dl&&dl.recipient, dl&&dl.line, dl&&dl.landmark, dl&&dl.barangay, dl&&dl.city, dl&&dl.province, dl&&dl.region, dl&&dl.zip, dl&&dl.full]);
      const sale = sales[0];
      for(const i of items) {
        await client.query(`INSERT INTO pos_sale_items (sale_id,product_id,sku,name,unit,qty,price,list_price,override_by,unit_cost)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,(SELECT unit_cost FROM products WHERE product_id = $2))`,[sale.sale_id,i.product_id,i.sku,i.name,i.unit,i.qty,i.price,i.price]);
        await postMovement(client,{productId:i.product_id,type:'out',reason:'sale',qty:i.qty,userId:p.cashier_id,sourceType:'pos_sale',sourceId:sale.sale_id,note:sale.receipt_no});
      }
      await client.query("UPDATE pos_xendit_payments SET status='paid',sale_id=$1 WHERE payment_id=$2",[sale.sale_id,p.payment_id]);
      kind = 'paid'; info = Object.assign({}, p, { receiptNo: sale.receipt_no });
    });
    if (kind && info) later(() => {
      if (kind === 'paid') return Promise.all([
        pingUser(info.cashier_id, { category: 'pos', title: 'Online POS payment completed',
          body: 'Invoice ' + info.receiptNo + ' for ' + asPeso(info.amount) + ' was recorded.',
          link: 'POS_Cashier.html#sales', entityType: 'sale', entityId: info.receiptNo, dedupeKey: 'pos_pay_ok:' + info.payment_id }, 'cashier'),
        pingFinance({ category: 'payment', title: 'POS online payment received',
          body: 'Cashier ' + (info.cashier_name || '') + ' — invoice ' + info.receiptNo + ' (' + asPeso(info.amount) + ').',
          link: 'Finance_Inventory.html#sales', entityType: 'sale', entityId: info.receiptNo, dedupeKey: 'pos_pay_fin:' + info.payment_id })
      ]);
      if (kind === 'review') return Promise.all([
        pingFinance({ category: 'payment', title: 'POS online payment needs review',
          body: 'Paid amount no longer matches the cart for cashier ' + (info.cashier_name || '') + ' (' + asPeso(info.amount) + '). Manual reconciliation is required.',
          link: 'Finance_Inventory.html#sales', severity: 'warn', entityType: 'pos_payment', entityId: String(info.payment_id), dedupeKey: 'pos_pay_review:' + info.payment_id }),
        pingUser(info.cashier_id, { category: 'pos', title: 'Online payment needs review',
          body: 'The payment of ' + asPeso(info.amount) + ' was received but the cart total changed. Finance must reconcile it.',
          link: 'POS_Cashier.html#sales', severity: 'warn', entityType: 'pos_payment', entityId: String(info.payment_id), dedupeKey: 'pos_pay_review_c:' + info.payment_id }, 'cashier')
      ]);
      return Promise.all([
        pingFinance({ category: 'payment', title: 'POS online payment failed',
          body: 'Cashier ' + (info.cashier_name || '') + ' — hosted checkout of ' + asPeso(info.amount) + ' expired or failed.',
          link: 'Finance_Inventory.html#sales', severity: 'warn', entityType: 'pos_payment', entityId: String(info.payment_id), dedupeKey: 'pos_pay_fail:' + info.payment_id }),
        pingUser(info.cashier_id, { category: 'pos', title: 'Online payment failed',
          body: 'The customer checkout of ' + asPeso(info.amount) + ' did not complete.',
          link: 'POS_Cashier.html#terminal', severity: 'warn', entityType: 'pos_payment', entityId: String(info.payment_id), dedupeKey: 'pos_pay_fail_c:' + info.payment_id }, 'cashier')
      ]);
    });
    return true;
  }

  // Customer starts hosted checkout for an order they own. The total always comes from PostgreSQL.
  app.post('/api/shop/orders/:no/xendit-checkout', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT order_id, order_no, total, paid_amount, payment_state, terms_key, terms_percent, terms_amount, terms_condition, status, payment_method, payment_status, xendit_invoice_id, xendit_external_id, fulfillment, advance_kind, advance_amount, delivery_fee FROM orders WHERE order_no = $1 AND customer_id = $2',
      [req.params.no, req.user.id]);
    if (!rows.length) throw bad('order', 'Order not found');
    const o = rows[0];
    const advance = isCod(o) && Number(o.advance_amount) > 0;
    if (o.payment_method !== 'Xendit' && !advance) throw bad('payment', 'This order is paid in cash, not online');
    if (advance && Number(o.paid_amount || 0) >= Number(o.advance_amount) - 0.004)
      throw bad('payment', `The ${advLabel(o)} is already paid. The rest is paid in cash on ${o.fulfillment === 'Delivery' ? 'delivery' : 'pickup'}`);
    if (['Cancelled', 'Returned'].includes(o.status)) throw bad('payment', 'This order is closed');
    if (Number(o.total) - Number(o.paid_amount || 0) < 0.01) throw bad('payment', 'This order has no remaining balance');
    const money = app.locals.paymentTerms && app.locals.paymentTerms.orderMoney(o);
    const dueNow = money ? Number(money.dueNow) : Number(o.total);
    if (!Number.isFinite(dueNow) || dueNow <= 0) throw bad('payment', 'There is no initial payment due on this order');
    const terms = moneyJson(o).terms || null;
    if (o.xendit_invoice_id) {
      try {
        const existing = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`);
        // re-use the open invoice only when it is still for the amount owed now (the terms or the balance may have changed)
        if (existing.status === 'PENDING' && existing.invoice_url && Math.round(Number(existing.amount) * 100) === Math.round(dueNow * 100))
          return res.json({ checkoutUrl: existing.invoice_url, amount: dueNow, terms });
      } catch (_) { /* create a replacement invoice below if the previous one is unavailable */ }
    }
    const externalId = `triplee-${o.order_no}-${o.order_id}-${Date.now()}`;
    const base = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (!base) throw bad('config', 'Set APP_BASE_URL to the public HTTPS address of this application');
    const invoice = await xenditRequest(`${xenditBaseUrl}/v2/invoices`, {
      method: 'POST',
      body: {
        external_id: externalId,
        amount: dueNow,
        currency: 'PHP',
        description: `Triple-E Metal Products order ${o.order_no} — ${advance ? (advLabel(o) + (o.advance_kind === 'shipping_fee' ? ' (the rest is cash on delivery)' : ' (the rest is cash on pickup)')) : Number(o.paid_amount || 0) > 0 ? 'remaining balance' : 'initial payment'}`,
        success_redirect_url: `${base}/Shop_Customer.html?payment=return`,
        failure_redirect_url: `${base}/Shop_Customer.html?payment=failed`,
        invoice_duration: 86400
      }
    });
    await pool.query('UPDATE orders SET xendit_invoice_id = $1, xendit_external_id = $2, payment_status = $3 WHERE order_id = $4',
      [invoice.id, externalId, 'pending', o.order_id]);
    res.json({ checkoutUrl: invoice.invoice_url, amount: dueNow, terms });
  }));

  async function applyShopInvoice(o, event, invoiceId) {
    if ((event.status === 'PAID' || event.status === 'SETTLED') && !['Cancelled', 'Returned'].includes(o.status)) {
      let confirmed = false, paidInfo = null, stockShort = '';
      await tx(async (client) => {
        const current = (await client.query('SELECT * FROM orders WHERE order_id = $1 FOR UPDATE', [o.order_id])).rows[0];
        if (!current || ['Cancelled', 'Returned'].includes(current.status) || current.xendit_invoice_id !== invoiceId) return;
        const payment = app.locals.paymentTerms;
        if (!payment) throw new Error('Payment ledger is unavailable');
        const money = payment.orderMoney(current);
        const amount = Number(event.paid_amount ?? event.amount);
        // Never mark paid from a browser redirect. Match the verified provider invoice to the currently owed installment.
        if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(Number(money.dueNow) * 100)) {
          // An already-processed invoice is a legitimate replay, not a new payment.
          const seen = await client.query('SELECT payment_id FROM payments WHERE provider_ref = $1', [invoiceId]);
          if (seen.rowCount) return;
          throw new Error('Xendit paid amount does not match the expected initial payment');
        }
        const result = await payment.applyPayment(client, {
          kind: 'order', no: current.order_no, amount, method: 'Xendit',
          providerRef: invoiceId, actor: { id: null, name: 'Xendit Webhook' }
        });
        if (result.replayed) return;
        // The payment_state and paid_amount are maintained by the ledger trigger.
        const fullyPaid = Math.round(Number(result.parent.balance) * 100) === 0;
        await client.query('UPDATE orders SET payment_status = $2 WHERE order_id = $1',
          [current.order_id, fullyPaid ? 'paid' : 'pending']);
        // Confirm the order by itself as soon as the part the payment terms ask for up front is in: the full amount on Full
        // Payment, the initial % on a down payment. That is the same rule the cashier's Confirm button follows
        // (payment-terms.js releaseDecision), so nobody has to press Confirm after an online payment.
        // Confirming reserves the stock; if it ran out in the meantime the payment is still kept and Finance is told.
        const after = (await client.query('SELECT * FROM orders WHERE order_id = $1', [current.order_id])).rows[0];
        const m = payment.orderMoney(after);
        paidInfo = { amount, paid: m.paid, balance: m.balance, condition: m.condition, fullyPaid };
        if (current.status === 'Pending Confirmation' && payment.releaseDecision(after, { action: 'confirm', role: 'finance', verified: true }).ok) {
          await client.query('SAVEPOINT auto_confirm');
          try {
            await confirmOrder(client, after, { id: null, name: 'Xendit Webhook', roleLabel: 'System' },
              `Confirmed automatically: Xendit invoice ${invoiceId} received ${amount}; balance ${result.parent.balance}`);
            await client.query('RELEASE SAVEPOINT auto_confirm');
            confirmed = true;
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT auto_confirm');
            if (!(err instanceof ValidationError)) throw err;
            stockShort = Object.values(err.fields || {})[0] || err.message;
          }
        }
      });
      if (!paidInfo) return;
      if (confirmed) notify(o.order_no, 'Paid', paidInfo);
      else notify(o.order_no, paidInfo.fullyPaid ? 'Fully Paid' : 'Partially Paid', paidInfo);
      if (stockShort) later(() => pingFinance({ category: 'payment', title: 'Paid online, but not confirmed',
        body: o.order_no + ' — ' + asPeso(paidInfo.amount) + ' was received online, but the order could not be confirmed: ' + stockShort + '. Restock it or contact the customer.',
        link: 'Finance_Inventory.html#orders', entityType: 'order', entityId: o.order_no, severity: 'critical', dedupeKey: 'pay_noconfirm:' + o.order_no }));
    } else if ((event.status === 'EXPIRED' || event.status === 'FAILED') && o.payment_status !== 'paid') {
      const up = await pool.query("UPDATE orders SET payment_status = 'expired' WHERE order_id = $1 AND payment_status <> 'paid' RETURNING order_id", [o.order_id]);
      if (up.rowCount) later(() => Promise.all([
        pingFinance({ category: 'payment', title: 'Online payment failed',
          body: o.order_no + ' — Xendit payment ' + String(event.status).toLowerCase() + '. The order still needs attention.',
          link: 'Finance_Inventory.html#orders', entityType: 'order', entityId: o.order_no, severity: 'warn', dedupeKey: 'pay_fail:' + o.order_no }),
        pingUser(o.customer_id, { category: 'payment', title: 'Payment failed',
          body: 'Payment for order ' + o.order_no + ' did not complete. You can try again from My Orders.',
          link: 'Shop_Customer.html#orders', entityType: 'order', entityId: o.order_no, severity: 'warn', dedupeKey: 'pay_cust_fail:' + o.order_no }, 'customer')
      ]));
    }
  }

  // The customer's page calls this after paying: ask Xendit directly, so the order is saved even if the callback never arrives.
  app.post('/api/orders/:no/check-payment', auth('cashier', 'finance'), wrap(async (req, res) => {
    const result = await pool.query('SELECT * FROM orders WHERE order_no = $1', [req.params.no]);
    if (!result.rowCount) throw bad('id', 'Order not found');
    const o = result.rows[0];
    if (paysOnline(o) && o.xendit_invoice_id && o.payment_status !== 'paid') {
      try {
        const invoice = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`);
        await applyShopInvoice(o, invoice, o.xendit_invoice_id);
      } catch (err) { console.warn('[xendit] cashier payment verification:', err.message); }
    }
    const current = await pool.query('SELECT * FROM orders WHERE order_id = $1', [o.order_id]);
    res.json({ status: current.rows[0].status, paymentStatus: current.rows[0].payment_status, ...moneyJson(current.rows[0]) });
  }));

  app.post('/api/shop/orders/:no/verify-payment', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2', [req.params.no, req.user.id]);
    if (!rows.length) throw bad('order', 'Order not found');
    const o = rows[0];
    let paymentError;
    // an invoice the ledger already holds (e.g. the down payment) has nothing left to confirm; asking Xendit again every poll is wasted work
    const booked = o.xendit_invoice_id ? (await pool.query('SELECT 1 FROM payments WHERE provider_ref = $1', [o.xendit_invoice_id])).rowCount > 0 : false;
    if (paysOnline(o) && o.xendit_invoice_id && o.payment_status !== 'paid' && !booked) {
      try {
        const inv = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`);
        await applyShopInvoice(o, inv, o.xendit_invoice_id);
      } catch (e) { console.error('[xendit] order payment check failed for ' + o.order_no + ':', e.message); paymentError = e.message; }   // shown on the payment window instead of waiting forever
    }
    const cur = await pool.query('SELECT * FROM orders WHERE order_id = $1', [o.order_id]);
    res.json({ status: cur.rows[0].status, paymentStatus: cur.rows[0].payment_status, ...moneyJson(cur.rows[0]), ...(paymentError ? { paymentError } : {}) });
  }));

  // Xendit calls this endpoint directly. Never trust the browser redirect as payment proof.
  app.post('/api/payments/xendit/webhook', wrap(async (req, res) => {
    const expected = process.env.XENDIT_CALLBACK_TOKEN;
    const supplied = req.get('x-callback-token');
    if (!expected || !supplied || !require('./security').safeEqual(supplied, expected)) return res.status(401).json({ error: 'Invalid callback token' });
    const event = req.body || {};
    const externalId = str(event.external_id);
    const invoiceId = str(event.id);
    if (!externalId || !invoiceId) return res.status(400).json({ error: 'Missing invoice identifiers' });
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE xendit_external_id = $1 AND xendit_invoice_id = $2 LIMIT 1', [externalId, invoiceId]);
    if (!rows.length) {
      if (app.locals.quoteXendit && await app.locals.quoteXendit.handle(event, externalId, invoiceId)) return res.json({ received: true });   // an accepted custom quote paid online
      await handlePosXenditWebhook(event, externalId, invoiceId); return res.json({received:true});
    }
    await applyShopInvoice(rows[0], event, invoiceId);
    res.json({ received: true });
  }));

  // POS sales remember the request id of each sale (stops a double-click or retry from saving the same sale twice).
  // No migration created this column, so without it every POS sale failed with "Server error". Safe to run every time the server starts.
  const posSalesReady = (async () => {
    try {
      await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS request_id TEXT');
      // POS documents are sales INVOICES: new numbers are SI-1001, SI-1002 ... (older R- numbers stay as they were and can still be looked up)
      await pool.query('CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1001');
      await pool.query('CREATE SEQUENCE IF NOT EXISTS receipt_no_seq START 1001');
      await pool.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'pos_sales' AND column_name = 'receipt_no' AND column_default LIKE '%''R-''%') THEN ALTER TABLE pos_sales ALTER COLUMN receipt_no SET DEFAULT ('SI-' || nextval('receipt_seq')); END IF; END $$`);
      await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS customer_name TEXT');
      await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS customer_phone TEXT');
      // POS delivery mode: 'Walk-in' (taken at the counter) or 'Delivery' (address + fee kept on the sale; the fee is part of total)
      await pool.query(`ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS fulfillment TEXT NOT NULL DEFAULT 'Walk-in',
        ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS delivery_recipient TEXT,
        ADD COLUMN IF NOT EXISTS delivery_address_line TEXT, ADD COLUMN IF NOT EXISTS delivery_landmark TEXT, ADD COLUMN IF NOT EXISTS delivery_barangay TEXT,
        ADD COLUMN IF NOT EXISTS delivery_city TEXT, ADD COLUMN IF NOT EXISTS delivery_province TEXT, ADD COLUMN IF NOT EXISTS delivery_region TEXT,
        ADD COLUMN IF NOT EXISTS delivery_zip TEXT, ADD COLUMN IF NOT EXISTS delivery_address TEXT`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_sales_cashier_request ON pos_sales (cashier_id, request_id) WHERE request_id IS NOT NULL');
      // online-payment sales are saved with method 'Xendit' (shown as "Online payment"): make sure the method column accepts it
      await pool.query(`DO $$
        DECLARE c record;
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pos_sales'::regclass AND conname = 'pos_sales_method_flow_check') THEN
            FOR c IN SELECT conname FROM pg_constraint
                      WHERE conrelid = 'pos_sales'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%method%'
            LOOP
              EXECUTE format('ALTER TABLE pos_sales DROP CONSTRAINT %I', c.conname);
            END LOOP;
            ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_method_flow_check CHECK (method IN ('Cash','Card','Xendit'));
          END IF;
        END $$`);
      // earlier online payments were saved as 'Card': relabel the ones that really came from a paid Xendit invoice
      await posPaymentsReady.catch(() => {});
      await pool.query(`UPDATE pos_sales SET method = 'Xendit'
        WHERE method = 'Card' AND card_ref IN (SELECT invoice_id FROM pos_xendit_payments WHERE status = 'paid' AND invoice_id IS NOT NULL)`);
    } catch (err) { console.warn('[db] could not prepare pos_sales.request_id:', err.message); }
  })();

  // Price overrides at the counter: keep the list price and who approved the change (safe to run every time the server starts).
  async function ensurePosOverrideSchema() {
    try {
      await pool.query('ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS list_price NUMERIC(12,2)');
      await pool.query('ALTER TABLE pos_sale_items ADD COLUMN IF NOT EXISTS override_by INT REFERENCES users(user_id)');
    } catch (err) { console.warn('[db] could not prepare the price-override columns:', err.message); }
  }
  ensurePosOverrideSchema();

  // Customer refund requests (one per order). Safe to run every time the server starts.
  async function ensureRefundSchema() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS order_refund_requests (
        request_id    BIGSERIAL PRIMARY KEY,
        order_id      BIGINT NOT NULL REFERENCES orders(order_id),
        reason_code   TEXT NOT NULL,
        details       TEXT NOT NULL,
        amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        requested_by  INT REFERENCES users(user_id),
        decided_by    INT REFERENCES users(user_id),
        decision_note TEXT,
        restocked     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at    TIMESTAMPTZ)`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_one_per_order ON order_refund_requests (order_id)');
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_refund_status ON order_refund_requests (status, created_at)`);
    } catch (err) { console.warn('[db] could not prepare the refund table:', err.message); }
  }
  ensureRefundSchema();

  // Partial returns of POS sales (safe to run every time the server starts).
  // The two shift columns are plain numbers (no foreign key) because the cash shift table is created by cash-shifts.js, which starts after this file.
  const posReturnsReady = (async () => {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS pos_return_requests (
        return_id          BIGSERIAL PRIMARY KEY,
        sale_id            BIGINT NOT NULL REFERENCES pos_sales(sale_id),
        reason             TEXT NOT NULL,
        amount             NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        refund_method      TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        restock            BOOLEAN,
        requested_by       INT REFERENCES users(user_id),
        requested_shift_id BIGINT,
        refund_shift_id    BIGINT,
        decided_by         INT REFERENCES users(user_id),
        decision_note      TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at         TIMESTAMPTZ)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS pos_return_items (
        return_item_id BIGSERIAL PRIMARY KEY,
        return_id      BIGINT NOT NULL REFERENCES pos_return_requests(return_id),
        sale_item_id   BIGINT NOT NULL REFERENCES pos_sale_items(item_id),
        product_id     INT REFERENCES products(product_id),
        qty            NUMERIC(14,2) NOT NULL CHECK (qty > 0),
        unit_price     NUMERIC(12,2) NOT NULL,
        amount         NUMERIC(12,2) NOT NULL CHECK (amount >= 0))`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_sale ON pos_return_requests (sale_id, status)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_status ON pos_return_requests (status, created_at)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_refund_shift ON pos_return_requests (refund_shift_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_pos_return_items_return ON pos_return_items (return_id)');
    } catch (err) { console.warn('[db] could not prepare the POS return tables:', err.message); }
  })();
  app.locals.posReturnsReady = posReturnsReady;   // cash-shifts.js waits for this before it reads the tables

  // Structured delivery address on orders + each customer's saved addresses (safe to run every time the server starts).
  async function ensureAddressSchema() {
    try {
      for (const col of ['recipient_name', 'address_line', 'landmark', 'barangay', 'city', 'province', 'region', 'zip_code'])
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${col} TEXT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS customer_addresses (
        address_id     BIGSERIAL PRIMARY KEY,
        user_id        INT NOT NULL REFERENCES users(user_id),
        label          TEXT NOT NULL DEFAULT 'Home',
        recipient_name TEXT NOT NULL,
        phone          TEXT NOT NULL,
        address_line   TEXT NOT NULL,
        landmark       TEXT,
        barangay       TEXT NOT NULL,
        city           TEXT NOT NULL,
        province       TEXT NOT NULL,
        region         TEXT NOT NULL,
        zip_code       TEXT NOT NULL,
        is_default     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_cust_addr_user ON customer_addresses (user_id)');
    } catch (err) { console.warn('[db] could not prepare the address tables:', err.message); }
  }
  const addressSchemaReady = ensureAddressSchema();

  /* ---------- delivery rates (fee depends on where the order is delivered) ---------- */
  async function ensureDeliveryRates() {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS delivery_rates (
        rate_id    SERIAL PRIMARY KEY,
        scope      TEXT NOT NULL CHECK (scope IN ('default','region','province')),
        name       TEXT NOT NULL,
        fee        NUMERIC(10,2) NOT NULL CHECK (fee >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_delivery_rates ON delivery_rates (scope, lower(name))');
      // available = false means "we do not deliver here" (checkout blocks it and the server refuses the order)
      const hadFlag = (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'delivery_rates' AND column_name = 'available'`)).rowCount > 0;
      await pool.query('ALTER TABLE delivery_rates ADD COLUMN IF NOT EXISTS available BOOLEAN NOT NULL DEFAULT true');
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE scope <> 'default')::int AS places FROM delivery_rates`);
      // empty table -> seed everything; only the "all other areas" row (older installs) -> add the starting region rates, otherwise every region pays the default
      if (!rows[0].n || !rows[0].places) for (const [scope, name, fee, available] of DEFAULT_DELIVERY_RATES)
        await pool.query('INSERT INTO delivery_rates (scope, name, fee, available) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope, name, fee, available]);
      // Upgrading from the version that had no coverage setting: apply the starting coverage once (province rows are left as they are)
      if (!hadFlag) {
        const cover = new Set(DEFAULT_DELIVERY_RATES.filter((r) => r[0] === 'region' && r[3]).map((r) => rateKey('region', r[1])));
        const all = (await pool.query('SELECT rate_id, scope, name FROM delivery_rates')).rows;
        for (const r of all) if (r.scope !== 'province')
          await pool.query('UPDATE delivery_rates SET available = $2 WHERE rate_id = $1', [r.rate_id, r.scope === 'region' && cover.has(rateKey('region', r.name))]);
      }
      // One-time: apply the starting coverage (NCR / Central Luzon / CALABARZON deliver, everything else blocked) to the saved rates.
      // Older databases kept every region as "We deliver here: Yes", so unreachable regions were never blocked. Fees and province rows are left alone,
      // and it never runs again, so Finance can change coverage afterwards in Sales > Orders > Delivery rates.
      await pool.query('CREATE TABLE IF NOT EXISTS delivery_rates_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      if (!(await pool.query(`SELECT 1 FROM delivery_rates_migrations WHERE name = 'coverage_v2'`)).rowCount) {
        const covered = new Set(DEFAULT_DELIVERY_RATES.filter((r) => r[0] === 'region' && r[3]).map((r) => rateKey('region', r[1])));
        const all = (await pool.query('SELECT rate_id, scope, name FROM delivery_rates')).rows;
        for (const r of all) if (r.scope !== 'province')
          await pool.query('UPDATE delivery_rates SET available = $2 WHERE rate_id = $1', [r.rate_id, r.scope === 'region' && covered.has(rateKey('region', r.name))]);
        await pool.query(`INSERT INTO delivery_rates_migrations (name) VALUES ('coverage_v2') ON CONFLICT DO NOTHING`);
        console.log('[delivery] applied the starting delivery coverage once: NCR, Central Luzon and CALABARZON deliver; other regions are blocked.');
      }
    } catch (err) { console.warn('[db] could not prepare the delivery rates table:', err.message); }
  }
  const deliveryRatesReady = ensureDeliveryRates();
  // The built-in starting rates. Used when the delivery_rates table cannot be read or is empty, so a database problem can never turn into
  // "we deliver everywhere for the standard fee": uncovered areas stay blocked.
  const BUILT_IN_RATES = DEFAULT_DELIVERY_RATES.map(([scope, name, fee, available], i) => ({ rate_id: -(i + 1), scope, name, fee, available }));
  const rateRows = async (db) => {
    await deliveryRatesReady;
    try {
      const rows = (await (db || pool).query('SELECT rate_id, scope, name, fee, available FROM delivery_rates ORDER BY scope, name')).rows;
      if (rows.length) return rows;
      console.warn('[delivery] the delivery_rates table is empty - using the built-in starting rates. Open Sales > Orders > Delivery rates and save.');
    } catch (err) { console.warn('[delivery] could not read delivery_rates - using the built-in starting rates:', err.message); }
    return BUILT_IN_RATES;
  };
  // Most specific rate wins: province, then region, then the "all other areas" rate, then DELIVERY_FEE from .env
  async function deliveryFeeFor(db, { region, province } = {}) {
    const rows = await rateRows(db);
    const hit = (scope, name) => name ? rows.find((r) => r.scope === scope && rateKey(scope, r.name) === rateKey(scope, name)) : null;
    const prov = hit('province', province);
    if (prov) return { fee: +prov.fee, rate: prov.name, scope: 'province', available: prov.available !== false };
    const reg = hit('region', region);
    if (reg) return { fee: +reg.fee, rate: reg.name, scope: 'region', available: reg.available !== false };
    const def = rows.find((r) => r.scope === 'default');
    return { fee: def ? +def.fee : DELIVERY_FEE, rate: def ? def.name : 'Standard rate', scope: 'default', available: def ? def.available !== false : false };   // no "all other areas" row: not covered
  }
  // The whole delivery quote for these goods: the area rate + the weight charge, and the estimated arrival. items = loadSellable() rows.
  async function deliveryQuote(db, place, items) {
    const base = await deliveryFeeFor(db, place);
    if (!base.available) return base;
    const q = await dcalc.quote(db, place, base, items);
    return { ...base, fee: q.fee, baseFee: q.base, weightKg: q.weightKg, extraKg: q.extraKg, weightCharge: q.weightCharge, free: q.free, feeNote: q.note, eta: q.eta };
  }
  // the cart a fee screen sends: items=SKU:qty,SKU:qty. No items = no weight, so the plain area rate (as before).
  const cartFromQuery = (v) => String(v || '').split(',').filter(Boolean).slice(0, 100).map((p) => { const [sku, qty] = p.split(':'); return { sku, qty: Number(qty) }; });
  async function quoteForRequest(db, place, itemsParam) {
    const cart = cartFromQuery(itemsParam);
    const items = cart.length ? await loadSellable(db, readLines(cart), { lock: false }) : [];
    return deliveryQuote(db, place, items);
  }
  const feeJson = (q) => ({ fee: q.fee, rate: q.rate, scope: q.scope, available: q.available, baseFee: q.baseFee, weightKg: q.weightKg, extraKg: q.extraKg, weightCharge: q.weightCharge, free: q.free, feeNote: q.feeNote || undefined, eta: q.eta });
  // shared with the quote forms (shop-extras.js), so a quotation can never promise delivery to an area the shop and the POS refuse
  app.locals.deliveryCoverage = (place) => deliveryFeeFor(pool, place || {});
  const ratesSummary = async () => {
    const rows = await rateRows();
    const fees = rows.filter((r) => r.available !== false).map((r) => +r.fee);
    return { fallback: (rows.find((r) => r.scope === 'default') || {}).fee != null ? +rows.find((r) => r.scope === 'default').fee : DELIVERY_FEE,
      from: fees.length ? Math.min(...fees) : DELIVERY_FEE, to: fees.length ? Math.max(...fees) : DELIVERY_FEE,
      defaultRate: rows.filter((r) => r.scope === 'default').map((r) => ({ name: r.name, fee: +r.fee, available: r.available !== false }))[0] || { name: 'All other areas', fee: DELIVERY_FEE, available: true },
      regions: rows.filter((r) => r.scope === 'region').map((r) => ({ name: r.name, fee: +r.fee, available: r.available !== false })),
      provinces: rows.filter((r) => r.scope === 'province').map((r) => ({ name: r.name, fee: +r.fee, available: r.available !== false })) };
  };

  /* ---------- shared helpers ---------- */
  const CATALOG_SQL = `
    SELECT p.sku, p.name, COALESCE(c.name, 'Uncategorized') AS category, p.grade, p.form, p.unit,
           p.selling_price, p.on_hand, p.reorder_level, p.shop_description, p.shop_specs,
           (SELECT image_url FROM shop_product_images WHERE product_id=p.product_id ORDER BY sort_order,image_id LIMIT 1) AS image_url
      FROM products p LEFT JOIN categories c USING (category_id)
     WHERE p.department = $1 AND NOT p.is_archived AND p.selling_price > 0 AND p.shop_visible = TRUE
     ORDER BY COALESCE(c.name, 'Uncategorized'), p.name`;
  const catalogJson = (r) => ({
    sku: r.sku, name: r.name, category: r.category, unit: r.unit,
    spec: [r.grade, r.form].filter(Boolean).join(' · '),
    description: r.shop_description || '', specs: r.shop_specs || {}, image: r.image_url || null,
    price: +r.selling_price, available: +r.on_hand, low: +r.reorder_level, fractional: isMeasured(r.unit)
  });
  async function catalog() {
    const { rows } = await pool.query(CATALOG_SQL, [FG]);
    return rows.map(catalogJson);
  }

  // [{sku, qty}] -> Map(sku -> qty); merges duplicates, rejects junk
  function readLines(items) {
    if (!Array.isArray(items) || !items.length) throw bad('items', 'Add at least one product');
    if (items.length > 100) throw bad('items', 'Too many lines in one transaction');
    const m = new Map();
    for (const it of items) {
      const sku = str(it && it.sku).toUpperCase();
      const qty = Number(it && it.qty);
      if (!sku) throw bad('items', 'Every line needs a SKU');
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6 || Math.round(qty * 100) !== qty * 100)
        throw bad('items', `Invalid quantity for ${sku}`);
      m.set(sku, round2((m.get(sku) || 0) + qty));
    }
    return m;
  }

  // Loads the sellable finished-goods rows for these SKUs (sorted by id so concurrent sales lock in the same order).
  async function loadSellable(client, lines, { lock }) {
    await dcalc.ready;   // products.weight_kg
    const { rows } = await client.query(
      `SELECT product_id, sku, name, unit, selling_price, on_hand, weight_kg
         FROM products
        WHERE upper(sku) = ANY($1) AND department = $2 AND NOT is_archived AND selling_price > 0 AND shop_visible = TRUE
        ORDER BY product_id ${lock ? 'FOR UPDATE' : ''}`, [[...lines.keys()], FG]);
    const bySku = new Map(rows.map(r => [r.sku.toUpperCase(), r]));
    const out = [];
    for (const [sku, qty] of lines) {
      const p = bySku.get(sku);
      if (!p) throw bad('items', `${sku} is not available for sale`);
      if (!isMeasured(p.unit) && !Number.isInteger(qty)) throw bad('items', `${p.name} is sold in whole ${p.unit} only`);
      if (+p.on_hand < qty) throw bad('items', `Only ${+p.on_hand} ${p.unit} of ${p.name} in stock`);
      out.push({ ...p, qty, price: +p.selling_price });
    }
    return out;
  }

  async function postMovement(client, { productId, type, reason, qty, userId, sourceType, sourceId, note }) {
    await client.query(
      `INSERT INTO stock_movements (product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT unit_cost FROM products WHERE product_id = $1))`, [productId, type, reason, qty, userId, sourceType, sourceId, note || null]);   // cost at this moment
  }

  const logStatus = (client, orderId, from, to, userId, note) => client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, from, to, userId, note || null]);

  // Payment confirmed -> take the goods out of stock (checked under a row lock so two admins cannot oversell).
  async function confirmOrder(client, o, user, note) {
    const { rows: lines } = await client.query(
      `SELECT i.product_id, i.qty, p.name, p.unit, p.on_hand
         FROM order_items i JOIN products p ON p.product_id = i.product_id
        WHERE i.order_id = $1 ORDER BY i.product_id FOR UPDATE OF p`, [o.order_id]);
    for (const l of lines)
      if (+l.on_hand < +l.qty) throw bad('stock', `Not enough stock for ${l.name}: ${+l.on_hand} ${l.unit} on hand, this order needs ${+l.qty}`);
    for (const l of lines) await postMovement(client, { productId: l.product_id, type: 'out', reason: 'online_order', qty: +l.qty,
      userId: user.id, sourceType: 'order', sourceId: o.order_id, note: o.order_no });
    // the cost of goods is fixed at the moment the stock leaves, so a later cost change never rewrites this order's profit
    await client.query('UPDATE order_items i SET unit_cost = p.unit_cost FROM products p WHERE p.product_id = i.product_id AND i.order_id = $1', [o.order_id]);
    await client.query(`UPDATE orders SET status = 'Paid', stock_deducted = TRUE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
    await logStatus(client, o.order_id, o.status, 'Paid', user.id, ['Payment confirmed — stock deducted', note].filter(Boolean).join(' — '));
    await audit(client, user, 'Record edited', `Order ${o.order_no} confirmed and paid — stock deducted`);
  }

  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* =====================================================
     POS — cashier
  ===================================================== */
  app.get('/api/pos/products', auth('cashier'), wrap(async (req, res) => {
    const rows = await catalog();
    res.json(app.locals.shopExtras ? await app.locals.shopExtras.decorate(rows, null) : rows);      // adds minOrder / maxOrder (same rule as the online shop)
  }));
  // Delivery fee for the address the cashier is typing (same rates as the online shop); the server recalculates it when the sale is saved
  app.get('/api/pos/delivery-fee', auth('cashier'), wrap(async (req, res) => {
    const region = str(req.query.region), province = str(req.query.province);
    if (!region && !province) throw bad('region', 'Choose the delivery region first');
    res.json(feeJson(await quoteForRequest(pool, { region, province }, req.query.items)));
  }));

  // ret = returnInfo() result for the sales being sent (optional). total / vat stay as originally charged;
  // refunded is the money already given back, so the till shows total - refunded as the real sale.
  const saleJson = (s, items, ret) => {
    const rs = ret && ret.sales.get(String(s.sale_id));
    return {
      id: String(s.sale_id), receiptNo: s.receipt_no, total: +s.total, vat: +s.vat, method: s.method,
      tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given,
      cardRef: s.card_ref || undefined, customerName: s.customer_name || undefined, customerPhone: s.customer_phone || undefined, cashierName: s.cashier_name,
      fulfillment: s.fulfillment || 'Walk-in', deliveryFee: +s.delivery_fee || 0,
      shipTo: s.fulfillment === 'Delivery' ? { recipient: s.delivery_recipient, addressLine: s.delivery_address_line, landmark: s.delivery_landmark || undefined, barangay: s.delivery_barangay,
        city: s.delivery_city, province: s.delivery_province, region: s.delivery_region, zip: s.delivery_zip, fullAddress: s.delivery_address } : undefined, createdAt: new Date(s.created_at).getTime(), status: s.status,
      refunded: rs ? rs.refunded : 0, returnPending: !!(rs && rs.pending),
      items: items.map(i => {
        const r = ret && ret.items.get(String(i.item_id)) || { approved: 0, pending: 0 };
        return { itemId: i.item_id === undefined ? undefined : String(i.item_id), sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price,
          returnedQty: r.approved, pendingReturnQty: r.pending, fractional: isMeasured(i.unit),
          listPrice: i.list_price !== null && i.list_price !== undefined && +i.list_price !== +i.price ? +i.list_price : undefined };
      })
    };
  };

  // How much of each sale line has been returned (approved) or is waiting for Finance (pending), plus per-sale refund totals.
  async function returnInfo(db, saleIds) {
    const out = { items: new Map(), sales: new Map() };
    if (!saleIds.length) return out;
    await posReturnsReady;
    const { rows } = await db.query(
      `SELECT ri.sale_item_id, r.status, SUM(ri.qty)::float8 AS qty FROM pos_return_items ri JOIN pos_return_requests r USING (return_id)
        WHERE r.sale_id = ANY($1) AND r.status IN ('pending','approved') GROUP BY ri.sale_item_id, r.status`, [saleIds]);
    for (const x of rows) {
      const k = String(x.sale_item_id), cur = out.items.get(k) || { approved: 0, pending: 0 };
      cur[x.status] = round2(cur[x.status] + x.qty); out.items.set(k, cur);
    }
    const sm = await db.query(
      `SELECT sale_id, COALESCE(SUM(amount) FILTER (WHERE status = 'approved'), 0)::float8 AS refunded, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM pos_return_requests WHERE sale_id = ANY($1) AND status IN ('pending','approved') GROUP BY sale_id`, [saleIds]);
    for (const x of sm.rows) out.sales.set(String(x.sale_id), { refunded: x.refunded, pending: x.pending });
    return out;
  }

  // A line total in whole centavos: price (centavos) x qty (hundredths). Integer maths so the till and the server always agree.
  const lineCents = (price, qty) => Math.round(Math.round(price * 100) * Math.round(qty * 100) / 100);

  // Supervisor approval for negotiated prices: a finance user types their own login at the counter. The password is checked once and
  // never kept; the cashier's screen only gets a short-lived signed token that is good for price overrides on this cashier's sales.
  const approvalFails = new Map();            // cashier id -> { n, until }   (stops guessing a supervisor's password at the till)
  app.post('/api/pos/override-approval', auth('cashier'), wrap(async (req, res) => {
    const f = approvalFails.get(req.user.id);
    if (f && f.until > Date.now()) throw bad('approval', 'Too many wrong attempts. Try again in a few minutes.');
    const email = str(req.body && req.body.email).toLowerCase();
    const password = req.body && req.body.password;
    if (!email || typeof password !== 'string' || !password || password.length > 200) throw bad('approval', 'Enter the supervisor email and password');
    const { rows } = await pool.query(
      `SELECT u.user_id, u.full_name, u.password_hash, u.status, r.role_key FROM users u JOIN roles r USING (role_id) WHERE u.email = $1`, [email]);
    const u = rows[0];
    const ok = !!u && u.status === 'active' && u.role_key === 'finance' && await bcrypt.compare(password, u.password_hash);
    if (!ok) {
      const n = ((f && f.until <= Date.now() ? 0 : f && f.n) || 0) + 1;
      approvalFails.set(req.user.id, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
      await audit(pool, req.user, 'Price override refused', 'Supervisor approval failed at the counter');
      throw bad('approval', 'Those supervisor details are not valid. Only a finance account can approve a price change.');
    }
    approvalFails.delete(req.user.id);
    const token = jwt.sign({ purpose: 'price_override', cashier: req.user.id, approver: u.user_id, approverName: u.full_name },
      process.env.JWT_SECRET, { expiresIn: OVERRIDE_MINUTES + 'm' });
    await audit(pool, req.user, 'Price override approved', `Approved by ${u.full_name} (valid ${OVERRIDE_MINUTES} min)`);
    res.json({ token, approver: u.full_name, expiresAt: Date.now() + OVERRIDE_MINUTES * 60000 });
  }));

  app.post('/api/pos/sales', auth('cashier'), wrap(async (req, res) => {
    await posSalesReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const lines = readLines(b.items);
    const method = str(b.method);
    if (!['Cash', 'Card'].includes(method)) throw bad('method', 'Choose Cash or Card');
    const cust = readCustomer(b);
    const dlv = await readPosDelivery(pool, b);                  // null = normal counter sale; delivery needs name, mobile and a full address
    if (dlv) { cust.name = dlv.name; cust.phone = dlv.phone; }

    // negotiated prices: {sku, qty, price} lines need a valid supervisor approval token
    const overrides = new Map();
    for (const it of b.items) {
      if (it && it.price === undefined) continue;
      const sku = str(it.sku).toUpperCase(), price = Number(it.price);
      if (!Number.isFinite(price) || price <= 0 || price > 1e7 || Math.round(price * 100) !== price * 100) throw bad('items', `Invalid price for ${sku}`);
      if (overrides.has(sku) || b.items.filter(x => str(x && x.sku).toUpperCase() === sku).length > 1) throw bad('items', `${sku} appears twice with a changed price`);
      overrides.set(sku, price);
    }
    let approval = null;
    if (overrides.size) {
      try { approval = jwt.verify(String(b.approvalToken || ''), process.env.JWT_SECRET); } catch (e) { approval = null; }
      if (!approval || approval.purpose !== 'price_override' || approval.cashier !== req.user.id)
        throw bad('approval', 'Price change needs a supervisor approval (it may have expired — ask them to approve again)');
    }

    const sale = await tx(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [73001, req.user.id]);
      const prior = await client.query('SELECT * FROM pos_sales WHERE cashier_id=$1 AND request_id=$2', [req.user.id, requestId]);
      if (prior.rowCount) {
        const it = await client.query('SELECT * FROM pos_sale_items WHERE sale_id=$1 ORDER BY item_id', [prior.rows[0].sale_id]);
        return saleJson(prior.rows[0], it.rows);
      }
      const shiftResult = await client.query('SELECT shift_id, opened_at FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE', [req.user.id]);
      if (!shiftResult.rowCount) throw bad('cashShift', 'Open your Cash Shift before completing a sale.');
      if (app.locals.shiftIsStale && app.locals.shiftIsStale(shiftResult.rows[0].opened_at)) throw bad('cashShift', 'Your cash shift from an earlier day is still open. Count and close it, then open a new shift, before completing a sale.');
      if (app.locals.shiftMustClose && app.locals.shiftMustClose(shiftResult.rows[0].opened_at)) throw bad('cashShift', 'It is time to close your cash shift. Count the drawer and close it first; no more sales can be made on this shift.');
      const cashShiftId = shiftResult.rows[0].shift_id;
      const items = await loadSellable(client, lines, { lock: true });
      if (app.locals.shopExtras) await app.locals.shopExtras.checkMinimums(client, items);     // minimum order; the maximum is the stock, checked in loadSellable
      const changed = [];
      for (const i of items) {
        const o = overrides.get(i.sku.toUpperCase());
        i.list_price = i.price;
        if (o !== undefined && o !== i.price) { changed.push(`${i.sku} ${peso(i.price)} to ${peso(o)}`); i.price = o; i.override_by = approval.approver; }
      }
      const total = round2(items.reduce((n, i) => n + lineCents(i.price, i.qty), 0) / 100 + (dlv ? dlv.fee : 0));   // delivery fee is part of the total
      let tendered = null, change = null, cardRef = null;
      if (method === 'Cash') {
        tendered = round2(Number(b.tendered));
        if (!Number.isFinite(tendered) || tendered < total) throw bad('tendered', 'Cash received is less than the total');
        if (tendered > 10000000) throw bad('tendered', 'Cash received is too large');
        change = round2(tendered - total);
      } else {
        // Card / phone payment: the customer pays exactly the total from their own phone, so there is no tendered amount or change; only the payment reference is kept.
        cardRef = str(b.cardRef).toUpperCase();
        if (!/^[A-Z0-9-]{4,30}$/.test(cardRef)) throw bad('cardRef', 'Reference number must be 4-30 letters, numbers or dashes');
        const dup = await client.query(`SELECT receipt_no FROM pos_sales WHERE method = 'Card' AND card_ref = $1 AND status <> 'Voided' LIMIT 1`, [cardRef]);
        if (dup.rowCount) throw bad('cardRef', `Reference ${cardRef} was already used on invoice ${dup.rows[0].receipt_no}`);
      }
      const vat = round2(total * VAT_RATE / (1 + VAT_RATE));
      const ins = await client.query(
        `INSERT INTO pos_sales (cashier_id, cashier_name, method, total, vat, tendered, change_given, card_ref, cash_shift_id, request_id, customer_name, customer_phone,
           fulfillment, delivery_fee, delivery_recipient, delivery_address_line, delivery_landmark, delivery_barangay, delivery_city, delivery_province, delivery_region, delivery_zip, delivery_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [req.user.id, req.user.name, method, total, vat, tendered, change, cardRef, cashShiftId, requestId, cust.name, cust.phone,
         dlv ? 'Delivery' : 'Walk-in', dlv ? dlv.fee : 0, dlv && dlv.ship.recipient, dlv && dlv.ship.addressLine, dlv && dlv.ship.landmark || null, dlv && dlv.ship.barangay,
         dlv && dlv.ship.city, dlv && dlv.ship.province, dlv && dlv.ship.region, dlv && dlv.ship.zip, dlv && dlv.ship.fullAddress]);
      const s = ins.rows[0];
      for (const i of items) {
        const li = await client.query(
          `INSERT INTO pos_sale_items (sale_id, product_id, sku, name, unit, qty, price, list_price, override_by, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT unit_cost FROM products WHERE product_id = $2)) RETURNING item_id`,   // cost at the moment of the sale
          [s.sale_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price, i.list_price, i.override_by || null]);
        i.item_id = li.rows[0].item_id;
        await postMovement(client, { productId: i.product_id, type: 'out', reason: 'sale', qty: i.qty, userId: req.user.id,
          sourceType: 'pos_sale', sourceId: s.sale_id, note: s.receipt_no });
      }
      await audit(client, req.user, 'Record added', `POS sale ${s.receipt_no} — ${peso(total)} (${method}), ${items.length} line(s)` + (dlv ? ` · delivery to ${dlv.ship.city}, ${dlv.ship.province} (fee ${peso(dlv.fee)})` : '')
        + (changed.length ? ` · price override approved by ${approval.approverName}: ${changed.join(', ')}` : ''));
      // a walk-in quotation handed to the counter: keep the reference on it so one quote can never cover two invoices
      if (str(b.quoteNo) && app.locals.quoteDesk) {
        await app.locals.quoteDesk.linkSale(client, str(b.quoteNo).toUpperCase(), s.sale_id);
        await audit(client, req.user, 'Record edited', `Quote ${str(b.quoteNo).toUpperCase()} completed as invoice ${s.receipt_no}`);
      }
      return saleJson(s, items);
    });
    res.status(201).json(sale);
  }));

  // Finance can inspect POS history across date ranges; cashiers remain limited to today.
  app.get('/api/pos/sales', auth('cashier', 'finance'), wrap(async (req, res) => {
    const valid = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
    const finance = req.user.role === 'finance';
    const all = finance && req.query.all === '1';
    const from = finance && valid(req.query.from) ? req.query.from : (finance && valid(req.query.date) ? req.query.date : null);
    const to = finance && valid(req.query.to) ? req.query.to : (from || null);
    if (finance && ((req.query.from && !valid(req.query.from)) || (req.query.to && !valid(req.query.to)) || (from && to && from > to)))
      return res.status(400).json({ error: 'Invalid POS date range' });
    const where = all ? '' : from ? `WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date` : `WHERE (created_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`;
    const params = all ? [] : from ? [TZ, from, to] : [TZ];
    const { rows: sales } = await pool.query(`SELECT * FROM pos_sales ${where} ORDER BY created_at DESC`, params);
    const { rows: items } = sales.length
      ? await pool.query('SELECT * FROM pos_sale_items WHERE sale_id = ANY($1) ORDER BY item_id', [sales.map(s => s.sale_id)])
      : { rows: [] };
    const ret = await returnInfo(pool, sales.map(s => s.sale_id));
    res.json(sales.map(s => saleJson(s, items.filter(i => i.sale_id === s.sale_id), ret)));
  }));

  // Find an older invoice by its number (the list above only shows today), so a customer can bring items back on a later day.
  app.get('/api/pos/sales/lookup', auth('cashier'), wrap(async (req, res) => {
    const no = str(req.query.receipt).toUpperCase();
    if (!/^[A-Z0-9-]{3,30}$/.test(no)) throw bad('receipt', 'Enter the invoice number printed on the invoice');
    const sr = await pool.query('SELECT * FROM pos_sales WHERE upper(receipt_no) = $1', [no]);
    if (!sr.rowCount) throw bad('receipt', 'No invoice with that number');
    const s = sr.rows[0];
    const { rows: items } = await pool.query('SELECT * FROM pos_sale_items WHERE sale_id = $1 ORDER BY item_id', [s.sale_id]);
    res.json(saleJson(s, items, await returnInfo(pool, [s.sale_id])));
  }));

  app.post('/api/pos/sales/:id/void-request', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {}, code = str(b.reason), details = str(b.details);
    if (!VOID_REASONS[code]) throw bad('reason', 'Choose the reason for the void');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please explain the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    const reason = VOID_REASONS[code] + (details ? ' \u2014 ' + details : '');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'Sale not found');
    await posReturnsReady;
    const info = await tx(async (client) => {
      const r = await client.query('SELECT sale_id, receipt_no, status FROM pos_sales WHERE sale_id = $1 FOR UPDATE', [req.params.id]);
      if (!r.rowCount) throw bad('id', 'Sale not found');
      if (r.rows[0].status !== 'Completed') throw bad('id', 'This sale already has a void request or is voided');
      // a void puts every item back in stock and removes the whole sale, which would count returned items twice
      const rt = await client.query(`SELECT 1 FROM pos_return_requests WHERE sale_id = $1 AND status IN ('pending','approved') LIMIT 1`, [r.rows[0].sale_id]);
      if (rt.rowCount) throw bad('id', 'Some items of this sale were already returned (or a return is waiting for Finance), so it cannot be voided. Return the remaining items instead.');
      const ins = await client.query('INSERT INTO void_requests (sale_id, reason, requested_by) VALUES ($1,$2,$3) RETURNING request_id', [r.rows[0].sale_id, reason, req.user.id]);
      await client.query(`UPDATE pos_sales SET status = 'Void Pending' WHERE sale_id = $1`, [r.rows[0].sale_id]);
      await audit(client, req.user, 'Record edited', `Void requested for ${r.rows[0].receipt_no}: ${reason}`);
      return { receipt: r.rows[0].receipt_no, requestId: ins.rows[0].request_id };
    });
    res.status(201).json({ ok: true });
    later(() => Promise.all([
      pingFinance({ category: 'pos', title: 'POS void approval requested',
        body: info.receipt + ' — ' + reason + ' (cashier ' + req.user.name + ').',
        link: 'Finance_Inventory.html#sales', entityType: 'void', entityId: String(info.requestId), severity: 'warn', dedupeKey: 'void_req:' + info.requestId }),
      pingUser(req.user.id, { category: 'pos', title: 'Void request sent',
        body: 'Finance was asked to void ' + info.receipt + '.',
        link: 'POS_Cashier.html#sales', entityType: 'void', entityId: String(info.requestId), dedupeKey: 'void_sent:' + info.requestId }, 'cashier')
    ]));
  }));

  /* ---------- finance: decide void requests ---------- */
  app.get('/api/pos/void-requests', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT v.request_id, v.reason, v.status, s.receipt_no, s.total, s.cashier_name,
              to_char(v.created_at AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS requested_at
         FROM void_requests v JOIN pos_sales s USING (sale_id)
        WHERE v.status = 'pending' ORDER BY v.created_at`, [TZ]);
    res.json(rows.map(r => ({ id: r.request_id, receiptNo: r.receipt_no, total: +r.total, cashier: r.cashier_name, reason: r.reason, requestedAt: r.requested_at })));
  }));

  app.post('/api/pos/void-requests/:id/decision', auth('finance'), wrap(async (req, res) => {
    const approve = (req.body || {}).approve === true;
    const decided = await tx(async (client) => {
      const r = await client.query(
        `SELECT v.request_id, v.sale_id, v.requested_by, s.receipt_no FROM void_requests v JOIN pos_sales s USING (sale_id)
          WHERE v.request_id = $1 AND v.status = 'pending' FOR UPDATE OF v, s`, [req.params.id]);
      if (!r.rowCount) throw bad('id', 'No pending void request with that id');
      const { sale_id, receipt_no, requested_by } = r.rows[0];
      if (approve) {
        const { rows: items } = await client.query('SELECT product_id, qty FROM pos_sale_items WHERE sale_id = $1 ORDER BY product_id', [sale_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty,
          userId: req.user.id, sourceType: 'pos_sale', sourceId: sale_id, note: `Void of ${receipt_no}` });
      }
      await client.query(`UPDATE pos_sales SET status = $2 WHERE sale_id = $1`, [sale_id, approve ? 'Voided' : 'Completed']);
      await client.query(`UPDATE void_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [r.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Void ${approve ? 'approved' : 'rejected'} for ${receipt_no}${approve ? ' — stock restored' : ''}`);
      return { receipt_no, requested_by };
    });
    res.json({ ok: true });
    later(() => pingUser(decided.requested_by, {
      category: 'pos', title: approve ? 'Void request approved' : 'Void request rejected',
      body: decided.receipt_no + ' was ' + (approve ? 'voided. Stock was restored.' : 'not voided. The sale stays completed.'),
      link: 'POS_Cashier.html#sales', entityType: 'void', entityId: req.params.id, severity: approve ? 'info' : 'warn',
      dedupeKey: 'void_dec:' + req.params.id + ':' + (approve ? 'ok' : 'no')
    }, 'cashier'));
  }));

  /* ---------- partial returns: cashier requests, Finance approves ---------- */
  const lineText = (rows) => rows.map(i => `${+i.qty} ${i.unit} ${i.name}`).join(', ');

  app.post('/api/pos/sales/:id/return-request', auth('cashier'), wrap(async (req, res) => {
    await posReturnsReady;
    const b = req.body || {}, code = str(b.reason), details = str(b.details);
    if (!RETURN_REASONS[code]) throw bad('reason', 'Choose the reason for the return');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please explain the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'Sale not found');
    if (!Array.isArray(b.items) || !b.items.length) throw bad('items', 'Choose at least one item to return');
    if (b.items.length > 100) throw bad('items', 'Too many lines in one return');
    const want = new Map();                       // sale item id -> quantity to return
    for (const it of b.items) {
      const id = str(it && it.itemId), qty = Number(it && it.qty);
      if (!/^\d{1,18}$/.test(id)) throw bad('items', 'One of the items is not valid');
      if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6 || Math.abs(qty * 100 - Math.round(qty * 100)) > 1e-6) throw bad('items', 'Enter a valid quantity to return');
      want.set(id, round2((want.get(id) || 0) + qty));
    }
    const reason = RETURN_REASONS[code] + (details ? ' — ' + details : '');

    const result = await tx(async (client) => {
      const sr = await client.query('SELECT sale_id, receipt_no, status, method, created_at FROM pos_sales WHERE sale_id = $1 FOR UPDATE', [req.params.id]);
      if (!sr.rowCount) throw bad('id', 'Sale not found');
      const sale = sr.rows[0];
      if (sale.status !== 'Completed') throw bad('id', sale.status === 'Voided' ? 'This sale was voided, so nothing can be returned' : 'This sale has a void request waiting for Finance, so items cannot be returned');
      if (Date.now() - new Date(sale.created_at).getTime() > RETURN_WINDOW_DAYS * 86400000)
        throw bad('id', `Items can only be returned within ${RETURN_WINDOW_DAYS} days of the sale`);
      const pend = await client.query(`SELECT 1 FROM pos_return_requests WHERE sale_id = $1 AND status = 'pending'`, [sale.sale_id]);
      if (pend.rowCount) throw bad('id', 'This sale already has a return waiting for Finance. Wait for the decision before sending another');
      let shiftId = null;
      if (sale.method === 'Cash') {               // a cash refund comes out of this cashier's drawer, so a shift must be open
        const sh = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL', [req.user.id]);
        if (!sh.rowCount) throw bad('cashShift', 'Open your Cash Shift first. A cash refund is paid from your drawer.');
        shiftId = sh.rows[0].shift_id;
      }
      const { rows: lines } = await client.query('SELECT item_id, product_id, sku, name, unit, qty, price FROM pos_sale_items WHERE sale_id = $1 ORDER BY item_id', [sale.sale_id]);
      const ret = await returnInfo(client, [sale.sale_id]);
      const chosen = [];
      let cents = 0;
      for (const [id, qty] of want) {
        const line = lines.find(l => String(l.item_id) === id);
        if (!line) throw bad('items', 'One of the items is not on this invoice');
        const done = ret.items.get(id) || { approved: 0, pending: 0 };
        const left = round2(+line.qty - done.approved - done.pending);
        if (qty > left + 1e-9) throw bad('items', left <= 0 ? `${line.name} was already returned` : `Only ${left} ${line.unit} of ${line.name} can still be returned`);
        if (!isMeasured(line.unit) && !Number.isInteger(qty)) throw bad('items', `${line.name} is sold in whole ${line.unit} only`);
        const amount = lineCents(+line.price, qty) / 100;
        cents += Math.round(amount * 100);
        chosen.push({ ...line, qty, amount });
      }
      if (!cents) throw bad('items', 'These items have no value to refund');
      const amount = cents / 100;
      const ins = await client.query(
        `INSERT INTO pos_return_requests (sale_id, reason, amount, refund_method, requested_by, requested_shift_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING return_id`,
        [sale.sale_id, reason, amount, sale.method, req.user.id, shiftId]);
      const returnId = ins.rows[0].return_id;
      for (const c of chosen)
        await client.query(`INSERT INTO pos_return_items (return_id, sale_item_id, product_id, qty, unit_price, amount) VALUES ($1,$2,$3,$4,$5,$6)`,
          [returnId, c.item_id, c.product_id, c.qty, c.price, c.amount]);
      await audit(client, req.user, 'Return', `Return RT-${returnId} requested for ${sale.receipt_no}: ${lineText(chosen)} — refund ${peso(amount)} (${sale.method === 'Cash' ? 'cash from drawer' : 'to the original payment'}). ${reason}`);
      return { id: Number(returnId), returnNo: 'RT-' + returnId, amount, receipt: sale.receipt_no };
    });
    res.status(201).json(result);
    later(() => Promise.all([
      pingFinance({ category: 'pos', title: 'POS return approval requested',
        body: result.returnNo + ' for ' + result.receipt + ' — refund ' + asPeso(result.amount) + '. Cashier: ' + req.user.name + '.',
        link: 'Finance_Inventory.html#sales', entityType: 'return', entityId: String(result.id), severity: 'warn', dedupeKey: 'ret_req:' + result.id }),
      pingUser(req.user.id, { category: 'pos', title: 'Return request sent',
        body: result.returnNo + ' for ' + result.receipt + ' is waiting for Finance.',
        link: 'POS_Cashier.html#sales', entityType: 'return', entityId: String(result.id), dedupeKey: 'ret_sent:' + result.id }, 'cashier')
    ]));
  }));

  const returnJson = (r, items) => ({
    id: Number(r.return_id), returnNo: 'RT-' + r.return_id, status: r.status, reason: r.reason, amount: +r.amount, refundMethod: r.refund_method,
    restock: r.restock === null ? undefined : !!r.restock, note: r.decision_note || undefined, requestedBy: r.requested_by_name || undefined,
    requestedAt: new Date(r.created_at).getTime(), decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : undefined,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, amount: +i.amount }))
  });

  app.get('/api/pos/return-requests', auth('finance'), wrap(async (req, res) => {
    await posReturnsReady;
    const { rows } = await pool.query(
      `SELECT r.*, s.receipt_no, s.cashier_name, u.full_name AS requested_by_name
         FROM pos_return_requests r JOIN pos_sales s USING (sale_id) LEFT JOIN users u ON u.user_id = r.requested_by
        WHERE r.status = 'pending' ORDER BY r.created_at`);
    const { rows: items } = rows.length ? await pool.query(
      `SELECT ri.return_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri JOIN pos_sale_items i ON i.item_id = ri.sale_item_id
        WHERE ri.return_id = ANY($1) ORDER BY ri.return_item_id`, [rows.map(r => r.return_id)]) : { rows: [] };
    res.json(rows.map(r => ({ ...returnJson(r, items.filter(i => String(i.return_id) === String(r.return_id))), receiptNo: r.receipt_no })));
  }));

  app.post('/api/pos/return-requests/:id/decision', auth('finance'), wrap(async (req, res) => {
    await posReturnsReady;
    const b = req.body || {}, approve = b.approve === true, note = str(b.note);
    const restock = b.restock === undefined ? true : b.restock === true;     // damaged goods can be refunded without going back on the shelf
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    if (!approve && note.length < 5) throw bad('note', 'Please tell the cashier why the return is rejected (at least 5 characters)');
    if (!/^\d{1,18}$/.test(req.params.id)) throw bad('id', 'No pending return with that id');
    const retDec = await tx(async (client) => {
      const r = await client.query(
        `SELECT r.*, s.receipt_no, s.status AS sale_status, s.method, u.full_name AS requester
           FROM pos_return_requests r JOIN pos_sales s USING (sale_id) LEFT JOIN users u ON u.user_id = r.requested_by
          WHERE r.return_id = $1 AND r.status = 'pending' FOR UPDATE OF r, s`, [req.params.id]);
      if (!r.rowCount) throw bad('id', 'No pending return with that id');
      const ret = r.rows[0], no = 'RT-' + ret.return_id;
      const { rows: items } = await client.query(
        `SELECT ri.product_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri JOIN pos_sale_items i ON i.item_id = ri.sale_item_id
          WHERE ri.return_id = $1 ORDER BY ri.product_id`, [ret.return_id]);
      let shiftId = null;
      if (approve) {
        if (ret.sale_status !== 'Completed') throw bad('id', 'This sale is no longer completed, so the return cannot be approved');
        if (ret.method === 'Cash') {              // the refund is paid from the requesting cashier's open drawer, so it must reduce that shift's expected cash
          const sh = await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL FOR UPDATE', [ret.requested_by]);
          if (!sh.rowCount) throw bad('id', `${ret.requester || 'The cashier'} has no open cash shift, so the cash refund cannot be recorded. Ask them to open a Cash Shift, then approve again`);
          shiftId = sh.rows[0].shift_id;
        }
        if (restock) for (const i of items)
          if (i.product_id) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty, userId: req.user.id,
            sourceType: 'pos_sale', sourceId: ret.sale_id, note: `Return ${no} of ${ret.receipt_no}` });
      }
      await client.query(
        `UPDATE pos_return_requests SET status = $2, restock = $3, refund_shift_id = $4, decided_by = $5, decision_note = $6, decided_at = now() WHERE return_id = $1`,
        [ret.return_id, approve ? 'approved' : 'rejected', approve ? restock : null, shiftId, req.user.id, note || null]);
      await audit(client, req.user, 'Return', approve
        ? `Return ${no} approved for ${ret.receipt_no}: ${lineText(items)} — refund ${peso(ret.amount)} (${ret.method === 'Cash' ? 'cash, from ' + ret.requester + "'s shift #" + shiftId : 'to the original payment method'}), ${restock ? 'stock restored' : 'not put back in stock'}${note ? '. ' + note : ''}`
        : `Return ${no} rejected for ${ret.receipt_no}: ${note}`);
      return { no, receipt: ret.receipt_no, requested_by: ret.requested_by, amount: +ret.amount };
    });
    res.json({ ok: true });
    later(() => pingUser(retDec.requested_by, {
      category: 'pos', title: approve ? 'Return request approved' : 'Return request rejected',
      body: retDec.no + ' for ' + retDec.receipt + (approve ? ' was approved. Refund ' + asPeso(retDec.amount) + '.' : ' was rejected' + (note ? ': ' + note : '.')),
      link: 'POS_Cashier.html#sales', entityType: 'return', entityId: req.params.id, severity: approve ? 'info' : 'warn',
      dedupeKey: 'ret_dec:' + req.params.id + ':' + (approve ? 'ok' : 'no')
    }, 'cashier'));
  }));

  /* =====================================================
     SHOP — customer
  ===================================================== */
  app.get('/api/shop/products', auth('customer'), wrap(async (req, res) => {
    const rows = await catalog();
    // adds minimum order, star rating and "notify me" info (shop-extras.js); the catalog still works if that module is off
    res.json(app.locals.shopExtras ? await app.locals.shopExtras.decorate(rows, req.user) : rows);
  }));
  app.get('/api/shop/config', auth('customer'), wrap(async (req, res) => {
    const d = await ratesSummary();
    res.json({ deliveryFee: d.fallback, deliveryFeeFrom: d.from, deliveryFeeTo: d.to, refundWindowDays: REFUND_WINDOW_DAYS, cancelAutoHours: CANCEL_AUTO_HOURS, cancelReasons: Object.fromEntries(Object.entries(CANCEL_REASONS).filter(([key]) => key !== 'balance_unpaid')), info: shopInfo() });
  }));
  // Fee for one delivery address: the customer sees it at checkout before placing the order (the server recalculates it when the order is placed)
  app.get('/api/shop/delivery-fee', auth('customer'), wrap(async (req, res) => {
    const region = str(req.query.region), province = str(req.query.province);
    if (!region && !province) throw bad('region', 'Choose the delivery region first');
    res.json(feeJson(await quoteForRequest(pool, { region, province }, req.query.items)));
  }));
  // Public: the Help page (delivery, refunds, contact) can be read without signing in. Nothing secret is in here.
  app.get('/api/shop/info', wrap(async (req, res) => {
    const d = await ratesSummary();
    res.json({ deliveryFee: d.fallback, deliveryFeeFrom: d.from, deliveryFeeTo: d.to, deliveryRates: d, refundWindowDays: REFUND_WINDOW_DAYS, cancelAutoHours: CANCEL_AUTO_HOURS, cancelReasons: Object.fromEntries(Object.entries(CANCEL_REASONS).filter(([key]) => key !== 'balance_unpaid')), info: shopInfo() });
  }));

  /* ---------- delivery rates: Finance manages them ---------- */
  app.get('/api/delivery-rates', auth('finance'), wrap(async (req, res) => {
    const rows = await rateRows();
    res.json(rows.map((r) => ({ id: r.rate_id, scope: r.scope, name: r.name, fee: +r.fee, available: r.available !== false })));
  }));
  // Replaces the whole rate list in one go (the admin table sends every row)
  app.put('/api/delivery-rates', auth('finance'), wrap(async (req, res) => {
    const list = Array.isArray(req.body && req.body.rates) ? req.body.rates : null;
    if (!list || !list.length || list.length > 300) throw bad('rates', 'Send between 1 and 300 delivery rates');
    const seen = new Set(), clean = [];
    for (const r of list) {
      const scope = str(r && r.scope), name = str(r && r.name).replace(/\s+/g, ' '), fee = Number(r && r.fee);
      if (!['default', 'region', 'province'].includes(scope)) throw bad('rates', 'Each rate must be for a region, a province, or "all other areas"');
      if (name.length < 2 || name.length > 100) throw bad('rates', 'Each rate needs a place name (2–100 characters)');
      if (!Number.isFinite(fee) || fee < 0 || fee > 100000) throw bad('rates', 'The fee for ' + name + ' must be between 0 and 100,000');
      const key = scope + '|' + rateKey(scope, name);
      if (seen.has(key)) throw bad('rates', name + ' is listed twice');
      seen.add(key); clean.push({ scope, name, fee: round2(fee), available: !(r && r.available === false) });
    }
    if (clean.filter((r) => r.scope === 'default').length !== 1) throw bad('rates', 'There must be exactly one "all other areas" rate');
    await deliveryRatesReady;
    await tx(async (client) => {
      await client.query('DELETE FROM delivery_rates');
      for (const r of clean) await client.query('INSERT INTO delivery_rates (scope, name, fee, available) VALUES ($1,$2,$3,$4)', [r.scope, r.name, r.fee, r.available]);
      await audit(client, req.user, 'Record edited', 'Delivery rates updated (' + clean.length + ' rates)');
    });
    res.json(await rateRows().then((rows) => rows.map((r) => ({ id: r.rate_id, scope: r.scope, name: r.name, fee: +r.fee, available: r.available !== false }))));
  }));

  /* ---------- refunds (shared by the customer and finance routes) ---------- */
  // (request_id is BIGSERIAL, which pg returns as text, hence Number())
  const refundJson = (r) => r ? ({
    id: Number(r.request_id), status: r.status, reason: r.reason_code, reasonLabel: REFUND_REASONS[r.reason_code] || r.reason_code,
    details: r.details, amount: +r.amount, decisionNote: r.decision_note || undefined, restocked: !!r.restocked,
    requestedAt: new Date(r.created_at).getTime(), decidedAt: r.decided_at ? new Date(r.decided_at).getTime() : undefined
  }) : null;
  async function refundsFor(ids) {
    if (!ids.length) return new Map();
    const { rows } = await pool.query('SELECT * FROM order_refund_requests WHERE order_id = ANY($1)', [ids]);
    return new Map(rows.map(r => [String(r.order_id), r]));   // keyed as text: order_id may be INT or BIGINT depending on the table
  }
  // the last moment a refund can be requested (the order must be closed: Delivered / Picked Up)
  const refundDeadline = (o) => new Date(o.status_updated_at || o.created_at).getTime() + REFUND_WINDOW_DAYS * 86400000;

  // until this moment a customer can cancel and it is approved immediately (only while nothing has been paid)
  const instantUntil = (o) => new Date(o.created_at).getTime() + CANCEL_AUTO_HOURS * 3600000;
  const paidIn = (o) => round2(Number(o.paid_amount) || 0);
  /* A cancelled order that had money on it owes the customer a refund. It is put in Finance's refund queue (Sales >
     Refund requests) for the amount in the ledger; approving it there writes the refund to the ledger. */
  async function queueCancelRefund(client, o, userId, keep) {
    const amount = round2(paidIn(o) - (Number(keep) || 0));     // keep: a down payment / delivery fee forfeited by a no-show
    if (!(amount > 0)) return 0;
    await client.query(
      `INSERT INTO order_refund_requests (order_id, reason_code, details, amount, requested_by) VALUES ($1,'cancelled',$2,$3,$4)
       ON CONFLICT (order_id) DO NOTHING`,
      [o.order_id, `Order cancelled before release. Refund the ${peso(amount)} received to the original payment method.`, amount, userId]);
    return amount;
  }

  // What the customer has paid and still owes. It comes from the payment ledger (paid_amount is kept by the database
  // trigger), never from the browser. The shop page needs it to tell "waiting for payment" from "paid".
  const moneyJson = (o) => {
    const pt = app.locals.paymentTerms;
    if (!pt) return {};
    const m = pt.orderMoney(o), t = pt.orderTerms(o);
    return { paymentState: m.state, paidAmount: m.paid, outstanding: m.balance, dueNow: m.dueNow, advance: m.advance || undefined,
      terms: t ? { key: t.key, percent: t.percent, initial: t.initial, dueNow: t.dueNow, balance: t.balance, condition: t.condition } : null };
  };
  const isCod = (o) => /^Cash on /.test(o.payment_method || '');
  // an order with something to pay through Xendit: an online-payment order, or a cash order's advance (delivery fee / deposit)
  const advLabel = (o) => (o.advance_kind === 'shipping_fee' ? (+o.advance_amount - +o.delivery_fee > 0.004 ? (+o.delivery_fee > 0 ? 'delivery fee and down payment' : 'down payment') : 'delivery fee') : 'down payment');
  const paysOnline = (o) => o.payment_method === 'Xendit' || (isCod(o) && Number(o.advance_amount) > 0);
  /* §8 THE money gate for moving an online order, the same for Finance and the counter (payment-terms.releaseDecision):
       Confirm            online orders need the payment due now (full, or the approved initial %) in the ledger; COD is confirmed unpaid
       Out for Delivery   goods leave the shop: an online-payment order must be fully settled; COD is collected at the door
       Delivered / Picked Up  nothing may stay outstanding. The counter takes COD cash on the spot; Finance has no drawer
       A Finance credit exception is the only way past the gate with money still owed.                                  */
  function moneyGate(o, target, role) {
    const pt = app.locals.paymentTerms;
    if (!pt || !target) return { ok: true };
    if (target === 'Paid') return pt.releaseDecision(o, { action: 'confirm', role });
    if (target === 'Out for Delivery' || target === 'Delivered') {
      const m = pt.orderMoney(o);
      if (!isCod(o) && m.outstanding && !o.credit_exception_by) {
        return { ok: false, field: 'payment', money: m, reason: `${peso(m.balance)} is still unpaid on this order. Orders on payment terms or online payments cannot be delivered until fully paid (or approved with a credit exception by Finance).` };
      }
      if (target === 'Out for Delivery') return { ok: true, money: m };
    }
    if (FINAL_STATUS.includes(target)) return pt.releaseDecision(o, { action: 'release', role });
    return { ok: true };
  }
  const orderJson = (o, items, cancelPending, refund, dlv) => ({
    ...moneyJson(o),
    id: o.order_no, createdAt: new Date(o.created_at).getTime(), fulfillment: o.fulfillment, address: o.address || undefined,
    shipTo: o.fulfillment === 'Delivery' && o.city ? { recipient: o.recipient_name, addressLine: o.address_line, landmark: o.landmark || undefined,
      barangay: o.barangay, city: o.city, province: o.province, region: o.region, zip: o.zip_code } : undefined,
    phone: o.phone, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee, total: +o.total, status: o.status, paymentStatus: o.payment_status || 'unpaid',
    cancelReasonCode: o.cancel_reason_code || undefined,
    depositDisposition: o.deposit_disposition || undefined,
    depositDecisionNote: o.deposit_decision_note || undefined,
    holdReason: o.status === 'On Hold' ? 'Balance unpaid' : undefined,
    forfeited: +o.forfeited_amount > 0 ? +o.forfeited_amount : undefined,
    delivery: o.fulfillment === 'Delivery' && ['Out for Delivery', 'Delivered'].includes(o.status) ? delivery.customerJson(dlv, o) : undefined,
    cancelRequested: !!cancelPending,
    cancellable: CUSTOMER_CANCELLABLE.includes(o.status) && !cancelPending,
    // money already received is never dropped by an instant cancel: a paid order goes to Finance as cancel + refund
    cancelInstant: CUSTOMER_CANCELLABLE.includes(o.status) && !cancelPending && !paidIn(o) && Date.now() <= instantUntil(o),
    cancelRefund: paidIn(o) || undefined,
    cancelInstantUntil: CUSTOMER_CANCELLABLE.includes(o.status) ? instantUntil(o) : undefined,
    cancelAutoHours: CANCEL_AUTO_HOURS,
    refund: refundJson(refund),
    refundEligible: FINAL_STATUS.includes(o.status) && !refund && Date.now() <= refundDeadline(o),
    refundDeadline: FINAL_STATUS.includes(o.status) ? refundDeadline(o) : undefined,
    refundWindowDays: REFUND_WINDOW_DAYS,
    items: items.map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
  });

  app.get('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query('SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200', [req.user.id]);
    if (!orders.length) return res.json([]);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]);
    const { rows: cr } = await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]);
    const pending = new Set(cr.map(r => r.order_id));
    const refunds = await refundsFor(ids);
    const dl = await delivery.loadFor(ids);
    res.json(orders.map(o => orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id), refunds.get(String(o.order_id)), dl.rows.get(String(o.order_id)))));
  }));

  /* ---------- address book (max 5 saved addresses per customer) ---------- */
  const MAX_ADDRESSES = 5;
  const LABELS = ['Home', 'Work', 'Other'];
  const mobileOf = (v) => str(v).replace(/[\s().-]/g, '');
  const MOBILE_RE = /^(\+63|0)9\d{9}$/;
  const addrJson = (r) => ({
    id: Number(r.address_id), label: r.label, recipient: r.recipient_name, phone: r.phone, addressLine: r.address_line,
    landmark: r.landmark || '', barangay: r.barangay, city: r.city, province: r.province, region: r.region, zip: r.zip_code,
    isDefault: !!r.is_default,
    fullAddress: formatShipTo({ addressLine: r.address_line, barangay: r.barangay, city: r.city, province: r.province, zip: r.zip_code })
  });
  const readLabel = (v) => { const l = str(v) || 'Home'; if (!LABELS.includes(l)) throw bad('label', 'Choose Home, Work or Other'); return l; };
  const readMobile = (v) => { const p = mobileOf(v); if (!MOBILE_RE.test(p)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567'); return p; };

  async function insertAddress(client, userId, ship, phone, label, makeDefault) {
    await client.query('SELECT 1 FROM users WHERE user_id = $1 FOR UPDATE', [userId]);     // serialises concurrent saves by the same customer
    const n = (await client.query('SELECT count(*)::int AS n FROM customer_addresses WHERE user_id = $1', [userId])).rows[0].n;
    if (n >= MAX_ADDRESSES) throw bad('address', `You can save up to ${MAX_ADDRESSES} addresses. Delete one first`);
    const isDefault = makeDefault || n === 0;
    if (isDefault) await client.query('UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1', [userId]);
    const r = await client.query(
      `INSERT INTO customer_addresses (user_id, label, recipient_name, phone, address_line, landmark, barangay, city, province, region, zip_code, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, label, ship.recipient, phone, ship.addressLine, ship.landmark || null, ship.barangay, ship.city, ship.province, ship.region, ship.zip, isDefault]);
    return r.rows[0];
  }

  app.get('/api/shop/addresses', auth('customer'), wrap(async (req, res) => {
    await addressSchemaReady;
    const { rows } = await pool.query('SELECT * FROM customer_addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC', [req.user.id]);
    res.json(rows.map(addrJson));
  }));

  app.post('/api/shop/addresses', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const label = readLabel(b.label), phone = readMobile(b.phone);
    const ship = await validateShipTo(b);
    const row = await tx(async (client) => insertAddress(client, req.user.id, ship, phone, label, b.isDefault === true));
    res.status(201).json(addrJson(row));
  }));

  app.put('/api/shop/addresses/:id', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw bad('id', 'Address not found');
    const b = req.body || {};
    const label = readLabel(b.label), phone = readMobile(b.phone);
    const ship = await validateShipTo(b);
    const row = await tx(async (client) => {
      const cur = await client.query('SELECT * FROM customer_addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (!cur.rowCount) throw bad('id', 'Address not found');
      const makeDefault = b.isDefault === true || (cur.rows[0].is_default && b.isDefault !== false);
      if (makeDefault) await client.query('UPDATE customer_addresses SET is_default = FALSE WHERE user_id = $1', [req.user.id]);
      const r = await client.query(
        `UPDATE customer_addresses SET label=$3, recipient_name=$4, phone=$5, address_line=$6, landmark=$7, barangay=$8, city=$9,
                province=$10, region=$11, zip_code=$12, is_default=$13 WHERE address_id=$1 AND user_id=$2 RETURNING *`,
        [id, req.user.id, label, ship.recipient, phone, ship.addressLine, ship.landmark || null, ship.barangay, ship.city, ship.province, ship.region, ship.zip, makeDefault]);
      return r.rows[0];
    });
    res.json(addrJson(row));
  }));

  app.post('/api/shop/addresses/:id/default', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const cur = await client.query('SELECT 1 FROM customer_addresses WHERE address_id = $1 AND user_id = $2 FOR UPDATE', [id, req.user.id]);
      if (!cur.rowCount) throw bad('id', 'Address not found');
      await client.query('UPDATE customer_addresses SET is_default = (address_id = $1) WHERE user_id = $2', [id, req.user.id]);
    });
    res.json({ ok: true });
  }));

  app.delete('/api/shop/addresses/:id', auth('customer'), wrap(async (req, res) => {
    const id = Number(req.params.id);
    await tx(async (client) => {
      const del = await client.query('DELETE FROM customer_addresses WHERE address_id = $1 AND user_id = $2 RETURNING is_default', [id, req.user.id]);
      if (!del.rowCount) throw bad('id', 'Address not found');
      if (del.rows[0].is_default)       // keep one default: promote the newest remaining address
        await client.query(`UPDATE customer_addresses SET is_default = TRUE WHERE address_id =
          (SELECT address_id FROM customer_addresses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`, [req.user.id]);
    });
    res.json({ ok: true });
  }));

  app.post('/api/shop/orders', auth('customer'), wrap(async (req, res) => {
    await addressSchemaReady; await rulesReady;
    const b = req.body || {};
    const requestId = typeof b.requestId === 'string' && /^[a-zA-Z0-9-]{12,100}$/.test(b.requestId) ? b.requestId : null;
    if (!requestId) throw bad('requestId', 'Sale request identifier is required. Refresh the POS page.');
    const lines = readLines(b.items);
    const fulfillment = str(b.fulfillment);
    if (!['Delivery', 'Pickup'].includes(fulfillment)) throw bad('fulfillment', 'Choose Delivery or Pickup');
    const cashMethod = fulfillment === 'Delivery' ? 'Cash on Delivery' : 'Cash on Pickup';
    const method = str(b.method);
    if (![...ONLINE_METHODS, cashMethod].includes(method)) throw bad('method', 'Choose a valid payment method');
    const phone = readMobile(b.phone);
    // Delivery needs a full structured address (street line + region / province / city / barangay / ZIP, checked against PSGC + the ZIP list)
    const ship = fulfillment === 'Delivery' ? await validateShipTo(b.shipTo || {}) : null;
    const saveLabel = ship && b.saveAddress === true ? readLabel(b.addressLabel) : null;

    const order = await tx(async (client) => {
      // No stock lock here: stock is only deducted when Finance confirms the order. This just refuses what is clearly unavailable.
      const items = await loadSellable(client, lines, { lock: false });
      if (app.locals.shopExtras) await app.locals.shopExtras.checkMinimums(client, items);   // minimum order per product
      const subtotal = round2(items.reduce((n, i) => n + i.price * i.qty, 0));
      let fee = 0;
      if (fulfillment === 'Delivery') {                       // by the delivery address' province / region
        const q = await deliveryQuote(client, ship, items);        // area rate + weight charge
        if (!q.available) throw bad('region', `Sorry, we do not deliver to ${ship.province || ship.region} yet. Choose another address or pick up in store.`);
        fee = q.fee;
      }
      // cash on delivery / pickup: within Finance's COD limit, and not for customers who missed too many deliveries or pickups
      // Cash on delivery: the delivery fee is paid online first, the rider collects the goods' price in cash.
      // Cash on pickup: a down payment is paid online first (taken off the total), the rest in cash at the counter.
      let advKind = null, advance = 0;
      if (method === cashMethod) {
        const c = await cashCheck(client, req.user.id, fulfillment, round2(subtotal + fee)); if (!c.ok) throw bad('method', c.reason);
        // COD: the delivery fee AND a down payment (taken off what the rider collects) are paid online first
        if (fulfillment === 'Delivery') {
          const half = round2(subtotal * 0.5);
          const minDep = c.rules.codDeposit > 0 ? c.rules.codDeposit : 200;
          const dep = round2(Math.min(Math.max(half, minDep), subtotal));
          if (fee + dep > 0) { advKind = 'shipping_fee'; advance = round2(fee + dep); }
        }
        if (fulfillment === 'Pickup') {
          const half = round2(subtotal * 0.5);
          const minDep = c.rules.copDeposit > 0 ? c.rules.copDeposit : 200;
          const dep = round2(Math.min(Math.max(half, minDep), subtotal));
          if (dep > 0) { advKind = 'deposit'; advance = dep; }
        }
        if (advance > 0 && !process.env.XENDIT_SECRET_KEY)
          throw bad('method', `${cashMethod} needs the ${advKind === 'shipping_fee' ? 'delivery fee and down payment' : 'down payment'} paid online first, and online payment is not available right now. Please try again later`);
      }
      const ins = await client.query(
        `INSERT INTO orders (customer_id, fulfillment, address, phone, payment_method, subtotal, delivery_fee, total,
                             recipient_name, address_line, landmark, barangay, city, province, region, zip_code, advance_kind, advance_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [req.user.id, fulfillment, ship ? ship.fullAddress + (ship.landmark ? ` (Landmark: ${ship.landmark})` : '') : null, phone, method, subtotal, fee, round2(subtotal + fee),
         ship && ship.recipient, ship && ship.addressLine, ship && ship.landmark || null, ship && ship.barangay, ship && ship.city, ship && ship.province, ship && ship.region, ship && ship.zip,
         advKind, advance]);
      let o = ins.rows[0];
      // Terms must be selected and validated on the server, using the final database-priced total.
      // Do this inside the order transaction so invalid terms cannot leave orphan orders.
      if (app.locals.paymentTerms) {
        const terms = await app.locals.paymentTerms.setOrderTerms(client, o,
          { termKey: method === 'Xendit' ? (str(b.termKey) || 'full') : 'full' }, req.user);
        o = Object.assign({}, o, terms);
      }
      for (const i of items) await client.query(
        `INSERT INTO order_items (order_id, product_id, sku, name, unit, qty, price) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [o.order_id, i.product_id, i.sku, i.name, i.unit, i.qty, i.price]);
      // optional: remember this address for next time (skipped silently when the address book is full)
      if (saveLabel) {
        try { await client.query('SAVEPOINT save_addr'); await insertAddress(client, req.user.id, ship, phone, saveLabel, b.makeDefault === true); }
        catch (err) { if (!(err instanceof ValidationError)) throw err; await client.query('ROLLBACK TO SAVEPOINT save_addr'); }
      }
      await audit(client, req.user, 'Record added', `Online order ${o.order_no} — ${peso(o.total)} (${method}, ${fulfillment})`);
      return orderJson(o, items, false, null);
    });
    res.status(201).json(order);
    notify(order.id, 'placed');
  }));

  app.post('/api/shop/orders/:no/cancel-request', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const code = str(b.reason), details = str(b.details);
    if (!CANCEL_REASONS[code] || code === 'balance_unpaid') throw bad('reason', 'Choose the reason for cancelling');
    if (code === 'other' && details.length < 5) throw bad('details', 'Please tell us the reason (at least 5 characters)');
    if (details.length > 300) throw bad('details', 'Please keep the details under 300 characters');
    const reason = CANCEL_REASONS[code] + (details ? ' \u2014 ' + details : '');
    let instant = false;
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE', [req.params.no, req.user.id]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (o.status === 'Cancelled') throw bad('id', 'This order is already cancelled');
      if (!CUSTOMER_CANCELLABLE.includes(o.status)) throw bad('id', 'We are already preparing or have finished this order, so it can no longer be cancelled here. Please contact us if you need help');
      const dup = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (dup.rowCount) throw bad('id', 'You already asked to cancel this order. Our team is reviewing it');
      instant = !paidIn(o) && Date.now() <= instantUntil(o);       // paid: Finance approves the cancellation and the refund
      if (instant) {
        // inside the free-cancel window: cancelled right away, stock goes back if it was already taken
        if (o.stock_deducted) {
          const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
          for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
            userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
        }
        await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
        await client.query(`INSERT INTO order_cancel_requests (order_id, reason, reason_code, requested_by, status, auto_approved, decided_at) VALUES ($1,$2,$3,$4,'approved',TRUE,now())`,
          [o.order_id, reason, code, req.user.id]);
        await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, 'Cancelled by customer: ' + reason);
        await audit(client, req.user, 'Record edited', `Order ${o.order_no} cancelled by the customer (within ${CANCEL_AUTO_HOURS} h): ${reason}${o.stock_deducted ? ' \u2014 stock restored, refund to original payment method due' : ''}`);
      } else {
        await client.query('INSERT INTO order_cancel_requests (order_id, reason, reason_code, requested_by) VALUES ($1,$2,$3,$4)', [o.order_id, reason, code, req.user.id]);
        await audit(client, req.user, 'Record edited', `Cancellation requested for ${o.order_no}: ${reason}${paidIn(o) ? ` — ${peso(paidIn(o))} paid, refund due if approved` : ''}`);
      }
    });
    res.status(201).json({ ok: true, cancelled: instant });
    if (instant) notify(req.params.no, 'Cancelled', { reason, by: 'customer' });
    else later(() => Promise.all([
      pingFinance({ category: 'orders', title: 'Cancellation requested',
        body: req.params.no + ' — ' + reason + ' (customer ' + req.user.name + '). Approve or reject it on Sales Transactions.',
        link: 'Finance_Inventory.html#sales', entityType: 'order', entityId: req.params.no, severity: 'warn',
        dedupeKey: 'cancel_req:' + req.params.no }),
      pingUser(req.user.id, { category: 'orders', title: 'Cancellation request sent',
        body: 'We received your request to cancel order ' + req.params.no + '. Finance will review it.',
        link: 'Shop_Customer.html#orders', entityType: 'order', entityId: req.params.no, dedupeKey: 'cancel_sent:' + req.params.no }, 'customer')
    ]));
  }));

  // Customer asks for a refund on a finished order (Delivered / Picked Up) inside the refund window. One request per order.
  app.post('/api/shop/orders/:no/refund-request', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const code = str(b.reason), details = str(b.details);
    if (!REFUND_REASONS[code] || code === 'cancelled') throw bad('reason', 'Choose the reason for your refund request');
    if (details.length < 5 || details.length > 300) throw bad('details', 'Please describe the problem (5 to 300 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 AND customer_id = $2 FOR UPDATE', [req.params.no, req.user.id]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (!FINAL_STATUS.includes(o.status))
        throw bad('id', 'You can ask for a refund once the order is delivered or picked up. Before that, you can request a cancellation instead');
      const dup = await client.query('SELECT 1 FROM order_refund_requests WHERE order_id = $1', [o.order_id]);
      if (dup.rowCount) throw bad('id', 'A refund request was already sent for this order');
      if (Date.now() > refundDeadline(o)) throw bad('id', `The ${REFUND_WINDOW_DAYS}-day refund period for this order has ended`);
      await client.query(
        `INSERT INTO order_refund_requests (order_id, reason_code, details, amount, requested_by) VALUES ($1,$2,$3,$4,$5)`,
        [o.order_id, code, details, o.total, req.user.id]);
      await audit(client, req.user, 'Record edited', `Refund requested for ${o.order_no} (${peso(o.total)}): ${REFUND_REASONS[code]} — ${details}`);
    });
    res.status(201).json({ ok: true });
    later(() => Promise.all([
      pingFinance({ category: 'payment', title: 'Refund request received',
        body: req.params.no + ' — customer ' + req.user.name + ' asked for a refund. Review it on Sales Transactions.',
        link: 'Finance_Inventory.html#sales', entityType: 'order', entityId: req.params.no, severity: 'warn',
        dedupeKey: 'refund_req:' + req.params.no }),
      pingUser(req.user.id, { category: 'payment', title: 'Refund request received',
        body: 'We received your refund request for order ' + req.params.no + '. We will update you when Finance decides.',
        link: 'Shop_Customer.html#orders', entityType: 'order', entityId: req.params.no, dedupeKey: 'refund_sent:' + req.params.no }, 'customer')
    ]));
  }));

  /* ---------- finance: confirm orders, decide cancellations ---------- */
  app.get('/api/orders', auth('finance', 'cashier'), wrap(async (req, res) => {
    const { rows: orders } = await pool.query(
      `SELECT o.*, u.full_name AS customer, u.phone AS customer_phone, u.email AS customer_email FROM orders o JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 200`);
    const ids = orders.map(o => o.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    const { rows: cr } = ids.length ? await pool.query(`SELECT DISTINCT order_id FROM order_cancel_requests WHERE order_id = ANY($1) AND status = 'pending'`, [ids]) : { rows: [] };
    const pending = new Set(cr.map(r => r.order_id));
    const refunds = await refundsFor(ids);
    const dl = await delivery.loadFor(ids);
    const { rows: hist } = ids.length ? await pool.query(
      `SELECT h.order_id, h.to_status, h.note, h.created_at, u.full_name AS by_name FROM order_status_history h
         LEFT JOIN users u ON u.user_id = h.changed_by WHERE h.order_id = ANY($1) ORDER BY h.created_at, h.history_id`, [ids]) : { rows: [] };
    const histBy = new Map();
    for (const h of hist) { const k = String(h.order_id); if (!histBy.has(k)) histBy.set(k, []); histBy.get(k).push({ to: h.to_status, note: h.note || undefined, by: h.by_name || 'System', at: new Date(h.created_at).getTime() }); }
    await rulesReady;
    const { rows: fails } = ids.length ? await pool.query('SELECT order_id, reason, created_at FROM order_failures WHERE order_id = ANY($1) ORDER BY created_at', [ids]) : { rows: [] };
    const failBy = new Map(); for (const f of fails) { const k = String(f.order_id); failBy.set(k, (failBy.get(k) || 0) + 1); }
    const pt = app.locals.paymentTerms;
    res.json(orders.map(o => {
      const flow = FLOW[o.fulfillment] || [], at = flow.indexOf(o.status), isDelivery = o.fulfillment === 'Delivery';
      const next = at >= 0 && at < flow.length - 1 ? flow[at + 1] : null, m = pt ? pt.orderMoney(o) : null, gate = moneyGate(o, next, req.user.role);
      return { ...orderJson(o, items.filter(i => i.order_id === o.order_id), pending.has(o.order_id), refunds.get(String(o.order_id))), customer: o.customer,
        // money flags the screens show; the server applies the same gate again on every move
        awaitingPayment: !!(m && o.payment_method === 'Xendit' && o.payment_status === 'pending' && m.dueNow > 0) || undefined,
        awaitingAdvance: !!(m && m.advance && !m.advance.paid && !['Cancelled', 'Returned'].includes(o.status)) || undefined,   // cash order: fee / down payment not paid online yet
        cashOnHandover: !!(m && isCod(o) && m.outstanding && !FINAL_STATUS.includes(o.status)) || undefined,
        creditException: o.credit_exception_by ? { note: o.credit_exception_note || 'credit exception granted by Finance' } : undefined,
        hold: next && !gate.ok ? gate.reason : undefined,
        paymentRef: o.xendit_invoice_id || undefined, history: histBy.get(String(o.order_id)) || [],
        failedAttempts: failBy.get(String(o.order_id)) || undefined,
        // Finance sees everything: rider phone, internal notes, proof photo ids (the photos themselves are fetched one by one)
        delivery: isDelivery ? delivery.financeJson(dl.rows.get(String(o.order_id)), dl.proofs.get(String(o.order_id))) : undefined,
        receivedBy: o.received_by || undefined, proofRequired: isDelivery ? delivery.proofRequired() : undefined,
        // account owner (read live from the account) and, for Delivery, the recipient saved on the order
        customerPhone: o.customer_phone || undefined, customerEmail: o.customer_email || undefined,
        recipient: o.fulfillment === 'Delivery' ? (o.recipient_name || undefined) : undefined,
        recipientPhone: o.fulfillment === 'Delivery' ? o.phone : undefined,
        flow,                                                            // the steps this order goes through (Delivery or Pickup)
        next,                                                            // the one step that can be done next
        canCancel: ADMIN_CANCELLABLE.includes(o.status) };
    }));
  }));

  // Confirm = payment received (online: gateway confirmed / COD: cash collected). Posts the stock-out.
  app.post('/api/orders/:no/confirm', auth('finance', 'cashier'), wrap(async (req, res) => {
    await tx(async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`, [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (o.status !== 'Pending Confirmation') throw bad('id', `Order is already ${o.status}`);
      const gate = moneyGate(o, 'Paid', req.user.role);
      if (!gate.ok) throw bad(gate.field || 'payment', gate.reason);
      await confirmOrder(client, o, req.user);
    });
    res.json({ ok: true });
    notify(req.params.no, 'Paid', { by: 'finance' });     // Finance confirmed it by hand: tell the customer, not Finance
  }));

  app.post('/api/orders/:no/cancel-decision', auth('finance'), wrap(async (req, res) => {
    const approve = (req.body || {}).approve === true;
    await tx(async (client) => {
      const r = await client.query(`SELECT * FROM orders WHERE order_no = $1 FOR UPDATE`, [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const q = await client.query(`SELECT request_id, reason_code FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending' FOR UPDATE`, [o.order_id]);
      if (!q.rowCount) throw bad('id', 'There is no pending cancellation request for this order');
      if (approve) {
        if (!['Pending Confirmation', 'Paid'].includes(o.balance_hold_from || o.status)) throw bad('id', 'This order is already packed, so it cannot be cancelled');
        if (o.stock_deducted) {
          const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
          for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
            userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
        }
        await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
        const kept = await app.locals.paymentTerms.cancellationPolicy(client, o, q.rows[0].reason_code || 'other', req.body || {}, req.user);
        const owed = await queueCancelRefund(client, o, req.user.id, kept);
        await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, 'Customer cancellation approved' + (owed ? ` — refund of ${peso(owed)} queued` : ''));
      }
      await client.query(`UPDATE order_cancel_requests SET status = $2, decided_by = $3, decided_at = now() WHERE request_id = $1`,
        [q.rows[0].request_id, approve ? 'approved' : 'rejected', req.user.id]);
      await audit(client, req.user, 'Record edited', `Cancellation ${approve ? 'approved' : 'rejected'} for ${o.order_no}${approve && o.stock_deducted ? ' — stock restored, refund to original payment method due' : ''}`);
    });
    res.json({ ok: true });
    notify(req.params.no, approve ? 'Cancelled' : 'cancel_declined');
  }));
  /* ---------- finance: review refund requests ---------- */
  app.get('/api/refund-requests', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.*, o.order_no, o.total AS order_total, o.fulfillment, o.payment_method, o.phone, o.status AS order_status,
              u.full_name AS customer, du.full_name AS decided_by_name
         FROM order_refund_requests r
         JOIN orders o ON o.order_id = r.order_id
         LEFT JOIN users u ON u.user_id = o.customer_id
         LEFT JOIN users du ON du.user_id = r.decided_by
        ORDER BY (r.status = 'pending') DESC, COALESCE(r.decided_at, r.created_at) DESC
        LIMIT 100`);
    const ids = rows.map(r => r.order_id);
    const { rows: items } = ids.length ? await pool.query('SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY item_id', [ids]) : { rows: [] };
    res.json(rows.map(r => ({
      ...refundJson(r), orderNo: r.order_no, customer: r.customer || 'Customer', phone: r.phone, fulfillment: r.fulfillment,
      method: r.payment_method, orderTotal: +r.order_total, orderStatus: r.order_status, decidedBy: r.decided_by_name || undefined,
      items: items.filter(i => String(i.order_id) === String(r.order_id)).map(i => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price }))
    })));
  }));

  // Approve (optionally put the goods back in stock and refund less than the full total) or reject (a reason is required).
  app.post('/api/orders/:no/refund-decision', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const approve = b.approve === true, restock = b.restock === true, note = str(b.note);
    if (note.length > 300) throw bad('note', 'The note must be 300 characters or fewer');
    if (!approve && note.length < 5) throw bad('note', 'Tell the customer why the request is declined (at least 5 characters)');
    let refundAmount = 0;
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      const q = await client.query(`SELECT * FROM order_refund_requests WHERE order_id = $1 AND status = 'pending' FOR UPDATE`, [o.order_id]);
      if (!q.rowCount) throw bad('id', 'There is no pending refund request for this order');
      let amount = +q.rows[0].amount;
      refundAmount = amount;
      if (approve && b.amount !== undefined && b.amount !== null && b.amount !== '') {
        amount = Number(b.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > +o.total || round2(amount) !== amount)
          throw bad('amount', `Enter a refund amount between ${peso(0.01)} and ${peso(o.total)}`);
        refundAmount = amount;
      }
      if (approve && restock) {
        if (!o.stock_deducted) throw bad('restock', 'Stock was never taken out for this order, so there is nothing to put back');
        const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'return', qty: +i.qty,
          userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Refund of ${o.order_no}` });
      }
      // the money goes back out through the ledger, so the order's paid amount / payment state and the reports follow
      if (approve && app.locals.paymentTerms) await app.locals.paymentTerms.refundOrderPayments(client, o, amount, req.user, `Refund ${o.order_no}${note ? ' — ' + note : ''}`);
      await client.query(
        `UPDATE order_refund_requests SET status = $2, amount = $3, restocked = $4, decision_note = $5, decided_by = $6, decided_at = now() WHERE request_id = $1`,
        [q.rows[0].request_id, approve ? 'approved' : 'rejected', amount, approve && restock, note || null, req.user.id]);
      await logStatus(client, o.order_id, o.status, o.status, req.user.id,
        approve ? `Refund approved — ${peso(amount)}${restock ? ', items back in stock' : ''}${note ? ' — ' + note : ''}` : `Refund declined — ${note}`);
      await audit(client, req.user, 'Record edited',
        approve ? `Refund approved for ${o.order_no} — ${peso(amount)} due to the customer's original payment method${restock ? '; stock restored' : ''}`
                : `Refund declined for ${o.order_no}: ${note}`);
    });
    res.json({ ok: true });
    notify(req.params.no, approve ? 'refund_approved' : 'refund_declined', { note, amount: refundAmount });
  }));

  /* =====================================================
     SALES TRANSACTIONS (admin) — every POS sale and every online order in one list
  ===================================================== */
  const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r); } return m; };
  const lineJson = (i) => ({ sku: i.sku, name: i.name, unit: i.unit, qty: +i.qty, price: +i.price, cost: +i.cost });
  const money = (lines) => {
    const revenue = round2(lines.reduce((n, i) => n + i.qty * i.price, 0));
    const cost = round2(lines.reduce((n, i) => n + i.qty * i.cost, 0));
    return { revenue, cost, profit: round2(revenue - cost) };
  };

  app.get('/api/sales', auth('finance'), wrap(async (req, res) => {
    const [pos, ord] = await Promise.all([
      pool.query('SELECT * FROM pos_sales ORDER BY created_at DESC LIMIT 500'),
      pool.query(`SELECT o.*, u.full_name AS customer FROM orders o LEFT JOIN users u ON u.user_id = o.customer_id ORDER BY o.created_at DESC LIMIT 500`)]);
    const posIds = pos.rows.map(s => s.sale_id), ordIds = ord.rows.map(o => o.order_id);
    const q = (sql, ids) => (ids.length ? pool.query(sql, [ids]) : Promise.resolve({ rows: [] }));
    const refundBy = await refundsFor(ordIds);
    await posReturnsReady;
    const [posItems, ordItems, voids, cancels, hist, posReturns, posReturnLines] = await Promise.all([
      q(`SELECT i.sale_id, i.item_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(i.unit_cost, p.unit_cost, 0) AS cost
           FROM pos_sale_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.sale_id = ANY($1) ORDER BY i.item_id`, posIds),
      q(`SELECT i.order_id, i.sku, i.name, i.unit, i.qty, i.price, COALESCE(i.unit_cost, p.unit_cost, 0) AS cost
           FROM order_items i LEFT JOIN products p ON p.product_id = i.product_id WHERE i.order_id = ANY($1) ORDER BY i.item_id`, ordIds),
      q(`SELECT request_id, sale_id, reason FROM void_requests WHERE status = 'pending' AND sale_id = ANY($1)`, posIds),
      q(`SELECT order_id, reason FROM order_cancel_requests WHERE status = 'pending' AND order_id = ANY($1)`, ordIds),
      q(`SELECT h.order_id, h.from_status, h.to_status, h.note, h.created_at, u.full_name AS changed_by_name
           FROM order_status_history h LEFT JOIN users u ON u.user_id = h.changed_by
          WHERE h.order_id = ANY($1) ORDER BY h.created_at, h.history_id`, ordIds),
      q(`SELECT r.*, u.full_name AS requested_by_name FROM pos_return_requests r LEFT JOIN users u ON u.user_id = r.requested_by
          WHERE r.sale_id = ANY($1) ORDER BY r.created_at, r.return_id`, posIds),
      q(`SELECT ri.return_id, ri.sale_item_id, ri.qty, ri.amount, i.sku, i.name, i.unit FROM pos_return_items ri
           JOIN pos_sale_items i ON i.item_id = ri.sale_item_id JOIN pos_return_requests r ON r.return_id = ri.return_id
          WHERE r.sale_id = ANY($1) ORDER BY ri.return_item_id`, posIds)]);
    const retLinesBy = groupBy(posReturnLines.rows, 'return_id'), retBySale = groupBy(posReturns.rows, 'sale_id');
    const pItems = groupBy(posItems.rows, 'sale_id'), oItems = groupBy(ordItems.rows, 'order_id');
    const voidBy = new Map(voids.rows.map(v => [v.sale_id, v])), cancelBy = new Map(cancels.rows.map(c => [c.order_id, c]));
    const histBy = groupBy(hist.rows, 'order_id');
    const dl = await delivery.loadFor(ordIds);

    const out = [];
    for (const s of pos.rows) {
      const v = voidBy.get(s.sale_id), rets = (retBySale.get(s.sale_id) || []).map(r => returnJson(r, retLinesBy.get(r.return_id) || []));
      // Items, total and profit are what the shop actually kept: lines already returned (approved) are taken off, so reports stay correct.
      const gone = new Map();
      for (const r of retBySale.get(s.sale_id) || []) if (r.status === 'approved')
        for (const l of retLinesBy.get(r.return_id) || []) gone.set(String(l.sale_item_id), round2((gone.get(String(l.sale_item_id)) || 0) + +l.qty));
      const refunded = round2(rets.filter(r => r.status === 'approved').reduce((n, r) => n + r.amount, 0));
      const kept = (pItems.get(s.sale_id) || []).map(i => ({ ...i, qty: round2(+i.qty - (gone.get(String(i.item_id)) || 0)) })).filter(i => i.qty > 0);
      const items = kept.map(lineJson);
      const net = round2(+s.total - refunded);
      const pending = rets.find(r => r.status === 'pending');
      out.push({
        source: 'POS', ref: s.receipt_no, createdAt: new Date(s.created_at).getTime(), customer: s.customer_name || 'Walk-in customer', phone: s.customer_phone || '', fulfillment: s.fulfillment === 'Delivery' ? 'Delivery' : 'Walk-in',
        address: s.fulfillment === 'Delivery' ? (s.delivery_address + (s.delivery_landmark ? ` (Landmark: ${s.delivery_landmark})` : '')) : undefined,
        method: s.method, subtotal: round2(net - (+s.delivery_fee || 0)), deliveryFee: +s.delivery_fee || 0, total: net, vat: refunded ? round2(net * VAT_RATE / (1 + VAT_RATE)) : +s.vat, status: s.status, cashier: s.cashier_name,
        tendered: s.tendered === null ? undefined : +s.tendered, change: s.change_given === null ? undefined : +s.change_given, cardRef: s.card_ref || undefined,
        items, ...money(items), next: null, canCancel: false, history: [],
        originalTotal: +s.total, refunded, returns: rets, returnRequest: pending || null,
        voidRequest: v ? { id: v.request_id, reason: v.reason } : null
      });
    }
    for (const o of ord.rows) {
      const items = (oItems.get(o.order_id) || []).map(lineJson), c = cancelBy.get(o.order_id), flow = FLOW[o.fulfillment] || [];
      const at = flow.indexOf(o.status);
      out.push({
        source: 'Shop', ref: o.order_no, createdAt: new Date(o.created_at).getTime(), customer: o.customer || 'Customer', phone: o.phone,
        address: o.address || undefined, fulfillment: o.fulfillment, method: o.payment_method, subtotal: +o.subtotal, deliveryFee: +o.delivery_fee,
        total: +o.total, status: o.status, receivedBy: o.received_by || undefined, items, ...money(items),
        delivery: o.fulfillment === 'Delivery' ? delivery.financeJson(dl.rows.get(String(o.order_id)), dl.proofs.get(String(o.order_id))) : undefined,
        next: at >= 0 && at < flow.length - 1 ? flow[at + 1] : null,
        canCancel: ADMIN_CANCELLABLE.includes(o.status),
        cancelRequest: c ? { reason: c.reason } : null,
        refund: refundJson(refundBy.get(String(o.order_id))),
        history: (histBy.get(o.order_id) || []).map(h => ({ from: h.from_status, to: h.to_status, note: h.note || undefined, by: h.changed_by_name || 'System', at: new Date(h.created_at).getTime() }))
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ flow: FLOW, sales: out });
  }));

  // Move an online order one step forward: Paid -> Packed -> Out for Delivery / Ready for Pickup -> Delivered / Picked Up.
  app.post('/api/orders/:no/status', auth('finance', 'cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const target = str(b.status), note = str(b.note), receivedBy = str(b.receivedBy);
    if (!target) throw bad('status', 'Choose the new status');
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    let handover = null;                                                  // the receipt of COD cash taken with this move
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0], flow = FLOW[o.fulfillment];
      if (!flow) throw bad('id', 'This order has no delivery or pickup type, so its status cannot be changed');
      if (o.status === 'Cancelled') throw bad('status', 'This order was cancelled and can no longer be changed');
      if (FINAL_STATUS.includes(o.status)) throw bad('status', `This order is already ${o.status} and is closed`);
      const at = flow.indexOf(o.status);
      if (at < 0) throw bad('status', `The current status "${o.status}" is not recognised`);
      const pend = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
      if (pend.rowCount) throw bad('status', 'The customer asked to cancel this order. Approve or reject that request first');
      const next = flow[at + 1];
      if (target !== next) throw bad('status', flow.includes(target)
        ? `The next step for this order is "${next}". Steps cannot be skipped or moved backwards`
        : `"${target}" is not a ${o.fulfillment.toLowerCase()} status`);
      if (FINAL_STATUS.includes(target) && (receivedBy.length < 2 || receivedBy.length > 80))
        throw bad('receivedBy', `Enter the name of the person who ${o.fulfillment === 'Delivery' ? 'received' : 'picked up'} the order (2–80 characters)`);
      // Delivery orders: who takes it out and when (Out for Delivery), proof that it arrived (Delivered). Pickup orders are not affected.
      await delivery.ready;
      const prev = o.fulfillment === 'Delivery' && ['Out for Delivery', 'Delivered'].includes(target)
        ? (await client.query('SELECT * FROM order_deliveries WHERE order_id = $1', [o.order_id])).rows[0] : null;
      const dispatch = o.fulfillment === 'Delivery' && target === 'Out for Delivery' ? delivery.dispatchFields(req.user.role === 'cashier' ? { courier: 'Store Dispatch' } : b.delivery, o) : null;
      if (dispatch) dispatch.trackingNo = await delivery.trackingFor(client, prev);   // generated here, never typed by Finance
      const arrived = o.fulfillment === 'Delivery' && target === 'Delivered' ? await delivery.deliveredFields(client, b.delivery, o, prev, req.user.role === 'cashier' ? { proof: false } : undefined) : null;

      const gate = moneyGate(o, target, req.user.role);
      if (!gate.ok) throw bad(gate.field || 'payment', gate.reason);
      let shiftId = null, cashReceived = null;
      const collect = gate.collect > 0 ? round2(gate.collect) : 0;        // COD balance taken at the counter / door right now
      if (FINAL_STATUS.includes(target) && req.user.role === 'cashier') {
        if (!/^\p{L}[\p{L}\s.'’\-]{1,79}$/u.test(receivedBy)) throw bad('receivedBy', 'Enter a valid recipient name');
        if (target === 'Picked Up') {
          if (!['National ID', 'Driver License', 'Passport', 'School ID', 'Company ID', 'Other Government ID'].includes(str(b.pickupIdType))) throw bad('pickupIdType', 'Choose the ID presented');
          if (!/^[A-Za-z0-9]{4}$/.test(str(b.pickupIdLast4))) throw bad('pickupIdLast4', 'Enter the last four ID characters');
        }
        if (b.representative && (str(b.relationship).length < 3 || str(b.relationship).length > 60)) throw bad('relationship', 'Enter the representative relationship (3–60 characters)');
        if (collect > 0) {
          cashReceived = Number(b.cashReceived);
          if (!Number.isFinite(cashReceived) || !/^\d+(?:\.\d{1,2})?$/.test(String(b.cashReceived)) || cashReceived < collect || cashReceived > collect + 100000)
            throw bad('cashReceived', `Enter the cash received; it must cover the ${peso(collect)} balance`);
          const shift = await client.query('SELECT shift_id, opened_at FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL FOR UPDATE', [req.user.id]);
          if (!shift.rowCount) throw bad('cashReceived', 'Open your Cash Shift before collecting payment');
          if (app.locals.shiftIsStale && app.locals.shiftIsStale(shift.rows[0].opened_at)) throw bad('cashReceived', 'Your cash shift from an earlier day is still open. Count and close it, then open a new shift, before collecting payment');
          if (app.locals.shiftMustClose && app.locals.shiftMustClose(shift.rows[0].opened_at)) throw bad('cashReceived', 'It is time to close your cash shift. Count the drawer and close it first; cash can no longer be collected on this shift');
          shiftId = shift.rows[0].shift_id;
        }
      }
      if (target === 'Paid') await confirmOrder(client, o, req.user, note);   // also deducts stock and writes its own history line
      else {
        if (!o.stock_deducted) throw bad('status', 'Stock has not been deducted for this order. Contact the system administrator');
        await client.query('UPDATE orders SET status = $2, status_updated_at = now(), received_by = COALESCE($3, received_by) WHERE order_id = $1',
          [o.order_id, target, FINAL_STATUS.includes(target) ? receivedBy : null]);
        if (shiftId !== null) {        // the COD cash goes into the ledger (and this cashier's drawer), like any counter payment
          const p = await app.locals.paymentTerms.applyPayment(client, { kind: 'order', no: o.order_no, amount: collect, method: 'Cash', tendered: cashReceived,
            cashShiftId: shiftId, actor: req.user, note: `Collected on ${target === 'Delivered' ? 'delivery' : 'pickup'}`, requestId: str(b.requestId) || undefined });
          await client.query("UPDATE orders SET payment_status = 'paid', cash_shift_id = $2 WHERE order_id = $1", [o.order_id, shiftId]);
          handover = { receiptNo: 'INV-' + o.order_no + '-' + p.paymentId, paymentId: p.paymentId, amount: p.amount, tendered: p.tendered, change: p.change,
            paidAmount: p.parent.paid, balance: p.parent.balance };
        }
        if (dispatch) await delivery.saveDispatch(client, o.order_id, dispatch, req.user.id);
        if (arrived) await delivery.saveDelivered(client, o.order_id, arrived, req.user.id);
        const histNote = dispatch ? [delivery.summary(dispatch), note].filter(Boolean).join(' — ')
          : FINAL_STATUS.includes(target) ? [`Received by ${receivedBy}`, arrived && arrived.notes, note].filter(Boolean).join(' — ') : note;
        await logStatus(client, o.order_id, o.status, target, req.user.id, histNote);
        await audit(client, req.user, 'Record edited', `Order ${o.order_no} moved from ${o.status} to ${target}` + (dispatch ? ` — ${delivery.summary(dispatch)}` : ''));
      }
    });
    res.json({ ok: true, ...(handover || {}) });
    notify(req.params.no, target, target === 'Paid' ? { by: 'finance' } : undefined);   // a person confirmed it: the "confirmed automatically" alert is only for online payments
  }));

  // Admin cancels an order directly (reason required). Stock goes back if it was already deducted.
  app.post('/api/orders/:no/cancel', auth('finance'), wrap(async (req, res) => {
    const body = req.body || {};
    let code = str(body.reasonCode) || 'other';
    if (!CANCEL_REASONS[code]) throw bad('reasonCode', 'Choose a cancellation reason');
    const reason = str(body.reason);
    if (reason.length < 5 || reason.length > 300) throw bad('reason', 'Please explain why (5 to 300 characters)');
    await tx(async (client) => {
      const r = await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no]);
      if (!r.rowCount) throw bad('id', 'Order not found');
      const o = r.rows[0];
      if (!body.reasonCode && o.status === 'On Hold' && o.balance_hold_from) code = 'balance_unpaid';
      if (o.status === 'Cancelled') throw bad('id', 'This order is already cancelled');
      if (FINAL_STATUS.includes(o.status)) throw bad('id', `This order was already ${o.status.toLowerCase()}, so it cannot be cancelled. Handle it as a return instead`);
      if (!ADMIN_CANCELLABLE.includes(o.status)) throw bad('id', `An order that is "${o.status}" can no longer be cancelled`);
      if (o.stock_deducted) {
        const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
        for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
          userId: req.user.id, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}` });
      }
      await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
      await client.query(`UPDATE order_cancel_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE order_id = $1 AND status = 'pending'`, [o.order_id, req.user.id]);
      const kept = await app.locals.paymentTerms.cancellationPolicy(client, o, code, body, req.user);
      const owed = await queueCancelRefund(client, o, req.user.id, kept);
      await logStatus(client, o.order_id, o.status, 'Cancelled', req.user.id, reason + (owed ? ` — refund of ${peso(owed)} queued` : ''));
      await audit(client, req.user, 'Record edited', `Order ${o.order_no} cancelled by admin: ${reason}${o.stock_deducted ? ' — stock restored, refund to original payment method due' : ''}`);
    });
    res.json({ ok: true });
    notify(req.params.no, 'Cancelled', { reason });
  }));

  /* ---------- deliveries and pickups that did not happen + cash rules ----------
     A delivery that fails (nobody home, refused, unreachable, wrong address, or a problem on our side) is either tried
     again (the order goes back to Packed, the stock stays reserved) or cancelled (the stock goes back on sale and any
     money received is queued for refund). A pickup nobody collects is cancelled the same way: by staff, or by itself
     PICKUP_HOLD_DAYS after it became Ready for Pickup, with a reminder 2 days before.
     Every failure is recorded in order_failures. Those caused by the customer count as a "no-show"; a customer with
     max_no_shows of them can no longer choose cash, and cash on delivery is limited to cod_limit per order.
     Finance sets the three numbers (order_rules, Payment Terms page). */
  const SYSTEM = { id: null, name: 'System', roleLabel: 'System' };
  const FAIL_REASONS = {
    Delivery: { not_home: ['Nobody home to receive it', true], refused: ['Customer refused the order or the cash payment', true],
      unreachable: ['Customer could not be reached', true], wrong_address: ['Wrong or incomplete address', true],
      shop_issue: ['Our side: vehicle, weather or schedule', false], other: ['Other reason', false] },
    Pickup: { not_picked_up: ['Customer did not pick it up', true], other: ['Other reason', false] }
  };
  const rulesReady = (async () => {
    try {
      // cost of goods per sale line (see confirmOrder and the POS sale): old lines get today's cost once, as the best estimate available
      for (const t of ['pos_sale_items', 'order_items']) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2)`);
        await pool.query(`UPDATE ${t} i SET unit_cost = p.unit_cost FROM products p WHERE p.product_id = i.product_id AND i.unit_cost IS NULL`);
      }
      await pool.query(`CREATE TABLE IF NOT EXISTS order_rules (
        id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        cod_limit NUMERIC(14,2) NOT NULL DEFAULT 10000 CHECK (cod_limit >= 0),
        max_no_shows INT NOT NULL DEFAULT 2 CHECK (max_no_shows BETWEEN 0 AND 10),
        pickup_hold_days INT NOT NULL DEFAULT 7 CHECK (pickup_hold_days BETWEEN 2 AND 60),
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('INSERT INTO order_rules (id) VALUES (1) ON CONFLICT DO NOTHING');
      // cash on pickup: a down payment paid online, kept if the customer does not come within cop_hold_hours of "Ready for Pickup"
      await pool.query('ALTER TABLE order_rules ADD COLUMN IF NOT EXISTS cop_deposit NUMERIC(14,2) NOT NULL DEFAULT 200 CHECK (cop_deposit >= 0)');
      await pool.query('ALTER TABLE order_rules ADD COLUMN IF NOT EXISTS cop_hold_hours INT NOT NULL DEFAULT 48 CHECK (cop_hold_hours BETWEEN 6 AND 336)');
      // cash on delivery: a down payment paid online together with the delivery fee (taken off what the rider collects)
      await pool.query('ALTER TABLE order_rules ADD COLUMN IF NOT EXISTS cod_deposit NUMERIC(14,2) NOT NULL DEFAULT 200 CHECK (cod_deposit >= 0)');
      // the part of a cash order paid online first (delivery fee for COD, down payment for COP), and what was kept when the customer did not show
      await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_kind TEXT CHECK (advance_kind IN ('shipping_fee','deposit'))`);
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS advance_amount NUMERIC(14,2) NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS forfeited_amount NUMERIC(14,2) NOT NULL DEFAULT 0');
      await pool.query(`CREATE TABLE IF NOT EXISTS order_failures (
        failure_id  BIGSERIAL PRIMARY KEY,
        order_id    BIGINT NOT NULL REFERENCES orders(order_id),
        customer_id INT REFERENCES users(user_id),
        kind        TEXT NOT NULL CHECK (kind IN ('Delivery','Pickup')),
        reason      TEXT NOT NULL,
        note        TEXT,
        outcome     TEXT NOT NULL CHECK (outcome IN ('retry','cancelled')),
        counts      BOOLEAN NOT NULL,
        recorded_by INT REFERENCES users(user_id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS ix_order_failures_customer ON order_failures (customer_id) WHERE counts');
      // Supabase: tables made at start-up also get row level security (the app owns them, so its own queries are not affected)
      for (const t of ['order_rules', 'order_failures']) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    } catch (err) { console.warn('[db] could not prepare the order rules tables:', err.message); }
  })();
  async function getRules(db) {
    await rulesReady;
    const r = (await (db || pool).query('SELECT cod_limit, max_no_shows, pickup_hold_days, cop_deposit, cop_hold_hours, cod_deposit, updated_at, u.full_name AS updated_by FROM order_rules LEFT JOIN users u ON u.user_id = order_rules.updated_by WHERE id = 1')).rows[0]
      || { cod_limit: 10000, max_no_shows: 2, pickup_hold_days: 7, cop_deposit: 200, cop_hold_hours: 48, cod_deposit: 200 };
    return { codLimit: round2(+r.cod_limit), maxNoShows: +r.max_no_shows, pickupHoldDays: +r.pickup_hold_days,
      copDeposit: round2(+r.cop_deposit), copHoldHours: +r.cop_hold_hours, codDeposit: round2(+r.cod_deposit),
      updatedBy: r.updated_by || undefined, updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined };
  }
  async function noShowCount(db, customerId) {
    await rulesReady;
    return (await (db || pool).query('SELECT COUNT(*)::int AS n FROM order_failures WHERE customer_id = $1 AND counts', [customerId])).rows[0].n;
  }
  async function cashCheck(db, customerId, fulfillment, total) {
    const rules = await getRules(db), n = await noShowCount(db, customerId);
    const cashWord = fulfillment === 'Delivery' ? 'Cash on delivery' : 'Cash on pickup';
    if (rules.maxNoShows > 0 && n >= rules.maxNoShows)
      return { ok: false, rules, noShows: n, reason: `${cashWord} is not available on your account after ${n} missed ${n === 1 ? 'delivery or pickup' : 'deliveries or pickups'}. Please pay online.` };
    if (fulfillment === 'Delivery' && rules.codLimit > 0 && total > rules.codLimit + 0.004)
      return { ok: false, rules, noShows: n, reason: `Cash on delivery is available for orders up to ${peso(rules.codLimit)}. Please pay online for this order${n ? '' : ', or choose Pickup'}.` };
    return { ok: true, rules, noShows: n };
  }
  app.locals.orderRules = { get: getRules, cashCheck };

  app.get('/api/finance/order-rules', auth('finance'), wrap(async (req, res) => res.json(await getRules())));
  app.put('/api/finance/order-rules', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {}, e = {};
    const money = String(b.codLimit == null ? '' : b.codLimit).replace(/[,₱\s]/g, '');
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(money)) e.codLimit = 'Enter the limit in pesos, e.g. 10000 (0 = no limit)';
    const shows = Number(b.maxNoShows), days = Number(b.pickupHoldDays);
    if (!Number.isInteger(shows) || shows < 0 || shows > 10) e.maxNoShows = 'Enter a whole number from 0 (off) to 10';
    if (!Number.isInteger(days) || days < 2 || days > 60) e.pickupHoldDays = 'Enter a whole number of days from 2 to 60';
    const before = await getRules();
    // cash on pickup down payment and how long a cash-on-pickup order is held (older screens do not send them: keep what is set)
    const depRaw = b.copDeposit == null ? String(before.copDeposit) : String(b.copDeposit).replace(/[,₱\s]/g, '');
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(depRaw) || Number(depRaw) > 100000) e.copDeposit = 'Enter the down payment in pesos, from 0 (no down payment) to 100,000';
    const codRaw = b.codDeposit == null ? String(before.codDeposit) : String(b.codDeposit).replace(/[,₱\s]/g, '');
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(codRaw) || Number(codRaw) > 100000) e.codDeposit = 'Enter the down payment in pesos, from 0 (delivery fee only) to 100,000';
    const hours = b.copHoldHours == null ? before.copHoldHours : Number(b.copHoldHours);
    if (!Number.isInteger(hours) || hours < 6 || hours > 336) e.copHoldHours = 'Enter a whole number of hours from 6 to 336 (14 days)';
    if (Object.keys(e).length) throw new ValidationError(e);
    await rulesReady;
    await pool.query('UPDATE order_rules SET cod_limit = $1, max_no_shows = $2, pickup_hold_days = $3, cop_deposit = $4, cop_hold_hours = $5, cod_deposit = $7, updated_by = $6, updated_at = now() WHERE id = 1',
      [round2(Number(money)), shows, days, round2(Number(depRaw)), hours, req.user.id, round2(Number(codRaw))]);
    await audit(pool, req.user, 'Record edited', `Order rules: cash on delivery limit ${peso(before.codLimit)} → ${peso(Number(money))}, ` +
      `missed deliveries/pickups before cash is blocked ${before.maxNoShows} → ${shows}, pickup hold ${before.pickupHoldDays} → ${days} days, ` +
      `cash on pickup down payment ${peso(before.copDeposit)} → ${peso(Number(depRaw))}, cash on pickup hold ${before.copHoldHours} → ${hours} hours, ` +
      `cash on delivery down payment ${peso(before.codDeposit)} → ${peso(Number(codRaw))}`);
    res.json(await getRules());
  }));
  // the checkout asks before showing the cash option, so the customer is never surprised at "Place order"
  app.get('/api/shop/cash-options', auth('customer'), wrap(async (req, res) => {
    const rules = await getRules(), n = await noShowCount(null, req.user.id);
    res.json({ codLimit: rules.codLimit, maxNoShows: rules.maxNoShows, noShows: n, cashBlocked: rules.maxNoShows > 0 && n >= rules.maxNoShows, pickupHoldDays: rules.pickupHoldDays,
      copDeposit: rules.copDeposit, copHoldHours: rules.copHoldHours, codDeposit: rules.codDeposit, onlineReady: !!process.env.XENDIT_SECRET_KEY });
  }));

  // cancel an order that never reached the customer: stock back on sale, any money received queued for refund
  // forfeit: the customer did not show (no-show pickup, refused / not home on delivery): the advance paid online is kept, not refunded
  async function cancelUndelivered(client, o, userId, reason, forfeit) {
    if (o.stock_deducted) {
      const { rows: items } = await client.query('SELECT product_id, qty FROM order_items WHERE order_id = $1 ORDER BY product_id', [o.order_id]);
      for (const i of items) await postMovement(client, { productId: i.product_id, type: 'in', reason: 'refund', qty: +i.qty,
        userId, sourceType: 'order', sourceId: o.order_id, note: `Cancelled ${o.order_no}: ${reason}` });
    }
    await client.query(`UPDATE orders SET status = 'Cancelled', stock_deducted = FALSE, status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
    await client.query(`UPDATE order_cancel_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE order_id = $1 AND status = 'pending'`, [o.order_id, userId]);
    const kept = forfeit && isCod(o) && Number(o.advance_amount) > 0 ? round2(Math.min(paidIn(o), Number(o.advance_amount))) : 0;
    if (kept > 0) await client.query('UPDATE orders SET forfeited_amount = $2 WHERE order_id = $1', [o.order_id, kept]);
    const owed = await queueCancelRefund(client, o, userId, kept);
    await logStatus(client, o.order_id, o.status, 'Cancelled', userId, reason + (kept ? ` — ${advLabel(o)} of ${peso(kept)} forfeited` : '') + (owed ? ` — refund of ${peso(owed)} queued` : ''));
    return owed;
  }

  // staff: the delivery did not go through, or the customer did not pick up the order
  app.post('/api/orders/:no/not-completed', auth('finance', 'cashier'), wrap(async (req, res) => {
    const b = req.body || {}, code = str(b.reason), note = str(b.note), action = str(b.action);
    if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
    await rulesReady;
    const out = await tx(async (client) => {
      const o = (await client.query('SELECT * FROM orders WHERE order_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!o) throw bad('id', 'Order not found');
      const at = o.fulfillment === 'Delivery' ? 'Out for Delivery' : 'Ready for Pickup';
      if (o.status !== at) throw bad('status', o.fulfillment === 'Delivery'
        ? 'Only an order that is Out for Delivery can be marked as not delivered' : 'Only an order that is Ready for Pickup can be marked as not picked up');
      const reasons = FAIL_REASONS[o.fulfillment], r = reasons[code];
      if (!r) throw bad('reason', 'Choose what happened');
      if (code === 'other' && note.length < 5) throw bad('note', 'Describe what happened (at least 5 characters)');
      const act = o.fulfillment === 'Pickup' ? 'cancel' : action;
      if (!['retry', 'cancel'].includes(act)) throw bad('action', 'Choose whether to try the delivery again or cancel the order');
      if (act === 'retry') {
        const pend = await client.query(`SELECT 1 FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`, [o.order_id]);
        if (pend.rowCount) throw bad('action', 'The customer asked to cancel this order: cancel it instead of trying again');
      }
      const words = r[0] + (note ? ` \u2014 ${note}` : '');
      await client.query(`INSERT INTO order_failures (order_id, customer_id, kind, reason, note, outcome, counts, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.order_id, o.customer_id, o.fulfillment, code, note || null, act === 'retry' ? 'retry' : 'cancelled', r[1], req.user.id]);
      const tries = (await client.query(`SELECT COUNT(*)::int AS n FROM order_failures WHERE order_id = $1 AND kind = 'Delivery'`, [o.order_id])).rows[0].n;
      let owed = 0;
      if (act === 'retry') {
        await client.query(`UPDATE orders SET status = 'Packed', status_updated_at = now() WHERE order_id = $1`, [o.order_id]);
        await logStatus(client, o.order_id, o.status, 'Packed', req.user.id, `Delivery attempt ${tries} failed: ${words}. Back to Packed for another try`);
      } else {
        owed = await cancelUndelivered(client, o, req.user.id, (o.fulfillment === 'Delivery' ? 'Not delivered: ' : 'Not picked up: ') + words, r[1]);
      }
      await audit(client, req.user, 'Record edited', `Order ${o.order_no} ${o.fulfillment === 'Delivery' ? 'not delivered' : 'not picked up'} — ${words}; ` +
        (act === 'retry' ? 'back to Packed for another try' : 'cancelled, stock returned' + (owed ? `, refund of ${peso(owed)} queued` : '')) + (r[1] ? ' (counts as a customer no-show)' : ''));
      return { o, act, words, tries, owed };
    });
    res.json({ ok: true, status: out.act === 'retry' ? 'Packed' : 'Cancelled', refundQueued: out.owed || undefined });
    if (out.act === 'retry') later(() => pingUser(out.o.customer_id, { category: 'delivery', title: 'We could not deliver your order',
      body: `We tried to deliver ${out.o.order_no} but could not complete it (${out.words}). We will contact you to arrange another delivery.`,
      link: 'Shop_Customer.html#orders', entityType: 'order', entityId: out.o.order_no, severity: 'warn', dedupeKey: 'deliv_fail:' + out.o.order_no + ':' + out.tries }, 'customer'));
    else notify(out.o.order_no, 'Cancelled', { reason: out.words });
  }));

  // pickups nobody collects: a reminder 2 days before the hold ends, then cancelled by itself (same rules as above)
  /* Pickups nobody collects. Two holds:
       cash on pickup with a down payment  cop_hold_hours after "Ready for Pickup" (default 48): cancelled, the down payment is KEPT
       every other pickup (paid online, or no down payment) pickup_hold_days (default 7): cancelled, whatever was paid is refunded
     The customer is reminded once before the hold ends (a quarter of the hold, at most 12 hours, for the short one; 2 days for the long one). */
  const COP_HELD = `o.payment_method = 'Cash on Pickup' AND COALESCE(o.advance_amount, 0) > 0`;
  async function sweepUnclaimedPickups() {
    const rules = await getRules(), out = { reminded: 0, cancelled: 0, forfeited: 0 };
    const holds = [
      { where: COP_HELD, secs: rules.copHoldHours * 3600, remind: Math.min(12 * 3600, rules.copHoldHours * 900), forfeit: true, words: `within ${rules.copHoldHours} hours` },
      { where: `NOT (${COP_HELD})`, secs: rules.pickupHoldDays * 86400, remind: Math.min(2, rules.pickupHoldDays - 1) * 86400, forfeit: false, words: `within ${rules.pickupHoldDays} days` }
    ];
    for (const h of holds) {
      const soon = await pool.query(
        `SELECT o.order_no, o.customer_id, o.status_updated_at, o.advance_amount, o.total, o.paid_amount FROM orders o WHERE o.status = 'Ready for Pickup' AND ${h.where}
           AND o.status_updated_at < now() - make_interval(secs => $1) AND o.status_updated_at >= now() - make_interval(secs => $2) LIMIT 200`, [h.secs - h.remind, h.secs]);
      for (const o of soon.rows) {
        const by = new Date(new Date(o.status_updated_at).getTime() + h.secs * 1000).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        const n = await pingUser(o.customer_id, { category: 'delivery', title: 'Your order is waiting for pickup',
          body: `Order ${o.order_no} is ready at our shop. Please pick it up by ${by}` + (h.forfeit
            ? ` and pay the ${asPeso(round2(+o.total - +o.paid_amount))} balance in cash. If you do not come, the order is cancelled and your ${asPeso(o.advance_amount)} down payment is not refunded.`
            : ', or it is cancelled automatically.'),
          link: 'Shop_Customer.html#orders', entityType: 'order', entityId: o.order_no, severity: 'warn', dedupeKey: 'pickup_remind:' + o.order_no }, 'customer');
        out.reminded += n ? 1 : 0;
      }
      const due = await pool.query(`SELECT o.order_id, o.order_no FROM orders o WHERE o.status = 'Ready for Pickup' AND ${h.where} AND o.status_updated_at < now() - make_interval(secs => $1) ORDER BY o.order_id LIMIT 100`, [h.secs]);
      for (const row of due.rows) {
        const reason = `Not picked up ${h.words}`;
        const done = await tx(async (client) => {
          const o = (await client.query(`SELECT o.* FROM orders o WHERE o.order_id = $1 AND o.status = 'Ready for Pickup' AND ${h.where} AND o.status_updated_at < now() - make_interval(secs => $2) FOR UPDATE SKIP LOCKED`,
            [row.order_id, h.secs])).rows[0];
          if (!o) return null;
          await client.query(`INSERT INTO order_failures (order_id, customer_id, kind, reason, note, outcome, counts) VALUES ($1,$2,'Pickup','not_picked_up',$3,'cancelled',TRUE)`,
            [o.order_id, o.customer_id, 'Cancelled automatically']);
          const owed = await cancelUndelivered(client, o, null, reason + ' (cancelled automatically)', h.forfeit);
          const kept = (await client.query('SELECT forfeited_amount FROM orders WHERE order_id = $1', [o.order_id])).rows[0].forfeited_amount;
          await audit(client, SYSTEM, 'Record edited', `Order ${o.order_no} cancelled automatically: ${reason.toLowerCase()} — stock returned` +
            (+kept ? `, down payment of ${peso(+kept)} forfeited` : '') + (owed ? `, refund of ${peso(owed)} queued` : ''));
          return { o, kept: +kept };
        });
        if (done) { out.cancelled++; if (done.kept) out.forfeited++;
          notify(done.o.order_no, 'Cancelled', { reason: reason.toLowerCase() + (done.kept ? `; the ${asPeso(done.kept)} down payment is not refunded` : '') }); }
      }
    }
    if (out.cancelled) console.log(`[auto] unclaimed pickups: ${out.cancelled} cancelled (${out.forfeited} down payments kept), ${out.reminded} reminded`);
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'unclaimed-pickups', run: sweepUnclaimedPickups });

  /* ---------- automatic follow-up of online orders nobody paid ----------
     An online-payment (Xendit) order that is still "Pending Confirmation" with nothing paid is cancelled by itself
     ORDER_PAY_HOURS (default 48) after the customer's LAST payment attempt (placing the order, or the last
     "Continue Online Payment", whose time is in xendit_external_id). The customer is reminded once, 12 hours before.
     Before cancelling, Xendit is asked about the open invoice: a payment that arrived late is recorded (and confirms the
     order) instead, and an invoice that is still open is left alone. Nothing was taken from stock yet (that happens on
     confirm), so nothing has to be restocked. A cash-on-delivery / pickup order whose delivery fee or down payment was never paid
     online is treated the same way; one with nothing to pay online first is never touched (the counter handles those).
     Safe with several servers: each order is locked with SKIP LOCKED and checked again before it changes. */
  const PAY_HOURS = Math.max(6, Number(process.env.ORDER_PAY_HOURS) || 48);
  const REMIND_HOURS = Math.min(12, PAY_HOURS / 2);
  const LAST_TRY = `GREATEST(o.created_at, COALESCE(to_timestamp(NULLIF(substring(o.xendit_external_id from '-([0-9]{13})$'), '')::bigint / 1000.0), o.created_at))`;
  const UNPAID = `o.status = 'Pending Confirmation' AND (o.payment_method = 'Xendit' OR (o.payment_method LIKE 'Cash on %' AND COALESCE(o.advance_amount, 0) > 0))
                  AND COALESCE(o.paid_amount, 0) = 0 AND NOT o.stock_deducted
                  AND NOT EXISTS (SELECT 1 FROM order_cancel_requests c WHERE c.order_id = o.order_id AND c.status = 'pending')`;
  async function sweepUnpaidOrders() {
    const out = { reminded: 0, cancelled: 0, paidLate: 0 };
    const remind = await pool.query(
      `SELECT o.order_no, o.customer_id, o.total, ${LAST_TRY} AS last_try FROM orders o
        WHERE ${UNPAID} AND ${LAST_TRY} < now() - make_interval(secs => $1) AND ${LAST_TRY} >= now() - make_interval(secs => $2) LIMIT 200`,
      [(PAY_HOURS - REMIND_HOURS) * 3600, PAY_HOURS * 3600]);
    for (const r of remind.rows) {
      const by = new Date(new Date(r.last_try).getTime() + PAY_HOURS * 3600000).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const n = await pingUser(r.customer_id, { category: 'payment', title: 'Order waiting for payment',
        body: `Order ${r.order_no} (${asPeso(r.total)}) is not paid yet. Pay by ${by} from My Orders, or it is cancelled automatically.`,
        link: 'Shop_Customer.html#orders', entityType: 'order', entityId: r.order_no, severity: 'warn',
        dedupeKey: 'pay_remind:' + r.order_no + ':' + new Date(r.last_try).getTime() }, 'customer');
      out.reminded += n ? 1 : 0;
    }
    const due = await pool.query(`SELECT o.* FROM orders o WHERE ${UNPAID} AND ${LAST_TRY} < now() - make_interval(secs => $1) ORDER BY o.order_id LIMIT 100`, [PAY_HOURS * 3600]);
    for (const o of due.rows) {
      if (o.xendit_invoice_id && process.env.XENDIT_SECRET_KEY) {
        let inv;
        try { inv = await xenditRequest(`${xenditBaseUrl}/v2/invoices/${encodeURIComponent(o.xendit_invoice_id)}`); }
        catch (err) { console.warn('[auto-cancel] could not ask Xendit about ' + o.order_no + ', trying again later:', err.message); continue; }
        if (inv.status === 'PAID' || inv.status === 'SETTLED') {
          try { await applyShopInvoice(o, inv, o.xendit_invoice_id); out.paidLate++; } catch (err) { console.warn('[auto-cancel] late payment for ' + o.order_no + ':', err.message); }
          continue;
        }
        if (inv.status === 'PENDING') continue;          // the customer can still pay this invoice
      }
      const reason = `not paid within ${PAY_HOURS} hours`;
      const done = await tx(async (client) => {
        const cur = (await client.query(`SELECT o.* FROM orders o WHERE o.order_id = $1 AND ${UNPAID} AND ${LAST_TRY} < now() - make_interval(secs => $2) FOR UPDATE SKIP LOCKED`,
          [o.order_id, PAY_HOURS * 3600])).rows[0];
        if (!cur) return false;                            // paid, changed or taken by another server in the meantime
        await client.query(`UPDATE orders SET status = 'Cancelled', status_updated_at = now() WHERE order_id = $1`, [cur.order_id]);
        await logStatus(client, cur.order_id, cur.status, 'Cancelled', null, 'Cancelled automatically: ' + reason);
        await audit(client, SYSTEM, 'Record edited', `Order ${cur.order_no} cancelled automatically: ${reason} (${cur.payment_method === 'Xendit' ? 'online payment' : cur.advance_kind === 'shipping_fee' ? 'cash on delivery, ' + advLabel(cur) : 'cash on pickup, deposit'} never paid)`);
        return true;
      });
      if (done) { out.cancelled++; notify(o.order_no, 'Cancelled', { reason: 'it was ' + reason }); }
    }
    if (out.cancelled || out.paidLate) console.log(`[auto] unpaid online orders: ${out.cancelled} cancelled, ${out.paidLate} paid late, ${out.reminded} reminded`);
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'unpaid-orders', run: sweepUnpaidOrders });
};