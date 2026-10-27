// Full empty-database initialization and real server; no provider credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const root = path.resolve(__dirname, '..');
function command(file, args, env) {
 const r = spawnSync(file, args, { cwd: root, env, encoding: 'utf8' });
 assert.equal(r.status, 0, `${file}: ${r.stderr}`); return r.stdout.trim();
}
test('fresh install supports OTP, role data, POS sale and void approval', { timeout: 60000 }, async (t) => {
 const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'triplee-startup-'));
 const bin = command('pg_config', ['--bindir']), data = path.join(temp, 'data');
 let running = false, child, pool, output = '';
 t.after(async () => {
  if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  if (pool) await pool.end();
  if (running) command(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
  fs.rmSync(temp, { recursive: true, force: true });
 });
 command(path.join(bin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=reject', '--no-locale']);
 command(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(temp,'postgres.log'), '-o', `-F -h '' -k ${temp}`, '-w','start']); running = true;
 const env = { PATH: process.env.PATH, HOME: temp, PGHOST: temp, PGUSER: os.userInfo().username, PGDATABASE: 'postgres', PGPORT: '5432', NODE_ENV: 'development',
  JWT_SECRET: require('node:crypto').randomBytes(32).toString('hex'), ADDRESS_CHECK: 'off', LOGIN_OTP: 'on', SHIFT_FORCE_CLOSE_MINUTES: '0', ENFORCE_STORE_HOURS: 'false' };
 command(path.join(bin,'psql'), ['-X','-v','ON_ERROR_STOP=1','-f',path.join(root,'db/initialize.sql')], env);
 pool = new Pool({ host: temp, user: env.PGUSER, database: 'postgres' });
 const port = await new Promise((resolve) => { const s = require('node:net').createServer().listen(0,'127.0.0.1', () => { const p=s.address().port; s.close(() => resolve(p)); }); });
 const base = 'http://127.0.0.1:' + port;
 child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...env, PORT: String(port), APP_BASE_URL: base }, stdio: ['ignore','pipe','pipe'] });
 child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
 for (let i=0;i<150 && !output.includes('cash shift schema ready');i++) await delay(100);
 await delay(500);
 assert.doesNotMatch(output, /could not|setup failed|schema:|unhandled rejection|uncaught exception|tables warning/i);
 command(path.join(bin,'psql'),['-X','-v','ON_ERROR_STOP=1','-f',path.join(root,'db/025_security_hardening.sql')],env);
 assert.equal((await pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity")).rows[0].n,0);
 assert.equal((await fetch(base+'/Login_Inventory.html')).status,200);
 assert.equal((await fetch(base+'/api/products')).status,401);
 assert.equal((await fetch(base+'/Finance_Inventory.html',{redirect:'manual'})).status,302);
 const password = require('node:crypto').randomBytes(16).toString('hex')+'!7';
 const request = async (route,body,cookie) => {
  const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,json:await r.json(),cookie:r.headers.get('set-cookie')};
 };
 const cookies={};
 for (const role of ['finance','cashier','customer']) {
  command(process.execPath,['scripts/create-user.js','Synthetic '+role,role,role+'@example.invalid',password,role],env);
  const login=await request('/api/auth/login',{email:role+'@example.invalid',password});
  assert.equal(login.json.code,'OTP_REQUIRED'); assert.equal(login.cookie,null);
  const token=login.json.challengeToken,offset=output.length;
  assert.equal((await request('/api/auth/login-otp/send',{token,channel:'email'})).status,200);
  await delay(50);
  const code=output.slice(offset).match(/test code: (\d{6})/)[1];
  const verified=await request('/api/auth/login-otp/verify',{token,code});
  assert.equal(verified.status,200); cookies[role]=verified.cookie.split(';')[0];
  assert.equal((await request('/api/auth/me',undefined,cookies[role])).status,200);
 }
 for(const route of ['/api/products','/api/inventory','/api/suppliers','/api/pos/void-requests','/api/audit','/api/inventory/automation/tracking'])
  assert.equal((await request(route,undefined,cookies.finance)).status,200,route);
 assert.equal((await request('/api/products',undefined,cookies.customer)).status,403);
 assert.equal((await request('/api/pos/products',undefined,cookies.cashier)).status,200);
 assert.equal((await request('/api/shop/products',undefined,cookies.customer)).status,200);
 // Recovery and retry endpoints must stay scoped to the signed-in cashier.
 const cashierId=(await pool.query("SELECT user_id FROM users WHERE username='cashier'")).rows[0].user_id;
 const financeId=(await pool.query("SELECT user_id FROM users WHERE username='finance'")).rows[0].user_id;
 const recovered=(await pool.query(`INSERT INTO pos_xendit_payments(cashier_id,cashier_name,external_id,amount,items,request_id)
  VALUES ($1,'Synthetic cashier','synthetic-pending',100,'[]','checkout-retry-000001') RETURNING payment_id`,[cashierId])).rows[0].payment_id;
 const foreign=(await pool.query(`INSERT INTO pos_xendit_payments(cashier_id,cashier_name,external_id,amount,items)
  VALUES ($1,'Other cashier','synthetic-foreign',200,'[]') RETURNING payment_id`,[financeId])).rows[0].payment_id;
 const recoveredList=await request('/api/pos/xendit-payments',undefined,cookies.cashier);
 assert.deepEqual(recoveredList.json.map(p=>p.paymentId),[recovered]);
 assert.equal((await request('/api/pos/xendit-payments',undefined,cookies.customer)).status,403);
 assert.equal((await request('/api/pos/xendit-payments?ids=invalid',undefined,cookies.cashier)).status,400);
 assert.deepEqual((await request('/api/pos/xendit-payments?ids='+foreign,undefined,cookies.cashier)).json.map(p=>p.paymentId),[recovered]);
 assert.equal((await request('/api/pos/xendit-payments/'+foreign,undefined,cookies.cashier)).status,404);
 // An interrupted checkout retry returns the original request even if a new cart is missing.
 const replays=await Promise.all([1,2].map(()=>request('/api/pos/xendit-checkout',{requestId:'checkout-retry-000001'},cookies.cashier)));
 assert.ok(replays.every(r=>String(r.json.paymentId)===String(recovered)));
 assert.equal((await pool.query('SELECT count(*)::int n FROM pos_xendit_payments')).rows[0].n,2);
 await pool.query("UPDATE pos_xendit_payments SET status='paid',sale_id=99 WHERE payment_id=$1",[recovered]);
 assert.equal((await request('/api/pos/xendit-payments',undefined,cookies.cashier)).json.length,0);
 const paidRecovery=await request('/api/pos/xendit-payments?requests=checkout-retry-000001',undefined,cookies.cashier);
 assert.equal(paidRecovery.json[0].status,'paid');
 assert.equal((await request('/api/pos/xendit-payments?ids='+recovered,undefined,cookies.cashier)).json[0].sale_id,'99');
 await pool.query("INSERT INTO products(sku,name,department,unit,on_hand,selling_price,shop_visible,price_auto) VALUES ('FG-SMOKE','Synthetic piece','Finished Goods','pcs',5,100,true,false)");
 command(path.join(bin,'psql'),['-X','-v','ON_ERROR_STOP=1','-f',path.join(root,'db/002_sales_core.sql')],env);
 assert.equal((await pool.query("SELECT on_hand FROM products WHERE sku='FG-SMOKE'")).rows[0].on_hand,'5.00');
 // A brand-new simultaneous retry may fail provider setup, but must create only one checkout request.
 // This fixture has no provider key: xenditAuth refuses before fetch can contact the provider.
 const simultaneous=await Promise.all([1,2].map(()=>request('/api/pos/xendit-checkout',{
  requestId:'first-checkout-race-0001',items:[{sku:'FG-SMOKE',qty:5}]},cookies.cashier)));
 assert.ok(simultaneous.some(r=>r.status===500));
 assert.ok(simultaneous.some(r=>r.status===200));
 assert.equal((await pool.query("SELECT count(*)::int n FROM pos_xendit_payments WHERE request_id='first-checkout-race-0001'")).rows[0].n,1);
 assert.equal((await request('/api/pos/xendit-payments?requests=first-checkout-race-0001',undefined,cookies.cashier)).json[0].status,'error');
 assert.equal((await pool.query('SELECT count(*)::int n FROM pos_sales')).rows[0].n,0);
 const order=await request('/api/shop/orders',{requestId:'startup-smoke-order-0001',fulfillment:'Pickup',method:'Xendit',phone:'09171234567',items:[{sku:'FG-SMOKE',qty:5}]},cookies.customer);
 assert.equal(order.status,201,JSON.stringify(order));
 const savedOrder=(await pool.query('SELECT order_no,stock_deducted FROM orders')).rows[0];
 assert.match(savedOrder.order_no,/^ORD-\d+$/); assert.equal(savedOrder.stock_deducted,false);
 assert.equal((await pool.query('SELECT COUNT(*)::int n FROM order_items')).rows[0].n,1);
 const shift=await request('/api/pos/cash-shifts/open',{openingCash:0},cookies.cashier);
 assert.ok(shift.status<300,JSON.stringify(shift));
 const sale=await request('/api/pos/sales',{requestId:'startup-smoke-sale-00001',method:'Cash',tendered:500,items:[{sku:'FG-SMOKE',qty:5}]},cookies.cashier);
 assert.ok(sale.status<300,JSON.stringify(sale));
 const row=(await pool.query('SELECT sale_id,receipt_no FROM pos_sales')).rows[0]; assert.match(row.receipt_no,/^SI-\d+$/);
 command(path.join(bin,'psql'),['-X','-v','ON_ERROR_STOP=1','-f',path.join(root,'db/002_sales_core.sql')],env);
 assert.equal((await pool.query('SELECT receipt_no FROM pos_sales WHERE sale_id=$1',[row.sale_id])).rows[0].receipt_no,row.receipt_no);
 assert.equal((await request(`/api/pos/sales/${row.sale_id}/void-request`,{reason:'other',details:'Synthetic smoke reversal'},cookies.cashier)).status,201);
 const pending=(await request('/api/pos/void-requests',undefined,cookies.finance)).json;
 assert.equal((await request(`/api/pos/void-requests/${pending[0].id}/decision`,{approve:true},cookies.finance)).status,200);
 assert.equal((await pool.query("SELECT on_hand FROM products WHERE sku='FG-SMOKE'")).rows[0].on_hand,'5.00');
 assert.doesNotMatch(output,/unhandled rejection|uncaught exception|error: column|error: relation/i);
});
