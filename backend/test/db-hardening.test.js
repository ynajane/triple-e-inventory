/* db-hardening.test.js — runs db/025_security_hardening.sql on a REAL PostgreSQL engine (PGlite, in memory — your live database is never touched)
   and proves what it promises: safe to run twice, old data keeps working, tampering with the audit log fails, bad data is rejected,
   one-time codes can only be stored hashed, RLS locks out the web roles, the purge removes only expired rows.
     node test/db-hardening.test.js        (needs the dev dependency:  npm install) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '..', 'db');
const read = (f) => fs.readFileSync(path.join(DB, f), 'utf8');
const MIGRATION = read('025_security_hardening.sql');
const HASH = 'a'.repeat(64);

let PGlite = null;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { /* the engine tests are skipped, the static ones still run */ }
const engine = { skip: PGlite ? false : 'run "npm install" in backend/ to get the dev dependency @electric-sql/pglite' };

/* a database as it is in production before this migration: core schema + seed + customer registration, an old account that has
   a mixed-case email, and Supabase's two web roles */
async function oldDatabase() {
  const db = new PGlite();
  await db.exec(read('001_schema.sql')); await db.exec(read('002_seed.sql')); await db.exec(read('009_customer_registration.sql'));
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
                 GRANT USAGE ON SCHEMA public TO anon, authenticated; GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;`);
  await db.exec(`INSERT INTO users (full_name, username, email, password_hash, role_id)
                 SELECT 'Old Admin', 'oldadmin', 'Old.Admin@Example.com', 'x', role_id FROM roles WHERE role_key = 'finance';
                 INSERT INTO users (full_name, username, email, password_hash, role_id)
                 SELECT 'Ana Cruz', 'ana', 'ana@example.com', 'x', role_id FROM roles WHERE role_key = 'customer';`);
  return db;
}
const fails = async (p, re) => { try { await p; } catch (e) { if (re) assert.match(String(e.message), re); return true; } return false; };

test('static: the migration is transactional, idempotent and destroys nothing', () => {
  assert.match(MIGRATION, /^BEGIN;/m); assert.match(MIGRATION, /^COMMIT;/m);
  assert.ok(!/\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE|ROLE)\b/i.test(MIGRATION), 'must not drop anything');
  assert.ok(!/\bTRUNCATE\s+(TABLE\s+)?(?!ON\b)\w/i.test(MIGRATION.replace(/REVOKE[^;]*;/gi, '').replace(/BEFORE TRUNCATE[^;]*;/gi, '')), 'must not truncate data');
  assert.ok(!/\bDELETE\s+FROM\s+(?!login_otps|phone_otps|password_otps|email_verifications|login_lockouts)\w+/i.test(MIGRATION), 'deletes only expired security rows (inside the purge function)');
  assert.ok(!/PASSWORD\s+'/i.test(MIGRATION), 'no passwords in SQL');
  for (const stmt of MIGRATION.match(/CREATE TABLE[^(]*/gi)) assert.match(stmt, /IF NOT EXISTS/i, stmt);
  for (const stmt of MIGRATION.match(/ADD COLUMN[^\n]*/gi)) assert.match(stmt, /IF NOT EXISTS|phone_verified_at/i, stmt);
});

test('static: the app creates the same security tables, so the migration and the start-up code agree', () => {
  for (const [file, table] of [['login-lockout.js', 'login_lockouts'], ['phone-otp.js', 'phone_otps'], ['password-otp.js', 'password_otps'], ['login-otp.js', 'login_otps']]) {
    const js = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const cols = (src, t) => { const m = src.match(new RegExp('CREATE TABLE IF NOT EXISTS ' + t + '\\s*\\(([\\s\\S]*?)\\)(?:`|;)')); assert.ok(m, t + ' definition in ' + file); return [...m[1].matchAll(/^\s*([a-z_]+)\s+[A-Z]/gm)].map((x) => x[1]).sort(); };
    assert.deepEqual(cols(MIGRATION, table), cols(js, table), table + ' columns differ between the migration and ' + file);
  }
});

test('migration runs on the existing database, then again (idempotent), without error', engine, async () => {
  const db = await oldDatabase();
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  const t = (await db.query(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename IN ('login_otps','phone_otps','password_otps','login_lockouts')`)).rows[0].n;
  assert.equal(t, 4);
});

test('existing accounts keep working: still verified, e-mail lower-cased (the only data change), still updatable at sign-in; rows that cannot be fixed never lock anyone out', engine, async () => {
  const db = await oldDatabase();
  await db.exec(`INSERT INTO users (full_name, username, email, password_hash, role_id) SELECT 'Weird','weird','weird-address','x',role_id FROM roles WHERE role_key='cashier'`);
  await db.exec(MIGRATION);
  const u = (await db.query(`SELECT username, email, phone_verified_at IS NOT NULL AS pv, token_version FROM users ORDER BY user_id`)).rows;
  assert.equal(u.length, 3);
  assert.ok(u.every((x) => x.pv && x.token_version === 0), 'existing accounts must stay verified (no forced phone re-verification)');
  assert.equal(u.find((x) => x.username === 'oldadmin').email, 'old.admin@example.com', 'mixed-case legacy e-mail is lower-cased');
  const has = async (name) => (await db.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name])).rowCount === 1;
  assert.equal(await has('chk_users_email_lower'), true);
  assert.equal(await has('chk_users_email_shape'), false, 'skipped, because one old row has a malformed address');
  await db.query(`UPDATE users SET last_login = now()`);                    // what every sign-in does: must work for EVERY old row
  await db.exec(`UPDATE users SET email = 'weird@example.com' WHERE username = 'weird'`);
  await db.exec(MIGRATION);                                                  // after fixing the row, running the script again installs it
  assert.equal(await has('chk_users_email_shape'), true);
});

test('two accounts whose e-mail differs only by case: the script finishes, changes nothing, and installs no constraint that could lock one out', engine, async () => {
  const db = await oldDatabase();
  await db.exec(`INSERT INTO users (full_name, username, email, password_hash, role_id) SELECT 'Dup','dup','ANA@example.com','x',role_id FROM roles WHERE role_key='customer'`);
  await db.exec(MIGRATION);
  const emails = (await db.query(`SELECT email FROM users WHERE lower(email) = 'ana@example.com' ORDER BY email`)).rows.map((r) => r.email);
  assert.deepEqual(emails, ['ANA@example.com', 'ana@example.com']);
  assert.equal((await db.query(`SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_email_lower'`)).rowCount, 0);
  await db.query(`UPDATE users SET last_login = now()`);
});

test('new users: upper-case or malformed email, unknown role are rejected; normal rows are accepted', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const add = (email) => db.query(`INSERT INTO users (full_name, username, email, password_hash, role_id) SELECT 'T', $2, $1, 'x', role_id FROM roles WHERE role_key='cashier'`, [email, 'u' + Math.random().toString(36).slice(2, 8)]);
  assert.ok(await fails(add('Upper@Example.com'), /chk_users_email_lower/));
  assert.ok(await fails(add('not-an-email'), /chk_users_email_shape/));
  assert.ok(await fails(add('a b@example.com'), /chk_users_email_shape/));
  await add('good.one@example.com');
  assert.ok(await fails(db.query(`INSERT INTO roles (role_key, label) VALUES ('superadmin','Super')`), /chk_roles_known/));
});

test('audit_log: rows can be added, but never changed, deleted or truncated (even by the owner)', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  await db.query(`INSERT INTO audit_log (user_name, role_label, action, detail, ip_address, user_agent) VALUES ('Ana','Customer','Login','ok','203.0.113.9','Firefox')`);
  assert.ok(await fails(db.query(`UPDATE audit_log SET detail = 'edited'`), /append-only/));
  assert.ok(await fails(db.query(`DELETE FROM audit_log`), /append-only/));
  assert.ok(await fails(db.query(`TRUNCATE audit_log`), /append-only/));
  const r = (await db.query(`SELECT count(*)::int n, min(ip_address) ip FROM audit_log`)).rows[0];
  assert.equal(r.n, 1); assert.equal(r.ip, '203.0.113.9');
});

test('one-time codes can only be stored as a 64-hex HMAC (a plain 6-digit code is refused by the database)', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const uid = (await db.query(`SELECT user_id FROM users LIMIT 1`)).rows[0].user_id;
  const ins = (table, hash, extra) => db.query(`INSERT INTO ${table} (user_id, ${extra.cols}, code_hash, expires_at) VALUES ($1, ${extra.vals}, $2, now() + interval '5 minutes')`, [uid, hash]);
  assert.ok(await fails(ins('login_otps', '123456', { cols: 'channel, destination', vals: `'email','a@b.co'` }), /chk_login_otps_hash/));
  assert.ok(await fails(ins('login_otps', HASH, { cols: 'channel, destination', vals: `'pigeon','a@b.co'` }), /chk_login_otps_hash/));
  await ins('login_otps', HASH, { cols: 'channel, destination', vals: `'email','a@b.co'` });
  assert.ok(await fails(ins('phone_otps', '654321', { cols: 'phone', vals: `'0917'` }), /chk_phone_otps_hash/));
  assert.ok(await fails(ins('password_otps', '654321', { cols: 'purpose, channel, destination', vals: `'reset','email','a@b.co'` }), /chk_password_otps_hash/));
});

test('row level security is on for every table, and the web roles (anon, authenticated) get nothing', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const off = (await db.query(`SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity`)).rows;
  assert.deepEqual(off, [], 'tables without RLS');
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    assert.ok(await fails(db.query(`SELECT * FROM users`), /permission denied/), role + ' must not read users');
    assert.ok(await fails(db.query(`SELECT * FROM audit_log`), /permission denied/), role + ' must not read audit_log');
    assert.ok(await fails(db.query(`DELETE FROM users`), /permission denied/), role + ' must not delete');
    await db.exec(`RESET ROLE`);
  }
  const owner = (await db.query(`SELECT count(*)::int n FROM users`)).rows[0].n;
  assert.equal(owner, 2, 'the owner (the app) still reads everything');
  await db.exec(`CREATE TABLE later_table (x int)`);   // a table created after the migration is not handed to the web roles either
  await db.exec(`SET ROLE anon`);
  assert.ok(await fails(db.query(`SELECT * FROM later_table`), /permission denied/));
  await db.exec(`RESET ROLE`);
});

test('the start-up code of the app still works on top of the migrated database (no conflicts)', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const src = fs.readFileSync(path.join(__dirname, '..', 'login-otp.js'), 'utf8');
  const create = src.match(/CREATE TABLE IF NOT EXISTS login_otps[\s\S]*?\)`/)[0].replace(/`$/, '');
  await db.exec(create);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps (user_id, created_at DESC)');
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0`);
  await db.exec(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address TEXT`);
});

test('security_purge_expired removes only old codes/tokens, keeps fresh ones, never touches audit_log', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const uid = (await db.query(`SELECT user_id FROM users LIMIT 1`)).rows[0].user_id;
  await db.query(`INSERT INTO login_otps (user_id, channel, destination, code_hash, expires_at, created_at) VALUES ($1,'email','a@b.co',$2, now() - interval '9 days', now() - interval '9 days')`, [uid, HASH]);
  await db.query(`INSERT INTO login_otps (user_id, channel, destination, code_hash, expires_at) VALUES ($1,'email','a@b.co',$2, now() + interval '5 minutes')`, [uid, HASH]);
  await db.query(`INSERT INTO login_lockouts (user_id, failed_attempts, locked_at, updated_at) VALUES ($1, 3, now() - interval '30 days', now() - interval '30 days')`, [uid]);
  await db.query(`INSERT INTO audit_log (action, detail, occurred_at) VALUES ('Login','very old', now() - interval '400 days')`);
  const r = (await db.query(`SELECT security_purge_expired() AS r`)).rows[0].r;
  assert.equal(r.login_otps, 1);
  assert.equal(r.login_lockouts, 0, 'a lock that is still in force is never purged');
  assert.equal((await db.query(`SELECT count(*)::int n FROM login_otps`)).rows[0].n, 1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM audit_log`)).rows[0].n, 1, 'audit log is kept');
  await db.exec(`SET ROLE anon`);
  assert.ok(await fails(db.query(`SELECT security_purge_expired()`), /permission denied/), 'web roles cannot run the purge');
  await db.exec(`RESET ROLE`);
});

test('the real auth middleware SQL runs on the real schema: a password change signs out the OTHER device but not this one', engine, async () => {
  const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const pool = { query: (sql, p) => db.query(sql, p) };
  const { auth, forgetAccountCheck, revocation } = require('../auth-middleware')(pool);
  assert.equal(await revocation.ready, true);
  const fin = (await db.query(`SELECT user_id FROM users WHERE username = 'oldadmin'`)).rows[0].user_id;
  const app = express(); app.use(cookieParser());
  app.get('/finance', auth('finance'), (req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const session = (tv) => jwt.sign({ id: fin, name: 'Old Admin', role: 'finance', roleLabel: 'x', tv }, process.env.JWT_SECRET);
  const status = async (tv) => (await fetch(base + '/finance', { headers: { cookie: 'session=' + session(tv) } })).status;

  const phone = session(0), laptop = session(0);
  assert.equal(await status(0), 200, 'both devices are signed in');
  const newTv = await revocation.bump({ query: (s, p) => db.query(s, p) }, fin);      // what the password change does inside its transaction
  assert.equal(newTv, 1); forgetAccountCheck(fin);
  assert.equal(await status(0), 401, 'the other device (old session number) is signed out');
  assert.equal(await status(newTv), 200, 'this device gets the new session number and stays signed in');
  await db.query(`UPDATE users SET status = 'disabled' WHERE user_id = $1`, [fin]); forgetAccountCheck(fin);
  assert.equal(await status(newTv), 401, 'a disabled account is refused on its next request');
  assert.ok(phone && laptop);
  server.close();
});

test('the audit insert used by server.js (with IP address and browser) works on the migrated schema, and tolerates very long values safely', engine, async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sql = (src.match(/`(INSERT INTO audit_log \(user_id, user_name, role_label, action, detail, ip_address, user_agent\)[^`]*)`/) || [])[1];
  assert.ok(sql, 'the new audit insert must be in server.js');
  const db = await oldDatabase(); await db.exec(MIGRATION);
  await db.query(sql, [null, 'Ana Cruz', 'Customer', 'Login', 'Successful login', '::ffff:203.0.113.9', 'Mozilla/5.0']);
  const row = (await db.query(`SELECT ip_address, user_agent FROM audit_log WHERE action = 'Login'`)).rows[0];
  assert.deepEqual(row, { ip_address: '::ffff:203.0.113.9', user_agent: 'Mozilla/5.0' });
  assert.match(src, /String\(ctx\.ip\)\.slice\(0, 64\)/); assert.match(src, /String\(ctx\.ua\)\.slice\(0, 300\)/);
});

test('optional read-only auditor role: reads business data and the audit log, never secrets, never writes', engine, async () => {
  const db = await oldDatabase(); await db.exec(MIGRATION);
  const raw = read('optional/readonly-auditor-role.sql');
  // psql-only lines (\set, \gexec, :'var') are replaced so the rest of the script can run on the in-memory engine
  const sql = raw.replace(/^\\set .*$/m, '').replace(/SELECT format\('CREATE ROLE[\s\S]*?\\gexec/, `CREATE ROLE triplee_readonly LOGIN PASSWORD 'x' NOINHERIT;`);
  assert.ok(!/\\gexec|:'/.test(sql), 'all psql syntax replaced');
  assert.ok(!/PASSWORD\s+'[^']{6,}'/i.test(raw), 'no password inside the file');
  await db.exec(sql); await db.exec(sql.replace(/CREATE ROLE[^;]*;/, ''));          // second run (role exists): policies are recreated, no error
  await db.exec(`INSERT INTO audit_log (action, detail) VALUES ('Login','x')`);
  await db.exec(`SET ROLE triplee_readonly`);
  assert.ok((await db.query(`SELECT count(*)::int n FROM audit_log WHERE action = 'Login'`)).rows[0].n >= 1, 'can read the audit log');
  assert.ok((await db.query(`SELECT username, status, last_login FROM users`)).rows.length >= 1, 'can read who/status/last sign-in');
  assert.ok(await fails(db.query(`SELECT password_hash FROM users`), /permission denied/), 'never the password hash');
  assert.ok(await fails(db.query(`SELECT email FROM users`), /permission denied/), 'no e-mail addresses');
  assert.ok(await fails(db.query(`SELECT * FROM login_otps`), /permission denied/), 'no one-time codes');
  assert.ok(await fails(db.query(`SELECT * FROM login_lockouts`), /permission denied/), 'no unlock tokens');
  assert.ok(await fails(db.query(`INSERT INTO audit_log (action) VALUES ('forged')`), /permission denied|read-only/), 'cannot write');
  assert.ok(await fails(db.query(`UPDATE users SET status = 'disabled'`), /permission denied|read-only/), 'cannot change');
  assert.ok(await fails(db.query(`DELETE FROM audit_log`), /permission denied|read-only/), 'cannot delete');
  await db.exec(`RESET ROLE`);
});

test('apply-migration.js (no psql needed): the dry run rolls everything back, the real run keeps it, the role file is handled without psql syntax', engine, async () => {
  const { prepare } = require('../scripts/apply-migration');
  const dry = prepare(MIGRATION, { dryRun: true });
  assert.ok(!/^COMMIT;/m.test(dry) && /^ROLLBACK;/m.test(dry));
  const db = await oldDatabase();
  await db.exec(dry);
  const after = (await db.query(`SELECT (SELECT count(*)::int FROM pg_tables WHERE tablename = 'login_otps') AS t,
                                        (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version') AS c,
                                        (SELECT email FROM users WHERE username = 'oldadmin') AS e,
                                        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity) AS rls`)).rows[0];
  assert.deepEqual(after, { t: 0, c: 0, e: 'Old.Admin@Example.com', rls: 0 }, 'a dry run must change nothing: no tables, no column, same e-mail, no RLS');
  await db.exec(prepare(MIGRATION));                                              // the real run keeps the changes
  assert.equal((await db.query(`SELECT count(*)::int n FROM pg_tables WHERE tablename = 'login_otps'`)).rows[0].n, 1);

  assert.throws(() => prepare(read('optional/readonly-auditor-role.sql')), /--ro-password/, 'the role file refuses to run without a password');
  const role = prepare(read('optional/readonly-auditor-role.sql'), { roPassword: 'x' });
  assert.ok(!/\\gexec|^\\set|:'ro_password'/m.test(role), 'no psql-only syntax is left');
  assert.throws(() => prepare('SELECT 1;', { dryRun: true }), /COMMIT/, 'a file that cannot be rolled back is refused for a dry run');
});

/* ---------- db/026_user_sessions.sql + device limits, on the real engine ---------- */
const SESSIONS_SQL = read('026_user_sessions.sql');
async function sessionDb() { const db = await oldDatabase(); await db.exec(MIGRATION); await db.exec(SESSIONS_SQL); return db; }

test('026: the migration runs twice, matches the table the server creates by itself, and puts it under RLS', engine, async () => {
  const cols = (src) => { const m = src.match(/CREATE TABLE IF NOT EXISTS user_sessions\s*\(([\s\S]*?)\)(?:`|;)/); assert.ok(m); return [...m[1].matchAll(/^\s*([a-z_]+)\s+[A-Z]/gm)].map((x) => x[1]).sort(); };
  assert.deepEqual(cols(SESSIONS_SQL), cols(fs.readFileSync(path.join(__dirname, '..', 'auth-middleware.js'), 'utf8')), 'migration and server start-up agree');
  const db = await sessionDb(); await db.exec(SESSIONS_SQL);
  assert.equal((await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'user_sessions'`)).rows[0].relrowsecurity, true);
  await db.exec(`SET ROLE anon`);
  assert.ok(await fails(db.query(`SELECT * FROM user_sessions`), /permission denied/));
  await db.exec(`RESET ROLE`);
  // the server's own start-up path on a database that never saw the migration
  const bare = await oldDatabase(); await bare.exec(MIGRATION);
  const mw = require('../auth-middleware')({ query: (s, p) => bare.query(s, p) });
  assert.equal(await mw.sessions.ready, true);
  assert.equal((await bare.query(`SELECT count(*)::int n FROM pg_tables WHERE tablename = 'user_sessions'`)).rows[0].n, 1);
});

test('device limits: customer 3 (the 4th sign-in ends the OLDEST), finance 1 (a new sign-in ends the old one), checked through the real middleware', engine, async () => {
  const express = require('express'), cookieParser = require('cookie-parser'), jwt = require('jsonwebtoken');
  process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123456';
  const db = await sessionDb();
  const pool = { query: (s, p) => db.query(s, p) };
  const { auth, sessions } = require('../auth-middleware')(pool);
  const ids = Object.fromEntries((await db.query(`SELECT username, user_id FROM users`)).rows.map((r) => [r.username, r.user_id]));
  const app = express(); app.use(cookieParser());
  app.get('/me', auth(), (req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookie = (userId, role, sid) => 'session=' + jwt.sign({ id: userId, name: 'T', role, roleLabel: role, tv: 0, sid }, process.env.JWT_SECRET);
  const code = async (userId, role, sid) => { const r = await fetch(base + '/me', { headers: { cookie: cookie(userId, role, sid) } }); return r.status === 200 ? 200 : (await r.json()).code; };
  const signIn = async (userId, limit) => { const sid = await sessions.create({ userId, ttlMs: 8 * 3600000, ip: '203.0.113.5', ua: 'test' }); await sessions.enforceLimit(userId, limit); await new Promise((r) => setTimeout(r, 5)); return sid; };

  const ana = ids.ana, devices = [];
  for (let i = 0; i < 3; i++) devices.push(await signIn(ana, 3));                 // phone, laptop, tablet
  for (const d of devices) assert.equal(await code(ana, 'customer', d), 200, 'three devices are allowed');
  const fourth = await signIn(ana, 3);
  assert.equal(await code(ana, 'customer', devices[0]), 'SESSION_REPLACED', 'the oldest device is signed out');
  assert.equal(await code(ana, 'customer', devices[1]), 200); assert.equal(await code(ana, 'customer', devices[2]), 200); assert.equal(await code(ana, 'customer', fourth), 200);
  assert.equal((await db.query(`SELECT revoked_reason FROM user_sessions WHERE session_id = $1`, [devices[0]])).rows[0].revoked_reason, 'limit');

  // logging out frees a place: nobody else is signed out by the next sign-in
  assert.equal(await sessions.revoke(devices[1], 'logout'), 1);
  const fifth = await signIn(ana, 3);
  assert.equal(await code(ana, 'customer', devices[2]), 200); assert.equal(await code(ana, 'customer', fourth), 200); assert.equal(await code(ana, 'customer', fifth), 200);
  assert.equal(await code(ana, 'customer', devices[1]), 'SESSION_REPLACED', 'a logged-out device cannot be reused');

  // finance: limit 1
  const admin = ids.oldadmin, a1 = await signIn(admin, 1);
  assert.equal(await code(admin, 'finance', a1), 200);
  const a2 = await signIn(admin, 1);
  assert.equal(await code(admin, 'finance', a1), 'SESSION_REPLACED', 'the first device is signed out at once'); assert.equal(await code(admin, 'finance', a2), 200);

  // a session id belongs to one account: another account's sid is not valid here
  assert.equal(await code(admin, 'finance', fifth), 'SESSION_REPLACED', "another account's sid is not valid for this account");
  server.close();
});

test('sessions: expired ones do not count toward the limit; a password change keeps only the current device; the purge removes old ended sessions', engine, async () => {
  const db = await sessionDb();
  const client = { query: (s, p) => db.query(s, p) };
  const { sessions } = require('../auth-middleware')(client);
  const ana = (await db.query(`SELECT user_id FROM users WHERE username = 'ana'`)).rows[0].user_id;
  const live = async () => (await db.query(`SELECT count(*)::int n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [ana])).rows[0].n;

  await db.query(`INSERT INTO user_sessions (session_id, user_id, created_at, expires_at) VALUES ('33333333-3333-4333-8333-333333333333', $1, now() - interval '2 days', now() - interval '1 day')`, [ana]);
  for (let i = 0; i < 3; i++) { await sessions.create({ userId: ana, ttlMs: 3600000 }); await sessions.enforceLimit(ana, 3); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(await live(), 3, 'the expired session did not use up a place, so nobody live was signed out');

  const keep = (await db.query(`SELECT session_id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at LIMIT 1`, [ana])).rows[0].session_id;
  assert.equal(await sessions.revokeOthers(client, ana, keep, 'password'), 3 - 1 + 1, 'two live devices plus the long-expired record end; the current one stays');
  assert.equal(await live(), 1);
  assert.equal((await db.query(`SELECT session_id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [ana])).rows[0].session_id, keep, 'this device stays signed in');
  assert.equal(await sessions.revokeOthers(client, ana, null, 'password'), 1, 'a reset (no current device) ends them all');

  await db.query(`INSERT INTO user_sessions (session_id, user_id, created_at, expires_at, revoked_at, revoked_reason) VALUES ('44444444-4444-4444-8444-444444444444', $1, now() - interval '10 days', now() - interval '9 days', now() - interval '9 days', 'logout')`, [ana]);
  const purged = (await db.query(`SELECT security_purge_expired() AS r`)).rows[0].r;
  assert.ok(purged.user_sessions >= 1, 'old ended sessions are deleted');
  assert.equal((await db.query(`SELECT count(*)::int n FROM user_sessions WHERE session_id = '44444444-4444-4444-8444-444444444444'`)).rows[0].n, 0);
  await assert.rejects(() => db.query(`INSERT INTO user_sessions (session_id, user_id, expires_at, revoked_at) VALUES ('55555555-5555-4555-8555-555555555555', $1, now(), now())`, [ana]), /chk_user_sessions_revoked/, 'a revoked session must say why');
});
