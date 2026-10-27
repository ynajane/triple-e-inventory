-- 026_user_sessions.sql — one row per signed-in device, so each role can have a LIMIT on devices at once
-- (OWASP A07 / ASVS V3.3 concurrent session control). Default limits (SESSION_LIMITS in backend/.env): finance 1, cashier 1, customer 3.
--
-- The server creates this table by itself at start-up (same definition), so running this file is optional; it keeps the schema documented and
-- puts the table under Row Level Security like everything else. Safe to run more than once; nothing is dropped or deleted.
--   cd backend && node scripts/apply-migration.js db/026_user_sessions.sql --dry-run     (rehearsal, rolled back)
--   cd backend && node scripts/apply-migration.js db/026_user_sessions.sql
-- Run it after db/025_security_hardening.sql (it needs the users table and replaces the purge function from 025).
BEGIN;

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id     UUID PRIMARY KEY,
  user_id        INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  ip_address     TEXT,
  user_agent     TEXT);
-- the limit check and the per-request check only ever look at a person's live sessions
CREATE INDEX IF NOT EXISTS idx_user_sessions_live ON user_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;

-- Row Level Security and no access for Supabase's web roles, as on every other table (db/025)
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
DO $r$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN REVOKE ALL ON user_sessions FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON user_sessions FROM authenticated; END IF;
END $r$;

-- integrity: a revoked session says why, a live one does not
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_user_sessions_revoked') THEN
    IF NOT EXISTS (SELECT 1 FROM user_sessions WHERE NOT ((revoked_at IS NULL) = (revoked_reason IS NULL))) THEN
      ALTER TABLE user_sessions ADD CONSTRAINT chk_user_sessions_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL));
    END IF;
  END IF;
END $c$;

-- retention: the 6-hourly purge from db/025 now also removes sessions that ended more than 7 days ago
CREATE OR REPLACE FUNCTION security_purge_expired(retain interval DEFAULT interval '7 days') RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $p$
DECLARE n_login int; n_phone int; n_pw int; n_verify int; n_lock int; n_sess int;
BEGIN
  DELETE FROM login_otps    WHERE created_at < now() - retain;  GET DIAGNOSTICS n_login = ROW_COUNT;
  DELETE FROM phone_otps    WHERE created_at < now() - retain;  GET DIAGNOSTICS n_phone = ROW_COUNT;
  DELETE FROM password_otps WHERE created_at < now() - retain;  GET DIAGNOSTICS n_pw    = ROW_COUNT;
  DELETE FROM email_verifications WHERE created_at < now() - retain AND (used_at IS NOT NULL OR expires_at < now());  GET DIAGNOSTICS n_verify = ROW_COUNT;
  DELETE FROM login_lockouts WHERE locked_at IS NULL AND updated_at < now() - retain;  GET DIAGNOSTICS n_lock = ROW_COUNT;
  DELETE FROM user_sessions WHERE LEAST(expires_at, COALESCE(revoked_at, expires_at)) < now() - retain;  GET DIAGNOSTICS n_sess = ROW_COUNT;
  RETURN jsonb_build_object('login_otps', n_login, 'phone_otps', n_phone, 'password_otps', n_pw,
                            'email_verifications', n_verify, 'login_lockouts', n_lock, 'user_sessions', n_sess);
END $p$;
REVOKE ALL ON FUNCTION security_purge_expired(interval) FROM PUBLIC;

COMMIT;
