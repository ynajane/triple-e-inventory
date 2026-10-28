/* db-config.js — one place that turns backend/.env into the options for `new Pool()` (server.js, scripts/create-user.js,
   check-payments.js all use it, so they always connect the same way).

   Either   DATABASE_URL=postgresql://user:password@host:5432/dbname
   or       DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME

   SSL (needed for Supabase and most hosted Postgres):
     DB_SSL=require            encrypted connection
     DB_SSL_CA=./supabase.crt  (optional, recommended) also checks the server's certificate against this CA file
                               (Supabase: Project Settings > Database > SSL Configuration > Download certificate)
     DB_SSL=off or unset       no SSL (a database on the same computer)
   An "sslmode=..." left in DATABASE_URL is removed when DB_SSL is set, because pg would let it override these settings.
   DB_POOL_MAX (default 10) caps the open connections; keep it low on Supabase's free plan. */
const fs = require('fs');
const path = require('path');

function sslOptions() {
  const mode = String(process.env.DB_SSL || '').trim().toLowerCase();
  if (!mode || ['off', 'false', '0', 'disable', 'no'].includes(mode)) return undefined;
  const caFile = String(process.env.DB_SSL_CA || '').trim();
  if (caFile) return { ca: fs.readFileSync(path.resolve(__dirname, caFile), 'utf8'), rejectUnauthorized: true };
  return { rejectUnauthorized: false };              // encrypted, certificate not checked (set DB_SSL_CA to check it)
}

// Serverless (Vercel): every running copy of the app opens its own pool, so each one keeps very few connections and
// lets idle ones go quickly. Supabase's session pooler (port 5432) allows only ~15 clients in total; use port 6543 there.
const SERVERLESS = !!process.env.VERCEL;

module.exports = function dbConfig() {
  const ssl = sslOptions();
  const max = SERVERLESS ? Math.min(Number(process.env.DB_POOL_MAX) || 3, 5) : Number(process.env.DB_POOL_MAX) || 10;
  const extra = SERVERLESS ? { idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 } : {};
  if (process.env.DATABASE_URL) {
    let url = process.env.DATABASE_URL.trim();       // a space pasted after "=" in a host's env settings would break the URL
    if (ssl) url = url.replace(/([?&])sslmode=[^&]*(&|$)/i, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '');
    if (SERVERLESS && /pooler\.supabase\.com:5432\b/.test(url))
      console.warn('[db] DATABASE_URL uses the Supabase session pooler (port 5432); on Vercel use the transaction pooler (port 6543).');
    return { connectionString: url, ssl, max, ...extra };
  }
  return {
    host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.PGPORT || process.env.DB_PORT) || 5432,
    user: process.env.PGUSER || process.env.DB_USER,
    password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
    database: process.env.PGDATABASE || process.env.DB_NAME,
    ssl, max, ...extra
  };
};
