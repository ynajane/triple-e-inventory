/* security.js — web-application hardening for TRIPLE-E (OWASP Top 10:2025 A01, A02, A04, A07, A09).
   No extra packages. Mounted FIRST in server.js:  const security = require('./security'); security.mount({ app, pool });

   What it adds
     • Security headers on every response (CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS in production)
     • Origin check on every state-changing /api request (CSRF defence on top of the sameSite cookie)
     • Rate limits: a general one for /api and a stricter one for sign-in, sign-up, OTP and password routes
     • "Cache-Control: no-store" on /api so personal data is never kept by the browser or a proxy
     • The audit log becomes append-only (a database trigger refuses UPDATE and DELETE)
     • A real client IP behind a proxy (trust proxy), so the existing per-IP limits in login-lockout.js, auth-signup.js,
       password-otp.js and phone-otp.js no longer treat every visitor as the same address

   Settings (all optional, see .env.example):
     TRUST_PROXY        number of proxy hops in front of the app (default 1 in production, 0 otherwise)
     ALLOWED_ORIGINS    extra hosts allowed to send state-changing requests, comma separated (e.g. shop.example.com)
     RATE_LIMIT_PER_MIN general limit per IP for /api (default 600: a shop counter shares one IP)
     AUTH_RATE_LIMIT    sign-in / sign-up / OTP limit per IP per 10 minutes (default 40)
     INVITE_RATE_LIMIT  invitations an administrator can send per IP per 10 minutes (default 30; its own budget, separate from sign-in)
     COOKIE_SECURE      true or false; when not set it is true in production */
'use strict';
const crypto = require('crypto');

const isProd = () => process.env.NODE_ENV === 'production';
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

/* ---------- constant-time secret comparison (OWASP A02/A07: no timing side channel on cron keys and webhook tokens) ---------- */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- cookies ---------- */
// The session cookie is "Secure" (HTTPS only) in production unless COOKIE_SECURE=false is set on purpose.
function cookieSecure() {
  const v = String(process.env.COOKIE_SECURE || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return isProd();
}

/* ---------- headers ---------- */
// script-src: a fresh per-request nonce replaces 'unsafe-inline' (OWASP A05:2021 — Security Misconfiguration / XSS hardening).
// The matching nonce is stamped onto every inline <script> tag when an HTML page is served — see the page-render
// middleware in server.js. Browsers that understand nonce-source ignore 'unsafe-inline' automatically, so any inline
// script an attacker injects (not carrying the per-request nonce) will not execute.
// style-src keeps 'unsafe-inline': the pages set style attributes dynamically from JS in many places, inline styles
// cannot run arbitrary script, and nonce-ing every style attribute would be high-churn for low security benefit.
function buildCSP(nonce) {
  return [
    "default-src 'self'",
    "script-src 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
}

function securityHeaders() {
  return (req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    res.setHeader('Content-Security-Policy', buildCSP(nonce));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=()');
    if (isProd()) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

/* ---------- CSRF: the Origin of a state-changing request must be this site ---------- */
function originGuard(extraHosts) {
  const allowed = new Set((extraHosts || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean));
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  const firstOf = (v) => String(v || '').split(',')[0].trim().toLowerCase();
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const from = req.get('origin') || req.get('referer');
    if (!from) return next();                        // not a browser (a script, a server callback): the sameSite cookie is not in play
    let host;
    try { host = new URL(from).host.toLowerCase(); } catch (_) { host = null; }
    // Apply the same immediate-peer trust check as Express, retaining the port for origin comparison.
    const trust = req.app.get('trust proxy fn');
    const trustedPeer = trust && trust(req.socket.remoteAddress, 0);
    const expected = firstOf(trustedPeer && req.get('x-forwarded-host') || req.get('host'));
    const ok = host && (host === expected || allowed.has(host));
    if (ok) return next();
    res.status(403).json({ error: 'Request blocked: it did not come from this site' });
  };
}

/* ---------- one browser, one cookie: refuse changes made from a page that belongs to a different sign-in ----------
   The session cookie is shared by every tab. If a Finance tab is open and someone signs in as a customer in another tab, the Finance tab
   would silently start acting as that customer. Pages send X-Session-User (the id they were opened for); a mismatch is refused with 409. */
function sessionGuard() {
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  const refuse = (res, why) => res.status(409).json({ code: 'SESSION_CHANGED', error: why });
  const STREAMS = /^\/notifications\/stream\/?$/i;   // EventSource cannot send headers
  return (req, res, next) => {
    if (/^\/auth(\/|$)/i.test(req.path) || STREAMS.test(req.path)) return next();
    const m = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return next();                           // no session: the route's own auth answers 401
    const claimed = req.get('x-session-user');
    const fromBrowser = !!req.get('sec-fetch-site');  // scripts, tests and server callbacks do not send this
    // Strict: a browser change request signed in as someone MUST say which account its page was opened for.
    if (!claimed) return !SAFE.has(req.method) && fromBrowser ? refuse(res, 'This page did not say which account it belongs to. Nothing was saved. Reload the page.') : next();
    let id = null;
    try { id = require('jsonwebtoken').verify(decodeURIComponent(m[1]), process.env.JWT_SECRET).id; } catch (_) { return next(); }
    if (String(id) === String(claimed)) return next();
    refuse(res, 'You signed in as a different account in another tab. Nothing was saved. Reload this page.');
  };
}

/* ---------- rate limiting (in memory, per IP) ---------- */
function rateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  const timer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, Math.min(windowMs, 60000));
  if (timer.unref) timer.unref();
  return (req, res, next) => {
    const now = Date.now(), key = req.ip || 'unknown';
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count += 1;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - h.count)));
    if (h.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((h.reset - now) / 1000))));
      return res.status(429).json({ error: message || 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

/* ---------- audit log: append-only ---------- */
const AUDIT_SQL = `
CREATE OR REPLACE FUNCTION block_audit_changes() RETURNS trigger AS $f$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP USING ERRCODE = '42501';
END $f$ LANGUAGE plpgsql;
DO $d$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_append_only') THEN
    CREATE TRIGGER trg_audit_append_only BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION block_audit_changes();
  END IF;
END $d$;`;

async function ensureAuditAppendOnly(pool, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { await pool.query(AUDIT_SQL); console.log('[security] audit_log is append-only'); return true; }
    catch (e) {
      if (i === tries) { console.warn('[security] could not make audit_log append-only:', e.message); return false; }
      await new Promise((r) => setTimeout(r, 15000 * i));   // the table may not exist yet on a first start
    }
  }
}

/* ---------- mount ---------- */
function mount({ app, pool, limits } = {}) {
  app.disable('x-powered-by');
  const hops = process.env.TRUST_PROXY !== undefined && process.env.TRUST_PROXY !== '' ? Number(process.env.TRUST_PROXY) : (isProd() ? 1 : 0);
  app.set('trust proxy', Number.isFinite(hops) ? hops : 0);

  const secret = String(process.env.JWT_SECRET || '');
  if (isProd() && (secret.length < 32 || /replace-with|changeme|secret$/i.test(secret)))
    console.warn('[security] JWT_SECRET is short or still a placeholder. Use at least 32 random characters in production.');
  if (isProd() && String(process.env.LOGIN_OTP || '').trim().toLowerCase() === 'off') console.warn('[security] LOGIN_OTP=off in production: sign-in has no second factor. Remove it from .env.');
  for (const k of ['EMAIL_VERIFICATION', 'PHONE_VERIFICATION'])
    if (isProd() && String(process.env[k] || '').trim().toLowerCase() === 'off') console.warn('[security] ' + k + '=off in production: new accounts are not verified. Remove it from .env.');
  if (isProd() && !cookieSecure()) console.warn('[security] COOKIE_SECURE is off in production: the session cookie can travel over plain HTTP.');

  const general = rateLimiter({ windowMs: 60000, max: (limits && limits.general) || num(process.env.RATE_LIMIT_PER_MIN, 600) });
  const strict = rateLimiter({ windowMs: 600000, max: (limits && limits.auth) || num(process.env.AUTH_RATE_LIMIT, 40),
    message: 'Too many attempts from this connection. Please wait a few minutes and try again.' });
  // Invitations (an administrator inviting staff) have their own budget, so signing in or the sign-in screens can never use it up, and the other way round.
  const invite = rateLimiter({ windowMs: 600000, max: (limits && limits.invite) || num(process.env.INVITE_RATE_LIMIT, 30),
    message: 'Too many invitations were sent from this connection. Please wait a few minutes and try again.' });
  const isInvite = /^\/invitations(\/|$)/i;
  const sensitive = /^\/(auth|signup)(\/|$)/i;
  // the verify-your-account screen asks "is my email confirmed yet?" every 3 seconds. That call is read-only, needs a signed 30-minute token and has its own
  // limit (phone-otp.js), so it must not eat the brute-force budget of sign-in and codes.
  const statusPoll = /^\/auth\/verification-status\/?$/i;

  app.use(securityHeaders());
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', originGuard((process.env.ALLOWED_ORIGINS || '').split(',')));
  app.use('/api', sessionGuard());
  app.use('/api', general);
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') return next();
    if (isInvite.test(req.path)) return invite(req, res, next);
    return sensitive.test(req.path) && !statusPoll.test(req.path) ? strict(req, res, next) : next();
  });

  if (pool) ensureAuditAppendOnly(pool).catch(() => {});
}

module.exports = { mount, cookieSecure, securityHeaders, originGuard, sessionGuard, rateLimiter, buildCSP, safeEqual, AUDIT_SQL };
