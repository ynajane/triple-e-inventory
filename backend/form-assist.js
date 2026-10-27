/* form-assist.js — Task 9: the server side of the form helpers (Finance product / stock forms, quote forms, customer and supplier forms).

   GET /api/products/next-sku?department=&category=   the next free SKU for a department + category, e.g. RM-AL-001
       Prefix = department code (RM / FG / FS) + the category code. The category code is the one the products of that category
       already use (RM-AL-ADC12, RM-AL-A380 -> AL); a category with no products yet gets the initials of its words.
       The number is one more than the highest number already used with that prefix (archived products count too), 3 digits.
       Only a suggestion: the form keeps the box editable and the server still checks the SKU is free when the product is saved.
   GET /api/products/:sku/last-receipt                  what the last supplier delivery of a product was: supplier, cost per unit,
       date, plus the product's storage location. Pre-fills the Stock In form and drives the "is this right?" cost check.
   GET /api/geo/zip-lookup?zip=1630                     the places a Philippine ZIP code belongs to (from data/ph-zip.json), so
       an address form can fill region / province / city / barangay from the ZIP.
   GET /api/customers/match?phone=&email=               (finance, cashier) customers already known by this phone or email:
       registered accounts, earlier walk-in sales and walk-in quotes. Lets a form say "this looks like X" instead of creating a twin.

   The rules are plain functions (exported) so test/form-assist.test.js can check them without a database. */
'use strict';

const DEPT_CODE = { 'Raw Materials': 'RM', 'Finished Goods': 'FG', 'Finishing Supplies': 'FS' };
const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'in', 'products', 'product', 'supplies', 'materials']);

// "Plating & Chemicals" -> "PC", "Aluminum Alloy" -> "AA". Used only when no product of the category exists yet.
function initialsCode(category) {
  const words = String(category || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !SMALL_WORDS.has(w.toLowerCase()));
  if (!words.length) return 'GEN';
  if (words.length === 1) return words[0].slice(0, 3);
  return words.slice(0, 3).map((w) => w[0]).join('');
}

// The category code the existing SKUs of a category share: the most common second segment of "DEPT-CODE-...".
function categoryCode(category, skusOfCategory, deptCode) {
  const counts = new Map();
  (skusOfCategory || []).forEach((sku) => {
    const parts = String(sku).toUpperCase().split('-');
    if (parts.length >= 3 && parts[0] === deptCode && /^[A-Z][A-Z0-9]{0,5}$/.test(parts[1])) counts.set(parts[1], (counts.get(parts[1]) || 0) + 1);
  });
  let best = null, n = 0;
  counts.forEach((c, code) => { if (c > n) { best = code; n = c; } });
  return best || initialsCode(category);
}

// next number after the highest PREFIX-<digits> already used -> "PREFIX-007"
function nextSkuFrom(prefix, allSkus) {
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d{1,6})$');
  const taken = new Set((allSkus || []).map((s) => String(s).toUpperCase()));
  let max = 0;
  taken.forEach((s) => { const m = re.exec(s); if (m) max = Math.max(max, Number(m[1])); });
  let n = max + 1, sku;
  do { sku = prefix + '-' + String(n).padStart(3, '0'); n++; } while (taken.has(sku));
  return sku;
}

/* ---------- ZIP -> place ---------- */
const REGION_ALIAS = [
  [/metro manila|national capital|^ncr$/, 'NCR'], [/cordillera|^car$/, 'CAR'], [/ilocos/, 'Region I '], [/cagayan valley/, 'Region II '],
  [/central luzon/, 'Region III '], [/calabarzon/, 'Region IV-A'], [/mimaropa/, 'MIMAROPA'], [/bicol/, 'Region V '],
  [/western visayas/, 'Region VI '], [/negros island/, 'NIR'], [/central visayas/, 'Region VII '], [/eastern visayas/, 'Region VIII '],
  [/zamboanga/, 'Region IX '], [/northern mindanao/, 'Region X '], [/davao/, 'Region XI '], [/soccsksargen/, 'Region XII '],
  [/caraga/, 'Region XIII '], [/muslim mindanao|bangsamoro|barmm|armm/, 'BARMM']
];
const low = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function regionName(admin1, regions) {
  const a = low(admin1);
  if (!a) return '';
  const hit = REGION_ALIAS.find(([re]) => re.test(a));
  if (!hit) return '';
  return (regions || []).find((r) => (r + ' ').startsWith(hit[1])) || '';
}
const NCR_DISTRICT = /manila district|capital district/i;
function provinceName(row) {
  if (low(row.admin1) === 'metro manila' || NCR_DISTRICT.test(row.admin2 || '')) return 'Metro Manila';
  return String(row.admin2 || '').replace(/^Province of\s+/i, '').trim();
}
// "Manila CPO - Ermita" -> city Manila, barangay/district Ermita; "Quezon City CPO" -> Quezon City
function cityAndArea(row) {
  const place = String(row.place || '').trim();
  const cpo = /^(.*?)\s+(?:CPO|P\.?O\.?|Post Office)(?:\s*-\s*(.*))?$/i.exec(place);
  if (row.admin3) return { city: row.admin3, barangay: cpo ? (cpo[2] || '') : place };
  if (cpo) return { city: cpo[1], barangay: cpo[2] || '' };
  return { city: place, barangay: '' };
}
// -> [{ zip, region, province, city, barangay }], most specific first, duplicates removed
function zipPlaces(zip, rows, regions) {
  if (!/^\d{4}$/.test(String(zip || '')) || !Array.isArray(rows)) return [];
  const provRegion = new Map();               // some rows have no region: borrow it from another row of the same province
  rows.forEach((r) => { const p = low(provinceName(r)); if (p && r.admin1 && !provRegion.has(p)) provRegion.set(p, r.admin1); });
  const seen = new Set(), out = [];
  rows.filter((r) => r.zip === String(zip)).forEach((r) => {
    const province = provinceName(r), ca = cityAndArea(r);
    const region = regionName(r.admin1 || provRegion.get(low(province)), regions);
    if (!region && !province) return;          // institutional / PO-box ZIPs ("Asian Development Bank") have no place to fill in
    const key = [region, province, ca.city, ca.barangay].map(low).join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ zip: String(zip), region, province, city: ca.city, barangay: ca.barangay });
  });
  return out;
}

// any Philippine number -> its last 10 digits (0917 123 4567, +63 917 123 4567 and 63917... are one number)
const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-10) : ''; };

module.exports = function mountFormAssist({ app, pool, auth, wrap, str, loadZipRows, REGIONS, TZ }) {
  app.get('/api/products/next-sku', auth('finance'), wrap(async (req, res) => {
    const department = str(req.query.department), category = str(req.query.category);
    const dept = DEPT_CODE[department];
    if (!dept) return res.status(400).json({ error: 'Choose a department first' });
    const all = (await pool.query('SELECT sku FROM products')).rows.map((r) => r.sku);
    let code = '';
    if (category) {
      const same = await pool.query(
        `SELECT p.sku FROM products p JOIN categories c USING (category_id)
          WHERE p.department = $1 AND lower(btrim(c.name)) = lower($2)`, [department, category]);
      code = categoryCode(category, same.rows.map((r) => r.sku), dept);
    }
    const prefix = code ? dept + '-' + code : dept;
    res.json({ sku: nextSkuFrom(prefix, all), prefix });
  }));

  app.get('/api/products/:sku/last-receipt', auth('finance'), wrap(async (req, res) => {
    const sku = str(req.params.sku).toUpperCase();
    const p = (await pool.query('SELECT product_id, location, unit, unit_cost, on_hand FROM products WHERE sku = $1 AND NOT is_archived', [sku])).rows[0];
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const m = (await pool.query(
      `SELECT s.code AS supplier, s.name AS supplier_name, s.status, m.unit_cost, m.quantity, m.invoice_no,
              to_char(m.created_at AT TIME ZONE $2, 'Mon DD, YYYY') AS day
         FROM stock_movements m LEFT JOIN suppliers s ON s.supplier_id = m.supplier_id
        WHERE m.product_id = $1 AND m.movement_type = 'in' AND m.reason = 'supplier_receipt'
        ORDER BY m.created_at DESC, m.movement_id DESC LIMIT 1`, [p.product_id, TZ])).rows[0];
    res.json({
      location: p.location || '', unit: p.unit, onHand: +p.on_hand, averageCost: +p.unit_cost,
      last: m ? { supplier: m.status === 'active' ? m.supplier : null, supplierName: m.supplier_name || null, unitCost: m.unit_cost == null ? null : +m.unit_cost,
        quantity: +m.quantity, invoiceNo: m.invoice_no || null, day: m.day } : null
    });
  }));

  app.get('/api/geo/zip-lookup', auth('finance', 'customer', 'cashier'), wrap(async (req, res) => {
    const zip = str(req.query.zip);
    if (!/^\d{4}$/.test(zip)) return res.json({ zip, places: [] });
    let rows = null;
    try { rows = await loadZipRows(); } catch { rows = null; }
    if (!rows) return res.json({ zip, places: [], unavailable: true });
    res.json({ zip, places: zipPlaces(zip, rows, REGIONS).slice(0, 12) });
  }));

  app.get('/api/customers/match', auth('finance', 'cashier'), wrap(async (req, res) => {
    const key = phoneKey(req.query.phone), email = str(req.query.email).toLowerCase();
    if (!key && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ matches: [] });
    const digits = `right(regexp_replace(coalesce($COL,''), '\\D', '', 'g'), 10)`;
    const out = [];
    const accounts = await pool.query(
      `SELECT u.user_id, u.full_name, u.email, u.phone FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE r.role_key = 'customer' AND (($1 <> '' AND ${digits.replace('$COL', 'u.phone')} = $1) OR ($2 <> '' AND lower(u.email) = $2))
        ORDER BY u.full_name LIMIT 3`, [key, email]);
    accounts.rows.forEach((u) => out.push({ kind: 'account', id: u.user_id, name: u.full_name, phone: u.phone || '', email: u.email || '',
      by: key && phoneKey(u.phone) === key ? 'phone' : 'email' }));
    if (key) {
      const walkin = await pool.query(
        `SELECT customer_name, customer_phone, to_char(created_at AT TIME ZONE $2, 'Mon DD, YYYY') AS day FROM pos_sales
          WHERE ${digits.replace('$COL', 'customer_phone')} = $1 AND coalesce(customer_name, '') <> ''
          ORDER BY created_at DESC LIMIT 1`, [key, TZ]).catch(() => ({ rows: [] }));
      walkin.rows.forEach((s) => out.push({ kind: 'walk-in', name: s.customer_name, phone: s.customer_phone, email: '', last: s.day, by: 'phone' }));
    }
    const quotes = await pool.query(
      `SELECT contact_name, phone, contact_email, to_char(created_at AT TIME ZONE $3, 'Mon DD, YYYY') AS day FROM quote_requests
        WHERE customer_id IS NULL AND (($1 <> '' AND ${digits.replace('$COL', 'phone')} = $1) OR ($2 <> '' AND lower(contact_email) = $2))
        ORDER BY created_at DESC LIMIT 1`, [key, email, TZ]).catch(() => ({ rows: [] }));
    quotes.rows.forEach((q) => out.push({ kind: 'walk-in quote', name: q.contact_name, phone: q.phone || '', email: q.contact_email || '', last: q.day,
      by: key && phoneKey(q.phone) === key ? 'phone' : 'email' }));
    // one line per person: an account wins over a walk-in record with the same name
    const seen = new Set();
    res.json({ matches: out.filter((m) => { const k = low(m.name); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4) });
  }));
};
module.exports.categoryCode = categoryCode;
module.exports.initialsCode = initialsCode;
module.exports.nextSkuFrom = nextSkuFrom;
module.exports.zipPlaces = zipPlaces;
module.exports.phoneKey = phoneKey;
