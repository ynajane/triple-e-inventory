'use strict';
// Connects with the same settings as the server and says what is wrong, without printing the password.
//   PowerShell:  $env:DATABASE_URL="postgresql://..."; $env:DB_SSL="require"; node scripts/test-db.js
require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const dbConfig = require('../db-config');

const HINTS = {
  '28P01': 'Wrong password. Reset it in Supabase > Project Settings > Database and update DATABASE_URL.',
  'XX000': 'Supabase does not recognise the user/project. Copy the connection string again from Supabase > Connect.',
  ENOTFOUND: 'The host name in DATABASE_URL is wrong. Copy the connection string again from Supabase > Connect.',
  ETIMEDOUT: 'Could not reach the database. Check the host and port (6543 for the transaction pooler).',
  ECONNREFUSED: 'Nothing is listening at that host/port. DATABASE_URL is probably missing or wrong.'
};

(async () => {
  const cfg = dbConfig();
  if (cfg.connectionString) {
    try { const u = new URL(cfg.connectionString); console.log('Host:', u.hostname, ' Port:', u.port || 5432, ' User:', decodeURIComponent(u.username)); }
    catch { console.log('DATABASE_URL is not a valid URL. Check for brackets, spaces or special characters in the password.'); process.exit(1); }
    if (/\[|\]|YOUR-PASSWORD/i.test(cfg.connectionString)) { console.log('DATABASE_URL still contains [YOUR-PASSWORD]. Put the real password in.'); process.exit(1); }
  } else console.log('DATABASE_URL is not set; using DB_HOST/DB_* settings (host ' + cfg.host + ').');

  const pool = new Pool({ ...cfg, max: 1, connectionTimeoutMillis: 10000 });
  try {
    await pool.query('SELECT 1');
    console.log('OK: connected to the database.');
    const t = await pool.query("SELECT to_regclass('public.users') AS users, to_regclass('public.roles') AS roles");
    if (!t.rows[0].users || !t.rows[0].roles) console.log('PROBLEM: the tables are missing. Run the setup SQL in Supabase > SQL Editor.');
    else {
      const n = await pool.query('SELECT count(*)::int AS n FROM users');
      console.log('OK: tables exist (' + n.rows[0].n + ' users).');
    }
  } catch (err) {
    console.log('FAILED:', err.code || '', err.message);
    const hint = HINTS[err.code] || (/self[- ]signed|certificate/i.test(err.message) ? 'SSL problem. Set DB_SSL=require (without DB_SSL_CA).' : '');
    if (hint) console.log('Fix:', hint);
    process.exitCode = 1;
  } finally { await pool.end(); }
})();
