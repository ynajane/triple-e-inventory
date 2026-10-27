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
test('account deletion and restoration preserve identity and access boundaries', {timeout:60000}, async t => {
 const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'triplee-users-'));
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
  JWT_SECRET: require('node:crypto').randomBytes(32).toString('hex'), ADDRESS_CHECK: 'off', LOGIN_OTP: 'off', SHIFT_FORCE_CLOSE_MINUTES: '0', ENFORCE_STORE_HOURS: 'false' };
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
 const request = async (route, method = 'GET', body, cookie) => {
  const r = await fetch(base+route, {method, headers:{'content-type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{})}, body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status, json:await r.json(), cookie:r.headers.get('set-cookie')?.split(';')[0]};
 };
 const accounts = {};
 for (const [name,role] of [['admin','finance'],['other','finance'],['cashier','cashier'],['customer','customer']]) {
  command(process.execPath,['scripts/create-user.js','Synthetic '+name,name,name+'@example.invalid',password,role],env);
  const r = await request('/api/auth/login','POST',{email:name+'@example.invalid',password});
  assert.equal(r.status,200,JSON.stringify(r.json));
  const id = (await pool.query('SELECT user_id FROM users WHERE username=$1',[name])).rows[0].user_id;
  accounts[name] = {id,cookie:r.cookie};
 }
 const {admin,other,cashier,customer} = accounts;
 const api = (route, method, body) => request(route,method,body,admin.cookie);
 const pathFor = '/api/users/'+customer.id;
 await pool.query(`INSERT INTO orders(customer_id,fulfillment,payment_method,subtotal,total) VALUES ($1,'Pickup','Cash',100,100)`,[customer.id]);
 await pool.query(`INSERT INTO audit_log(user_id,user_name,action,detail) VALUES ($1,'Synthetic customer','Record created','Keep attribution')`,[customer.id]);
 const before = (await pool.query('SELECT token_version FROM users WHERE user_id=$1',[customer.id])).rows[0].token_version;
 await t.test('Finance-only soft delete retains linked history, revokes access and is idempotent', async () => {
  assert.equal((await request(pathFor,'DELETE',undefined,cashier.cookie)).status,403);
  assert.equal((await request(pathFor,'DELETE',undefined,customer.cookie)).status,403);
  assert.equal((await api('/api/users/'+admin.id,'DELETE')).status,400);
  const deleted = await Promise.all([api(pathFor,'DELETE'),api(pathFor,'DELETE')]);
  assert.ok(deleted.every(r=>r.status===200),JSON.stringify(deleted));
  assert.equal(deleted.filter(r=>r.json.changed).length,1);
  const saved=(await pool.query('SELECT * FROM users WHERE user_id=$1',[customer.id])).rows[0];
  assert.equal(saved.status,'disabled'); assert.ok(saved.deleted_at); assert.equal(saved.deleted_by,admin.id);
  assert.equal(saved.token_version,before+1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM orders WHERE customer_id=$1',[customer.id])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE user_id=$1 AND detail='Keep attribution'",[customer.id])).rows[0].n,1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='Account deleted'")).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM user_sessions WHERE user_id=$1 AND revoked_at IS NULL',[customer.id])).rows[0].n,0);
  assert.equal((await request('/api/auth/me','GET',undefined,customer.cookie)).status,401);
  assert.equal((await request('/api/auth/login','POST',{email:'customer@example.invalid',password})).status,401);
  assert.ok(!(await api('/api/users')).json.some(u=>u.id===customer.id));
  assert.deepEqual((await api('/api/users?deleted=1')).json.map(u=>u.id),[customer.id]);
  assert.ok(!(await request('/api/pos/customer-directory','GET',undefined,cashier.cookie)).json.some(u=>u.id===customer.id));
  assert.equal((await api('/api/customers/'+customer.id+'/profile')).status,404);
  assert.equal((await api(pathFor+'/profile')).status,200,'archived details remain available to Finance');
  assert.equal((await api(pathFor+'/status','PATCH',{status:'active'})).status,409);
  assert.equal((await api(pathFor,'PATCH',{roleKey:'customer'})).status,400);
  await assert.rejects(pool.query("UPDATE users SET status='active' WHERE user_id=$1",[customer.id]),/users_deleted_disabled/);
 });
 await t.test('deleted state and revocation survive a server restart', async () => {
  child.kill(); await once(child,'exit'); output='';
  child=spawn(process.execPath,['server.js'],{cwd:root,env:{...env,PORT:String(port),APP_BASE_URL:base},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',d=>{output+=d;}); child.stderr.on('data',d=>{output+=d;});
  for(let i=0;i<150&&!output.includes('cash shift schema ready');i++)await delay(100);
  await delay(500);
  assert.deepEqual((await api('/api/users?deleted=1')).json.map(u=>u.id),[customer.id]);
  assert.equal((await request('/api/auth/me','GET',undefined,customer.cookie)).status,401);
  assert.equal((await api(pathFor,'DELETE')).json.changed,false);
 });
 await t.test('restore remains disabled and old cookies never become valid after enabling', async () => {
  assert.equal((await request(pathFor+'/restore','POST',undefined,cashier.cookie)).status,403);
  const restored=await api(pathFor+'/restore','POST');
  assert.equal(restored.status,200); assert.equal(restored.json.status,'disabled');
  assert.equal((await api(pathFor+'/restore','POST')).json.changed,false);
  assert.ok((await api('/api/users')).json.some(u=>u.id===customer.id&&!u.deletedAt));
  assert.equal((await api('/api/users?deleted=1')).json.length,0);
  assert.equal((await request('/api/auth/me','GET',undefined,customer.cookie)).status,401);
  assert.equal((await api(pathFor+'/status','PATCH',{status:'active'})).status,200);
  assert.equal((await request('/api/auth/me','GET',undefined,customer.cookie)).status,401);
  assert.equal((await request('/api/auth/login','POST',{email:'customer@example.invalid',password})).status,200);
  assert.equal((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='Account restored'")).rows[0].n,1);
 });
 await t.test('failed audit rolls back deletion and token/session revocation', async () => {
  await pool.query(`CREATE FUNCTION reject_delete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='Account deleted' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER reject_delete_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_delete_audit()`);
  const tv=(await pool.query('SELECT token_version FROM users WHERE user_id=$1',[cashier.id])).rows[0].token_version;
  assert.equal((await api('/api/users/'+cashier.id,'DELETE')).status,500);
  const row=(await pool.query('SELECT status,deleted_at,token_version FROM users WHERE user_id=$1',[cashier.id])).rows[0];
  assert.deepEqual(row,{status:'active',deleted_at:null,token_version:tv});
  assert.equal((await request('/api/auth/me','GET',undefined,cashier.cookie)).status,200);
  await pool.query('DROP TRIGGER reject_delete_audit ON audit_log; DROP FUNCTION reject_delete_audit()');
 });
 await t.test('opposing Finance deletion/status requests cannot remove every active administrator', async () => {
  const result=await Promise.all([
   api('/api/users/'+other.id,'DELETE'),
   request('/api/users/'+admin.id+'/status','PATCH',{status:'disabled'},other.cookie)
  ]);
  assert.equal(result.filter(r=>r.status===200).length,1,JSON.stringify(result));
  assert.equal((await pool.query("SELECT count(*)::int n FROM users u JOIN roles r USING(role_id) WHERE role_key='finance' AND status='active' AND deleted_at IS NULL")).rows[0].n,1);
 });
 assert.doesNotMatch(output,/unhandled rejection|uncaught exception|error: column|error: relation/i);
});
