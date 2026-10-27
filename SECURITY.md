# TRIPLE-E Inventory & POS — Security Documentation

Framework-aligned security package for the BSIT Information Assurance and Security capstone rubric.
Framework: **OWASP Top 10:2021/2025 + OWASP ASVS (Level 2 chapters V2, V4, V5, V7, V9) + OWASP API Security**, with **ISO/IEC 25010** security characteristics (section 9). Project type: web application + REST API on PostgreSQL.

---

## 1. Security scope and system boundaries (Rubric I-1)

Three-tier architecture:

| Tier | Component | Trust level |
|---|---|---|
| Presentation | Static HTML/CSS/JS in `Finance_Inventory/` (Login, Landing, Shop, POS, Finance, Cash Shifts) | Untrusted (runs in the user's browser) |
| Application | Node.js/Express API in `backend/` (`server.js` + feature modules, `security.js` hardening layer) | Trusted, enforces all rules |
| Data | PostgreSQL (`backend/db/*.sql`), connected through `db-config.js` (optional TLS + CA pinning) | Trusted, reachable only from the application tier |

```
                          INTERNET (untrusted)
   Customer browser        Cashier browser         Finance/Admin browser
          \                      |                      /
           \_____ HTTPS (TLS, HSTS in production) _____/
                              |
  ======================= TRUST BOUNDARY 1 =======================
        Reverse proxy / host (Nginx or platform, trust proxy = 1)
                              |
   +--------------- APPLICATION TIER: Node.js + Express ---------------+
   |  security.js    headers + per-request nonce CSP, Origin/CSRF       |
   |                 guard, rate limits, no-store, audit append-only    |
   |  auth-middleware.js   session cookie (JWT) -> role check (403)     |
   |                 -> account still active                            |
   |  route modules  validation, parameterized SQL, audit(), alerts     |
   |  security-alerts.js   failed-login / admin lock-out alerts         |
   +----------+------------------------+-----------------------+-------+
              |                        |                       |
  ===== TRUST BOUNDARY 2 =====   ===== TRUST BOUNDARY 3 (server-side only, secrets in env) =====
              |                        |                       |
   DATA TIER: PostgreSQL        Xendit (payments)     Gmail/Mailgun (email), SMS (OTP),
   least-privilege DB user,     webhook: shared       address lookups (PSGC/GeoNames)
   TLS (+CA pinning)            secret, constant-time
   backups + restore drill      compare
```

Network segmentation: the browser can reach only the proxy/Express (port 80/443); PostgreSQL accepts connections only from the application host (firewall / provider allow-list) and is never exposed to browsers; third-party calls are made only by the server; the front end may load scripts only from `self` and cdnjs.

Roles (3): **finance** (admin/finance officer), **cashier**, **customer**. Roles are enforced server-side by `auth('finance'|'cashier'|'customer')`; private HTML pages are also gated server-side (page gate in `server.js`), and the front end is never trusted for authorization.

External connections: Xendit (payments), Gmail/Mailgun (email), SMS provider (OTP), PSGC/GeoNames/Nominatim (address lookup, via `connect-src 'self'` only through the backend), cdnjs (QR library, the only third-party script origin allowed by CSP).

Trust boundaries: browser ↔ API (cookie session + Origin check + CSP), API ↔ database (parameterized SQL, least-privilege DB user `triplee_app`), API ↔ third parties (server-side only, secrets in env).

## 2. Information assets and priority (Rubric I-2)

| Asset | Where | Priority | Why |
|---|---|---|---|
| Password hashes, OTP/unlock token hashes | `users`, `login_lockouts` | Critical | Account takeover |
| Customer PII (name, phone, address, birth date, company TIN) | `users`, customer tables | Critical | RA 10173 exposure |
| Payment, order, cash-shift and refund records | orders/payments/cash_shifts | Critical | Financial integrity |
| Audit log | `audit_log` | Critical (integrity) | Accountability, forensics |
| Session secret `JWT_SECRET`, DB and mail credentials | `backend/.env` (gitignored) | Critical | Full compromise |
| Pricing, inventory, BOM, quotes | business tables | High | Business loss |
| Static front end | `Finance_Inventory/` | Low | Public by design |

## 3. CIA requirements (Rubric I-3)

- **Confidentiality** — passwords only as bcrypt hashes; session in an httpOnly, sameSite cookie (Secure in production); PII only to its owner or `finance`; `Cache-Control: no-store` on `/api`; TLS to the database where hosted.
- **Integrity** — every query parameterized; money handled in whole centavos; row locking on stock/payments; `audit_log` is append-only, enforced by a database trigger (`security.js`, `AUDIT_SQL`); CSRF Origin guard on every state-changing request.
- **Availability** — per-IP rate limits (general and stricter auth tier), connection pool with error handler, account lockout limits abuse, scheduled backups with a timed restore drill (`scripts/backup.sh`, `restore-test.sh`).

## 4. Threat model (Rubric II-1, II-4) — OWASP Top 10 mapping

| OWASP | Threat scenario in TRIPLE-E | Mitigation (file) | Status |
|---|---|---|---|
| A01 Broken Access Control | Cashier calls a finance route; customer opens a staff page | `auth(role)` on routes; page gate for private HTML (`server.js`); disabled-account re-check | Mitigated |
| A02 Cryptographic Failures | Stolen DB dump; secret in repo; cookie over HTTP | bcrypt cost 12 (`auth-signup.js`); `.env` gitignored; HSTS + Secure cookie in production; DB TLS (`db-config.js`) | Mitigated |
| A03 Injection (SQL, XSS) | Crafted input in search/quote fields; script injected into a page | Parameterized SQL, whitelisted identifiers for dynamic SQL; **nonce-based CSP without `unsafe-inline` for scripts**; no inline handlers, `eval` or `javascript:` URLs; `esc()` on rendered values | Mitigated |
| A04 Insecure Design | Brute force, OTP abuse, double payment | Lockout + emailed unlock, rate limits, OTP expiry, atomic payment updates | Mitigated |
| A05 Security Misconfiguration | Missing headers, verbose errors | `security.js` headers (CSP, XFO, nosniff, Referrer, Permissions, HSTS); generic 500 responses; `x-powered-by` off | Mitigated |
| A06 Vulnerable Components | Outdated npm packages | `npm audit` as an acceptance gate (section 7) | Process control |
| A07 Identification & Authentication Failures | Credential stuffing, stolen/guessed password, user enumeration | Lockout, **second factor on every sign-in (one-time code by email or text)**, generic unlock/forgot responses, email + mobile verification, failed-login alerts | Mitigated |
| A08 Software/Data Integrity | Tampered audit trail | Append-only trigger; CSRF guard | Mitigated |
| A09 Logging & Monitoring Failures | Attack unnoticed | Audit entries for every failed login, lock-out, unlock; ~100 audit call sites | Partly (no external alerting, see residual risk) |
| A10 SSRF / Server-side requests | Backend fetching attacker URLs | Third-party calls use fixed hosts; no user-supplied fetch URLs | Low exposure |

## 5. Vulnerability and weakness analysis (Rubric II-2)

Method: manual code review of `backend/` and `Finance_Inventory/`, pattern searches (string-built SQL, inline handlers, `eval`, `javascript:`), automated tests, and `npm audit` (re-run before each release, record the result in the table below).

| Finding | Basis | Result |
|---|---|---|
| String-built SQL | OWASP A03 / ASVS V5 | Only whitelisted internal identifiers are interpolated; no user input |
| Script injection (CSP `unsafe-inline`) | OWASP A03/A05, ASVS V14 | **Fixed**: nonce-based `script-src`; 17 inline `onclick`/`onerror` attributes converted to data attributes with delegated listeners |
| Token in `localStorage` | ASVS V3 | Not present; session is an httpOnly cookie |
| In-memory rate limiter resets on restart / not shared across instances | ASVS V11 | Accepted for single-instance deployment; use Redis if scaled out |
| `style-src 'unsafe-inline'` | CSP guidance | Accepted residual (section 6, R9) |
| Dependency vulnerabilities | OWASP A06 | **Fixed**: `npm audit --omit=dev` found 2 high (nodemailer 6.10.1, body-parser); upgraded to nodemailer 10.2.1 and patched body-parser; re-audit: 0 vulnerabilities. Re-run before each release |

### 5a. OWASP ASVS Level 2 checklist (Rubric II-2, II-4)

Status: **Met** = implemented and evidenced, **Partial** = implemented with a stated limit, **N/A** = not applicable to this system.

| ASVS | Requirement | Status | Evidence |
|---|---|---|---|
| V2.1 | Password length ≥ 8, max ≥ 64, no composition-only rules that block long passphrases | Met | `auth-signup.js`: min 8, class rules, 72-byte cap that matches bcrypt |
| V2.1 | Block common / context-specific passwords | Met | `COMMON_PASSWORDS` list; rejects email name and user names |
| V2.2 | Anti-automation: rate limit + lockout | Met | `security.js` strict limiter; `login-lockout.js` 3 failures + emailed unlock |
| V2.2 | Generic errors, no user enumeration | Met | login returns "Invalid email or password"; unlock/forgot answer the same whether or not the account exists |
| V2.4 | Passwords stored with an adaptive hash | Met | bcrypt cost 12 |
| V2.5 | Reset / recovery codes are single use and expire | Met | `password-otp.js`, unlock token stored as SHA-256 hash with expiry |
| V2.8 | Out-of-band verification | Met | email link + mobile OTP before first sign-in |
| V3.2 | Session ends and tokens are invalidated | Met | 8 h expiry, logout clears cookie, disabled/changed account rejected next request, **password change/reset revokes every other session** (`users.token_version`, tested on a real PostgreSQL engine) |
| V3.3 | Concurrent session control | Met | **Device limit per role** (`SESSION_LIMITS`, default administrator 1, cashier 1, customer 3). Every sign-in is recorded in `user_sessions` (device, IP, browser); signing in over the limit ends the **oldest** device, which is refused on its next request with "signed in on another device" (`SESSION_REPLACED`), explained on the login page and recorded in the audit log. Logging out or changing the password frees places. Tested on a real PostgreSQL engine (`db-hardening.test.js`) |
| V3.4 | Cookie flags | Met | httpOnly, sameSite=lax, Secure in production (tested) |
| V3.5 | Token validated, no `alg=none` / forged | Met | `rbac.test.js` forged, tampered, expired, alg-none tokens → 401 |
| V4.1 | Access control enforced server-side, deny by default | Met | `auth-middleware.js`; route audit test fails on any unprotected `/api` route |
| V4.1 | Role check does not touch the database before denying | Met | `rbac.test.js` "403 before the database" |
| V4.2 | IDOR: users reach only their own records | Met (reviewed) | `pos-shop.js`: order checkout/verify/cancel/refund use `WHERE order_no = $1 AND customer_id = $2 [req.user.id]`; addresses use `address_id = $1 AND user_id = $2`; order list uses `customer_id = $1`; profile uses `user_id = req.user.id`. Re-check any new `:id` route |
| V4.3 | Admin interfaces protected | Met | finance pages gated server-side; routes use `auth('finance')` |
| V4.1 / V8.3 | Least privilege for administrators over personal data | Met | Finance can change an account's **role only**; name, e-mail, mobile, birth date, gender and company details can be changed only by the account owner in My Profile (a new mobile number is re-verified by text). The server refuses any such field from Finance; a customer cannot become staff or the reverse, nobody changes their own role, and at least one active Finance-Admin must remain. The Customers screen offers only view and disable/enable, never an edit form (`rbac.test.js`) |
| V5.1 | Input validation server-side | Met | per-field validators in `server.js`/`auth-signup.js`; 100 kb JSON limit; image type + 2 MB limit |
| V5.3 | Output encoding / injection defense | Met | `esc()`, parameterized SQL, nonce CSP, no inline handlers |
| V5.3 | SQL injection | Met | parameterized queries; dynamic SQL only with whitelisted identifiers |
| V7.1 | No sensitive data in logs / errors | Met | generic 500, no stack to client; hashes never logged |
| V7.2 | Security events logged | Met | failed/successful login, lock-out, unlock, finance/POS actions in `audit_log` |
| V7.3 | Log integrity | Met | append-only DB trigger (tested) |
| V7.x | Alerting on suspicious activity | Met | `security-alerts.js` (tested, `security-alerts.test.js`) |
| V8.1 | Sensitive data not cached | Met | `Cache-Control: no-store` on `/api` (tested) |
| V9.1 | TLS for all traffic | Met in production | HSTS; Secure cookie; DB TLS; requires HTTPS deployment |
| V10.x | No dangerous code (eval, dynamic functions) | Met | repo search: no `eval(`, `new Function(` |
| V11.1 | Business-logic limits | Met | stock/payment row locking, centavo arithmetic, double-submit protection on sales; **end-of-day cash control**: from 15 minutes before closing (4:45 PM) the cashier's shift must be counted and closed, the window cannot be dismissed, and the server refuses sales, cash collection and cash movements on that shift until it is closed (`cash-shift-force-close.test.js`) |
| V12.x | File upload restrictions | Met | avatar: JPEG/PNG only, 2 MB |
| V13.x | API: auth on every endpoint, content type, no mass assignment | Met | route audit; field-by-field validation |
| V14.2 | Dependencies free of known vulnerabilities | Met | `npm audit --omit=dev` = 0 |
| V14.4 | Security headers | Met | CSP (nonce), XFO, nosniff, Referrer-Policy, Permissions-Policy, HSTS |
| V14.5 | CSRF / origin validation | Met | Origin guard + sameSite (tested) |
| V6.2 | Cryptographic secrets compared safely | Met | `safeEqual` (constant time) for cron keys and webhook token |
| V3.3 / V2.8 | Multi-factor on every sign-in | Met | `login-otp.js`: after the password, a 6-digit one-time code by **email or text message (the user chooses)** is required before any session starts; code is hashed, single use, 5-minute expiry, 5 wrong tries, 60 s resend cooldown, 5 sends/hour (`login-otp.test.js`) |

### 5b. OWASP API Security Top 10 (2023) mapping

| API risk | Control |
|---|---|
| API1 Broken object-level authorization | Queries scoped to the signed-in user; role-restricted admin routes |
| API2 Broken authentication | bcrypt, lockout, rate limits, signed httpOnly cookie, token expiry |
| API3 Broken object property-level authorization | Explicit field lists on updates; role-specific response shapes |
| API4 Unrestricted resource consumption | General per-IP limit; a strict limit for sign-in, sign-up and one-time codes (40 per 10 min); a separate limit for administrator invitations (30 per 10 min) so one cannot starve the other; the read-only verification poll is excluded; 100 kb body limit, 2 MB upload limit, pool cap |
| API5 Broken function-level authorization | `auth(role)` on every non-public route; route audit test |
| API6 Unrestricted access to sensitive business flows | Lockout, OTP expiry and cooldowns, double-payment protection |
| API7 Server-side request forgery | No user-supplied URLs fetched by the server |
| API8 Security misconfiguration | Hardened headers, generic errors, `x-powered-by` off, env-only secrets |
| API9 Improper inventory management | Single `/api` surface; every route listed in the audit test |
| API10 Unsafe consumption of APIs | Webhook authenticated by shared secret; third-party data escaped before display |

### 5c. Data protection: at rest, in transit, secrets and keys (Rubric III-2)

| Item | Control |
|---|---|
| In transit | HTTPS + HSTS in production; Secure cookie; PostgreSQL over TLS (`DB_SSL=require`, optional `DB_SSL_CA` pinning in `db-config.js`) |
| Passwords | bcrypt (cost 12), never stored or logged in clear text |
| Tokens (unlock, verification, OTP) | Only SHA-256 hashes stored, short expiry, single use |
| Database at rest | Provider-managed disk encryption on the hosted PostgreSQL. **Confirm and record in your provider dashboard** (screenshot for the defense); backups are protected by file permissions on the backup host |
| Secrets | `JWT_SECRET`, DB and mail credentials only in `backend/.env` (gitignored, never in source), strength warning at startup |
| Key rotation | Rotate `JWT_SECRET` every 6 months or on suspected exposure (signs everyone out), rotate DB/mail credentials at the same time, and after any staff departure |
| Webhook / cron secrets | Compared in constant time (`safeEqual`); cron endpoints return 404 without the key |
| One-time codes at rest | Stored only as a 64-hex HMAC; a database CHECK constraint refuses anything else, so a plain 6-digit code can never be saved (`db/025`) |
| Database exposure | Row Level Security on every table and no privileges for Supabase's web roles (`anon`, `authenticated`), so the auto-generated REST API cannot read the data (`db/025`) |

### 5d. Database-tier controls (`backend/db/025_security_hardening.sql`)

Applied once after a backup, as the same user as `DATABASE_URL`: `cd backend && node scripts/apply-migration.js db/025_security_hardening.sql --dry-run` (rehearsal, rolled back), then the same command without `--dry-run` (no `psql` needed; `psql -f` also works). It is idempotent (safe to run twice), transactional, deletes nothing, and the only data change is lower-casing e-mail addresses (the app only ever matches lower case). It was executed against a real PostgreSQL engine in `backend/test/db-hardening.test.js`, including a second run, a legacy-data scenario and the real auth middleware SQL.

| # | Control | Risk | Rubric | Verified by |
|---|---|---|---|---|
| 1 | Sign-in tables (`login_lockouts`, `phone_otps`, `password_otps`, `login_otps`) documented in SQL, identical to what the server creates | Schema drift, undocumented data | III-3, VI-1 | test compares the migration with the server code column by column |
| 2 | `users.token_version`: a password change or reset signs out every other device, the current one stays signed in | Stolen/old session survives a password change (R1, R4) | III-1 | `rbac.test.js`, real-engine test in `db-hardening.test.js` |
| 3 | `audit_log`: IP address + browser per entry; append-only trigger now also blocks TRUNCATE; UPDATE/DELETE/TRUNCATE revoked from PUBLIC; indexes for review | Tampering, weak forensics (R7, R11) | IV-3 | tests: update, delete, truncate all refused even for the owner |
| 4 | CHECK constraints: lower-case valid email, only the 3 roles, one-time codes only as 64-hex HMAC, non-negative counters. Added only when all existing rows already pass, so no account can be locked out | Bad data, privilege-escalation by inserting a role (R4) | III-1, III-5 | tests: bad rows rejected, legacy rows still updatable |
| 5 | Row Level Security on every table + no access for `anon`/`authenticated` (also for tables created later) | Data read through the Supabase REST API (R12) | III-2, III-3 | test: web roles denied on `users`, `audit_log` and a table created afterwards |
| 6 | `security_purge_expired()`, run by the server every 6 hours: expired codes/tokens deleted after 7 days; the audit log is never purged | Excess personal data kept (RA 10173, R12) | V-1 | test: removes only old rows, executable only by the owner |
| 7 | Optional `db/optional/readonly-auditor-role.sql`: a read-only role that reads business data and the audit log but never password hashes, e-mail addresses, tokens or codes | Separation of duties, insider misuse | III-1 | test: reads allowed, secrets and writes denied |
| 8 | `db/026_user_sessions.sql`: one row per signed-in device; per-role device limits (admin 1, cashier 1, customer 3), logout and password change free places, ended sessions purged after 7 days | Shared/stolen account used on many devices, one drawer used from two devices (R1, R4) | III-1 | tests: 4th customer sign-in ends the oldest, admin/cashier limit 1, expired sessions do not count, RLS on the table |

How to check it was applied (Appendix B): `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;` returns 0, and `SELECT security_purge_expired();` returns a JSON row count.

## 6. Risk register (Rubric II-3, III-5)

Likelihood (L) and Impact (I) are rated 1–5; score = L × I; ≥15 High, 8–14 Medium, ≤7 Low. Residual rating is after the control.

| ID | Risk | L | I | Score | Control (traceability) | Residual |
|---|---|---|---|---|---|---|
| R1 | Credential stuffing / brute force on login | 4 | 4 | 16 High | Lockout after 3 failures + emailed unlock (`login-lockout.js`), per-IP strict limiter (`security.js`), bcrypt 12, **one-time code on every sign-in so a stolen password alone cannot open a session** (`login-otp.js`), failed-login alerts; tests: `security.test.js`, `login-otp.test.js` | Very low |
| R2 | SQL injection | 3 | 5 | 15 High | Parameterized queries; whitelisted identifiers | Low |
| R3 | Stored/reflected XSS leading to session abuse | 3 | 5 | 15 High | Nonce CSP, httpOnly cookie, output escaping, no inline handlers; test: nonce test in `security.test.js` | Low |
| R4 | Privilege escalation (cashier → finance, customer → staff) | 3 | 5 | 15 High | `auth(role)` middleware, server-side page gate, disabled-account check | Low |
| R5 | CSRF on state-changing requests | 3 | 4 | 12 Medium | Origin guard + sameSite cookie; test: CSRF test | Low |
| R6 | Secret leakage (`.env`, JWT secret) | 2 | 5 | 10 Medium | `.env` gitignored, JWT secret strength warning, env-only secrets | Low |
| R7 | Audit log tampering | 2 | 5 | 10 Medium | DB trigger blocks UPDATE, DELETE and TRUNCATE; privileges revoked; IP + browser recorded; tests: `security.test.js`, `db-hardening.test.js` | Low (a database superuser could still disable the trigger) |
| R8 | Data loss / ransomware / outage | 2 | 5 | 10 Medium | `backup.sh` checksummed dumps + retention, `restore-test.sh` drill with RTO timing | Low |
| R9 | Inline-style based UI redress / CSS injection | 2 | 2 | 4 Low | `frame-ancestors 'none'`, X-Frame-Options; style inline kept for UI | Low (accepted) |
| R10 | Vulnerable dependency | 3 | 4 | 12 Medium | `npm audit` gate before release; 0 vulnerabilities after upgrade | Low |
| R11 | Undetected attack | 3 | 3 | 9 Medium | Detective control: `security-alerts.js` emails the owner on 10+ failed sign-ins per IP or account in 10 min and on any finance-account lock-out; test: `security-alerts.test.js` | Low |
| R12 | PII disclosure (RA 10173) | 2 | 5 | 10 Medium | Role-restricted access, Privacy Policy and consent at sign-up, `no-store` on API, Row Level Security + no web-role access on every table, expired codes purged automatically | Low |

## 7. Security acceptance criteria (Rubric IV-2)

A release is acceptable only when all are true:

| # | Criterion | Measure | How verified |
|---|---|---|---|
| A1 | Security test suite passes | 75/75 tests (security 13, rbac 15, alerts 7, sign-in code 13, database 18, numeric 3, recovery 4, production configuration 2) | `cd backend && npm run test:security` |
| A13 | Strict numeric inputs | Reject booleans, arrays, objects and non-decimal text before coercion; preserve valid decimal inputs | `numeric-validation.test.js`, `payment-terms.test.js` |
| A14 | Transaction integrity and recovery | Concurrent stock/payment/production requests, failed audit writes and a real dump/restore preserve balances and required row counts | `npm run test:data-integrity` (requires local PostgreSQL tools) |
| A15 | Production configuration | No unsafe configuration findings; deployment/network/provider evidence still required | `npm run check:production`, then manual deployment checks in DATA_PROCESS.md |
| A16 | Fresh database startup | Empty install, all roles with OTP, customer order, POS sale/approved void, schema reapplication and post-start RLS pass | `npm run test:startup` (requires local PostgreSQL tools) |
| A12 | Database hardening applied | Migration `025` run with no error; 0 public tables without Row Level Security; `anon`/`authenticated` cannot read `users`; `security_purge_expired()` runs | Appendix B queries; `db-hardening.test.js` proves the script on a real engine |
| A11 | No session without the second factor | The login route never sets the session cookie; only `completeLogin` does, after a right one-time code; a used, expired, forged or over-tried code is refused | `login-otp.test.js` (incl. wiring check) |
| A2 | No weak CSP | `script-src` has a nonce and no `unsafe-inline`; nonce differs per request | CSP test |
| A3 | No inline handlers | 0 matches for `on*=` attributes, `javascript:` hrefs, `eval(` in `Finance_Inventory/` | repo grep (Appendix A) |
| A4 | Passwords hashed | bcrypt cost ≥ 12 | code review `auth-signup.js` |
| A5 | Dependencies | 0 high/critical findings | `npm audit --omit=dev` |
| A6 | Session cookie | httpOnly + sameSite; Secure when `NODE_ENV=production` | cookie test |
| A7 | Protected routes | Wrong role receives 403 before any database query; 0 unprotected `/api` routes outside the reviewed public list | `rbac.test.js` (role matrix + route audit over 254 routes) |
| A10 | Alerting works | Threshold, window, cooldown and administrator lock-out alerts fire as specified | `security-alerts.test.js` |
| A8 | Recovery | Restore drill completes and RTO is recorded | `scripts/restore-test.sh` log |
| A9 | Secrets | `JWT_SECRET` ≥ 32 random chars; `.env` untracked | startup warning, `git ls-files backend/.env` returns nothing |

## 8. Security testing and verification plan (Rubric IV-1)

| Framework control | Test | Type | Evidence |
|---|---|---|---|
| ASVS V14 / A05 headers | Headers on every response, HSTS only in production | Automated | `security.test.js` |
| A03 / XSS | Nonce CSP, no `unsafe-inline`, nonce rotates per request | Automated | `security.test.js` |
| ASVS V4 CSRF | Cross-origin POST blocked, `ALLOWED_ORIGINS` honoured | Automated | `security.test.js` |
| A04 / V11 rate limiting | 429 with `Retry-After`; stricter auth tier | Automated | `security.test.js` |
| ASVS V3 cookies | Secure flag follows environment | Automated | `security.test.js` |
| A09 / V7 | Audit trigger refuses UPDATE/DELETE | Automated | `security.test.js` |
| A01 access control | Every role against every protected route: 200 vs 403, 403 before DB, forged/expired/alg-none tokens, disabled account, changed role | Automated | `rbac.test.js` |
| A01 / API5 function-level authorization | Route audit: every `/api` route has `auth()` unless on the reviewed public list | Automated | `rbac.test.js` |
| A09 detection | Failed-login thresholds, cooldown, administrator lock-out alert | Automated | `security-alerts.test.js` |
| A07 / ASVS V2.8, V3.3 second factor | Choose email or text; code hashed + single use; expiry; 5 wrong tries; resend cooldown; forged/expired/wrong-purpose challenge tokens; no code in production logs; no session cookie before the code | Automated | `login-otp.test.js` |
| A07 lockout | 3 wrong passwords lock the account; unlock link starts cooldown | Manual | Appendix B |
| A03 injection | SQL metacharacters in search/quote/login fields return normal errors, no 500 | Manual (ZAP or manual) | Appendix B |
| A06 dependencies | `npm audit` | Tool | Appendix B |
| Recovery | `restore-test.sh` | Scripted drill | log with RTO |

## 9. ISO/IEC 25010 security characteristics (Rubric IV-4)

| Characteristic | Requirement | Implementation |
|---|---|---|
| Confidentiality | Only authorized users read data | Role checks, httpOnly cookie, TLS, bcrypt, `no-store` |
| Integrity | Prevent unauthorized modification | Parameterized SQL, CSRF Origin guard, nonce CSP, DB constraints, append-only audit trigger |
| Non-repudiation | Actions cannot be denied | Audit log records user, role, action, timestamp; log is immutable |
| Accountability | Actions traceable to one user | Per-user accounts, `audit()` on sensitive actions, failed-login logging |
| Authenticity | Identity can be proven | bcrypt credentials **plus a one-time code (email or text) on every sign-in**, signed JWT session, email and mobile verification |

Related characteristics: **Reliability** (pool error handling, backups, restore drill) and **Maintainability/Testability** (automated security tests).

## 10. Logging, monitoring and auditability (Rubric IV-3)

- `audit_log` is append-only (trigger). Recorded: every failed sign-in with attempt count, lock-outs, unlock events, finance and POS actions (about 100 call sites).
- Retention: keep audit records for at least 1 year (management decision, enforce through backups).
- Monitoring and alerting: `security-alerts.js` emails `SECURITY_ALERT_EMAIL` when one IP or one account fails sign-in 10+ times in 10 minutes (credential stuffing / guessing) or a `finance` account is locked. Alerts are also written to the server log as `[SECURITY ALERT]`, are de-duplicated for 30 minutes, and never block or change the login response (no enumeration leak). Set `SECURITY_ALERT_EMAIL` in `backend/.env` to turn on email.
- Review routine: the finance officer reviews the audit log weekly (failed logins, lock-outs, voids, refunds, price changes).

## 11. Privacy and data handling (Rubric V-1)

- Governing law: Data Privacy Act of 2012 (RA 10173). A full Privacy Policy and Terms are shown in the sign-up window (`Login_Inventory.html`, `data-legal` links) and the user must tick **both** acknowledgements; acceptance time and `TERMS_VERSION` are stored (`terms_accepted_at`, `privacy_accepted_at`, `terms_version`).
- Data subject rights (access, correction, deletion, complaint to the National Privacy Commission) are described in the policy; users edit data in My Profile; customer deletion is implemented with an audit trail; staff accounts are disabled, not deleted, to preserve accountability.
- Minimization: only data needed for orders, delivery and invoicing is collected. Disclosure: only to the owner and authorized staff.
- Retention: personal data is kept while the account is active and for the period needed for tax/accounting records; deleted on a verified request unless law requires retention. One-time codes and verification/unlock tokens are deleted automatically 7 days after they were issued (`security_purge_expired()`, run every 6 hours); the audit log is kept (append-only) for at least 1 year.

## 12. Backup, recovery, incident response and continuity (Rubric V-2)

**Backup/recovery:** `backend/scripts/backup.sh` creates private, uniquely named dumps and checksums (directory owned by the running user with no group/other access; new directory mode 700, files 600). It refuses shared or symlink destinations and publishes a dump only after success. `restore-test.sh` requires the matching checksum, restores transactionally into a separate scratch database, and fails on restore errors, missing required tables or failed/invalid row-count queries. RTO timing includes verification. The disposable PostgreSQL test compares six restored table counts with the source fixture; operational drills must also compare expected data and application integrity. Schedule `backup.sh` daily (cron / Task Scheduler) and run the restore drill monthly.

**Incident response runbook**

1. **Detect** — audit-log anomalies, user reports, alerts.
2. **Contain** — disable affected accounts (`status`), rotate `JWT_SECRET` (signs out every session), rotate DB/mail credentials, block abusive IPs at the proxy.
3. **Eradicate** — patch the cause, run `npm audit`, redeploy.
4. **Recover** — restore from the latest verified backup if data was altered; confirm with `restore-test.sh` checks.
5. **Notify** — the owner/data-protection contact immediately; affected users and the National Privacy Commission within 72 hours of a confirmed personal-data breach (RA 10173 / NPC rules).
6. **Review** — write a short post-incident note and update the risk register.

**Continuity:** stateless API (restart or move host in minutes), database restorable from backup, static front end re-deployable from the repository.

## 13. Control traceability summary (Rubric VI-1)

Risk → control → test → acceptance criterion: R1 → lockout/limiter → security.test (rate limit) + manual lockout → A1/A7; R2 → parameterized SQL → manual injection test → A3/A7; R3 → nonce CSP → CSP test → A2/A3; R4 → `auth()` → role tests → A7; R5 → Origin guard → CSRF test → A1; R6 → env secrets → startup check → A9; R7 → trigger → trigger test → A1; R8 → backup scripts → restore drill → A8; R10 → npm audit → A5; R11 → security-alerts → alerts test → A10.

## 14. Known residual risks (accepted)

1. `style-src` keeps `'unsafe-inline'` (UI sets styles dynamically; inline styles cannot execute script).
2. Rate limiter is in memory (single instance). Move to a shared store if the API is scaled out.
3. Alerting is email-only and per process (single instance); use a shared store and a pager/chat channel if scaled out.
4. The sign-in code depends on your email service (Gmail/Mailgun) and TextBee phone gateway being up; the user can pick the other method if one fails. Keep `LOGIN_OTP` unset (on) in production.
5. The application's own database user is the table owner, because the server creates and alters tables at start-up. It therefore cannot be limited to INSERT/SELECT/UPDATE/DELETE yet; splitting it into a migration user and a runtime user requires moving those start-up migrations out of the server first. Mitigation: Row Level Security and the revoked web roles, the append-only audit log, the optional read-only auditor role, and a strong database password in `.env`.
6. A database superuser can still disable the audit trigger; keep superuser credentials out of the application and review the Supabase dashboard access list.
7. After deploying the nonce CSP and the sign-in code screen, browser-test every page once (login, sign-up, shop, POS checkout, finance reports, cash shifts): the automated checks cannot exercise the UI.

---

### Appendix A — CSP verification commands

```
cd backend && npm run test:security      # 75 tests: security, RBAC, alerts, OTP, database, numeric inputs, recovery and production configuration
grep -rEn "[ '\"]on(click|error|change|submit|load)=|javascript:|eval\(" ../Finance_Inventory   # expect no output
```

### Appendix B — Manual test log (fill in per release)

| Date | Test | Tester | Result |
|---|---|---|---|
| | Cashier opens finance-only API route → 403 | | |
| | Customer opens `/Finance_Inventory.html` → redirected | | |
| | 3 wrong passwords → lock + email; unlock link works | | |
| | Right password → "Confirm it's you" screen appears; no page opens yet | | |
| | Choose **Email** → code arrives; right code signs in | | |
| | Choose **Text** → SMS arrives; right code signs in | | |
| | Wrong code ×5 → refused, then Resend gives a working new code | | |
| | Expired code (wait 5 min) → refused | | |
| | Type `/Finance_Inventory.html` after the password but before the code → redirected to login | | |
| | `' OR 1=1 --` in login/search → normal error, no 500 | | |
| | `npm audit --omit=dev` → 0 high/critical | | |
| | `restore-test.sh` completes; RTO: ___ min | | |
| | Migration `node scripts/apply-migration.js db/025_security_hardening.sql --dry-run`, then without `--dry-run`: finishes with no error (note any NOTICE) | | |
| | Tables without RLS: `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;` → 0 | | |
| | `UPDATE audit_log SET detail='x';` and `TRUNCATE audit_log;` are refused ("append-only") | | |
| | Change password on laptop → the phone session is signed out on its next click; the laptop stays signed in | | |
| | Admin signs in on a 2nd device → the 1st device is signed out on its next click and the login page says why | | |
| | Cashier signs in on a 2nd device → the 1st device is signed out | | |
| | Customer signs in on 4 devices → the 1st (oldest) is signed out, the other 3 keep working | | |
| | Log out on one customer device, sign in on a new one → nobody else is signed out | | |
| | `node scripts/apply-migration.js db/026_user_sessions.sql --dry-run`, then without `--dry-run`: no error | | |
| | `SELECT security_purge_expired();` returns a JSON row count | | |

### Data validation and release workflow

See [DATA_PROCESS.md](DATA_PROCESS.md) for the data gates, preserved payment policy, automated checks and deployment evidence. The origin guard honors forwarded hosts only when the immediate peer is trusted by Express; the ingress must overwrite forwarded headers and prevent direct backend access. Numeric fields accept finite numbers and plain decimal strings; booleans, arrays, objects, hexadecimal and exponent strings are refused. Formatted peso fields retain their documented separators. Payment replay checks run again after the parent lock, preventing simultaneous retries from inserting a second ledger event. Request IDs cannot be replayed against a different parent.
