/* automation-pricing.api.js — DEV ONLY walk-through against a running server (:8099, AUTOMATION_CRON_KEY=cronkey) and its PostgreSQL.
   Covers: Finance can only change a role (never personal details), finished goods priced unit cost + markup, the quote calculator
   and the below-cost rule, store hours for cash shifts, the weekly scheduled stock count, and invoice numbering.
   Run:  node test/automation-pricing.api.js */
const { execSync } = require('child_process');
const B = 'http://localhost:8099';
const sql = (q) => execSync(`psql -At postgres://triplee:x@localhost:5432/triplee -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
async function session(email) {
  const r = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'StrongP@ss1' }) });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Sign-in answered ' + r.status + '. Start this DEV server with LOGIN_OTP=off: the walk-through cannot type a one-time code.');
  return async (method, path, body) => { const x = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) }; };
}
let pass = 0, fail = 0; const ok = (l, c, d) => { if (c) { pass++; console.log('  PASS ' + l); } else { fail++; console.log('  FAIL ' + l + '  ->  ' + String(JSON.stringify(d)).slice(0, 400)); } };
const automation = () => fetch(B + '/api/automation/run', { method: 'POST', headers: { 'x-cron-key': 'cronkey' } }).then((r) => r.json());
const needed = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
(async () => {
  const fi = await session('fin@example.com'), ca = await session('cara@example.com'), cu = await session('carlo@example.com');
  const second = +sql(`SELECT user_id FROM users WHERE email='fin2@example.com'`) || +sql(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_key='finance' AND u.email <> 'fin@example.com' LIMIT 1`);
  const me = +sql(`SELECT user_id FROM users WHERE email='fin@example.com'`), carlo = +sql(`SELECT user_id FROM users WHERE email='carlo@example.com'`);

  console.log('\n1. User Management: Finance changes the role only');
  let r = await fi('PATCH', '/api/users/' + second, { name: 'Changed Name', roleKey: 'finance' });
  ok('sending a name is refused', r.status === 400 && /only change the role/.test(JSON.stringify(r.body)), r.body);
  r = await fi('PATCH', '/api/users/' + second, { email: 'x@gmail.com', roleKey: 'finance' });
  ok('sending an email is refused', r.status === 400, r.body);
  const nameBefore = sql(`SELECT full_name || '|' || email FROM users WHERE user_id=${second}`);
  r = await fi('PATCH', '/api/users/' + second, { roleKey: 'cashier' });
  ok('role changed to Cashier', r.status === 200 && r.body.changed === true && sql(`SELECT r.role_key FROM users u JOIN roles r USING (role_id) WHERE user_id=${second}`) === 'cashier', r.body);
  ok('…name and email untouched', sql(`SELECT full_name || '|' || email FROM users WHERE user_id=${second}`) === nameBefore);
  r = await fi('PATCH', '/api/users/' + second, { roleKey: 'finance' });
  ok('and back to Finance-Admin', r.status === 200 && sql(`SELECT r.role_key FROM users u JOIN roles r USING (role_id) WHERE user_id=${second}`) === 'finance', r.body);
  r = await fi('PATCH', '/api/users/' + me, { roleKey: 'cashier' });
  ok('nobody changes their own role', r.status === 400 && /own role/.test(JSON.stringify(r.body)), r.body);
  r = await fi('PATCH', '/api/users/' + carlo, { roleKey: 'cashier' });
  ok('a customer stays a customer', r.status === 400, r.body);

  console.log('\n2. Finished goods: selling price = unit cost + markup');
  const cost = +sql(`SELECT unit_cost FROM products WHERE sku='FG-FB02'`);
  ok('FG-FB02 is unit cost + 20% (' + cost + ' -> ' + (cost * 1.2).toFixed(2) + ')', +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === Math.round(cost * 120) / 100);
  r = await ca('PUT', '/api/finance/pricing', { fgMarkupPct: 30 });
  ok('a cashier cannot change the pricing rules', r.status === 403, r.body);
  const R0 = (await fi('GET', '/api/pricing')).body;
  r = await fi('PUT', '/api/finance/pricing', { fgMarkupPct: 25, quoteMarkupPct: R0.quoteMarkupPct, rates: R0.rates });
  ok('Finance sets 25%: every automatic price follows', r.status === 200 && r.body.repriced > 0 && +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === Math.round(cost * 125) / 100, r.body);
  r = await fi('PUT', '/api/finance/pricing', { fgMarkupPct: 20, quoteMarkupPct: R0.quoteMarkupPct, rates: R0.rates });
  ok('back to 20%', +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === Math.round(cost * 120) / 100);
  sql(`UPDATE products SET unit_cost = unit_cost + 10 WHERE sku='FG-FB02'`);
  ok('a new unit cost re-prices it by itself (database trigger)', +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === Math.round((cost + 10) * 120) / 100);
  sql(`UPDATE products SET unit_cost = ${cost} WHERE sku='FG-FB02'`);
  sql(`UPDATE products SET selling_price = 999 WHERE sku='FG-FB02'`);
  ok('a hand-typed price on an automatic product is put back', +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === Math.round(cost * 120) / 100);
  sql(`UPDATE products SET price_auto = false, selling_price = 250 WHERE sku='FG-FB02'`);
  sql(`UPDATE products SET unit_cost = unit_cost WHERE sku='FG-FB02'`);
  ok('a manual price is left alone', +sql(`SELECT selling_price FROM products WHERE sku='FG-FB02'`) === 250);
  sql(`UPDATE products SET price_auto = true WHERE sku='FG-FB02'`);
  const list = (await fi('GET', '/api/products')).body.find((p) => p.sku === 'FG-FB02');
  ok('the product list says it is automatic again', list && list.priceAuto === true && list.listPrice === Math.round(cost * 120) / 100, list);

  console.log('\n3. Quote calculator');
  const spec = { itemType: 'Die-cast part', material: 'Aluminum ADC12', size: 'Medium: 51 to 150 mm', thickness: '3.0 mm', finish: 'Powder Coated', service: 'Deburring' };
  r = await cu('POST', '/api/pricing/quote-estimate', { quantity: '50 pcs', specs: spec });
  ok('a customer gets an estimate', r.status === 200 && r.body.ok && r.body.total > 0 && r.body.pricePerPiece === Math.ceil(r.body.costPerPiece * 1.2), r.body);
  const est = r.body;
  r = await cu('POST', '/api/pricing/quote-estimate', { quantity: '100 pcs', specs: spec });
  ok('more pieces share the tooling: cheaper per piece', r.body.pricePerPiece < est.pricePerPiece, [r.body.pricePerPiece, est.pricePerPiece]);
  r = await cu('POST', '/api/pricing/quote-estimate', { quantity: '50 pcs', specs: Object.assign({}, spec, { size: 'Large: 151 to 300 mm' }) });
  ok('a bigger size costs more', r.body.pricePerPiece > est.pricePerPiece, r.body.pricePerPiece);
  r = await cu('POST', '/api/pricing/quote-estimate', { quantity: '50', specs: { itemType: 'Die-cast part' } });
  ok('missing details: it says what is missing', r.body.ok === false && r.body.missing.includes('size'), r.body);
  r = await cu('POST', '/api/shop/quotes', { productName: 'Pump cover (calc test)', itemType: spec.itemType, quantity: '50', quantityUnit: 'pcs', neededBy: needed, fulfillment: 'Pickup', phone: '09171234567', specs: spec });
  const no = r.body.id;
  ok('request sent', r.status === 201, r.body);
  r = await ca('GET', '/api/pricing/quote/' + no);
  ok('the cashier sees the same system price', r.body.ok && r.body.total === est.total, r.body.total);
  r = await ca('POST', '/api/pos/quotes/' + no + '/price', { amount: String(Math.floor(est.costTotal * 0.8)), leadTime: '2 weeks', validDays: 7 });
  ok('a price below the computed cost goes to Finance', r.status === 200 && r.body.status === 'pending_approval' && /Below the computed cost/.test(r.body.quote.approvalReason || sql(`SELECT approval_reason FROM quote_requests WHERE quote_no='${no}'`)), r.body);
  ok('…the system price and cost are saved next to it', +sql(`SELECT suggested_amount FROM quote_requests WHERE quote_no='${no}'`) === est.total && +sql(`SELECT suggested_cost FROM quote_requests WHERE quote_no='${no}'`) === est.costTotal);
  const fq = (await fi('GET', '/api/finance/quotes')).body.find((q) => q.id === no);
  ok('Finance sees both', fq && fq.suggestedAmount === est.total && fq.proposedAmount < fq.suggestedCost, fq && [fq.suggestedAmount, fq.proposedAmount, fq.suggestedCost]);
  await fi('POST', '/api/finance/quotes/' + no, { status: 'closed', closeReason: 'duplicate' });

  console.log('\n4. Cash shift store hours');
  r = await ca('GET', '/api/pos/business-hours');
  ok('store hours are 8:00 AM to 5:00 PM', r.body.open === '8:00 AM' && r.body.close === '5:00 PM' && typeof r.body.canOpenShift === 'boolean', r.body);
  const h = r.body, inside = h.nowMinutes >= h.openMinutes - h.earlyMinutes && h.nowMinutes < h.closeMinutes;
  ok('can a shift open now? ' + inside + ' (server time ' + Math.floor(h.nowMinutes / 60) + ':' + String(h.nowMinutes % 60).padStart(2, '0') + ')', h.canOpenShift === inside, h);
  const openShift = sql(`SELECT count(*) FROM pos_cash_shifts s JOIN users u ON u.user_id = s.cashier_id WHERE u.email='cara@example.com' AND closed_at IS NULL`) === '1';
  if (!inside && !openShift) {
    r = await ca('POST', '/api/pos/cash-shifts/open', { openingCash: 1000 });
    ok('outside store hours a shift cannot be opened', r.status === 409 && /store|early/i.test(r.body.error || ''), r.body);
  }
  const jobs = await automation();
  ok('the close-of-day job runs', jobs['shift-hours'] && !jobs['shift-hours'].error, jobs['shift-hours']);

  console.log('\n5. Weekly stock count');
  const wd = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })).getDay();
  sql(`UPDATE stock_counts SET status='cancelled', closed_at=now() WHERE status='open'`);
  const before = (await fi('GET', '/api/stock-counts/schedule')).body;
  ok('default: every Monday, all departments', before.weekday >= 0 && before.dueDays >= 1, before);
  r = await fi('PUT', '/api/stock-counts/schedule', { enabled: true, weekday: wd, scope: '', dueDays: 2 });
  ok('Finance sets count day = today', r.status === 200 && r.body.weekday === wd, r.body);
  sql(`UPDATE stock_count_schedule SET last_run = NULL`);
  const afterOpen = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })).getHours() >= 8;
  const a = await automation();
  if (afterOpen) {
    ok('the system started the count by itself', a['weekly-stock-count'] && /^SC-/.test(a['weekly-stock-count'].started || ''), a['weekly-stock-count']);
    const c = (await fi('GET', '/api/stock-counts')).body.find((x) => x.status === 'open');
    ok('…marked as weekly, started by the system', c && c.scheduled === true && /System/.test(c.createdBy), c);
    ok('…and Finance is told', +sql(`SELECT count(*) FROM notifications WHERE title LIKE 'Weekly stock count%ready' AND created_at > now() - interval '2 minutes'`) > 0);
    const again = await automation();
    ok('it runs once a day only', !again['weekly-stock-count'].started, again['weekly-stock-count']);
    const s2 = (await fi('GET', '/api/stock-counts/schedule')).body;
    ok('next count is a week later', s2.nextRun && s2.lastRun && (new Date(s2.nextRun) - new Date(s2.lastRun)) / 864e5 === 7, s2);
    if (c) await fi('POST', '/api/stock-counts/' + c.id + '/cancel', {});
  } else console.log('  (before 8:00 AM: the automatic start is checked after opening time)');
  await fi('PUT', '/api/stock-counts/schedule', { enabled: before.enabled, weekday: before.weekday, scope: before.scope, dueDays: before.dueDays });

  console.log('\n6. Invoices');
  ok('new POS numbers start with SI-', /'SI-'/.test(sql(`SELECT column_default FROM information_schema.columns WHERE table_name='pos_sales' AND column_name='receipt_no'`)));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
