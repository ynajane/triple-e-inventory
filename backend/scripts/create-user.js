// Usage: node scripts/create-user.js "Full Name" username email password finance|cashier|customer
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const [name, username, email, password, roleKey = 'finance'] = process.argv.slice(2);
if (!password) { console.error('Usage: node scripts/create-user.js "Full Name" username email password [finance|cashier|customer]'); process.exit(1); }

const problems = [];
if (!name || name.trim().length < 2 || name.length > 100) problems.push('Name must be 2–100 characters');
if (!/^[A-Za-z0-9._-]{3,30}$/.test(username || '')) problems.push('Username must be 3–30 characters (letters, numbers, . _ -)');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) problems.push('Email address is not valid');
if (password.length < 8) problems.push('Password must be at least 8 characters');
if (!/[A-Za-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password))
  problems.push('Password needs a letter, a number and a symbol');
if (!['finance', 'cashier', 'customer'].includes(roleKey)) problems.push('Role must be finance, cashier or customer');
if (problems.length) { console.error('Cannot create user:\n - ' + problems.join('\n - ')); process.exit(1); }

(async () => {
  const pool = new Pool(require('../db-config')());
  const hash = await bcrypt.hash(password, 12);
  const r = await pool.query(
    `INSERT INTO users (full_name, username, email, password_hash, role_id)
     VALUES ($1,$2,lower($3),$4,(SELECT role_id FROM roles WHERE role_key=$5)) RETURNING user_id`,
    [name.trim(), username, email, hash, roleKey]);
  // accounts made by an administrator with this script count as verified (needs the column from db/008 or a server start)
  await pool.query('UPDATE users SET email_verified_at = now() WHERE user_id = $1', [r.rows[0].user_id]).catch(() => {});
  console.log('Created user', r.rows[0].user_id);
  await pool.end();
})().catch(e => {
  console.error(e.code === '23505' ? 'That username or email already exists' : e.message);
  process.exit(1);
});
