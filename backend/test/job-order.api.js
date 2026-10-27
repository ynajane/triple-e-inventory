/* job-order.api.js — DEV ONLY walk-through against a running server (:8099) and its PostgreSQL (psql on PATH), demo users carlo / cara / fin.
   Covers: a custom quote made with a job order (materials leave stock, "ready" is refused before), the "missing details" answer
   updating the quotation, Finance closing a request with a reason, and deleting a customer account with no history.
   Run:  node test/job-order.api.js */
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
const key = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const needed = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
const customQuote = (over) => Object.assign({ productName: 'Aluminum pump cover', itemType: 'Die-cast part', quantity: '50', quantityUnit: 'pcs', neededBy: needed, fulfillment: 'Pickup', phone: '09171234567',
  specs: { material: 'Aluminum ADC12', size: 'Medium: 51 to 150 mm', thickness: '3.0 mm', finish: 'Powder Coated', service: 'Deburring' } }, over || {});
(async () => {
  const cu = await session('carlo@example.com'), ca = await session('cara@example.com'), fi = await session('fin@example.com');

  console.log('\n1. a custom item is made with a job order');
  let r = await cu('POST', '/api/shop/quotes', customQuote());
  ok('customer asked for a custom die-cast part', r.status === 201, r.body);
  const no = r.body.id;
  r = await ca('POST', '/api/pos/quotes/' + no + '/price', { amount: '25000.00', leadTime: '2 weeks', validDays: 7, note: 'Includes powder coat' });
  ok('cashier priced it (goes to Finance: no cashier limit set)', r.status === 200 && r.body.status === 'pending_approval', r.body);
  r = await fi('POST', '/api/finance/quotes/' + no + '/approve-price', {});
  ok('Finance approved the price', r.status === 200, r.body);
  r = await cu('POST', '/api/shop/quotes/' + no + '/respond', { action: 'accept', payMethod: 'cod' });
  ok('customer accepted', r.status === 200 && r.body.status === 'accepted', r.body);
  r = await fi('GET', '/api/finance/quotes/' + no + '/job');
  ok('before "Start preparing" no materials can be issued yet', r.status === 200 && r.body.custom === true && r.body.canIssue === false && !r.body.job, r.body);
  ok('the quote\'s material and finish suggest ADC12 ingot and powder coat', (r.body.suggestions || []).map((x) => x.sku).join() === 'RM-ADC12,FS-PNT', r.body.suggestions);
  r = await fi('POST', '/api/finance/quotes/' + no + '/step', { status: 'preparing' });
  ok('Finance started preparing', r.status === 200 && r.body.status === 'preparing', r.body);
  r = await fi('POST', '/api/finance/quotes/' + no + '/step', { status: 'ready' });
  ok('"ready" is refused until the materials are issued', r.status === 400 && /Job order/.test(JSON.stringify(r.body)), r.body);
  const ingot0 = +sql(`SELECT on_hand FROM products WHERE sku='RM-ADC12'`), coat0 = +sql(`SELECT on_hand FROM products WHERE sku='FS-PNT'`);
  r = await fi('POST', '/api/finance/quotes/' + no + '/job', { requestKey: key(), items: [{ sku: 'RM-ADC12', quantity: '999999' }] });
  ok('more than is on hand is refused, nothing deducted', r.status === 400 && /on hand/.test(JSON.stringify(r.body)) && +sql(`SELECT on_hand FROM products WHERE sku='RM-ADC12'`) === ingot0, r.body);
  r = await fi('POST', '/api/finance/quotes/' + no + '/job', { requestKey: key(), items: [{ sku: 'FG-DC01', quantity: '1' }] });
  ok('a finished good cannot be issued to a job', r.status === 400, r.body);
  const k1 = key();
  r = await fi('POST', '/api/finance/quotes/' + no + '/job', { requestKey: k1, note: 'Two ingots', items: [{ sku: 'RM-ADC12', quantity: '12.5' }, { sku: 'FS-PNT', quantity: '1.2' }] });
  ok('materials issued: job order made', r.status === 201 && /^JOB-\d+/.test(r.body.job.ref) && r.body.job.items.length === 2, r.body);
  ok('…stock went down by exactly what was issued', +sql(`SELECT on_hand FROM products WHERE sku='RM-ADC12'`) === ingot0 - 12.5 && +sql(`SELECT on_hand FROM products WHERE sku='FS-PNT'`) === +(coat0 - 1.2).toFixed(2));
  ok('…as "Used in production" movements linked to the job', +sql(`SELECT count(*) FROM stock_movements WHERE source_type='job_order' AND reason='production_use' AND source_id=(SELECT job_id FROM job_orders j JOIN quote_requests q USING (quote_id) WHERE q.quote_no='${no}')`) === 2);
  ok('…with the material cost (12.5 x 148 + 1.2 x 380 = 2,306)', r.body.job.materialCost === 2306, r.body.job);
  r = await fi('POST', '/api/finance/quotes/' + no + '/job', { requestKey: k1, items: [{ sku: 'RM-ADC12', quantity: '12.5' }] });
  ok('a double click does not deduct twice', r.status === 200 && r.body.duplicate === true && +sql(`SELECT on_hand FROM products WHERE sku='RM-ADC12'`) === ingot0 - 12.5, r.body);
  r = await fi('POST', '/api/finance/quotes/' + no + '/step', { status: 'ready' });
  ok('now it can be marked ready', r.status === 200 && r.body.status === 'ready', r.body);

  console.log('\n2. "missing details": the answer updates the quotation');
  r = await cu('POST', '/api/shop/quotes', customQuote({ productName: 'Brass valve body', itemType: 'Fitting / valve', specs: { material: 'Brass C37700', size: '1"', thickness: 'Not applicable', finish: 'Polished', service: 'None (as is)' } }));
  const no2 = r.body.id;
  r = await ca('POST', '/api/pos/quotes/' + no2 + '/clarifications', { fields: ['dimensions'], message: 'Please confirm the exact pipe size and thread.' });
  ok('cashier asked for the size', r.status === 201, r.body);
  r = await cu('POST', '/api/shop/quotes/' + no2 + '/clarifications/respond', { response: '', specs: { dimensions: '25 mm', finish: 'Nickel Plated', quantity: '60 pcs' } });
  ok('customer answered and also changed the finish and quantity', r.status === 200, r.body);
  ok('…the quotation now says Size: 25 mm, Finish: Nickel Plated, 60 pcs', sql(`SELECT (specs->>'size') || '|' || (specs->>'finish') || '|' || quantity FROM quote_requests WHERE quote_no='${no2}'`) === '25 mm|Nickel Plated|60 pcs');
  ok('…and its details text too', /Size: 25 mm/.test(sql(`SELECT details FROM quote_requests WHERE quote_no='${no2}'`)) && /Finish: Nickel Plated/.test(sql(`SELECT details FROM quote_requests WHERE quote_no='${no2}'`)));

  console.log('\n3. Finance closes a request: a reason is required');
  r = await fi('POST', '/api/finance/quotes/' + no2, { status: 'closed' });
  ok('no reason: refused', r.status === 400 && r.body.fields.closeReason, r.body);
  r = await fi('POST', '/api/finance/quotes/' + no2, { status: 'closed', closeReason: 'other', note: 'short' });
  ok('"Other" needs an explanation', r.status === 400 && r.body.fields.note, r.body);
  r = await fi('POST', '/api/finance/quotes/' + no2, { status: 'closed', closeReason: 'cannot_make' });
  ok('closed with a reason', r.status === 200 && sql(`SELECT status || '|' || close_reason FROM quote_requests WHERE quote_no='${no2}'`) === 'closed|cannot_make', r.body);
  const mine = (await cu('GET', '/api/shop/quotes')).body.find((q) => q.id === no2);
  ok('the customer sees why', mine && /cannot make/.test(mine.closeReason || ''), mine && mine.closeReason);

  console.log('\n4. User Management: customer accounts');
  const list = (await fi('GET', '/api/users')).body;
  ok('customers are listed with staff', list.some((u) => u.roleKey === 'customer') && list.some((u) => u.roleKey === 'finance'));
  const em = 'triplee.temp' + Date.now() + '@gmail.com';
  r = await fi('POST', '/api/invitations', { name: 'Temp Customer', email: em, role: 'customer' });
  ok('Finance can invite a customer (they choose their own password)', r.status === 201, r.body);
  sql(`INSERT INTO users (full_name, username, email, password_hash, role_id, status) SELECT 'Delete Me', 'delme${Date.now()}', 'del${Date.now()}@example.com', password_hash, 3, 'active' FROM users WHERE user_id = 4`);
  const del = (await fi('GET', '/api/users')).body.find((u) => u.name === 'Delete Me');
  r = await fi('DELETE', '/api/users/' + del.id);
  ok('a customer with no history can be deleted', r.status === 200, r.body);
  r = await fi('DELETE', '/api/users/4');
  ok('a customer with orders cannot (disable instead)', r.status === 400 && /Disable it instead/.test(JSON.stringify(r.body)), r.body);
  r = await fi('DELETE', '/api/users/3');
  ok('staff accounts are never deleted', r.status === 400, r.body);
  sql(`DELETE FROM invitations WHERE email='${em}'`);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
