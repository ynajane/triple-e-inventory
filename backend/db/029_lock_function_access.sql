-- 029_lock_function_access.sql: close the last door that Supabase's public REST API (PostgREST) leaves open.
--
-- 025_security_hardening.sql already turned on Row Level Security for every table and removed the web roles' table access.
-- Supabase also lets the web roles (anon = anyone with the project's public key, authenticated = any signed-in Supabase user)
-- CALL any function in the public schema through /rest/v1/rpc/<name>. PostgreSQL gives EXECUTE to everyone by default, so the
-- helper and trigger functions of this app were callable from outside. This revokes that, and makes it the default for
-- functions created later. The server connects as the table owner (postgres), which is not affected.
--
-- Safe to run again (idempotent); nothing is dropped or deleted.
--   cd backend && node scripts/apply-migration.js db/029_lock_function_access.sql --dry-run     (rehearse, then rolled back)
--   cd backend && node scripts/apply-migration.js db/029_lock_function_access.sql               (apply; type YES)
BEGIN;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
  END IF;
END $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
