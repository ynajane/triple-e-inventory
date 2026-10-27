/* delivery-calc.js — the delivery fee and the estimated arrival date are worked out, nobody types them.

     fee      = the area rate (delivery_rates, by province / region)   — unchanged, Finance still sets it per place
              + weight charge  = every whole kg above the free allowance x the per-kg fee
              (or 0 when the goods total reaches the free-delivery amount, if Finance has set one)
     arrival  = today (Manila) + packing days + transit days, counting working days only (no Sundays, no fixed-date
                Philippine holidays). Shown as a range, earliest to latest.

   Weight comes from products.weight_kg (per piece, Finished Goods). A product with no weight adds nothing, so
   nothing changes until Finance fills the weights in. Finance edits the numbers below in Sales > Orders > Delivery
   (GET / PUT /api/delivery-settings). Everything the server prices is repeated when the order is saved.
   The rules are plain functions (exported on the module) so test/delivery-calc.test.js can check them without a database. */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const DEFAULTS = {
  freeWeightKg: 20,      // no weight charge up to this many kg
  perKgFee: 5,           // pesos for every whole kg above it
  freeOverAmount: 0,     // goods total (pesos) that earns free delivery; 0 = off
  packDays: 1,           // working days to pack and hand over to the courier
  transitMetro: 2,       // working days on the road: Metro Manila
  transitOther: 5,       // everywhere else
  rangeDays: 2           // the latest date is this many working days after the earliest
};
const LIMITS = {
  freeWeightKg: [0, 100000], perKgFee: [0, 10000], freeOverAmount: [0, 10000000],
  packDays: [0, 30], transitMetro: [0, 60], transitOther: [0, 60], rangeDays: [0, 30]
};
const WHOLE = ['packDays', 'transitMetro', 'transitOther', 'rangeDays'];

// Philippine holidays that fall on the same date every year. Movable ones (Holy Week, Eid, National Heroes Day) change each
// year and are not listed: the estimate can be a day short around them, which is why it is a range.
const FIXED_HOLIDAYS = ['01-01', '04-09', '05-01', '06-12', '08-21', '11-01', '11-30', '12-08', '12-24', '12-25', '12-30', '12-31'];

/* ---------- weight and fee ---------- */
// lines: [{ qty, unit, weight_kg }]. A line sold by the kg weighs its quantity; otherwise piece weight x quantity.
function totalWeightKg(lines) {
  let w = 0;
  for (const l of lines || []) {
    const qty = Number(l.qty) || 0;
    if (String(l.unit || '').trim().toLowerCase() === 'kg') { w += qty; continue; }
    w += qty * (Number(l.weight_kg) || 0);
  }
  return Math.round(w * 1000) / 1000;
}
// base = the area rate. Returns every part so the screen can explain the number.
function computeFee({ base, weightKg, goodsTotal }, s) {
  const set = Object.assign({}, DEFAULTS, s || {});
  const b = round2(base), kg = Number(weightKg) || 0;
  if (set.freeOverAmount > 0 && Number(goodsTotal) >= set.freeOverAmount)
    return { fee: 0, base: b, weightKg: kg, extraKg: 0, weightCharge: 0, free: true, note: 'Free delivery on orders of ' + set.freeOverAmount.toLocaleString('en-PH') + ' pesos or more' };
  const extraKg = Math.max(0, Math.ceil(kg - set.freeWeightKg - 1e-9));
  const weightCharge = round2(extraKg * set.perKgFee);
  return { fee: round2(b + weightCharge), base: b, weightKg: kg, extraKg, weightCharge, free: false,
    note: weightCharge > 0 ? `Area rate plus ${extraKg} kg over ${set.freeWeightKg} kg x ${set.perKgFee} pesos` : '' };
}

/* ---------- dates ---------- */
const pad = (n) => String(n).padStart(2, '0');
const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toIso = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
const isWorkingDay = (iso) => { const dt = toDate(iso); return dt.getUTCDay() !== 0 && !FIXED_HOLIDAYS.includes(iso.slice(5)); };
// `from` + n working days (n = 0 returns the next working day on or after `from`)
function addWorkingDays(from, n) {
  let dt = toDate(from), left = Math.max(0, Math.floor(n));
  while (!isWorkingDay(toIso(dt))) dt.setUTCDate(dt.getUTCDate() + 1);
  while (left > 0) { dt.setUTCDate(dt.getUTCDate() + 1); if (isWorkingDay(toIso(dt))) left--; }
  return toIso(dt);
}
const isMetro = (place) => /\b(ncr|metro manila|national capital)\b/i.test(`${(place && place.region) || ''} ${(place && place.province) || ''}`);
// today = 'YYYY-MM-DD' in Manila. Orders placed after the cut-off hour start counting tomorrow.
function estimateArrival(place, today, s, hour) {
  const set = Object.assign({}, DEFAULTS, s || {});
  const transit = isMetro(place) ? set.transitMetro : set.transitOther;
  const start = Number(hour) >= 15 ? addWorkingDays(today, 1) : addWorkingDays(today, 0);
  const earliest = addWorkingDays(start, set.packDays + transit), latest = addWorkingDays(earliest, set.rangeDays);
  return { earliest, latest, workingDays: set.packDays + transit };
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; };
const rangeText = (e) => (e.earliest === e.latest ? niceDate(e.earliest) : e.earliest.slice(5, 7) === e.latest.slice(5, 7)
  ? `${niceDate(e.earliest)}\u2013${Number(e.latest.slice(8))}` : `${niceDate(e.earliest)} \u2013 ${niceDate(e.latest)}`);

/* ---------- settings validation ---------- */
function cleanSettings(body) {
  const out = {}, errors = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = body && body[k];
    if (v === undefined || v === null || v === '') { errors[k] = 'Enter a number (0 switches it off)'; continue; }
    const n = Number(v);
    if (!Number.isFinite(n)) { errors[k] = 'Must be a number'; continue; }
    if (n < LIMITS[k][0] || n > LIMITS[k][1]) { errors[k] = `Must be between ${LIMITS[k][0]} and ${LIMITS[k][1]}`; continue; }
    if (WHOLE.includes(k) && !Number.isInteger(n)) { errors[k] = 'Whole days only'; continue; }
    if (Math.round(n * 100) / 100 !== n) { errors[k] = 'At most 2 decimal places'; continue; }
    out[k] = n;
  }
  return { out, errors };
}

function manilaNow(TZ) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ || 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { today: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function mount({ app, pool, auth, wrap, tx, audit, ValidationError, TZ }) {
  const ready = (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(10,3) CHECK (weight_kg IS NULL OR weight_kg >= 0)');
      await pool.query(`CREATE TABLE IF NOT EXISTS delivery_settings (
        id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        free_weight_kg NUMERIC(10,2) NOT NULL DEFAULT ${DEFAULTS.freeWeightKg},
        per_kg_fee NUMERIC(10,2) NOT NULL DEFAULT ${DEFAULTS.perKgFee},
        free_over_amount NUMERIC(12,2) NOT NULL DEFAULT ${DEFAULTS.freeOverAmount},
        pack_days INT NOT NULL DEFAULT ${DEFAULTS.packDays},
        transit_metro INT NOT NULL DEFAULT ${DEFAULTS.transitMetro},
        transit_other INT NOT NULL DEFAULT ${DEFAULTS.transitOther},
        range_days INT NOT NULL DEFAULT ${DEFAULTS.rangeDays},
        updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('INSERT INTO delivery_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    } catch (err) { console.warn('[db] could not prepare the delivery settings:', err.message); }
  })();

  const fromRow = (r) => ({ freeWeightKg: +r.free_weight_kg, perKgFee: +r.per_kg_fee, freeOverAmount: +r.free_over_amount,
    packDays: +r.pack_days, transitMetro: +r.transit_metro, transitOther: +r.transit_other, rangeDays: +r.range_days });
  // never throws: a database problem falls back to the built-in numbers instead of blocking a sale
  async function settings(db) {
    try { await ready; const { rows } = await (db || pool).query('SELECT * FROM delivery_settings WHERE id = 1'); return rows[0] ? fromRow(rows[0]) : { ...DEFAULTS }; }
    catch (e) { return { ...DEFAULTS }; }
  }
  // base = { fee, ... } from the area rate; items = loadSellable() rows ({ qty, unit, weight_kg, price })
  async function quote(db, place, base, items) {
    const s = await settings(db);
    const goodsTotal = (items || []).reduce((n, i) => n + Number(i.price || 0) * Number(i.qty || 0), 0);
    const kg = totalWeightKg(items);
    const f = computeFee({ base: base.fee, weightKg: kg, goodsTotal }, s);
    const now = manilaNow(TZ), eta = estimateArrival(place, now.today, s, now.hour);
    return { ...f, eta: { earliest: eta.earliest, latest: eta.latest, text: rangeText(eta), workingDays: eta.workingDays } };
  }

  app.get('/api/delivery-settings', auth('finance'), wrap(async (req, res) => res.json({ ...(await settings()), defaults: DEFAULTS })));
  app.put('/api/delivery-settings', auth('finance'), wrap(async (req, res) => {
    const { out, errors } = cleanSettings(req.body || {});
    if (Object.keys(errors).length) throw new ValidationError(errors);
    await ready;
    await tx(async (client) => {
      await client.query(`UPDATE delivery_settings SET free_weight_kg=$1, per_kg_fee=$2, free_over_amount=$3, pack_days=$4, transit_metro=$5,
        transit_other=$6, range_days=$7, updated_by=$8, updated_at=now() WHERE id=1`,
        [out.freeWeightKg, out.perKgFee, out.freeOverAmount, out.packDays, out.transitMetro, out.transitOther, out.rangeDays, req.user.id]);
      await audit(client, req.user, 'Record edited', `Delivery fee rules: ${out.perKgFee} pesos per kg above ${out.freeWeightKg} kg, free over ${out.freeOverAmount || 'none'}; ${out.packDays}+${out.transitMetro} (Metro) / ${out.packDays}+${out.transitOther} (other) working days`);
    });
    res.json({ ...(await settings()), defaults: DEFAULTS });
  }));

  return { ready, settings, quote };
}

module.exports = mount;
Object.assign(mount, { DEFAULTS, totalWeightKg, computeFee, addWorkingDays, estimateArrival, rangeText, cleanSettings, isMetro });

