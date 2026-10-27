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

test('real PostgreSQL stock, payment, production and recovery guarantees', { timeout: 90000 }, async (t) => {
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
  await pool.query("ALTER TABLE pos_sales ADD status TEXT DEFAULT 'Completed'");
  for (const file of ['003_cash_shift.sql', '006_shop_extras.sql', '012_quote_flow.sql']) await pool.query(sql(file));
  // Same supporting columns normally supplied by server startup, without mounting unrelated services.
  await pool.query(`ALTER TABLE orders ADD order_no TEXT UNIQUE, ADD payment_status TEXT DEFAULT 'unpaid', ADD status_updated_at TIMESTAMPTZ;
    ALTER TABLE quote_requests ADD converted_order_id INT;
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
    await c.query('INSERT INTO audit_log(user_id,user_name,role_label,action,detail) VALUES (1,$1,$2,$3,$4)', ['Test Finance','Finance',action,detail]);
  };
  const app = express(); app.use(express.json());
  const deps = { app, pool, tx, audit, ValidationError, str: (v) => typeof v === 'string' ? v.trim() : '',
    auth: () => (req, res, next) => { req.user = { id: 1, name: 'Test Finance', roleLabel: 'Finance' }; next(); },
    wrap: (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next) };
  require('../payment-terms')(deps); await app.locals.paymentTerms.ready;
  assert.equal(await require('../production')(deps).ready, true);
  await pool.query('ALTER TABLE production_records ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2)');
  app.use((err, req, res, next) => res.status(err.fields ? 400 : 500).json({ error: err.message, fields: err.fields }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const post = async (body) => {
    const r = await fetch('http://127.0.0.1:' + server.address().port + '/api/production', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const count = async (table, db = pool) => Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  const payment = (spec = {}) => tx((c) => app.locals.paymentTerms.applyPayment(c, {
    kind: 'order', no: 'ORD-TEST', amount: 40, method: 'Cash', actor: { id: 1, name: 'Test Finance' }, ...spec }));
  await t.test('concurrent stock issues cannot sell the last piece twice', async () => {
    const sell = () => tx((c) => c.query(`INSERT INTO stock_movements(product_id,movement_type,reason,quantity) VALUES (2,'out','sale',1)`));
    const results = await Promise.allSettled([sell(), sell()]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await pool.query('SELECT on_hand FROM products WHERE product_id=2')).rows[0].on_hand, '0.00');
  });
  await t.test('simultaneous payment/provider retries create one ledger row', async () => {
    const results = await Promise.all([payment({ requestId: 'same-request-000001', providerRef: 'invoice-1' }), payment({ requestId: 'same-request-000001', providerRef: 'invoice-1' })]);
    assert.equal(results[0].paymentId, results[1].paymentId);
    assert.equal(await count('payments'), 1);
    assert.equal((await pool.query('SELECT paid_amount FROM orders')).rows[0].paid_amount, '40.00');
    await assert.rejects(payment({ no: 'ORD-OTHER', requestId: 'same-request-000001' }), (e) => !!e.fields?.requestId);
    await assert.rejects(payment({ no: 'ORD-OTHER', providerRef: 'invoice-1' }), (e) => !!e.fields?.reference);
  });
  await t.test('overpayment, malformed tender and excess refunds leave balances intact', async () => {
    for (const tendered of [true, [], [100], '0x64']) await assert.rejects(payment({ tendered }), (e) => !!e.fields?.tendered);
    await assert.rejects(payment({ amount: 61 }), (e) => !!e.fields?.amount);
    const id = (await pool.query('SELECT payment_id FROM payments')).rows[0].payment_id;
    await payment({ amount: 10, direction: 'out', reversedOf: id, requestId: 'refund-request-00001' });
    await assert.rejects(payment({ amount: 31, direction: 'out', reversedOf: id }), (e) => !!e.fields?.amount);
    assert.equal((await pool.query('SELECT paid_amount FROM orders')).rows[0].paid_amount, '30.00');
  });
  await t.test('audit failure rolls back payment row and trigger-derived balance', async () => {
    const before = await count('payments'); failAudit = true;
    try { await assert.rejects(payment({ amount: 5 }), /synthetic audit failure/); } finally { failAudit = false; }
    assert.equal(await count('payments'), before);
    assert.equal((await pool.query('SELECT paid_amount FROM orders')).rows[0].paid_amount, '30.00');
  });
  await pool.query(`INSERT INTO product_materials(finished_product_id,material_product_id,qty_per_unit,unit) VALUES (2,1,2,'kg')`);
  const batch = { sku: 'FG-TEST', quantity: 1, requestKey: 'production-retry-0001', items: [{ sku: 'RM-TEST', actualQty: 2 }] };
  await t.test('concurrent production confirmation deducts and produces only once', async () => {
    const results = await Promise.all([post(batch), post(batch)]);
    for (const result of results) assert.ok([200, 201].includes(result.status), JSON.stringify(result));
    assert.equal(await count('production_records'), 1);
    assert.deepEqual((await pool.query('SELECT on_hand FROM products ORDER BY product_id')).rows.map((r) => r.on_hand), ['8.00', '1.00']);
  });
  await t.test('invalid production input, shortages and audit failure cannot partially post', async () => {
    const before = await count('stock_movements');
    for (const quantity of [true, [1], '0x10']) assert.equal((await post({ ...batch, quantity })).status, 400);
    assert.equal((await post({ ...batch, requestKey: 'production-short-0001', items: [{ sku: 'RM-TEST', actualQty: 99 }] })).status, 400);
    failAudit = true;
    try { assert.equal((await post({ ...batch, requestKey: 'production-audit-0001' })).status, 500); } finally { failAudit = false; }
    assert.equal(await count('stock_movements'), before); assert.equal(await count('production_records'), 1);
  });
  await t.test('real dump and verified scratch restore preserve row counts', async () => {
    await pool.query('CREATE DATABASE triplee_restore_test');
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, DATABASE_URL: '', PGHOST: temp,
      PGPORT: '5432', PGUSER: os.userInfo().username, PGDATABASE: 'postgres',
      TARGET_URL: 'postgresql:///triplee_restore_test?host=' + encodeURIComponent(temp) + '&user=' + encodeURIComponent(os.userInfo().username) };
    const out = path.join(temp, 'backups');
    command('bash', [path.join(root, 'scripts/backup.sh'), out], { env });
    command('bash', [path.join(root, 'scripts/restore-test.sh'), path.join(out, fs.readdirSync(out).find((n) => n.endsWith('.dump')))], { env });
    const restored = new Pool({ host: temp, user: os.userInfo().username, database: 'triplee_restore_test' });
    try { for (const table of ['users','products','stock_movements','audit_log','payments','production_records']) assert.equal(await count(table, restored), await count(table), table); }
    finally { await restored.end(); }
  });
});
