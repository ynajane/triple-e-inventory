/* desk-browser-harness.js — DEV ONLY. Not part of the deployed app and never started by server.js.

   It boots the REAL backend modules (backend/payment-terms.js, backend/quote-desk.js and the quotation half of
   backend/shop-extras.js) inside a real Express app, but answers their SQL from an in-memory double instead of
   PostgreSQL. That makes it possible to open Finance_Inventory/POS_Cashier.html in a browser and click through the
   quotation desk — list, detail drawer, clarification request, pricing, payment terms, walk-in form, conversion —
   with no database and without ever connecting to the production server.
   The payment half of that double is test/payment-double.js: it re-runs the db/020 trigger maths, so the balances
   the screens show come from the ledger rows exactly as they do in PostgreSQL.

   Run:  node backend/test/desk-browser-harness.js 8787
   Then: http://127.0.0.1:8787/POS_Cashier.html        (the fake session is already a cashier)

   Nothing here is a test assertion: quote-desk.test.js is the test. This file exists only to let a human look at the screen. */
const path = require('path');
const fs = require('fs');
const NM = path.join(__dirname, '..', 'node_modules');
const express = require(path.join(NM, 'express'));
const mountQuoteDesk = require(path.join(__dirname, '..', 'quote-desk.js'));
const mountShopExtras = require(path.join(__dirname, '..', 'shop-extras.js'));
const mountPaymentTerms = require(path.join(__dirname, '..', 'payment-terms.js'));
const paymentDouble = require('./payment-double');

const PORT = Number(process.argv[2] || 8787);
const ROOT = path.join(__dirname, '..', '..', 'Finance_Inventory');

/* ---------------- the in-memory catalogue + quotations ---------------- */
const PRODUCTS = [
  { sku: 'SSB-0010', name: 'Stainless Flat Bar', category: 'Bars & Rods', unit: 'kg', spec: '304 · 25 × 3 mm', price: 185.5, available: 1200 },
  { sku: 'RFR-0026', name: 'Rib-Type Roofing', category: 'Roofing', unit: 'linear m', spec: '0.4 mm · Pre-painted', price: 425, available: 260 },
  { sku: 'ANG-0203', name: 'Angle Bar', category: 'Angles & Channels', unit: 'pcs', spec: '2 × 2 in · 3 mm · 6 m', price: 710, available: 88 },
  { sku: 'FBT-0012', name: 'Hex Bolt & Nut Set', category: 'Fasteners', unit: 'box', spec: 'M12 × 50 · 50 pcs', price: 580, available: 8 },
  { sku: 'BF-ELB-034', name: 'Brass Forged Elbow 3/4"', category: 'Forged Brass Products', unit: 'pcs', spec: 'Brass · 3/4 in', price: 450, available: 380 }   // a real finished good: sold by the piece
];
const DB = { quotes: new Map(), attachments: [], clar: [], audit: [], orders: [], orderLines: [], sales: [], payments: [], terms: null, users: null, seq: { quote: 1000, attach: 0, clar: 0, order: 500, sale: 9000 } };
const USERS = { 3: { user_id: 3, full_name: 'Test Cashier' }, 4: { user_id: 4, full_name: 'Test Finance' }, 7: { user_id: 7, full_name: 'Ana Cruz' } };
DB.users = USERS;
// the payment ledger double: answers the statements payment-terms.js sends and re-runs the db/020 trigger maths
const paymentSql = paymentDouble(DB);

function seed(o) {
  DB.seq.quote += 1;
  const q = Object.assign({
    quote_id: DB.seq.quote, quote_no: 'QR-' + DB.seq.quote, customer_id: null, created_by: 3, handled_by: null,
    contact_name: 'Someone', phone: '09170000000', contact_email: null, company_name: null, flexible_date: false,
    product_sku: null, product_name: null, quantity: '10 pcs', details: '', specs: {}, needed_by: null, needed_months: null,
    fulfillment: 'Pickup', area: null, pay_method: null, status: 'new', quoted_amount: null, proposed_amount: null,
    approval_reason: null, reply_note: null, lead_time: null, valid_until: null, paid_amount: 0, payment_state: 'unpaid', payments: [], progress: [],
    terms_key: null, terms_percent: null, terms_amount: null, terms_balance: null, terms_condition: null, terms_availability: null,
    terms_state: 'none', terms_decided_by: null, terms_decided_at: null, terms_customer_seen_at: null,
    responded_at: null, response_note: null, received_by: null, clarification: null, source: 'pos',
    converted_order_id: null, converted_at: null, handover_sale_id: null, handover_at: null,
    created_at: new Date(), updated_at: new Date()
  }, o);
  DB.quotes.set(q.quote_no, q);
  return q;
}
seed({ contact_name: 'Ana Cruz', customer_id: 7, phone: '09171234567', product_sku: 'SSB-0010', product_name: 'Stainless Flat Bar 25×3', quantity: '200 kg',
  specs: { material: 'Stainless Steel 304', size: '25 × 3 mm', finish: 'Mill', thickness: '3 mm' }, details: 'Cut to 6 m lengths', needed_by: '2026-11-20',
  fulfillment: 'Pickup', status: 'new', source: 'shop' });
seed({ contact_name: 'Ben Dimaano', phone: '09181234567', product_sku: 'SSB-0010', product_name: 'Stainless Flat Bar 25×3', quantity: '60 kg',
  specs: { material: 'Stainless Steel 304', size: '25 × 3 mm' }, details: 'Walk-in at the counter', needed_by: '2026-11-10',
  status: 'awaiting_details', source: 'pos' });
seed({ contact_name: 'Cara Lim', customer_id: 8, phone: '09191234567', product_name: 'Custom stainless tray', quantity: '5 pcs',
  specs: { material: 'Stainless Steel 304', size: '600 × 400 mm' }, details: 'Rounded corners, no drainage holes', needed_by: '2026-12-05',
  status: 'new', source: 'shop' });
seed({ contact_name: 'Dan Reyes', customer_id: 9, phone: '09201234567', product_sku: 'RFR-0026', product_name: 'Rib-Type Roofing 0.4 mm',
  quantity: '260 linear m', specs: { material: 'GI', thickness: '0.4 mm', finish: 'Pre-painted' }, needed_by: '2026-11-15',
  fulfillment: 'Delivery', area: 'Brgy. San Isidro, Cabanatuan, Nueva Ecija', status: 'pending_approval', proposed_amount: 108000,
  approval_reason: 'Roofing at 0.4 mm below the usual 0.45 mm order size', source: 'shop' });
// This fixture is an actionable quote in quote-chain.test.js; its validity must move with the test date.
seed({ contact_name: 'Eva Son', customer_id: 10, phone: '09211234567', product_sku: 'ANG-0203', product_name: 'Angle Bar 2×2',
  quantity: '20 pcs', specs: { material: 'Carbon steel', size: '2 × 2 in', thickness: '3 mm' }, needed_by: '2026-11-05',
  status: 'quoted', quoted_amount: 14200, lead_time: '3-5 working days', valid_until: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), reply_note: 'Price includes cutting to 6 m.', source: 'shop' });
seed({ contact_name: 'Ferdinand Ope', customer_id: 11, phone: '09221234567', product_sku: 'SSB-0010', product_name: 'Stainless Flat Bar 25×3',
  quantity: '120 kg', specs: { material: 'Stainless Steel 304' }, needed_by: '2026-10-30', status: 'quoted', quoted_amount: 23400,
  lead_time: 'In stock', valid_until: '2026-10-22', source: 'pos' });
seed({ contact_name: 'Gina Tuazon', phone: '09231234567', product_sku: 'SSB-0010', product_name: 'Stainless Flat Bar 25×3', quantity: '40 kg',
  specs: { material: 'Stainless Steel 304' }, needed_by: '2026-10-28', status: 'accepted', quoted_amount: 7800, pay_method: 'Pay on pickup',
  lead_time: 'In stock', valid_until: '2026-10-25', responded_at: new Date(), source: 'pos' });
seed({ contact_name: 'Herry Bat', customer_id: 12, phone: '09241234567', product_sku: 'RFR-0026', product_name: 'Rib-Type Roofing 0.4 mm',
  quantity: '120 linear m', needed_by: '2026-10-20', status: 'accepted', quoted_amount: 51000, pay_method: 'Xendit',
  lead_time: '1-2 weeks', valid_until: '2026-10-18', responded_at: new Date(), fulfillment: 'Delivery',
  area: 'Brgy. Poblacion, Gapan, Nueva Ecija', source: 'shop' });
seed({ contact_name: 'Ivy Dimaak', customer_id: 13, phone: '09251234567', product_sku: 'FBT-0012', product_name: 'Hex Bolt & Nut Set M12',
  quantity: '10 box', needed_by: '2026-09-30', status: 'completed', quoted_amount: 5800, paid_amount: 5800, payment_state: 'paid', pay_method: 'Pay on pickup',
  lead_time: 'In stock', valid_until: '2026-09-20', responded_at: new Date('2026-09-12'), received_by: 'Ivy Dimaak', source: 'pos' });
seed({ contact_name: 'Jun Salak', phone: '09261234567', product_sku: 'ANG-0203', product_name: 'Angle Bar 2×2', quantity: '6 pcs',
  needed_by: '2026-09-15', status: 'declined', quoted_amount: 4300, valid_until: '2026-09-10', source: 'pos' });
seed({ contact_name: 'Lorna Vista', customer_id: 14, phone: '09271234567', product_sku: 'RFR-0026', product_name: 'Rib-Type Roofing 0.4 mm',
  quantity: '80 linear m', needed_by: '2026-08-20', status: 'expired', quoted_amount: 34000, valid_until: '2026-08-10', source: 'shop' });

/* ---------------- the SQL double ---------------- */
const rowsOf = (rows) => ({ rows, rowCount: rows.length });
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
const quoteById = (id) => [...DB.quotes.values()].find((q) => Number(q.quote_id) === Number(id));
const likeRe = (p) => new RegExp(String(p).replace(/[\\%]/g, (c) => (c === '\\' ? '' : '.*')).replace(/_/g, '.'), 'i');
const openClar = (id) => DB.clar.filter((c) => Number(c.quote_id) === Number(id) && c.status === 'awaiting_customer');

/* INSERT INTO quote_requests (a, b, c) VALUES ($1,$3,$7) RETURNING ...  ->  zip the named columns with their parameters */
const DEFAULTS = { status: 'new', source: 'shop' };   // columns the INSERT statements leave to the schema default
function insertFromSql(sql, params) {
  const cols = /\(([^)]*)\)\s*VALUES/.exec(sql)[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const vals = /VALUES\s*\(([^)]*)\)/.exec(sql)[1].split(',').map((c) => c.trim());
  const row = {};
  cols.forEach((c, i) => {
    const t = vals[i] || '';
    const mark = /^\$(\d+)$/.exec(t);
    if (mark) row[c] = params[Number(mark[1]) - 1];
    else if (/^'(.*)'$/s.test(t)) row[c] = t.slice(1, -1);
    else if (/^NULL$/i.test(t)) row[c] = null;
  });
  DB.seq.quote += 1;
  row.quote_id = DB.seq.quote;
  row.quote_no = row.quote_no || 'QR-' + DB.seq.quote;
  return Object.assign({ contact_email: null, company_name: null, flexible_date: false, specs: {}, details: '', progress: [], payments: [],
    paid_amount: 0, converted_order_id: null, handover_sale_id: null, handover_at: null, converted_at: null,
    created_at: new Date(), updated_at: new Date() }, DEFAULTS, row);
}
/* UPDATE quote_requests SET a = $2, b = $3 WHERE ... RETURNING ... */
function applySet(row, sql, params) {
  const set = /SET (.*?) WHERE/.exec(sql);
  if (!set) return;
  // Postgres would evaluate these; emulate the only conditional the quotation routes use: col=CASE WHEN $2='quoted' THEN $n ELSE col END
  const body = set[1].replace(/([a-z_]+)=CASE WHEN \$2='quoted' THEN \$(\d+)(::date)? ELSE \1 END/gi, (m, col, n) => {
    if (String(params[1]) === 'quoted') row[col.toLowerCase()] = params[Number(n) - 1];
    return '';
  });
  // col = COALESCE($n, col): Postgres keeps the old value when the caller sent nothing. Splitting on ',' would cut this in half.
  const rest = body.replace(/([a-z_]+)\s*=\s*COALESCE\(\s*\$(\d+)\s*,\s*\1\s*\)/gi, (m, col, n) => {
    const v = params[Number(n) - 1];
    if (v != null && v !== '') row[col.toLowerCase()] = v;
    return '';
  });
  rest.split(',').forEach((part) => {
    const m = /([a-z_]+)\s*=\s*\$(\d+)/i.exec(part.trim());
    if (m) {
      // the quotation display copy of the payments is written as $2::jsonb — Postgres would store a real array
      const raw = params[Number(m[2]) - 1];
      let v = raw;
      if (/::jsonb/i.test(part) && typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { /* keep the string */ } }
      row[m[1].toLowerCase()] = v;
      return;
    }
    // Finance approve-price copies one column into another (quoted_amount=proposed_amount); Postgres reads the old row value.
    const cc = /([a-z_]+)\s*=\s*([a-z_]+)\s*(?=,|$)/i.exec(part.trim());
    if (cc) { row[cc[1].toLowerCase()] = row[cc[2].toLowerCase()]; return; }
    else { const lit = /([a-z_]+)\s*=\s*(now\(\)|'[^']*'|[^,]+)/i.exec(part.trim()); if (lit) row[lit[1].toLowerCase()] = lit[2].trim() === 'now()' ? new Date() : lit[2].replace(/'/g, ''); }
  });
  row.updated_at = new Date();
}

async function query(sql, params = []) {
  const s = clean(sql), p = params || [];
  const logs = [];
  // the payment ledger double answers first for its own statements (payment_terms, payments, the derived totals)
  const money = paymentSql(s, p);
  if (money) return money;
  if (/^(ALTER TABLE|CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE))/.test(s)) return rowsOf([]);
  if (/^SELECT pg_advisory_xact_lock/.test(s)) return rowsOf([]);
  if (/^INSERT INTO audit_log/.test(s)) { DB.audit.push({ action: p[3] || p[1], detail: p[4] || p[2], occurred_at: new Date() }); return rowsOf([]); }
  if (/^INSERT INTO orders\s*\(/.test(s)) {
    // db/schema.sql:66 gives a new order DEFAULT 'Pending Confirmation' and neither the checkout route nor the quote
    // conversion names a status, so the double has to supply that same default — several shipped routes gate on it.
    const rec = { order_id: ++DB.seq.order, order_no: 'ORD-' + DB.seq.order,
      customer_id: p[0], total: Number(p[7]) || Number(p[6]) || 0, status: 'Pending Confirmation', payment_status: 'unpaid',
      paid_amount: 0, payment_state: 'unpaid', terms_key: null, terms_percent: null, terms_amount: null, terms_condition: null, terms_approved_by: null,
      created_at: new Date(), updated_at: new Date() };
    DB.orders.push(rec); return rowsOf([rec]);
  }
  if (/^INSERT INTO (order_items|order_status_history)/.test(s)) { DB.orderLines.push({ sql: s.slice(0, 40), order_id: Number(p[0]) }); return rowsOf([]); }
  if (/^INSERT INTO pos_sales/.test(s)) {
    const rec = { sale_id: ++DB.seq.sale, receipt_no: 'R-' + DB.seq.sale, customer_id: p[0], total: Number(p[7]) || Number(p[6]) || 0 };
    DB.sales.push(rec); return rowsOf([rec]);
  }
  if (/^INSERT INTO quote_attachments/.test(s)) {
    const a = { attachment_id: ++DB.seq.attach, quote_id: p[0], file_name: p[1], mime: p[2], size_bytes: p[3], data: p[4], uploaded_by: p[5], created_at: new Date() };
    DB.attachments.push(a); return rowsOf([a]);
  }
  if (/^DELETE FROM quote_attachments/.test(s)) { const b = DB.attachments.length; DB.attachments = DB.attachments.filter((a) => !(a.attachment_id === p[0] && a.quote_id === p[1])); return { rows: [], rowCount: b - DB.attachments.length }; }
  if (/^INSERT INTO quote_requests/.test(s)) { const q = insertFromSql(s, p); DB.quotes.set(q.quote_no, q); return rowsOf([q]); }
  if (/^UPDATE quote_requests/.test(s)) {
    const q = /WHERE quote_id\s*=\s*\$1/i.test(s) ? quoteById(p[0]) : DB.quotes.get(String(p[0]).toUpperCase());
    if (!q) return rowsOf([]);
    // the POS hand-over guards itself with "AND handover_at IS NULL"; Postgres would match no row the second time
    const guard = /AND\s+([a-z_]+)\s+IS NULL/i.exec(s);
    if (guard && q[guard[1].toLowerCase()] != null) return rowsOf([]);
    applySet(q, s, p);
    return rowsOf(/RETURNING/i.test(s) ? [q] : []);
  }
  if (/^INSERT INTO quote_clarifications/.test(s)) {
    const c = { clarification_id: ++DB.seq.clar, quote_id: Number(p[0]), fields: JSON.parse(p[1] || '[]'), message: p[2], response_due: p[3] || null,
      created_by: p[4], status: 'awaiting_customer', response: null, submitted_specs: null, answered_at: null, created_at: new Date() };
    DB.clar.push(c); return rowsOf([c]);
  }
  if (/^SELECT clarification_id FROM quote_clarifications/.test(s)) return rowsOf(openClar(p[0]).map((c) => ({ clarification_id: c.clarification_id })));
  if (/^SELECT DISTINCT ON \(quote_id\) \* FROM quote_clarifications/.test(s)) { const ids = (p[0] || []).map(Number), latest = new Map();
    DB.clar.filter((c) => ids.includes(Number(c.quote_id))).forEach((c) => latest.set(c.quote_id, c)); return rowsOf([...latest.values()]); }
  if (/^SELECT k\.\*.*FROM quote_clarifications/.test(s)) return rowsOf(DB.clar.filter((c) => Number(c.quote_id) === Number(p[0])));
  if (/^SELECT \* FROM quote_clarifications/.test(s)) return rowsOf(/awaiting_customer/.test(s) ? openClar(p[0]) : DB.clar.filter((c) => Number(c.quote_id) === Number(p[0])));
  if (/^UPDATE quote_clarifications/.test(s)) { const c = DB.clar.find((x) => Number(x.clarification_id) === Number(p[0])); if (!c) return rowsOf([]); applySet(c, s, p); c.status = 'answered'; return rowsOf([c]); }
  if (/^SELECT \* FROM quote_requests WHERE quote_no\s*=\s*\$1.*FOR UPDATE/.test(s)) {
    const q = DB.quotes.get(String(p[0]).toUpperCase());
    const tail = s.replace(/^SELECT \* FROM quote_requests WHERE quote_no\s*=\s*\$1/i, '');
    const okOwner = !/customer_id\s*=\s*\$2/i.test(tail) || (q && Number(q.customer_id) === Number(p[1]));
    const okSource = !/source\s*=\s*'([a-z]+)'/i.test(tail) || (q && q.source === /source\s*=\s*'([a-z]+)'/i.exec(tail)[1]);
    return rowsOf(q && okOwner && okSource ? [q] : []);
  }
  // the ledger service locks a quotation by its key column, whichever the caller passed (payment-terms.js:339)
  if (/^SELECT \* FROM quote_requests WHERE quote_id = \$1 FOR UPDATE/i.test(s)) return rowsOf([quoteById(Number(p[0]))].filter(Boolean));
  // the Xendit webhook finds the quotation a paid invoice belongs to by the two identifiers stored on it
  if (/^SELECT \* FROM quote_requests WHERE xendit_external_id/i.test(s)) {
    return rowsOf([...DB.quotes.values()].filter((q) => String(q.xendit_external_id) === String(p[0]) && String(q.xendit_invoice_id) === String(p[1])).slice(0, 1));
  }
  if (/^SELECT .*FROM products/.test(s)) { const pr = PRODUCTS.find((x) => x.sku === String(p[0]).toUpperCase()); return rowsOf(pr ? [{ product_id: 1, sku: pr.sku, name: pr.name, unit: pr.unit, selling_price: pr.price, on_hand: pr.available, is_archived: false }] : []); }
  if (/^SELECT a\.mime, a\.data, a\.file_name FROM quote_attachments/.test(s)) {
    const q = DB.quotes.get(String(p[1]).toUpperCase());
    const a = q && DB.attachments.find((x) => x.attachment_id === Number(p[0]) && x.quote_id === q.quote_id);
    return rowsOf(a ? [a] : []);
  }
  if (/^SELECT a\.attachment_id, a\.file_name/.test(s)) return rowsOf(DB.attachments.filter((a) => Number(a.quote_id) === Number(p[0])));
  if (/^SELECT action, detail/.test(s)) return rowsOf(DB.audit.slice(-25).map((a) => ({ action: a.action, detail: a.detail, user_name: 'Harness', role_label: 'Cashier', occurred_at: a.occurred_at })));
  if (/^SELECT count\(\*\)::int AS n FROM quote_attachments/.test(s)) return rowsOf([{ n: DB.attachments.filter((a) => Number(a.quote_id) === Number(p[0])).length }]);
  if (/^SELECT order_no, total, status FROM orders/.test(s)) { const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0])); return rowsOf(o ? [o] : []); }
  // some of the shipped quote SELECTs are written across several lines, so .* would stop at the first newline
  if (/^SELECT [\s\S]*\bFROM quote_requests/.test(s)) {
    let rows = [...DB.quotes.values()];
    const one = /WHERE q\.quote_no = \$1/.test(s);
    if (one) rows = [DB.quotes.get(String(p[0]).toUpperCase())].filter(Boolean);
    if (!one) {
      // only the WHERE half of the statement filters: /api/finance/quotes sorts by (q.status IN (...)) DESC, which is
      // not a restriction, so reading it as one would hide every quoted request from Finance.
      const where = s.split(/\border\b/i)[0];
      const inSt = /q\.status IN \(([^)]*)\)/.exec(where); if (inSt) { const a = inSt[1].split(',').map((x) => x.trim().replace(/'/g, '')); rows = rows.filter((q) => a.includes(q.status)); }
      const eqSt = /q\.status = '([a-z_]+)'/.exec(where); if (eqSt) rows = rows.filter((q) => q.status === eqSt[1]);
      const src = /q\.source = '(shop|pos)'/.exec(where); if (src) rows = rows.filter((q) => (q.source || 'shop') === src[1]);
      const mine = /q\.created_by = \$\d+/.exec(where); if (mine) rows = rows.filter((q) => Number(q.created_by) === Number(p[Number(mine[0].replace(/\D/g, '')) - 1]));
      // the customer's own list is not aliased: WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50
      const own = /WHERE customer_id = \$(\d+)/.exec(s); if (own) rows = rows.filter((q) => Number(q.customer_id) === Number(p[Number(own[1]) - 1]));
      const like = p.find((x) => typeof x === 'string' && x.includes('%'));
      if (like) rows = rows.filter((q) => likeRe(like).test(`${q.quote_no} ${q.contact_name} ${q.phone} ${q.product_name || ''}`.toLowerCase()));
      if (/GROUP BY q\.status/.test(s)) { const m = new Map(); rows.forEach((q) => m.set(q.status, (m.get(q.status) || 0) + 1)); return rowsOf([...m].map(([status, n]) => ({ status, n }))); }
      if (/ORDER BY .*created_at DESC/i.test(s)) rows = rows.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (/LIMIT/.test(s)) {
        // the desk pages with LIMIT $n OFFSET $m; the shop routes write the number straight into the SQL
        const lm = /LIMIT \$(\d+)/i.exec(s), lit = /LIMIT (\d+)/i.exec(s);
        const om = /OFFSET \$(\d+)/i.exec(s), olit = /OFFSET (\d+)/i.exec(s);
        const limit = lm ? Number(p[Number(lm[1]) - 1]) : lit ? Number(lit[1]) : rows.length;
        const offset = om ? Number(p[Number(om[1]) - 1]) : olit ? Number(olit[1]) : 0;
        rows = rows.slice(offset, offset + limit);
      }
    }
    if (/^SELECT count/i.test(s)) return rowsOf([{ n: rows.length }]);
    return rowsOf(rows.map((q) => Object.assign({}, q,
      { created_by_name: (USERS[q.created_by] || {}).full_name, handled_by_name: null, customer_email: q.customer_id ? 'customer' + q.customer_id + '@example.com' : null,
        // the shipped SELECTs join users for the name of whoever signed the quotation's terms
        terms_decided_by_name: (USERS[q.terms_decided_by] || {}).full_name || null,
        proposed_by_name: (USERS[q.proposed_by] || {}).full_name || null,          // who sent the price to Finance (shop-extras.js joins users for it)
        attachment_count: DB.attachments.filter((a) => Number(a.quote_id) === Number(q.quote_id)).length,
        // the desk's SELECT joins orders so it can show the converted order number
        order_no: (DB.orders.find((o) => Number(o.order_id) === Number(q.converted_order_id)) || {}).order_no || null,
        converted_order_no: (DB.orders.find((o) => Number(o.order_id) === Number(q.converted_order_id)) || {}).order_no || null,
        clarification_status: (openClar(q.quote_id)[0] || {}).status || null })));
  }
  logs.push('unhandled: ' + s.slice(0, 120));
  if (global.__HARNESS_LOG) console.log('[harness sql]', s.slice(0, 140), JSON.stringify(p).slice(0, 160));
  return rowsOf([]);
}

/* ---------------- the app ---------------- */
class ValidationError extends Error { constructor(fields) { super(Object.values(fields)[0]); this.fields = fields; } }
let SESSION = { id: 3, name: 'Test Cashier', role: 'cashier', roleLabel: 'Cashier', email: 'cashier@example.com' };
const auth = (...allowed) => (req, res, next) => {
  if (!SESSION) return res.status(401).json({ error: 'Not signed in' });
  req.user = SESSION;
  if (allowed.length && !allowed.includes(SESSION.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, fields: err.fields });
  if (err && err.fields) return res.status(400).json({ error: Object.values(err.fields)[0], fields: err.fields });
  console.error(err); res.status(500).json({ error: 'Server error: ' + err.message });
});
const str = (v) => (v == null ? '' : String(v)).trim();
const pool = { query };
const tx = async (fn) => fn({ query });
const audit = async (c, u, action, detail) => c.query('INSERT INTO audit_log VALUES ($1,$2,$3,$4,$5)', [u.id, u.name, u.roleLabel, action, detail]);
const validateShipTo = async (b) => b;
const formatShipTo = (b) => [b.addressLine, b.barangay, b.city, b.province, b.zip].filter(Boolean).join(', ');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/api/auth/me', (req, res) => res.json(SESSION || { name: 'Demo Cashier', role: 'cashier' }));
app.get('/api/pos/products', auth('cashier'), (req, res) => res.json(PRODUCTS));
app.get('/api/pos/sales', auth('cashier'), (req, res) => res.json(DB.sales));
app.post('/api/pos/sales', auth('cashier'), (req, res) => {
  const no = str(req.body && req.body.quoteNo);
  const s = { sale_id: ++DB.seq.sale, id: DB.seq.sale, receipt_no: 'R-' + DB.seq.sale, total: 0, status: 'Completed' };
  DB.sales.unshift(s);
  if (no) { const q = DB.quotes.get(no.toUpperCase()); if (q) { q.handover_sale_id = s.sale_id; q.handover_at = q.handover_at || new Date(); } }
  res.status(201).json({ receiptNo: s.receipt_no, total: s.total, change: 0 });
});
['/api/geo/regions', '/api/geo/regions/0/provinces', '/api/geo/provinces/0/cities', '/api/geo/cities/0/barangays'].forEach((route, i) => {
  app.get(route, auth('customer', 'cashier', 'finance'), (req, res) => res.json(
    i === 0 ? [{ code: 'R3', name: 'Central Luzon' }, { code: 'R1', name: 'CALABARZON' }]
      : i === 1 ? [{ code: 'P1', name: 'Nueva Ecija' }] : i === 2 ? [{ code: 'C1', name: 'Cabanatuan City' }, { code: 'C2', name: 'Gapan City' }]
        : [{ code: 'B1', name: 'Poblacion' }, { code: 'B2', name: 'San Isidro' }]));
});
app.get('/api/shop/notifications', auth(), (req, res) => res.json({ items: [], unread: 0 }));

/* dev-only: the small pieces of pos-shop.js that Shop_Customer.html needs before it can show the quotation form.
   The live shop routes are not mounted here; these keep their response shape. */
app.get('/api/shop/products', auth('customer'), (req, res) => res.json(PRODUCTS.map((p) => ({
  sku: p.sku, name: p.name, category: p.category, unit: p.unit, price: p.price, spec: p.spec,
  specs: { material: p.spec.split(' · ')[0], size: p.spec.split(' · ')[1] || '', thickness: (p.spec.match(/[\d.]+\s*mm/) || [''])[0], finish: '' },
  available: p.available, inStock: p.available > 0, onHand: p.available, minOrder: 1, rating: null, image: null }))));
app.get('/api/shop/info', (req, res) => res.json({ deliveryFee: 250, deliveryFeeFrom: 0, deliveryFeeTo: 1000,
  refundWindowDays: 7, cancelAutoHours: 12, cancelReasons: ['Changed my mind', 'Ordered the wrong size', 'Found a better price'],
  info: { name: 'Triple E Metal Products', address: 'Quezon City', phone: '(02) 700-0000', email: 'quotes@example.com' } }));
app.get('/api/shop/config', auth('customer'), (req, res) => res.json({ deliveryFee: 250, refundWindowDays: 7, cancelAutoHours: 12,
  cancelReasons: ['Changed my mind'], info: { name: 'Triple E Metal Products', address: 'Quezon City', phone: '(02) 700-0000', email: 'quotes@example.com' } }));
app.get('/api/shop/addresses', auth('customer'), (req, res) => res.json([]));

/* dev-only: flip the signed-in identity so the customer and Finance steps can be clicked through in a browser.
   Nothing in server.js uses this file; it exists so the desk UI can be exercised without the live database. */
app.post('/__harness/session', (req, res) => {
  const r = str(req.body && req.body.role), id = Number(req.body && req.body.id) || 0;
  SESSION = r === 'customer' ? { id: id || 10, name: (USERS[id] || {}).full_name || 'Eva Son', role: 'customer', roleLabel: 'Customer', email: 'customer@example.com' }
    : r === 'finance' ? { id: id || 4, name: 'Test Finance', role: 'finance', roleLabel: 'Finance', email: 'finance@example.com' }
    : r === 'none' ? null : { id: id || 3, name: 'Test Cashier', role: 'cashier', roleLabel: 'Cashier', email: 'cashier@example.com' };
  res.json(SESSION || { signedOut: true });
});

/* dev-only: open or close the test cashier's drawer, so the counter's "cash needs an open shift" rule can be
   exercised without a real pos_cash_shifts table. */
app.post('/__harness/shift', (req, res) => {
  DB.cashShiftId = req.body && req.body.open ? Number(req.body.id || 11) : null;
  res.json({ cashShiftId: DB.cashShiftId });
});

/* dev-only: apply the SHIPPED §8 release rules (payment-terms.js: orderMoney + releaseDecision) to a stored order,
   so the gate decisions can be tested without mounting the stock, rider, mail and shift machinery around them.
   The body may say what to assume about this one row — its payment method, what the ledger has collected, which term
   it is on, even what its fulfilment status claims — because no PostgreSQL here means no way to stage every order
   shape. Nothing is written. server.js never uses this file. */
app.post('/__harness/release-check/:no', auth('cashier'), wrap(async (req, res) => {
  const found = DB.orders.find((x) => String(x.order_no).toUpperCase() === String(req.params.no).toUpperCase());
  if (!found) return res.status(404).json({ error: 'The harness has no such order' });
  const b = req.body || {};
  const row = Object.assign({}, found, {
    status: str(b.status) || found.status,
    payment_method: str(b.method) || found.payment_method || 'GCash',
    paid_amount: b.paid == null ? found.paid_amount : Number(b.paid),
    terms_key: b.termsKey === undefined ? found.terms_key : b.termsKey,
    terms_percent: b.termsPercent === undefined ? found.terms_percent : b.termsPercent,
    terms_amount: b.termsAmount === undefined ? found.terms_amount : b.termsAmount,
    terms_condition: b.termsCondition === undefined ? found.terms_condition : b.termsCondition
  });
  const pt = app.locals.paymentTerms;
  const opts = { role: str(b.role) || SESSION.role, verified: !!b.verified };
  res.json({ orderNo: row.order_no, method: row.payment_method, money: pt.orderMoney(row),
    confirm: pt.releaseDecision(row, Object.assign({ action: 'confirm' }, opts)),
    release: pt.releaseDecision(row, Object.assign({ action: 'release' }, opts)) });
}));

/* dev-only: stamp the two Xendit identifiers an online quotation payment carries onto a harness row, so the webhook
   half of shop-extras.js can be exercised without the live gateway. server.js never uses this file. */
app.post('/__harness/quote-xendit/:no', auth('finance'), wrap(async (req, res) => {
  const q = DB.quotes.get(String(req.params.no).toUpperCase());
  if (!q) return res.status(404).json({ error: 'The harness has no such quotation' });
  q.xendit_external_id = str(req.body && req.body.externalId);
  q.xendit_invoice_id = str(req.body && req.body.invoiceId);
  res.json({ quoteNo: q.quote_no, externalId: q.xendit_external_id, invoiceId: q.xendit_invoice_id });
}));

/* dev-only: deliver a Xendit callback for a quotation through the SHIPPED handler (shop-extras.js app.locals.quoteXendit),
   so a retried callback recording the money once can be tested (§6, §11). */
app.post('/__harness/quote-callback', auth('finance'), wrap(async (req, res) => {
  const b = req.body || {};
  const handler = app.locals.quoteXendit;
  if (!handler) return res.status(500).json({ error: 'shop-extras did not mount the Xendit quote handler' });
  res.json({ handled: await handler.handle(b.event || {}, str(b.externalId), str(b.invoiceId)) });
}));

/* dev-only: read the in-memory tables so the conversion tests can prove that no second order, sale or stock
   movement appeared. */
app.get('/__harness/state', (req, res) => res.json({
  orders: DB.orders, orderLines: DB.orderLines.length, sales: DB.sales, attachments: DB.attachments.length, clar: DB.clar,
  payments: DB.payments, terms: DB.terms, quotes: [...DB.quotes.values()],
  stock: PRODUCTS.map((p) => ({ sku: p.sku, available: p.available }))
}));

/* quote-automation.js talks to tables this double does not keep (products with costs, recipes, quote_rules), so the harness
   gives shop-extras.js a stand-in with the SAME routing rules (the shipped routeQuote): a catalog product's system price is its
   harness price x quantity, its cost 80% of that, its stock the harness "available"; a custom item cannot be priced here, so it
   goes to Finance as "not costed". The cashier limit is the starting value from CASHIER_QUOTE_LIMIT_PHP (0 = Finance approves all); suites that test something
   other than pricing may widen the band with HARNESS_QUOTE_BAND_PCT, because their sample prices are not the harness prices. */
const { routeQuote } = require(path.join(__dirname, '..', 'quote-automation.js')).pure;
DB.decisions = [];
app.locals.quoteAutomation = {
  ready: Promise.resolve(true),
  settings: async () => ({ tolerancePct: Number(process.env.HARNESS_QUOTE_BAND_PCT || 5), minMarginPct: 0, valueLimit: Number(process.env.CASHIER_QUOTE_LIMIT_PHP || 0), costMovePct: 5, expiryReminderDays: 2 }),
  draftForQuote: async (db, q) => {
    const p = q.product_sku && PRODUCTS.find((x) => x.sku === String(q.product_sku).toUpperCase());
    const n = Number(String(q.quantity || '').replace(/,/g, '').match(/[\d.]+/) || 0);
    if (!p || !(n > 0)) return { ok: false, status: 'cannot_price', problems: [{ code: 'harness', message: 'The harness has no costs for a custom item.' }], shortfalls: [] };
    const total = Math.round(p.price * n * 100) / 100, short = n > p.available ? n - p.available : 0;
    return { ok: true, status: short ? 'short' : 'ok', total, costTotal: Math.round(total * 80) / 100, pricePerPiece: p.price,
      shortfalls: short ? [{ sku: p.sku, name: p.name, unit: p.unit, needed: n, onHand: p.available, short }] : [] };
  },
  route: routeQuote,
  saveRecipe: async (db, q) => q,
  logDecision: async (db, d) => { DB.decisions.push({ quote: d.quote.quote_no, action: d.action, rules: d.rules || (d.decision || {}).rules || [] }); },
  onAccept: async () => null,
  afterAccept: () => {}
};
app.get('/__harness/decisions', (req, res) => res.json(DB.decisions));

// payment-terms owns the ledger that shop-extras writes through, so it mounts first here too (same order as server.js)
mountPaymentTerms({ app, pool, auth, wrap, tx, audit, ValidationError, str });
mountShopExtras({ app, pool, auth, wrap, tx, audit, ValidationError, str });
mountQuoteDesk({ app, pool, auth, wrap, tx, audit, ValidationError, str, validateShipTo, formatShipTo });
// anything the harness does not implement answers as JSON, so the UI shows its real error state instead of an HTML 404 page
app.use('/api', (req, res) => res.status(404).json({ error: 'The browser harness does not implement ' + req.path }));
app.use(express.static(ROOT, { extensions: ['html'] }));

fs.existsSync(path.join(ROOT, 'POS_Cashier.html')) || (console.error('Finance_Inventory/POS_Cashier.html not next to this harness'), process.exit(1));
app.listen(PORT, '127.0.0.1', () => console.log('quotation desk browser harness on http://127.0.0.1:' + PORT + '/POS_Cashier.html'));
