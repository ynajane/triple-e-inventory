/* quote-desk.test.js — integration test for the Cashier Quotation Desk API.

   Runs the real module inside a real Express app over HTTP, with a scripted PostgreSQL layer in place of a live
   database, so route wiring, role gates, validation, status guards, the file-type check and the "convert exactly
   once" behaviour are exercised end to end.  Run with:  node backend/test/quote-desk.test.js
   It never opens a connection to the production database. */
const path = require('path');
const http = require('http');
const NM = path.join(__dirname, '..', 'node_modules');
const express = require(path.join(NM, 'express'));
const mountQuoteDesk = require(path.join(__dirname, '..', 'quote-desk.js'));

let PASS = 0, FAIL = 0;
const ok = (name, cond, extra) => { if (cond) { PASS++; console.log('  PASS  ' + name); } else { FAIL++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };

/* ---------------- the scripted database ---------------- */
const DB = { quotes: new Map(), orders: [], orderItems: [], attachments: [], audit: [], seq: { order: 500, attach: 1 }, products: new Map() };
const P = (o) => { DB.quotes.set(o.quote_no, Object.assign({ paid_amount: 0, payments: [], progress: [], specs: {}, created_at: new Date('2026-10-01T02:00:00Z'), updated_at: new Date() }, o)); };
P({ quote_id: 1, quote_no: 'QR-1001', customer_id: 7, contact_name: 'Ana Cruz', phone: '09171234567', product_sku: 'FG-BRASS-01',
    product_name: 'Brass elbow 3/4', quantity: '200 pcs', details: 'Material: Brass', needed_by: '2026-12-01', fulfillment: 'Pickup',
    status: 'accepted', quoted_amount: 9000, pay_method: 'Pay on pickup', source: 'shop' });
P({ quote_id: 2, quote_no: 'QR-1002', customer_id: null, contact_name: 'Ben Dimaano', phone: '09181234567', product_sku: 'FG-BRASS-01',
    product_name: 'Brass elbow 3/4', quantity: '10 pcs', details: 'Material: Brass', needed_by: '2026-12-01', fulfillment: 'Pickup',
    status: 'accepted', quoted_amount: 4500, pay_method: 'Pay on pickup', source: 'pos' });
P({ quote_id: 3, quote_no: 'QR-1003', customer_id: 7, contact_name: 'Cara Lim', phone: '09191234567', product_sku: null,
    product_name: 'Custom stainless tray', quantity: '5 pcs', details: 'Material: Stainless Steel 304', needed_by: '2026-12-01',
    fulfillment: 'Pickup', status: 'accepted', quoted_amount: 9000, pay_method: 'Cash', source: 'shop' });
P({ quote_id: 4, quote_no: 'QR-1004', customer_id: 8, contact_name: 'Dan Reyes', phone: '09201234567', product_sku: 'FG-OUT-01',
    product_name: 'Copper sheet 4x8', quantity: '900 sheets', details: 'Material: Copper', needed_by: '2026-12-01', fulfillment: 'Delivery',
    area: 'Brgy. Poblacion, Cabanatuan, Nueva Ecija', status: 'accepted', quoted_amount: 30000, pay_method: 'Xendit', source: 'shop' });
P({ quote_id: 5, quote_no: 'QR-1005', customer_id: 9, contact_name: 'Eva Son', phone: '09211234567', product_sku: 'FG-BRASS-01',
    product_name: 'Brass tee 1/2', quantity: '30 pcs', details: 'Material: Brass', needed_by: '2026-12-15', fulfillment: 'Pickup',
    status: 'new', source: 'shop' });
/* filler so that search, filters and pagination are tested against a list longer than one page */
[['QR-1006', 'quoted'], ['QR-1007', 'quoted'], ['QR-1008', 'closed'], ['QR-1009', 'completed'],
 ['QR-1010', 'awaiting_details'], ['QR-1011', 'pending_approval'], ['QR-1012', 'declined']].forEach((x, i) => {
  P({ quote_id: 6 + i, quote_no: x[0], customer_id: 20 + i, contact_name: 'Bulk Buyer ' + (i + 1), phone: '0922000' + (1000 + i),
      product_sku: 'FG-BRASS-01', product_name: 'Brass elbow 3/4', quantity: '25 pcs', details: 'Material: Brass',
      needed_by: '2026-12-20', fulfillment: 'Pickup', status: x[1], source: 'shop', quoted_amount: x[1] === 'new' ? null : 1125 });
});
DB.products.set('FG-BRASS-01', { product_id: 11, sku: 'FG-BRASS-01', name: 'Brass elbow 3/4', unit: 'pcs', selling_price: 450, on_hand: 1200, is_archived: false });
DB.products.set('FG-OUT-01', { product_id: 12, sku: 'FG-OUT-01', name: 'Copper sheet 4x8', unit: 'sheets', selling_price: 90, on_hand: 40, is_archived: false });

const likeToRe = (pattern) => new RegExp(String(pattern).replace(/%/g, '.*'), 'i');
const rowsOf = (rows) => ({ rows, rowCount: rows.length });
function byQuoteId(id) { return [...DB.quotes.values()].find((q) => Number(q.quote_id) === Number(id)); }

/* A small SQL matcher — just enough for the statements quote-desk.js really sends. */
async function query(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  if (/^SELECT pg_advisory_xact_lock/.test(s)) return rowsOf([]);
  if (/^(ALTER TABLE|CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE))/.test(s)) return rowsOf([]);
  if (/^INSERT INTO audit_log/.test(s)) { DB.audit.push({ action: p[3], detail: p[4] }); return rowsOf([]); }
  if (/^INSERT INTO order_status_history/.test(s)) return rowsOf([]);
  if (/^INSERT INTO orders /.test(s)) {
    const o = { order_id: ++DB.seq.order, order_no: 'ORD-' + DB.seq.order, customer_id: p[0], fulfillment: p[1], address: p[2], phone: p[3],
      payment_method: p[4], subtotal: Number(p[5]), delivery_fee: Number(p[6]), total: Number(p[7]), recipient_name: p[8], address_line: p[9],
      barangay: p[11], city: p[12], province: p[13], region: p[14], zip_code: p[15], status: 'Pending', payment_status: 'unpaid' };
    DB.orders.push(o); return rowsOf([o]);
  }
  if (/^INSERT INTO order_items/.test(s)) { DB.orderItems.push({ order_id: p[0], product_id: p[1], sku: p[2], qty: p[5], price: p[6] }); return rowsOf([]); }
  if (/^INSERT INTO quote_attachments/.test(s)) {
    const a = { attachment_id: ++DB.seq.attach, quote_id: p[0], file_name: p[1], mime: p[2], size_bytes: p[3], data: p[4], uploaded_by: p[5] };
    DB.attachments.push(a); return rowsOf([a]);
  }
  if (/^DELETE FROM quote_attachments/.test(s)) {
    const before = DB.attachments.length;
    DB.attachments = DB.attachments.filter((a) => !(a.attachment_id === p[0] && a.quote_id === p[1]));
    return { rows: [], rowCount: before - DB.attachments.length };
  }
  if (/^SELECT order_no, total, status FROM orders/.test(s)) { const o = DB.orders.find((x) => Number(x.order_id) === Number(p[0])); return rowsOf(o ? [{ order_no: o.order_no, total: o.total, status: o.status }] : []); }
  if (/^UPDATE quote_requests SET converted_order_id/.test(s)) {
    const q = byQuoteId(p[0]); if (!q) return rowsOf([]);
    q.converted_order_id = p[1]; q.converted_at = new Date(); q.convert_request_id = p[2]; q.converted_note = p[3];
    return rowsOf([q]);
  }
  if (/^UPDATE quote_requests SET handover_at/.test(s)) {
    const q = byQuoteId(p[0]); if (!q || q.handover_at) return rowsOf([]);
    q.handover_at = new Date(); return rowsOf([{ handover_at: q.handover_at }]);
  }
  if (/^UPDATE quote_requests SET handover_sale_id/.test(s)) {
    const q = byQuoteId(p[0]); if (!q) return rowsOf([]);
    if (q.handover_sale_id && Number(q.handover_sale_id) !== Number(p[1])) throw Object.assign(new Error('already used'), { fields: { quote: 'This quotation was already used on another receipt' } });
    q.handover_sale_id = p[1]; return rowsOf([q]);
  }
  if (/^UPDATE quote_requests SET updated_at/.test(s)) return rowsOf([]);
  if (/^SELECT .*FROM products/.test(s)) { const pr = DB.products.get(String(p[0]).toUpperCase()); return rowsOf(pr && !pr.is_archived ? [pr] : []); }
  if (/^SELECT a\.mime, a\.data, a\.file_name FROM quote_attachments a JOIN quote_requests q/.test(s)) {
    const q = DB.quotes.get(p[1]);
    const a = q && DB.attachments.find((x) => x.attachment_id === p[0] && x.quote_id === q.quote_id);
    return rowsOf(a ? [a] : []);
  }
  if (/^SELECT a\.attachment_id, a\.file_name/.test(s)) return rowsOf(DB.attachments.filter((a) => a.quote_id === p[0]));
  if (/^SELECT k\.\*, u\.full_name AS asked_by_name FROM quote_clarifications/.test(s)) return rowsOf([]);
  if (/^SELECT action, detail/.test(s)) return rowsOf(DB.audit.map((a) => ({ action: a.action, detail: a.detail, user_name: 'Tester', role_label: 'Cashier', occurred_at: new Date() })));
  if (/^SELECT count\(\*\)::int AS n FROM quote_attachments/.test(s)) return rowsOf([{ n: DB.attachments.filter((a) => String(a.quote_id) === String(p[0])).length }]);
  if (/^SELECT q\.status, count\(\*\)::int AS n FROM quote_requests/.test(s)) {
    const m = new Map(); [...DB.quotes.values()].forEach((q) => m.set(q.status, (m.get(q.status) || 0) + 1));
    return rowsOf([...m].map(([status, n]) => ({ status, n })));
  }
  if (/^SELECT count\(\*\)::int AS n FROM quote_requests q WHERE/.test(s)) {
    const like = /LIKE \$/.test(s) ? p.find((x) => typeof x === 'string' && x.includes('%')) : null;
    return rowsOf([{ n: pickRows(like, s).length }]);
  }
  if (/^SELECT q\.\*, c\.full_name AS created_by_name/.test(s)) {
    if (/WHERE q\.quote_no = \$1/.test(s)) { const q = DB.quotes.get(p[0]); return rowsOf(q ? [Object.assign({}, q, { created_by_name: 'Tester', attachment_count: DB.attachments.filter((a) => a.quote_id === q.quote_id).length })] : []); }
    const like = /LIKE \$/.test(s) ? p.find((x) => typeof x === 'string' && x.includes('%')) : null;
    const limit = p[p.length - 2], offset = p[p.length - 1];
    return rowsOf(pickRows(like, s).slice(Number(offset), Number(offset) + Number(limit))
      .map((q) => Object.assign({}, q, { created_by_name: 'Tester', attachment_count: DB.attachments.filter((a) => a.quote_id === q.quote_id).length })));
  }
  if (/\* FROM quote_requests WHERE quote_no = \$1 FOR UPDATE/.test(s)) { const q = DB.quotes.get(p[0]); return rowsOf(q ? [q] : []); }
  throw new Error('unhandled SQL in the test double: ' + s.slice(0, 150));
}
/* The double only ever receives parameterised values, so the literal WHERE fragments (status / source filters)
   are read back out of the SQL text — that is the part of the query this test wants to prove is applied. */
function pickRows(likeParam, sql) {
  let rows = [...DB.quotes.values()];
  const statusIn = /q\.status IN \(([^)]*)\)/.exec(sql || '');
  if (statusIn) { const allowed = statusIn[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')); rows = rows.filter((q) => allowed.includes(q.status)); }
  const eq = /q\.status = '([a-z_]+)'/.exec(sql || '');
  if (eq) rows = rows.filter((q) => q.status === eq[1]);
  const src = /q\.source = '(shop|pos)'/.exec(sql || '');
  if (src) rows = rows.filter((q) => (q.source || 'shop') === src[1]);
  if (likeParam) { const re = likeToRe(likeParam); rows = rows.filter((q) => re.test(`${q.quote_no} ${q.contact_name} ${q.phone} ${q.product_name || ''}`.toLowerCase())); }
  return rows.sort((a, b) => String(b.quote_no).localeCompare(String(a.quote_no)));
}
const pool = { query };
const tx = async (fn) => fn({ query });

/* ---------------- the app ---------------- */
class ValidationError extends Error { constructor(fields) { super(Object.values(fields)[0]); this.fields = fields; } }
let ROLE = 'cashier';
const auth = (...allowed) => (req, res, next) => {
  req.user = { id: 3, name: 'Test Cashier', role: ROLE, roleLabel: ROLE };
  if (allowed.length && !allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
};
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, fields: err.fields });
  if (err && err.fields) return res.status(400).json({ error: Object.values(err.fields)[0], fields: err.fields });
  console.error(err); res.status(500).json({ error: 'Server error' });
});
const str = (v) => (v == null ? '' : String(v)).trim();

const app = express();
app.use(express.json());                                        // same as server.js: JSON bodies, raw bodies per route
const desk = mountQuoteDesk({ app, pool, auth, wrap, tx, str, ValidationError,
  audit: async (c, u, action, detail) => c.query('INSERT INTO audit_log VALUES ($1,$2,$3,$4,$5)', [u.id, u.name, u.roleLabel, action, detail]),
  validateShipTo: async (b) => {
    ['recipient', 'addressLine', 'barangay', 'city', 'province', 'region', 'zip'].forEach((k) => { if (!str(b[k]) && k !== 'landmark') throw new ValidationError({ [k]: 'Enter the ' + k }); });
    return Object.assign({}, b, { fullAddress: [b.addressLine, b.barangay, b.city, b.province, b.zip].filter(Boolean).join(', ') });
  },
  formatShipTo: (b) => [b.addressLine, b.barangay, b.city, b.province, b.zip].filter(Boolean).join(', ') });
const linkSale = (client, no, saleId) => app.locals.quoteDesk.linkSale(client, no, saleId);

let PORT;
const server = http.createServer(app);
async function call(method, url, { body, headers } = {}) {
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: url,
      headers: Object.assign({ 'Content-Type': Buffer.isBuffer(body) ? 'image/png' : 'application/json' }, headers || {}) },
    (res) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  let json = null; try { json = JSON.parse(r.body.toString('utf8')); } catch (e) { /* bytes */ }
  return { status: r.status, headers: r.headers, json, raw: r.body };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  console.log('\n1. role gates');
  ROLE = 'customer';
  ok('the desk list refuses a customer (403)', (await call('GET', '/api/pos/quote-desk')).status === 403);
  ok('the desk detail refuses a customer (403)', (await call('GET', '/api/pos/quote-desk/QR-1001')).status === 403);
  ok('conversion refuses a customer (403)', (await call('POST', '/api/pos/quote-desk/QR-1001/convert', { body: JSON.stringify({ requestId: 'x'.repeat(20) }) })).status === 403);
  ROLE = 'cashier';

  console.log('\n2. the desk list (search / sort / page / filter)');
  const all = await call('GET', '/api/pos/quote-desk');
  ok('200 with a paged result object', all.status === 200 && Array.isArray(all.json.rows) && typeof all.json.total === 'number', all.json && all.json.error);
  ok('every column the redesign shows is on the row', ['id', 'customer', 'phone', 'product', 'source', 'quantity', 'neededBy', 'amount', 'requestDate', 'statusLabel'].every((k) => k in all.json.rows[0]), Object.keys(all.json.rows[0] || {}));
  ok('facet counts are computed server-side', all.json.counts.all === 12 && all.json.counts.open === 2 && all.json.counts.active === 4 && all.json.counts.done === 3 && all.json.counts.approval === 1 && all.json.counts.quoted === 2, all.json.counts);
  const search = await call('GET', '/api/pos/quote-desk?q=cara');
  ok('search by customer name finds exactly that quotation', search.json.rows.length === 1 && search.json.rows[0].id === 'QR-1003', search.json.rows.map((r) => r.id));
  const byPhone = await call('GET', '/api/pos/quote-desk?q=09181234567');
  ok('search by phone works', byPhone.json.rows.length === 1 && byPhone.json.rows[0].id === 'QR-1002');
  const sorted = await call('GET', '/api/pos/quote-desk?sort=customer&dir=asc');
  ok('sorting is applied and echoed back', sorted.status === 200 && sorted.json.sort === 'customer' && sorted.json.dir === 'asc');
  const paged = await call('GET', '/api/pos/quote-desk?page=2&pageSize=10');
  ok('pagination slices the requested page', paged.json.rows.length === 2 && paged.json.pageCount === 2 && paged.json.page === 2 && paged.json.total === 12, { n: paged.json.rows.length, pc: paged.json.pageCount, total: paged.json.total });
  ok('page 1 and page 2 never repeat a quotation', paged.json.rows.map((r) => r.id).join() === 'QR-1002,QR-1001', paged.json.rows.map((r) => r.id));
  const filtered = await call('GET', '/api/pos/quote-desk?status=active');
  ok('the status filter is applied in SQL, not in the browser', filtered.json.rows.length === 4 && filtered.json.filter === 'active' && filtered.json.rows.every((r) => ['accepted', 'preparing', 'ready'].includes(r.status)), filtered.json.rows.map((r) => [r.id, r.status]));
  const hostile = await call('GET', '/api/pos/quote-desk?sort=created%3B%20DROP%20TABLE%20quote_requests--&dir=asc');
  ok('a hostile sort falls back to a known column instead of running', hostile.status === 200 && hostile.json.sort === 'created');
  const wild = await call('GET', '/api/pos/quote-desk?q=%25%5F');
  ok('LIKE wildcards in a search term are escaped, not treated as wildcards', wild.json.rows.length === 0, wild.json.rows.length);
  const badFilters = await call('GET', '/api/pos/quote-desk?status=anything&source=zzz&page=0&pageSize=7');
  ok('unknown filters / sizes degrade to safe defaults', badFilters.status === 200 && badFilters.json.filter === 'all' && badFilters.json.source === 'all' && badFilters.json.pageSize === 10 && badFilters.json.page === 1);
  const src = await call('GET', '/api/pos/quote-desk?source=pos');
  ok('the Source filter separates walk-in from online', src.json.rows.every((r) => r.source === 'pos') && src.json.rows.length >= 1);

  console.log('\n3. one quotation in full');
  const det = await call('GET', '/api/pos/quote-desk/QR-1002');
  ok('detail returns the quote plus history arrays', det.status === 200 && det.json.id === 'QR-1002' && Array.isArray(det.json.clarifications) && det.json.attachments === undefined, det.json && det.json.error);
  ok('detail carries the full specifications and the audit trail', typeof det.json.details === 'string' && Array.isArray(det.json.notes));
  ok('a fresh request reads "Pending Cashier Review" for the cashier', (await call('GET', '/api/pos/quote-desk/QR-1005')).json.statusLabel === 'Pending Cashier Review');
  const nf = await call('GET', '/api/pos/quote-desk/QR-9999');
  ok('an unknown reference is a 400 with a field error', nf.status === 400 && nf.json.fields.id !== undefined, nf.json);

  console.log('\n4. no reference drawings or photos any more');
  const gone = await call('POST', '/api/pos/quote-desk/QR-1005/attachments?name=a.png', { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), headers: { 'Content-Type': 'image/png' } });
  ok('the upload route no longer exists', gone.status === 404, gone.status);
  ok('nothing was stored', DB.attachments.length === 0, DB.attachments.length);
  const noFiles = await call('GET', '/api/pos/quote-desk/QR-1005');
  ok('the detail and the list carry no file fields', noFiles.json.attachments === undefined && (await call('GET', '/api/pos/quote-desk')).json.rows.every((r) => r.attachmentCount === undefined));

  console.log('\n5. accepted quotation -> order, exactly once');
  const conv = await call('POST', '/api/pos/quote-desk/QR-1001/convert', { body: JSON.stringify({ requestId: 'convert-pickup-0001' }) });
  ok('conversion creates one order', conv.status === 200 && conv.json.kind === 'order' && !!conv.json.orderNo, conv.json);
  ok('the order is created UNPAID (a quote is not a payment)', DB.orders.length === 1 && DB.orders[0].payment_status === 'unpaid' && DB.orders[0].status === 'Pending', DB.orders[0]);
  ok('no stock movement is recorded by the conversion itself', !DB.orderItems.some((i) => i.deducted));
  ok('the order line carries the accepted quantity and unit price', DB.orderItems[0] && DB.orderItems[0].qty === 200 && DB.orderItems[0].price === 45, DB.orderItems[0]);
  ok('the quotation keeps its own reference on the order', DB.audit.some((a) => /QR-1001 converted to order/.test(a.detail)), DB.audit.map((a) => a.detail));
  const again = await call('POST', '/api/pos/quote-desk/QR-1001/convert', { body: JSON.stringify({ requestId: 'convert-pickup-0002' }) });
  ok('a second click with a different id returns the SAME order, no duplicate', again.json.duplicate === true && again.json.orderNo === conv.json.orderNo && DB.orders.length === 1, again.json);
  const retry = await call('POST', '/api/pos/quote-desk/QR-1001/convert', { body: JSON.stringify({ requestId: 'convert-pickup-0002' }) });
  ok('replaying the same request id is still idempotent', retry.json.orderNo === conv.json.orderNo && DB.orders.length === 1);
  ok('a conversion with no request id is refused', (await call('POST', '/api/pos/quote-desk/QR-1005/convert', { body: JSON.stringify({}) })).json.fields.requestId !== undefined);
  const tooShort = await call('POST', '/api/pos/quote-desk/QR-1005/convert', { body: JSON.stringify({ requestId: 'abc' }) });
  ok('a too-short request id is refused', tooShort.status === 400 && tooShort.json.fields.requestId !== undefined);
  const notAccepted = await call('POST', '/api/pos/quote-desk/QR-1005/convert', { body: JSON.stringify({ requestId: 'convert-new-00001' }) });
  ok('only an accepted quotation can be converted (QR-1005 is "new")', notAccepted.status === 400 && notAccepted.json.fields.status !== undefined, notAccepted.json);
  const custom = await call('POST', '/api/pos/quote-desk/QR-1003/convert', { body: JSON.stringify({ requestId: 'convert-custom-001' }) });
  ok('a custom item with no catalog product is refused with a clear reason', custom.status === 400 && custom.json.fields.product !== undefined, custom.json);
  const scarce = await call('POST', '/api/pos/quote-desk/QR-1004/convert', { body: JSON.stringify({ requestId: 'convert-scarce-001',
    shipTo: { recipient: 'Dan Reyes', addressLine: '123 Mabini St.', barangay: 'Poblacion', city: 'Cabanatuan', province: 'Nueva Ecija', region: 'Central Luzon', zip: '3100' } }) });
  ok('stock is verified before converting (900 sheets wanted, 40 on hand)', scarce.status === 400 && scarce.json.fields.stock !== undefined, scarce.json);

  console.log('\n5b. walk-in quotation -> the POS counter');
  // two accepted quotes written in kg for a product that is sold by pcs (created here so the list totals above stay as they were)
  P({ quote_id: 20, quote_no: 'QR-1020', customer_id: 7, contact_name: 'Gil Tan', phone: '09271234567', product_sku: 'FG-BRASS-01',
      product_name: 'Brass elbow 3/4', quantity: '5 kg', details: 'Material: Brass', needed_by: '2026-12-01', fulfillment: 'Pickup',
      status: 'accepted', quoted_amount: 2250, pay_method: 'Pay on pickup', source: 'shop' });
  P({ quote_id: 21, quote_no: 'QR-1021', customer_id: null, contact_name: 'Hana Uy', phone: '09281234567', product_sku: 'FG-BRASS-01',
      product_name: 'Brass elbow 3/4', quantity: '5 kg', details: 'Material: Brass', needed_by: '2026-12-01', fulfillment: 'Pickup',
      status: 'accepted', quoted_amount: 2250, pay_method: 'Pay on pickup', source: 'pos' });
  // a quantity in kg can never become "5 pcs": the unit has to be the one the product is sold in (pcs)
  const kgOnline = await call('POST', '/api/pos/quote-desk/QR-1020/convert', { body: JSON.stringify({ requestId: 'convert-unit-online-1' }) });
  ok('an online quote in kg is not converted into pcs of a product sold by pcs', kgOnline.status === 400 && kgOnline.json.fields.quantity !== undefined && /sold by pcs/.test(kgOnline.json.fields.quantity), kgOnline.json);
  ok('... and no order was made for it', DB.quotes.get('QR-1020').converted_order_id === undefined || DB.quotes.get('QR-1020').converted_order_id === null);
  const kgWalkin = await call('POST', '/api/pos/quote-desk/QR-1021/convert', { body: JSON.stringify({ requestId: 'convert-unit-walkin-1' }) });
  ok('a walk-in quote in kg is not handed to the counter as pcs either', kgWalkin.status === 400 && kgWalkin.json.fields.quantity !== undefined, kgWalkin.json);
  ok('... and nothing was handed over', !DB.quotes.get('QR-1021').handover_at);
  const walkin = await call('POST', '/api/pos/quote-desk/QR-1002/convert', { body: JSON.stringify({ requestId: 'convert-walkin-001' }) });
  ok('a walk-in quote hands the counter a ready line (sku, qty, unit price)', walkin.status === 200 && walkin.json.kind === 'pos' && walkin.json.sku === 'FG-BRASS-01' && walkin.json.qty === 10 && walkin.json.unitPrice === 450, walkin.json);
  ok('it reports the on-hand stock so the cashier knows before ringing up', walkin.json.stock === 1200);
  const walkin2 = await call('POST', '/api/pos/quote-desk/QR-1002/convert', { body: JSON.stringify({ requestId: 'convert-walkin-002' }) });
  ok('the same walk-in quote cannot be handed over twice', walkin2.status === 400 && walkin2.json.fields.status !== undefined, walkin2.json);
  ok('handing over does not create an order row', DB.orders.length === 1);

  console.log('\n6. one quotation can only cover one receipt');
  await linkSale({ query }, 'QR-1002', 9001);
  ok('the linked sale id is stored on the quotation', Number(DB.quotes.get('QR-1002').handover_sale_id) === 9001, DB.quotes.get('QR-1002').handover_sale_id);
  let clash = null;
  try { await linkSale({ query }, 'QR-1002', 9002); } catch (e) { clash = e.fields; }
  ok('linking a second receipt to the same quotation is refused', clash && clash.quote !== undefined, clash);
  await linkSale({ query }, 'QR-1002', 9001);
  ok('replaying the same receipt is allowed (no false error)', Number(DB.quotes.get('QR-1002').handover_sale_id) === 9001);

  console.log('\n7. pure helpers');
  ok('"12.5 linear m" parses into a quantity and a unit', JSON.stringify(desk.splitQuantity('12.5 linear m')) === JSON.stringify({ qty: 12.5, unit: 'linear m' }));
  ok('"1,200 pcs" keeps its thousands separator out of the number', desk.splitQuantity('1,200 pcs').qty === 1200);
  ok('a malformed quantity is rejected instead of guessed', desk.splitQuantity('lots of them') === null);
  ok('the cashier label for a customer answer says "Awaiting Customer Details"', desk.labelFor('awaiting_details', 'Pickup') === 'Awaiting Customer Details');
  ok('an expired quote is labelled as expired, not "Quote Ready"', desk.labelFor('quoted', 'Pickup', true) === 'Quote Expired');
  ok('ready means "Out for Delivery" only on delivery quotes', desk.labelFor('ready', 'Delivery') === 'Out for Delivery' && desk.labelFor('ready', 'Pickup') === 'Ready for Pickup');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  server.close();
  process.exit(FAIL ? 1 : 0);
  setTimeout(() => process.exit(0), 2000);
})();
