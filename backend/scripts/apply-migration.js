/* apply-migration.js — runs a .sql file from backend/db against the database in backend/.env, without needing psql.

   Rehearse first (everything runs, then is ROLLED BACK; nothing is kept):
     node scripts/apply-migration.js db/025_security_hardening.sql --dry-run
   Then apply for real (asks you to type YES; take a backup first):
     node scripts/apply-migration.js db/025_security_hardening.sql
   Optional read-only auditor login (password typed here, never stored in a file):
     node scripts/apply-migration.js db/optional/readonly-auditor-role.sql --ro-password="a-long-random-password"

   Connects exactly like the server (db-config.js: DATABASE_URL or DB_*, DB_SSL). The password is never printed. */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* Turns the file into what can be sent over a normal connection. Pure function (tested in test/db-hardening.test.js). */
function prepare(sql, { dryRun = false, roPassword = '' } = {}) {
  let out = sql;
  if (/^\\\w/m.test(out) || /:'ro_password'/.test(out)) {
    // psql-only syntax in the optional read-only role file: handled here instead
    if (/:'ro_password'/.test(out) && !roPassword) throw new Error('This file needs a password for the new login: add --ro-password="..."');
    out = out.replace(/^\\set .*$/m, '');
    out = out.replace(/SELECT format\('CREATE ROLE[\s\S]*?\\gexec/, '/* role is created by apply-migration.js before this script */');
  }
  if (dryRun) {
    if (!/^COMMIT;\s*$/m.test(out)) throw new Error('Dry run needs the file to end with COMMIT; it does not, so it cannot be rolled back safely.');
    out = out.replace(/^COMMIT;\s*$/m, 'ROLLBACK;');
  }
  return out;
}

const hostOf = (cfg) => {
  if (cfg.connectionString) { const s = cfg.connectionString; return s.slice(s.lastIndexOf('@') + 1); }   // never shows the password
  return (cfg.host || 'localhost') + ':' + (cfg.port || 5432) + '/' + (cfg.database || '');
};
const ask = (q) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); res(a); }); });

async function main() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const roArg = args.find((a) => a.startsWith('--ro-password='));
  if (!file) { console.error('Usage: node scripts/apply-migration.js db/025_security_hardening.sql [--dry-run] [--ro-password="..."]'); process.exit(1); }
  const full = path.resolve(path.join(__dirname, '..'), file);
  if (!full.startsWith(path.resolve(__dirname, '..', 'db') + path.sep) || !full.endsWith('.sql') || !fs.existsSync(full)) {
    console.error('Only .sql files inside backend/db can be applied. Not found or not allowed: ' + file); process.exit(1);
  }
  const { Pool } = require('pg');
  const cfg = require('../db-config')();
  const roPassword = roArg ? roArg.slice('--ro-password='.length) : '';
  const sql = prepare(fs.readFileSync(full, 'utf8'), { dryRun, roPassword });

  console.log('\nFile    : ' + path.relative(path.join(__dirname, '..'), full));
  console.log('Database: ' + hostOf(cfg));
  console.log('Mode    : ' + (dryRun ? 'DRY RUN (everything is rolled back at the end)' : 'APPLY FOR REAL'));
  if (!dryRun) {
    console.log('\nHave you taken a backup (scripts/backup.sh or the Supabase dashboard)? Run with --dry-run first if unsure.');
    if ((await ask('Type YES to continue: ')).trim() !== 'YES') { console.log('Cancelled. Nothing was changed.'); process.exit(0); }
  }

  const pool = new Pool({ ...cfg, max: 1 });
  const client = await pool.connect();
  client.on('notice', (n) => console.log('  NOTICE: ' + n.message));
  try {
    if (roPassword) {
      const exists = (await client.query(`SELECT 1 FROM pg_roles WHERE rolname = 'triplee_readonly'`)).rowCount;
      if (!exists) {
        await client.query(`CREATE ROLE triplee_readonly LOGIN PASSWORD ${client.escapeLiteral(roPassword)} NOINHERIT CONNECTION LIMIT 3`);
        console.log('  created login triplee_readonly');
      }
    }
    console.log('\nRunning...');
    await client.query(sql);
    console.log(dryRun ? 'Dry run finished: no error. Everything was rolled back, the database is unchanged.' : 'Done: no error.');
    if (!dryRun && /025_security_hardening/.test(full)) {
      const q = async (s) => (await client.query(s)).rows[0];
      console.log('\nCheck:');
      console.log('  tables without Row Level Security :', (await q(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`)).n, '(want 0)');
      console.log('  users.token_version exists        :', !!(await q(`SELECT 1 AS x FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'token_version'`)));
      console.log('  audit_log append-only triggers    :', (await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND tgname IN ('trg_audit_append_only', 'trg_audit_no_truncate')`)).n, '(want 2)');
      console.log('  constraints installed             :', (await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE 'chk\\_%'`)).n, '(NOTICE lines above explain any that were skipped)');
      console.log('  purge function                    :', JSON.stringify((await q(`SELECT security_purge_expired() AS r`)).r));
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already reset */ }
    console.error('\nFAILED, and rolled back (the database is unchanged): ' + e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}

module.exports = { prepare };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
