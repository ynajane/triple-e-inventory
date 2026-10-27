-- readonly-auditor-role.sql — OPTIONAL separation of duties (OWASP A01, ASVS V4.1 least privilege).
-- Creates triplee_readonly: a login that can READ business data and the audit log (for an auditor, a grader demo or a reporting tool)
-- but can never change anything and never sees secrets: no password hashes, no avatars, no personal contact details, and no
-- one-time-code / token tables.
--
-- Run once, AFTER db/025_security_hardening.sql, as the table owner (same user as DATABASE_URL). The password is typed on the command line,
-- never stored in this file:
--   psql "$DATABASE_URL" -v ro_password='a-long-random-password' -f backend/db/optional/readonly-auditor-role.sql
-- Then connect the auditor with:  postgresql://triplee_readonly:<password>@host:5432/dbname
--
-- Why policies: db/025 turned on Row Level Security everywhere, so a non-owner role sees nothing until it is given an explicit
-- SELECT policy. Only SELECT policies are created, so INSERT/UPDATE/DELETE stay impossible.
--
-- NOTE on the application's own database user: the server creates and alters its tables at start-up, so it must stay the table owner.
-- Splitting it into "migration" and "runtime" users is a later step: it needs those start-up migrations moved out of the server first.
\set ON_ERROR_STOP on
BEGIN;

SELECT format('CREATE ROLE triplee_readonly LOGIN PASSWORD %L NOINHERIT CONNECTION LIMIT 3', :'ro_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'triplee_readonly') \gexec

ALTER ROLE triplee_readonly SET default_transaction_read_only = on;
ALTER ROLE triplee_readonly SET statement_timeout = '30s';
GRANT USAGE ON SCHEMA public TO triplee_readonly;

DO $r$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') LOOP
    -- tables that hold secrets or one-time codes are never readable by this role
    CONTINUE WHEN t.relname IN ('users', 'login_lockouts', 'phone_otps', 'password_otps', 'login_otps', 'email_verifications', 'invitations');
    EXECUTE format('GRANT SELECT ON public.%I TO triplee_readonly', t.relname);
    EXECUTE format('DROP POLICY IF EXISTS ro_select ON public.%I', t.relname);
    EXECUTE format('CREATE POLICY ro_select ON public.%I FOR SELECT TO triplee_readonly USING (true)', t.relname);
  END LOOP;
END $r$;

-- users: only who/role/status/last sign-in (no password_hash, avatar, phone, email, birth date, TIN)
GRANT SELECT (user_id, username, role_id, status, last_login, created_at) ON users TO triplee_readonly;
DROP POLICY IF EXISTS ro_select ON users;
CREATE POLICY ro_select ON users FOR SELECT TO triplee_readonly USING (true);

COMMIT;
