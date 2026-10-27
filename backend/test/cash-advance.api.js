/* cash-advance.api.js — DEV ONLY walk-through of Cash on Delivery / Cash on Pickup against a running server and its PostgreSQL.
   COD: the delivery fee + a deposit (order_rules.cod_deposit, default 200) are paid online first (Xendit); the rider collects the rest in cash.
   COP: a reservation deposit (order_rules.cop_deposit, default 200) is paid online first and taken off the total; the rest is cash at
   the counter. Not picked up within order_rules.cop_hold_hours (default 48) of Ready for Pickup: cancelled, restocked, deposit kept.
   Needs: the server on :8099 with XENDIT_SECRET_KEY set (any value; the gateway itself is simulated through the webhook),
   XENDIT_CALLBACK_TOKEN=testtoken, AUTOMATION_CRON_KEY=cronkey, psql on PATH, and the demo users (carlo / cara / fin).
   Run:  node test/cash-advance.api.js */
// API walk-through of the new cash rules against the dev server (port 8099, XENDIT key set to a fake value, callback token "testtoken")
const { execSync } = require('child_process');
const B = 'http://localhost:8099';
const sql = (q) => execSync(`psql -At postgres://triplee:x@localhost:5432/triplee -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
async function session(email) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'StrongP@ss1' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Sign-in answered ' + r.status + '. Start this DEV server with LOGIN_OTP=off: the walk-through cannot type a one-time code.');
  return async (method, path, body, extra) => { const x = await fetch(B + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', cookie }, extra || {}), body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) }; };
}
const rid = () => 'test-' + Math.random().toString(36).slice(2, 14) + Date.now();
let pass = 0, fail = 0; const ok = (l, c, d) => { if (c) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l + '  ->  ' + String(JSON.stringify(d)).slice(0, 400)); } };
const webhook = async (no, amount) => {
  const inv = 'inv_' + no + '_' + Date.now(), ext = 'triplee-' + no + '-x-' + Date.now();
  sql(`UPDATE orders SET xendit_invoice_id='${inv}', xendit_external_id='${ext}', payment_status='pending' WHERE order_no='${no}'`);
  const r = await fetch(B + '/api/payments/xendit/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-callback-token': 'testtoken' }, body: JSON.stringify({ id: inv, external_id: ext, status: 'PAID', paid_amount: amount, amount }) });
  return r.status;
};
const automation = () => fetch(B + '/api/automation/run', { method: 'POST', headers: { 'x-cron-key': 'cronkey' } }).then(r => r.json());
(async () => {
  const cu = await session('carlo@example.com'), ca = await session('cara@example.com'), fi = await session('fin@example.com');
  sql(`DELETE FROM order_failures WHERE customer_id = 4`);                       // a clean slate for the no-show block
  const rules = await fi('GET', '/api/finance/order-rules');
  console.log('\nRules:', JSON.stringify(rules.body));
  ok('defaults: ₱200 pickup down payment, 48-hour hold, ₱200 COD down payment', rules.body.copDeposit === 200 && rules.body.copHoldHours === 48 && rules.body.codDeposit === 200, rules.body);

  // the price of 20 elbows comes from the product (finished goods are priced unit cost + markup, so it is read, not assumed)
  const SUB = Math.round(Number(sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`)) * 20 * 100) / 100, BAL = Math.round((SUB - 200) * 100) / 100;
  const ph = (n) => n.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  console.log('\n1. Cash on Pickup: ₱200 down payment online, the rest in cash at the counter (20 pcs = ₱' + ph(SUB) + ')');
  let r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Pickup', method: 'Cash on Pickup', phone: '09171234567', items: [{ sku: 'FG-FB02', qty: 20 }] });
  ok('order placed', r.status === 201, r.body);
  const cop = r.body;
  ok('it asks for a ₱200 down payment now, the rest (₱' + ph(BAL) + ') in cash later', cop.advance && cop.advance.kind === 'deposit' && cop.advance.amount === 200 && cop.dueNow === 200 && cop.advance.cash === BAL, cop);
  r = await ca('POST', '/api/orders/' + cop.id + '/confirm', {});
  ok('the counter cannot confirm it before the down payment is paid', r.status === 400 && /down payment has not been paid/.test(JSON.stringify(r.body)), r.body);
  ok('a wrong amount from the gateway is not accepted', (await webhook(cop.id, SUB)) >= 400 || sql(`SELECT paid_amount FROM orders WHERE order_no='${cop.id}'`) === '0.00');
  ok('the ₱200 paid online is recorded', (await webhook(cop.id, 200)) === 200 && sql(`SELECT paid_amount FROM orders WHERE order_no='${cop.id}'`) === '200.00');
  ok('…and the order confirms itself', sql(`SELECT status FROM orders WHERE order_no='${cop.id}'`) === 'Paid');
  r = await cu('POST', '/api/shop/orders/' + cop.id + '/xendit-checkout', {});
  ok('the rest cannot be paid through the down payment link', r.status === 400 && /already paid/.test(r.body.error || ''), r.body);
  for (const st of ['Packed', 'Ready for Pickup']) await ca('POST', '/api/orders/' + cop.id + '/status', { status: st });
  ok('ready for pickup', sql(`SELECT status FROM orders WHERE order_no='${cop.id}'`) === 'Ready for Pickup');
  sql(`UPDATE orders SET status_updated_at = now() - interval '49 hours' WHERE order_no='${cop.id}'`);
  const a1 = await automation();
  ok('not picked up within 48 hours: cancelled automatically', sql(`SELECT status FROM orders WHERE order_no='${cop.id}'`) === 'Cancelled', a1);
  ok('…the ₱200 down payment is kept', sql(`SELECT forfeited_amount FROM orders WHERE order_no='${cop.id}'`) === '200.00');
  ok('…no refund is queued', sql(`SELECT count(*) FROM order_refund_requests r JOIN orders o USING (order_id) WHERE o.order_no='${cop.id}'`) === '0');
  ok('…stock went back', sql(`SELECT stock_deducted FROM orders WHERE order_no='${cop.id}'`) === 'f');
  ok('…and it counts as a no-show', sql(`SELECT count(*) FROM order_failures f JOIN orders o USING (order_id) WHERE o.order_no='${cop.id}' AND f.counts`) === '1');

  console.log('\n2. Cash on Pickup picked up in time: the balance is paid in cash at the counter');
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Pickup', method: 'Cash on Pickup', phone: '09171234567', items: [{ sku: 'FG-FB02', qty: 20 }] });
  const cop2 = r.body; await webhook(cop2.id, 200);
  for (const st of ['Packed', 'Ready for Pickup']) await ca('POST', '/api/orders/' + cop2.id + '/status', { status: st });
  r = await ca('POST', '/api/orders/' + cop2.id + '/status', { status: 'Picked Up', receivedBy: 'Carlo Customer', pickupIdType: 'National ID', pickupIdLast4: '1234', cashReceived: String(BAL - 1), requestId: rid() });
  ok('the cashier must take the full ₱' + ph(BAL) + ' balance', r.status === 400 && JSON.stringify(r.body).includes(BAL.toLocaleString('en-PH')), r.body);
  r = await ca('POST', '/api/orders/' + cop2.id + '/status', { status: 'Picked Up', receivedBy: 'Carlo Customer', pickupIdType: 'National ID', pickupIdLast4: '1234', cashReceived: String(BAL), requestId: rid() });
  ok('picked up with ₱' + ph(BAL) + ' cash', r.status === 200 && r.body.amount === BAL && r.body.balance === 0, r.body);

  console.log('\n3. Cash on Delivery: the delivery fee online, the goods in cash to the rider');
  const ship = { recipient: 'Carlo Customer', phone: '09171234567', addressLine: 'Blk 5 Lot 12 Sampaguita St.', region: 'National Capital Region (NCR)', province: 'Metro Manila', city: 'City of Valenzuela', barangay: 'Malinta', zip: '1440' };
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Delivery', method: 'Cash on Delivery', phone: '09171234567', shipTo: ship, items: [{ sku: 'FG-FB02', qty: 20 }] });
  ok('COD order placed', r.status === 201, r.body);
  const cod = r.body;
  ok('the delivery fee + ₱200 down payment are paid now; the rest is cash on delivery', cod.advance && cod.advance.kind === 'shipping_fee' && cod.advance.amount === cod.deliveryFee + 200 && cod.advance.fee === cod.deliveryFee && cod.advance.deposit === 200 && cod.dueNow === cod.deliveryFee + 200 && cod.advance.cash === cod.subtotal - 200 && cod.advance.label === 'delivery fee and down payment', cod);
  r = await ca('POST', '/api/orders/' + cod.id + '/confirm', {});
  ok('not confirmed before the fee and down payment are paid', r.status === 400 && /delivery fee and down payment has not been paid/.test(JSON.stringify(r.body)), r.body);
  await webhook(cod.id, cod.advance.amount);
  ok('fee paid: confirmed by itself', sql(`SELECT status FROM orders WHERE order_no='${cod.id}'`) === 'Paid');
  for (const st of ['Packed']) await ca('POST', '/api/orders/' + cod.id + '/status', { status: st });
  r = await ca('POST', '/api/orders/' + cod.id + '/status', { status: 'Out for Delivery' });
  ok('out for delivery with the goods still to collect', r.status === 200, r.body);
  r = await ca('POST', '/api/orders/' + cod.id + '/status', { status: 'Delivered', receivedBy: 'Carlo Customer', cashReceived: String(cod.subtotal - 200), requestId: rid() });
  ok('delivered: the rider collected the goods less the down payment (' + (cod.subtotal - 200) + ')', r.status === 200 && r.body.amount === cod.subtotal - 200 && r.body.balance === 0, r.body);

  console.log('\n4. COD: the customer refuses at the door — the delivery fee is kept');
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Delivery', method: 'Cash on Delivery', phone: '09171234567', shipTo: ship, items: [{ sku: 'FG-FB02', qty: 20 }] });
  const cod2 = r.body; await webhook(cod2.id, cod2.advance.amount);
  for (const st of ['Packed', 'Out for Delivery']) await ca('POST', '/api/orders/' + cod2.id + '/status', { status: st });
  r = await ca('POST', '/api/orders/' + cod2.id + '/not-completed', { reason: 'refused', action: 'cancel' });
  ok('cancelled', r.status === 200 && !r.body.refundQueued, r.body);
  ok('…the delivery fee and down payment are kept, nothing refunded', sql(`SELECT forfeited_amount FROM orders WHERE order_no='${cod2.id}'`) === Number(cod2.advance.amount).toFixed(2));
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Delivery', method: 'Cash on Delivery', phone: '09171234567', shipTo: ship, items: [{ sku: 'FG-FB02', qty: 20 }] });
  ok('after 2 no-shows, cash is blocked for this customer', r.status === 400 && /not available on your account/.test(r.body.error || ''), r.body);
  sql(`DELETE FROM order_failures WHERE customer_id = 4`);
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Delivery', method: 'Cash on Delivery', phone: '09171234567', shipTo: ship, items: [{ sku: 'FG-FB02', qty: 20 }] });
  const cod3 = r.body; await webhook(cod3.id, cod3.advance.amount);
  for (const st of ['Packed', 'Out for Delivery']) await ca('POST', '/api/orders/' + cod3.id + '/status', { status: st });
  r = await ca('POST', '/api/orders/' + cod3.id + '/not-completed', { reason: 'shop_issue', action: 'cancel' });
  ok('our own fault (vehicle / weather): the fee is refunded instead', r.status === 200 && r.body.refundQueued === cod3.advance.amount && sql(`SELECT forfeited_amount FROM orders WHERE order_no='${cod3.id}'`) === '0.00', r.body);

  console.log('\n5. The advance was never paid');
  r = await cu('POST', '/api/shop/orders', { requestId: rid(), fulfillment: 'Pickup', method: 'Cash on Pickup', phone: '09171234567', items: [{ sku: 'FG-FB02', qty: 20 }] });
  const cop3 = r.body;
  sql(`UPDATE orders SET created_at = now() - interval '49 hours' WHERE order_no='${cop3.id}'`);
  await automation();
  ok('a cash-on-pickup order whose down payment never came is cancelled like an unpaid online order', sql(`SELECT status FROM orders WHERE order_no='${cop3.id}'`) === 'Cancelled');

  console.log('\n6. Finance settings');
  r = await fi('PUT', '/api/finance/order-rules', { codLimit: rules.body.codLimit, maxNoShows: rules.body.maxNoShows, pickupHoldDays: rules.body.pickupHoldDays, copDeposit: '300', copHoldHours: 24 });
  ok('Finance can set ₱300 / 24 hours', r.status === 200 && r.body.copDeposit === 300 && r.body.copHoldHours === 24, r.body);
  r = await fi('PUT', '/api/finance/order-rules', { codLimit: rules.body.codLimit, maxNoShows: rules.body.maxNoShows, pickupHoldDays: rules.body.pickupHoldDays, copDeposit: 'abc', copHoldHours: 2 });
  ok('…and nonsense is refused per field', r.status === 400 && r.body.fields.copDeposit && r.body.fields.copHoldHours, r.body);
  await fi('PUT', '/api/finance/order-rules', { codLimit: rules.body.codLimit, maxNoShows: rules.body.maxNoShows, pickupHoldDays: rules.body.pickupHoldDays, copDeposit: '200', copHoldHours: 48 });
  sql(`DELETE FROM order_failures WHERE customer_id = 4`);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
