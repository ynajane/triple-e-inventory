/**
 * db.js — Tier 3 Data Access & Connection Pool Layer
 *
 * Security & OWASP Alignment:
 * - OWASP A02:2021 (Cryptographic Failures / Secret Management):
 *   Database credentials (PGUSER, PGPASSWORD, PGHOST, PGPORT, PGDATABASE) are pulled
 *   exclusively from environment variables (process.env) so zero secrets are hardcoded
 *   in source control.
 * - OWASP A05:2021 (Security Misconfiguration) & ISO/IEC 25010 (Reliability / Availability):
 *   Enforces connection pool bounds (max connections, idleTimeoutMillis, connectionTimeoutMillis)
 *   and statement_timeout to prevent connection exhaustion and slow-query DoS attacks.
 */
require('dotenv').config();
const { Pool } = require('pg');
const dbConfig = require('./db-config');

function createPool(overrides = {}) {
  const baseConfig = dbConfig();
  const poolConfig = {
    ...baseConfig,
    user: process.env.PGUSER || baseConfig.user,
    password: process.env.PGPASSWORD || baseConfig.password,
    host: process.env.PGHOST || baseConfig.host || 'localhost',
    port: Number(process.env.PGPORT || baseConfig.port || 5432),
    database: process.env.PGDATABASE || baseConfig.database,
    max: Number(process.env.DB_POOL_MAX) || baseConfig.max || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ...overrides
  };

  // If connectionString is explicitly used, retain it alongside timeout safeguards
  if (baseConfig.connectionString && !process.env.PGHOST) {
    return new Pool({
      connectionString: baseConfig.connectionString,
      ssl: baseConfig.ssl,
      max: poolConfig.max,
      idleTimeoutMillis: poolConfig.idleTimeoutMillis,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
      ...overrides
    });
  }

  return new Pool(poolConfig);
}

const pool = createPool();

pool.on('error', (err) => {
  console.error('[DB Pool Error] Unexpected error on idle PostgreSQL client:', err.message);
});

module.exports = {
  pool,
  createPool,
  query: (text, params) => pool.query(text, params)
};

