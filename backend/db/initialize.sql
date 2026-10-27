-- Fresh, empty databases only. No sample inventory or customer accounts are loaded.
\set ON_ERROR_STOP on
\ir 001_schema.sql
\ir 002_sales_core.sql
-- Required before concurrent runtime schema routines reference these tables.
\ir 006_shop_extras.sql
\ir 008_production.sql
\ir 009_customer_registration.sql
\ir 026_user_sessions.sql
\ir 028_user_soft_delete.sql
\ir 025_security_hardening.sql
INSERT INTO roles (role_key,label) VALUES
 ('finance','Finance-Admin Officer'), ('cashier','Sales Staff / Cashier'), ('customer','Customer');
