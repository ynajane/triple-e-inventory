require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const dns = require('dns').promises;

const pool = new Pool(require('./db-config')());

// Safety net: a database hiccup (dropped connection, wrong password, database not ready yet) must be LOGGED, not kill the server.
// Without these, Node 22 exits on the first unhandled error and Cloud Run reports "container failed to start".
pool.on('error', (err) => console.error('[db] pool error (idle client):', err.message));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err && err.stack || err));
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err && err.stack || err));

const app = express();
const security = require('./security');   // OWASP Top 10:2025 — headers, CSRF, rate limits, append-only audit, proxy (security.js)
security.mount({ app, pool });
// who/where for the audit log: the client address (real one behind the proxy, see security.js) and browser of the request that caused each entry
const requestContext = new (require('async_hooks').AsyncLocalStorage)();
app.use((req, res, next) => requestContext.run({ ip: req.ip, ua: req.get('user-agent') }, next));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// Low-stock alerts (email + text). Registered this early so it also sees every change made by the routes below.
app.locals.lowStock = require('./low-stock')(app, pool);

const TZ = 'Asia/Manila';

/* =====================================================
   Validation helpers (the browser checks too, but this is the real gate)
===================================================== */
class ValidationError extends Error {
  constructor(fields) { super(Object.values(fields)[0]); this.fields = fields; }
}
const DEPARTMENTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];
const FINISHED_GOODS_CATEGORIES = ['Aluminum Die-Cast Products', 'Forged Brass Products'];
// Triple E only works in aluminum and brass, so the only metal raw materials are these two (no steel, iron, stainless...)
const RAW_MATERIAL_CATEGORIES = ['Aluminum Alloy', 'Brass / Copper Alloy'];
const isRawMaterialCategory = (c) => RAW_MATERIAL_CATEGORIES.some((x) => x.toLowerCase() === String(c || '').trim().toLowerCase());
const FINISHED_GOODS_UNIT = 'pcs';      // every Finished Good is sold by the piece (enforced in validateProduct and in the quote form)
const NEEDS_SUPPLIER = ['Raw Materials', 'Finishing Supplies'];
// Units offered in the product form (kg and pcs first, then units used for metals)
const UNITS = ['kg', 'pcs', 'tonne', 'g', 'lb', 'm', 'ft', 'sheet', 'plate', 'bar', 'coil', 'roll', 'bundle', 'set', 'pair', 'box', 'bag', 'drum', 'liter'];

// Reasons offered on the Stock In / Stock Out form (POS and online orders post their own: sale, online_order)
const REASONS = {
  in: {
    supplier_receipt: 'Received from supplier',
    customer_return: 'Returned by customer',
    produced_batch: 'Produced \u2014 new batch',
    other: 'Other (explain in note)'
  },
  out: {
    rust_corrosion: 'Rust / corrosion',
    damaged: 'Damaged (bent, cracked, broken)',
    scrap_cutting_waste: 'Scrap / cutting waste',
    quality_rejection: 'Rejected — failed quality inspection',
    lost_missing: 'Lost / missing',
    returned_to_supplier: 'Returned to supplier',
    other: 'Other (explain in note)'
  }
};
// Labels for reasons the system writes by itself (sales, orders, returns) and for older ledger rows,
// so the movement log, reports and the printed PDF never show a raw code such as "online_order"
const LEGACY_REASON_LABELS = {
  production_output: 'Produced in-house',
  production_use: 'Used in production',
  count_correction_up: 'Stock count correction (+)',
  count_correction_down: 'Stock count correction (−)',
  sale: 'Sold at the POS counter',
  online_order: 'Online shop order',
  return: 'Returned by customer',
  refund: 'Order cancelled, restocked',
  opening_balance: 'Opening balance'
};
const ALL_DEPTS = DEPARTMENTS;
// Which product departments each reason applies to (the product's department comes from the database).
//  Stock In : supplier deliveries are raw materials / finishing supplies only (finished goods are made in-house),
//             produced batches and customer returns are finished goods,
//             count corrections and "other" can be any department.
//  Stock Out: reasons are matched to the departments where they can really happen.
const REASON_DEPTS = {
  in: {
    supplier_receipt: ['Raw Materials', 'Finishing Supplies'], // finished goods are produced in-house, never bought in
    customer_return: ['Finished Goods'],
    produced_batch: ['Finished Goods'],
    other: ALL_DEPTS
  },
  out: {
    rust_corrosion: ['Raw Materials', 'Finished Goods'],
    damaged: ALL_DEPTS,
    scrap_cutting_waste: ['Raw Materials'],
    quality_rejection: ['Raw Materials', 'Finished Goods'],
    lost_missing: ALL_DEPTS,
    returned_to_supplier: ['Raw Materials', 'Finishing Supplies'],
    other: ALL_DEPTS
  }
};
const NOTE_REQUIRED = ['other', 'count_correction_up', 'count_correction_down'];


/* =====================================================
   Supplier helpers: Title Case, PH phone numbers, email domain check
===================================================== */
const TITLE_KEEP = { gmbh: 'GmbH', llc: 'LLC', plc: 'PLC', cnc: 'CNC', ph: 'PH', usa: 'USA', uae: 'UAE' };
function titleCase(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/(^|[\s\-\/(])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
    .replace(/\b(gmbh|llc|plc|cnc|ph|usa|uae)\b/gi, (w) => TITLE_KEEP[w.toLowerCase()]);
}

const REGIONS = ['NCR - National Capital Region', 'CAR - Cordillera Administrative Region', 'Region I - Ilocos Region',
  'Region II - Cagayan Valley', 'Region III - Central Luzon', 'Region IV-A - CALABARZON', 'MIMAROPA - Region IV-B',
  'Region V - Bicol Region', 'Region VI - Western Visayas', 'NIR - Negros Island Region', 'Region VII - Central Visayas',
  'Region VIII - Eastern Visayas', 'Region IX - Zamboanga Peninsula', 'Region X - Northern Mindanao', 'Region XI - Davao Region',
  'Region XII - SOCCSKSARGEN', 'Region XIII - Caraga', 'BARMM - Bangsamoro Autonomous Region', 'Outside the Philippines'];
const OUTSIDE_PH = 'Outside the Philippines';

const PHONE_MSG = 'Phone number must start with +63 or 09, e.g. +63 917 123 4567 or 0917 123 4567';
function phoneError(raw) {
  if (/[^\d+\s().-]/.test(raw)) return 'Phone number can only have digits, +, spaces and dashes';
  const p = raw.replace(/[\s().-]/g, '');
  if (p.startsWith('+63')) {
    const r = p.slice(3);
    if (!/^\d+$/.test(r)) return PHONE_MSG;
    if (r.startsWith('9')) return r.length === 10 ? '' : 'A +63 mobile number needs 10 digits after +63, e.g. +63 917 123 4567';
    return r.length >= 9 && r.length <= 10 ? '' : PHONE_MSG;               // landline with area code
  }
  if (p.startsWith('09')) return /^09\d{9}$/.test(p) ? '' : 'A 09 mobile number needs 11 digits, e.g. 0917 123 4567';
  return PHONE_MSG;
}
// Philippine MOBILE number (required at registration): 0917 123 4567, +63 917 123 4567, 63917... -> { value: '+63 917 123 4567' }
const MOBILE_MSG = 'Enter a valid Philippine mobile number, e.g. 0917 123 4567 or +63 917 123 4567';
function phMobile(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { error: 'Mobile number is required' };
  if (/[^\d+\s().-]/.test(s)) return { error: 'Mobile number can only have digits, +, spaces and dashes' };
  let p = s.replace(/[\s().-]/g, '');
  if (p.startsWith('+63')) p = p.slice(3);
  else if (p.startsWith('63')) p = p.slice(2);
  else if (p.startsWith('09')) p = p.slice(1);
  else if (!p.startsWith('9')) return { error: MOBILE_MSG };
  if (!/^9\d{9}$/.test(p)) return { error: MOBILE_MSG };
  return { value: '+63 ' + p.slice(0, 3) + ' ' + p.slice(3, 6) + ' ' + p.slice(6) };
}
// New customer accounts must confirm their email before signing in. EMAIL_VERIFICATION=off in .env turns this off (e.g. no email service on a test PC).
const EMAIL_VERIFICATION_ON = String(process.env.EMAIL_VERIFICATION || 'on').toLowerCase() !== 'off';
// ...and confirm their mobile number with a 6-digit text-message code (phone-otp.js). PHONE_VERIFICATION=off in .env turns this off.
const PHONE_VERIFICATION_ON = String(process.env.PHONE_VERIFICATION || 'on').toLowerCase() !== 'off';
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function zipError(zip, region) {
  if (region === OUTSIDE_PH) return /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(zip) ? '' : 'ZIP / postal code must be 3-10 letters or numbers';
  return /^\d{4}$/.test(zip) ? '' : 'ZIP code must be 4 digits, e.g. 1000';
}
// Older suppliers only have one "contact" and one "location" text. Split it so the form can show it.
function supplierFields(r) {
  const segs = String(r.contact || '').split('·').map((x) => x.trim()).filter(Boolean);
  const email = r.email != null ? r.email : ((String(r.contact || '').match(/[^\s@·,;|]+@[^\s@·,;|]+\.[^\s@·,;|]+/) || [])[0] || '');
  const phone = r.phone != null ? r.phone : ((String(r.contact || '').replace(email, ' ').match(/\+?\d[\d\s().-]{5,}\d/) || [])[0] || '');
  const person = r.contact_person != null ? r.contact_person : (segs.find((x) => !/[@\d]/.test(x)) || '');
  const address = r.address_line != null ? r.address_line : (r.location || '');
  const city = r.city || '', province = r.province || '', region = r.region || '', zip = r.zip_code || '', barangay = r.barangay || '';
  const leadTimeDays = r.lead_time_days == null ? null : +r.lead_time_days;
  const area = [city, province].filter(Boolean).join(', ');
  const fullAddress = city ? [address, barangay && (/^(brgy|barangay)/i.test(barangay) ? barangay : 'Brgy. ' + barangay), city, province, [region, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : (r.location || address);
  return { contactPerson: person, phone, email, address, city, province, barangay, region, zip, leadTimeDays,
    contact: [person, phone, email].filter(Boolean).join(' · '), location: area || r.location || address, fullAddress };
}

const COMMON_DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.com.ph', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'proton.me'];
function editDistance(a, b) {   // counts a swapped pair of letters (gmial -> gmail) as one mistake
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);

const emailCache = new Map();   // email -> { at, result }
// Checks that the domain really exists and can receive mail (MX lookup). No API key needed.
// Set EMAIL_CHECK=off in .env to skip (e.g. on a computer with no internet).
async function checkEmailDomain(email) {
  email = String(email || '').trim().toLowerCase();
  const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(email);
  if (!m) return { ok: false, message: 'Enter a valid email address, e.g. name@company.com' };
  const [, local, domain] = m;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) || domain.length > 253)
    return { ok: false, message: 'The email domain "' + domain + '" is not valid' };
  if (process.env.EMAIL_CHECK === 'off') return { ok: true };

  const near = COMMON_DOMAINS.find((d) => d !== domain && editDistance(d, domain) <= 1);
  if (near) return { ok: false, message: 'Did you mean ' + local + '@' + near + '?' };

  const hit = emailCache.get(email);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.result;

  let kind;
  try { kind = await lookupMailDomain(domain); }
  catch (err) {
    // neither this computer's DNS nor the online DNS services could be reached: do not block the save over it
    console.warn('[email] could not check', domain, '-', err.message);
    return { ok: true, unverified: true };
  }
  const result = kind === 'mail' ? { ok: true }
    : kind === 'nodomain' ? { ok: false, message: 'The domain "' + domain + '" does not exist or cannot receive email' }
    : { ok: false, message: 'The domain "' + domain + '" cannot receive email' };
  emailCache.set(email, { at: Date.now(), result });
  return result;
}
// DNS over HTTPS (port 443): works even when the computer's own DNS server refuses Node's lookups (common on Windows / VPN / school networks)
async function dohLookup(domain, type) {
  const q = encodeURIComponent(domain);
  const urls = [`https://cloudflare-dns.com/dns-query?name=${q}&type=${type}`, `https://dns.google/resolve?name=${q}&type=${type}`];
  let lastErr;
  for (const url of urls) {
    try {
      const j = await fetchJson(url, 6000, { Accept: 'application/dns-json' });
      if (typeof j.Status === 'number') return { status: j.Status, answers: j.Answer || [] };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('DNS-over-HTTPS unreachable');
}
const dnsCode = (e) => e && (e.code || '');
// -> 'mail' (can receive email) | 'nomail' | 'nodomain'; throws when nothing could be checked
async function lookupMailDomain(domain) {
  try {                                                         // 1. the computer's own DNS
    const mx = await withTimeout(dns.resolveMx(domain), 4000);
    const real = (mx || []).filter((r) => r.exchange && r.exchange !== '.');   // "." is a null MX = the domain says it takes no email
    return real.length ? 'mail' : 'nomail';
  } catch (err) {
    if (dnsCode(err) === 'ENODATA') {                           // no MX record: mail can still go to the domain's own address (A record)
      try { const a = await withTimeout(dns.resolve4(domain), 4000); return a && a.length ? 'mail' : 'nomail'; }
      catch (e2) { if (['ENODATA', 'ENOTFOUND'].includes(dnsCode(e2))) return 'nodomain'; /* else fall through to DoH */ }
    } else if (dnsCode(err) === 'ENOTFOUND') return 'nodomain';
  }
  const mx = await dohLookup(domain, 'MX');                     // 2. online DNS
  if (mx.status === 3) return 'nodomain';                       // NXDOMAIN
  const hasMx = mx.answers.some((a) => a.type === 15 && !/^\d+\s+\.?$/.test(String(a.data || '').trim()));
  if (hasMx) return 'mail';
  const a = await dohLookup(domain, 'A');
  return a.answers.some((x) => x.type === 1) ? 'mail' : (a.status === 3 ? 'nodomain' : 'nomail');
}
// User accounts (customers and staff) must use a personal email from a well-known public provider.
// Company / private-domain addresses are refused. Suppliers are companies, so they keep using assertEmailDomain only.
const PERSONAL_EMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.com.ph', 'ymail.com', 'rocketmail.com',
  'outlook.com', 'outlook.ph', 'hotmail.com', 'hotmail.ph', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com']
  .concat(String(process.env.PERSONAL_EMAIL_DOMAINS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean)));   // .env can add more
async function assertPersonalEmail(email) {
  if (!email) return;
  const domain = String(email).toLowerCase().split('@').pop();
  if (!PERSONAL_EMAIL_DOMAINS.has(domain))
    throw new ValidationError({ email: 'Use a personal email (Gmail, Yahoo, Outlook, iCloud…). Company or private-domain emails are not allowed.' });
  await assertEmailDomain(email);
}
async function assertEmailDomain(email) {
  if (!email) return;
  const r = await checkEmailDomain(email);
  if (!r.ok) throw new ValidationError({ email: r.message });
}


/* =====================================================
   Philippine address data (PSGC) + ZIP code check
   Region -> Province -> City/Municipality come from the PSGC API (cached in memory).
   ZIP codes are checked against the GeoNames PH postal list (downloaded once, kept in backend/data),
   with OpenStreetMap Nominatim as a second opinion. No API key needed.
   Set ADDRESS_CHECK=off in .env to skip these checks (e.g. a computer with no internet).
===================================================== */
const fs = require('fs');
const zlib = require('zlib');
const PSGC_BASE = (process.env.PSGC_API_BASE || 'https://psgc.gitlab.io/api').replace(/\/+$/, '');
const GEO_TTL = 24 * 3600 * 1000;
const geoCache = new Map();   // url -> { at, data }

const https = require('https'), http = require('http');
// plain HTTP(S) GET that works on every Node version (global fetch needs Node 18+)
function httpGet(url, { ms = 8000, headers, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Bad URL ' + url)); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: Object.assign({ 'User-Agent': 'TripleE-Inventory/1.0', Accept: 'application/json,*/*' }, headers) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, u).toString(), { ms, headers, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(ms, () => req.destroy(Object.assign(new Error('timed out after ' + ms / 1000 + 's'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
  });
}
async function fetchJson(url, ms = 8000, headers) {
  const r = await httpGet(url, { ms, headers });
  if (r.status < 200 || r.status >= 300) throw Object.assign(new Error('HTTP ' + r.status + ' from ' + url), { status: r.status });
  return JSON.parse(r.body.toString('utf8'));
}
let lastGeoError = '';
async function psgc(pathname) {
  const hit = geoCache.get(pathname);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.data;
  let data, lastErr;
  for (const url of [`${PSGC_BASE}${pathname}.json`, `${PSGC_BASE}${pathname}/`]) {
    try { data = await fetchJson(url); if (Array.isArray(data)) break; lastErr = new Error('Unexpected reply from ' + url); data = null; }
    catch (err) { lastErr = err; }
  }
  if (!Array.isArray(data)) {
    if (hit) return hit.data;                                   // serve stale data rather than fail
    lastGeoError = (lastErr && (lastErr.code ? lastErr.code + ': ' : '') + lastErr.message) || 'unknown error';
    console.warn('[geo] PSGC request failed:', pathname, '-', lastGeoError);
    throw Object.assign(new Error('Address service unavailable: ' + lastGeoError), { geo: true, cause: lastErr });
  }
  lastGeoError = '';
  geoCache.set(pathname, { at: Date.now(), data });
  return data;
}
const sortByName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });
const slim = (rows, nameOf) => rows.map((r) => ({ code: r.code, name: nameOf ? nameOf(r) : r.name })).sort(sortByName);
// "NCR - National Capital Region", "Region III - Central Luzon" (same labels the old dropdown used)
const regionLabel = (r) => (r.regionName && r.regionName !== r.name ? `${r.name} - ${r.regionName}` : r.name);
const FALLBACK_REGIONS = [['130000000', 'NCR - National Capital Region'], ['140000000', 'CAR - Cordillera Administrative Region'],
  ['010000000', 'Region I - Ilocos Region'], ['020000000', 'Region II - Cagayan Valley'], ['030000000', 'Region III - Central Luzon'],
  ['040000000', 'Region IV-A - CALABARZON'], ['170000000', 'MIMAROPA - Region IV-B'], ['050000000', 'Region V - Bicol Region'],
  ['060000000', 'Region VI - Western Visayas'], ['180000000', 'NIR - Negros Island Region'], ['070000000', 'Region VII - Central Visayas'],
  ['080000000', 'Region VIII - Eastern Visayas'], ['090000000', 'Region IX - Zamboanga Peninsula'], ['100000000', 'Region X - Northern Mindanao'],
  ['110000000', 'Region XI - Davao Region'], ['120000000', 'Region XII - SOCCSKSARGEN'], ['160000000', 'Region XIII - Caraga'],
  ['190000000', 'BARMM - Bangsamoro Autonomous Region']].map(([code, name]) => ({ code, name }));
const getRegions = async () => {
  try { const r = slim(await psgc('/regions'), regionLabel).filter((x) => x.name); if (r.length) return r; }
  catch (err) { console.warn('[geo] using the built-in region list:', err.message); }
  return FALLBACK_REGIONS;
};
const getProvinces = async (regionCode) => {
  try { return slim(await psgc(`/regions/${encodeURIComponent(regionCode)}/provinces`)); }
  catch (err) { if (err.cause && err.cause.status === 404) return []; throw err; }   // NCR has no provinces
};
const getCitiesOfProvince = async (code) => slim(await psgc(`/provinces/${encodeURIComponent(code)}/cities-municipalities`));
const getBarangaysOfCity = async (code) => {
  try { return slim(await psgc(`/cities-municipalities/${encodeURIComponent(code)}/barangays`)); }
  catch (err) { if (err.cause && err.cause.status === 404) return []; throw err; }
};
const getCitiesOfRegion = async (code) => slim(await psgc(`/regions/${encodeURIComponent(code)}/cities-municipalities`));

// loose name matching: "City of Cebu" ~ "Cebu City", "Dasmariñas" ~ "Dasmarinas"
function norm(v) {
  return String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ').replace(/\bcity of\b|\bmunicipality of\b|\bprovince of\b|\bcity\b|\bmunicipality\b|\bprov\.?\b/g, ' ')
    .replace(/\bsta\.?\b/g, 'santa').replace(/\bsto\.?\b/g, 'santo').replace(/\bgen\.?\b/g, 'general')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
const sameName = (a, b) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/* ----- ZIP list (GeoNames) ----- */
const ZIP_FILE = path.join(__dirname, 'data', 'ph-zip.json');
let zipRows = null, zipLoading = null;
function readZipEntry(buf, wanted) {          // tiny zip reader: finds one file and inflates it
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42), name = buf.toString('utf8', off + 46, off + 46 + nlen);
    if (name === wanted) {
      const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      const raw = buf.subarray(dataStart, dataStart + csize);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    off += 46 + nlen + elen + clen;
  }
  throw new Error(wanted + ' not found in zip');
}
function parseGeoNames(txt) {
  // country, postal, place, admin1, code1, admin2, code2, admin3, code3, lat, lon, accuracy
  return txt.split('\n').map((l) => l.split('\t')).filter((c) => c.length >= 8 && /^\d{4}$/.test(c[1]))
    .map((c) => ({ zip: c[1], place: c[2], admin1: c[3], admin2: c[5], admin3: c[7] }));
}
async function loadZipRows() {
  if (zipRows) return zipRows;
  if (zipLoading) return zipLoading;
  zipLoading = (async () => {
    try {
      let fresh = false;
      try { fresh = Date.now() - fs.statSync(ZIP_FILE).mtimeMs < 30 * 24 * 3600 * 1000; } catch { /* no file yet */ }
      if (fresh) { zipRows = JSON.parse(fs.readFileSync(ZIP_FILE, 'utf8')); return zipRows; }
      try {
        const r = await httpGet('https://download.geonames.org/export/zip/PH.zip', { ms: 25000 });
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        zipRows = parseGeoNames(readZipEntry(r.body, 'PH.txt').toString('utf8'));
        if (zipRows.length < 500) throw new Error('ZIP list looks incomplete');
        fs.mkdirSync(path.dirname(ZIP_FILE), { recursive: true });
        fs.writeFileSync(ZIP_FILE, JSON.stringify(zipRows));
      } catch (err) {
        console.warn('[zip] download failed:', err.message);
        try { zipRows = JSON.parse(fs.readFileSync(ZIP_FILE, 'utf8')); } catch { zipRows = null; }   // old copy is better than nothing
      }
      return zipRows;
    } finally { zipLoading = null; }
  })();
  return zipLoading;
}

let lastNominatim = 0;
async function nominatimZip(zip) {
  const wait = lastNominatim + 1100 - Date.now();               // their policy: max 1 request / second
  lastNominatim = Date.now() + Math.max(wait, 0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=10&countrycodes=ph&postalcode=' + encodeURIComponent(zip);
  return fetchJson(url, 8000, { 'User-Agent': 'TripleE-Inventory/1.0' });
}

const zipCache = new Map();
// Does this ZIP belong to the chosen city / province?  -> { ok, unknown?, message }
async function checkZipMatch({ zip, city, province, barangay }) {
  const key = [zip, norm(city), norm(province), norm(barangay)].join('|');
  const hit = zipCache.get(key);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.result;
  const done = (result) => { if (!result.unknown) zipCache.set(key, { at: Date.now(), result }); return result; };

  const isNcr = /metro manila|national capital|^ncr$/.test(norm(province));
  const provinceHit = (x) => sameName(x.admin2, province) || sameName(x.admin1, province) || sameName(x.admin3, province)
    || (isNcr && /metro manila|national capital/i.test([x.admin1, x.admin2].join(' ')));
  const cityHit = (x) => sameName(x.place, city) || sameName(x.admin3, city) || (!!barangay && sameName(x.place, barangay));

  let rows = null;
  try { rows = await loadZipRows(); } catch { rows = null; }
  const found = rows ? rows.filter((x) => x.zip === zip) : [];
  if (found.some((x) => cityHit(x) && provinceHit(x)) || found.some((x) => cityHit(x) && !x.admin2 && !x.admin1)) return done({ ok: true });

  // second opinion: OpenStreetMap
  let osm = null;
  try { osm = await nominatimZip(zip); } catch { osm = null; }
  if (Array.isArray(osm) && osm.length) {
    const cityOk = osm.some((o) => { const a = o.address || {}; return [a.city, a.town, a.municipality, a.village, a.suburb, a.city_district, a.county]
      .some((v) => v && sameName(v, city)) || sameName(o.display_name, city) && norm(o.display_name).split(' ').includes(norm(city).split(' ')[0]); });
    const provOk = osm.some((o) => { const a = o.address || {}; return [a.state, a.province, a.region, a.county, a.state_district]
      .some((v) => v && sameName(v, province)) || (isNcr && /metro manila|national capital/i.test(o.display_name || '')); });
    if (cityOk && provOk) return done({ ok: true });
  }

  if (!rows && !(Array.isArray(osm) && osm.length))
    return { ok: false, unknown: true, message: 'Could not check the ZIP code right now. Check the internet connection and try again.' };

  if (found.length) {
    const where = [...new Set(found.map((x) => [x.place, x.admin2 || x.admin1].filter(Boolean).join(', ')))].slice(0, 3).join(' / ');
    return done({ ok: false, message: `ZIP code ${zip} does not match ${city}, ${province}. It belongs to ${where}.`, expected: where });
  }
  if (Array.isArray(osm) && osm.length) {
    const o = osm[0], a = o.address || {};
    const where = [a.city || a.town || a.municipality || a.village, a.state || a.province].filter(Boolean).join(', ') || String(o.display_name || '').split(',').slice(0, 2).join(',');
    return done({ ok: false, message: `ZIP code ${zip} does not match ${city}, ${province}. It belongs to ${where}.`, expected: where });
  }
  return done({ ok: false, message: `ZIP code ${zip} was not found in the Philippine postal list. Check the ZIP code.` });
}

// Region -> Province -> City must be a real PSGC path, and the ZIP must belong to that city
async function checkAddress({ region, province, city, barangay, zip }) {
  if (process.env.ADDRESS_CHECK === 'off' || region === OUTSIDE_PH) return {};
  const err = {};
  let regions;
  try { regions = await getRegions(); } catch { return { region: 'Could not load the region list right now. Check the internet connection and try again.' }; }
  const reg = regions.find((r) => r.name === region) || regions.find((r) => sameName(r.name, region));
  if (!reg) return { region: 'Choose a valid region' };
  try {
    let provs = await getProvinces(reg.code);
    let cities;
    if (provs.length) {
      const prov = provs.find((p) => p.name.toLowerCase() === province.toLowerCase()) || provs.find((p) => sameName(p.name, province));
      if (!prov) return { province: `"${province}" is not a province of ${reg.name}` };
      cities = await getCitiesOfProvince(prov.code);
    } else {                                                    // NCR has no provinces
      if (!/metro manila|national capital|^ncr$/.test(norm(province))) return { province: `${reg.name} has no provinces — use "Metro Manila"` };
      cities = await getCitiesOfRegion(reg.code);
    }
    const c = cities.find((x) => x.name.toLowerCase() === city.toLowerCase()) || cities.find((x) => norm(x.name) === norm(city));
    if (!c) return { city: `"${city}" is not a city / municipality of ${province}` };
    try {                                                       // the barangay must belong to the city (skipped when the list is empty / unavailable)
      const bgys = await getBarangaysOfCity(c.code);
      if (bgys.length && !bgys.some((x) => norm(x.name) === norm(barangay))) return { barangay: `"${barangay}" is not a barangay of ${city}` };
    } catch { /* barangay list unavailable: do not block */ }
  } catch { return { city: 'Could not load the city list right now. Check the internet connection and try again.' }; }
  if (zip && /^\d{4}$/.test(zip)) {
    const z = await checkZipMatch({ zip, city, province, barangay });
    if (!z.ok && !z.unknown) err.zip = z.message;
  }
  return err;
}
async function assertAddress(s, was) {
  // an old address that is left exactly as it was is not re-checked (older records may not match PSGC names)
  if (was && ['region', 'province', 'city', 'barangay', 'zip'].every((k) => String(was[k] || '') === String(s[k] || ''))) return;
  const e = await checkAddress(s);
  if (Object.keys(e).length) throw new ValidationError(e);
}

/* ----- Customer delivery address (online shop) -----
   Street line + Region/Province/City/Barangay (PSGC) + ZIP. Same checks as the supplier form,
   but delivery is Philippines only. If the PSGC / ZIP services are unreachable the format checks
   still apply and the order is not blocked (the outage is logged). */
function formatShipTo(a) {
  const brgy = a.barangay && (/^(brgy|barangay)/i.test(a.barangay) ? a.barangay : 'Brgy. ' + a.barangay);
  return [a.addressLine, brgy, a.city, a.province, a.zip].filter(Boolean).join(', ');
}
async function validateShipTo(b) {
  const e = {};
  const recipient = text(e, 'recipient', b.recipient, 'Recipient name', { min: 2, max: 80 });
  if (recipient && !e.recipient && !/^[\p{L}][\p{L}\p{M}\s.,'’-]*$/u.test(recipient)) e.recipient = 'Recipient name can only have letters, spaces, . , \' and -';
  const addressLine = text(e, 'addressLine', b.addressLine, 'House / unit no., street, block, lot', { min: 5, max: 150 });
  if (addressLine && !e.addressLine && !/[\p{L}]/u.test(addressLine)) e.addressLine = 'Enter the street name, e.g. "Blk 5 Lot 12 Sampaguita St."';
  const landmark = text(e, 'landmark', b.landmark, 'Landmark', { max: 120, required: false });
  const region = str(b.region);
  if (!region) e.region = 'Choose a region';
  else if (region === OUTSIDE_PH) e.region = 'We only deliver within the Philippines';
  else if (region.length > 100 || (process.env.ADDRESS_CHECK === 'off' && !REGIONS.includes(region))) e.region = 'Choose a valid region';
  const province = text(e, 'province', b.province, 'Province', { min: 2, max: 60 });
  const city = text(e, 'city', b.city, 'City / Municipality', { min: 2, max: 60 });
  const barangay = text(e, 'barangay', b.barangay, 'Barangay', { min: 2, max: 80 });
  const zip = text(e, 'zip', b.zip, 'ZIP code', { min: 1, max: 10 });
  if (zip && !e.zip && !e.region) { const m = zipError(zip, region); if (m) e.zip = m; }
  if (Object.keys(e).length) throw new ValidationError(e);
  const s = { recipient, addressLine, landmark, region, province, city, barangay, zip };
  const geo = await checkAddress({ region, province, city, barangay, zip });
  const down = Object.values(geo).find((m) => /^Could not load/.test(m));
  if (down) console.warn('[geo] address service unavailable, order address accepted without the PSGC/ZIP check:', down);
  else if (Object.keys(geo).length) throw new ValidationError(geo);
  s.fullAddress = formatShipTo(s);
  return s;
}

const str = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
function text(errors, key, v, label, { min = 1, max = 120, required = true } = {}) {
  const s = str(v);
  if (!s) { if (required) errors[key] = `${label} is required`; return s; }
  if (s.length < min) errors[key] = `${label} must be at least ${min} characters`;
  else if (s.length > max) errors[key] = `${label} must be at most ${max} characters`;
  return s;
}
function number(errors, key, v, label, { min = 0, max = 1e8, dp = 2, required = true, gt = false } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) errors[key] = `${label} is required`;
    return null;
  }
  // JSON booleans/arrays and JavaScript-only formats must never become business quantities.
  if ((typeof v !== 'number' && typeof v !== 'string') ||
      (typeof v === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()))) {
    errors[key] = `${label} must be a number`; return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) { errors[key] = `${label} must be a number`; return null; }
  if (gt ? n <= min : n < min) { errors[key] = gt ? `${label} must be greater than ${min}` : `${label} cannot be negative`; return null; }
  if (n > max) { errors[key] = `${label} is too large`; return null; }
  if (Math.round(n * 10 ** dp) / 10 ** dp !== n) { errors[key] = `${label} can have at most ${dp} decimal places`; return null; }
  return n;
}
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function validateProduct(b, { creating }) {
  const e = {};
  const sku = str(b.sku).toUpperCase();
  if (!sku) e.sku = 'SKU is required';
  else if (!/^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(sku)) e.sku = 'SKU must be 3–40 characters: letters, numbers, dot, dash or underscore';
  const name = text(e, 'name', b.name, 'Product name', { min: 2, max: 120 });
  const department = str(b.department);
  if (!DEPARTMENTS.includes(department)) e.department = 'Choose a valid department';
  const category = text(e, 'category', b.category, 'Category', { min: 2, max: 60 });
  const unit = str(b.unit);
  if (!unit) e.unit = 'Unit is required';
  else if (!UNITS.includes(unit)) e.unit = 'Choose a unit from the list';
  // Finished goods are counted and sold by the piece. Raw materials / finishing supplies keep kg, sheet, roll, liter... as before.
  else if (department === 'Finished Goods' && unit !== FINISHED_GOODS_UNIT) e.unit = 'Finished goods are sold by the piece. Choose pcs';
  // Triple E only sells its two product lines; Raw Materials / Finishing Supplies keep free categories
  if (department === 'Finished Goods' && category && !FINISHED_GOODS_CATEGORIES.some((c) => c.toLowerCase() === category.toLowerCase()))
    e.category = 'Finished goods are ' + FINISHED_GOODS_CATEGORIES.join(' or ');
  // new raw materials: aluminum or brass only (an edit of an old product is checked in the PUT route, where its saved category is known)
  if (creating && department === 'Raw Materials' && category && !isRawMaterialCategory(category))
    e.category = 'Raw materials are ' + RAW_MATERIAL_CATEGORIES.join(' or ') + ' (we only work in aluminum and brass)';
  // a finished good's cost is worked out from its recipe (recipe-costing.js): the form does not have to send it
  const unitCost = number(e, 'unitCost', b.unitCost, 'Unit cost', { max: 1e7, required: department !== 'Finished Goods' });
  // only Finished Goods are sold: they need a selling price; every other department has none (stored as 0)
  // priceAuto (finished goods): the selling price is unit cost + the markup (pricing.js keeps it right in the database).
  // true = automatic (default), false = Finance typed its own price, null = flag not sent: keep what is saved.
  const priceAuto = department !== 'Finished Goods' ? null : b.priceAuto === undefined ? (creating ? true : null) : b.priceAuto === true;
  const listPrice = department === 'Finished Goods'
    ? (priceAuto === true ? null : number(e, 'listPrice', b.listPrice, 'Selling price', { max: 1e7, gt: true }))
    : 0;
  // Reorder level is worked out automatically from usage (reorder.js) unless Finance ticks "Set manually".
  // reorderAuto: true = automatic, false = manual, null = flag not sent (an older form): keep the saved flag and read the level as before.
  const reorderAuto = b.reorderAuto === undefined ? (creating ? true : null) : b.reorderAuto === true;
  const reorderLevel = reorderAuto === true ? null : number(e, 'reorderLevel', b.reorderLevel, 'Reorder level', { max: 1e8 });
  const onHand = creating ? number(e, 'onHand', b.onHand, 'On hand', { max: 1e8 }) : null;
  const location = text(e, 'location', b.location, 'Storage location', { min: 2, max: 100 });
  // weight of one piece, in kg: the delivery fee adds a weight charge from it (delivery-calc.js). Blank = not recorded; undefined = form did not send it, keep what is saved.
  const weightKg = department !== 'Finished Goods' ? null : b.weightKg === undefined ? undefined : number(e, 'weightKg', b.weightKg, 'Weight per piece', { max: 100000, dp: 3, required: false });

  if (Object.keys(e).length) throw new ValidationError(e);
  return { sku, name, department, category, unit, unitCost, listPrice, priceAuto, reorderLevel, reorderAuto, onHand, location: location || null, weightKg };
}
function validateSupplier(b, stored, creating) {
  // `stored` = the supplier's current phone/email when editing; an old value left unchanged is not re-checked
  const e = {};
  let name = text(e, 'name', b.name, 'Supplier name', { min: 2, max: 120 });
  if (name && !e.name) name = titleCase(name);
  if (name && !e.name && !/[A-Za-z]/.test(name)) e.name = 'Supplier name must contain letters';
  let contactPerson = text(e, 'contactPerson', b.contactPerson, 'Contact person', { min: 2, max: 80 });
  if (contactPerson && !e.contactPerson && !/^[A-Za-z][A-Za-z .,'’-]*$/.test(contactPerson)) e.contactPerson = 'Contact person can only have letters, spaces, . , \' and -';
  if (contactPerson && !e.contactPerson) contactPerson = titleCase(contactPerson);

  const phone = text(e, 'phone', b.phone, 'Phone number', { min: 7, max: 30, required: false });
  if (phone && !e.phone && !(stored && stored.phone === phone)) { const m = phoneError(phone); if (m) e.phone = m; }
  const email = text(e, 'email', b.email, 'Email', { min: 5, max: 120, required: false }).toLowerCase();
  if (email && !e.email && !(stored && stored.email === email) && !EMAIL_FORMAT.test(email))
    e.email = 'Enter a valid email address, e.g. name@company.com';
  if (!phone && !email) { e.phone = e.phone || 'Enter a phone number or an email address'; e.email = e.email || 'Enter a phone number or an email address'; }

  let address = text(e, 'address', b.address, 'Warehouse address', { min: 5, max: 150 });
  if (address && !e.address) address = titleCase(address);
  let city = text(e, 'city', b.city, 'City / Municipality', { min: 2, max: 60 });
  let province = text(e, 'province', b.province, 'Province / State', { min: 2, max: 60 });
  const region = str(b.region);
  let barangay = text(e, 'barangay', b.barangay, 'Barangay', { min: 2, max: 80, required: region !== OUTSIDE_PH });
  // names picked from the PSGC list keep their official spelling; only typed-in foreign addresses are Title Cased
  if (region === OUTSIDE_PH) {
    if (barangay && !e.barangay) barangay = titleCase(barangay);
    if (city && !e.city) city = titleCase(city);
    if (province && !e.province) province = titleCase(province);
  }
  if (!region) e.region = 'Choose a region';
  else if (region.length > 100 || (process.env.ADDRESS_CHECK === 'off' && !REGIONS.includes(region))) e.region = 'Choose a valid region';   // the PSGC check below confirms it
  const zip = text(e, 'zip', b.zip, 'ZIP code', { min: 1, max: 10 });
  if (zip && !e.zip && !e.region) { const m = zipError(zip, region); if (m) e.zip = m; }

  const status = b.status === undefined ? undefined : str(b.status);
  if (status !== undefined && !['active', 'archived'].includes(status)) e.status = 'Invalid status';
  let productSkus;
  if (b.productSkus !== undefined) {
    if (!Array.isArray(b.productSkus) || b.productSkus.some(c => typeof c !== 'string')) e.products = 'Invalid product list';
    else productSkus = [...new Set(b.productSkus.map(s => str(s).toUpperCase()).filter(Boolean))];
  }
  if (productSkus && !productSkus.length) e.products = 'Tick at least one product this supplier provides';
  if (creating && b.productSkus === undefined) e.products = 'Tick at least one product this supplier provides';
  // days from ordering to delivery; used by the automatic reorder level of the products this supplier is the main supplier of
  const leadRaw = b.leadTimeDays;
  let leadTimeDays = null;
  if (leadRaw !== undefined && leadRaw !== null && leadRaw !== '') {
    const n = Number(leadRaw);
    if (!Number.isInteger(n) || n < 0 || n > 365) e.leadTimeDays = 'Lead time must be a whole number of days from 0 to 365';
    else leadTimeDays = n;
  }
  if (Object.keys(e).length) throw new ValidationError(e);
  const f = supplierFields({ contact_person: contactPerson || '', phone, email, address_line: address, city, province, region, zip_code: zip, barangay });
  return { name, contactPerson: contactPerson || null, phone: phone || null, email: email || null, address, city, province, barangay, region, zip,
    contact: f.contact, location: f.location, status, productSkus, leadTimeDays };
}
function validateMovement(b) {
  const e = {};
  const sku = str(b.sku).toUpperCase();
  if (!sku) e.sku = 'Choose a product';
  const type = str(b.type);
  if (!['in', 'out'].includes(type)) e.type = 'Choose Stock In or Stock Out';
  const reason = str(b.reason);
  if (!reason) e.reason = type === 'out' ? 'Choose why this stock is going out' : 'Choose why this stock is coming in';
  else if (REASONS[type] && !REASONS[type][reason]) e.reason = 'That reason is not valid for this movement type';
  const quantity = number(e, 'quantity', b.quantity, 'Quantity', { min: 0, max: 1e8, gt: true });
  const note = text(e, 'note', b.note, 'Note', { max: 300, required: false });
  if (!e.reason && NOTE_REQUIRED.includes(reason) && note.length < 3) e.note = 'Please explain this entry in the note';
  // Deliveries from a supplier: who sent it (required) and the supplier's invoice / delivery receipt number
  let supplier = null, invoiceNo = null, unitCost = null;
  if (type === 'in' && reason === 'supplier_receipt') {
    supplier = str(b.supplier);
    if (!supplier) e.supplier = 'Choose the supplier this delivery came from';
    invoiceNo = text(e, 'invoiceNo', b.invoiceNo, 'Invoice / delivery no.', { max: 40, required: false }) || null;
    // optional: what the supplier charged per unit on this delivery; it updates the product's average cost
    const raw = String(b.unitCost == null ? '' : b.unitCost).replace(/[,₱\s]/g, '');
    if (b.unitCost != null && typeof b.unitCost !== 'number' && typeof b.unitCost !== 'string')
      e.unitCost = 'Enter the cost per unit in pesos, e.g. 145.50';
    else if (raw !== '') {
      if (!/^\d{1,8}(\.\d{1,2})?$/.test(raw)) e.unitCost = 'Enter the cost per unit in pesos, e.g. 145.50';
      else if (!(Number(raw) > 0)) e.unitCost = 'The cost per unit must be more than 0';
      else unitCost = Number(raw);
    }
  }
  if (Object.keys(e).length) throw new ValidationError(e);
  return { sku, type, reason, quantity, note: note || null, supplier, invoiceNo, unitCost };
}

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, fields: err.fields });
  console.error(err);
  if (err.code === '23505') {
    const what = /sku/i.test(err.detail || '') ? { fields: { sku: 'That SKU already exists' }, error: 'That SKU already exists' }
      : /name|code/i.test(err.constraint || err.detail || '') ? { fields: { name: 'That name already exists' }, error: 'That name already exists' }
      : { error: 'That record already exists' };
    return res.status(409).json(what);
  }
  if (err.code === '23514') return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'Server error' });
});
const tx = async (fn) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
};

/* ---------- auth ---------- */
// Session + role check lives in auth-middleware.js (401 not signed in, 403 wrong role BEFORE any database work, 401 disabled account).
const { auth, forgetAccountCheck, revocation, sessions } = require('./auth-middleware')(pool);
app.locals.forgetAccountCheck = forgetAccountCheck;
app.locals.userSessions = sessions;                  // one row per signed-in device (db/026): device limits, logout, password change
app.locals.sessionRevocation = revocation;           // password change / reset: sign the person out everywhere else (users.token_version)

/* The ONLY place a session cookie is written. tv = users.token_version the session is issued for (see auth-middleware.js). */
const SESSION_MS = 8 * 3600 * 1000;
function startSession(res, user, tv, sid) {
  res.cookie('session', jwt.sign({ id: user.id, name: user.name, role: user.role, roleLabel: user.roleLabel, tv: Number(tv) || 0, ...(sid ? { sid } : {}) }, process.env.JWT_SECRET, { expiresIn: '8h' }), {
    httpOnly: true, sameSite: 'lax', secure: security.cookieSecure(), maxAge: SESSION_MS });
}

// Audit entries also record the client address and browser (db/025). The columns are added at start-up too; until that finishes, the old insert is used.
let auditHasWho = false;
pool.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address TEXT')
  .then(() => pool.query('ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT'))
  .then(() => { auditHasWho = true; })
  .catch((e) => console.warn('[audit] the audit log will not record IP address / browser (could not add the columns):', e.message));
async function audit(client, user, action, detail) {
  if (!auditHasWho) return client.query(
    `INSERT INTO audit_log (user_id, user_name, role_label, action, detail) VALUES ($1,$2,$3,$4,$5)`,
    [user.id, user.name, user.roleLabel, action, detail]);
  const ctx = requestContext.getStore() || {};
  return client.query(
    `INSERT INTO audit_log (user_id, user_name, role_label, action, detail, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [user.id, user.name, user.roleLabel, action, detail, ctx.ip ? String(ctx.ip).slice(0, 64) : null, ctx.ua ? String(ctx.ua).slice(0, 300) : null]);
}

const userLifecycle = require('./user-lifecycle')({ pool, tx, audit, revocation, sessions, forgetAccountCheck, ValidationError });

app.locals.alerts = require('./security-alerts')({ mailer: require('./mailer') });   // detective control: alerts on repeated failed sign-ins (OWASP A09)
require('./login-lockout')({ app, pool, wrap, audit, str, EMAIL_RE });
/* The ONLY place a sign-in session is started. Called after the password AND the one-time code (login-otp.js) were right,
   or straight after the password when LOGIN_OTP=off. u needs user_id, full_name, role_key, label. */
// DEVICE LIMIT per role (SESSION_LIMITS, default "finance=1,cashier=1,customer=3"): how many devices can be signed in to one account at the same time.
// Signing in over the limit ends the OLDEST session, which is refused on its next request ("signed in on another device"). Logging out frees a place.
// A role that is not listed has no limit; "SESSION_LIMITS=" (empty) turns limits off. (OWASP ASVS V3.3 concurrent session control, A07.)
const parseLimits = (v) => { const out = {}; String(v).split(',').forEach((pair) => { const [role, n] = pair.split('=').map((x) => x.trim()); const k = Math.floor(Number(n)); if (role && Number.isFinite(k) && k > 0 && k <= 50) out[role] = k; }); return out; };
const SESSION_LIMITS = parseLimits(process.env.SESSION_LIMITS === undefined ? 'finance=1,cashier=1,customer=3' : process.env.SESSION_LIMITS);
app.locals.sessionLimits = SESSION_LIMITS;
app.locals.completeLogin = async (res, u, how) => {
  const user = { id: u.user_id, name: u.full_name, role: u.role_key, roleLabel: u.label };
  const limit = SESSION_LIMITS[u.role_key] || 0, ctx = requestContext.getStore() || {};
  let tv = u.token_version, ended = 0;
  const sid = await sessions.create({ userId: u.user_id, ttlMs: SESSION_MS, ip: ctx.ip, ua: ctx.ua });   // this device
  if (limit && sid) ended = await sessions.enforceLimit(u.user_id, limit);                                // older devices over the limit end
  else if (limit === 1) { const next = await revocation.bump(pool, u.user_id); if (next) { tv = next; ended = -1; } }   // no device table: still keep ONE device by ending every older session
  forgetAccountCheck(u.user_id);
  await pool.query('UPDATE users SET last_login = now() WHERE user_id = $1', [u.user_id]);
  await audit(pool, user, 'Login', 'Successful login' + (how ? ' (one-time code by ' + how + ')' : '')
    + (ended ? '; ' + (ended > 0 ? ended + ' older device(s) signed out' : 'older sessions ended') + ' (limit of ' + limit + ' device' + (limit === 1 ? '' : 's') + ' for ' + user.roleLabel + ' accounts)' : ''));
  startSession(res, user, tv, sid);
  return user;
};
require('./login-otp')({ app, pool, wrap, tx, audit, str });
app.post('/api/auth/login', wrap(async (req, res) => {
  const email = str(req.body && req.body.email).toLowerCase();
  const password = req.body && req.body.password;
  if (!EMAIL_RE.test(email) || email.length > 254 || typeof password !== 'string' || !password || password.length > 200)
    return res.status(400).json({ error: 'Enter a valid email and password' });
  const lock = app.locals.loginLock;
  const { rows } = await pool.query(
    `SELECT u.*, r.role_key, r.label FROM users u JOIN roles r USING (role_id) WHERE u.email = $1`, [email]);
  const u = rows[0];
  // locked account: refuse BEFORE checking the password (the cooldown only runs after the emailed link was opened)
  if (u && u.status === 'active') {
    const st = await lock.status(u.user_id);
    if (st) return res.status(423).json(st);
  }
  if (!u || u.status !== 'active' || !(await bcrypt.compare(password, u.password_hash))) {
    app.locals.alerts.failedLogin({ ip: req.ip, email }).catch(() => {});
    if (u && u.status === 'active') {
      const f = await lock.fail(u, req);
      if (f.locked) app.locals.alerts.lockout({ email: u.email, role: u.role_key }).catch(() => {});
      if (f.locked) return res.status(423).json({ code: 'LOCKED', secondsLeft: 0, emailSent: f.emailSent,
        error: 'Too many failed attempts. ' + (f.emailSent ? 'We emailed you an unlock link. Open it to unlock your account.' : 'We could not send the unlock email. Try "Resend unlock link" in a minute.') });
      return res.status(401).json({ error: 'Invalid email or password', attemptsLeft: f.attemptsLeft });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  // EVERY account (customer, cashier, finance) must have confirmed BOTH its email and its mobile number (only said after the password is right).
  // Staff prove their email by opening the invitation link, so for them only the mobile code is left.
  // Older accounts were marked verified when these checks were added; an account with no mobile number on file is never blocked.
  {
    await app.locals.phoneReady;
    const fresh = (await pool.query('SELECT email_verified_at, phone_verified_at, phone FROM users WHERE user_id = $1', [u.user_id])).rows[0] || {};
    const emailOk = !EMAIL_VERIFICATION_ON || !!fresh.email_verified_at;
    const phoneOk = !app.locals.phoneOtp.needsPhone(fresh);
    if (!emailOk || !phoneOk) {
      const missing = !emailOk && !phoneOk ? 'your email address and your mobile number' : !emailOk ? 'your email address' : 'your mobile number';
      return res.status(403).json({ code: 'VERIFICATION_REQUIRED', emailVerified: emailOk, phoneVerified: phoneOk, email: u.email,
        pendingToken: app.locals.phoneOtp.issuePendingToken(u.user_id),
        error: 'Please verify ' + missing + ' before signing in.' });
    }
  }
  await lock.clear(u.user_id);                       // right password: the failed-attempt count starts again from 0
  // Second factor on EVERY sign-in: the password alone never starts a session. The person now chooses to get a one-time code by
  // email or text message (login-otp.js). LOGIN_OTP=off skips this step (development / test harnesses only).
  if (app.locals.loginOtp.enabled()) {
    await audit(pool, { id: u.user_id, name: u.full_name, roleLabel: u.label }, 'Login', 'Password accepted; one-time code required');
    return res.status(403).json(app.locals.loginOtp.challengeFor(u));
  }
  res.json(await app.locals.completeLogin(res, u));
}));
app.post('/api/auth/logout', wrap(async (req, res) => {
  // record the log out in the audit log (the cookie is read here because this route is open to expired sessions too)
  try {
    const u = jwt.verify(req.cookies.session, process.env.JWT_SECRET);
    await audit(pool, u, 'Logout', 'Logged out');
    await sessions.revoke(u.sid, 'logout');                              // frees this device's place under the device limit
  } catch { /* no valid session - nothing to record */ }
  res.clearCookie('session'); res.json({ ok: true });
}));
app.get('/api/auth/me', auth(), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT full_name, email, phone FROM users WHERE user_id = $1', [req.user.id]);
  const u = rows[0] || {};
  res.json({ ...req.user, name: u.full_name || req.user.name, email: u.email || null, phone: u.phone || '' });
}));
/* ---------- my profile (any signed-in user edits only their own row) ---------- */
const PROFILE_SQL = `SELECT u.user_id, u.full_name, u.username, u.email, u.phone, r.label AS role_label, r.role_key,
       to_char(u.created_at AT TIME ZONE $2, 'Mon DD, YYYY') AS joined, (u.avatar IS NOT NULL) AS has_avatar,
       u.first_name, u.middle_name, u.last_name, u.suffix, to_char(u.birthdate, 'YYYY-MM-DD') AS birthdate, u.gender,
       u.company_name, u.company_position, u.company_tin, (u.email_verified_at IS NOT NULL) AS email_verified,
       (u.phone_verified_at IS NOT NULL) AS phone_verified,
       (SELECT v.new_email FROM email_verifications v WHERE v.user_id = u.user_id AND v.used_at IS NULL AND v.new_email IS NOT NULL
           AND v.expires_at > now() ORDER BY v.created_at DESC LIMIT 1) AS pending_email
  FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1`;
// accounts made before the name was split have only full_name: split it so My Profile can show the parts
function splitFullName(full) {
  const w = String(full || '').trim().split(/\s+/).filter(Boolean);
  let suffix = '';
  if (w.length > 2 && /^(jr\.?|sr\.?|ii|iii|iv|v)$/i.test(w[w.length - 1])) {
    const s = w.pop().replace(/\.$/, '').toLowerCase();
    suffix = { jr: 'Jr.', sr: 'Sr.', ii: 'II', iii: 'III', iv: 'IV', v: 'V' }[s];
  }
  return { first: w.length > 1 ? w.slice(0, -1).join(' ') : (w[0] || ''), last: w.length > 1 ? w[w.length - 1] : '', suffix };
}
const profileJson = (u) => {
  const guess = u.first_name == null ? splitFullName(u.full_name) : null;
  return {
    name: u.full_name, username: u.username, email: u.email, phone: u.phone || '',
    firstName: guess ? guess.first : u.first_name, middleName: u.middle_name || '', lastName: guess ? guess.last : (u.last_name || ''),
    suffix: guess ? guess.suffix : (u.suffix || ''), birthdate: u.birthdate || '', gender: u.gender || '',
    companyName: u.company_name || '', companyPosition: u.company_position || '', companyTin: u.company_tin || '',
    emailVerified: !!u.email_verified, pendingEmail: u.pending_email || '',
    phoneVerified: !app.locals.phoneOtp.needsPhone({ phone: u.phone, phone_verified_at: u.phone_verified ? 1 : null }),
    employeeId: 'TEM-' + String(u.user_id).padStart(4, '0'),
    department: u.role_key === 'finance' ? 'Finance' : u.role_label,
    roleLabel: u.role_label, role: u.role_key, joined: u.joined, hasAvatar: !!u.has_avatar
  };
};
app.get('/api/auth/profile', auth(), wrap(async (req, res) => {
  await app.locals.accountReady; await app.locals.phoneReady;
  const { rows } = await pool.query(PROFILE_SQL, [req.user.id, TZ]);
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  res.json(profileJson(rows[0]));
}));
app.put('/api/auth/profile', auth(), wrap(async (req, res) => {
  await app.locals.accountReady; await app.locals.phoneReady;
  const H = app.locals.accountHelpers;
  const b = req.body || {};
  const e = {};
  const isCustomer = req.user.role === 'customer';
  // Customers, cashiers and finance staff all sign up with first / middle / last name + suffix, so they all edit those parts.
  // Only an old page that still sends one `name` takes the legacy path (the parts are re-split so they never go stale).
  const structured = b.firstName !== undefined || b.lastName !== undefined || b.middleName !== undefined;
  let name, parts = null;
  if (structured) { parts = H.nameParts(e, b); name = parts.full; }
  else {
    name = text(e, 'name', b.name, 'Full name', { min: 2, max: 100 });
    if (name && !e.name && !/^[\p{L}][\p{L}\p{M}\s.'’-]*$/u.test(name)) e.name = 'Full name can only have letters, spaces, . \' and -';
  }
  const email = str(b.email).toLowerCase();
  if (!email) e.email = 'Email is required';
  else if (email.length > 254 || !EMAIL_FORMAT.test(email)) e.email = 'Enter a valid email address';
  const phone = H.mobileField(e, b.phone);        // everyone: a Philippine MOBILE number (the verification code is texted to it)

  const current = (await pool.query("SELECT email, phone, to_char(birthdate, 'YYYY-MM-DD') AS birthdate_s FROM users WHERE user_id = $1", [req.user.id])).rows[0];
  // birthdate + gender for everyone; company details are customer-only. A birthdate that is being changed must still be 18+, and an existing one cannot be wiped.
  let more = null;
  if (parts) {
    const birthChanged = str(b.birthdate) !== ((current && current.birthdate_s) || '');
    more = { ...H.optionalDetails(e, b, { adult: birthChanged }) };
    if (isCustomer) Object.assign(more, H.companyDetails(e, b));
  }
  if (Object.keys(e).length) throw new ValidationError(e);

  // the email domain must really exist and accept mail (only checked when the email is being changed,
  // so an existing address never blocks a name / phone edit). Done before the transaction: it is a network lookup.
  const emailChanged = !!current && current.email !== email;
  if (emailChanged) await assertPersonalEmail(email);
  // a NEW email (any role) only replaces the old one after the link sent to it is opened
  const needsConfirm = emailChanged && EMAIL_VERIFICATION_ON;
  // compare numbers in one canonical form, so an old-format number (09171234567) re-saved as +63 917 123 4567 is NOT treated as a new number
  const canon = (p) => { if (!p) return ''; const m = phMobile(p); return m.value || String(p).replace(/\s+/g, ''); };
  let phoneChanged = false;

  const result = await tx(async (client) => {
    const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND user_id <> $2', [email, req.user.id]);
    if (taken.rowCount) throw new ValidationError({ email: 'That email is already used by another account' });
    const before = (await client.query("SELECT *, to_char(birthdate, 'YYYY-MM-DD') AS birthdate_s FROM users WHERE user_id = $1 FOR UPDATE", [req.user.id])).rows[0];
    if (!before) throw new ValidationError({ name: 'Account not found' });
    phoneChanged = canon(before.phone) !== canon(phone);
    const sets = ['full_name = $1', 'phone = $2'], vals = [name, phone || null];
    const add = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
    if (!needsConfirm) add('email', email);
    if (PHONE_VERIFICATION_ON && phoneChanged) sets.push('phone_verified_at = NULL');   // a new number is confirmed with a text code at the next sign-in
    if (parts) { add('first_name', parts.first); add('middle_name', parts.middle || null); add('last_name', parts.last); add('suffix', parts.suffix || null); }
    else { const g = splitFullName(name); add('first_name', g.first); add('last_name', g.last || null); add('suffix', g.suffix || null); }
    if (more) {
      add('birthdate', more.birthdate); add('gender', more.gender);
      if (isCustomer) { add('company_name', more.companyName); add('company_position', more.companyPosition); add('company_tin', more.companyTin); }
    }
    vals.push(req.user.id);
    await client.query('UPDATE users SET ' + sets.join(', ') + ' WHERE user_id = $' + vals.length, vals);
    const changed = [];
    if (before.full_name !== name) changed.push('name');
    if (emailChanged) changed.push(needsConfirm ? 'email (awaiting verification)' : 'email');
    if (phoneChanged) changed.push(PHONE_VERIFICATION_ON ? 'phone (awaiting verification)' : 'phone');
    if (more && ((before.birthdate_s || '') !== (more.birthdate || '') || (before.gender || null) !== more.gender)) changed.push('personal details');
    if (isCustomer && more && ((before.company_name || null) !== more.companyName || (before.company_position || null) !== more.companyPosition || (before.company_tin || null) !== more.companyTin)) changed.push('company details');
    if (changed.length) await audit(client, { ...req.user, name }, 'Profile updated', 'Changed ' + changed.join(', '));
    return (await client.query(PROFILE_SQL, [req.user.id, TZ])).rows[0];
  });
  const notes = [];
  if (needsConfirm) {
    const sent = await app.locals.startEmailVerification(req, { userId: req.user.id, name: (parts && parts.first) || name, to: email, change: true });
    notes.push(sent.sent ? 'We sent a confirmation link to ' + email + '. Your email changes once you click it.'
      : 'Your other details were saved, but the confirmation email could not be sent (' + sent.reason + '). Try again later.');
  }
  if (PHONE_VERIFICATION_ON && phoneChanged && phone) notes.push('Your new mobile number will be confirmed with a text code the next time you sign in.');
  const message = notes.join(' ');
  // the session cookie carries the display name, so refresh it
  const user = { id: req.user.id, name: result.full_name, role: req.user.role, roleLabel: req.user.roleLabel };
  startSession(res, user, req.user.tv, req.user.sid);   // same session: a profile edit must not log any device out
  res.json({ ...profileJson(result), message });
}));
// change password: any signed-in user.
//  1) the current password must be TYPED and be right (the system never fills it in),
//  2) the new password must pass the same rules as sign-up,
//  3) then a one-time code sent to the user's email OR mobile number (their choice) must be entered (password-otp.js; PASSWORD_OTP=off skips it).
app.put('/api/auth/password', auth(), wrap(async (req, res) => {
  const b = req.body || {};
  const cur = typeof b.currentPassword === 'string' ? b.currentPassword : '';
  const next = typeof b.newPassword === 'string' ? b.newPassword : '';
  const otp = app.locals.passwordOtp;
  if (!cur) throw new ValidationError({ currentPassword: 'Enter your current password' });
  await otp.verifyCurrent(req.user.id, cur);                       // wrong current password: nothing else is checked or changed
  const me = (await pool.query('SELECT email, first_name, last_name FROM users WHERE user_id = $1', [req.user.id])).rows[0] || {};
  let problem = '';
  if (next.length > 200) problem = 'New password is too long';
  else if (app.locals.passwordProblem) problem = app.locals.passwordProblem(next, { email: me.email, names: [me.first_name, me.last_name] });
  else if (next.length < 8 || !/[A-Za-z]/.test(next) || !/\d/.test(next) || !/[^A-Za-z0-9]/.test(next)) problem = 'New password needs at least 8 characters with a letter, a number and a symbol';
  if (!problem && next === cur) problem = 'New password must be different from the current one';
  if (problem) throw new ValidationError({ newPassword: problem });
  if (next !== b.confirmPassword && b.confirmPassword !== undefined) throw new ValidationError({ confirmPassword: 'Passwords do not match' });
  const needCode = otp.enabledForChange();
  // the person picks ONE way to get the code (their email or their mobile number); it must be a way this account really has
  const channels = needCode ? await otp.requiredChannels(req.user.id) : [];
  const channel = typeof b.channel === 'string' ? b.channel : '';
  if (needCode && !channels.length) throw new ValidationError({ code: 'No verified email or mobile number is on this account, so a code cannot be sent. Ask the Finance/Admin team for help.' });
  if (needCode && !channels.includes(channel)) throw new ValidationError({ code: 'Choose email or text message, then enter the code sent to it.' });
  const hash = await bcrypt.hash(next, 12);
  const newTv = await tx(async (client) => {
    if (needCode) await otp.consume(client, req.user.id, 'change-' + channel, b.code);   // the code is used up only when it is right
    await client.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, req.user.id]);
    const tv = await revocation.bump(client, req.user.id);                               // every OTHER device is signed out (OWASP A07 session management)
    await audit(client, req.user, 'Profile updated', needCode ? 'Changed password (confirmed with a one-time code sent to the email or the mobile number)' : 'Changed password');
    return tv;
  });
  await sessions.revokeOthers(pool, req.user.id, req.user.sid, 'password');   // the other devices' places are freed too
  forgetAccountCheck(req.user.id);
  startSession(res, req.user, newTv, req.user.sid);      // this device stays signed in with the new session number
  res.json({ ok: true });
}));
// profile photo: JPG / PNG up to 2 MB, kept in the users table (avatar BYTEA)
const looksLikeJpeg = (b) => b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
const looksLikePng = (b) => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
app.get('/api/auth/avatar', auth(), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT avatar, avatar_type FROM users WHERE user_id = $1', [req.user.id]);
  if (!rows[0] || !rows[0].avatar) return res.status(404).json({ error: 'No photo' });
  res.set({ 'Content-Type': rows[0].avatar_type || 'image/jpeg', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(rows[0].avatar);
}));
app.put('/api/auth/avatar', auth(), express.raw({ type: ['image/jpeg', 'image/png'], limit: '2mb' }), wrap(async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new ValidationError({ photo: 'Choose a JPG or PNG image' });
  const type = looksLikeJpeg(buf) ? 'image/jpeg' : looksLikePng(buf) ? 'image/png' : null;
  if (!type) throw new ValidationError({ photo: 'That file is not a real JPG or PNG image' });
  await tx(async (client) => {
    await client.query('UPDATE users SET avatar = $1, avatar_type = $2 WHERE user_id = $3', [buf, type, req.user.id]);
    await audit(client, req.user, 'Profile updated', 'Changed profile photo');
  });
  res.json({ ok: true });
}));
app.delete('/api/auth/avatar', auth(), wrap(async (req, res) => {
  await tx(async (client) => {
    await client.query('UPDATE users SET avatar = NULL, avatar_type = NULL WHERE user_id = $1', [req.user.id]);
    await audit(client, req.user, 'Profile updated', 'Removed profile photo');
  });
  res.json({ ok: true });
}));
// live "is this email free?" check for the profile form
app.get('/api/auth/check-email', auth(), wrap(async (req, res) => {
  const email = str(req.query.email).toLowerCase();
  const r = await pool.query('SELECT 1 FROM users WHERE email = $1 AND user_id <> $2', [email, req.user.id]);
  const dom = await checkEmailDomain(email);          // MX lookup, no API key (same check the supplier form uses)
  res.json({ taken: r.rowCount > 0, domainOk: !!dom.ok, unverified: !!dom.unverified, message: dom.ok ? '' : dom.message });
}));
app.get('/api/reasons', auth('finance'), (req, res) => res.json({ ...REASONS, depts: REASON_DEPTS }));
app.get('/api/units', auth(), (req, res) => res.json(UNITS));
// Categories for the product form dropdown (from the database)
app.get('/api/categories', auth('finance'), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM categories ORDER BY name');
  res.json(rows.map(r => r.name));
}));

/* ---------- products / inventory ---------- */
const reorder = require('./reorder')({ pool });   // automatic reorder level (average daily use x lead + safety days)
app.get('/api/reorder-settings', auth('finance'), (req, res) => res.json(reorder.settings));
const productSelect = `
  SELECT v.*, COALESCE((
      SELECT json_agg(json_build_object('code', s.code, 'name', s.name, 'primary', ps.is_primary, 'status', s.status)
                      ORDER BY ps.is_primary DESC, s.name)
        FROM product_suppliers ps JOIN suppliers s USING (supplier_id)
       WHERE ps.product_id = v.product_id), '[]'::json) AS suppliers
    FROM v_inventory v WHERE NOT v.is_archived ORDER BY v.department, v.name`;
// reorder_auto / reorder_basis live on products (the view does not have them), so the list adds them here
const productSelectFull = productSelect.replace('SELECT v.*, COALESCE((', 'SELECT v.*, p.weight_kg, p.reorder_auto, p.reorder_basis, p.price_auto, p.cost_mode, p.cost_note, p.cost_override_reason, COALESCE((')
  .replace('FROM v_inventory v WHERE', 'FROM v_inventory v JOIN products p ON p.product_id = v.product_id WHERE');

app.get('/api/inventory', auth('finance'), wrap(async (req, res) => {
  const { rows } = await pool.query(productSelect);
  res.json(rows.map(r => ({ name: r.name, sku: r.sku, department: r.department, onHand: +r.on_hand,
    reorderLevel: +r.reorder_level, unit: r.unit, unitCost: +r.unit_cost, location: r.location,
    suppliers: r.suppliers })));
}));

app.get('/api/products', auth('finance'), wrap(async (req, res) => {
  await reorder.ready;
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3) CHECK (weight_kg IS NULL OR weight_kg >= 0)').catch(() => {});   // delivery-calc.js adds it too; this just makes the order of start-up irrelevant
  if (app.locals.pricing) await app.locals.pricing.ready;   // price_auto column + trigger
  if (app.locals.recipeCosting) await app.locals.recipeCosting.ready;   // cost_mode / cost_note columns
  const archivedOnly = String(req.query.archived || '') === '1';
  const { rows } = await pool.query(archivedOnly ? productSelectFull.replace('WHERE NOT v.is_archived', 'WHERE v.is_archived') : productSelectFull);
  const why = {};
  if (archivedOnly) { await softDeleteReady; (await pool.query('SELECT sku, delete_reason, deleted_at FROM products WHERE is_archived')).rows.forEach(w => { why[w.sku] = w; }); }
  res.json(rows.map(r => ({ archived: !!r.is_archived, deleteReason: why[r.sku] ? why[r.sku].delete_reason || undefined : undefined, deletedAt: why[r.sku] && why[r.sku].deleted_at ? +new Date(why[r.sku].deleted_at) : undefined, sku: r.sku, name: r.name, department: r.department, category: r.category || 'Uncategorized',
    grade: r.grade || '', form: r.form || '', unit: r.unit, costUnit: r.unit, status: r.stock_status, available: +r.on_hand,
    reorderLevel: +r.reorder_level, reorderAuto: !!r.reorder_auto, reorderBasis: r.reorder_basis || '',
    weightKg: r.weight_kg == null ? null : +r.weight_kg, stdCost: +r.unit_cost, listPrice: +r.selling_price, priceAuto: r.department === 'Finished Goods' ? r.price_auto !== false : undefined, location: r.location,
    margin: r.selling_price > 0 ? +(((r.selling_price - r.unit_cost) / r.selling_price) * 100).toFixed(1) : 0,
    costMode: r.department === 'Finished Goods' ? (r.cost_mode || 'auto') : undefined, costNote: r.cost_note || undefined, costOverrideReason: r.cost_override_reason || undefined,
    primarySource: r.primary_source || (r.suppliers.length ? r.suppliers[0].name : null),
    suppliers: r.suppliers })));
}));

// Finance-only material/supplier linking. Product and Supplier pages remain separate.
// Links are maintained transactionally and never applied to manufactured Finished Goods.
app.put('/api/products/:sku/suppliers', auth('finance'), wrap(async (req, res) => {
  const codes = req.body && req.body.supplierCodes;
  const preferred = req.body && req.body.preferredSupplierCode;
  if (!Array.isArray(codes) || codes.length > 100 || codes.some(c => typeof c !== 'string' || !c.trim()))
    throw new ValidationError({ supplierCodes: 'Provide a list of supplier codes (maximum 100)' });
  const unique = [...new Set(codes.map(c => c.trim()))];
  if (preferred && !unique.includes(preferred))
    throw new ValidationError({ preferredSupplierCode: 'Preferred supplier must be in the selected list' });
  const result = await tx(async client => {
    const product = await client.query('SELECT product_id, department FROM products WHERE sku=$1 AND NOT is_archived FOR UPDATE', [req.params.sku]);
    if (!product.rowCount) return null;
    if (!NEEDS_SUPPLIER.includes(product.rows[0].department))
      throw new ValidationError({ supplierCodes: 'Finished Goods are manufactured internally and cannot have material suppliers' });
    const suppliers = await client.query(`SELECT supplier_id, code FROM suppliers WHERE code = ANY($1) AND status = 'active'`, [unique]);
    if (suppliers.rowCount !== unique.length)
      throw new ValidationError({ supplierCodes: 'One or more suppliers are missing or inactive' });
    const pid = product.rows[0].product_id;
    await client.query('DELETE FROM product_suppliers WHERE product_id=$1', [pid]);
    for (const row of suppliers.rows) {
      await client.query('INSERT INTO product_suppliers(product_id,supplier_id,is_primary) VALUES($1,$2,$3)',
        [pid, row.supplier_id, row.code === (preferred || unique[0])]);
    }
    await audit(client, req.user, 'Supplier links updated', `Material ${req.params.sku}: ${unique.join(', ') || 'unassigned'}`);
    return { supplierCodes: unique, preferredSupplierCode: preferred || unique[0] || null };
  });
  if (!result) return res.status(404).json({ error: 'Material not found' });
  res.json({ ok: true, ...result });
}));

async function categoryId(client, name) {
  name = String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  // reuse an existing category whatever its upper/lower case ("Sheet" and "sheet" are one category)
  const found = await client.query(`SELECT category_id FROM categories WHERE lower(btrim(name)) = lower($1) ORDER BY category_id LIMIT 1`, [name]);
  if (found.rowCount) return found.rows[0].category_id;
  const c = await client.query(
    `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING category_id`, [name]);
  return c.rows[0].category_id;
}
// A product name can only be used once among active products (ignores upper/lower case and extra spaces).
// `sku` = the product being edited, so it does not clash with itself.
async function assertProductNameFree(client, name, sku) {
  const { rows } = await client.query(
    `SELECT sku, name FROM products
      WHERE lower(btrim(name)) = lower($1) AND NOT is_archived AND sku <> $2 LIMIT 1`, [name, sku || '']);
  if (rows.length) throw new ValidationError({ name: `A product named "${rows[0].name}" already exists (SKU ${rows[0].sku})` });
}
app.post('/api/products', auth('finance'), wrap(async (req, res) => {
  const p = validateProduct(req.body || {}, { creating: true });
  await reorder.ready;
  if (app.locals.pricing) await app.locals.pricing.ready;   // price_auto column + trigger
  // Raw Materials and Finishing Supplies are bought, so a new one must name its supplier. Finished Goods are made in-house: no supplier.
  const supplierCode = str((req.body || {}).supplierCode);
  if (NEEDS_SUPPLIER.includes(p.department) && !supplierCode) throw new ValidationError({ supplier: 'Choose the supplier for this material' });
  await tx(async (client) => {
    await assertProductNameFree(client, p.name, null);
    let supplier = null;
    if (NEEDS_SUPPLIER.includes(p.department)) {
      supplier = (await client.query(`SELECT supplier_id, name FROM suppliers WHERE code = $1 AND status = 'active'`, [supplierCode])).rows[0];
      if (!supplier) throw new ValidationError({ supplier: 'That supplier is missing or archived. Choose another' });
    }
    const ins = await client.query(
      `INSERT INTO products (sku,name,department,category_id,unit,unit_cost,selling_price,reorder_level,reorder_auto,location,price_auto,weight_kg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING product_id`,
      [p.sku, p.name, p.department, await categoryId(client, p.category), p.unit, p.unitCost == null ? 0 : p.unitCost, p.listPrice || 0, p.reorderLevel == null ? 0 : p.reorderLevel, p.reorderAuto === true, p.location, p.priceAuto !== false, p.weightKg == null ? null : p.weightKg]);
    const id = ins.rows[0].product_id;
    if (supplier) await client.query('INSERT INTO product_suppliers (product_id, supplier_id, is_primary) VALUES ($1,$2,TRUE)', [id, supplier.supplier_id]);
    // the stock a new product starts with is its own ledger entry ("Opening balance"), valued at the cost it was entered with
    if (p.onHand > 0) await client.query(
      `INSERT INTO stock_movements (product_id,movement_type,reason,quantity,handled_by,note,unit_cost)
       VALUES ($1,'in','opening_balance',$2,$3,'Opening balance',$4)`, [id, p.onHand, req.user.id, p.unitCost == null ? 0 : p.unitCost]);
    await reorder.recalc(client, p.sku);   // no-op unless automatic; writes the "needs usage history" note for a new product
    await audit(client, req.user, 'Record added', `Product ${p.sku} — ${p.name}` + (supplier ? ` — supplier ${supplier.name}` : ''));
  });
  res.status(201).json({ ok: true });
}));

app.put('/api/products/:sku', auth('finance'), wrap(async (req, res) => {
  const p = validateProduct({ ...req.body, sku: req.params.sku }, { creating: false });
  await reorder.ready;
  if (app.locals.pricing) await app.locals.pricing.ready;   // price_auto column + trigger
  const found = await tx(async (client) => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(req.user.id)]);
    await assertProductNameFree(client, p.name, p.sku);
    const rc = app.locals.recipeCosting && (await app.locals.recipeCosting.ready) ? app.locals.recipeCosting : null;
    const before = (await client.query('SELECT p.product_id, p.unit_cost, p.department, c.name AS category FROM products p LEFT JOIN categories c ON c.category_id = p.category_id WHERE p.sku = $1 AND NOT p.is_archived FOR UPDATE OF p', [p.sku])).rows[0];
    // an old raw material that already sits in another category may keep it; any change must land on aluminum or brass
    if (p.department === 'Raw Materials' && !isRawMaterialCategory(p.category) && !(before && before.department === 'Raw Materials' && String(before.category || '').toLowerCase() === p.category.toLowerCase()))
      throw new ValidationError({ category: 'Raw materials are ' + RAW_MATERIAL_CATEGORIES.join(' or ') + ' (we only work in aluminum and brass)' });
    // a finished good with a recipe does not take a typed cost (it is "auto"); Finance can override it, with a reason that is logged
    let guard = null;
    if (rc && before && p.department === 'Finished Goods' && before.department === 'Finished Goods') {
      guard = await rc.guardProductCost(client, p, req.body || {}, req.user);
      p.unitCost = guard.unitCost;
    }
    if (p.unitCost == null) p.unitCost = before ? +before.unit_cost : 0;
    const r = await client.query(
      `UPDATE products SET name=$2, department=$3, category_id=$4, unit=$5, unit_cost=$6,
              selling_price=COALESCE($7, selling_price), reorder_level=COALESCE($8, reorder_level), location=$9,
              reorder_auto=COALESCE($10::boolean, reorder_auto),
              reorder_basis=CASE WHEN $10::boolean IS FALSE THEN NULL ELSE reorder_basis END,
              price_auto=COALESCE($11::boolean, price_auto),
              weight_kg=CASE WHEN $12::boolean THEN $13::numeric ELSE weight_kg END
        WHERE sku=$1 AND NOT is_archived RETURNING product_id`,
      [p.sku, p.name, p.department, await categoryId(client, p.category), p.unit, p.unitCost, p.listPrice, p.reorderLevel, p.location, p.reorderAuto, p.priceAuto, p.weightKg !== undefined, p.weightKg === undefined ? null : p.weightKg]);
    if (!r.rowCount) return false;
    await reorder.recalc(client, p.sku);   // if it is (now) automatic, work the level out straight away
    await audit(client, req.user, 'Record edited', `Product ${p.sku}`);
    // cost ripple: a material whose cost was changed by hand moves every finished good that uses it
    if (rc && before && ['Raw Materials', 'Finishing Supplies'].includes(p.department) && Math.abs(+before.unit_cost - p.unitCost) >= 0.005)
      await rc.ripple(client, before.product_id, { user: req.user, name: p.name, oldCost: +before.unit_cost, newCost: p.unitCost });
    if (guard && guard.recalc) await rc.recalcOne(client, before.product_id, { user: req.user, why: 'override removed' });
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Product not found' });
  res.json({ ok: true });
}));

// Products and suppliers are never removed: "delete" hides them (soft delete) and keeps who/when/why for the Deleted tab.
const softDeleteReady = (async () => {
  for (const t of ['products', 'suppliers']) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS delete_reason TEXT`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  }
})().catch(e => console.error('[soft delete] schema setup failed:', e.message));
function deleteReason(body) {
  const reason = str(body && body.reason);
  if (reason.length < 5) throw new ValidationError({ reason: 'Give a reason for deleting this (at least 5 characters).' });
  if (reason.length > 300) throw new ValidationError({ reason: 'Keep the reason within 300 characters.' });
  return reason;
}

app.delete('/api/products/:sku', auth('finance'), wrap(async (req, res) => {
  await softDeleteReady;
  const reason = deleteReason(req.body);
  const r = await pool.query('UPDATE products SET is_archived = TRUE, delete_reason = $2, deleted_at = now() WHERE sku = $1 AND NOT is_archived', [str(req.params.sku).toUpperCase(), reason]);
  if (!r.rowCount) return res.status(404).json({ error: 'Product not found' });
  await audit(pool, req.user, 'Record edited', `Deleted product ${req.params.sku}: ${reason}`);
  res.json({ ok: true });
}));

app.post('/api/products/:sku/restore', auth('finance'), wrap(async (req, res) => {
  const sku = str(req.params.sku).toUpperCase();
  const p = await pool.query('SELECT name FROM products WHERE sku = $1 AND is_archived', [sku]);
  if (!p.rowCount) return res.status(404).json({ error: 'Archived product not found' });
  // an active product may already use this name (names are unique among active products)
  const dup = await pool.query(`SELECT sku FROM products WHERE lower(btrim(name)) = lower(btrim($1)) AND NOT is_archived AND sku <> $2 LIMIT 1`, [p.rows[0].name, sku]);
  if (dup.rowCount) return res.status(409).json({ error: `Cannot restore: an active product named "${p.rows[0].name}" already exists (SKU ${dup.rows[0].sku}). Rename that one first.` });
  await softDeleteReady;
  await pool.query('UPDATE products SET is_archived = FALSE, delete_reason = NULL, deleted_at = NULL WHERE sku = $1', [sku]);
  await audit(pool, req.user, 'Record edited', `Restored product ${sku}`);
  res.json({ ok: true });
}));

/* ---------- suppliers ---------- */
app.get('/api/validate-email', auth('finance'), wrap(async (req, res) => {
  res.json(await checkEmailDomain(req.query.email));
}));


/* ---------- address lists + ZIP check (used by the supplier form, the shop checkout and the cashier's walk-in delivery quotes) ---------- */
const geoRoute = (fn) => wrap(async (req, res) => {
  try { res.json(await fn(req)); }
  catch (err) {
    if (err.geo) return res.status(503).json({ error: 'The address list could not be loaded (' + (lastGeoError || 'no connection') + '). Check the internet connection of the computer running the backend.' });
    throw err;
  }
});
app.get('/api/geo/regions', auth('finance', 'customer', 'cashier'), geoRoute(() => getRegions()));
app.get('/api/geo/regions/:code/provinces', auth('finance', 'customer', 'cashier'), geoRoute((req) => getProvinces(req.params.code)));
app.get('/api/geo/regions/:code/cities', auth('finance', 'customer', 'cashier'), geoRoute((req) => getCitiesOfRegion(req.params.code)));
app.get('/api/geo/cities/:code/barangays', auth('finance', 'customer', 'cashier'), geoRoute((req) => getBarangaysOfCity(req.params.code)));
app.get('/api/geo/provinces/:code/cities', auth('finance', 'customer', 'cashier'), geoRoute((req) => getCitiesOfProvince(req.params.code)));
// ZIP codes that belong to a city / municipality (used to pre-fill the ZIP box in the shop checkout)
app.get('/api/geo/zip-suggest', auth('finance', 'customer', 'cashier'), wrap(async (req, res) => {
  const city = str(req.query.city), province = str(req.query.province), barangay = str(req.query.barangay);
  if (!city) return res.json({ zips: [] });
  let rows = null;
  try { rows = await loadZipRows(); } catch { rows = null; }
  if (!rows) return res.json({ zips: [] });
  const isNcr = /metro manila|national capital|^ncr$/.test(norm(province));
  const inProv = (x) => !province || sameName(x.admin2, province) || sameName(x.admin1, province) || sameName(x.admin3, province)
    || (isNcr && /metro manila|national capital|capital district|manila/i.test([x.admin1, x.admin2].join(' ')));
  const exact = rows.filter((x) => inProv(x) && (sameName(x.place, city) || sameName(x.admin3, city)));
  const byBgy = barangay ? exact.filter((x) => sameName(x.place, barangay)) : [];
  const pick = byBgy.length ? byBgy : exact;
  res.json({ zips: [...new Set(pick.map((x) => x.zip))].sort().slice(0, 12) });
}));
app.get('/api/geo/status', auth('finance'), wrap(async (req, res) => {
  const out = { psgcBase: PSGC_BASE, node: process.version };
  try { out.regions = (await psgc('/regions')).length; out.psgc = 'ok'; } catch (err) { out.psgc = 'FAILED'; out.reason = lastGeoError || err.message; }
  const z = await loadZipRows().catch(() => null);
  out.zipList = z ? z.length + ' rows' : 'not loaded';
  res.json(out);
}));
app.get('/api/geo/check-zip', auth('finance', 'customer', 'cashier'), wrap(async (req, res) => {
  const zip = str(req.query.zip), city = str(req.query.city), province = str(req.query.province), region = str(req.query.region), barangay = str(req.query.barangay);
  if (region === OUTSIDE_PH || process.env.ADDRESS_CHECK === 'off') return res.json({ ok: true });
  if (!/^\d{4}$/.test(zip)) return res.json({ ok: false, message: 'ZIP code must be 4 digits, e.g. 1000' });
  if (!city || !province) return res.json({ ok: false, unknown: true, message: 'Choose the province and city first' });
  res.json(await checkZipMatch({ zip, city, province, barangay }));
}));

/* ---------- form helpers (Task 9): next SKU, last delivery, ZIP -> address, known customers ---------- */
require('./form-assist')({ app, pool, auth, wrap, str, loadZipRows, REGIONS, TZ });

const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');

app.get('/api/suppliers', auth('finance'), wrap(async (req, res) => {
  await softDeleteReady;
  const { rows } = await pool.query(`
    SELECT s.*, COALESCE((
        SELECT json_agg(json_build_object('sku', p.sku, 'name', p.name, 'primary', ps.is_primary) ORDER BY p.name)
          FROM product_suppliers ps JOIN products p USING (product_id)
         WHERE ps.supplier_id = s.supplier_id AND NOT p.is_archived), '[]'::json) AS products
      FROM suppliers s ORDER BY s.name`);
  res.json(rows.map(s => ({ id: s.code, name: s.name, initials: initials(s.name), status: s.status,
    deleteReason: s.status === 'archived' ? s.delete_reason || undefined : undefined, deletedAt: s.status === 'archived' && s.deleted_at ? +new Date(s.deleted_at) : undefined,
    ...supplierFields(s),
    supplies: s.products.length ? s.products.map(p => p.name).join(', ') : (s.supplies || ''),
    products: s.products })));
}));

// Make the supplier's product list exactly `skus` (adds/removes links, keeps one primary per product)
async function setSupplierProducts(client, supplierId, skus) {
  const found = await client.query(`SELECT product_id, sku, name, department FROM products WHERE sku = ANY($1) AND NOT is_archived`, [skus]);
  if (found.rowCount !== skus.length) {
    const ok = found.rows.map(r => r.sku);
    throw new ValidationError({ products: `Unknown product: ${skus.filter(s => !ok.includes(s)).join(', ')}` });
  }
  const ids = found.rows.map(r => r.product_id);
  await client.query(`DELETE FROM product_suppliers WHERE supplier_id = $1 AND NOT (product_id = ANY($2))`, [supplierId, ids]);
  // suppliers only supply Raw Materials / Finishing Supplies (links that already exist are left alone)
  const had = (await client.query('SELECT product_id FROM product_suppliers WHERE supplier_id = $1', [supplierId])).rows.map(r => r.product_id);
  const wrong = found.rows.filter(r => !had.includes(r.product_id) && !NEEDS_SUPPLIER.includes(r.department));
  if (wrong.length)
    throw new ValidationError({ products: `${wrong.map(r => r.name).join(', ')}: only Raw Materials and Finishing Supplies can be supplied` });
  for (const id of ids)
    await client.query(`INSERT INTO product_suppliers (product_id, supplier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, supplierId]);
  // every product that has suppliers must have exactly one primary
  await client.query(`
    UPDATE product_suppliers ps SET is_primary = TRUE
     WHERE (ps.product_id, ps.supplier_id) IN (
       SELECT DISTINCT ON (product_id) product_id, supplier_id FROM product_suppliers
        WHERE product_id IN (SELECT product_id FROM product_suppliers GROUP BY product_id HAVING NOT bool_or(is_primary))
        ORDER BY product_id, supplier_id)`);
}

// Supplier name, email and phone must be unique across suppliers (active or archived).
// `was` = the supplier's stored values when editing: an old value left unchanged is not re-checked.
const phoneKey = (p) => String(p || '').replace(/[\s().-]/g, '').replace(/^\+63/, '0');   // +63 917… and 0917… are the same number
async function assertSupplierUnique(s, code, was) {
  const e = {};
  const same = await pool.query(
    `SELECT name, status FROM suppliers WHERE (lower(btrim(name)) = lower($1) OR code = $3) AND code <> $2 LIMIT 1`,
    [s.name, code || '', s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')]);
  if (same.rowCount && !(was && was.name && was.name.toLowerCase() === s.name.toLowerCase()))
    e.name = `A supplier named "${same.rows[0].name}" already exists${same.rows[0].status === 'archived' ? ' (archived)' : ''}`;
  if (s.email && !(was && was.email && was.email.toLowerCase() === s.email)) {
    const r = await pool.query(`SELECT name FROM suppliers WHERE lower(email) = $1 AND code <> $2 LIMIT 1`, [s.email, code || '']);
    if (r.rowCount) e.email = `This email is already used by ${r.rows[0].name}`;
  }
  if (s.phone && !(was && phoneKey(was.phone) === phoneKey(s.phone))) {
    const r = await pool.query(
      `SELECT name FROM suppliers
        WHERE regexp_replace(regexp_replace(coalesce(phone,''), '[\\s().-]', '', 'g'), '^\\+63', '0') = $1 AND code <> $2 LIMIT 1`,
      [phoneKey(s.phone), code || '']);
    if (r.rowCount) e.phone = `This phone number is already used by ${r.rows[0].name}`;
  }
  if (Object.keys(e).length) throw new ValidationError(e);
}
app.post('/api/suppliers', auth('finance'), wrap(async (req, res) => {
  const s = validateSupplier(req.body || {}, null, true);
  await assertSupplierUnique(s, null, null);
  await assertAddress(s, null);
  await assertEmailDomain(s.email);
  const code = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await tx(async (client) => {
    const ins = await client.query(
      `INSERT INTO suppliers (code,name,location,contact,contact_person,phone,email,address_line,city,province,region,zip_code,barangay,lead_time_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING supplier_id`,
      [code, s.name, s.location, s.contact, s.contactPerson, s.phone, s.email, s.address, s.city, s.province, s.region, s.zip, s.barangay || null,
       s.leadTimeDays == null ? reorder.settings.leadDays : s.leadTimeDays]);
    if (s.productSkus && s.productSkus.length) await setSupplierProducts(client, ins.rows[0].supplier_id, s.productSkus);
    await audit(client, req.user, 'Record added', `Supplier ${s.name}`);
  });
  res.status(201).json({ id: code });
}));

app.put('/api/suppliers/:code', auth('finance'), wrap(async (req, res) => {
  // an old phone / email that is left as it was is kept (older records may not follow the new rules)
  const cur = await pool.query('SELECT * FROM suppliers WHERE code = $1', [req.params.code]);
  if (!cur.rowCount) return res.status(404).json({ error: 'Supplier not found' });
  const was = supplierFields(cur.rows[0]);
  const s = validateSupplier(req.body || {}, { phone: was.phone, email: was.email.toLowerCase() });
  await assertSupplierUnique(s, req.params.code, { name: cur.rows[0].name, email: was.email, phone: was.phone });
  await assertAddress(s, was);
  if (s.email && s.email !== was.email.toLowerCase()) await assertEmailDomain(s.email);
  const found = await tx(async (client) => {
    const r = await client.query(
      `UPDATE suppliers SET name=$2, location=$3, contact=$4, contact_person=$6, phone=$7, email=$8, address_line=$9,
              city=$10, province=$11, region=$12, zip_code=$13, barangay=$14, status=COALESCE($5, status),
              lead_time_days=COALESCE($15::int, lead_time_days)
        WHERE code=$1 RETURNING supplier_id`,
      [req.params.code, s.name, s.location, s.contact, s.status || null, s.contactPerson, s.phone, s.email, s.address, s.city, s.province, s.region, s.zip, s.barangay || null, s.leadTimeDays]);
    if (!r.rowCount) return false;
    // a new lead time changes the automatic reorder level of the products this supplier mainly supplies
    if (s.leadTimeDays != null) {
      const skus = await client.query(`SELECT p.sku FROM product_suppliers ps JOIN products p USING (product_id) WHERE ps.supplier_id = $1 AND ps.is_primary AND p.reorder_auto`, [r.rows[0].supplier_id]);
      for (const row of skus.rows) await reorder.recalc(client, row.sku);
    }
    if (s.productSkus) await setSupplierProducts(client, r.rows[0].supplier_id, s.productSkus);
    await audit(client, req.user, 'Record edited', `Supplier ${req.params.code}${s.status ? ' to ' + s.status : ''}`);
    return true;
  });
  if (!found) return res.status(404).json({ error: 'Supplier not found' });
  res.json({ ok: true });
}));

app.patch('/api/suppliers/:code/status', auth('finance'), wrap(async (req, res) => {
  const status = str(req.body && req.body.status);
  if (!['active', 'archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await softDeleteReady;
  const reason = status === 'archived' ? deleteReason(req.body) : null;
  const r = await pool.query('UPDATE suppliers SET status = $2::text, delete_reason = $3::text, deleted_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END WHERE code = $1', [req.params.code, status, reason]);
  if (!r.rowCount) return res.status(404).json({ error: 'Supplier not found' });
  await audit(pool, req.user, 'Record edited', status === 'archived' ? `Deleted supplier ${req.params.code}: ${reason}` : `Restored supplier ${req.params.code}`);
  res.json({ ok: true });
}));

/* ---------- stock movements ---------- */
let productionApi = null;      // set by production.js below
app.get('/api/movements', auth('finance'), wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 5000);
  const { rows } = await pool.query(
    `SELECT m.ref, m.reason, p.name AS product, m.movement_type, m.quantity, p.unit, p.department, m.source_type, m.source_id,
            COALESCE(u.full_name, '—') AS handled_by, s.name AS supplier, m.invoice_no, m.note, COALESCE(m.unit_cost, p.unit_cost) AS unit_cost,
            to_char(m.created_at AT TIME ZONE $2, 'Mon DD, HH12:MI AM') AS dt,
            to_char(m.created_at AT TIME ZONE $2, 'YYYY-MM-DD') AS d
       FROM stock_movements m JOIN products p USING (product_id) LEFT JOIN users u ON u.user_id = m.handled_by
       LEFT JOIN suppliers s ON s.supplier_id = m.supplier_id
      ORDER BY m.created_at DESC, m.movement_id DESC LIMIT $1`, [limit, TZ]);
  // movements made by a confirmed production carry the production reference and the finished product they belong to
  const prodInfo = productionApi
    ? await productionApi.infoFor([...new Set(rows.filter(r => r.source_type === 'production').map(r => String(r.source_id)))])
    : new Map();
  res.json(rows.map(r => {
    const pr = r.source_type === 'production' ? prodInfo.get(String(r.source_id)) : null;
    return { ref: r.ref, product: r.product, type: r.movement_type, qty: +r.quantity,
      reason: REASONS.in[r.reason] || REASONS.out[r.reason] || LEGACY_REASON_LABELS[r.reason] || r.reason,
      unit: r.unit, department: r.department, handledBy: r.handled_by, dateTime: r.dt, date: r.d, unitCost: r.unit_cost != null ? +r.unit_cost : null,
      supplier: r.supplier || undefined, invoiceNo: r.invoice_no || undefined, note: r.note || undefined,
      productionRef: pr ? pr.ref : undefined, relatedProduct: pr ? pr.product : undefined };
  }));
}));

app.post('/api/movements', auth('finance'), wrap(async (req, res) => {
  const m = validateMovement(req.body || {});
  if (m.type === 'in' && m.reason === 'produced_batch')
    throw new ValidationError({ reason: 'Use "Produced Internally" so the materials used are deducted automatically' });
  const result = await tx(async (client) => {
    const p = await client.query('SELECT product_id, name, department, on_hand, unit, unit_cost FROM products WHERE sku = $1 AND NOT is_archived FOR UPDATE', [m.sku]);
    if (!p.rowCount) throw new ValidationError({ sku: 'That product does not exist' });
    const prod = p.rows[0];
    const allowedDepts = REASON_DEPTS[m.type][m.reason];
    if (m.type === 'in' && m.reason === 'supplier_receipt' && prod.department === 'Finished Goods')
      throw new ValidationError({ reason: `${prod.name} is a finished good. Finished goods are produced in-house, so record it with "Produced Internally" (or "Returned by customer"), not as a supplier delivery` });
    if (!allowedDepts.includes(prod.department))
      throw new ValidationError({ sku: `"${REASONS[m.type][m.reason]}" applies to ${allowedDepts.join(' / ')} products — ${prod.name} is ${prod.department}` });
    if (m.type === 'out' && +prod.on_hand < m.quantity)
      throw new ValidationError({ quantity: `Only ${+prod.on_hand} ${prod.unit} on hand — cannot take out ${m.quantity}` });
    let supplierId = null, supplierName = null;
    if (m.supplier) {
      const sp = await client.query(`SELECT supplier_id, name, status FROM suppliers WHERE code = $1`, [m.supplier]);
      if (!sp.rowCount) throw new ValidationError({ supplier: 'That supplier does not exist' });
      if (sp.rows[0].status !== 'active') throw new ValidationError({ supplier: `${sp.rows[0].name} is archived — restore it first or choose another supplier` });
      if (m.type === 'in' && m.reason === 'supplier_receipt') {
        const link = await client.query('SELECT 1 FROM product_suppliers WHERE product_id=$1 AND supplier_id=$2', [prod.product_id, sp.rows[0].supplier_id]);
        if (!link.rowCount) throw new ValidationError({ supplier: 'This supplier is not linked to the selected material. Assign it in Product or Supplier Management before recording delivery.' });
      }
      supplierId = sp.rows[0].supplier_id; supplierName = sp.rows[0].name;
    }
    // Moving-average cost: a delivery bought at a different price moves the product's cost by its share of the stock.
    // new cost = (stock on hand x current cost + quantity received x price paid) / (stock on hand + quantity received)
    // Every movement keeps the cost it moved at, so stock value and profit history do not change when the cost does later.
    const oldCost = +prod.unit_cost || 0, onHand = Math.max(0, +prod.on_hand);
    let newCost = oldCost;
    if (m.unitCost != null) newCost = Math.round(((onHand * oldCost + m.quantity * m.unitCost) / (onHand + m.quantity)) * 100) / 100;
    const ins = await client.query(
      `INSERT INTO stock_movements (product_id,movement_type,reason,quantity,handled_by,note,supplier_id,invoice_no,unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ref`,
      [prod.product_id, m.type, m.reason, m.quantity, req.user.id, m.note, supplierId, m.invoiceNo, m.unitCost != null ? m.unitCost : oldCost]);
    if (newCost !== oldCost) await client.query('UPDATE products SET unit_cost = $2 WHERE product_id = $1', [prod.product_id, newCost]);
    // General replenishment must not approve a quote's purchase before its payment gate.
    // Quote-linked suggestions are received through the Finance purchase-suggestion route.
    if (m.type === 'in' && m.reason === 'supplier_receipt') {
      await client.query(
        `UPDATE purchase_suggestions
            SET status = 'received',
                note = COALESCE(NULLIF(note, ''), 'Received via delivery') || ' (Ref: ' || $2 || ')'
          WHERE product_id = $1 AND quote_id IS NULL AND status IN ('open', 'ordered')`,
        [prod.product_id, ins.rows[0].ref]
      ).catch((e) => console.warn('[movements] suggestion update error:', e.message));
    }
    await audit(client, req.user, 'Record added',
      `Stock ${m.type === 'in' ? 'In' : 'Out'} — ${ins.rows[0].ref}, ${prod.name}, ${m.type === 'in' ? '+' : '-'}${m.quantity} ${prod.unit} (${REASONS[m.type][m.reason]})` +
      (supplierName ? `, from ${supplierName}` : '') + (m.invoiceNo ? `, invoice ${m.invoiceNo}` : '') +
      (m.unitCost != null ? `, at ₱${m.unitCost.toFixed(2)} each — average cost ₱${oldCost.toFixed(2)} → ₱${newCost.toFixed(2)}` : ''));
    // cost ripple: every finished good that uses this material is recalculated, repriced, and its open quotes flagged (same transaction)
    let ripple = null;
    const rc = app.locals.recipeCosting;
    if (newCost !== oldCost && ['Raw Materials', 'Finishing Supplies'].includes(prod.department) && rc && (await rc.ready))
      ripple = await rc.ripple(client, prod.product_id, { user: req.user, name: prod.name, oldCost, newCost });
    return { ref: ins.rows[0].ref, unitCost: newCost, previousCost: oldCost, ripple };
  });
  res.status(201).json({ ref: result.ref, unitCost: result.unitCost, previousCost: result.previousCost, ripple: result.ripple && result.ripple.affected ? result.ripple : undefined });
}));

/* ---------- stock count (physical inventory) ---------- */
require('./stock-count')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });

/* ---------- in-app Notification Center (bell, history, role-based events) ---------- */
app.locals.notifications = require('./notifications')({ app, pool, auth, wrap, TZ });

reorder.start();   // recalculate automatic reorder levels now and every 6 hours

/* ---------- production (material requirements, produced-internally Stock In, production history) ---------- */
productionApi = require('./production')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });
app.locals.production = productionApi;

/* ---------- inventory automation: three-department tracking, delivery schedules, periodic production ---------- */
const inventoryAutomation = require('./inventory-automation')({ pool, tx, audit, ValidationError, str, TZ });
app.locals.inventoryAutomation = inventoryAutomation;

// Department summary / automated tracking across Raw Materials, Finishing Supplies, Finished Goods
app.get('/api/inventory/automation/tracking', auth('finance'), wrap(async (req, res) => {
  res.json(await inventoryAutomation.getDepartmentSummary());
}));

// Delivery schedules for Raw Materials and Finishing Supplies
app.get('/api/inventory/automation/delivery-schedules', auth('finance'), wrap(async (req, res) => {
  res.json(await inventoryAutomation.listDeliverySchedules());
}));

// Receive an individual delivery schedule immediately
app.post('/api/inventory/automation/delivery-schedules/:id/receive', auth('finance'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json(await inventoryAutomation.receiveDeliverySchedule(id, req.user));
}));

// Process due delivery schedules to automatically update stock levels for incoming Raw Materials & Finishing Supplies
app.post('/api/inventory/automation/delivery-schedules/process-due', auth('finance'), wrap(async (req, res) => {
  const asOf = req.body && req.body.asOfDate;
  res.json(await inventoryAutomation.processDueDeliveries(asOf, req.user));
}));

// Everything on the schedule stocks in by itself on its date: deliveries first, then production (also run by the automation timer below)
app.post('/api/inventory/automation/run-due', auth('finance'), wrap(async (req, res) => {
  res.json(await inventoryAutomation.runDueAutomation());
}));
(app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'inventory-schedule', run: async () => {
  const r = await inventoryAutomation.runDueAutomation();
  return { received: r.deliveries.processedCount, produced: r.production.producedCount, waitingForMaterials: r.production.waiting.length };
} });

// Periodic production plans for Finished Goods
app.get('/api/inventory/automation/production-plans', auth('finance'), wrap(async (req, res) => {
  res.json(await inventoryAutomation.listProductionPlans());
}));

// Calculate material consumption and sufficiency for a finished good / production plan
app.post('/api/inventory/automation/production-plans/calculate', auth('finance'), wrap(async (req, res) => {
  const b = req.body || {};
  let targetProduct = b.sku || b.productId;
  if (b.planId) {
    const pl = await pool.query('SELECT finished_product_id FROM periodic_production_plans WHERE plan_id = $1', [b.planId]);
    if (pl.rowCount) targetProduct = pl.rows[0].finished_product_id;
  }
  if (!targetProduct) return res.status(400).json({ error: 'Must provide planId, sku, or productId' });
  const vol = Number(b.volume);
  if (!vol || vol <= 0) return res.status(400).json({ error: 'Volume must be greater than zero' });
  res.json(await inventoryAutomation.calculatePlanMaterials(targetProduct, vol));
}));

// Execute periodic production run: simultaneously deducts Raw Materials & Finishing Supplies and adds Finished Goods
app.post('/api/inventory/automation/production-plans/:id/execute', auth('finance'), wrap(async (req, res) => {
  const planId = parseInt(req.params.id, 10);
  res.json(await inventoryAutomation.executeProductionRun(planId, req.body, req.user));
}));

app.post('/api/inventory/automation/production-run', auth('finance'), wrap(async (req, res) => {
  res.json(await inventoryAutomation.executeProductionRun(null, req.body, req.user));
}));

/* Customer directory belongs to the cashier, not Finance. Never expose other staff accounts. */
app.get('/api/pos/customer-directory', auth('cashier'), wrap(async (req, res) => {
  await userLifecycle.ready();
  // the directory also says when they joined and how much they have done in the shop, so the cashier can tell regulars apart
  const { rows } = await pool.query(`SELECT u.user_id AS id, u.full_name AS name, u.email, u.phone, u.status, u.username,
    to_char(u.last_login AT TIME ZONE $1, 'Mon DD, YYYY HH12:MI AM') AS "lastLogin",
    to_char(u.created_at AT TIME ZONE $1, 'Mon DD, YYYY') AS joined, (EXTRACT(EPOCH FROM u.created_at) * 1000)::bigint AS "joinedAt",
    (SELECT count(*)::int FROM orders o WHERE o.customer_id = u.user_id) AS orders,
    (SELECT count(*)::int FROM product_reviews pr WHERE pr.user_id = u.user_id) AS reviews
    FROM users u JOIN roles r ON r.role_id=u.role_id WHERE r.role_key='customer' AND u.deleted_at IS NULL ORDER BY u.full_name`, [TZ]);
  res.json(rows);
}));
app.get('/api/pos/customers/:id/profile', auth('cashier'), wrap(async (req,res) => {
  await userLifecycle.ready();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({error:'Invalid customer ID'});
  // Same details Finance sees, minus the company TIN. Never any password hash, token or consent record.
  const {rows}=await pool.query(`SELECT u.user_id,u.full_name AS name,u.email,u.phone,u.status,u.username,
    u.first_name,u.middle_name,u.last_name,u.suffix,to_char(u.birthdate,'YYYY-MM-DD') AS birthdate,
    u.gender,u.company_name,u.company_position,(u.email_verified_at IS NOT NULL) AS email_verified,
    to_char(u.created_at AT TIME ZONE $2,'Mon DD, YYYY') AS joined,
    to_char(u.last_login AT TIME ZONE $2,'Mon DD, YYYY HH12:MI AM') AS last_login
    FROM users u JOIN roles r ON r.role_id=u.role_id WHERE u.user_id=$1 AND r.role_key='customer' AND u.deleted_at IS NULL`,[req.params.id,TZ]);
  if(!rows.length)return res.status(404).json({error:'Customer not found'});
  const u=rows[0], guess=u.first_name==null?splitFullName(u.name):null;
  res.json({ id:u.user_id, name:u.name, username:u.username, email:u.email, phone:u.phone||'', status:u.status,
    firstName:guess?guess.first:u.first_name, middleName:u.middle_name||'', lastName:guess?guess.last:u.last_name,
    suffix:guess?guess.suffix:u.suffix, birthdate:u.birthdate||'', gender:u.gender||'',
    companyName:u.company_name||'', companyPosition:u.company_position||'', emailVerified:!!u.email_verified,
    joined:u.joined||'', lastLogin:u.last_login||'Never' });
}));
/* ---------- users & audit (finance only) ---------- */
app.get('/api/users', auth('finance'), wrap(async (req, res) => {
  await userLifecycle.ready();
  const deleted = req.query.deleted === '1';
  const { rows } = await pool.query(
    `SELECT u.user_id, u.full_name, u.username, u.email, r.label, r.role_key, u.status, u.deleted_at,
            to_char(u.last_login AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS last_login,
            EXTRACT(EPOCH FROM u.last_login)::bigint AS last_login_epoch,
            (u.avatar IS NOT NULL) AS has_avatar
       FROM users u JOIN roles r USING (role_id)
      WHERE (u.deleted_at IS NOT NULL) = $2
      ORDER BY u.last_login DESC NULLS LAST, u.full_name`, [TZ, deleted]);   // most recent sign-in first; accounts that never signed in go last
  res.json(rows.map(u => ({ id: u.user_id, name: u.full_name, username: u.username, email: u.email, role: u.label,
    roleKey: u.role_key, status: u.status, deletedAt: u.deleted_at, lastLogin: u.last_login || 'Never',
    lastLoginAt: u.last_login_epoch == null ? null : Number(u.last_login_epoch), hasAvatar: !!u.has_avatar,
    isYou: u.user_id === req.user.id })));   // the page hides Disable on your own row
}));

// Read-only registered customer details for Finance/Admin Customer Management.
// Never expose password hashes, verification tokens, or private consent records.
app.get('/api/customers/:id/profile', auth('finance'), wrap(async (req, res) => {
  await userLifecycle.ready();
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Customer not found' });
  const { rows } = await pool.query(`SELECT u.user_id, u.full_name, u.username, u.email, u.phone, u.status,
      u.first_name, u.middle_name, u.last_name, u.suffix,
      to_char(u.birthdate, 'YYYY-MM-DD') AS birthdate, u.gender,
      u.company_name, u.company_position, u.company_tin,
      (u.email_verified_at IS NOT NULL) AS email_verified,
      to_char(u.created_at AT TIME ZONE $2, 'Mon DD, YYYY') AS joined,
      to_char(u.last_login AT TIME ZONE $2, 'Mon DD, YYYY HH12:MI AM') AS last_login
    FROM users u JOIN roles r ON r.role_id = u.role_id
    WHERE u.user_id = $1 AND r.role_key = 'customer' AND u.deleted_at IS NULL`, [id, TZ]);
  if (!rows.length) return res.status(404).json({ error: 'Customer not found' });
  const u = rows[0]; const guess = u.first_name == null ? splitFullName(u.full_name) : null;
  res.json({ id: u.user_id, name: u.full_name, username: u.username, email: u.email,
    phone: u.phone || '', status: u.status, firstName: guess ? guess.first : u.first_name,
    middleName: u.middle_name || '', lastName: guess ? guess.last : u.last_name,
    suffix: guess ? guess.suffix : u.suffix, birthdate: u.birthdate || '', gender: u.gender || '',
    companyName: u.company_name || '', companyPosition: u.company_position || '',
    companyTin: u.company_tin || '', emailVerified: !!u.email_verified,
    joined: u.joined || '', lastLogin: u.last_login || 'Never' });
}));

// Full profile of ANY account for the Edit window in User Management / Customer Management (finance only; never the password hash).
app.get('/api/users/:id/profile', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Account not found' });
  const { rows } = await pool.query(`SELECT u.user_id, u.full_name, u.email, u.phone, u.status, r.role_key,
      u.first_name, u.middle_name, u.last_name, u.suffix, to_char(u.birthdate, 'YYYY-MM-DD') AS birthdate, u.gender,
      u.company_name, u.company_position, u.company_tin
    FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Account not found' });
  const u = rows[0], guess = u.first_name == null ? splitFullName(u.full_name) : null;
  res.json({ id: u.user_id, name: u.full_name, email: u.email, phone: u.phone || '', status: u.status, roleKey: u.role_key,
    firstName: guess ? guess.first : u.first_name, middleName: u.middle_name || '', lastName: guess ? guess.last : (u.last_name || ''),
    suffix: guess ? guess.suffix : (u.suffix || ''), birthdate: u.birthdate || '', gender: u.gender || '',
    companyName: u.company_name || '', companyPosition: u.company_position || '', companyTin: u.company_tin || '' });
}));

// profile photo of any account, for the User Management list (finance only). Same photo the person uploaded in My Profile.
app.get('/api/users/:id/avatar', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'No photo' });
  const { rows } = await pool.query('SELECT avatar, avatar_type FROM users WHERE user_id = $1', [id]);
  if (!rows[0] || !rows[0].avatar) return res.status(404).json({ error: 'No photo' });
  res.set({ 'Content-Type': rows[0].avatar_type === 'image/png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.send(rows[0].avatar);          // Express adds an ETag, so the browser only re-downloads a photo that changed
}));

// Change an account's ROLE (Finance only). Finance does NOT edit anyone's personal information: name, email, mobile number,
// birthdate, gender and company details belong to the account owner, who changes them in My Profile (with its own checks,
// e.g. a new mobile number is confirmed by text). A request that tries to send any of those is refused, so nothing can slip through.
// Rules: a customer stays a customer, staff can only be Finance-Admin or Cashier, nobody changes their own role, and at least one
// active Finance-Admin must remain.
const PROFILE_FIELDS = ['name', 'firstName', 'middleName', 'lastName', 'suffix', 'email', 'phone', 'birthdate', 'gender', 'companyName', 'companyPosition', 'companyTin'];
app.patch('/api/users/:id', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id), b = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid request' });
  const sent = PROFILE_FIELDS.filter((k) => b[k] !== undefined);
  if (sent.length) throw new ValidationError({ role: 'Finance can only change the role. Personal details are changed by the account owner in My Profile' });
  const out = await tx(async (client) => {
    await userLifecycle.lock(client, req.user);
    const t = (await client.query(`SELECT u.user_id, u.full_name, u.email, u.status, u.deleted_at, r.role_key, r.label FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1 FOR UPDATE`, [id])).rows[0];
    if (!t) throw new ValidationError({ id: 'Account not found' });
    if (t.deleted_at) throw new ValidationError({ id: 'Restore this deleted account before changing its role' });
    const roleKey = str(b.roleKey);
    if (!['finance', 'cashier', 'customer'].includes(roleKey)) throw new ValidationError({ role: 'Choose a valid role' });
    if (roleKey === t.role_key) return { t, roleKey, changed: false };
    if (t.role_key === 'customer') throw new ValidationError({ role: 'A customer account cannot be changed to Finance-Admin or Cashier' });
    if (roleKey === 'customer') throw new ValidationError({ role: 'A staff account cannot be changed to Customer' });
    if (id === req.user.id) throw new ValidationError({ role: 'You cannot change your own role. Ask another Finance-Admin' });
    if (t.role_key === 'finance') {
      const left = (await client.query(`SELECT count(*)::int AS n FROM users u JOIN roles r USING (role_id)
                                         WHERE r.role_key = 'finance' AND u.status = 'active' AND u.user_id <> $1`, [id])).rows[0].n;
      if (left < 1) throw new ValidationError({ role: 'At least one active Finance-Admin must remain' });
    }
    await client.query(`UPDATE users SET role_id = (SELECT role_id FROM roles WHERE role_key = $2) WHERE user_id = $1`, [id, roleKey]);
    await audit(client, req.user, 'Record edited', `Role changed — ${t.full_name}: ${t.label} to ${roleKey === 'finance' ? 'Finance-Admin Officer' : 'Sales Staff / Cashier'}`);
    return { t, roleKey, changed: true };
  });
  res.json({ ok: true, name: out.t.full_name, email: out.t.email, roleKey: out.roleKey, changed: out.changed });
}));

// Soft deletion preserves staff attribution, customer history and all related records.
app.delete('/api/users/:id', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request' });
  res.json(await userLifecycle.change(id, req.user));
}));
app.post('/api/users/:id/restore', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request' });
  res.json(await userLifecycle.change(id, req.user, true));
}));

// Finance can disable / re-enable any account, including another Finance-Admin (e.g. one who left the company). Two rules:
//   - never your own account (another Finance-Admin has to do it), so nobody locks themselves out by mistake;
//   - at least one active Finance-Admin must remain, or nobody could manage the system any more.
// Finance lifecycle decisions share a transaction lock, so concurrent changes cannot remove every administrator.
// The disabled person is signed out on their next request (see accountStillValid above).
app.patch('/api/users/:id/status', auth('finance'), wrap(async (req, res) => {
  const id = Number(req.params.id);
  const status = str(req.body && req.body.status);
  if (!Number.isInteger(id) || !['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid request' });
  if (id === req.user.id && status === 'disabled') return res.status(403).json({ error: 'You cannot disable your own account. Ask another Finance-Admin to do it.' });
  const out = await tx(async (c) => {
    await userLifecycle.lock(c, req.user);
    const t = (await c.query('SELECT u.full_name, u.status, u.deleted_at, r.role_key, r.label FROM users u JOIN roles r USING (role_id) WHERE u.user_id = $1 FOR UPDATE OF u', [id])).rows[0];
    if (!t) return { code: 404, error: 'Account not found' };
    if (t.deleted_at) return { code: 409, error: 'Restore this deleted account before changing its status' };
    if (t.status === status) return { ok: true, t };
    if (t.role_key === 'finance' && status === 'disabled') {
      const left = (await c.query(`SELECT u.user_id FROM users u JOIN roles r USING (role_id) WHERE r.role_key = 'finance' AND u.status = 'active' FOR UPDATE OF u`)).rows
        .filter((x) => x.user_id !== id).length;
      if (!left) return { code: 409, error: 'This is the only active Finance-Admin. Invite or enable another Finance-Admin first.' };
    }
    await c.query('UPDATE users SET status = $2 WHERE user_id = $1', [id, status]);
    await audit(c, req.user, 'Record edited', `${t.label} account ${status === 'disabled' ? 'disabled' : 're-enabled'} — ${t.full_name}`);
    return { ok: true, t };
  });
  if (!out.ok) return res.status(out.code).json({ error: out.error });
  app.locals.forgetAccountCheck(id);
  res.json({ ok: true, status });
}));

app.get('/api/audit', auth('finance'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT to_char(occurred_at AT TIME ZONE $1, 'YYYY-MM-DD HH12:MI AM') AS ts, user_name, role_label, action, detail
       FROM audit_log ORDER BY occurred_at DESC, audit_id DESC LIMIT 500`, [TZ]);
  res.json(rows.map(a => ({ timestamp: a.ts, user: a.user_name || 'System', role: a.role_label, action: a.action, detail: a.detail })));
}));

/* ---------- sign-up: customers sign up directly; staff get an emailed invite link (Mailgun) ---------- */
require('./auth-signup')({ app, pool, auth, wrap, tx, audit, ValidationError, str, text, EMAIL_FORMAT, phoneError, phMobile, assertEmailDomain: assertPersonalEmail, emailVerificationOn: EMAIL_VERIFICATION_ON, phoneVerificationOn: PHONE_VERIFICATION_ON, TZ });
require('./phone-otp')({ app, pool, wrap, tx, audit, str, phoneVerificationOn: PHONE_VERIFICATION_ON, emailVerificationOn: EMAIL_VERIFICATION_ON });
// one-time codes for FORGOT password (email or text, the person chooses) and CHANGE password (password-otp.js)
require('./password-otp')({ app, pool, auth, wrap, tx, audit, ValidationError, str, EMAIL_RE });
/* ---------- POS + online shop (finished goods only) ---------- */
// payment-terms owns the ledger, so it mounts first: pos-shop / shop-extras / quote-desk reach it through app.locals.paymentTerms
require('./payment-terms')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });
// due date + reminders for partly paid orders (needs the ledger columns payment-terms just created)
app.locals.balanceReminders = require('./balance-reminders')({ app, pool, auth, wrap });
require('./pos-shop')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ, validateShipTo, formatShipTo });
require('./shop-product-content')({ app, pool, auth, wrap });
require('./shop-extras')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
// a custom quoted item is made with a job order: its raw materials and finishing supplies are issued (stock out) before it is ready
require('./job-orders')({ app, pool, auth, wrap, tx, audit, ValidationError, str, TZ });
// automatic prices: finished goods = unit cost + markup (20%), custom quotes from a formula (pricing.js)
app.locals.pricing = require('./pricing')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
// recipe costing: a finished good's cost = its recipe x the materials' current cost; ripples to prices and open quotes (recipe-costing.js)
app.locals.recipeCosting = require('./recipe-costing')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
// custom quotes: quick recipe, priced with the recipe formula; quote approval routing, decision log, reminders (quote-automation.js)
require('./quote-automation')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
// guided quote form: suggested price / ready date / valid-until date, with the reasons (quote-form-guide.js)
require('./quote-form-guide')({ app, pool, auth, wrap, ValidationError, str });
require('./quote-desk')({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo });

/* ---------- automation: follow-ups that run by themselves ----------
   Each module adds its jobs to app.locals.automationJobs (unpaid online orders: reminder + auto-cancel; quotes about to
   expire: reminder). They run every AUTOMATION_MINUTES (default 15) while the server is up. Cloud Run can sleep when
   nobody uses the app, so a Cloud Scheduler job should also call
       POST /api/automation/run    header  x-cron-key: <AUTOMATION_CRON_KEY>
   Every job is safe to run twice and on several servers at once (rows are locked / marked before anything is sent). */
{
  let running = false;
  async function runAutomation() {
    if (running) return { skipped: 'already running' };
    running = true;
    const out = {};
    try {
      for (const job of app.locals.automationJobs || []) {
        try { out[job.name] = await job.run(); }
        catch (err) { out[job.name] = { error: err.message }; console.warn('[auto] ' + job.name + ' failed:', err.message); }
      }
    } finally { running = false; }
    return out;
  }
  const cron = async (req, res) => {
    const key = process.env.AUTOMATION_CRON_KEY || process.env.LOW_STOCK_CRON_KEY;
    if (!key || !security.safeEqual(req.get('x-cron-key'), key)) return res.status(404).json({ error: 'Not found' });
    res.json(await runAutomation());
  };
  app.get('/api/automation/run', cron);
  app.post('/api/automation/run', cron);
  const every = Math.max(5, Number(process.env.AUTOMATION_MINUTES) || 15) * 60000;
  setInterval(runAutomation, every).unref();
  setTimeout(runAutomation, 45000).unref();      // after the schemas are ready
  app.locals.runAutomation = runAutomation;
}

// Data minimisation (RA 10173): expired one-time codes and tokens are deleted every 6 hours by security_purge_expired() (db/025).
// Until that migration is applied the function does not exist; that is not an error.
{
  const purge = () => pool.query('SELECT security_purge_expired() AS r')
    .then((x) => { const n = Object.values((x.rows[0] && x.rows[0].r) || {}).reduce((a, b) => a + Number(b || 0), 0); if (n) console.log('[security] purged ' + n + ' expired code/token rows'); })
    .catch((e) => { if (e.code !== '42883') console.warn('[security] purge failed:', e.message); });
  setInterval(purge, 6 * 3600 * 1000).unref();
  setTimeout(purge, 5 * 60 * 1000).unref();
}

require('./cash-shifts')({ app, pool, auth, wrap, tx, audit, TZ });
// Finance Reports API: sales overview, top products, low stock, inventory (reports.js + reports-core.js)
require('./reports')({ app, pool, auth, wrap, TZ });

/* ---------- static front-end (dev convenience) ---------- */
const dir = path.resolve(__dirname, process.env.FRONTEND_DIR || '../Finance_Inventory');
/* ---------- page gate: private pages are only sent to a signed-in user ----------
   The landing, login and help pages stay public. Everything else needs the session cookie, otherwise the visitor is
   sent to the login page (the data routes under /api were already protected; this stops the page itself from opening). */
const PRIVATE_PAGES = {
  'shop_customer.html': ['customer'],            // online shop: customers only
  'pos_cashier.html': null,                      // null = any signed-in role (the page itself still checks its own role)
  'finance_inventory.html': null,
  'finance_cash_shifts.html': null
};
const PAGE_HOME = { finance: '/Finance_Inventory.html', cashier: '/POS_Cashier.html', customer: '/Shop_Customer.html' };
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let name;
  try { name = decodeURIComponent(req.path).split('/').pop().toLowerCase(); } catch (e) { return res.redirect('/Login_Inventory.html'); }
  if (!Object.prototype.hasOwnProperty.call(PRIVATE_PAGES, name)) return next();
  res.set('Cache-Control', 'no-store');          // so the Back button after logging out cannot show the page again
  let user;
  try { user = jwt.verify(req.cookies.session, process.env.JWT_SECRET); } catch (e) { return res.redirect('/Login_Inventory.html'); }
  const roles = PRIVATE_PAGES[name];
  if (roles && !roles.includes(user.role)) return res.redirect(PAGE_HOME[user.role] || '/Login_Inventory.html');
  next();
});

/* Stamp the per-request CSP nonce (set by security.js) onto every inline <script> tag so the browser will run it
   under the nonce-based Content-Security-Policy, instead of serving the HTML file as-is via express.static.
   External <script src="..."> tags are left untouched — the nonce only applies to inline script content. (OWASP
   A05:2021 — Security Misconfiguration / XSS hardening: removes 'unsafe-inline' from script-src.) */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!req.path.toLowerCase().endsWith('.html')) return next();
  let rel;
  try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (e) { return next(); }
  const file = path.join(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) return next();   // path traversal guard
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) return next();                       // let express.static produce the normal 404
    const nonce = res.locals.cspNonce;
    const stamped = nonce ? html.replace(/<script(\s[^>]*)?>/gi, (full, attrs) => {
      attrs = attrs || '';
      if (/\bsrc\s*=/i.test(attrs)) return full;   // external script: no inline content, no nonce needed
      return '<script nonce="' + nonce + '"' + attrs + '>';
    }) : html;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(stamped);
  });
});
app.use(express.static(dir));

app.get('/', (req, res) => {
  res.redirect('/LandingPage_Inventory-1.html');
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large (the limit is 2 MB for photos)' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// adds any supplier columns the database does not have yet (safe to run every time)
async function ensureSupplierColumns() {
  try {
    for (const col of ['contact_person', 'phone', 'email', 'address_line', 'barangay', 'city', 'province', 'region', 'zip_code'])
      await pool.query(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS ${col} TEXT`);
    await pool.query('ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INT CHECK (lead_time_days BETWEEN 0 AND 365)');
  } catch (err) { console.warn('[db] could not check the suppliers columns:', err.message); }
}
ensureSupplierColumns();
// adds the profile columns the users table needs (safe to run every time)
async function ensureUserColumns() {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar BYTEA');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_type TEXT');
  }
  catch (err) { console.warn('[db] could not check the users columns:', err.message); }
}
ensureUserColumns();
// Stock In details (supplier / invoice no.). The ledger already has supplier_id; add the other two.
// Also lets the ledger accept every reason the form offers (older databases limited it to a short list).
async function ensureMovementColumns() {
  try {
    await pool.query('ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS supplier_id INT REFERENCES suppliers(supplier_id)');
    await pool.query('ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2) CHECK (unit_cost >= 0)');
    await pool.query('ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS invoice_no TEXT');
    await pool.query(`DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c'
                  AND pg_get_constraintdef(oid) ILIKE '%reason%' AND pg_get_constraintdef(oid) NOT ILIKE '%produced_batch%'
      LOOP EXECUTE format('ALTER TABLE stock_movements DROP CONSTRAINT %I', c.conname); END LOOP; END $$`);
  } catch (err) { console.warn('[db] could not check the stock movement columns:', err.message); }
}
ensureMovementColumns();
// Older finished goods may still carry kg / sheet / length... Nothing is rewritten here (changing a unit changes what the price means), but say so
// in the log so Finance can open each one in Products > Finished Goods and switch it to pcs. Until then a quote for it follows the unit it is saved with.
(async () => {
  try {
    const r = await pool.query(`SELECT sku, unit FROM products WHERE department = 'Finished Goods' AND NOT is_archived AND unit <> $1 ORDER BY sku`, [FINISHED_GOODS_UNIT]);
    if (r.rowCount) console.warn(`[products] ${r.rowCount} finished good(s) are not counted in ${FINISHED_GOODS_UNIT}: ` + r.rows.slice(0, 20).map((x) => `${x.sku} (${x.unit})`).join(', ') + (r.rowCount > 20 ? ', ...' : '') + '. Edit them and choose pcs.');
  } catch (err) { console.warn('[products] could not check the finished goods units:', err.message); }
})();
app.listen(process.env.PORT || 8080, () => {
  console.log('Triple E API on port ' + (process.env.PORT || 8080));
  console.log('[profile] My Profile routes are loaded (GET/PUT /api/auth/profile)');
  if (process.env.ADDRESS_CHECK !== 'off') {            // warm up the address lists and say clearly if they cannot be reached
    psgc('/regions').then((r) => console.log('[geo] PSGC address API reachable (' + r.length + ' regions)'))
      .catch((err) => console.warn('[geo] PSGC address API NOT reachable: ' + err.message + ' — the form will only show the built-in regions'));
    loadZipRows().then((z) => console.log(z ? '[geo] ZIP list ready (' + z.length + ' rows)' : '[geo] ZIP list not available yet'));
  }
});
