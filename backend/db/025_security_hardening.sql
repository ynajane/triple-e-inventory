-- 025_security_hardening.sql — database-tier security controls (OWASP A01 Broken Access Control, A02 Cryptographic Failures,
-- A04 Insecure Design, A07 Authentication Failures, A09 Logging Failures).
--
-- WHAT IT DOES
--   1. Documents the sign-in security tables that the server otherwise creates at start-up (same definitions, so nothing changes)
--   2. users.token_version: lets a password change/reset sign the user out of every other device at once
--   3. audit_log: records the IP address and browser of each action, adds indexes, and is protected against UPDATE, DELETE
--      AND TRUNCATE (the app's own trigger only covered UPDATE/DELETE) and against changes by the web-facing roles
--   4. Integrity CHECK constraints (lower-case valid email, only the 3 roles, one-time codes stored only as a 64-hex HMAC) —
--      the only data change is lower-casing e-mail addresses
--   5. Row Level Security on EVERY table in the public schema + no access for Supabase's web roles (anon, authenticated).
--      The server connects as the table owner, which is not affected; the Supabase REST API can no longer read your tables.
--   6. security_purge_expired(): removes expired one-time codes / tokens (data minimisation, RA 10173)
--
-- HOW TO RUN (once, then it is safe to run again — every statement is idempotent; nothing is dropped or deleted):
--   without psql (rehearse first, then apply):  cd backend && node scripts/apply-migration.js db/025_security_hardening.sql --dry-run
--   with psql:                                  psql "$DATABASE_URL" -f backend/db/025_security_hardening.sql
--   Use the SAME database user as DATABASE_URL in backend/.env (the owner of the tables). Take a backup first (scripts/backup.sh).
--   E-mail addresses are first converted to lower case (the app only ever matches lower case). Each new CHECK constraint is added only
--   if all existing rows already satisfy it; otherwise a NOTICE names it, the rest of the script completes, and you can fix the rows
--   and run the script again. No account can be locked out by a constraint.
BEGIN;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Sign-in security tables (identical to what login-lockout.js, phone-otp.js, password-otp.js and login-otp.js create)
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
DO $$ BEGIN
  -- accounts that already exist count as verified; only new accounts must verify their phone (same one-time backfill as phone-otp.js)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'phone_verified_at') THEN
    ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMPTZ;
    UPDATE users SET phone_verified_at = COALESCE(created_at, now());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS login_lockouts (
  user_id          INT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_at        TIMESTAMPTZ,
  token_hash       TEXT,
  token_expires_at TIMESTAMPTZ,
  unlock_until     TIMESTAMPTZ,
  last_email_at    TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS phone_otps (
  otp_id      BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  wrong_tries INT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_phone_otps_user ON phone_otps (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS password_otps (
  otp_id      BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  destination TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  wrong_tries INT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_password_otps_user ON password_otps (user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS login_otps (
  otp_id      BIGSERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  destination TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  wrong_tries INT NOT NULL DEFAULT 0,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_login_otps_user ON login_otps (user_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Session revocation: bump users.token_version and every older session cookie stops working on its next request
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 0;
COMMENT ON COLUMN users.token_version IS 'Session revocation counter. The signed session carries it; auth-middleware.js rejects a session whose number is older.';
COMMENT ON COLUMN users.password_hash IS 'bcrypt hash only. Never select it into a response and never log it.';

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Audit log: who, from where, tamper-proof
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_user_time   ON audit_log (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_time ON audit_log (action, occurred_at DESC);

-- same function and trigger security.js installs at start-up, plus a statement trigger for TRUNCATE (row triggers do not fire for it)
CREATE OR REPLACE FUNCTION block_audit_changes() RETURNS trigger AS $f$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
END $f$ LANGUAGE plpgsql;
DO $d$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_append_only' AND tgrelid = 'audit_log'::regclass) THEN
    CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION block_audit_changes();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_no_truncate' AND tgrelid = 'audit_log'::regclass) THEN
    CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION block_audit_changes();
  END IF;
END $d$;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Integrity constraints
--    A constraint is added ONLY when every existing row already satisfies it. (A NOT VALID constraint would still be checked every
--    time an old row is updated — for example the last_login update at sign-in — and could lock that account out.) If old rows break
--    a rule, a NOTICE says which, the constraint is skipped, and you can fix the rows and run this script again.
-- ---------------------------------------------------------------------------------------------------------------------
DO $n$ BEGIN
  -- the app always compares e-mail addresses in lower case (login, sign-up, profile), so an upper-case address could never sign in
  UPDATE users SET email = lower(email) WHERE email <> lower(email);
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'Some e-mail addresses differ from another account only by upper/lower case. Fix those by hand, then run this script again.';
END $n$;

DO $c$
DECLARE
  spec text[][] := ARRAY[
    ARRAY['users',          'chk_users_email_lower',   $$email = lower(email)$$],
    ARRAY['users',          'chk_users_email_shape',   $$email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' AND length(email) <= 254$$],
    ARRAY['users',          'chk_users_token_version', $$token_version >= 0$$],
    ARRAY['roles',          'chk_roles_known',         $$role_key IN ('finance','cashier','customer')$$],
    ARRAY['login_otps',     'chk_login_otps_hash',     $$code_hash ~ '^[0-9a-f]{64}$' AND wrong_tries >= 0 AND channel IN ('email','sms')$$],
    ARRAY['phone_otps',     'chk_phone_otps_hash',     $$code_hash ~ '^[0-9a-f]{64}$' AND wrong_tries >= 0$$],
    ARRAY['password_otps',  'chk_password_otps_hash',  $$code_hash ~ '^[0-9a-f]{64}$' AND wrong_tries >= 0 AND channel IN ('email','sms')$$],
    ARRAY['login_lockouts', 'chk_lockouts_attempts',   $$failed_attempts >= 0$$]
  ];
  i int; bad bigint;
BEGIN
  FOR i IN 1 .. array_length(spec, 1) LOOP
    CONTINUE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = spec[i][2]);
    EXECUTE format('SELECT count(*) FROM %I WHERE NOT (%s)', spec[i][1], spec[i][3]) INTO bad;
    IF bad = 0 THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', spec[i][1], spec[i][2], spec[i][3]);
    ELSE
      RAISE NOTICE 'Constraint % NOT added: % existing row(s) in % break it. Fix them, then run this script again.', spec[i][2], bad, spec[i][1];
    END IF;
  END LOOP;
END $c$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Row Level Security everywhere + no access for the web-facing roles
--    RLS with no policy = "deny" for every role that is not the table owner (or a superuser / BYPASSRLS role).
--    The server connects as the owner, so it keeps working; Supabase's anon/authenticated roles (the REST API) are locked out.
-- ---------------------------------------------------------------------------------------------------------------------
DO $r$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
    IF t.owner = current_user OR pg_has_role(current_user, t.owner, 'MEMBER') THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    ELSE
      RAISE NOTICE 'Row level security NOT enabled on % (owned by %). Run this script as its owner.', t.relname, t.owner;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;
END $r$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Retention: delete expired one-time codes and tokens. The audit log is never purged (it is append-only by design).
--    The server calls this every 6 hours; you can also run:  SELECT security_purge_expired();
-- ---------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION security_purge_expired(retain interval DEFAULT interval '7 days') RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $p$
DECLARE n_login int; n_phone int; n_pw int; n_verify int; n_lock int;
BEGIN
  DELETE FROM login_otps    WHERE created_at < now() - retain;  GET DIAGNOSTICS n_login = ROW_COUNT;
  DELETE FROM phone_otps    WHERE created_at < now() - retain;  GET DIAGNOSTICS n_phone = ROW_COUNT;
  DELETE FROM password_otps WHERE created_at < now() - retain;  GET DIAGNOSTICS n_pw    = ROW_COUNT;
  DELETE FROM email_verifications WHERE created_at < now() - retain AND (used_at IS NOT NULL OR expires_at < now());  GET DIAGNOSTICS n_verify = ROW_COUNT;
  DELETE FROM login_lockouts WHERE locked_at IS NULL AND updated_at < now() - retain;  GET DIAGNOSTICS n_lock = ROW_COUNT;
  RETURN jsonb_build_object('login_otps', n_login, 'phone_otps', n_phone, 'password_otps', n_pw,
                            'email_verifications', n_verify, 'login_lockouts', n_lock);
END $p$;
REVOKE ALL ON FUNCTION security_purge_expired(interval) FROM PUBLIC;

COMMIT;
