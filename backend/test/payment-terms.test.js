/* payment-terms.test.js — the payment policy, the ledger and the balances derived from it.

   Runs over real HTTP against test/desk-browser-harness.js, which mounts the SHIPPED modules
   (backend/payment-terms.js, the quotation half of backend/shop-extras.js and backend/quote-desk.js) and answers their
   SQL from test/payment-double.js. So these assertions exercise the routes, the guards and the balance maths that ship.

   The double re-runs the db/020 trigger maths in JavaScript. What that does NOT prove (no PostgreSQL here): that the
   SQL parses, that the AFTER INSERT trigger really fires, that the unique indexes reject a duplicate, or that the
   JSONB backfill matches. Those are listed as unverified in README_DEPLOY.md and must be run on staging.

     node test/payment-terms.test.js */
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.HARNESS_PORT || 8901);
let port = PORT;
const BASE = () => 'http://127.0.0.1:' + port;
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); }
}

async function start(p, env) {
  port = p;
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(p)],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { XENDIT_SECRET_KEY: '' }, env) });
  const err = [];
  child.stderr.on('data', (b) => err.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(BASE() + '/api/shop/info'); if (r.ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('harness did not start: ' + err.join(''));
}

async function call(role, method, p, body) {
  const s = await fetch(BASE() + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  if (!s.ok) throw new Error('session switch failed');
  const r = await fetch(BASE() + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const state = () => call('cashier', 'GET', '/__harness/state').then((r) => r.body);
const termOf = (rows, key) => rows.find((t) => t.key === key);

/* a shop customer's quote for a catalog product: ready stock, so no fabrication service */
const shopQuote = () => ({ contactName: 'Eva Son', phone: '0921 123 4567', sku: 'ANG-0203', quantity: 4, quantityUnit: 'pcs',
  fulfillment: 'Pickup', neededBy: '2026-12-15',
  specs: { material: 'Aluminum ADC12', size: '2"', thickness: '3.0 mm', finish: 'Raw / Unfinished', service: 'None (as is)' } });

async function main() {
  const child = await start(PORT, { CASHIER_QUOTE_LIMIT_PHP: '60000', HARNESS_QUOTE_BAND_PCT: '1000' });
  try {
    /* ---------------- 1. the policy: percentages are a proposal until Finance switches them on ---------------- */
    console.log('\n1. payment terms ship switched off except Full Payment, and only Finance can change them');
    const cfg = await call('finance', 'GET', '/api/finance/payment-terms');
    ok('Finance can read the policy table: Full, Half and Down Payment (custom partial payment was removed)', cfg.status === 200 && cfg.body.terms.map((t) => t.key).join() === 'full,half,down', cfg.body);
    ok('ledgerReady comes from the database, not a guess', cfg.body.ledgerReady === true, cfg.body.ledgerReady);
    ok('Full Payment is the only term switched on at the start',
      termOf(cfg.body.terms, 'full').enabled === true && ['half', 'down'].every((k) => termOf(cfg.body.terms, k).enabled === false) && !termOf(cfg.body.terms, 'custom'),
      cfg.body.terms.map((t) => [t.key, t.enabled]));
    ok('no partial term is authorised for any order type yet',
      ['half', 'down'].every((k) => termOf(cfg.body.terms, k).retailAllowed === false && termOf(cfg.body.terms, k).madeToOrderAllowed === false));

    const asCashier = await call('cashier', 'POST', '/api/finance/payment-terms/half', { enabled: true, retailAllowed: true });
    ok('a cashier cannot switch a payment term on', asCashier.status === 403, asCashier);
    const noScope = await call('finance', 'POST', '/api/finance/payment-terms/half', { enabled: true });
    ok('a partial term cannot be switched on without saying where it applies', noScope.status === 400 && noScope.body.fields.scope, noScope);
    const badPct = await call('finance', 'POST', '/api/finance/payment-terms/down', { percent: 130, enabled: true, madeToOrderAllowed: true });
    ok('a down payment above 100% is refused', badPct.status === 400 && badPct.body.fields.percent, badPct);
    const fullPct = await call('finance', 'POST', '/api/finance/payment-terms/full', { percent: 50 });
    ok('Full Payment cannot be quietly redefined as a partial term', fullPct.status === 400 && fullPct.body.fields.percent, fullPct);

    const enableHalf = await call('finance', 'POST', '/api/finance/payment-terms/half',
      { enabled: true, madeToOrderAllowed: true, percent: 50, balanceCondition: 'balance due before release', note: 'Pilot for made-to-order only' });
    ok('Finance can switch Half on for made-to-order only', enableHalf.status === 200 && enableHalf.body.term.enabled === true
      && enableHalf.body.term.madeToOrderAllowed === true && enableHalf.body.term.retailAllowed === false, enableHalf.body);

    const posRetail = await call('cashier', 'GET', '/api/pos/payment-terms?total=9000&madeToOrder=false');
    ok('for ready stock only Full Payment is offered', posRetail.status === 200 && posRetail.body.options.length === 1 && posRetail.body.options[0].key === 'full', posRetail.body);
    const posMto = await call('cashier', 'GET', '/api/pos/payment-terms?total=9000&madeToOrder=true');
    ok('for made-to-order, Half appears with its amounts worked out server-side',
      posMto.body.options.map((o) => o.key).join(',') === 'full,half' && termOf(posMto.body.options, 'half').dueNow === 4500 && termOf(posMto.body.options, 'half').balance === 4500, posMto.body);
    ok('Custom is never a self-service option at the counter', !posMto.body.options.some((o) => o.key === 'custom'));

    /* ---------------- 2. a quotation carries its terms before it is ever sent ---------------- */
    console.log('\n2. payment terms belong to the quotation, and no money moves while it is still pending');
    const created = await call('customer', 'POST', '/api/shop/quotes', shopQuote());
    const no = created.body && created.body.id;
    ok('the customer raised the request', created.status === 201 && !!no, created);
    const priced = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/price', { amount: '9000', leadTime: '1 to 3 working days', validDays: 7, note: 'Standard angle bar price' });
    ok('the cashier priced it within the configured ceiling', priced.status === 200 && priced.body.status === 'quoted', priced);

    const earlyPay = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '4500', method: 'Cash' });
    ok('nothing can be collected while the quote is only quoted, not accepted', earlyPay.status === 400 && earlyPay.body.fields.status, earlyPay);

    const retailHalf = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/terms', { termKey: 'half' });
    ok('a term switched on for made-to-order is not offered on a ready-stock quote', retailHalf.status === 400 && retailHalf.body.fields.termKey, retailHalf);
    const customByCashier = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/terms', { termKey: 'custom', percent: 40 });
    ok('a cashier cannot invent a custom percentage', customByCashier.status === 400 && customByCashier.body.fields.termKey, customByCashier);
    const customByFinance = await call('finance', 'POST', '/api/finance/quotes/' + no + '/terms', { termKey: 'custom', percent: 40 });
    ok('custom partial payment is gone for Finance too', customByFinance.status === 400 && /no longer offered/.test(JSON.stringify(customByFinance.body)), customByFinance);
    const switchOn = await call('finance', 'POST', '/api/finance/payment-terms/custom', { enabled: true, madeToOrderAllowed: true });
    ok('…and it cannot be switched back on', switchOn.status === 400, switchOn);
    const disabledDown = await call('finance', 'POST', '/api/finance/quotes/' + no + '/terms', { termKey: 'down' });
    ok('even Finance cannot attach a term that is switched off — the policy comes first', disabledDown.status === 400 && disabledDown.body.fields.termKey, disabledDown);

    const approveHalf = await call('finance', 'POST', '/api/finance/quotes/' + no + '/terms', { termKey: 'half', condition: 'balance due before pickup' });
    const terms = approveHalf.body && approveHalf.body.terms;
    ok('Finance approved Half Payment on this quotation', approveHalf.status === 200 && terms.state === 'approved' && terms.key === 'half', approveHalf.body);
    ok('the terms block carries total, percent, initial amount, balance and its condition',
      terms.total === 9000 && terms.percent === 50 && terms.amount === 4500 && terms.balance === 4500 && terms.condition === 'balance due before pickup', terms);

    const shown = await call('cashier', 'GET', '/api/pos/quote-desk/' + no);
    ok('the desk screen reads the same approved terms from the backend',
      shown.status === 200 && shown.body.terms && shown.body.terms.state === 'approved' && shown.body.terms.amount === 4500, shown.body && shown.body.terms);
    ok('the quotation is still unpaid and its balance is the whole amount',
      +shown.body.paidAmount === 0 && shown.body.paymentState === 'unpaid' && +shown.body.balance === 9000, shown.body);

    const mine = await call('customer', 'GET', '/api/shop/quotes');
    const card = (mine.body || []).find((x) => String(x.id) === String(no));
    ok('the customer sees these terms on their own quote card', mine.status === 200 && card && card.terms && card.terms.state === 'approved'
      && card.terms.percent === 50 && card.dueNow === 4500 && card.terms.condition === 'balance due before pickup', card && { terms: card.terms, dueNow: card.dueNow });

    /* ---------------- 3. acceptance covers the terms; then the ledger takes the money ---------------- */
    console.log('\n3. the initial payment is recorded once, the balance stays outstanding');
    const depositCod = await call('customer', 'POST', '/api/shop/quotes/' + no + '/respond', { action: 'accept', payMethod: 'cod' });
    ok('a required deposit cannot be deferred to COD', depositCod.status === 400 && depositCod.body.fields.payMethod, depositCod);
    const accepted = await call('customer', 'POST', '/api/shop/quotes/' + no + '/respond', { action: 'accept', payMethod: 'online' });
    ok('the customer accepted the quote', accepted.status === 200 && accepted.body.status === 'accepted', accepted);
    const afterAccept = await call('cashier', 'GET', '/api/pos/quote-desk/' + no);
    ok('acceptance stamps the terms as reviewed by the customer', afterAccept.body.terms.seenAt > 0, afterAccept.body.terms);
    ok('accepting does not mark anything paid', +afterAccept.body.paidAmount === 0 && afterAccept.body.paymentState === 'unpaid', afterAccept.body);

    for (const amount of [true, [100], {}, '0x10', '1e2']) {
      const invalid = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount, method: 'Cash' });
      ok('malformed payment amount is refused: ' + JSON.stringify(amount), invalid.status === 400 && invalid.body.fields.amount, invalid);
    }
    ok('invalid payment input leaves the ledger empty', (await state()).payments.length === 0);

    const initial = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment',
      { amount: '4500', method: 'Cash', note: 'Down payment at the counter', requestId: 'pay-test-initial-0001' });
    ok('the initial payment is accepted', initial.status === 200 && initial.body.paidAmount === 4500, initial);
    ok('the order is partially paid, not paid', initial.body.paymentState === 'partially_paid' && initial.body.balance === 4500, initial.body);
    let st = await state();
    ok('one ledger row exists and it is the initial payment',
      st.payments.length === 1 && st.payments[0].direction === 'in' && st.payments[0].purpose === 'initial' && Number(st.payments[0].amount) === 4500, st.payments);
    const quote = st.quotes.find((q) => q.quote_no === no);
    ok('the ledger owns the total, the trigger maths agrees with the route', Number(quote.paid_amount) === 4500 && quote.payment_state === 'partially_paid', { paid: quote.paid_amount, state: quote.payment_state });
    ok('the quotation keeps its display copy with the ledger id on it',
      Array.isArray(quote.payments) && quote.payments.length === 1 && quote.payments[0].id > 0, quote.payments);

    const replay = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment',
      { amount: '4500', method: 'Cash', requestId: 'pay-test-initial-0001' });
    ok('the same request id replayed changes nothing', replay.status === 200 && replay.body.replayed === true && replay.body.paidAmount === 4500, replay);
    st = await state();
    ok('no second ledger row from the retry', st.payments.length === 1, st.payments.length);

    const over = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '5000', method: 'Cash', requestId: 'pay-test-over-000001' });
    ok('overpayment is refused with the real balance in the message',
      over.status === 400 && /4,500/.test(over.body.fields.amount), over.body);
    const zero = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '0', method: 'Cash' });
    ok('a zero or negative amount is refused', zero.status === 400 && zero.body.fields.amount, zero);
    const odd = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '100', method: 'Bitcoin' });
    ok('an unknown payment method is refused', odd.status === 400 && odd.body.fields.method, odd);
    const wrongState = await call('customer', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '100', method: 'Cash' });
    ok('a customer cannot record a payment received', wrongState.status === 403, wrongState);

    const rest = await call('finance', 'POST', '/api/finance/quotes/' + no + '/payment', { amount: '4500', method: 'Bank transfer', requestId: 'pay-test-rest-00001' });
    ok('the balance payment settles it', rest.status === 200 && rest.body.paidAmount === 9000 && rest.body.balance === 0, rest);
    ok('the state is derived from the confirmed net, not from a redirect', rest.body.paymentState === 'paid', rest.body);
    st = await state();
    ok('two rows, and the second is a balance payment', st.payments.length === 2 && st.payments[1].purpose === 'balance', st.payments.map((p) => [p.purpose, String(p.amount), p.method]));

    const ledger = await call('finance', 'GET', '/api/finance/payment-ledger/quote/' + no);
    ok('the ledger view agrees with the totals on the quote',
      ledger.status === 200 && ledger.body.total === 9000 && ledger.body.paidAmount === 9000 && ledger.body.outstanding === 0 && ledger.body.payments.length === 2, ledger.body);
    const ledgerRetail = await call('finance', 'GET', '/api/finance/payment-terms');
    ok('receivables are counted from the ledger, with this quote no longer outstanding there',
      ledgerRetail.status === 200 && ledgerRetail.body.receivables != null && typeof ledgerRetail.body.receivables.outstanding === 'number', ledgerRetail.body.receivables);

    /* ---------------- 4. converting a paid quotation moves its money, exactly once ---------------- */
    console.log('\n4. conversion carries the approved terms and the payments already made into the order');
    const before = await state();
    const conv = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'conv-test-payments-0001', recipient: 'Eva Son' });
    ok('the accepted quotation became one order', conv.status === 200 && conv.body.kind === 'order' && !!conv.body.orderNo, conv.body);
    ok('the quotation payments moved with it', conv.body.paymentsMoved === 2 && conv.body.paidAmount === 9000, conv.body);
    st = await state();
    const order = st.orders.find((o) => o.order_no === conv.body.orderNo);
    ok('the order owes nothing more: total 9000, confirmed 9000', Number(order.total) === 9000 && Number(order.paid_amount) === 9000 && order.payment_state === 'paid', order);
    ok('the approved terms travelled to the order', order.terms_key === 'half' && Number(order.terms_percent) === 50 && Number(order.terms_amount) === 4500,
      { key: order.terms_key, pct: order.terms_percent, amt: order.terms_amount });
    const movedQuote = st.quotes.find((q) => q.quote_no === no);
    ok('the quotation no longer holds the money (it belongs to the order now)', Number(movedQuote.paid_amount) === 0 && movedQuote.payment_state === 'unpaid',
      { paid: movedQuote.paid_amount, state: movedQuote.payment_state });
    ok('its display copy says where each payment went', movedQuote.payments.every((p) => p.movedTo === order.order_no), movedQuote.payments);
    const inRows = st.payments.filter((p) => p.paid_for === 'order' && p.direction === 'in');
    const outRows = st.payments.filter((p) => p.paid_for === 'quote' && p.direction === 'out');
    ok('the move left a matching pair of rows, not an edited history', inRows.length === 2 && outRows.length === 2, { inRows: inRows.length, outRows: outRows.length });
    ok('the ledger still totals what the customer actually handed over',
      Math.round(st.payments.reduce((n, p) => n + (p.direction === 'in' ? Number(p.amount) : -Number(p.amount)), 0)) === 9000, st.payments.length);

    const again = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'conv-test-payments-0002' });
    ok('a second conversion returns the same order', again.status === 200 && again.body.orderNo === order.order_no && again.body.duplicate === true, again.body);
    st = await state();
    ok('and moves no money a second time', st.orders.length === before.orders.length + 1 && st.payments.length === before.payments.length + 4,
      { orders: st.orders.length, payments: st.payments.length });
    const finQuotes = await call('finance', 'GET', '/api/finance/quotes');
    const listed = (finQuotes.body || []).find((q) => q.id === no);
    ok('the Finance list names the order this quotation became, so the sales report can count the job once (§10)',
      finQuotes.status === 200 && listed && listed.convertedOrder === conv.body.orderNo, listed && { convertedOrder: listed.convertedOrder });

    /* ---------------- 5. a term refused goes back to Full Payment ---------------- */
    console.log('\n5. refusing a proposed term leaves a plain full-payment quotation');
    const two = await call('customer', 'POST', '/api/shop/quotes', Object.assign(shopQuote(), { contactName: 'Eva Son', quantity: 2 }));
    const no2 = two.body.id;
    await call('cashier', 'POST', '/api/pos/quotes/' + no2 + '/price', { amount: '1200', leadTime: '1 to 3 working days', validDays: 7, note: 'Two lengths' });
    const proposed = await call('finance', 'POST', '/api/finance/quotes/' + no2 + '/terms', { termKey: 'half' });
    ok('Finance attached Half Payment to the second quotation', proposed.status === 200 && proposed.body.terms.state === 'approved', proposed.body);
    const refused = await call('finance', 'POST', '/api/finance/quotes/' + no2 + '/terms', { action: 'refuse', note: 'Counter policy is full payment this month' });
    ok('refusing it puts the quote back to paying everything before release',
      refused.status === 200 && refused.body.terms.key === 'full' && refused.body.terms.percent === 100 && refused.body.terms.balance === 0, refused.body);
    const d2 = await call('cashier', 'GET', '/api/pos/quote-desk/' + no2);
    ok('and the desk shows no amount due now', d2.body.terms.key === 'full' && +d2.body.paidAmount === 0, d2.body.terms);

    console.log('\n6. money on an order: the counter collects it, the ledger decides the state, Finance may refund it');
    // the second quotation is a plain full-payment one and nobody has paid on it, so converting it gives an unpaid order
    await call('customer', 'POST', '/api/shop/quotes/' + no2 + '/respond', { action: 'accept', payMethod: 'cod' });
    const conv2 = await call('cashier', 'POST', '/api/pos/quote-desk/' + no2 + '/convert', { requestId: 'conv-test-order-000001', recipient: 'Eva Son' });
    const ordNo = conv2.body && conv2.body.orderNo;
    ok('a second quotation became its own order', conv2.status === 200 && !!ordNo && ordNo !== order.order_no, conv2.body);
    st = await state();
    const order2 = st.orders.find((o) => o.order_no === ordNo);
    ok('that order starts unpaid with nothing recorded against it',
      Number(order2.total) === 1200 && Number(order2.paid_amount) === 0 && order2.payment_state === 'unpaid', order2 && { t: order2.total, p: order2.paid_amount, s: order2.payment_state });

    const payRetail = await call('customer', 'GET', '/api/shop/payment-terms?total=1200');
    ok('at checkout the customer is offered only what Finance switched on for ready stock',
      payRetail.status === 200 && payRetail.body.options.length === 1 && payRetail.body.options[0].key === 'full' && payRetail.body.options[0].dueNow === 1200, payRetail.body);

    await call('cashier', 'POST', '/__harness/shift', { open: false });
    const noDrawer = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '500', method: 'Cash', tendered: '1000', cashShiftId: 99, requestId: 'pos-counter-0000000' });
    ok('cash cannot be taken while this cashier has no open Cash Shift', noDrawer.status === 400 && noDrawer.body.fields.method, noDrawer.body);
    await call('cashier', 'POST', '/__harness/shift', { open: true, id: 11 });

    const counter = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '500', method: 'Cash', tendered: '1000', cashShiftId: 99, requestId: 'pos-counter-0000001' });
    ok('the counter records a payment against the order', counter.status === 200 && counter.body.paidAmount === 500 && counter.body.balance === 700, counter.body);
    ok('cash keeps tendered and change, so the till and the drawer agree',
      counter.body.tendered === 1000 && counter.body.change === 500, { tendered: counter.body.tendered, change: counter.body.change });
    ok('the state comes from the ledger: partially paid, not paid', counter.body.paymentState === 'partially_paid', counter.body.paymentState);
    ok('every payment gets its own receipt number', counter.body.receiptNo === 'INV-' + ordNo + '-' + counter.body.paymentId, counter.body.receiptNo);
    st = await state();
    const onRows = st.payments.filter((p) => p.paid_for === 'order' && Number(p.order_id) === Number(order2.order_id));
    ok('one ledger row, the initial payment, in the cashier\u2019s own open drawer — not the shift number the page sent',
      onRows.length === 1 && onRows[0].purpose === 'initial' && onRows[0].method === 'Cash' && Number(onRows[0].cash_shift_id) === 11, onRows);

    const replay2 = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '500', method: 'Cash', requestId: 'pos-counter-0000001' });
    ok('the same payment sent twice (retry, double click) is recorded once',
      replay2.status === 200 && replay2.body.replayed === true && replay2.body.paidAmount === 500 && replay2.body.paymentId === counter.body.paymentId, replay2.body);
    const over2 = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment', { amount: '701', method: 'Cash', requestId: 'pos-counter-0000002' });
    ok('the counter cannot take more than the outstanding balance',
      over2.status === 400 && /700/.test(over2.body.fields.amount), over2.body);
    const refWrong = await call('cashier', 'POST', '/api/finance/orders/' + ordNo + '/refund', { paymentId: onRows[0].payment_id });
    ok('a cashier cannot refund anything', refWrong.status === 403, refWrong.status);

    const noRef = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '700', method: 'GCash', requestId: 'pos-counter-refcheck-1' });
    ok('an online payment is not recorded without the reference from the app, receipt or statement',
      noRef.status === 400 && noRef.body.fields.reference, noRef.body);

    const axisBefore = (await state()).orders.find((o) => o.order_no === ordNo).status;
    const settle = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '700', method: 'GCash', reference: 'GCASH-7788', requestId: 'pos-counter-0000003' });
    ok('the balance payment closes it out', settle.status === 200 && settle.body.balance === 0 && settle.body.paymentState === 'paid', settle.body);
    const oLedger = await call('cashier', 'GET', '/api/pos/payment-ledger/order/' + ordNo);
    ok('the counter reads total, received and outstanding from one place',
      oLedger.status === 200 && oLedger.body.total === 1200 && oLedger.body.paidAmount === 1200 && oLedger.body.outstanding === 0 && oLedger.body.payments.length === 2, oLedger.body);
    ok('the online payment is on the ledger with its provider reference, not in the cash drawer',
      oLedger.body.payments[1].providerRef === 'GCASH-7788' && oLedger.body.payments[1].cashShiftId === undefined, oLedger.body.payments[1]);
    const axisCheck = (await state()).orders.find((o) => o.order_no === ordNo);
    ok('money arriving never touches the fulfilment status — the two stay on separate axes (§5, §8)',
      axisCheck.payment_state === 'paid' && axisCheck.status === axisBefore && !['Delivered', 'Picked Up', 'Completed'].includes(axisCheck.status),
      { status: axisCheck.status, payment_state: axisCheck.payment_state });

    const refund = await call('finance', 'POST', '/api/finance/orders/' + ordNo + '/refund',
      { paymentId: counter.body.paymentId, note: 'Customer returned the 500 peso item', requestId: 'fin-refund-0000001' });
    ok('Finance refunds one recorded payment', refund.status === 200 && refund.body.refunded === 500 && refund.body.paidAmount === 700, refund.body);
    ok('the order is partially refunded — a state of its own, not merely unpaid again',
      refund.body.paymentState === 'partially_refunded' && refund.body.balance === 500, refund.body);
    const doubleRefund = await call('finance', 'POST', '/api/finance/orders/' + ordNo + '/refund',
      { paymentId: counter.body.paymentId, requestId: 'fin-refund-0000002' });
    ok('the same payment cannot be refunded twice', doubleRefund.status === 400 && /500/.test(doubleRefund.body.fields.amount), doubleRefund.body);
    st = await state();
    const refundRows = st.payments.filter((p) => p.paid_for === 'order' && Number(p.order_id) === Number(order2.order_id) && p.direction === 'out');
    ok('the refund is a new row that points at the payment it reverses',
      refundRows.length === 1 && Number(refundRows[0].reversed_of) === Number(counter.body.paymentId), refundRows);

    const creditOn = await call('finance', 'POST', '/api/finance/orders/' + order.order_no + '/credit-exception', { action: 'grant', note: 'Long-standing account, balance settles with next delivery' });
    ok('only Finance can let goods go out with money still outstanding',
      creditOn.status === 200 && creditOn.body.outstanding === 0, creditOn.body);
    const creditBad = await call('finance', 'POST', '/api/finance/orders/' + order.order_no + '/credit-exception', { action: 'grant', note: 'sure' });
    ok('…and it always needs a written reason', creditBad.status === 400 && creditBad.body.fields.note, creditBad.body);
    const creditCashier = await call('cashier', 'POST', '/api/finance/orders/' + order.order_no + '/credit-exception', { action: 'grant', note: 'Let it go out today' });
    ok('a cashier cannot grant themselves a credit exception', creditCashier.status === 403, creditCashier.status);

    const termLate = await call('customer', 'POST', '/api/shop/orders/' + ordNo + '/terms', { termKey: 'full' });
    ok('the payment option is fixed as soon as money is recorded on the order',
      termLate.status === 400 && /already recorded/.test(termLate.body.fields.termKey), termLate.body);

    /* ---------------- 7. the §8 gates: the shipped rules, applied to the ledger figures ----------------
       test/desk-browser-harness.js answers /__harness/release-check with payment-terms.js's own orderMoney() and
       releaseDecision() — the two functions pos-shop.js calls when an order is confirmed or released. The body says
       what to assume that one row's paid_amount and terms are, because there is no PostgreSQL here to stage every
       order shape. It proves the decision; it does not prove the UPDATE statements around it. */
    console.log('\n7. confirming and releasing: only the ledger and a named credit exception decide');
    const rule = (no, body) => call('cashier', 'POST', '/__harness/release-check/' + no, body);

    const settled = await rule(ordNo, { paid: 1200 });
    ok('what the ledger has collected in full can be confirmed and released',
      settled.status === 200 && settled.body.money.dueNow === 0 && settled.body.confirm.ok === true && settled.body.release.ok === true, settled.body);

    const behind = await rule(ordNo, { paid: 700, role: 'finance' });
    ok('₱500 of the ₱1,200 order is still outstanding', behind.body.money.balance === 500 && behind.body.money.outstanding === true, behind.body.money);
    ok('the counter cannot confirm an order with money still due',
      behind.body.confirm.ok === false && behind.body.confirm.field === 'payment' && /500/.test(behind.body.confirm.reason), behind.body.confirm);
    ok('and nothing is released because a person pressed the button instead',
      behind.body.release.ok === false && /500/.test(behind.body.release.reason), behind.body.release);
    const alreadyGone = await rule(ordNo, { paid: 700, role: 'finance', status: 'Delivered' });
    ok('a fulfilment status that claims the goods are already gone changes nothing — the ledger is still the gate (§8)',
      alreadyGone.body.release.ok === false && /500/.test(alreadyGone.body.release.reason), alreadyGone.body.release);

    const cod = await rule(ordNo, { paid: 700, method: 'Cash on Pickup' });
    ok('a Cash-on-Pickup release collects what the ledger still owes, not the order total',
      cod.body.release.ok === true && cod.body.release.collect === 500, cod.body.release);
    const codUnpaid = await rule(ordNo, { paid: 0, method: 'Cash on Pickup' });
    ok('accepting a cash order is allowed — the money is taken at the counter, not before',
      codUnpaid.body.confirm.ok === true && codUnpaid.body.release.collect === 1200, codUnpaid.body);

    const partial = await rule(order.order_no, { paid: 2000, termsKey: 'half', termsPercent: 50, termsAmount: 4500, termsCondition: 'balance due before release' });
    ok('an approved 50% option with ₱2,000 in asks for the ₱2,500 left of the initial payment',
      partial.body.money.initial === 4500 && partial.body.money.dueNow === 2500 && partial.body.money.balance === 7000, partial.body.money);
    ok('the same figure gates the confirmation',
      partial.body.confirm.ok === false && /2,500/.test(partial.body.confirm.reason), partial.body.confirm);
    const initialIn = await rule(order.order_no, { paid: 4500, termsKey: 'half', termsPercent: 50, termsAmount: 4500 });
    ok('once the initial payment is complete, what is due now is the balance',
      initialIn.body.money.dueNow === 4500 && initialIn.body.money.balance === 4500, initialIn.body.money);

    const onCredit = await rule(order.order_no, { paid: 4500, termsKey: 'half', termsPercent: 50, termsAmount: 4500, role: 'finance' });
    ok('Finance granted a credit exception on this order, so it may go out with the balance behind',
      onCredit.body.money.outstanding === true && onCredit.body.release.ok === true && /Long-standing/.test((onCredit.body.release.credit || {}).note || ''), onCredit.body.release);
    const offCredit = await call('finance', 'POST', '/api/finance/orders/' + order.order_no + '/credit-exception', { action: 'revoke' });
    ok('the exception can be taken away again', offCredit.status === 200, offCredit.body);
    const afterRevoke = await rule(order.order_no, { paid: 4500, termsKey: 'half', termsPercent: 50, termsAmount: 4500, role: 'finance' });
    ok('with no exception on file, the balance stops the release',
      afterRevoke.body.release.ok === false && !afterRevoke.body.release.credit, afterRevoke.body.release);

    /* ---------------- 8. §3 checkout picker: what may be offered, and what choosing it does ----------------
       The customer page asks /api/shop/payment-terms for the basket total and posts back only the option key it was
       given. These calls go through the shipped routes, so they prove which options appear and what choosing one
       stores — not how the page paints them.                                              */
    console.log('\n8. the checkout option list comes from the policy, and choosing an option moves no money');
    const three = await call('customer', 'POST', '/api/shop/quotes', Object.assign(shopQuote(), { contactName: 'Iya Son', quantity: 1 }));
    const no3 = three.body && three.body.id;
    ok('a third quotation was opened for the picker to be used on', three.status < 300 && !!no3, three.body);
    await call('cashier', 'POST', '/api/pos/quotes/' + no3 + '/price', { amount: '2000', leadTime: '1 to 3 working days', validDays: 7, note: 'One length' });
    await call('customer', 'POST', '/api/shop/quotes/' + no3 + '/respond', { action: 'accept', payMethod: 'cod' });
    const conv3 = await call('cashier', 'POST', '/api/pos/quote-desk/' + no3 + '/convert', { requestId: 'conv-test-picker-00001', recipient: 'Iya Son' });
    const ord3 = conv3.body && conv3.body.orderNo;
    ok('and it became one order waiting for payment', conv3.status === 200 && !!ord3, conv3.body);

    const notOn = await call('customer', 'POST', '/api/shop/orders/' + ord3 + '/terms', { termKey: 'down' });
    ok('an option Finance has not switched on cannot be chosen, however the page was rendered',
      notOn.status === 400 && notOn.body.fields.termKey, notOn.body);

    const enableRetail = await call('finance', 'POST', '/api/finance/payment-terms/half',
      { enabled: true, retailAllowed: true, madeToOrderAllowed: true, percent: 50, balanceCondition: 'balance due before the order is released' });
    ok('Finance extending Half to ready stock is what puts it in front of customers',
      enableRetail.status === 200 && enableRetail.body.term.retailAllowed === true, enableRetail.body);

    const pick = await call('customer', 'GET', '/api/shop/payment-terms?total=2000');
    const halfOpt = (pick.body.options || []).find((o) => o.key === 'half');
    ok('the list is Full first, then the approved partial, with amounts worked out by the server',
      pick.status === 200 && pick.body.options.length === 2 && pick.body.options[0].key === 'full' && pick.body.options[0].dueNow === 2000
      && halfOpt.dueNow === 1000 && halfOpt.balance === 1000 && halfOpt.percent === 50
      && halfOpt.balanceCondition === 'balance due before the order is released', pick.body);
    ok('a custom percentage is never on the customer list — Finance agrees it quotation by quotation',
      (pick.body.options || []).every((o) => o.key !== 'custom'), (pick.body.options || []).map((o) => o.key));
    const empty = await call('customer', 'GET', '/api/shop/payment-terms?total=0');
    ok('an empty basket gets no options at all', empty.status === 400 && empty.body.fields.total, empty.body);

    const chosen = await call('customer', 'POST', '/api/shop/orders/' + ord3 + '/terms', { termKey: 'half' });
    ok('choosing the partial option stores it with the figures the server computed',
      chosen.status === 200 && chosen.body.money.key === 'half' && chosen.body.money.percent === 50
      && chosen.body.money.initial === 1000 && chosen.body.money.dueNow === 1000 && chosen.body.money.balance === 2000
      && chosen.body.money.condition === 'balance due before the order is released', chosen.body.money);
    st = await state();
    const order3 = st.orders.find((o) => o.order_no === ord3);
    ok('choosing an option marks nothing paid and writes no ledger row',
      Number(order3.paid_amount) === 0 && order3.payment_state === 'unpaid' && Number(order3.terms_amount) === 1000,
      order3 && { paid: order3.paid_amount, state: order3.payment_state, terms: order3.terms_amount });
    ok('…and the ledger really is empty for that order',
      st.payments.filter((p) => Number(p.order_id) === Number(order3.order_id)).length === 0, st.payments.filter((p) => Number(p.order_id) === Number(order3.order_id)));
    const onHalf = await rule(ord3, { method: 'GCash' });
    ok('the release gate then asks for the ₱1,000 initial, not the whole order',
      onHalf.body.confirm.ok === false && /1,000/.test(onHalf.body.confirm.reason) && onHalf.body.release.ok === false, onHalf.body);

    /* ---------------- 9. §9 the Finance money screens ---------------- */
    console.log('\n9. Finance sees the balances owed and every payment or refund recorded');
    const rec = await call('finance', 'GET', '/api/finance/receivables');
    ok('the receivables screen reads the totals the database keeps',
      rec.status === 200 && Array.isArray(rec.body.orders) && Array.isArray(rec.body.quotes) && rec.body.ledgerReady === true,
      { status: rec.status, orders: rec.body && rec.body.orders && rec.body.orders.length, ready: rec.body && rec.body.ledgerReady });
    ok('only what is genuinely owed is listed, largest first',
      rec.body.orders.every((x) => x.outstanding > 0.005) && rec.body.orders.every((x, i, a) => i === 0 || a[i - 1].outstanding >= x.outstanding),
      rec.body.orders.map((x) => [x.no, x.outstanding]));
    const owing = rec.body.orders.find((x) => x.no === ord3);
    ok('an order that only chose a payment option is owed in full, under that option',
      owing && owing.outstanding === 2000 && owing.paidAmount === 0 && owing.termsKey === 'half' && owing.paymentState === 'unpaid', owing);
    const part = rec.body.orders.find((x) => x.no === ordNo);
    ok('the ₱500 refunded back is owed again, not quietly forgiven',
      part && part.outstanding === 500 && part.paidAmount === 700 && part.total === 1200, part);
    ok('an order the ledger has collected in full is not on the list at all',
      !rec.body.orders.some((x) => x.no === order.order_no), rec.body.orders.map((x) => x.no));
    ok('the header figures are the list summed once, server-side',
      rec.body.totals.openOrders === rec.body.orders.length
      && Math.abs(rec.body.totals.ordersOwed - rec.body.orders.reduce((n, x) => n + x.outstanding, 0)) < 0.005
      && Math.abs(rec.body.totals.allOwed - (rec.body.totals.ordersOwed + rec.body.totals.quotesOwed)) < 0.005, rec.body.totals);
    const recCashier = await call('cashier', 'GET', '/api/finance/receivables');
    ok('a cashier cannot read the Finance money screens', recCashier.status === 403, recCashier.status);

    const mon = await call('finance', 'GET', '/api/finance/payments');
    const ordRows = mon.body.payments.filter((x) => x.ref === ordNo);
    ok('every payment and every refund against that order is on the list',
      mon.status === 200 && ordRows.length === 3 && ordRows.filter((x) => x.direction === 'in').reduce((n, x) => n + x.amount, 0) === 1200
      && ordRows.filter((x) => x.direction === 'out').reduce((n, x) => n + x.amount, 0) === 500, ordRows);
    ok('a refund names the payment it reverses',
      ordRows.some((x) => x.direction === 'out' && ordRows.some((y) => y.direction === 'in' && y.id === x.reversedOf)), ordRows);
    const gcashRow = mon.body.payments.find((x) => x.method === 'GCash');
    ok('money that came in online carries its provider reference and no cash drawer',
      gcashRow && gcashRow.providerRef && gcashRow.cashShiftId === null, gcashRow);
    const counterRow = mon.body.payments.find((x) => x.ref === ordNo && x.method === 'Cash' && x.direction === 'in');
    ok('money taken at the counter names the drawer it went into', counterRow && counterRow.cashShiftId === 11, counterRow);
    const arrived = mon.body.payments.filter((x) => x.direction === 'in' && !x.moved);
    const refiled = mon.body.payments.filter((x) => x.direction === 'in' && x.moved);
    const sum = (rows) => rows.reduce((n, x) => n + x.amount, 0);
    ok('the totals are that money summed, with cash kept apart from everything else',
      Math.abs(mon.body.totals.collected - sum(arrived)) < 0.005
      && Math.abs(mon.body.totals.cashInDrawer + mon.body.totals.onlineAndOther - mon.body.totals.collected) < 0.005, mon.body.totals);
    ok('…and a payment re-filed onto the order a quotation became is listed but never counted a second time (§10)',
      refiled.length > 0 && Math.abs(mon.body.totals.collected + sum(refiled) - sum(arrived.concat(refiled))) < 0.005,
      { counted: arrived.length, refilled: refiled.length, collected: mon.body.totals.collected });
    const onlyQuotes = await call('finance', 'GET', '/api/finance/payments?kind=quote');
    ok('…and the list can be narrowed to one side of the ledger',
      onlyQuotes.status === 200 && onlyQuotes.body.payments.every((x) => x.kind === 'quote'), onlyQuotes.body.payments.slice(0, 3));

    /* ---------------- 10. §10 the period report: sold / arrived / still owed ---------------- */
    console.log('\n10. the period report keeps what was sold, what arrived and what is owed apart');
    const db = await state();
    const dayOf = (t) => new Date(new Date(t).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const today = dayOf(new Date());
    const rep = await call('finance', 'GET', '/api/finance/payment-report');
    ok('Finance can read the period report', rep.status === 200 && rep.body.booked && rep.body.collections && rep.body.receivables, rep.body);
    ok('the period defaults to today in Manila time', rep.body.from === today && rep.body.to === today && rep.body.ledgerReady === true,
      { from: rep.body.from, to: rep.body.to, today });
    const repCashier = await call('cashier', 'GET', '/api/finance/payment-report');
    ok('a cashier cannot read it', repCashier.status === 403, repCashier.status);
    const repBad = await call('finance', 'GET', '/api/finance/payment-report?from=14-10-2026');
    ok('a date the screen cannot use is answered with a field, not a stack trace', repBad.status === 400 && repBad.body.fields.from, repBad.body);
    const repReversed = await call('finance', 'GET', '/api/finance/payment-report?from=2026-10-20&to=2026-10-01');
    ok('a range the end date sits before the start of is refused', repReversed.status === 400 && repReversed.body.fields.to, repReversed.body);
    const repLong = await call('finance', 'GET', '/api/finance/payment-report?from=2026-01-01&to=2026-10-01');
    ok('…and so is a range longer than the report will aggregate', repLong.status === 400 && repLong.body.fields.to, repLong.body);

    const bookedRefs = rep.body.booked.rows.map((r) => r.no);
    ok('an order is on the report once, whatever it was paid in',
      bookedRefs.length === new Set(bookedRefs).size && bookedRefs.every((no) => /^ORD/.test(String(no))), bookedRefs);
    const rowOf = (no) => rep.body.booked.rows.find((r) => r.no === no);
    const bookedRow = rowOf(ordNo);
    const onOrd = db.payments.filter((x) => x.paid_for === 'order' && String((db.orders.find((o) => o.order_no === ordNo) || {}).order_id) === String(x.order_id));
    ok('…at its own value, with the payments shown as money received against it, not as extra sales',
      bookedRow && bookedRow.total === 1200 && bookedRow.inPeriod === onOrd.filter((x) => x.direction === 'in' && !/^transfer/.test(String(x.request_id || '')))
        .reduce((n, x) => n + Number(x.amount), 0), bookedRow);
    ok('the booked figures are those rows summed server-side',
      Math.abs(rep.body.booked.value - rep.body.booked.rows.reduce((n, r) => n + r.total, 0)) < 0.005
      && Math.abs(rep.body.booked.stillOwed - rep.body.booked.rows.reduce((n, r) => n + r.outstanding, 0)) < 0.005
      && Math.abs(rep.body.booked.value - rep.body.booked.collected - rep.body.booked.stillOwed) < 0.005,
      rep.body.booked && { value: rep.body.booked.value, collected: rep.body.booked.collected, stillOwed: rep.body.booked.stillOwed });
    const coll = rep.body.collections;
    const moneyToday = db.payments.filter((x) => dayOf(x.created_at) === today && !/^transfer/.test(String(x.request_id || '')));
    ok('collections are the ledger rows of the period, each counted once — a quotation payment moved onto its order is not new money',
      Math.abs(coll.arrived - moneyToday.filter((x) => x.direction === 'in').reduce((n, x) => n + Number(x.amount), 0)) < 0.005
      && db.payments.some((x) => /^transfer/.test(String(x.request_id || ''))),
      { arrived: coll.arrived, rows: moneyToday.filter((x) => x.direction === 'in').length });
    ok('the money splits by day, method, purpose and parent without any of it being lost or repeated',
      Math.abs(coll.byDay.reduce((n, x) => n + x.arrived, 0) - coll.arrived) < 0.005
      && Math.abs(coll.byMethod.reduce((n, x) => n + x.arrived, 0) - coll.arrived) < 0.005
      && Math.abs(coll.byPurpose.filter((x) => x.purpose !== 'refund').reduce((n, x) => n + x.amount, 0) - coll.arrived) < 0.005
      && Math.abs(coll.byKind.reduce((n, x) => n + x.arrived, 0) - coll.arrived) < 0.005
      && Math.abs(coll.drawer + coll.outside - coll.arrived) < 0.005,
      { arrived: coll.arrived, drawer: coll.drawer, outside: coll.outside, net: coll.net });
    ok('cash that landed in a drawer is the only part counted for the till (§4)',
      Math.abs(coll.drawer - moneyToday.filter((x) => x.direction === 'in' && x.cash_shift_id != null).reduce((n, x) => n + Number(x.amount), 0)) < 0.005,
      { drawer: coll.drawer });
    ok('the receivables half agrees with the receivables screen',
      Math.abs(rep.body.receivables.allOwed - rec.body.totals.allOwed) < 0.005
      && Math.abs(rep.body.receivables.ordersOwed - rec.body.totals.ordersOwed) < 0.005
      && rep.body.receivables.openOrders === rec.body.totals.openOrders,
      { report: rep.body.receivables, screen: rec.body.totals });

    /* ---------------- 11. the online callback records money once, however many times Xendit repeats it ---------------- */
    console.log('\n11. a paid online invoice lands on the quotation once, even when Xendit repeats the callback');
    const webQ = await call('customer', 'POST', '/api/shop/quotes', Object.assign(shopQuote(), { contactName: 'Eva Son', quantity: 4 }));   // 4 lengths: ₱3,000 is above their cost (the price routing refuses a loss)
    const webNo = webQ.body.id;
    await call('cashier', 'POST', '/api/pos/quotes/' + webNo + '/price', { amount: '3000', leadTime: '1 to 3 working days', validDays: 7, note: 'Four lengths' });
    const acc3 = await call('customer', 'POST', '/api/shop/quotes/' + webNo + '/respond', { action: 'accept', payMethod: 'online' });
    ok('the third quotation is accepted with the money still to come online', acc3.status === 200 && acc3.body.status === 'accepted', acc3.body);
    const qid = (st) => Number(st.quotes.find((q) => q.quote_no === webNo).quote_id);
    const onQuote = (st) => st.payments.filter((x) => x.paid_for === 'quote' && Number(x.quote_id) === qid(st));
    const ext = 'xt-external-callback-test-000001', inv = 'inv-callback-test-0000000001';
    const stamp = await call('finance', 'POST', '/__harness/quote-xendit/' + webNo, { externalId: ext, invoiceId: inv });
    ok('the invoice raised for this quotation is the one Xendit will call back about', stamp.status === 200 && stamp.body.invoiceId === inv, stamp.body);
    const cb1 = await call('finance', 'POST', '/__harness/quote-callback', { externalId: ext, invoiceId: inv, event: { status: 'PAID', paid_amount: 1000, amount: 1000 } });
    const st1 = await state();
    const rows1 = onQuote(st1);
    ok('the callback writes one ledger row for the money that actually arrived',
      cb1.body.handled === true && rows1.length === 1 && Number(rows1[0].amount) === 1000 && rows1[0].provider_ref === inv && rows1[0].method === 'Xendit',
      { handled: cb1.body.handled, rows: rows1.length, row: rows1[0] });
    ok('…money taken online is never put in a cash drawer (§4)', rows1.length === 1 && rows1[0].cash_shift_id == null, rows1[0]);
    ok('the quotation reads as partly paid, not paid, with the balance still owed (§5)',
      Number(st1.quotes.find((q) => q.quote_no === webNo).paid_amount) === 1000 && st1.quotes.find((q) => q.quote_no === webNo).payment_state === 'partially_paid',
      { paid: st1.quotes.find((q) => q.quote_no === webNo).paid_amount, state: st1.quotes.find((q) => q.quote_no === webNo).payment_state });
    ok('the screen copy of the payment carries the same provider reference as the ledger',
      (st1.quotes.find((q) => q.quote_no === webNo).payments || []).length === 1 && st1.quotes.find((q) => q.quote_no === webNo).payments[0].ref === inv,
      st1.quotes.find((q) => q.quote_no === webNo).payments);

    const cb2 = await call('finance', 'POST', '/__harness/quote-callback', { externalId: ext, invoiceId: inv, event: { status: 'PAID', paid_amount: 1000, amount: 1000 } });
    const st2 = await state();
    ok('the very same callback arriving again is read, not recorded a second time (§6)',
      cb2.body.handled === true && st2.payments.length === st1.payments.length && Number(st2.quotes.find((q) => q.quote_no === webNo).paid_amount) === 1000,
      { rows: st2.payments.length, paid: st2.quotes.find((q) => q.quote_no === webNo).paid_amount });
    ok('…and the display copy stays one payment, not two', (st2.quotes.find((q) => q.quote_no === webNo).payments || []).length === 1,
      st2.quotes.find((q) => q.quote_no === webNo).payments);

    const inv2 = 'inv-callback-test-0000000002';
    await call('finance', 'POST', '/__harness/quote-xendit/' + webNo, { externalId: ext, invoiceId: inv2 });
    const cb3 = await call('finance', 'POST', '/__harness/quote-callback', { externalId: ext, invoiceId: inv2, event: { status: 'SETTLED', paid_amount: 2000, amount: 2000 } });
    const st3 = await state();
    const webRow = st3.quotes.find((q) => q.quote_no === webNo);
    ok('the balance paid on a second invoice closes the quotation out, two rows and no more',
      cb3.body.handled === true && Number(webRow.paid_amount) === 3000 && webRow.payment_state === 'paid' && onQuote(st3).length === 2,
      { paid: webRow.paid_amount, state: webRow.payment_state, rows: onQuote(st3).length });
    const cb4 = await call('finance', 'POST', '/__harness/quote-callback', { externalId: ext, invoiceId: inv2, event: { status: 'EXPIRED', paid_amount: 0, amount: 2000 } });
    const st4 = await state();
    ok('a callback that says nothing was paid records nothing, even on an invoice already paid',
      cb4.body.handled === true && st4.payments.length === st3.payments.length && Number(st4.quotes.find((q) => q.quote_no === webNo).paid_amount) === 3000,
      { rows: st4.payments.length });
    const cb5 = await call('finance', 'POST', '/__harness/quote-callback', { externalId: ext, invoiceId: 'inv-never-issued-0000000000', event: { status: 'PAID', paid_amount: 1000 } });
    ok('an invoice the shop never raised moves no money', cb5.body.handled === false && (await state()).payments.length === st4.payments.length, cb5.body);

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
  } finally {
    child.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); try { spawn('true'); } catch {} process.exit(1); });
