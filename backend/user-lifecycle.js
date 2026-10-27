'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = function userLifecycle({ pool, tx, audit, revocation, sessions, forgetAccountCheck, ValidationError }) {
  const ready = (async () => {
    const client = await pool.connect();
    try {
      await client.query(fs.readFileSync(path.join(__dirname, 'db/028_user_soft_delete.sql'), 'utf8'));
      return true;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  })().catch(e => { console.error('[users] soft delete schema setup failed:', e.message); return false; });

  async function ensureReady() {
    if (!(await ready)) throw new Error('User account storage is unavailable');
  }
  // Serialize all Finance role/status/delete/restore decisions before locking individual accounts.
  // Recheck the actor: an earlier request may have disabled them while this request waited.
  async function lock(client, actor) {
    await ensureReady();
    await client.query('SELECT pg_advisory_xact_lock(738291, 1)');
    const u = (await client.query(`SELECT u.status, u.deleted_at, r.role_key FROM users u JOIN roles r USING (role_id)
      WHERE u.user_id = $1 FOR UPDATE OF u`, [actor.id])).rows[0];
    if (!u || u.status !== 'active' || u.deleted_at || u.role_key !== 'finance') {
      throw new ValidationError({ id: 'Your Finance account is no longer active. Sign in again.' });
    }
  }
  async function change(id, actor, restore = false) {
    await ensureReady();
    // Refuse deletion if old sessions cannot be permanently revoked.
    if (!(await revocation.ready) || !(await sessions.ready)) throw new Error('Session revocation is unavailable');
    const out = await tx(async client => {
      await lock(client, actor);
      if (id === actor.id) throw new ValidationError({ id: 'You cannot delete or restore your own account. Ask another Finance-Admin.' });
      const u = (await client.query(`SELECT u.user_id, u.full_name, u.email, u.status, u.deleted_at, r.role_key
        FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1 FOR UPDATE OF u`, [id])).rows[0];
      if (!u) throw new ValidationError({ id: 'Account not found' });
      if (restore ? !u.deleted_at : !!u.deleted_at) return { name: u.full_name, changed: false };
      if (!restore && u.role_key === 'finance' && u.status === 'active') {
        const left = (await client.query(`SELECT count(*)::int AS n FROM users u JOIN roles r USING (role_id)
          WHERE r.role_key = 'finance' AND u.status = 'active' AND u.deleted_at IS NULL AND u.user_id <> $1`, [id])).rows[0].n;
        if (!left) throw new ValidationError({ id: 'At least one active Finance-Admin must remain' });
      }
      await client.query(`UPDATE users SET status = 'disabled', deleted_at = ${restore ? 'NULL' : 'now()'},
        deleted_by = ${restore ? 'NULL' : '$2'} WHERE user_id = $1`, restore ? [id] : [id, actor.id]);
      await revocation.bump(client, id);
      await sessions.revokeOthers(client, id, null, restore ? 'restored' : 'deleted');
      await audit(client, actor, restore ? 'Account restored' : 'Account deleted',
        `${u.full_name} (${u.email}) — ${restore ? 'restored as disabled; Finance must enable sign-in' : 'soft deleted; sign-in blocked and linked history retained'}`);
      return { name: u.full_name, changed: true };
    });
    forgetAccountCheck(id);
    return { ok: true, ...out, status: 'disabled', deleted: !restore };
  }
  return { ready: ensureReady, lock, change };
};
