/* End-to-end quotation chains, run over real HTTP against test/desk-browser-harness.js.
   The harness mounts the real quote-desk.js and shop-extras.js route code, so these assertions cover the
   shipped handlers, not a re-implementation. It uses the in-memory SQL double, so it proves route logic and
   state transitions; real PostgreSQL behaviour is verified by test/quote-desk.test.js and migration 019.

   node test/quote-chain.test.js */
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = Number(process.env.HARNESS_PORT || 8899);
let port = PORT;
const BASE = () => 'http://127.0.0.1:' + port;
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  →  ' + JSON.stringify(detail) : '')); }
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

/* one global session lives in the harness, so the role is switched before every step */
async function call(role, method, p, body) {
  const s = await fetch(BASE() + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  if (!s.ok) throw new Error('session switch failed');
  const r = await fetch(BASE() + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const state = () => call('cashier', 'GET', '/__harness/state').then((r) => r.body);
const walkIn = () => ({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', sku: 'ANG-0203', quantity: 4, quantityUnit: 'pcs',
  fulfillment: 'Pickup', flexibleDate: true,
  specs: { material: 'Aluminum ADC12', size: '2"', thickness: '3.0 mm', finish: 'Raw / Unfinished', service: 'None (as is)' }, });
// the harness system price of 4 x ANG-0203 is 4 x 710 = 2,840 (cost 80% = 2,272): the counter prices at it unless a test says otherwise
const SYSTEM = '2840.00';

async function main() {
  const child = await start(PORT);
  try {
    console.log('\n1. walk-in quotation at the counter: created unpriced, approved by Finance, handed over once');
    const before = await state();
    const created = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const no = created.body && created.body.id;
    ok('the counter saved the request', created.status === 201 && !!no, created);
    ok('it is not priced yet', created.body.status === 'new' && created.body.quotedAmount == null, created.body);
    ok('nothing was paid', +created.body.paidAmount === 0, created.body);
    ok('no order or POS sale appeared', before.orders.length === 0 && before.sales.length === 0, before);

    const price = (amount, extra) => Object.assign({ amount, leadTime: '1 to 3 working days', validDays: 7, note: 'Counter price' }, extra);
    const opts = await call('cashier', 'GET', '/api/pos/quote-options');
    ok('the cashier screen is told Finance\'s approval rules (band, minimum margin, value limit)', opts.status === 200 && opts.body.approvalRules && opts.body.approvalRules.tolerancePct === 5 && opts.body.approvalRules.valueLimit === 0, opts.body && opts.body.approvalRules);
    const asked = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/price', price(SYSTEM));
    ok('with no value limit the price goes to Finance, and the cashier is never asked for a reason', asked.status === 200 && asked.body.status === 'pending_approval', asked);
    ok('…and the system writes the reason itself', /no cashier order-value limit/i.test(asked.body.quote.approvalReason || '') && asked.body.decision.rules.join() === 'over_limit', asked.body.quote);

    const approved = await call('finance', 'POST', '/api/finance/quotes/' + no + '/approve-price', {});
    ok('Finance approval turns it into a quotation', approved.status === 200 && approved.body.quote.status === 'quoted' && +approved.body.quote.quotedAmount === 2840, approved.body);
    const reApprove = await call('finance', 'POST', '/api/finance/quotes/' + no + '/approve-price', {});
    ok('the same proposal cannot be approved twice', reApprove.status === 400, reApprove);
    const notOwner = await call('customer', 'POST', '/api/shop/quotes/' + no + '/respond', { action: 'accept', payMethod: 'cod' });
    ok('a signed-in customer cannot answer a walk-in quotation', notOwner.status === 400, notOwner);

    const accepted = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/respond', { action: 'accept' });
    ok('the counter can record the walk-in acceptance', accepted.status === 200 && accepted.body.status === 'accepted', accepted.body);
    const twice = await call('cashier', 'POST', '/api/pos/quotes/' + no + '/respond', { action: 'accept' });
    ok('a second acceptance is refused', twice.status === 400, twice);

    const handed = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'walkin-handover-0000000001' });
    ok('the accepted walk-in quote is handed to the POS terminal', handed.status === 200 && handed.body.kind === 'pos' && handed.body.qty === 4, handed.body);
    const again = await call('cashier', 'POST', '/api/pos/quote-desk/' + no + '/convert', { requestId: 'walkin-handover-0000000002' });
    ok('the same quote cannot be handed over twice', again.status === 400, again);
    const afterWalkIn = await state();
    ok('a quotation is not a reservation: no order, no sale, stock untouched',
      afterWalkIn.orders.length === 0 && afterWalkIn.sales.length === 0 &&
      JSON.stringify(afterWalkIn.stock) === JSON.stringify(before.stock), afterWalkIn);

    console.log('\n2. online quotation: owner accepts, the desk converts it into exactly one unpaid order');
    const list = await call('customer', 'GET', '/api/shop/quotes');
    const quoted = list.body.find((q) => q.status === 'quoted');
    ok('the customer sees the priced quote with the approved amount', !!quoted && quoted.quotedAmount > 0, list.body);
    const isoOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const dow = (v) => new Date(v + 'T00:00:00Z').getUTCDay();
    ok('a priced quote carries an estimated ready date, "if accepted today"', isoOk(quoted.estimatedReady) && !quoted.readyFromAcceptance, quoted);
    ok('the estimated ready date is after today and never a weekend', quoted.estimatedReady > new Date().toISOString().slice(0, 10) && dow(quoted.estimatedReady) !== 0 && dow(quoted.estimatedReady) !== 6, quoted.estimatedReady);
    const noMethod = await call('customer', 'POST', '/api/shop/quotes/' + quoted.id + '/respond', { action: 'accept' });
    ok('accepting without choosing how to pay is refused', noMethod.status === 400 && noMethod.body.fields.payMethod, noMethod);
    const cod = await call('customer', 'POST', '/api/shop/quotes/' + quoted.id + '/respond', { action: 'accept', payMethod: 'cod' });
    ok('a required initial payment cannot be deferred to COD', cod.status === 400 && cod.body.fields.payMethod, cod);
    const yes = await call('customer', 'POST', '/api/shop/quotes/' + quoted.id + '/respond', { action: 'accept', payMethod: 'online' });
    ok('the owner accepted it', yes.status === 200 && yes.body.status === 'accepted', yes.body);
    const back = await call('customer', 'GET', '/api/shop/quotes');
    const card = back.body.find((q) => q.id === quoted.id);
    ok('the chosen online payment method is recorded', card.payMethod === 'Xendit', card);
    ok('acceptance never marks the quote paid', +card.paidAmount === 0, card);
    ok('after acceptance the date is counted from the acceptance day', isoOk(card.estimatedReady) && card.readyFromAcceptance === true, card);
    ok('acceptance never creates an order', card.orderNo == null && (await state()).orders.length === 0, card);

    const first = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000001' });
    ok('conversion creates an order', first.status === 200 && first.body.kind === 'order' && !!first.body.orderNo, first.body);
    const replay = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000001' });
    ok('the same requestId replays the same order instead of making another', replay.status === 200 && replay.body.duplicate === true && replay.body.orderNo === first.body.orderNo, replay.body);
    const freshId = await call('cashier', 'POST', '/api/pos/quote-desk/' + quoted.id + '/convert', { requestId: 'online-convert-000000000002' });
    ok('a fresh requestId on a converted quote is still refused', freshId.status === 400 || (freshId.body && freshId.body.duplicate === true), freshId);
    const desk = await call('cashier', 'GET', '/api/pos/quote-desk/' + quoted.id);
    ok('the desk shows the preserved price and its order reference',
      desk.status === 200 && desk.body.amount === quoted.quotedAmount && desk.body.orderNo === first.body.orderNo, desk.body);
    const afterOnline = await state();
    ok('exactly one order exists and it is unpaid', afterOnline.orders.length === 1 && afterOnline.orders[0].payment_status === 'unpaid' && afterOnline.orders[0].status === 'Pending Confirmation', afterOnline.orders);
    ok('the order total is the approved quotation amount', +afterOnline.orders[0].total === quoted.quotedAmount, afterOnline.orders[0]);
    ok('stock was only checked, never deducted', JSON.stringify(afterOnline.stock) === JSON.stringify(afterWalkIn.stock), afterOnline.stock);
    ok('no POS sale was created by an online conversion', afterOnline.sales.length === 0, afterOnline.sales);
  } finally {
    child.kill();
  }

  console.log('\n3. the cashier pricing ceiling comes from CASHIER_QUOTE_LIMIT_PHP, not from a hardcoded number');
  const second = await start(PORT + 1, { CASHIER_QUOTE_LIMIT_PHP: '50000' });
  try {
    const a = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const routine = await call('cashier', 'POST', '/api/pos/quotes/' + a.body.id + '/price',
      { amount: '2750.00', leadTime: '1 to 3 working days', validDays: 7, note: 'Routine counter price' });
    ok('inside the band, above cost, under the ceiling and in stock: quoted straight away', routine.status === 200 && routine.body.status === 'quoted' && !routine.body.decision.rules.length, routine);
    const b = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const over = await call('cashier', 'POST', '/api/pos/quotes/' + b.body.id + '/price',
      { amount: '60000.00', leadTime: '1 to 3 working days', validDays: 7, note: 'Big order' });
    ok('above the same ceiling it goes to Finance instead, with no reason asked of the cashier', over.status === 200 && over.body.status === 'pending_approval', over);
    ok('…and the automatic reason names the ceiling', /50,000/.test(over.body.quote.approvalReason || '') && over.body.decision.rules.includes('over_limit'), over.body.quote);
    const fq = await call('finance', 'GET', '/api/finance/quotes');
    const mine = (fq.body || []).find((x) => x.id === b.body.id);
    ok('Finance sees who sent the price, the lead time and the validity', mine && mine.proposedBy && mine.proposedLeadTime && mine.proposedValidDays === 7 && fq.body[0].status === 'pending_approval', mine);
    const thin = await call('finance', 'POST', '/api/finance/quotes/' + b.body.id + '/return-price', { note: 'no' });
    ok('sending a price back needs a real note', thin.status === 400 && thin.body.fields.note, thin.body);
    const back = await call('finance', 'POST', '/api/finance/quotes/' + b.body.id + '/return-price', { note: 'Too high, use the 2026 brass price list' });
    ok('Finance can send the price back to the cashier', back.status === 200 && back.body.quote.status === 'new' && /brass price list/.test(back.body.quote.financeNote || ''), back.body);
    const desk = await call('cashier', 'GET', '/api/pos/quote-desk/' + b.body.id);
    ok('…and the cashier desk shows Finance\'s note', desk.status === 200 && /brass price list/.test(JSON.stringify(desk.body)), desk.body && desk.body.financeNote);
    const again = await call('finance', 'POST', '/api/finance/quotes/' + b.body.id + '/return-price', { note: 'Too high, use the 2026 brass price list' });
    ok('a price that is not waiting cannot be sent back twice', again.status === 400, again.body);
    const c = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const flagged = await call('cashier', 'POST', '/api/pos/quotes/' + c.body.id + '/price',
      { amount: SYSTEM, leadTime: '1 to 3 working days', validDays: 7, note: 'Custom', customManufacturing: true, reason: 'Custom die, costing needs Finance' });
    ok('the cashier cannot choose the route: an old "needs Finance" tick is ignored, the rules decide', flagged.status === 200 && flagged.body.status === 'quoted', flagged.body);
    const d = await call('cashier', 'POST', '/api/pos/quotes', walkIn());
    const loss = await call('cashier', 'POST', '/api/pos/quotes/' + d.body.id + '/price', { amount: '2000.00', leadTime: '1 to 3 working days', validDays: 7, note: 'Discount' });
    ok('below cost always goes to Finance, with the loss in plain words', loss.status === 200 && loss.body.status === 'pending_approval' && /below the cost of .2,272\.00/.test(loss.body.quote.approvalReason || ''), loss.body.quote);
    const log = (await call('finance', 'GET', '/__harness/decisions')).body;
    ok('every decision is logged with its rule', log.some((x) => x.quote === a.body.id && x.action === 'auto_quoted') && log.some((x) => x.quote === d.body.id && x.action === 'sent_to_finance' && x.rules.includes('below_cost'))
      && log.some((x) => x.quote === b.body.id && x.action === 'returned'), log);
    const e = await call('customer', 'POST', '/api/shop/quotes', Object.assign(walkIn(), { contactName: 'Ana Cruz', flexibleDate: false, neededBy: new Date(Date.now() + 9 * 864e5).toISOString().slice(0, 10) }));
    await call('cashier', 'POST', '/api/pos/quotes/' + e.body.id + '/price', { amount: SYSTEM, leadTime: '1 to 3 working days', validDays: 7, note: 'Online' });
    const mineList = (await call('customer', 'GET', '/api/shop/quotes')).body || [];
    const card = mineList.find((x) => x.id === e.body.id);
    ok('the customer sees the price but never the cost, the system price or the routing check', card && card.quotedAmount === 2840 && card.suggestedCost === undefined && card.approvalCheck === undefined && card.suggestedAmount === undefined, card || e.body);
  } finally {
    second.kill();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
