// Uses a disposable local PostgreSQL cluster; never reads DATABASE_URL or connects to a shared server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const express = require('express');
const root = path.join(__dirname, '..');
function command(bin, args, options = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000, ...options });
  assert.equal(r.status, 0, r.stderr || r.error?.message || r.stdout);
  return r.stdout;
}

test('real PostgreSQL balance, deposit, production and credit safeguards', { timeout: 90000 }, async (t) => {
  const bin = process.env.POSTGRES_BIN || command('pg_config', ['--bindir']).trim();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'triplee-pg-')), data = path.join(temp, 'data');
  let running = false, pool, server;
  t.after(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (pool) await pool.end();
    if (running) command(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
    fs.rmSync(temp, { recursive: true, force: true });
  });
  command(path.join(bin, 'initdb'), ['-D', data, '--auth-local=trust', '--auth-host=reject', '--no-locale']);
  command(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(temp, 'postgres.log'), '-o', `-F -h '' -k ${temp}`, '-w', 'start']);
  running = true;
  pool = new Pool({ host: temp, user: os.userInfo().username, database: 'postgres', max: 5 });
  const sql = (name) => fs.readFileSync(path.join(root, 'db', name), 'utf8');
  await pool.query(sql('001_schema.sql'));
  const schema = sql('schema.sql');
  await pool.query(schema.slice(schema.indexOf('CREATE TABLE orders')).replace(/CREATE TABLE product_reviews[\s\S]*?\);/, ''));
  await pool.query("ALTER TABLE pos_sales ADD status TEXT DEFAULT 'Completed', ADD card_ref TEXT");
  for (const file of ['003_cash_shift.sql', '006_shop_extras.sql', '012_quote_flow.sql']) await pool.query(sql(file));
  // Same supporting columns normally supplied by server startup, without mounting unrelated services.
  await pool.query(`ALTER TABLE orders ADD order_no TEXT UNIQUE, ADD payment_status TEXT DEFAULT 'unpaid', ADD status_updated_at TIMESTAMPTZ, ADD stock_deducted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE quote_requests ADD converted_order_id INT;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE stock_movements ADD unit_cost NUMERIC(12,2);
    ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_reason_check;
    INSERT INTO roles(role_key,label) VALUES ('finance','Finance');
    INSERT INTO users(full_name,username,email,password_hash,role_id) VALUES ('Test Finance','test','test@example.invalid','unused',1);
    INSERT INTO products(sku,name,department,unit,on_hand,unit_cost) VALUES
      ('RM-TEST','Test metal','Raw Materials','kg',10,5), ('FG-TEST','Test piece','Finished Goods','pcs',1,10);
    INSERT INTO orders(customer_id,fulfillment,total,order_no) VALUES (1,'Pickup',100,'ORD-TEST');`);
  const tx = async (fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  class ValidationError extends Error { constructor(fields) { super(Object.values(fields)[0]); this.fields = fields; } }
  let failAudit = false;
  const audit = async (c, u, action, detail) => {
    if (failAudit) throw new Error('synthetic audit failure');
    await c.query('INSERT INTO audit_log(user_id,user_name,role_label,action,detail) VALUES ($1,$2,$3,$4,$5)', [u.id,u.name,u.roleLabel,action,detail]);
  };
  const app = express(); app.use(express.json());
  const deps = { app, pool, tx, audit, ValidationError, str: (v) => typeof v === 'string' ? v.trim() : '',
    auth: (...roles) => (req, res, next) => { const id = Number(req.headers['x-user'] || 1); const role = id === 3 ? 'cashier' : id === 4 ? 'customer' : 'finance'; req.user = { id, name: 'Test Finance ' + id, role, roleLabel: role }; if (!roles.includes(role)) return res.sendStatus(403); next(); },
    wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next) };
  require('../payment-terms')(deps); await app.locals.paymentTerms.ready;

  require('../job-orders')(deps); await app.locals.jobOrders.ready;
  require('../quote-automation')(deps); await app.locals.quoteAutomation.ready;
  await pool.query(`INSERT INTO users(full_name,username,email,password_hash,role_id) VALUES
    ('Second Finance','second','second@example.invalid','unused',1), ('Cashier','cashier','cashier@example.invalid','unused',1);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    INSERT INTO orders(customer_id,fulfillment,total,order_no,terms_key,terms_amount,terms_percent) VALUES
    (1,'Pickup',100,'ORD-HOLD','half',50,50),(1,'Pickup',30000,'ORD-CREDIT','half',15000,50);
    INSERT INTO quote_requests(quote_no,customer_id,contact_name,phone,details,quantity,status,quoted_amount,terms_key,terms_amount,terms_percent,terms_state)
      VALUES ('Q-PROD',1,'Synthetic','09000000000','Synthetic fabrication','1 pcs','accepted',100,'half',50,50,'approved');`);
  app.use((err, req, res, next) => res.status(err.fields ? 400 : 500).json({ error: err.message, fields: err.fields }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (path, body, user = 1) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method:'POST', headers:{'content-type':'application/json','x-user':String(user)}, body:JSON.stringify(body) });
    return { status:r.status, body:await r.json().catch(() => null) };
  };
  const pt = app.locals.paymentTerms;
  require('../pos-shop')(deps); await app.locals.orderRules.get();
  require('../shop-extras')(deps);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT');
  const actor = { id:1, name:'Test Finance', role:'finance', roleLabel:'Finance' };
  const order = async (no) => (await pool.query('SELECT * FROM orders WHERE order_no=$1',[no])).rows[0];
  const quote = async () => (await pool.query("SELECT * FROM quote_requests WHERE quote_no='Q-PROD'")).rows[0];
  const pay = (no, amount, extra = {}) => tx((db) => pt.applyPayment(db, {kind:'order',no,amount,method:'Cash',actor,...extra}));
  app.use((err, req, res, next) => res.status(err.fields ? 400 : 500).json({error:err.message,fields:err.fields}));
  await t.test('holds after grace, once across concurrency/restart; extensions and final payment recover', async () => {
    await pay('ORD-HOLD',50);
    assert.equal(await pt.holdOverdue('ORD-HOLD'),null);
    await pool.query("UPDATE orders SET balance_due_at=now()-interval '6 days', status='Paid' WHERE order_no='ORD-HOLD'");
    assert.equal(await pt.holdOverdue('ORD-HOLD'),null);
    await pool.query("UPDATE orders SET balance_due_at=now()-interval '8 days' WHERE order_no='ORD-HOLD'");
    await Promise.all([pt.holdOverdue('ORD-HOLD'),pt.holdOverdue('ORD-HOLD')]);
    assert.equal((await order('ORD-HOLD')).status,'On Hold');
    assert.equal((await order('ORD-HOLD')).balance_hold_from,'Paid');
    assert.equal(pt.releaseDecision(await order('ORD-HOLD'),{action:'release'}).ok,false);
    assert.equal(Number((await pool.query("SELECT count(*) n FROM audit_log WHERE detail LIKE '%On Hold%'")).rows[0].n),1);
    const invalid = await post('/api/finance/orders/ORD-HOLD/balance-extension',{dueAt:'2028-02-31T10:00:00.000Z',note:'Invalid calendar day rejected'});
    assert.equal(invalid.status,400); assert.ok(invalid.body.fields.dueAt);
    const future = new Date(Date.now()+86400000).toISOString();
    assert.equal((await post('/api/finance/orders/ORD-HOLD/balance-extension',{dueAt:future,note:'Customer needs another day'})).status,200);
    assert.equal((await order('ORD-HOLD')).status,'Paid');
    assert.equal(await pt.holdOverdue('ORD-HOLD'),null);
    await pool.query("UPDATE orders SET balance_due_at=now()-interval '8 days' WHERE order_no='ORD-HOLD'");
    failAudit=true;
    await assert.rejects(pt.holdOverdue('ORD-HOLD'),/audit failure/); failAudit=false;
    assert.equal((await order('ORD-HOLD')).status,'Paid');
    await pt.holdOverdue('ORD-HOLD'); await pay('ORD-HOLD',50); await pt.holdOverdue('ORD-HOLD');
    assert.equal((await order('ORD-HOLD')).status,'Paid');
    await pool.query("UPDATE orders SET status='Packed' WHERE order_no='ORD-CREDIT'");
  });
  await t.test('credit cap requires a different authenticated approver, with no release before approval', async () => {
    await pool.query("UPDATE orders SET total=10000 WHERE order_no='ORD-TEST'");
    const atLimit=await post('/api/finance/orders/ORD-TEST/credit-exception',{note:'Account at the single approver limit'});
    assert.equal(atLimit.status,200); assert.equal(atLimit.body.pending,false);
    assert.equal((await order('ORD-TEST')).credit_exception_by,1);
    let r=await post('/api/finance/orders/ORD-CREDIT/credit-exception',{note:'Known customer approved credit',secondApproverId:2});
    assert.equal(r.status,200); assert.equal(r.body.pending,true);
    assert.equal((await order('ORD-CREDIT')).credit_exception_by,null);
    r=await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'approve',note:'I approve the credit request'});
    assert.equal(r.status,400); assert.ok(r.body.fields.approver);
    r=await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'approve',note:'Second Finance verified this account'},2);
    assert.equal(r.status,200); assert.equal((await order('ORD-CREDIT')).credit_exception_by,1);
    assert.equal((await order('ORD-CREDIT')).credit_second_by,2);
    assert.equal(pt.releaseDecision(await order('ORD-CREDIT'),{action:'release'}).ok,true);
    assert.equal(await pt.holdOverdue('ORD-CREDIT'),null);
    assert.equal((await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'grant',note:'bad'},3)).status,403);
    assert.equal((await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'grant',note:'bad'})).status,400);
    assert.equal((await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'revoke'})).status,200);
    assert.equal((await order('ORD-CREDIT')).credit_exception_by,null);
  });
  await t.test('unpaid fabrication, job issue and purchases blocked; named Finance override audited', async () => {
    assert.equal(pt.productionDecision(await quote()).ok,false);
    const step = await post('/api/pos/quotes/Q-PROD/step',{status:'preparing'},3);
    assert.equal(step.status,400,step.body?.error); assert.ok(step.body.fields.payment);
    let r=await post('/api/finance/quotes/Q-PROD/job',{requestKey:'job-test-000001',items:[{sku:'RM-TEST',quantity:1}]});
    assert.equal(r.status,400); assert.ok(r.body.fields.payment);
    await pool.query(`INSERT INTO purchase_suggestions(product_id,sku,name,unit,quantity,quote_id,quote_no)
      SELECT 1,'RM-TEST','Test metal','kg',1,quote_id,quote_no FROM quote_requests WHERE quote_no='Q-PROD'`);
    r=await post('/api/finance/purchase-suggestions/1',{status:'ordered'});
    assert.equal(r.status,400); assert.ok(r.body.fields.payment);
    assert.equal((await pool.query('SELECT status FROM purchase_suggestions')).rows[0].status,'open');
    assert.equal((await post('/api/finance/quotes/Q-PROD/production-override',{note:'Priority job authorized by Finance'},3)).status,403);
    assert.equal((await post('/api/finance/quotes/Q-PROD/production-override',{note:'Priority job authorized by Finance'})).status,200);
    assert.equal(pt.productionDecision(await quote()).ok,true);
    assert.equal((await quote()).production_override_name,'Test Finance 1');
    assert.equal((await post('/api/finance/purchase-suggestions/1',{status:'ordered'})).status,200);
    assert.equal((await post('/api/finance/quotes/Q-PROD/production-override',{action:'revoke',note:'Payment must be collected first'})).status,200);
    await tx((db)=>pt.applyPayment(db,{kind:'quote',no:'Q-PROD',amount:50,method:'Cash',actor}));
    assert.equal(pt.productionDecision(await quote()).ok,true);
    await pool.query("UPDATE quote_requests SET terms_condition='balance due before production starts' WHERE quote_no='Q-PROD'");
    assert.equal(pt.productionDecision(await quote()).ok,false);
    await pool.query("UPDATE quote_requests SET terms_condition='balance due before release' WHERE quote_no='Q-PROD'");
    await pool.query("UPDATE quote_requests SET terms_key='full', terms_percent=100, terms_amount=100 WHERE quote_no='Q-PROD'");
    assert.equal(pt.productionDecision(await quote()).ok,false);
    await pool.query("UPDATE quote_requests SET terms_key='half', terms_percent=50, terms_amount=50, terms_state='proposed' WHERE quote_no='Q-PROD'");
    assert.equal(pt.productionDecision(await quote()).ok,false);
    await pool.query("UPDATE quote_requests SET terms_state='approved' WHERE quote_no='Q-PROD'");
  });
  await t.test('made-to-order deposit decision requires a note, retains only deposit, preserves ledger, refunds through applyPayment', async () => {
    const o=await order('ORD-HOLD');
    await pool.query("UPDATE quote_requests SET converted_order_id=$1 WHERE quote_no='Q-PROD'",[o.order_id]);
    const decide=(body,code='changed_mind')=>tx((db)=>pt.cancellationPolicy(db,o,code,{reasonCode:code,...body},actor));
    await assert.rejects(decide({}),e=>!!e.fields.depositDisposition);
    await assert.rejects(decide({depositDisposition:'forfeit',note:'bad'}),e=>!!e.fields.note);
    assert.equal(await decide({depositDisposition:'forfeit',note:'Custom material cannot be reused'}),50);
    assert.equal((await order('ORD-HOLD')).paid_amount,'100.00');
    const count=Number((await pool.query('SELECT count(*) n FROM payments')).rows[0].n);
    assert.equal((await order('ORD-HOLD')).forfeited_amount,'50.00');
    const original = (await pool.query("SELECT payment_id FROM payments WHERE order_id=$1 AND direction='in' LIMIT 1",[o.order_id])).rows[0];
    const rejected = await post('/api/finance/orders/ORD-HOLD/refund',{paymentId:Number(original.payment_id),amount:60,note:'Attempt to spend retained deposit'});
    assert.equal(rejected.status,400); assert.ok(rejected.body.fields.amount);
    const retained=await order('ORD-HOLD');
    await assert.rejects(tx((db)=>pt.refundOrderPayments(db,retained,100,actor,'refund')),e=>!!e.fields.amount);
    assert.equal(Number((await pool.query('SELECT count(*) n FROM payments')).rows[0].n),count);
    assert.equal(await decide({depositDisposition:'refund',note:'Finance approves a full refund'}),0);
    const refundable=await order('ORD-HOLD');
    assert.equal(await tx((db)=>pt.refundOrderPayments(db,refundable,100,actor,'Finance cancellation refund')),100);
    assert.equal((await order('ORD-HOLD')).payment_state,'refunded');
    await assert.rejects(pool.query('DELETE FROM payments'),/append-only/);
    const ready=await order('ORD-TEST');
    assert.equal(await tx((db)=>pt.cancellationPolicy(db,ready,'changed_mind',{},actor)),0);
  });
  await t.test('overdue notification dedupes across sweeps and restarts; rules skip credit exceptions', async () => {
    await pool.query("UPDATE orders SET balance_due_at=now()-interval '8 days' WHERE order_no='ORD-CREDIT'");
    await pay('ORD-CREDIT',100);
    const saved=new Map();
    app.locals.notifications={
      notifyRole:async(role,n)=>{const key=role+':'+n.dedupeKey;if(saved.has(key))return 0;saved.set(key,n);return 1;},
      notifyUser:async()=>0
    };
    const a=require('../balance-reminders')(deps), b=require('../balance-reminders')(deps);
    assert.equal((await a.check()).checked,true);
    assert.equal((await b.check()).checked,true);
    assert.equal((await order('ORD-CREDIT')).status,'On Hold');
    const notices=[...saved.values()].filter(n=>n.title==='On Hold — balance unpaid');
    assert.equal(notices.length,1); assert.deepEqual(notices[0].meta.actions,['extend','credit-exception','cancel']);
    assert.equal((await post('/api/finance/orders/ORD-CREDIT/credit-exception',{note:'Account credit reviewed by Finance'})).body.pending,true);
    assert.equal((await order('ORD-CREDIT')).status,'On Hold');
    assert.equal((await post('/api/finance/orders/ORD-CREDIT/credit-exception',{action:'approve',note:'Second review approved this account'},2)).status,200);
    assert.equal((await order('ORD-CREDIT')).status,'Packed');
    assert.equal(await pt.holdOverdue('ORD-CREDIT'),null);
  });
  await t.test('actual cancel route requires deposit decision and stores system code; ready stock stays refundable', async () => {
    await pool.query(`INSERT INTO orders(customer_id,fulfillment,total,order_no,terms_key,terms_amount,terms_percent)
      VALUES(1,'Pickup',100,'ORD-CANCEL','half',50,50),(1,'Pickup',100,'ORD-RETAIL','half',50,50);
      INSERT INTO quote_requests(quote_no,customer_id,contact_name,phone,details,quantity,status,quoted_amount,converted_order_id)
      SELECT 'Q-CANCEL',1,'Synthetic','09000000000','Made to order','1 pcs','accepted',100,order_id FROM orders WHERE order_no='ORD-CANCEL';`);
    const forbidden=await post('/api/shop/orders/ORD-CANCEL/cancel-request',{reason:'balance_unpaid'},4);
    assert.equal(forbidden.status,400); assert.ok(forbidden.body.fields.reason);
    const publicInfo=await fetch('http://127.0.0.1:'+server.address().port+'/api/shop/info').then(r=>r.json());
    assert.equal(publicInfo.cancelReasons.balance_unpaid,undefined);
    await pay('ORD-CANCEL',50); await pay('ORD-RETAIL',50);
    const policy=await fetch('http://127.0.0.1:'+server.address().port+'/api/finance/orders/ORD-CANCEL/cancellation-policy').then(r=>r.json());
    assert.equal(policy.madeToOrder,true); assert.equal(policy.paid,50);
    await pool.query("UPDATE orders SET balance_due_at=now()-interval '8 days' WHERE order_no='ORD-CANCEL'");
    await pt.holdOverdue('ORD-CANCEL');
    let r=await post('/api/orders/ORD-CANCEL/cancel',{reasonCode:'balance_unpaid',reason:'Overdue balance cancellation'});
    assert.equal(r.status,400,r.body?.error); assert.ok(r.body.fields.depositDisposition);
    assert.equal((await order('ORD-CANCEL')).status,'On Hold');
    failAudit=true;
    r=await post('/api/orders/ORD-CANCEL/cancel',{reasonCode:'balance_unpaid',reason:'Overdue balance cancellation',depositDisposition:'forfeit',note:'Custom material has already been cut'});
    failAudit=false; assert.equal(r.status,500);
    assert.equal((await order('ORD-CANCEL')).status,'On Hold');
    assert.equal((await order('ORD-CANCEL')).deposit_disposition,null);
    r=await post('/api/orders/ORD-CANCEL/cancel',{reasonCode:'balance_unpaid',reason:'Overdue balance cancellation',depositDisposition:'forfeit',note:'Custom material has already been cut'});
    assert.equal(r.status,200,r.body?.error);
    assert.equal((await order('ORD-CANCEL')).cancel_reason_code,'balance_unpaid');
    assert.equal((await order('ORD-CANCEL')).forfeited_amount,'50.00');
    assert.equal((await pool.query("SELECT count(*) n FROM order_refund_requests WHERE order_id=$1",[(await order('ORD-CANCEL')).order_id])).rows[0].n,'0');
    r=await post('/api/orders/ORD-RETAIL/cancel',{reasonCode:'changed_mind',reason:'Customer no longer needs stock'});
    assert.equal(r.status,200,r.body?.error);
    assert.equal((await order('ORD-RETAIL')).forfeited_amount,'0.00');
    assert.equal((await pool.query("SELECT amount FROM order_refund_requests WHERE order_id=$1",[(await order('ORD-RETAIL')).order_id])).rows[0].amount,'50.00');
  });

});
