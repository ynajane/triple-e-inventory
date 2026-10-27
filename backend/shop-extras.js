/* shop-extras.js — extras for a metal-products shop:
     1. Request a quote           customer form -> Finance replies with a price -> customer accepts / declines
     2. Minimum order             products.min_order_qty (set by Finance in the product form), enforced on online orders
     3. Back-in-stock alerts      customer taps "Notify me" on an out-of-stock item; an email goes out when stock returns
     4. Verified reviews          only customers whose order is Delivered / Picked Up; Finance can hide a review

   Mounted in server.js:   require('./shop-extras')({ app, pool, auth, wrap, tx, audit, ValidationError, str });
   Like the other modules it creates its own tables on start (safe to run every time); 006_shop_extras.sql is the same
   thing for running by hand.  pos-shop.js calls app.locals.shopExtras.decorate / checkMinimums, and both fail soft:
   if these tables could not be created, the shop and the POS keep working without the extras. */
const mailer = require('./mailer');
const makeOrderMail = require('./order-mail');
const decimalNumber = require('./numeric-input');
const { escapeHtml: esc } = mailer;

const FINAL_STATUS = ['Delivered', 'Picked Up'];
const MOBILE_RE = /^(\+63|0)9\d{9}$/;
const NAME_RE = /^[\p{L}][\p{L}\p{M}\s.,'\u2019-]*$/u;
const MAX_OPEN_QUOTES = 5;           // a customer can have this many un-answered requests at once
const BACK_IN_STOCK_DAYS = 7;        // how long the "Back in stock" tag shows for a customer who asked to be told

/* ---------------- pure: who must be reminded about money still owed on an accepted quote, and when ----------------
   Nobody keys a payment in from Finance. Online money arrives by itself (Xendit); money taken on pickup / delivery is taken by the
   cashier at the counter. So the automation reminds the people who can actually move the money:
     customer  online payment not made   6 h after accepting, then every 24 h, at most 3 times
     Finance   online payment still not made after 72 h (once): chase the customer or close the quote
     cashier   the order is ready / out for delivery and a balance is still owed: at once, then every 48 h
     customer  same, every 48 h (the first "your order is ready" message already went out), at most 3 times
     Finance   ready but still unpaid after 7 days (once)
   Each action has a key; the notifications table (dedupeKey) is what stops the same reminder going out twice.
   q: { status, pay_method, quoted_amount, paid_amount, accepted_at (ms), ready_at (ms), has_account }  now: ms */
const HOUR = 3600000;
function paymentReminderPlan(q, now, cfg) {
  const c = Object.assign({ onlineFirstH: 6, onlineEveryH: 24, onlineMax: 3, onlineFinanceH: 72, readyEveryH: 48, readyMax: 3, readyFinanceH: 168 }, cfg || {});
  const owed = Math.round((Number(q.quoted_amount) - (Number(q.paid_amount) || 0)) * 100) / 100, out = [];
  if (!(owed > 0.004)) return out;
  if (q.status === 'accepted' && q.pay_method === 'Xendit' && !(Number(q.paid_amount) > 0) && q.accepted_at) {
    const h = (now - q.accepted_at) / HOUR;
    if (h >= c.onlineFirstH && q.has_account) {
      const n = Math.min(c.onlineMax, Math.floor((h - c.onlineFirstH) / c.onlineEveryH) + 1);
      out.push({ to: 'customer', kind: 'online', n, key: 'qpay_online:' + n, owed });
    }
    if (h >= c.onlineFinanceH) out.push({ to: 'finance', kind: 'online_stale', n: 1, key: 'qpay_online_stale', owed });
  }
  if (q.status === 'ready' && q.ready_at) {
    const h = (now - q.ready_at) / HOUR, n = Math.floor(h / c.readyEveryH);
    out.push({ to: 'cashier', kind: 'collect', n, key: 'qpay_collect:' + n, owed });
    if (n >= 1 && q.has_account && n <= c.readyMax) out.push({ to: 'customer', kind: 'pickup', n, key: 'qpay_pickup:' + n, owed });
    if (h >= c.readyFinanceH) out.push({ to: 'finance', kind: 'ready_stale', n: 1, key: 'qpay_ready_stale', owed });
  }
  return out;
}

module.exports = function mountShopExtras({ app, pool, auth, wrap, tx, audit, ValidationError, str }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const { shopInfo } = makeOrderMail(pool);
  const baseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ms = (d) => (d ? new Date(d).getTime() : undefined);

  /* ---------------- schema ---------------- */
  const ready = (async () => {
    try {
      await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_qty NUMERIC(14,2) NOT NULL DEFAULT 20 CHECK (min_order_qty > 0)');
      await pool.query(`CREATE SEQUENCE IF NOT EXISTS quote_no_seq START 1001`);
      await pool.query(`CREATE TABLE IF NOT EXISTS quote_requests (
        quote_id      BIGSERIAL PRIMARY KEY,
        quote_no      TEXT UNIQUE NOT NULL DEFAULT ('QR-' || nextval('quote_no_seq')),
        customer_id   INT NOT NULL REFERENCES users(user_id),
        contact_name  TEXT NOT NULL,
        phone         TEXT NOT NULL,
        product_sku   TEXT,
        product_name  TEXT,
        quantity      TEXT NOT NULL,
        details       TEXT NOT NULL,
        needed_by     DATE,
        fulfillment   TEXT CHECK (fulfillment IN ('Delivery','Pickup')),
        area          TEXT,
        status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','quoted','closed')),
        quoted_amount NUMERIC(14,2) CHECK (quoted_amount >= 0),
        reply_note    TEXT,
        handled_by    INT REFERENCES users(user_id),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quotes_customer ON quote_requests (customer_id, created_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_quotes_status ON quote_requests (status, created_at DESC)');

      await pool.query(`CREATE TABLE IF NOT EXISTS quote_clarifications (
        clarification_id BIGSERIAL PRIMARY KEY,
        quote_id BIGINT NOT NULL REFERENCES quote_requests(quote_id) ON DELETE CASCADE,
        fields JSONB NOT NULL,
        message TEXT NOT NULL,
        response_due DATE,
        status TEXT NOT NULL DEFAULT 'awaiting_customer' CHECK(status IN ('awaiting_customer','answered')),
        response TEXT,
        submitted_specs JSONB,
        created_by INT NOT NULL REFERENCES users(user_id),
        answered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_quote_open_clarification ON quote_clarifications(quote_id) WHERE status = 'awaiting_customer'");

      // walk-in customers logged at the POS have no shop account
      await pool.query('ALTER TABLE quote_requests ALTER COLUMN customer_id DROP NOT NULL');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS approval_reason TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS proposed_amount NUMERIC(14,2)');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS proposed_lead_time TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS proposed_valid_days INT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ready_by DATE');          // the date Finance promised in the guided quote form
      // who sent the price to Finance, when, and Finance's note when it sends the price back to the cashier
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS proposed_by INT REFERENCES users(user_id)');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMPTZ');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS finance_note TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS close_reason TEXT');
      // the system price (pricing.js) saved next to the cashier's price, and the computed cost behind it
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS suggested_amount NUMERIC(14,2)');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS cost_stale_at TIMESTAMPTZ');            // set by recipe-costing.js when a material cost moved after this quote was priced
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS cost_stale_note TEXT');
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS suggested_cost NUMERIC(14,2)');          // why Finance closed the request (CLOSE_REASONS)
      // a closed request ALWAYS has a reason, even if something skips the API. Requests closed before reasons existed are marked "other".
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_closed_needs_reason') THEN
          UPDATE quote_requests SET close_reason = 'other' WHERE status = 'closed' AND (close_reason IS NULL OR btrim(close_reason) = '');
          ALTER TABLE quote_requests ADD CONSTRAINT quote_closed_needs_reason
            CHECK (status <> 'closed' OR (close_reason IS NOT NULL AND btrim(close_reason) <> ''));
        END IF; END $$`);
      await pool.query(`ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'shop'`);
      await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(user_id)');
      // quote flow: needed-by date (older rows may have needed_months), dropdown choices, reply details, customer answer
      for (const c of ['needed_months INT CHECK (needed_months BETWEEN 1 AND 24)', 'specs JSONB', 'lead_time TEXT', 'valid_until DATE', 'responded_at TIMESTAMPTZ', 'response_note TEXT',
                       'paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0', "payments JSONB NOT NULL DEFAULT '[]'::jsonb", "progress JSONB NOT NULL DEFAULT '[]'::jsonb", 'received_by TEXT', 'pay_method TEXT', 'xendit_invoice_id TEXT', 'xendit_external_id TEXT',
                       'expiry_reminded_at TIMESTAMPTZ'])
        await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ' + c);
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_requests_status_check' AND pg_get_constraintdef(oid) LIKE '%awaiting_details%') THEN
          ALTER TABLE quote_requests DROP CONSTRAINT IF EXISTS quote_requests_status_check;
          ALTER TABLE quote_requests ADD CONSTRAINT quote_requests_status_check CHECK (status IN ('new','quoted','accepted','declined','preparing','ready','completed','closed','pending_approval','awaiting_details'));
        END IF; END $$`);
      await pool.query(`CREATE TABLE IF NOT EXISTS stock_alerts (
        alert_id    BIGSERIAL PRIMARY KEY,
        user_id     INT NOT NULL REFERENCES users(user_id),
        product_id  INT NOT NULL REFERENCES products(product_id),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        notified_at TIMESTAMPTZ,
        UNIQUE (user_id, product_id))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS product_reviews (
        review_id     BIGSERIAL PRIMARY KEY,
        product_id    INT NOT NULL REFERENCES products(product_id),
        user_id       INT NOT NULL REFERENCES users(user_id),
        order_id      BIGINT NOT NULL,
        rating        SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        body          TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','hidden')),
        hidden_by     INT REFERENCES users(user_id),
        hidden_at     TIMESTAMPTZ,
        hidden_reason TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, product_id))`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews (product_id, status, created_at DESC)');
      console.log('[shop] quotes / reviews / stock alerts schema ready');
    } catch (err) { console.warn('[shop] could not prepare the quotes / reviews / stock alerts schema:', err.message); }
  })();
  const whenReady = (req, res, next) => { ready.then(() => next(), next); };
  ['/api/shop/quotes', '/api/shop/reviews', '/api/shop/my-reviews', '/api/shop/stock-alerts', '/api/finance/quotes', '/api/finance/reviews', '/api/pos/quotes']
    .forEach((p) => app.use(p, whenReady));

  /* ---------------- mail (never blocks or fails a request) ---------------- */
  async function send(to, subject, lines, tag) {
    try {
      if (!to) return;
      const text = lines.join('\n');
      const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">' +
        lines.map((l) => (l ? '<p style="margin:0 0 10px">' + esc(l) + '</p>' : '')).join('') + '</div>';
      const r = await mailer.sendMail({ to, subject, html, text, tag });
      if (!r.sent) console.warn(`[mail] "${subject}" not sent: ${r.reason}`);
    } catch (err) { console.error(`[mail] "${subject}" failed:`, err.message); }
  }
  const signoff = () => { const i = shopInfo() || {}; return ['', 'Triple E Metal Products', [i.phone, i.email].filter(Boolean).join(' \u00B7 ')]; };

  /* =====================================================
     1. Request a quote
     Flow:  customer (shop) or cashier (walk-in) sends a request  ->  status 'new'
            Finance replies with an amount, lead time and validity  ->  'quoted'
            customer accepts / declines (or asks for a new quote)    ->  'accepted' / 'declined' / back to 'new'
            accepted quote:  Finance records payments and moves it  ->  'preparing' -> 'ready' (Ready for Pickup / Out for Delivery)
                             -> 'completed' (Picked Up / Delivered; needs the receiver's name and the balance paid)
            Finance can close (cancel) a quote at any step before it is completed  ->  'closed'
  ===================================================== */
  /* WHAT TRIPLE E MAKES — and so the only things a custom quotation can ask for:
       Die-cast part     aluminum ADC12 / A380, made to the customer's specifications (size range or typed dimensions), counted in pcs / sets
       Forged part       brass C37700 / C36000, made to the customer's specifications, counted in pcs / sets
       Fitting / valve   forged brass, standard pipe sizes 1/4" to 2", no wall thickness, counted in pcs / sets / boxes
     The item type decides the material family; the material decides finish and wall thickness. Everything is in ONE table,
     QUOTE_OPTIONS.matrix[itemType][material], which the form downloads, so the page and readQuote() can never disagree.
     A ready-made catalog product (finished good) skips all of this: it is quoted in pcs, with the details of its product record. */
  const NA = 'Not applicable', NOT_SURE = 'Not sure (advise me)';
  const mm = (...n) => n.map((x) => x.toFixed(1) + ' mm');
  const ALU = ['Aluminum ADC12', 'Aluminum A380'], BRASS = ['Brass C37700', 'Brass C36000'];
  const PIPE_SIZES = ['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"'];
  // A part is made to order, so it has no catalog size. The dropdown offers size RANGES (by the longest side),
  // which is enough for a first price; "Exact dimensions" lets them type length x width x height instead.
  const PART_SIZES = ['Small: longest side up to 50 mm', 'Medium: 51 to 150 mm', 'Large: 151 to 300 mm', 'Extra large: 301 to 1000 mm'];
  const FINISH_ALU = ['Raw / Unfinished', 'Shot Blasted', 'Powder Coated', 'Painted', 'Chromate Conversion', 'Polished'];
  const FINISH_BRASS = ['Raw / Unfinished', 'Polished', 'Satin / Brushed', 'Nickel Plated', 'Chrome Plated'];
  const WALL_ALU = mm(1, 1.5, 2, 2.5, 3, 4, 5, 6), WALL_BRASS = mm(1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12);
  const SERVICE = ['None (as is)', 'Deburring', 'Drilling / tapping', 'CNC machining', 'Threading (BSP / NPT)'];
  const QUOTE_OPTIONS = {
    neededMaxMonths: 6,                                                      // "needed by" is a date: from tomorrow up to this many months from today
    units: ['pcs', 'sets', 'boxes'],
    decimalUnits: [],                                                        // every part is counted in whole pieces
    minQty: 20,                                                              // smallest custom run (a catalog product keeps its own minimum)
    material: ALU.concat(BRASS, [NOT_SURE]),
    size: PIPE_SIZES,                                                        // parts use size ranges or typed dimensions; only fittings have standard sizes
    thickness: [...new Set(WALL_ALU.concat(WALL_BRASS))].sort((a, b) => parseFloat(a) - parseFloat(b)).concat([NA]),
    finish: [...new Set(FINISH_ALU.concat(FINISH_BRASS))],
    service: SERVICE,
    customAllowed: ['size', 'thickness'],                                    // these two also accept a typed value ("Other...")
    // a typed wall thickness must sit inside what the process can make ('' = material not chosen / not sure)
    thicknessLimits: { 'Aluminum ADC12': { min: 1, max: 8 }, 'Aluminum A380': { min: 1, max: 8 }, 'Brass C37700': { min: 1, max: 20 }, 'Brass C36000': { min: 1, max: 20 }, '': { min: 1, max: 20 } },
    leadTimes: ['1 to 3 working days', '1 week', '2 weeks', '3 weeks', '1 month', '2 months', '3 months', '4 to 6 months'],
    // how many WORKING days (Mon-Fri) each lead time means, so the screens can show a real calendar date. Upper bound of the wording.
    leadWorkdays: { '1 to 3 working days': 3, '1 week': 5, '2 weeks': 10, '3 weeks': 15, '1 month': 22, '2 months': 44, '3 months': 66, '4 to 6 months': 132 },
    validDays: [3, 7, 14, 30],
    payMethods: ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Credit / debit card']
  };
  // per material: the finish / wall thickness it can take (Not sure has no rule: the item type's own list applies)
  const MATERIAL_FITS = {};
  ALU.forEach((m) => { MATERIAL_FITS[m] = { finish: FINISH_ALU, thickness: WALL_ALU.concat([NA]) }; });
  BRASS.forEach((m) => { MATERIAL_FITS[m] = { finish: FINISH_BRASS, thickness: WALL_BRASS.concat([NA]) }; });
  QUOTE_OPTIONS.rules = {};
  Object.keys(MATERIAL_FITS).forEach((m) => { QUOTE_OPTIONS.rules[m] = { finish: MATERIAL_FITS[m].finish, thickness: MATERIAL_FITS[m].thickness, service: SERVICE }; });
  // words in a product name / description that point at a material: a grade gives the exact material, a family word gives its name
  QUOTE_OPTIONS.families = [
    { label: 'die-cast aluminum', name: 'Aluminum', words: ['aluminum', 'aluminium', 'adc12', 'a380', 'die-cast', 'die cast', 'diecast'], materials: ALU, grades: { adc12: 'Aluminum ADC12', a380: 'Aluminum A380' } },
    { label: 'forged brass', name: 'Brass', words: ['brass', 'c37700', 'c36000', 'forged', 'forging'], materials: BRASS, grades: { c37700: 'Brass C37700', c36000: 'Brass C36000' } }
  ];
  QUOTE_OPTIONS.forms = [];
  QUOTE_OPTIONS.itemTypes = ['Die-cast part', 'Forged part', 'Fitting / valve'];
  // words in "Describe the item" that name the KIND of item, so the form can suggest the item type (brass valve -> Fitting / valve)
  QUOTE_OPTIONS.typeWords = {
    'Die-cast part': ['die-cast', 'die cast', 'diecast', 'casting', 'cast', 'housing', 'bracket', 'cover', 'enclosure'],
    'Forged part': ['forged', 'forging', 'forge'],
    'Fitting / valve': ['valve', 'fitting', 'elbow', 'tee', 'coupling', 'nipple', 'union', 'bushing', 'adapter', 'adaptor', 'connector', 'reducer', 'plug', 'cap', 'faucet', 'tap', 'hose']
  };
  // words that only name HOW it is made: a fitting is forged too, so "forged brass valve" is a fitting. They count only when no other word matched.
  QUOTE_OPTIONS.processWords = ['forged', 'forging', 'forge', 'cast', 'casting'];
  QUOTE_OPTIONS.itemRules = {
    'Die-cast part':   { materials: ALU, sizes: PART_SIZES, typed: 'part', thickness: 'optional', finish: FINISH_ALU, wall: WALL_ALU, units: ['pcs', 'sets'], unit: 'pcs',
                         services: ['None (as is)', 'Deburring', 'Drilling / tapping', 'CNC machining'], label: 'a die-cast part', note: 'Aluminum, cast to order. Pick a size range, or type the exact dimensions.', thicknessFor2D: true },
    'Forged part':     { materials: BRASS, sizes: PART_SIZES, typed: 'part', thickness: 'optional', finish: FINISH_BRASS, wall: WALL_BRASS, units: ['pcs', 'sets'], unit: 'pcs',
                         services: SERVICE, label: 'a forged part', note: 'Brass, forged to order. Pick a size range, or type the exact dimensions.', thicknessFor2D: true },
    'Fitting / valve': { materials: BRASS, sizes: PIPE_SIZES, typed: 'pipe', thickness: 'none', finish: FINISH_BRASS, wall: [], units: ['pcs', 'sets', 'boxes'], unit: 'pcs',
                         services: ['None (as is)', 'Deburring', 'Drilling / tapping', 'Threading (BSP / NPT)'], label: 'a fitting or valve', note: 'Forged brass, standard pipe sizes up to 2".' }
  };
  // typed sizes ("Other...") must look like the item: the client builds the same RegExp from these strings
  QUOTE_OPTIONS.typedSizes = {
    part: { pattern: /^(?:[Øø⌀]\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?){1,2})\s*(?:mm|cm|in|inch|inches|")$/i.source, flags: 'i',
            hint: 'the overall dimensions with the unit, e.g. 100 x 60 x 40 mm or Ø50 mm', maxMm: 1000 },
    pipe: { pattern: /^(\d+[-\s])?\d+(\/\d+|\.\d+)?\s*("|in|inch|inches|mm)$/i.source, flags: 'i', hint: 'the pipe size with its unit, e.g. 1 inch or 25 mm', maxIn: 2 }
  };
  // numbers inside a typed size, in mm ("1-1/4 in" -> 31.75)
  const sizeNumbersMm = (v) => {
    const unit = (/(mm|cm|inches|inch|in|")\s*$/i.exec(v) || [])[1] || 'mm', f = /^mm$/i.test(unit) ? 1 : /^cm$/i.test(unit) ? 10 : 25.4;
    return (v.replace(/(mm|cm|inches|inch|in|")\s*$/i, '').match(/\d+(?:[-\s]\d+\/\d+|\/\d+|\.\d+)?/g) || []).map((t) => {
      const mx = /^(\d+)[-\s](\d+)\/(\d+)$/.exec(t), fr = /^(\d+)\/(\d+)$/.exec(t);
      return (mx ? +mx[1] + mx[2] / mx[3] : fr ? fr[1] / fr[2] : +t) * f;
    });
  };
  const typedSizeProblem = (kind, v) => {
    const t = QUOTE_OPTIONS.typedSizes[kind];
    if (!t || !new RegExp(t.pattern, t.flags).test(v)) return 'Type ' + (t ? t.hint : 'the size');
    const n = sizeNumbersMm(v);
    if (n.some((x) => !(x > 0))) return 'Each dimension must be more than 0';
    if (t.maxMm && n.some((x) => x > t.maxMm)) return 'Parts larger than ' + t.maxMm + ' mm are quoted by our staff. Please call or visit us';
    if (t.maxIn && n.some((x) => x > t.maxIn * 25.4 + 0.01)) return 'Fittings are made up to ' + t.maxIn + '" (50 mm). Larger sizes are quoted by our staff';
    return '';
  };
  // what the dropdown may offer for one detail, given the item type and the material (either may be empty = not chosen yet)
  function allowedFor(key, material, itemType) {
    const t = QUOTE_OPTIONS.itemRules[itemType], fit = MATERIAL_FITS[material];
    if (key === 'material') return t ? t.materials.concat([NOT_SURE]) : QUOTE_OPTIONS.material;
    if (key === 'size') return t ? t.sizes : QUOTE_OPTIONS.size;
    if (key === 'service') return t ? t.services : SERVICE;
    if (key === 'finish') return fit ? fit.finish.filter((f) => !t || t.finish.includes(f)) : t ? t.finish : QUOTE_OPTIONS.finish;
    if (key === 'thickness') {
      if (t && t.thickness === 'none') return [NA];
      return fit ? fit.thickness : t ? t.wall.concat([NA]) : QUOTE_OPTIONS.thickness;
    }
    return QUOTE_OPTIONS[key] || [];
  }
  QUOTE_OPTIONS.matrix = {};
  QUOTE_OPTIONS.itemTypes.forEach((t) => {
    QUOTE_OPTIONS.matrix[t] = {};
    [''].concat(QUOTE_OPTIONS.itemRules[t].materials, [NOT_SURE]).forEach((m) => {
      const key = m === NOT_SURE ? '' : m;                 // "Not sure" keeps every choice of the item type, no more
      QUOTE_OPTIONS.matrix[t][m] = { size: allowedFor('size', key, t), thickness: allowedFor('thickness', key, t), finish: allowedFor('finish', key, t), service: allowedFor('service', key, t) };
    });
  });
  const listText = (a) => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];

  // the form needs today's earliest / latest "needed by" date too (Philippine time), so the options are built per request
  const quoteOptionsNow = () => ({ ...QUOTE_OPTIONS, neededMin: addDays(todayPH(), 1), neededMax: addMonthsISO(todayPH(), QUOTE_OPTIONS.neededMaxMonths) });
  // The same options, cut down to what the stock records can supply (Products > Raw Materials / Finishing Supplies).
  // A material with no raw-material item, or a finish whose supply is not in stock records, is not offered, so a quote can never ask for
  // something we cannot make. Add the item under Products and it appears here by itself. Falls back to the full list if the check fails.
  function fitOptions(base, inv) {
    const o = JSON.parse(JSON.stringify(base));
    const okM = (m) => m === NOT_SURE || m === '' || !!inv.materials[m], okF = (f) => !!inv.finishes[f];
    o.material = o.material.filter(okM); o.finish = o.finish.filter(okF);
    o.families.forEach((f) => { f.materials = f.materials.filter(okM); });
    Object.keys(o.rules).forEach((m) => { if (!okM(m)) delete o.rules[m]; else o.rules[m].finish = o.rules[m].finish.filter(okF); });
    Object.keys(o.itemRules).forEach((t) => { const r = o.itemRules[t]; r.materials = r.materials.filter(okM); r.finish = r.finish.filter(okF); });
    Object.keys(o.matrix).forEach((t) => Object.keys(o.matrix[t]).forEach((m) => {
      if (!okM(m)) { delete o.matrix[t][m]; return; }
      o.matrix[t][m].finish = o.matrix[t][m].finish.filter(okF);
    }));
    o.itemTypes = o.itemTypes.filter((t) => o.itemRules[t].materials.length);               // no stock record for any of its materials: not offered
    o.inventory = inv;
    return o;
  }
  async function stockFit(db) {
    const A = app.locals.quoteAutomation; if (!A || !A.inventoryFit) return null;
    try { await A.ready; return await A.inventoryFit(db || pool, QUOTE_OPTIONS.material.filter((m) => m !== NOT_SURE), QUOTE_OPTIONS.finish); }
    catch (e) { console.warn('[quote] stock records check failed:', e.message); return null; }
  }
  async function quoteOptionsFor(db) { const base = quoteOptionsNow(), inv = await stockFit(db); return inv ? fitOptions(base, inv) : base; }
  // the server-side twin of the form's filter: a custom item cannot ask for a material / finish that has no stock record
  async function assertInStockRecords(specs) {
    const inv = await stockFit(pool); if (!inv) return;
    const m = specs.material, f = specs.finish;
    if (m && m !== NOT_SURE && inv.materials[m] === null) throw bad('material', m + ' is not in our stock records right now. Choose another material, or call us so we can source it');
    if (f && inv.finishes[f] === null) throw bad('finish', f + ' is not available right now (we have no supply for it on record). Choose another finish, or call us');
  }
  // Walk-in (cashier) quotes are paid when the order is picked up / delivered, so accepting one sets this automatically.
  const payOnLabel = (f) => (f === 'Delivery' ? 'Pay on delivery' : 'Pay on pickup');
  const SPEC_LABEL = { material: 'Material', size: 'Size', thickness: 'Thickness', finish: 'Finish', service: 'Machining / secondary work' };
  const CUSTOM_RE = /^[\p{L}\p{N}\s.,x\u00D7\-"'\/()+*]+$/u;
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const addDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const addMonthsISO = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
  const dateStr = (d) => {                                                  // pg gives DATE columns as JS dates
    if (!d) return undefined;
    if (typeof d === 'string') return d.slice(0, 10);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };

  /* Estimated ready date. The clock starts when the customer accepts (responded_at); before that it is shown as "if accepted today".
     Weekends are skipped; holidays are not known, so it is an estimate, not a promise. */
  const addWorkdays = (iso, n) => { let d = new Date(iso + 'T00:00:00Z'), left = n; while (left > 0) { d = new Date(d.getTime() + 86400000); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; } return d.toISOString().slice(0, 10); };
  const phDay = (t) => (t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) : null);
  // lead_time is free TEXT in the database: quotes saved before the dropdown ("3-5 working days", "2 weeks") still get a date
  const leadWorkdaysOf = (t) => {
    if (QUOTE_OPTIONS.leadWorkdays[t] != null) return QUOTE_OPTIONS.leadWorkdays[t];
    const x = String(t || '').toLowerCase().match(/(\d+)(?:\s*(?:-|\u2013|to)\s*(\d+))?\s*(working\s*day|day|week|month)s?/);
    if (!x) return undefined;
    const n = Number(x[2] || x[1]);
    return /day/.test(x[3]) ? n : x[3] === 'week' ? n * 5 : n * 22;
  };
  const readyBy = (leadTime, startIso) => { const n = leadWorkdaysOf(leadTime); return n && startIso ? addWorkdays(startIso, n) : undefined; };
  const quoteReadyBy = (q) => {
    if (!q || !q.lead_time || ['declined', 'closed', 'new', 'pending_approval', 'awaiting_details'].includes(q.status)) return undefined;
    if (q.ready_by) return dateStr(q.ready_by);                         // a date was promised in the quote: it does not move when the customer accepts
    const started = ['accepted', 'preparing', 'ready', 'completed'].includes(q.status) && q.responded_at;
    return readyBy(q.lead_time, started ? phDay(q.responded_at) : todayPH());
  };
  app.locals.quoteReadyBy = quoteReadyBy;
  app.locals.readyBy = readyBy;
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const QFLOW = ['accepted', 'preparing', 'ready', 'completed'];             // what happens after the customer accepts
  const stepLabel = (st, f) => ({ new: 'Waiting for reply', quoted: 'Quote ready', accepted: 'Accepted', declined: 'Declined', preparing: 'Preparing',
    ready: f === 'Delivery' ? 'Out for Delivery' : 'Ready for Pickup', completed: f === 'Delivery' ? 'Delivered' : 'Picked Up', closed: 'Closed', pending_approval: 'Awaiting Finance approval', awaiting_details: 'Awaiting customer details' })[st] || st;
  const CLOSE_REASON_LABEL = { customer_cancelled: 'The customer cancelled or no longer needs it', no_response: 'The customer did not respond',
    price_not_agreed: 'The customer did not agree with the price', cannot_make: 'We cannot make this item or get the material', duplicate: 'Duplicate of another request', other: 'Other reason' };
  const quoteJson = (q) => {
    const validUntil = dateStr(q.valid_until), total = q.quoted_amount == null ? null : +q.quoted_amount, paid = +q.paid_amount || 0;
    const terms = (app.locals.paymentTerms || {}).quoteTerms ? app.locals.paymentTerms.quoteTerms(q) : null;
    const at = QFLOW.indexOf(q.status), next = at >= 0 && at < QFLOW.length - 1 ? QFLOW[at + 1] : null;
    const progress = [];
    if (at >= 0 && q.responded_at) progress.push({ status: 'accepted', label: 'Accepted', at: ms(q.responded_at) });
    (Array.isArray(q.progress) ? q.progress : []).forEach((e) => progress.push({ status: e.s, label: stepLabel(e.s, q.fulfillment), at: e.at, note: e.note || undefined }));
    return {
      id: q.quote_no, status: q.status, statusLabel: stepLabel(q.status, q.fulfillment), product: q.product_name || undefined, sku: q.product_sku || undefined,
      quantity: q.quantity, details: q.details, specs: q.specs || undefined,
      neededBy: dateStr(q.needed_by), neededMonths: q.needed_months || undefined,          // new requests have a date (neededBy); neededMonths only exists on requests made while the form asked for months
      flexibleDate: q.flexible_date === true || undefined, contactEmail: q.contact_email || undefined, company: q.company_name || undefined,
      fulfillment: q.fulfillment || undefined, area: q.area || undefined,
      payMethod: q.pay_method || undefined, payLater: /^Pay on /.test(q.pay_method || '') || undefined, payOnline: q.pay_method === 'Xendit' || undefined, payNow: ['accepted', 'preparing', 'ready'].includes(q.status) && q.quoted_amount != null && owedOn(q) > 0 ? owedOn(q) : undefined,
      proposedAmount: q.proposed_amount == null ? undefined : +q.proposed_amount, approvalReason: q.approval_reason || undefined,
      proposedLeadTime: q.proposed_lead_time || undefined, proposedValidDays: q.proposed_valid_days || undefined,
      proposedBy: q.proposed_by_name || undefined, proposedAt: ms(q.proposed_at) || undefined, financeNote: q.finance_note || undefined,
      suggestedAmount: q.suggested_amount == null ? undefined : +q.suggested_amount, suggestedCost: q.suggested_cost == null ? undefined : +q.suggested_cost,
      costStale: q.cost_stale_note || undefined,
      approvalCheck: q.approval_check || undefined, acceptCheck: q.accept_check || undefined, recipeEdited: Array.isArray(q.recipe) || undefined,
      closeReason: q.close_reason ? (CLOSE_REASON_LABEL[q.close_reason] || q.close_reason) : undefined, quotedAmount: total == null ? undefined : total, replyNote: q.reply_note || undefined,
      leadTime: q.lead_time || undefined, readyBy: dateStr(q.ready_by) || undefined, validUntil,
      estimatedReady: quoteReadyBy(q), readyFromAcceptance: ['accepted', 'preparing', 'ready', 'completed'].includes(q.status) || undefined,
      lateForNeededBy: (() => { const r = quoteReadyBy(q), n = dateStr(q.needed_by); return !!(r && n && r > n) || undefined; })(),
      expired: q.status === 'quoted' && !!validUntil && validUntil < todayPH(),
      respondedAt: ms(q.responded_at), responseNote: q.response_note || undefined,
      paidAmount: paid, balance: total == null ? undefined : Math.max(0, round2(total - paid)),
      // derived by the payment ledger trigger, never by these screens
      paymentState: q.payment_state || (paid > 0 && total != null && paid >= total ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid'),
      terms: terms || undefined, dueNow: terms && terms.state === 'approved' && total != null && paid <= 0 ? terms.amount : undefined,
      payments: (Array.isArray(q.payments) ? q.payments : []).map((p) => ({ amount: p.amount, method: p.method, note: p.note || undefined, at: p.at })),
      progress, next: next || undefined, nextLabel: next ? stepLabel(next, q.fulfillment) : undefined, receivedBy: q.received_by || undefined,
      clarification: q.clarification || undefined, source: q.source || 'shop', createdAt: ms(q.created_at), updatedAt: ms(q.updated_at)
    };
  };
  const nc = () => app.locals.notifications;                                   // in-app notification center (fails soft)
  /* The payment terms block printed on a quotation (§2). Nothing is collected while a quote is still pending —
     these lines only tell the customer what will be due, when, and what the balance covers. */
  const termsLines = (q) => {
    const t = (app.locals.paymentTerms || {}).quoteTerms ? app.locals.paymentTerms.quoteTerms(q) : null;
    if (!t || t.state === 'proposed' || t.total == null) return [];
    const head = (t.key === 'full' || +t.percent >= 100)
      ? `Payment terms: Full Payment - ${peso(t.total)} before ${q.fulfillment === 'Delivery' ? 'delivery' : 'pickup'}`
      : `Payment terms: ${t.percent}% now (${peso(t.amount)}), balance ${peso(t.balance)} - ${t.condition || 'due before release'}`;
    const est = quoteReadyBy(q);
    return [head].concat(t.availability ? [`Estimated availability: ${t.availability}${est ? ' (about ' + needText(est) + ' if accepted today)' : ''}`] : []);
  };
  const pingFinance = (n) => (nc() ? nc().notifyRole('finance', n) : null);
  const pingUser = (id, n, role) => (nc() && id ? nc().notifyUser(id, n, role) : null);
  // what only staff may see (costs, the system price, why a price went to Finance) never goes to the customer
  const INTERNAL = ['suggestedAmount', 'suggestedCost', 'approvalCheck', 'acceptCheck', 'approvalReason', 'proposedAmount', 'proposedBy', 'proposedAt',
    'proposedLeadTime', 'proposedValidDays', 'financeNote', 'costStale', 'recipeEdited'];
  const customerJson = (q) => { const j = quoteJson(q); INTERNAL.forEach((k) => { delete j[k]; }); return j; };

  app.get('/api/shop/quote-options', auth('customer'), wrap(async (req, res) => res.json(await quoteOptionsFor())));
  // the cashier screen also needs Finance's approval rules, so it can say before confirming where a price will go
  app.get('/api/pos/quote-options', auth('cashier'), wrap(async (req, res) => res.json({ ...(await quoteOptionsFor()),
    approvalRules: app.locals.quoteAutomation ? await app.locals.quoteAutomation.settings() : null })));
  app.get('/api/finance/quote-options', auth('finance'), wrap(async (req, res) => res.json(await quoteOptionsFor())));

  // Checks a quote request body (shop customer or POS walk-in) and returns the clean values, or throws a field error.
  // Size and details that the product's own database record already states (Finance fills them in under the product's
  // online specifications). Same mapping as QuoteFields.autofill in quote-fields.js: Material, Size (or Dimensions), Thickness, Finish.
  const SPEC_ALIAS = { material: ['material'], size: ['size', 'dimensions'], thickness: ['thickness'], finish: ['finish'] };
  function productSpecs(shopSpecs) {
    const src = shopSpecs && typeof shopSpecs === 'object' && !Array.isArray(shopSpecs) ? shopSpecs : {}, out = {};
    const lower = {}; Object.keys(src).forEach((k) => { lower[k.trim().toLowerCase()] = str(src[k]); });
    Object.keys(SPEC_ALIAS).forEach((key) => { const hit = SPEC_ALIAS[key].map((a) => lower[a]).find(Boolean); if (hit) out[key] = hit.slice(0, 80); });
    return out;
  }
  // "Forged Brass Elbow" -> Brass, "Die-Cast Aluminum Heat Sink" -> Aluminum. Only when the name points at exactly one material.
  // the kind of item a catalog product is, read from its name the same way the form does (quote-fields.js):
  // "Forged Brass Gate Valve" -> Fitting / valve, "Die-Cast Pump Housing" -> Die-cast part. null when the name does not say.
  function itemTypeFromName(name) {
    const text = String(name || '').toLowerCase(), has = (w) => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(e?s)?(?![a-z0-9])', 'i').test(text);
    const fam = (QUOTE_OPTIONS.families || []).find((f) => f.words.some(has));
    const strong = (t) => (QUOTE_OPTIONS.typeWords[t] || []).filter((w) => !QUOTE_OPTIONS.processWords.includes(w)).some(has);
    let byWord = QUOTE_OPTIONS.itemTypes.filter(strong);
    if (!byWord.length) byWord = QUOTE_OPTIONS.itemTypes.filter((t) => (QUOTE_OPTIONS.typeWords[t] || []).some(has));
    const fits = QUOTE_OPTIONS.itemTypes.filter((t) => (!fam || QUOTE_OPTIONS.itemRules[t].materials.some((m) => fam.materials.includes(m))) && (!byWord.length || byWord.includes(t)));
    return fits.length === 1 ? fits[0] : null;
  }
  function materialFromName(name) {
    const text = String(name || '').toLowerCase();
    const fam = (QUOTE_OPTIONS.families || []).find((f) => f.words.some((w) => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)));
    if (!fam) return null;
    const g = Object.keys(fam.grades || {}).find((k) => text.includes(k));
    return g ? fam.grades[g] : fam.name;
  }
  // same delivery coverage as checkout and the POS (Finance > Delivery rates); a quote is not sent for an area we cannot deliver to
  async function mustDeliverTo(place, field) {
    const cover = app.locals.deliveryCoverage;
    if (!cover || (!place.region && !place.province)) return;
    const q = await cover(place);
    if (q && q.available === false) throw bad(field, `Sorry, we do not deliver to ${place.province || place.region} yet. Choose another area, or switch to Pickup`);
  }
  async function readQuote(b, { fallbackName, userId }) {
    const contactName = str(b.contactName) || fallbackName;
    if (!contactName) throw bad('contactName', 'Enter the customer\u2019s name');
    if (contactName.length < 2 || contactName.length > 80 || !NAME_RE.test(contactName)) throw bad('contactName', 'Enter your full name (letters only)');
    const phone = str(b.phone).replace(/[\s().-]/g, '');
    if (!phone) throw bad('phone', 'Enter your mobile number so we can reach you');
    if (!MOBILE_RE.test(phone)) throw bad('phone', 'Enter a valid mobile number, e.g. 0917 123 4567');
    // optional on the cashier's walk-in form: an email to send the written quote to, and the company the request is for
    const contactEmail = str(b.contactEmail).toLowerCase();
    if (contactEmail && (contactEmail.length > 120 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(contactEmail))) throw bad('contactEmail', 'Enter a valid email address, or leave it empty');
    const company = str(b.company).replace(/\s+/g, ' ');
    if (company.length > 80) throw bad('company', 'Keep the company name within 80 characters');

    // the product (or a described custom item)
    let sku = null, productName = str(b.productName).slice(0, 120) || null, productUnit = '', fromProduct = {};
    if (str(b.sku)) {
      const p = (await pool.query(`SELECT sku, name, unit, shop_specs FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [str(b.sku).toUpperCase()])).rows[0];
      if (!p) throw bad('sku', 'That product is not available');
      sku = p.sku; productName = p.name; productUnit = String(p.unit || '').toLowerCase(); fromProduct = productSpecs(p.shop_specs);
    } else if (!productName || productName.length < 3) throw bad('productName', 'Tell us what you need (at least 3 characters)');

    // a custom (non-catalog) item must say what KIND of item it is: that is what decides which sizes, thicknesses and units make sense
    let itemType = null, itemRule = null;
    if (!sku) {
      itemType = str(b.itemType);
      if (!QUOTE_OPTIONS.itemTypes.includes(itemType)) throw bad('itemType', 'Choose what kind of item you need: ' + listText(QUOTE_OPTIONS.itemTypes.map((t) => t.toLowerCase())));
      itemRule = QUOTE_OPTIONS.itemRules[itemType];
    }

    // amount required: a number plus a unit from the list (or the product's own unit)
    const raw = String(b.quantity == null ? '' : b.quantity).replace(/,/g, '').trim();
    const qty = Number(raw);
    if (!raw) throw bad('quantity', 'Enter how much you need');
    if (!Number.isFinite(qty) || qty <= 0) throw bad('quantity', 'Enter a number greater than 0');
    if (qty > 1000000 || Math.abs(Math.round(qty * 100) - qty * 100) > 1e-6) throw bad('quantity', 'Enter a quantity up to 1,000,000 with at most 2 decimals');
    const unit = str(b.quantityUnit).toLowerCase();
    if (sku) {
      // a catalog product is a finished good: always sold by the piece. The server decides, not the browser.
      if (unit !== 'pcs') throw bad('quantity', productName + ' is sold by pcs. Quote it in pcs' + (unit ? ', not in ' + unit : '') + '.');
    } else {
      if (!QUOTE_OPTIONS.units.includes(unit)) throw bad('quantity', 'Choose the unit: ' + listText(QUOTE_OPTIONS.units));
      if (!itemRule.units.includes(unit)) throw bad('quantity', itemType + ' is quoted in ' + listText(itemRule.units) + ', not in ' + unit + '.');
    }
    if (!QUOTE_OPTIONS.decimalUnits.includes(unit) && !Number.isInteger(qty)) throw bad('quantity', 'Use a whole number for ' + unit + ', e.g. 200');
    if (!sku && qty < QUOTE_OPTIONS.minQty) throw bad('quantity', 'The minimum order for a custom item is ' + QUOTE_OPTIONS.minQty + ' ' + unit + '.');
    const quantity = qty.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + unit;

    // needed by: a date from tomorrow up to 6 months from today (Philippine time), so nothing in the past or far away is accepted.
    // At the counter the cashier may tick "the date is flexible" when the walk-in customer has no deadline; an online account always picks a date.
    const flexibleDate = !userId && b.flexibleDate === true;
    const neededBy = str(b.neededBy), today = todayPH(), latest = addMonthsISO(today, QUOTE_OPTIONS.neededMaxMonths);
    if (!neededBy) { if (!flexibleDate) throw bad('neededBy', 'Choose the date you need it'); }
    else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || new Date(neededBy + 'T00:00:00Z').toISOString().slice(0, 10) !== neededBy) throw bad('neededBy', 'Choose a valid date');
      if (neededBy <= today) throw bad('neededBy', 'Choose a date after today');
      if (neededBy > latest) throw bad('neededBy', 'Choose a date within the next ' + QUOTE_OPTIONS.neededMaxMonths + ' months');
    }

    // sizes and details: every one is a dropdown; size and thickness can also be typed in
    const inSpecs = b.specs && typeof b.specs === 'object' && !Array.isArray(b.specs) ? b.specs : {};
    const specs = {};
    for (const key of Object.keys(SPEC_LABEL)) {
      if (fromProduct[key]) { specs[key] = fromProduct[key]; continue; }   // the product record decides; whatever the browser sent is ignored
      // A catalog product is a ready-made finished good: nothing is chosen or customised. Anything its record does not state is saved as
      // "Not specified" (the material is read from the product name when it names one), and it is always sold as is. Same rule as the locked form.
      if (sku) {
        if (key === 'service') { specs[key] = 'None (as is)'; continue; }
        const named = key === 'material' && materialFromName(productName);
        if (named) { specs[key] = named; continue; }
        specs[key] = 'Not specified';
        continue;
      }
      const v = str(inSpecs[key]);
      if (!v) throw bad(key, 'Choose the ' + SPEC_LABEL[key].toLowerCase());
      const label = SPEC_LABEL[key].toLowerCase(), mat = specs.material, allowed = allowedFor(key, mat, itemType);   // material comes first in SPEC_LABEL
      if (!allowed.includes(v)) {
        const master = (QUOTE_OPTIONS[key] || []).includes(v);
        if (key === 'material') {
          if (!master) throw bad(key, 'Choose the material from the list (' + listText(itemRule.materials) + ')');
          throw bad(key, v + ' is not used for ' + itemRule.label + '. Choose ' + listText(itemRule.materials));
        }
        if (key === 'size') {                                            // standard sizes of that item, or a typed one that looks like it
          if (master || v === NA) throw bad(key, 'That size does not go with ' + itemRule.label + '. ' + (itemRule.typed === 'pipe' ? 'Choose ' + itemRule.sizes[0] + ' to ' + itemRule.sizes[itemRule.sizes.length - 1] + ', or type ' : 'Choose a size range, or type ') + QUOTE_OPTIONS.typedSizes[itemRule.typed].hint);
          const why = v.length < 2 || v.length > 40 || !CUSTOM_RE.test(v) ? 'Type ' + QUOTE_OPTIONS.typedSizes[itemRule.typed].hint : typedSizeProblem(itemRule.typed, v);
          if (why) throw bad(key, why);
        } else if (key === 'thickness') {
          if (itemRule.thickness === 'none') throw bad(key, itemType + ' has no wall thickness. Choose Not applicable');
          const lim = QUOTE_OPTIONS.thicknessLimits[mat] || QUOTE_OPTIONS.thicknessLimits[''];
          if (master) throw bad(key, 'That thickness is not offered for ' + (MATERIAL_FITS[mat] ? mat : itemRule.label) + '. Choose one from the list, or type ' + lim.min + ' to ' + lim.max + ' mm');
          const tm = /^(\d+(?:\.\d+)?)\s*mm$/i.exec(v);
          if (!tm) throw bad(key, 'Type the thickness in mm, e.g. 2.5 mm');
          if (+tm[1] < lim.min || +tm[1] > lim.max) throw bad(key, (MATERIAL_FITS[mat] ? mat : 'These parts') + ' can be made ' + lim.min + ' to ' + lim.max + ' mm thick. Type a thickness in that range');
        } else {                                                          // finish / secondary work: list only
          if (!master) throw bad(key, 'Choose the ' + label + ' from the list');
          if (key === 'finish' && MATERIAL_FITS[mat] && !MATERIAL_FITS[mat].finish.includes(v)) throw bad(key, v + ' is not offered for ' + mat + '. Choose one from the list');
          throw bad(key, v + ' is not offered for ' + itemRule.label + '. Choose one from the list');
        }
      }
      specs[key] = v;
    }
    if (!sku) await assertInStockRecords(specs);                          // the material and finish must exist in the stock records
    // every detail the item type needs to be priced is required here, so the cashier never has to send the request back for it
    if (itemRule && itemRule.thicknessFor2D && !itemRule.sizes.includes(specs.size) && !/^[\u00D8\u00F8\u2300]/.test(specs.size) &&
        sizeNumbersMm(specs.size).length === 2 && !/^\d+(\.\d+)?\s*mm$/i.test(specs.thickness))
      throw bad('thickness', 'A size with only length and width needs the wall thickness too. Choose it, or type it in mm (e.g. 3 mm)');
    const notes = str(b.notes);
    if (notes.length > 1000) throw bad('notes', 'Please keep the extra notes under 1,000 characters');
    if (notes) specs.notes = notes;
    if (itemType) specs.itemType = itemType;
    const details = (itemType ? ['Item type: ' + itemType] : []).concat(Object.keys(SPEC_LABEL).map((k) => SPEC_LABEL[k] + ': ' + specs[k]))
      .concat(flexibleDate && !neededBy ? ['Needed by: Flexible / whenever ready'] : [])
      .concat(notes ? ['Notes: ' + notes] : []).join('\n');

    // delivery or pickup is required; delivery needs an address (a saved one, or the city and barangay typed in)
    const fulfillment = str(b.fulfillment);
    if (!['Delivery', 'Pickup'].includes(fulfillment)) throw bad('fulfillment', 'Choose delivery or pickup');
    let area = null;
    if (fulfillment === 'Delivery') {
      if (userId && b.addressId !== undefined && b.addressId !== null && b.addressId !== '') {
        const id = Number(b.addressId);
        if (!Number.isInteger(id)) throw bad('address', 'Choose where it should be delivered');
        const a = (await pool.query('SELECT * FROM customer_addresses WHERE address_id = $1 AND user_id = $2', [id, userId])).rows[0];
        if (!a) throw bad('address', 'That saved address was not found. Please choose another');
        await mustDeliverTo({ region: a.region, province: a.province }, 'address');
        area = [a.address_line, a.barangay && (/^(brgy|barangay)/i.test(a.barangay) ? a.barangay : 'Brgy. ' + a.barangay), a.city, a.province, a.zip_code].filter(Boolean).join(', ');
      } else {
        const city = str(b.city), barangay = str(b.barangay), street = str(b.street), region = str(b.region), province = str(b.province);
        // the cashier's walk-in form picks Region > Province > City > Barangay from the address lists, so all four are required there;
        // the customer's quick "different area" box only types the city and barangay
        if (!userId || b.region !== undefined || b.province !== undefined) {
          if (region.length < 2 || region.length > 80) throw bad('region', 'Choose the region');
          if (province.length < 2 || province.length > 60 || !/\p{L}/u.test(province)) throw bad('province', 'Choose the province');
        }
        if (region || province) await mustDeliverTo({ region, province }, 'province');
        if (city.length < 2 || city.length > 60 || !/\p{L}/u.test(city)) throw bad('city', 'Enter the city or municipality');
        if (barangay.length < 2 || barangay.length > 60 || !/\p{L}/u.test(barangay)) throw bad('barangay', 'Enter the barangay');
        if (street && (street.length < 5 || street.length > 100)) throw bad('street', 'Enter the house no. and street (5 to 100 characters), or leave it empty');
        area = [street, /^(brgy|barangay)/i.test(barangay) ? barangay : 'Brgy. ' + barangay, city, province].filter(Boolean).join(', ');
      }
      area = area.slice(0, 250);
    }
    return { contactName, phone, quantity, details, specs, neededBy, fulfillment, area, sku, productName, contactEmail, company, flexibleDate, itemType };
  }

  const INSERT_COLS = 'contact_name, phone, product_sku, product_name, quantity, details, specs, needed_by, fulfillment, area, contact_email, company_name, flexible_date';
  const insertVals = (v) => [v.contactName, v.phone, v.sku, v.productName, v.quantity, v.details, JSON.stringify(v.specs), v.neededBy || null, v.fulfillment, v.area, v.contactEmail || null, v.company || null, v.flexibleDate === true];
  // "$2,$3,...": placeholders generated from INSERT_COLS so the column list and the values can never drift apart
  // (a hand-written list missed flexible_date and every walk-in quote failed with "Server error"). specs is cast to jsonb.
  const insertParams = (from) => INSERT_COLS.split(',').map((c, i) => '$' + (from + i) + (c.trim() === 'specs' ? '::jsonb' : '')).join(',');
  const financeTo = () => process.env.QUOTE_EMAIL || (shopInfo() || {}).email;
  const needText = (d) => !d ? 'Flexible / whenever ready' : new Date(d + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  app.post('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const v = await readQuote(req.body || {}, { fallbackName: req.user.name, userId: req.user.id });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE customer_id = $1 AND status = 'new'`, [req.user.id])).rows[0].n;
    if (open >= MAX_OPEN_QUOTES) throw bad('quote', `You already have ${open} requests waiting for an answer. Please wait for our reply first`);

    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, ${INSERT_COLS}) VALUES ($1,${insertParams(2)}) RETURNING *`,
        [req.user.id, ...insertVals(v)]);
      await audit(client, req.user, 'Record added', `Quote request ${r.rows[0].quote_no}${v.productName ? ' \u2014 ' + v.productName : ''} (${v.quantity})`);
      return r.rows[0];
    });
    res.status(201).json(customerJson(row));

    // email: a copy to the customer and a heads-up to Finance (fire-and-forget)
    (async () => {
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [req.user.id])).rows[0];
      await send(u && u.email, `We received your quote request ${row.quote_no}`, [
        `Hi ${v.contactName},`, `Thank you for your request. We will send you a quote soon.`, '',
        `Reference: ${row.quote_no}`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`, `Needed by: ${needText(v.neededBy)}`, ...signoff()], 'quote-received');
      const to = financeTo();
      if (to) await send(to, `New quote request ${row.quote_no} from ${v.contactName}`, [
        `Customer: ${v.contactName} (${v.phone})`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`,
        `Needed by: ${needText(v.neededBy)}`, `Receive by: ${v.fulfillment}${v.area ? ' \u00B7 ' + v.area : ''}`, '', v.details, '',
        `Open Finance > Quote Requests${baseUrl() ? ' at ' + baseUrl() + '/Finance_Inventory.html' : ''} to reply.`], 'quote-new');
      else console.warn('[shop] new quote request ' + row.quote_no + ' saved. Set QUOTE_EMAIL or SHOP_EMAIL in .env to get an email for each request');
    })().catch((e) => console.error('[mail] quote emails failed:', e.message));
  }));

  app.get('/api/shop/quotes', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM quote_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json((await latestClarifications(rows)).map(customerJson));
  }));

  /* After Finance replies, the customer (or the cashier for a walk-in) answers the quote:
       accept  -> status 'accepted'  (Finance is told and follows up on payment / pickup / delivery)
       decline -> status 'declined'
       renew   -> status 'new'       (the price expired or no longer fits: ask Finance for a fresh quote) */
  async function respondToQuote(req, res, { where, params, who, autoPay }) {
    const action = str((req.body || {}).action), note = str((req.body || {}).note);
    if (!['accept', 'decline', 'renew'].includes(action)) throw bad('action', 'Choose accept, decline or ask for a new quote');
    if (note.length > 500) throw bad('note', 'Please keep the note under 500 characters');
    const next = { accept: 'accepted', decline: 'declined', renew: 'new' }[action];
    // accepting a quote needs a payment method: the online customer chooses one, the cashier's walk-in quote is automatically pay on pickup
    const chosen = str((req.body || {}).payMethod);                      // 'online' (Xendit) or 'cod' (pay on pickup / cash on delivery)
    if (action === 'accept' && !autoPay && !['online', 'cod'].includes(chosen)) throw bad('payMethod', 'Choose how you will pay: online or on pickup / delivery');
    const q = await tx(async (client) => {
      const cur = (await client.query(`SELECT * FROM quote_requests WHERE quote_no = $1 AND ${where} FOR UPDATE`, [req.params.no, ...params])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (cur.status !== 'quoted') throw bad('status', cur.status === 'new' ? 'This request has not been answered yet' : 'This quote was already answered or closed');
      const vu = dateStr(cur.valid_until);
      if (action === 'accept' && vu && vu < todayPH()) throw bad('status', 'This quote has expired. Ask for a new quote instead');
      if (action === 'accept' && !autoPay && chosen === 'cod' && app.locals.paymentTerms) {
        const due = app.locals.paymentTerms.approvedDueOf(cur);          // an approved down payment is paid online first; only the balance is paid on delivery / pickup
        if (due && +due.amount > 0) throw bad('payMethod', 'Your payment terms need ' + peso(due.amount) + ' paid first. Choose Pay online for that amount; the balance of ' + peso(round2(+cur.quoted_amount - +due.amount)) + ' is paid on ' + (cur.fulfillment === 'Delivery' ? 'delivery' : 'pickup') + '.');
      }
      const payMethod = action === 'accept' ? (autoPay || chosen === 'cod' ? payOnLabel(cur.fulfillment) : 'Xendit') : null;
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, responded_at = now(), response_note = $3, pay_method = COALESCE($4, pay_method), updated_at = now() WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, next, note || null, payMethod]);
      // Accepting covers the payment terms printed on the quote, so they are stamped as seen with the acceptance.
      if (action === 'accept' && app.locals.paymentTerms) await app.locals.paymentTerms.markTermsSeen(client, cur.quote_id);
      await audit(client, req.user, 'Record edited', `Quote request ${cur.quote_no} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'sent back for a new quote'} by ${who}`);
      // on acceptance the cost and stock are checked again at today's prices, the job order draft and any purchase suggestions are made
      const check = action === 'accept' && app.locals.quoteAutomation ? await app.locals.quoteAutomation.onAccept(client, r.rows[0], req.user) : null;
      return Object.assign(r.rows[0], { check });
    });
    const check = q.check; delete q.check;
    let checkoutUrl, payError;
    if (action === 'accept' && q.pay_method === 'Xendit') {                // start the online payment right away; if it cannot start, the customer can tap Pay now later
      try { checkoutUrl = await quoteCheckoutUrl(q); } catch (e) { payError = 'Online payment could not be started right now. Tap Pay now on your quote to try again.'; console.warn('[xendit] quote checkout failed:', e.message); }
    }
    res.json({ ok: true, status: q.status, checkoutUrl, payError });
    if (action === 'accept' && app.locals.quoteAutomation) app.locals.quoteAutomation.afterAccept(q, check);
    if (action === 'accept' && checkoutUrl) sendPayLink(q, checkoutUrl);
    Promise.resolve(pingFinance({ category: 'orders', title: action === 'accept' ? 'Quote accepted' : action === 'decline' ? 'Quote declined' : 'New quote requested',
      body: `${q.contact_name} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'asked for a new quote on'} ${q.quote_no}` + (q.quoted_amount != null ? ' (' + peso(q.quoted_amount) + ')' : '') + (action === 'accept' && q.pay_method ? '. Payment: ' + q.pay_method : '') + '.',
      link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no })).catch(() => {});
    (async () => {
      const to = financeTo(); if (!to) return;
      const verb = action === 'accept' ? 'ACCEPTED' : action === 'decline' ? 'declined' : 'is asking for a new quote on';
      await send(to, `Quote ${q.quote_no} ${action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'needs a new quote'}`, [
        `${q.contact_name} (${q.phone}) ${verb} quote ${q.quote_no}.`, `Item: ${q.product_name || 'See details'} \u00B7 ${q.quantity}`,
        ...(q.quoted_amount != null ? [`Quoted amount: ${peso(q.quoted_amount)}`] : []), ...termsLines(q), ...(action === 'accept' && q.pay_method ? [`Payment method: ${q.pay_method}`] : []), ...(note ? ['', `Note: ${note}`] : []), '',
        action === 'accept' ? (/^Pay on /.test(q.pay_method || '') ? `Next: open Finance > Quote Requests and move it to Preparing. The customer pays on ${q.fulfillment === 'Delivery' ? 'delivery' : 'pickup'}; record the payment then.` : `The customer is paying online through Xendit. You will be notified when the payment arrives; then move it to Preparing.`) : 'Open Finance > Quote Requests to see it.'], 'quote-response');
    })().catch((e) => console.error('[mail] quote response failed:', e.message));
  }

  // Clarification is a separate auditable exchange: never overwrite original specs.
  const CLARIFY_FIELDS = ['dimensions','thickness','material','finish','quantity','other'];      // no reference drawings: the shop does not take them
  const clarificationJson = c => c && ({ id: c.clarification_id, fields: c.fields, message: c.message,
    responseDue: dateStr(c.response_due), status: c.status, response: c.response || undefined,
    submittedSpecs: c.submitted_specs || undefined, createdAt: ms(c.created_at), answeredAt: ms(c.answered_at) });
  async function latestClarifications(rows) {
    if (!rows.length) return rows;
    const ids = rows.map(q => q.quote_id);
    const { rows: cs } = await pool.query(`SELECT DISTINCT ON (quote_id) * FROM quote_clarifications
      WHERE quote_id = ANY($1::bigint[]) ORDER BY quote_id, created_at DESC`, [ids]);
    const byId = new Map(cs.map(c => [String(c.quote_id), clarificationJson(c)]));
    return rows.map(q => ({ ...q, clarification: byId.get(String(q.quote_id)) }));
  }
  // what each requested detail must look like when the customer answers (same rules as Shop_Customer.html)
  const CLARIFY_LABEL = { dimensions: 'dimensions', thickness: 'thickness', material: 'material', finish: 'finish', quantity: 'quantity' };
  function clarifyProblem(k, v) {
    if (!v) return 'Enter the ' + CLARIFY_LABEL[k] + ' the cashier asked for';
    if (k === 'dimensions' && !/\d/.test(v)) return 'Enter the dimensions with numbers and a unit, e.g. 100 x 60 x 40 mm';
    if (k === 'dimensions' && !/(mm|cm|m|in|inch|inches|ft|")\s*$/i.test(v)) return 'Add the unit to the dimensions, e.g. mm or inches';
    if (k === 'thickness' && !/^\d+(\.\d+)?\s*(mm|cm|in|")$/i.test(v)) return 'Enter the thickness as a number with its unit, e.g. 2.5 mm';
    if (k === 'quantity' && !/^\d[\d,]*(\.\d+)?\s*[a-z]*$/i.test(v)) return 'Enter the quantity as a number, e.g. 200 pcs';
    if ((k === 'material' || k === 'finish') && (v.length < 2 || !/[a-z]/i.test(v))) return 'Enter the ' + k + ' in words, e.g. ' + (k === 'material' ? 'Brass C37700' : 'Polished');
    return '';
  }
  app.post('/api/pos/quotes/:no/clarifications', auth('cashier'), wrap(async (req,res) => {
    const b = req.body || {};
    const fields = Array.isArray(b.fields) ? [...new Set(b.fields)] : [];
    if (!fields.length || fields.length > CLARIFY_FIELDS.length || fields.some(f => !CLARIFY_FIELDS.includes(f))) throw bad('fields','Select at least one valid specification');
    const message = str(b.message);
    if (message.length < 15 || message.length > 1000) throw bad('message','Explain the missing details in 15–1000 characters');
    const due = b.responseDue ? str(b.responseDue) : null;
    if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || !Number.isFinite(Date.parse(due)) || due < todayPH() || due > addMonthsISO(todayPH(), 6))) throw bad('responseDue','Choose a valid date within six months');
    const c = await tx(async client => {
      const q = (await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 FOR UPDATE',[req.params.no])).rows[0];
      if (!q) throw bad('id','Quotation not found');
      if (!['new','awaiting_details'].includes(q.status)) throw bad('status','Clarification is only available before quotation pricing');
      const existing = (await client.query("SELECT clarification_id FROM quote_clarifications WHERE quote_id=$1 AND status='awaiting_customer'",[q.quote_id])).rows[0];
      if (existing) throw bad('status','A clarification request is already awaiting the customer');
      if (!q.customer_id) throw bad('customer','Walk-in customers must be contacted directly; this action requires an online customer account');
      const row=(await client.query(`INSERT INTO quote_clarifications(quote_id,fields,message,response_due,created_by)
        VALUES($1,$2::jsonb,$3,$4,$5) RETURNING *`,[q.quote_id,JSON.stringify(fields),message,due,req.user.id])).rows[0];
      await client.query("UPDATE quote_requests SET status='awaiting_details', updated_at=now() WHERE quote_id=$1",[q.quote_id]);
      await audit(client,req.user,'Record edited',`Clarification requested for ${q.quote_no}`);
      return {row,customerId:q.customer_id,no:q.quote_no};
    });
    res.status(201).json({ok:true,clarification:clarificationJson(c.row)});
    Promise.resolve(pingUser(c.customerId,{category:'orders',title:'Quotation details needed',body:`Please provide missing specifications for ${c.no}.`,link:'Shop_Customer.html',entityType:'quote',entityId:c.no},'customer')).catch(()=>{});
  }));
  app.post('/api/shop/quotes/:no/clarifications/respond', auth('customer'), wrap(async(req,res)=>{
    const b=req.body||{}, response=str(b.response);
    const specs=b.specs && typeof b.specs==='object' && !Array.isArray(b.specs) ? b.specs : {};
    const allowed=['dimensions','thickness','material','finish','quantity','other'];
    if (Object.keys(specs).some(k=>!allowed.includes(k))) throw bad('specs','Unsupported specification field');
    for (const [key,val] of Object.entries(specs)) {
      if (typeof val!=='string' || val.length>200) throw bad('spec_'+key,`Enter a valid ${key} (maximum 200 characters)`);
      specs[key]=val.trim();
    }
    if (response.length > 1500) throw bad('response','Keep your note within 1500 characters');
    const result=await tx(async client=>{
      const q=(await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 AND customer_id=$2 FOR UPDATE',[req.params.no,req.user.id])).rows[0];
      if(!q) throw bad('id','Quotation not found');
      if(q.status!=='awaiting_details') throw bad('status','This quotation is not awaiting details');
      const c=(await client.query("SELECT * FROM quote_clarifications WHERE quote_id=$1 AND status='awaiting_customer' FOR UPDATE",[q.quote_id])).rows[0];
      if(!c) throw bad('status','There is no outstanding clarification');
      // the details the cashier asked for are required; the customer may also correct any OTHER detail while answering (optional)
      for (const k of Object.keys(specs)) if (!c.fields.includes(k) && specs[k]) { const why = clarifyProblem(k, specs[k]); if (why) throw bad('spec_' + k, why); }
      // every detail the cashier asked for is required, and must look like that kind of detail; "Other" is answered in the note
      for (const k of c.fields) {
        if (k === 'other' || k === 'drawing') {      // 'drawing' is no longer offered; a request made before is answered in the note like "other"
          if (response.length < 10) throw bad('response', 'The cashier asked for other details: explain them in at least 10 characters');
          continue;
        }
        const why = clarifyProblem(k, specs[k] || '');
        if (why) throw bad('spec_' + k, why);
      }
      if (!c.fields.includes('other') && !c.fields.includes('drawing') && response && response.length < 5) throw bad('response', 'Write at least 5 characters, or leave the note empty');
      // the answers go INTO the quotation (its specs, its details text and its quantity), so the cashier prices what the customer confirmed
      const given = {}; Object.keys(specs).forEach((k) => { if (specs[k]) given[k] = specs[k]; });
      const toSpec = { dimensions: 'size', thickness: 'thickness', material: 'material', finish: 'finish' };
      const nextSpecs = Object.assign({}, q.specs || {});
      let details = String(q.details || ''), quantity = q.quantity;
      for (const k of Object.keys(given)) {
        if (toSpec[k]) {
          const key = toSpec[k], label = SPEC_LABEL[key];
          nextSpecs[key] = given[k];
          const line = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + ': .*$', 'm');
          details = line.test(details) ? details.replace(line, label + ': ' + given[k]) : details + '\n' + label + ': ' + given[k];
        } else if (k === 'quantity') {
          const m = /^(\d[\d,]*)\s*([a-z]*)$/i.exec(given[k]), old = /([a-z]+)\s*$/i.exec(q.quantity || '');
          const n = m ? Number(m[1].replace(/,/g, '')) : NaN, unit = (m && m[2] ? m[2] : old ? old[1] : 'pcs').toLowerCase();
          if (!(n > 0) || !QUOTE_OPTIONS.units.includes(unit)) throw bad('spec_quantity', 'Enter the quantity as a whole number with pcs, sets or boxes, e.g. 200 pcs');
          if (!q.product_sku && n < QUOTE_OPTIONS.minQty) throw bad('spec_quantity', 'The minimum order for a custom item is ' + QUOTE_OPTIONS.minQty + ' ' + unit);
          quantity = n.toLocaleString('en-US') + ' ' + unit;
        }
      }
      const row=(await client.query(`UPDATE quote_clarifications SET status='answered',response=$2,submitted_specs=$3::jsonb,answered_at=now()
        WHERE clarification_id=$1 RETURNING *`,[c.clarification_id,response,JSON.stringify(given)])).rows[0];
      await client.query("UPDATE quote_requests SET status='new', specs=$2::jsonb, details=$3, quantity=$4, updated_at=now() WHERE quote_id=$1",
        [q.quote_id, JSON.stringify(nextSpecs), details, quantity]);
      await audit(client,req.user,'Record edited',`Customer clarified ${q.quote_no}` + (Object.keys(given).length ? ': ' + Object.keys(given).map((k) => k + ' = ' + given[k]).join(', ') : ''));
      return {row,no:q.quote_no};
    });
    res.json({ok:true,clarification:clarificationJson(result.row)});
    Promise.resolve(pingFinance({category:'orders',title:'Quotation clarification received',body:`Customer provided details for ${result.no}.`,link:'Finance_Inventory.html#quotes',entityType:'quote',entityId:result.no})).catch(()=>{});
  }));

  app.post('/api/shop/quotes/:no/respond', auth('customer'), wrap((req, res) => respondToQuote(req, res, { where: 'customer_id = $2', params: [req.user.id], who: 'the customer' })));

  /* ---- walk-in customers: the cashier logs the request, Finance prices it, the cashier tells the customer and records the answer ---- */
  const MAX_OPEN_POS_QUOTES = 50;
  app.post('/api/pos/quotes', auth('cashier'), wrap(async (req, res) => {
    const v = await readQuote(req.body || {}, { fallbackName: '', userId: null });
    const open = (await pool.query(`SELECT count(*)::int AS n FROM quote_requests WHERE source = 'pos' AND status = 'new'`)).rows[0].n;
    if (open >= MAX_OPEN_POS_QUOTES) throw bad('quote', 'There are too many walk-in requests waiting for Finance. Please ask Finance to answer them first');
    const row = await tx(async (client) => {
      const r = await client.query(
        `INSERT INTO quote_requests (customer_id, source, created_by, ${INSERT_COLS}) VALUES (NULL,'pos',$1,${insertParams(2)}) RETURNING *`,
        [req.user.id, ...insertVals(v)]);
      await audit(client, req.user, 'Record added', `Walk-in quote request ${r.rows[0].quote_no}${v.productName ? ' \u2014 ' + v.productName : ''} (${v.quantity}) for ${v.contactName}`);
      return r.rows[0];
    });
    res.status(201).json({ ...quoteJson(row), customer: row.contact_name, phone: row.phone });
    (async () => {
      const to = financeTo();
      if (!to) return;
      await send(to, `Walk-in quote request ${row.quote_no} from ${v.contactName}`, [
        `Walk-in customer: ${v.contactName} (${v.phone}) \u2014 logged at the counter by ${req.user.name || 'a cashier'}`, `Item: ${v.productName || 'See details'}`, `Quantity: ${v.quantity}`,
        `Needed by: ${needText(v.neededBy)}`, `Receive by: ${v.fulfillment}${v.area ? ' \u00B7 ' + v.area : ''}`, '', v.details, '',
        `This customer has no online account. Open Finance > Quote Requests to price it, then the cashier or Finance calls them.`], 'quote-new');
    })().catch((e) => console.error('[mail] walk-in quote email failed:', e.message));
  }));

  // everything logged at the counter, newest first, so any cashier can answer "did my quote come back?"
  app.get('/api/pos/quotes', auth('cashier'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT q.*, c.full_name AS created_by_name FROM quote_requests q LEFT JOIN users c ON c.user_id = q.created_by
        ORDER BY (q.status = 'quoted') DESC, q.created_at DESC LIMIT 150`);
    res.json((await latestClarifications(rows)).map((q) => ({ ...quoteJson(q), customer: q.contact_name, phone: q.phone, source: q.source, loggedBy: q.created_by_name || undefined })));
  }));

  app.post('/api/pos/quotes/:no/respond', auth('cashier'), wrap((req, res) => respondToQuote(req, res, { where: `source = 'pos'`, params: [], autoPay: true, who: 'the cashier (walk-in customer)' })));

  /* The cashier confirms a price; WHERE it goes is decided by quote-automation.js (routeQuote), never by the cashier:
       fully costed, within the tolerance band of the system price, at or above the minimum margin (never below cost), under the
       order-value limit, stock covers the quantity and no partial-payment terms waiting  ->  'quoted' straight away;
       anything else -> 'pending_approval' with the reason written by the system. Without the automatic checks it always goes to Finance.
     The limits are Finance's settings (Approval rules), not numbers in this file. */
  const TERM_NAMES = { full: 'Full Payment', half: 'Half Payment', down: 'Down Payment', custom: 'Custom partial payment' };
  const readPrice = (b) => {
    const raw = String(b.amount ?? '').trim();
    if (!/^(?:\d{1,9})(?:\.\d{1,2})?$/.test(raw)) throw bad('amount', 'Enter a positive peso amount with up to two decimal places');
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount <= 0) throw bad('amount', 'Enter a valid amount');
    const leadTime = str(b.leadTime), days = Number(b.validDays);
    if (!QUOTE_OPTIONS.leadTimes.includes(leadTime)) throw bad('leadTime', 'Select a valid preparation time');
    if (!QUOTE_OPTIONS.validDays.includes(days)) throw bad('validDays', 'Select a valid quotation period');
    const note = str(b.note);
    if (note.length > 1500) throw bad('note', 'Notes cannot exceed 1500 characters');
    return { amount, leadTime, days, note };
  };
  app.post('/api/pos/quotes/:no/price', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {}, v = readPrice(b), qa = app.locals.quoteAutomation;
    const termKey = str(b.termKey);
    if (termKey && !TERM_NAMES[termKey]) throw bad('termKey', 'Choose a payment term');
    if (qa) await qa.ready;
    const priced = await tx(async client => {
      let cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quotation not found');
      if (!['new','pending_approval'].includes(cur.status)) throw bad('status', 'Only new or pending quotations can be priced');
      // the recipe lines the cashier adjusted belong to this price: they are saved first, so the checks below use them
      if (qa && !cur.product_sku && b.recipe !== undefined) cur = await qa.saveRecipe(client, cur, b.recipe, req.user);
      // partial-payment terms go to Finance only when the system cannot sign them (payment-terms.js autoTermsCheck:
      // within Finance's automatic limit, allowed for this order type, customer owes nothing elsewhere); signed terms never do
      const pt = app.locals.paymentTerms;
      let partialKey = termKey ? (termKey !== 'full' ? termKey : null) : (cur.terms_key && cur.terms_key !== 'full' && cur.terms_state !== 'approved' ? cur.terms_key : null);
      if (partialKey && pt && pt.autoTermsCheck && (await pt.autoTermsCheck(client, cur, partialKey, v.amount)).ok) partialKey = null;
      let decision, draft = null;
      if (qa) {
        draft = await qa.draftForQuote(client, cur);
        decision = qa.route({ amount: v.amount, draft, settings: await qa.settings(client), terms: partialKey ? { key: partialKey, label: TERM_NAMES[partialKey] || partialKey } : null });
      } else decision = { route: 'pending_approval', rules: ['checks_unavailable'], key: 'checks_unavailable', numbers: { cashierTotal: v.amount },
        reasons: ['The automatic price checks are not available, so Finance approves this price'], summary: 'The automatic price checks are not available' };
      const toFinance = decision.route === 'pending_approval';
      const result = await client.query(`UPDATE quote_requests SET status=$2, proposed_amount=$3, proposed_lead_time=$4, proposed_valid_days=$5,
        approval_reason=$6, quoted_amount=CASE WHEN $2='quoted' THEN $3 ELSE quoted_amount END,
        lead_time=CASE WHEN $2='quoted' THEN $4 ELSE lead_time END,
        valid_until=CASE WHEN $2='quoted' THEN $7::date ELSE valid_until END,
        reply_note=CASE WHEN $2='quoted' THEN $8 ELSE reply_note END, handled_by=$9, updated_at=now(),
        proposed_by=$9, proposed_at=now(), finance_note=NULL, suggested_amount=$10, suggested_cost=$11,
        cost_stale_at=NULL, cost_stale_note=NULL, approval_check=$12::jsonb, approval_reminded_at=NULL, approval_escalated_at=NULL, expiry_reminded_at=NULL
        WHERE quote_id=$1 RETURNING *`, [cur.quote_id, decision.route, v.amount, v.leadTime, v.days,
          toFinance ? decision.reasons.join('; ') : null, addDays(todayPH(),v.days), v.note||null, req.user.id,
          draft && draft.ok ? draft.total : null, draft && draft.ok ? draft.costTotal : null, JSON.stringify(decision)]);
      if (qa) await qa.logDecision(client, { quote: cur, action: toFinance ? 'sent_to_finance' : 'auto_quoted', decision, user: req.user });
      else await audit(client, req.user, 'Record edited', `Cashier price for quote ${cur.quote_no} sent to Finance: ${decision.reasons[0]}`);
      // the chosen payment term goes on with the price, so the customer's "your quote is ready" message already carries it
      let row = result.rows[0], terms = null;
      if (termKey && pt && pt.attachTerms && termKey !== (row.terms_key || 'full') && !(Number(row.paid_amount) > 0)) {
        terms = await pt.attachTerms(client, row, { termKey }, req.user);
        row = terms.out;
      }
      return { row, terms, cur };
    });
    const q = priced.row;
    // Finance hears about terms the system could not sign; the customer hears about the terms in the "quote ready" message below
    if (priced.terms && app.locals.paymentTerms) app.locals.paymentTerms.afterTermsAttached(priced.cur, { ...priced.terms, out: { ...priced.terms.out, customer_id: null } });
    if (q.status === 'pending_approval') afterSentToFinance(q, req.user); else afterQuoted(q);
    const d = q.approval_check || {};
    res.json({ ok: true, status: q.status, quote: quoteJson(q), decision: { route: d.route, rules: d.rules, reasons: d.reasons, numbers: d.numbers, summary: d.summary } });
  }));
  // after the commit: who has to know
  function afterSentToFinance(q, user) {
    Promise.resolve(pingFinance({ category: 'orders', severity: 'warn', title: 'Quote price waiting for your approval',
      body: `${(user && user.name) || 'A cashier'} priced ${q.quote_no} at ${peso(q.proposed_amount)} for ${q.contact_name}. Reason: ${q.approval_reason || 'not given'}.`,
      link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qapprove:' + q.quote_no + ':' + Date.now() })).catch(() => {});
  }
  async function mailQuoted(q, intro) {
    const u = q.customer_id ? (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0] : null;
    await send(u && u.email, `Your quote ${q.quote_no} is ready`, [
      `Hi ${q.contact_name},`, intro || 'Here is our quote for your request.', '',
      `Item: ${q.product_name || 'See details'} \u00B7 ${q.quantity}`, `Quoted amount: ${peso(q.quoted_amount)}`, q.ready_by ? `Ready by: ${needText(dateStr(q.ready_by))}` : `Ready in: ${q.lead_time}${quoteReadyBy(q) ? ' (about ' + needText(quoteReadyBy(q)) + ' if you accept today)' : ''}`, `Price valid until: ${dateStr(q.valid_until)}`,
      ...termsLines(q),
      ...(q.reply_note ? ['', q.reply_note] : []), '',
      `To go ahead, open Request a Quote in your account and tap Accept${baseUrl() ? ' (' + baseUrl() + '/Shop_Customer.html)' : ''}. Accepting covers these payment terms too. You can also decline it or ask for a new quote there.`, ...signoff()], 'quote-reply');
  }
  // the customer hears about a ready price at once (a walk-in has no account: the cashier tells them at the counter or by phone)
  function afterQuoted(q, { refreshed } = {}) {
    if (!q.customer_id) return;
    Promise.resolve(pingUser(q.customer_id, { category: 'orders', title: refreshed ? 'Your quote was updated to today\u2019s prices' : 'Your quote is ready',
      body: `${q.quote_no}: ${peso(q.quoted_amount)}, valid until ${needText(dateStr(q.valid_until))}.`, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    mailQuoted(q, refreshed ? 'We refreshed your quote at today\u2019s material prices.' : null).catch((e) => console.error('[mail] quote ready failed:', e.message));
  }
  // Finance approves a waiting price (one tap, or in a batch with the same reason). Partial-payment terms that waited with it are signed too.
  async function approvePrice(client, cur, user, { batch } = {}) {
    if (cur.status !== 'pending_approval' || !cur.proposed_amount || !cur.proposed_lead_time || !cur.proposed_valid_days) throw bad('status','No pending price proposal');
    let row = (await client.query(`UPDATE quote_requests SET status='quoted', quoted_amount=proposed_amount,
      lead_time=proposed_lead_time,valid_until=$2::date,handled_by=$3,updated_at=now(),finance_note=NULL WHERE quote_id=$1 RETURNING *`,
      [cur.quote_id,addDays(todayPH(),cur.proposed_valid_days),user.id])).rows[0];
    if (cur.terms_key && cur.terms_key !== 'full' && cur.terms_state === 'proposed') {
      row = (await client.query('UPDATE quote_requests SET terms_state=$2, terms_decided_by=$3, terms_decided_at=now() WHERE quote_id=$1 RETURNING *', [cur.quote_id, 'approved', user.id])).rows[0] || row;
      await audit(client, user, 'Record edited', `Quote ${cur.quote_no}: payment terms approved with the price \u2014 ${cur.terms_percent}% now (${peso(cur.terms_amount)}), balance ${peso(cur.terms_balance)}`);
    }
    const ck = cur.approval_check || {}, qa = app.locals.quoteAutomation;
    if (qa) await qa.logDecision(client, { quote: cur, action: batch ? 'batch_approved' : 'approved', rules: ck.rules || [], user,
      numbers: ck.numbers || { cashierTotal: +cur.proposed_amount }, reason: (batch ? 'Approved in a batch for the same reason: ' : 'Approved by Finance: ') + (cur.approval_reason || 'no reason recorded') });
    else await audit(client, user, 'Record edited', `Finance approved quotation ${cur.quote_no}`);
    return row;
  }
  function afterApproved(q) {
    Promise.resolve(pingUser(q.proposed_by, { category: 'orders', title: 'Finance approved your price', body: `${q.quote_no}: ${peso(q.quoted_amount)} is approved. Tell ${q.contact_name} the price.`,
      link: 'POS_Cashier.html#quotes', entityType: 'quote', entityId: q.quote_no }, 'cashier')).catch(() => {});
    afterQuoted(q);
  }
  app.post('/api/finance/quotes/:no/approve-price', auth('finance'), wrap(async (req,res) => {
    const q = await tx(async client => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 FOR UPDATE',[req.params.no])).rows[0];
      if (!cur) throw bad('id','Quotation not found');
      return approvePrice(client, cur, req.user);
    });
    afterApproved(q);
    res.json({ok:true,quote:quoteJson(q)});
  }));
  /* Finance discount: a pick from fixed steps (never a typed price), capped by the order quantity AND by the minimum margin.
     The limit is worked out here, so the screen only shows what the server will accept.
     DISCOUNT_TIERS / DISCOUNT_STEPS are starting values: change them here to change the policy. */
  const DISCOUNT_TIERS = [{ min: 500, pct: 10 }, { min: 200, pct: 8 }, { min: 50, pct: 5 }, { min: 1, pct: 3 }];
  const DISCOUNT_STEPS = [1, 2, 3, 5, 8, 10];
  const qtyNumber = (t) => { const m = /^\s*([\d,.]+)/.exec(String(t || '')); const n = m ? Number(m[1].replace(/,/g, '')) : NaN; return Number.isFinite(n) && n > 0 ? n : 1; };
  async function discountOptions(cur) {
    const base = round2(+cur.proposed_amount), qty = qtyNumber(cur.quantity);
    const tier = (DISCOUNT_TIERS.find((t) => qty >= t.min) || { pct: 0 }).pct;
    const S = app.locals.quoteAutomation ? await app.locals.quoteAutomation.settings() : { minMarginPct: 0 };
    const cost = cur.suggested_cost == null ? null : +cur.suggested_cost;
    // lowest allowed price = cost plus the minimum margin (so never below cost)
    const floor = cost == null ? null : round2(cost / (1 - Math.min(+S.minMarginPct || 0, 99) / 100));
    const floorPct = floor == null ? 0 : Math.max(0, Math.floor((1 - floor / base) * 1000) / 10);
    const maxPct = Math.min(tier, floorPct);
    const why = cost == null ? 'This quote has no recorded cost, so a discount cannot be checked.'
      : maxPct <= 0 ? 'No discount possible: the price is already at the minimum margin (' + (+S.minMarginPct || 0) + '%).'
      : (floorPct < tier ? 'Limited by the minimum margin' : 'Limit for ' + qty + ' unit' + (qty === 1 ? '' : 's')) + ': up to ' + maxPct + '%.';
    return { base, qty, tierPct: tier, floorPct, maxPct, steps: DISCOUNT_STEPS.filter((x) => x <= maxPct), why };
  }
  const pendingPrice = async (no) => {
    const cur = (await pool.query('SELECT * FROM quote_requests WHERE quote_no=$1', [no])).rows[0];
    if (!cur) throw bad('id', 'Quotation not found');
    if (cur.status !== 'pending_approval' || !cur.proposed_amount) throw bad('status', 'Only a price waiting for approval can be discounted');
    return cur;
  };
  app.get('/api/finance/quotes/:no/discount-options', auth('finance'), wrap(async (req, res) => res.json(await discountOptions(await pendingPrice(req.params.no)))));
  app.post('/api/finance/quotes/:no/approve-discount', auth('finance'), wrap(async (req, res) => {
    const pct = Number((req.body || {}).pct);
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quotation not found');
      if (cur.status !== 'pending_approval' || !cur.proposed_amount) throw bad('status', 'No pending price proposal');
      const o = await discountOptions(cur);
      if (!o.steps.includes(pct)) throw bad('pct', o.maxPct > 0 ? 'Choose a discount of up to ' + o.maxPct + '% for this quantity' : o.why);
      const price = round2(o.base * (1 - pct / 100));
      // the new price and the part-payment amounts that go with it change together, then the normal approval runs in the same transaction
      const upd = (await client.query(`UPDATE quote_requests SET proposed_amount = $2::numeric,
          terms_amount  = CASE WHEN terms_key IS NOT NULL AND terms_key <> 'full' AND terms_percent IS NOT NULL THEN round($2::numeric * terms_percent / 100, 2) ELSE terms_amount END,
          terms_balance = CASE WHEN terms_key IS NOT NULL AND terms_key <> 'full' AND terms_percent IS NOT NULL THEN $2::numeric - round($2::numeric * terms_percent / 100, 2) ELSE terms_balance END,
          approval_reason = COALESCE(approval_reason || ' ', '') || $3 WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, price, `Finance discount ${pct}% for ${o.qty} unit(s): ${peso(o.base)} to ${peso(price)}.`])).rows[0];
      await audit(client, req.user, 'Record edited', `Quote ${cur.quote_no}: Finance gave a ${pct}% discount (${peso(o.base)} to ${peso(price)}) on ${o.qty} unit(s)`);
      return approvePrice(client, upd, req.user);
    });
    afterApproved(q);
    res.json({ ok: true, quote: quoteJson(q) });
  }));
  // Finance does not agree with the cashier's price: it goes back to the cashier with a note (the proposal stays on record)
  app.post('/api/finance/quotes/:no/return-price', auth('finance'), wrap(async (req, res) => {
    const note = str((req.body || {}).note).replace(/\s+/g, ' ');
    if (note.length < 10) throw bad('note', 'Tell the cashier what to change (at least 10 characters)');
    if (note.length > 500) throw bad('note', 'Keep the note within 500 characters');
    const q = await tx(async client => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no=$1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quotation not found');
      if (cur.status !== 'pending_approval') throw bad('status', 'Only a price waiting for approval can be sent back');
      const r = await client.query(`UPDATE quote_requests SET status='new', finance_note=$2, handled_by=$3, updated_at=now() WHERE quote_id=$1 RETURNING *`,
        [cur.quote_id, note, req.user.id]);
      const ck = cur.approval_check || {};
      if (app.locals.quoteAutomation) await app.locals.quoteAutomation.logDecision(client, { quote: cur, action: 'returned', rules: ck.rules || [], user: req.user,
        numbers: ck.numbers || { cashierTotal: +cur.proposed_amount }, reason: 'Sent back to the cashier: ' + note });
      else await audit(client, req.user, 'Record edited', `Finance sent the cashier price of ${cur.quote_no} back: ${note}`);
      return r.rows[0];
    });
    Promise.resolve(pingUser(q.proposed_by, { category: 'orders', severity: 'warn', title: 'Finance sent your price back', body: `${q.quote_no}: ${note}`,
      link: 'POS_Cashier.html#quotes', entityType: 'quote', entityId: q.quote_no }, 'cashier')).catch(() => {});
    res.json({ ok: true, quote: quoteJson(q) });
  }));

  app.get('/api/finance/quotes', auth('finance'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT q.*, u.email AS customer_email, h.full_name AS handled_by_name, d.full_name AS terms_decided_by_name,
              conv.order_no AS converted_order_no, pb.full_name AS proposed_by_name
         FROM quote_requests q LEFT JOIN users u ON u.user_id = q.customer_id LEFT JOIN users h ON h.user_id = q.handled_by
         LEFT JOIN users pb ON pb.user_id = q.proposed_by
         LEFT JOIN users d ON d.user_id = q.terms_decided_by
         LEFT JOIN orders conv ON conv.order_id = q.converted_order_id
        ORDER BY (q.status = 'pending_approval') DESC, (q.status IN ('new','accepted','preparing','ready')) DESC, q.created_at DESC LIMIT 300`);
    // recurring customers: for each price waiting for Finance, what this customer was last quoted for the same product (last-quote.js)
    let lastOf = () => null;
    if (rows.some((q) => q.status === 'pending_approval' && q.product_sku)) {
      try {
        const h = await pool.query(`SELECT quote_id, quote_no, customer_id, phone, product_sku, quantity, quoted_amount, suggested_cost, status, created_at
            FROM quote_requests WHERE product_sku IS NOT NULL AND quoted_amount IS NOT NULL AND status NOT IN ('new','awaiting_details','pending_approval')
            ORDER BY created_at DESC LIMIT 3000`);
        lastOf = (q) => require('./last-quote').lastQuoteFor(q, h.rows);
      } catch (err) { console.warn('[quotes] last-quote history skipped:', err.message); }   // the list must never fail because of a hint
    }
    // convertedOrder tells the Sales report that this quotation's money belongs to an order it already lists (§10)
    res.json(rows.map((q) => ({ ...quoteJson(q), productionOverride: q.production_override_by ? { by: q.production_override_name, note: q.production_override_note } : undefined, customer: q.contact_name, phone: q.phone, email: q.customer_email,
      handledBy: q.handled_by_name || undefined, convertedOrder: q.converted_order_no || undefined,
      lastQuote: (q.status === 'pending_approval' && lastOf(q)) || undefined })));
  }));

  // Finance: send the quote (amount is required), close a request, or reopen it
  // why a request is closed: Finance must pick one (and explain "Other"); the customer is told the reason
  const CLOSE_REASONS = {
    customer_cancelled: 'The customer cancelled or no longer needs it',
    no_response: 'The customer did not respond',
    price_not_agreed: 'The customer did not agree with the price',
    cannot_make: 'We cannot make this item or get the material',
    duplicate: 'Duplicate of another request',
    other: 'Other reason'
  };
  QUOTE_OPTIONS.closeReasons = Object.keys(CLOSE_REASONS).map((k) => ({ key: k, label: CLOSE_REASONS[k] }));
  app.post('/api/finance/quotes/:no', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const status = str(b.status), note = str(b.note), closeReason = str(b.closeReason);
    if (!['new', 'quoted', 'closed'].includes(status)) throw bad('status', 'Choose a status');
    if (status === 'closed') {
      if (!CLOSE_REASONS[closeReason]) throw bad('closeReason', 'Choose why this request is being closed');
      if (closeReason === 'other' && note.length < 10) throw bad('note', 'Explain the reason for closing (at least 10 characters)');
    }
    if (note.length > 1500) throw bad('note', 'The note is too long (max 1500 characters)');
    if (note && note.length < 5) throw bad('note', 'Write at least 5 characters, or leave the note empty');
    let amount = null, leadTime = null, validUntil = null, readyBy = null, plan = null;
    if (status === 'quoted') {
      const raw = String(b.amount == null ? '' : b.amount).replace(/[,\u20B1\s]/g, '');
      if (!raw) throw bad('amount', 'Enter the quoted amount');
      amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount greater than 0');
      amount = Math.round(amount * 100) / 100;
      if (b.readyBy || b.validUntil) {                  // the guided form: dates, checked against the system's own guidance (quote-form-guide.js)
        if (!app.locals.quoteGuide) throw bad('amount', 'The quote guide is not available');
        plan = await app.locals.quoteGuide.readPlan(pool, req.params.no, { amount, readyBy: str(b.readyBy), validUntil: str(b.validUntil), overrideReason: b.overrideReason });
        leadTime = plan.leadTime; validUntil = plan.validUntil; readyBy = plan.readyBy;
      } else {                                          // older screens that still send a wording + number of days
        leadTime = str(b.leadTime);
        if (!QUOTE_OPTIONS.leadTimes.includes(leadTime)) throw bad('leadTime', 'Choose how long it will take to make or prepare');
        const days = Number(b.validDays);
        if (!QUOTE_OPTIONS.validDays.includes(days)) throw bad('validDays', 'Choose how long the price is valid');
        validUntil = addDays(todayPH(), days);
      }
    }
    const q = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (cur.status === 'completed') throw bad('status', 'This quote is already completed and cannot be changed');
      if (status === 'quoted' && cur.status === 'pending_approval' && cur.proposed_amount) {   // a typed price may go up, never below what the discount rules allow
        const o = await discountOptions(cur), lowest = round2(o.base * (1 - o.maxPct / 100));
        if (amount < lowest) throw bad('amount', o.maxPct > 0 ? `The lowest price allowed here is ${peso(lowest)} (${o.maxPct}% below the cashier price). ${o.why}` : `This price cannot be lowered. ${o.why}`);
      }
      const started = ['preparing', 'ready'].includes(cur.status) || (cur.status === 'accepted' && +cur.paid_amount > 0);
      if (started && status !== 'closed') throw bad('status', 'Work or payment has already started on this quote. You can only move it forward or close it');
      if (status === 'closed' && +cur.paid_amount > 0 && note.length < 5) throw bad('note', 'Payments were received. Write a note about the refund or how it was settled');
      const quoting = status === 'quoted';
      const r = await client.query(
        `UPDATE quote_requests SET status = $2, reply_note = $3, quoted_amount = $4, lead_time = $5, valid_until = $6, handled_by = $7,
                ready_by = CASE WHEN $2 = 'quoted' THEN $9::date ELSE ready_by END,
                responded_at = CASE WHEN $2 IN ('quoted','new') THEN NULL ELSE responded_at END,
                response_note = CASE WHEN $2 IN ('quoted','new') THEN NULL ELSE response_note END,
                close_reason = CASE WHEN $2 = 'closed' THEN $8 ELSE NULL END, updated_at = now() WHERE quote_id = $1 RETURNING *`,
        [cur.quote_id, status, quoting ? (note || null) : (note || cur.reply_note), quoting ? amount : cur.quoted_amount,
         quoting ? leadTime : cur.lead_time, quoting ? validUntil : cur.valid_until, req.user.id, status === 'closed' ? closeReason : null, quoting ? readyBy : null]);
      if (plan && app.locals.quoteAutomation) await app.locals.quoteAutomation.logDecision(client, { quote: cur, action: 'finance_quoted', user: { id: req.user.id, name: req.user.name, roleLabel: 'Finance' },
        reason: plan.overrideReason ? 'Changed from the system guidance: ' + plan.overrideReason : 'Followed the system guidance', rules: plan.flags.map((f) => f.code),
        numbers: { cashierTotal: amount, systemTotal: plan.guide.price.ok ? plan.guide.price.suggested : null, costTotal: plan.guide.price.ok ? plan.guide.price.cost : null, readyBy, validUntil, flags: plan.flags.map((f) => f.text) } });
      await audit(client, req.user, 'Record edited', `Quote request ${cur.quote_no} marked ${status}${quoting ? ' (' + peso(amount) + ')' : ''}` +
        (status === 'closed' ? ` — reason: ${CLOSE_REASONS[closeReason]}${note ? ' (' + note + ')' : ''}` : ''));
      return r.rows[0];
    });
    res.json({ ok: true });
    if (status !== 'new') (async () => {
      if (!q.customer_id) return;                       // walk-in from the POS: the cashier / Finance tells them by phone
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      if (status === 'closed') {                        // the customer always learns why
        Promise.resolve(pingUser(q.customer_id, { category: 'orders', title: 'Quote request closed', body: `${q.quote_no} was closed: ${CLOSE_REASONS[q.close_reason] || 'closed by our staff'}.` + (note ? ' ' + note : ''),
          link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
        return send(u && u.email, `Your quote request ${q.quote_no} was closed`, [`Hi ${q.contact_name},`, `We closed your quote request ${q.quote_no}.`, '',
          'Reason: ' + (CLOSE_REASONS[q.close_reason] || 'closed by our staff'), ...(note ? [note] : []), '', 'You can send a new request any time from Request a Quote.', ...signoff()], 'quote-reply');
      }
      if (status === 'quoted') await mailQuoted(q);
      else await send(u && u.email, `Update on your quote request ${q.quote_no}`, [`Hi ${q.contact_name},`, 'We have an update on your quote request.', '', q.reply_note, ...signoff()], 'quote-reply');
    })().catch((e) => console.error('[mail] quote reply failed:', e.message));
  }));

  /* ---- after acceptance: payments and the pickup / delivery steps (Finance) ---- */
  const msgFor = (q, st) => {
    const f = q.fulfillment, bal = Math.max(0, round2(+q.quoted_amount - (+q.paid_amount || 0))), shop = (shopInfo() || {}).address;
    const owe = bal > 0 ? ` Balance to pay ${f === 'Delivery' ? 'on delivery' : 'at pickup'}: ${peso(bal)}.` : ' Your quote is fully paid.';
    if (st === 'preparing') return { title: 'We started on your order', body: `${q.quote_no} is now being prepared.${q.lead_time ? ' Estimated time: ' + q.lead_time + (quoteReadyBy(q) ? ', about ' + needText(quoteReadyBy(q)) : '') + '.' : ''}` };
    if (st === 'ready') return f === 'Delivery'
      ? { title: 'Your order is out for delivery', body: `${q.quote_no} is on its way${q.area ? ' to ' + q.area : ''}.${owe}` }
      : { title: 'Your order is ready for pickup', body: `${q.quote_no} is ready${shop ? ' at ' + shop : ' at our shop'}.${owe}` };
    return { title: f === 'Delivery' ? 'Your order was delivered' : 'Your order was picked up', body: `${q.quote_no} is complete. Thank you for ordering from Triple E Metal Products.` };
  };

  async function advanceQuote(client, cur, target, user, { note = '', receivedBy = '' } = {}) {
    const at = QFLOW.indexOf(cur.status);
    if (at < 0) throw bad('status', 'Only an accepted quote can move to the next step');
    const next = QFLOW[at + 1];
    if (!next) throw bad('status', 'This quote is already completed');
    if (target !== next) throw bad('status', `The next step is "${stepLabel(next, cur.fulfillment)}". Steps cannot be skipped or moved backwards`);
    // a custom item (no catalog product) is made with a job order: its materials must be issued before it can be ready
    if (next === 'ready' && !cur.product_sku && app.locals.jobOrders) {
      await app.locals.jobOrders.ready;
      // a draft job order (made automatically at acceptance) is only a plan: the materials must really be issued
      if (!(await client.query(`SELECT 1 FROM job_orders WHERE quote_id = $1 AND status <> 'draft'`, [cur.quote_id])).rowCount)
        throw bad('status', 'Issue the raw materials and finishing supplies for this custom item first (Job order), then mark it ready');
    }
    if (next === 'preparing') {
      const pt = app.locals.paymentTerms;
      if (!pt) throw bad('payment', 'Payment checks are unavailable. Production cannot start.');
      await pt.assertProduction(client, cur);
    }
    if (next === 'completed') {
      if (receivedBy.length < 2 || receivedBy.length > 80) throw bad('receivedBy', `Enter the name of the person who ${cur.fulfillment === 'Delivery' ? 'received' : 'picked up'} the order (2 to 80 characters)`);
      const owed = round2(+cur.quoted_amount - (+cur.paid_amount || 0));
      if (owed > 0.004) throw bad('payment', `The balance of ${peso(owed)} is not paid yet. Record the payment first`);
    }
    const entry = { s: next, at: Date.now(), note: [next === 'completed' ? 'Received by ' + receivedBy : '', note].filter(Boolean).join(' - ') || undefined };
    const r = await client.query(
      `UPDATE quote_requests SET status = $2, received_by = COALESCE($3, received_by), progress = COALESCE(progress, '[]'::jsonb) || $4::jsonb, handled_by = $5, updated_at = now()
        WHERE quote_id = $1 RETURNING *`,
      [cur.quote_id, next, next === 'completed' ? receivedBy : null, JSON.stringify([entry]), user.id]);
    await audit(client, user, 'Record edited', `Quote ${cur.quote_no} moved from ${stepLabel(cur.status, cur.fulfillment)} to ${stepLabel(next, cur.fulfillment)}` + (note ? ` (${note})` : ''));
    return r.rows[0];
  }
  // Preparing -> Ready -> Picked up / Delivered is the cashier's work (they hold the goods, the job order and the counter payment).
  // Finance approves, purchases, follows up money and cancels: it does not move the order along.
  for (const [base, role] of [['/api/pos', 'cashier']]) {
    app.post(base + '/quotes/:no/step', auth(role), wrap(async (req, res) => {
      const b = req.body || {};
      const target = str(b.status), note = str(b.note), receivedBy = str(b.receivedBy);
      if (note.length > 200) throw bad('note', 'The note must be 200 characters or fewer');
      const q = await tx(async (client) => {
        const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
        if (!cur) throw bad('id', 'Quote request not found');
        return advanceQuote(client, cur, target, req.user, { note, receivedBy });
      });
      res.json({ ok: true, status: q.status });
      afterStep(q);
    }));
  }
  // the customer (and, for a walk-in, the cashier who logged it) hears about every step
  function afterStep(q) {
    const m = msgFor(q, q.status);
    Promise.resolve(pingUser(q.customer_id, { category: 'delivery', title: m.title, body: m.body, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    if (q.source === 'pos') Promise.resolve(pingUser(q.created_by, { category: 'pos', title: 'Walk-in quote: ' + stepLabel(q.status, q.fulfillment), body: `${q.quote_no} for ${q.contact_name}. ` + (q.status === 'ready' ? 'Tell the customer it is ready.' : ''), link: 'POS_Cashier.html', entityType: 'quote', entityId: q.quote_no }, 'cashier')).catch(() => {});
    (async () => {
      if (!q.customer_id) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, `${m.title} (${q.quote_no})`, [`Hi ${q.contact_name},`, m.body, ...signoff()], 'quote-step');
    })().catch((e) => console.error('[mail] quote step failed:', e.message));
  }
  app.locals.quoteFlow = { approvePrice, afterApproved, afterQuoted, afterSentToFinance, advance: advanceQuote, afterStep, QFLOW };

  // the payment link goes to the customer as soon as they accept (in-app and email), so nobody sends it by hand
  function sendPayLink(q, url) {
    const due = owedOn(q), part = due > 0 && due < round2(+q.quoted_amount);
    const what = part ? 'down payment' : 'payment';
    Promise.resolve(pingUser(q.customer_id, { category: 'payment', title: `Pay the ${what} for ${q.quote_no}`,
      body: `${peso(due)} is due now${part ? ' (the balance is paid later, as the payment terms say)' : ''}. Open your quote and tap Pay now, or use the link we emailed you.`,
      link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    (async () => {
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send((u && u.email) || q.contact_email, `Payment link for your quote ${q.quote_no}`, [`Hi ${q.contact_name},`,
        `Thank you for accepting quote ${q.quote_no}. The ${what} due now is ${peso(due)}.`, `Pay online here (GCash, Maya, card or bank): ${url}`,
        part ? 'The balance is due later, as the payment terms on your quote say.' : '', ...signoff()], 'quote-paylink');
    })().catch((e) => console.error('[mail] quote payment link failed:', e.message));
  }

  // Finance records cash / transfer received against an accepted quote. The money itself is written to the
  // payment ledger (payment-terms.js), which owns quote_requests.paid_amount and payment_state through a trigger;
  // the payments JSONB array below stays only as the display copy the quotation screens already read.
  app.post('/api/finance/quotes/:no/payment', auth('finance'), wrap(async (req, res) => {
    const b = req.body || {};
    const method = str(b.method), note = str(b.note);
    let amount = decimalNumber(b.amount, { money: true });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount greater than 0');
    amount = round2(amount);
    if (!QUOTE_OPTIONS.payMethods.includes(method)) throw bad('method', 'Choose how it was paid');
    if (note.length > 100) throw bad('note', 'The note must be 100 characters or fewer');
    const pt = app.locals.paymentTerms;
    if (!pt) throw bad('ledger', 'The payment ledger is not available');
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (!['accepted', 'preparing', 'ready'].includes(cur.status)) throw bad('status', 'Payments can only be recorded on an accepted quote that is not completed yet');
      const paid = await pt.applyPayment(client, { kind: 'quote', no: cur.quote_no, amount, method, note, actor: req.user, requestId: str(b.requestId) || undefined });
      if (paid.replayed) return { cur, paid };
      const entry = { id: paid.paymentId, amount, method, note: note || undefined, at: Date.now() };
      const pays = (Array.isArray(cur.payments) ? cur.payments : []).concat([entry]);
      await client.query('UPDATE quote_requests SET payments = $2::jsonb, handled_by = $3, updated_at = now() WHERE quote_id = $1',
        [cur.quote_id, JSON.stringify(pays), req.user.id]);
      return { cur, paid };
    });
    const parent = out.paid.parent, q = out.cur;
    res.json({ ok: true, replayed: !!out.paid.replayed, paidAmount: parent.paid, balance: parent.balance, paymentState: parent.state,
      payments: (Array.isArray(q.payments) ? q.payments : []).concat(out.paid.replayed ? [] : [{ amount, method, note: note || undefined, at: Date.now() }]) });
    if (out.paid.replayed) return;
    const body = `Payment of ${peso(amount)} received for ${q.quote_no}. ` + (parent.balance > 0 ? `Balance: ${peso(parent.balance)}.` : 'Fully paid.');
    Promise.resolve(pingUser(q.customer_id, { category: 'payment', title: 'Payment received', body, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    (async () => {
      if (!q.customer_id) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, `Payment received for ${q.quote_no}`, [`Hi ${q.contact_name},`, body, ...signoff()], 'quote-payment');
    })().catch((e) => console.error('[mail] quote payment failed:', e.message));
  }));


  /* ---------- Paying an accepted quote ----------
     When the customer accepts they choose:  'online' -> Xendit (GCash, Maya, card, bank; the invoice is for the balance)
                                             'cod'    -> pay on pickup / cash on delivery (Finance records the cash when it is collected)
     An online payment is only trusted when it comes from Xendit itself (signed callback, or the server asking Xendit directly). */
  const xBase = 'https://api.xendit.co';
  async function xenditCall(url, opt = {}) {
    const key = process.env.XENDIT_SECRET_KEY;
    if (!key) throw new Error('Online payment is not set up yet');
    const r = await fetch(url, { method: opt.method || 'GET', headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'Content-Type': 'application/json' },
      body: opt.body ? JSON.stringify(opt.body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.message || 'Xendit request failed'); e.status = r.status; throw e; }
    return data;
  }
  /* What an online checkout should bill for this quote.
     With approved partial terms the first invoice is only the initial payment (a 50% or 30% down payment is not the
     whole order), and only once nothing has been paid yet. After that it is whatever balance is left. */
  const owedOn = (q) => {
    const bal = round2(+q.quoted_amount - (+q.paid_amount || 0));
    const pt = app.locals.paymentTerms;
    if (!pt || (+q.paid_amount || 0) > 0) return bal;
    const terms = pt.approvedDueOf(q);
    return terms && +terms.amount > 0 ? Math.min(bal, round2(+terms.amount)) : bal;
  };
  // returns the Xendit checkout link for what the customer still owes (re-uses a still-open invoice)
  async function quoteCheckoutUrl(q) {
    const owed = owedOn(q); if (!(owed > 0)) return null;
    if (q.xendit_invoice_id) {
      try { const ex = await xenditCall(`${xBase}/v2/invoices/${encodeURIComponent(q.xendit_invoice_id)}`);
        if (ex.status === 'PENDING' && ex.invoice_url && Number(ex.amount) === owed) return ex.invoice_url; } catch (_) { /* make a new one below */ }
    }
    const base = baseUrl(); if (!base) throw new Error('APP_BASE_URL is not set');
    const externalId = `triplee-quote-${q.quote_no}-${q.quote_id}-${Date.now()}`;
    const inv = await xenditCall(`${xBase}/v2/invoices`, { method: 'POST', body: {
      external_id: externalId, amount: owed, currency: 'PHP', description: `Triple-E Metal Products quote ${q.quote_no}`,
      success_redirect_url: `${base}/Shop_Customer.html?quotepay=return&quote=${encodeURIComponent(q.quote_no)}`,
      failure_redirect_url: `${base}/Shop_Customer.html?quotepay=failed&quote=${encodeURIComponent(q.quote_no)}`, invoice_duration: 86400 } });
    await pool.query('UPDATE quote_requests SET xendit_invoice_id = $2, xendit_external_id = $3 WHERE quote_id = $1', [q.quote_id, inv.id, externalId]);
    return inv.invoice_url;
  }
  // a paid Xendit invoice becomes a payment on the quote (once only: the invoice id is the ledger's provider reference,
  // so a retried callback re-reads the same row instead of adding money twice)
  async function applyQuoteInvoice(q, event, invoiceId) {
    if (!['PAID', 'SETTLED'].includes(String(event.status))) return null;
    const pt = app.locals.paymentTerms;
    if (!pt) { console.error('[xendit] the payment ledger module is not mounted — quote payment not recorded'); return null; }
    const amount = round2(Number(event.paid_amount != null ? event.paid_amount : event.amount));
    if (!(amount > 0)) return null;
    let done = null;
    await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_id = $1 FOR UPDATE', [q.quote_id])).rows[0];
      if (!cur) return;
      const paid = await pt.applyPayment(client, {
        kind: 'quote', id: cur.quote_id, amount, method: 'Xendit', providerRef: invoiceId, note: 'Paid online',
        actorName: 'Xendit Webhook',
        // money already captured online is recorded as it is, even if the quote was amended below it — Finance refunds the difference
        allowOver: true
      });
      if (paid.replayed) { done = null; return; }
      const pays = Array.isArray(cur.payments) ? cur.payments : [];
      await client.query('UPDATE quote_requests SET payments = $2::jsonb, updated_at = now() WHERE quote_id = $1',
        [cur.quote_id, JSON.stringify(pays.concat([{ id: paid.paymentId, amount, method: 'Xendit', note: 'Paid online', ref: invoiceId, at: Date.now() }]))]);
      done = { cur, parent: paid.parent, amount };
    });
    if (done) {
      const { cur: q2, parent, amount: amt } = done, bal = parent.balance;
      Promise.resolve(pingFinance({ category: 'payment', title: 'Quote paid online', body: `${q2.quote_no} — ${peso(amt)} received through Xendit.` + (bal > 0 ? ` Balance: ${peso(bal)}.` : parent.paid > parent.total ? ` Overpaid by ${peso(round2(parent.paid - parent.total))} — please refund.` : ' Fully paid.'),
        link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q2.quote_no })).catch(() => {});
      Promise.resolve(pingUser(q2.customer_id, { category: 'payment', title: 'Payment received', body: `Payment of ${peso(amt)} received for ${q2.quote_no}. ` + (bal > 0 ? `Balance: ${peso(bal)}.` : 'Fully paid. Thank you!'),
        link: 'Shop_Customer.html', entityType: 'quote', entityId: q2.quote_no }, 'customer')).catch(() => {});
    }
    return done;
  }
  const accepting = (q) => ['accepted', 'preparing', 'ready'].includes(q.status);
  app.post('/api/shop/quotes/:no/pay', auth('customer'), wrap(async (req, res) => {
    const q = (await pool.query('SELECT * FROM quote_requests WHERE quote_no = $1 AND customer_id = $2', [req.params.no, req.user.id])).rows[0];
    if (!q) throw bad('id', 'Quote request not found');
    if (!accepting(q)) throw bad('status', 'Only an accepted quote can be paid');
    // a customer who chose Pay on delivery / pickup can still pay online early (their choice stays as it is); only a quote with no method chosen cannot
    if (q.pay_method !== 'Xendit' && !/^Pay on /.test(q.pay_method || '')) throw bad('payment', 'Accept the quote and choose how to pay first');
    if (!(owedOn(q) > 0)) throw bad('payment', 'This quote is already fully paid');
    let url; try { url = await quoteCheckoutUrl(q); } catch (e) { console.warn('[xendit] quote checkout failed:', e.message); throw bad('payment', 'Online payment is not available right now. Please try again later or contact us'); }
    res.json({ checkoutUrl: url });
  }));
  // the customer's page calls this after paying: ask Xendit directly, so the payment is saved even if the callback never arrives
  app.post('/api/shop/quotes/:no/verify-payment', auth('customer'), wrap(async (req, res) => {
    const q = (await pool.query('SELECT * FROM quote_requests WHERE quote_no = $1 AND customer_id = $2', [req.params.no, req.user.id])).rows[0];
    if (!q) throw bad('id', 'Quote request not found');
    if (q.xendit_invoice_id && owedOn(q) > 0) {
      try { const inv = await xenditCall(`${xBase}/v2/invoices/${encodeURIComponent(q.xendit_invoice_id)}`); await applyQuoteInvoice(q, inv, q.xendit_invoice_id); }
      catch (e) { console.warn('[xendit] quote payment check failed:', e.message); }
    }
    const c = (await pool.query('SELECT paid_amount, quoted_amount FROM quote_requests WHERE quote_id = $1', [q.quote_id])).rows[0];
    res.json({ paidAmount: +c.paid_amount, balance: Math.max(0, owedOn(c)) });
  }));
  // called by the Xendit webhook in pos-shop.js; returns true when the invoice belonged to a quote
  app.locals.quoteXendit = { handle: async (event, externalId, invoiceId) => {
    const q = (await pool.query('SELECT * FROM quote_requests WHERE xendit_external_id = $1 AND xendit_invoice_id = $2 LIMIT 1', [externalId, invoiceId])).rows[0];
    if (!q) return false;
    await applyQuoteInvoice(q, event, invoiceId);
    return true;
  } };

  /* =====================================================
     2. Minimum order
  ===================================================== */
  // Manufacturing company: every sale (online shop AND the POS counter) has a minimum order. Finance sets it per product inside
  // MIN_ORDER_FLOOR..MIN_ORDER_CAP (default 20..50, overridable in .env); anything stored outside that range (old rows default to 1)
  // is treated as the nearest allowed value. The maximum is simply what is in stock, and the minimum never exceeds the stock,
  // so the last few units can still be bought.
  const MIN_ORDER_FLOOR = Number(process.env.MIN_ORDER_FLOOR) > 0 ? Number(process.env.MIN_ORDER_FLOOR) : 20;
  const MIN_ORDER_CAP = Number(process.env.MIN_ORDER_CAP) >= MIN_ORDER_FLOOR ? Number(process.env.MIN_ORDER_CAP) : Math.max(50, MIN_ORDER_FLOOR);
  const effectiveMin = (stored, onHand) => {
    const m = Math.min(MIN_ORDER_CAP, Math.max(MIN_ORDER_FLOOR, Number(stored) || MIN_ORDER_FLOOR));
    return Number(onHand) > 0 ? Math.min(m, Number(onHand)) : m;
  };
  // items = rows from loadSellable (product_id, name, unit, qty, on_hand).
  async function checkMinimums(client, items) {
    try {
      await ready;
      const { rows } = await client.query('SELECT product_id, min_order_qty FROM products WHERE product_id = ANY($1)', [items.map((i) => i.product_id)]);
      const min = new Map(rows.map((r) => [r.product_id, +r.min_order_qty]));
      for (const i of items) {
        const m = effectiveMin(min.get(i.product_id), i.on_hand);
        if (+i.qty < m) throw bad('items', `${i.name}: the minimum order is ${m} ${i.unit}`);
      }
    } catch (err) { if (err instanceof ValidationError) throw err; console.warn('[shop] minimum order check skipped:', err.message); }
  }

  /* =====================================================
     3. Back-in-stock alerts
  ===================================================== */
  app.get('/api/shop/stock-alerts', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.sku FROM stock_alerts a JOIN products p ON p.product_id = a.product_id WHERE a.user_id = $1 AND a.notified_at IS NULL`, [req.user.id]);
    res.json(rows.map((r) => r.sku));
  }));
  app.post('/api/shop/stock-alerts', auth('customer'), wrap(async (req, res) => {
    const p = (await pool.query(
      `SELECT product_id, name, on_hand FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived AND selling_price > 0 AND shop_visible = TRUE`,
      [str(req.body && req.body.sku).toUpperCase()])).rows[0];
    if (!p) throw bad('sku', 'That product is not available');
    if (+p.on_hand > 0) throw bad('sku', `${p.name} is in stock right now`);
    await pool.query(
      `INSERT INTO stock_alerts (user_id, product_id) VALUES ($1,$2)
       ON CONFLICT (user_id, product_id) DO UPDATE SET notified_at = NULL, created_at = now()`, [req.user.id, p.product_id]);
    res.status(201).json({ ok: true });
  }));
  app.delete('/api/shop/stock-alerts/:sku', auth('customer'), wrap(async (req, res) => {
    await pool.query(
      `DELETE FROM stock_alerts WHERE user_id = $1 AND product_id IN (SELECT product_id FROM products WHERE upper(sku) = $2)`,
      [req.user.id, String(req.params.sku).toUpperCase()]);
    res.json({ ok: true });
  }));

  // Claims every waiting alert whose product is available again (the UPDATE claims them, so two server instances never send twice).
  let lastCheck = 0, checking = false;
  async function checkAlerts() {
    if (checking) return;
    checking = true; lastCheck = Date.now();
    try {
      await ready;
      const { rows } = await pool.query(
        `UPDATE stock_alerts SET notified_at = now()
          WHERE alert_id IN (SELECT a.alert_id FROM stock_alerts a JOIN products p ON p.product_id = a.product_id
                              WHERE a.notified_at IS NULL AND p.on_hand > 0
                                AND NOT p.is_archived AND p.shop_visible FOR UPDATE OF a SKIP LOCKED)
        RETURNING user_id, product_id`);
      for (const r of rows) {
        const x = (await pool.query(
          `SELECT u.email, u.full_name, p.name, p.unit, p.selling_price FROM users u, products p WHERE u.user_id = $1 AND p.product_id = $2`,
          [r.user_id, r.product_id])).rows[0];
        if (x) await send(x.email, `${x.name} is back in stock`, [
          `Hi ${x.full_name},`, `Good news: ${x.name} is available again at ${peso(x.selling_price)} per ${x.unit}.`,
          'Stock can run out quickly, so order soon.', baseUrl() ? `Shop: ${baseUrl()}/Shop_Customer.html` : '', ...signoff()], 'back-in-stock');
      }
      if (rows.length) console.log(`[shop] sent ${rows.length} back-in-stock email(s)`);
    } catch (err) { console.warn('[shop] back-in-stock check failed:', err.message); }
    finally { checking = false; }
  }
  setInterval(checkAlerts, 60 * 1000).unref();   // also runs when the shop is opened (below), because Cloud Run may sleep between visits

  /* Quote about to expire: a quote the customer has not answered yet gets ONE reminder (in-app + email) when 2 days or
     fewer are left before its valid-until date, so fewer quotes lapse just because nobody looked. The row is marked in
     the same UPDATE that picks it, so two servers never send the same reminder twice. */
  async function remindExpiringQuotes() {
    await pool.query('ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS expiry_reminded_at TIMESTAMPTZ');
    const days = app.locals.quoteAutomation ? (await app.locals.quoteAutomation.settings()).expiryReminderDays : 2;
    const { rows } = await pool.query(`
      UPDATE quote_requests q SET expiry_reminded_at = now()
        FROM (SELECT q2.quote_id FROM quote_requests q2
               WHERE q2.status = 'quoted' AND q2.valid_until IS NOT NULL AND q2.expiry_reminded_at IS NULL
                 AND q2.valid_until >= (now() AT TIME ZONE 'Asia/Manila')::date
                 AND q2.valid_until <= (now() AT TIME ZONE 'Asia/Manila')::date + $1::int
               ORDER BY q2.quote_id LIMIT 100 FOR UPDATE SKIP LOCKED) pick
       WHERE q.quote_id = pick.quote_id
      RETURNING q.quote_id, q.quote_no, q.customer_id, q.contact_name, q.contact_email, q.product_name, q.quoted_amount, q.created_by, q.proposed_by, q.phone,
                to_char(q.valid_until, 'Mon DD, YYYY') AS until_s, (q.valid_until - (now() AT TIME ZONE 'Asia/Manila')::date) AS days_left`, [days]);
    for (const q of rows) {
      const left = +q.days_left === 0 ? 'today' : +q.days_left === 1 ? 'tomorrow' : 'in ' + q.days_left + ' days';
      if (!q.customer_id) await pingUser(q.proposed_by || q.created_by, { category: 'orders', severity: 'warn', title: 'Walk-in quote expires ' + left,
        body: `${q.quote_no} for ${q.contact_name} (${q.phone}, ${peso(q.quoted_amount)}) is valid until ${q.until_s}. Call the customer, or use "Refresh price" if costs changed.`,
        link: 'POS_Cashier.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'quote_expiry:' + q.quote_no }, 'cashier');
      const u = q.customer_id ? (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0] : null;
      if (q.customer_id) await pingUser(q.customer_id, { category: 'orders', title: 'Your quote expires ' + left,
        body: `${q.quote_no} for ${q.product_name || 'your request'} (${peso(q.quoted_amount)}) is valid until ${q.until_s}. Accept it in Request a Quote before then to keep this price.`,
        link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no, severity: 'warn', dedupeKey: 'quote_expiry:' + q.quote_no }, 'customer');
      await send((u && u.email) || q.contact_email, `Your quote ${q.quote_no} expires ${left}`, [
        `Hi ${q.contact_name},`, `Our quote ${q.quote_no} for ${q.product_name || 'your request'} (${peso(q.quoted_amount)}) is valid until ${q.until_s}.`,
        `To keep this price, open Request a Quote in your account and tap Accept${baseUrl() ? ' (' + baseUrl() + '/Shop_Customer.html)' : ''}. If you need changes, just reply to this email.`,
        ...signoff()], 'quote-expiry');
    }
    if (rows.length) console.log(`[auto] sent ${rows.length} quote expiry reminder(s)`);
    return { reminded: rows.length };
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'quote-expiry', run: remindExpiringQuotes });

  /* ---------- Who records a payment ----------
     Online (Xendit): nobody. The signed callback, or the server asking Xendit directly, records it.
     Pay on pickup / cash on delivery: the CASHIER who takes the money records it, and cash goes into that cashier's own open
     Cash Shift (so the drawer count adds up). Finance does not key payments in: it is told when money arrives and can send the
     customer or the cashier a reminder (below). If the customer chose online payment, the open Xendit link is checked first
     and closed before a counter payment is taken, so the same money can never be paid twice. */
  async function settleOnlineInvoice(q, { close } = {}) {
    if (!(q.xendit_invoice_id && process.env.XENDIT_SECRET_KEY)) return { state: 'none' };
    let inv; try { inv = await xenditCall(`${xBase}/v2/invoices/${encodeURIComponent(q.xendit_invoice_id)}`); } catch (e) { console.warn('[xendit] quote payment check failed:', e.message); return { state: 'unavailable' }; }
    const st = String(inv.status || '').toUpperCase();
    if (['PAID', 'SETTLED'].includes(st)) { await applyQuoteInvoice(q, inv, q.xendit_invoice_id); return { state: 'paid' }; }
    if (st === 'PENDING' && close) {
      try { await xenditCall(`${xBase}/invoices/${encodeURIComponent(q.xendit_invoice_id)}/expire!`, { method: 'POST', body: {} }); return { state: 'closed' }; }
      catch (e) { console.warn('[xendit] could not close the quote invoice:', e.message); return { state: 'unavailable' }; }
    }
    return { state: st === 'PENDING' ? 'pending' : 'expired' };
  }
  const quoteByNo = async (no) => (await pool.query('SELECT * FROM quote_requests WHERE quote_no = $1', [no])).rows[0];

  app.post('/api/pos/quotes/:no/payment', auth('cashier'), wrap(async (req, res) => {
    const b = req.body || {};
    const method = str(b.method), note = str(b.note);
    let amount = decimalNumber(b.amount, { money: true });
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw bad('amount', 'Enter a valid amount greater than 0');
    amount = round2(amount);
    if (!QUOTE_OPTIONS.payMethods.includes(method)) throw bad('method', 'Choose how it was paid');
    if (note.length > 100) throw bad('note', 'The note must be 100 characters or fewer');
    const reference = method === 'Cash' ? '' : str(b.reference);
    if (method !== 'Cash' && (reference.length < 4 || reference.length > 60)) throw bad('reference', 'Enter the reference from the app, receipt or statement (4 to 60 characters)');
    const pt = app.locals.paymentTerms; if (!pt) throw bad('ledger', 'The payment ledger is not available');
    const q0 = await quoteByNo(req.params.no);
    if (!q0) throw bad('id', 'Quote request not found');
    if (!accepting(q0)) throw bad('status', 'Payments can only be recorded on an accepted quote that is not completed yet');
    if (q0.pay_method === 'Xendit' && q0.xendit_invoice_id && round2(+q0.quoted_amount - (+q0.paid_amount || 0)) > 0.004) {
      const r = await settleOnlineInvoice(q0, { close: true });
      if (r.state === 'unavailable') throw bad('payment', 'The customer chose online payment and the payment link could not be checked right now. Try again in a minute so nobody is charged twice');
      if (r.state === 'paid') {
        const again = await quoteByNo(req.params.no);
        if (!(round2(+again.quoted_amount - (+again.paid_amount || 0)) > 0.004)) throw bad('payment', 'The customer already paid this online. Nothing is left to collect');
      }
    }
    const out = await tx(async (client) => {
      const cur = (await client.query('SELECT * FROM quote_requests WHERE quote_no = $1 FOR UPDATE', [req.params.no])).rows[0];
      if (!cur) throw bad('id', 'Quote request not found');
      if (!accepting(cur)) throw bad('status', 'Payments can only be recorded on an accepted quote that is not completed yet');
      let shiftId = null;
      if (method === 'Cash') {
        const shift = (await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id = $1 AND closed_at IS NULL FOR UPDATE', [req.user.id])).rows[0];
        if (!shift) throw bad('method', 'Open your Cash Shift before taking cash for this quote');
        shiftId = Number(shift.shift_id);
      }
      const paid = await pt.applyPayment(client, { kind: 'quote', no: cur.quote_no, amount, method, note, actor: req.user, requestId: str(b.requestId) || undefined,
        providerRef: reference || undefined, tendered: b.tendered, cashShiftId: shiftId });
      if (paid.replayed) return { cur, paid };
      const entry = { id: paid.paymentId, amount, method, note: note || undefined, ref: reference || undefined, by: req.user.name || undefined, at: Date.now() };
      await client.query('UPDATE quote_requests SET payments = $2::jsonb, updated_at = now() WHERE quote_id = $1',
        [cur.quote_id, JSON.stringify((Array.isArray(cur.payments) ? cur.payments : []).concat([entry]))]);
      return { cur, paid };
    });
    const parent = out.paid.parent, q = out.cur;
    res.json({ ok: true, replayed: !!out.paid.replayed, paymentId: out.paid.paymentId, paidAmount: parent.paid, balance: parent.balance, paymentState: parent.state,
      change: out.paid.change == null ? null : out.paid.change });
    if (out.paid.replayed) return;
    const body = `Payment of ${peso(amount)} received for ${q.quote_no} (${method}). ` + (parent.balance > 0 ? `Balance: ${peso(parent.balance)}.` : 'Fully paid. Thank you!');
    Promise.resolve(pingUser(q.customer_id, { category: 'payment', title: 'Payment received', body, link: 'Shop_Customer.html', entityType: 'quote', entityId: q.quote_no }, 'customer')).catch(() => {});
    Promise.resolve(pingFinance({ category: 'payment', title: 'Counter payment recorded on a quote', body: `${q.quote_no} — ${peso(amount)} (${method}) taken by ${req.user.name || 'the cashier'}. ` + (parent.balance > 0 ? `Balance ${peso(parent.balance)}.` : 'Fully paid.'),
      link: 'Finance_Inventory.html#quotes', entityType: 'quote', entityId: q.quote_no, dedupeKey: 'qpos_pay:' + out.paid.paymentId })).catch(() => {});
    (async () => {
      if (!q.customer_id) return;
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      await send(u && u.email, `Payment received for ${q.quote_no}`, [`Hi ${q.contact_name},`, body, ...signoff()], 'quote-payment');
    })().catch((e) => console.error('[mail] quote payment failed:', e.message));
  }));

  // "Check online payment": ask Xendit now instead of waiting for the callback (cashier at the counter, Finance on the quote)
  for (const [base, role] of [['/api/pos', 'cashier'], ['/api/finance', 'finance']]) {
    app.post(base + '/quotes/:no/check-payment', auth(role), wrap(async (req, res) => {
      const q = await quoteByNo(req.params.no);
      if (!q) throw bad('id', 'Quote request not found');
      const r = await settleOnlineInvoice(q);
      const c = await quoteByNo(req.params.no);
      res.json({ ok: true, online: q.pay_method === 'Xendit', state: r.state, paidAmount: +c.paid_amount, balance: Math.max(0, round2(+c.quoted_amount - (+c.paid_amount || 0))) });
    }));
  }

  /* ---------- Payment reminders (automatic, and by hand from Finance) ---------- */
  const pingCashiers = (n) => (nc() ? nc().notifyRole('cashier', n) : null);
  const readyAtOf = (q) => { const e = (Array.isArray(q.progress) ? q.progress : []).filter((x) => x && x.s === 'ready').pop(); return e && e.at ? +e.at : (q.updated_at ? new Date(q.updated_at).getTime() : null); };
  function reminderText(q, a) {
    const owe = peso(a.owed), where = q.fulfillment === 'Delivery' ? 'on delivery' : 'at pickup';
    if (a.kind === 'online') return { title: `Please pay for ${q.quote_no}`, severity: 'warn', body: `${owe} is due so we can start on your order. Open Request a Quote and tap Pay now (GCash, Maya, card or bank).` };
    if (a.kind === 'pickup') return { title: `Your order ${q.quote_no} is waiting`, severity: 'warn', body: `${q.quote_no} is ${q.fulfillment === 'Delivery' ? 'ready for delivery' : 'ready for pickup'}. ${owe} is still to be paid ${where}.` };
    if (a.kind === 'collect') return { title: `Collect ${owe} on ${q.quote_no}`, severity: a.n ? 'warn' : 'info',
      body: `${q.contact_name} (${q.phone}): ${q.quote_no} is ${q.fulfillment === 'Delivery' ? 'out for delivery' : 'ready for pickup'} and ${owe} is still unpaid. Collect it ${where}, then record it in Quote Desk > Collect payment.` };
    if (a.kind === 'online_stale') return { title: `${q.quote_no} accepted but unpaid`, severity: 'warn', body: `${q.contact_name} accepted ${q.quote_no} more than 3 days ago and has not paid ${owe} online. Remind them or close the quote.` };
    return { title: `${q.quote_no} ready but unpaid`, severity: 'error', body: `${q.quote_no} has been ready for over 7 days with ${owe} still unpaid. Ask the cashier to collect it, or decide what happens to the order.` };
  }
  /* sends one reminder; `bucket` makes the key unique per send for manual reminders. Returns 1 when it went out, 0 when the same one was already sent. */
  async function sendPaymentReminder(q, a, bucket) {
    const t = reminderText(q, a), key = a.key + ':' + q.quote_no + (bucket ? ':' + bucket : '');
    const base = { category: 'payment', severity: t.severity, title: t.title, body: t.body, entityType: 'quote', entityId: q.quote_no, dedupeKey: key };
    if (a.to === 'finance') return (await pingFinance(Object.assign(base, { link: 'Finance_Inventory.html#quotes' }))) ? 1 : 0;
    if (a.to === 'cashier') return (await pingCashiers(Object.assign(base, { link: 'POS_Cashier.html#quotes' }))) ? 1 : 0;
    if (!q.customer_id) return 0;
    const added = await pingUser(q.customer_id, Object.assign(base, { link: 'Shop_Customer.html' }), 'customer');
    if (!added) return 0;
    (async () => {
      const u = (await pool.query('SELECT email FROM users WHERE user_id = $1', [q.customer_id])).rows[0];
      let link = '';
      if (a.kind === 'online') { try { link = (await quoteCheckoutUrl(q)) || ''; } catch (_) { /* the in-app message still tells them to open the quote */ } }
      await send((u && u.email) || q.contact_email, t.title, [`Hi ${q.contact_name},`, t.body, ...(link ? [`Pay online here: ${link}`] : []), 'If you already paid, please ignore this message.', ...signoff()], 'quote-pay-reminder');
    })().catch((e) => console.error('[mail] quote payment reminder failed:', e.message));
    return 1;
  }
  async function remindQuotePayments() {
    const { rows } = await pool.query(`
      SELECT q.*, (q.customer_id IS NOT NULL) AS has_account FROM quote_requests q
       WHERE q.status IN ('accepted', 'ready') AND q.quoted_amount IS NOT NULL AND q.quoted_amount - COALESCE(q.paid_amount, 0) > 0.004
       ORDER BY q.quote_id LIMIT 300`);
    const now = Date.now(), out = { checked: rows.length, sent: 0 };
    for (const q of rows) {
      const plan = paymentReminderPlan({ status: q.status, pay_method: q.pay_method, quoted_amount: q.quoted_amount, paid_amount: q.paid_amount,
        accepted_at: q.responded_at ? new Date(q.responded_at).getTime() : null, ready_at: q.status === 'ready' ? readyAtOf(q) : null, has_account: q.has_account }, now);
      for (const a of plan) { try { out.sent += await sendPaymentReminder(q, a); } catch (e) { console.warn('[auto] payment reminder for ' + q.quote_no + ' failed:', e.message); } }
    }
    if (out.sent) console.log(`[auto] sent ${out.sent} quote payment reminder(s)`);
    return out;
  }
  (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'quote-payment-reminders', run: remindQuotePayments });

  // Finance: nudge the customer, or the cashier who collects, about money still owed on an accepted quote (at most once every 6 hours each)
  app.post('/api/finance/quotes/:no/remind', auth('finance'), wrap(async (req, res) => {
    const to = str((req.body || {}).to);
    if (!['customer', 'cashier'].includes(to)) throw bad('to', 'Choose who to remind: the customer or the cashier');
    const q = await quoteByNo(req.params.no);
    if (!q) throw bad('id', 'Quote request not found');
    const owed = round2(+q.quoted_amount - (+q.paid_amount || 0));
    if (!accepting(q) || !(owed > 0.004)) throw bad('payment', 'Nothing is waiting to be paid on this quote');
    if (to === 'customer' && !q.customer_id) throw bad('to', `This is a walk-in quote with no online account. Call the customer on ${q.phone || 'the number on the quote'}`);
    const kind = to === 'customer' ? (q.status === 'ready' ? 'pickup' : 'online') : 'collect';
    if (to === 'cashier' && q.status !== 'ready') throw bad('to', 'The cashier collects once the order is ready. Until then the customer is the one to remind');
    if (to === 'customer' && kind === 'online' && q.pay_method !== 'Xendit') throw bad('to', 'This customer pays at ' + (q.fulfillment === 'Delivery' ? 'delivery' : 'pickup') + '. Nothing is due yet');
    const bucket = 'm' + Math.floor(Date.now() / (6 * HOUR));
    const sent = await sendPaymentReminder(q, { to, kind, n: 0, key: 'qpay_manual:' + to, owed }, bucket);
    if (sent) await audit(pool, req.user, 'Record edited', `Quote ${q.quote_no}: payment reminder sent to the ${to} (${peso(owed)} owed)`);
    res.json({ ok: true, sent: !!sent, message: sent ? `Reminder sent to the ${to}.` : `The ${to} was already reminded in the last 6 hours.` });
  }));
  app.locals.quotePayments = { checkoutUrl: quoteCheckoutUrl, owedOn };

  /* =====================================================
     4. Reviews
  ===================================================== */
  const maskName = (n) => { const p = String(n || '').trim().split(/\s+/).filter(Boolean); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : (p[0] || 'Customer'); };
  const productBySku = async (sku) => (await pool.query(
    `SELECT product_id, sku, name FROM products WHERE upper(sku) = $1 AND department = 'Finished Goods' AND NOT is_archived`, [String(sku).toUpperCase()])).rows[0];
  // The order that lets this customer review this product: delivered / picked up, and it contains the product.
  const eligibleOrder = async (userId, productId) => (await pool.query(
    `SELECT o.order_id, o.order_no FROM orders o JOIN order_items i ON i.order_id = o.order_id
      WHERE o.customer_id = $1 AND i.product_id = $2 AND o.status = ANY($3)
      ORDER BY o.status_updated_at DESC NULLS LAST, o.order_id DESC LIMIT 1`, [userId, productId, FINAL_STATUS])).rows[0];

  app.get('/api/shop/my-reviews', auth('customer'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.sku, r.rating, r.status FROM product_reviews r JOIN products p ON p.product_id = r.product_id WHERE r.user_id = $1`, [req.user.id]);
    res.json(rows);
  }));

  app.get('/api/shop/reviews/:sku', auth('customer', 'finance'), wrap(async (req, res) => {
    const p = await productBySku(req.params.sku);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const [{ rows: list }, { rows: agg }] = await Promise.all([
      pool.query(`SELECT r.review_id, r.rating, r.body, r.created_at, r.user_id, u.full_name
                    FROM product_reviews r JOIN users u ON u.user_id = r.user_id
                   WHERE r.product_id = $1 AND r.status = 'visible' ORDER BY r.created_at DESC LIMIT 100`, [p.product_id]),
      pool.query(`SELECT rating, count(*)::int AS n FROM product_reviews WHERE product_id = $1 AND status = 'visible' GROUP BY rating`, [p.product_id])]);
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; let count = 0, sum = 0;
    for (const a of agg) { dist[a.rating] = a.n; count += a.n; sum += a.rating * a.n; }
    const out = {
      summary: { average: count ? Math.round((sum / count) * 10) / 10 : 0, count, distribution: dist },
      reviews: list.map((r) => ({ id: Number(r.review_id), rating: r.rating, body: r.body, author: maskName(r.full_name), createdAt: ms(r.created_at), mine: r.user_id === req.user.id })),
      canReview: false, reviewed: false
    };
    if (req.user.role === 'customer') {
      const mine = (await pool.query('SELECT status FROM product_reviews WHERE user_id = $1 AND product_id = $2', [req.user.id, p.product_id])).rows[0];
      out.reviewed = !!mine; out.myReviewHidden = !!mine && mine.status === 'hidden';
      out.canReview = !mine && !!(await eligibleOrder(req.user.id, p.product_id));
    }
    res.json(out);
  }));

  app.post('/api/shop/reviews', auth('customer'), wrap(async (req, res) => {
    const b = req.body || {};
    const p = await productBySku(str(b.sku));
    if (!p) throw bad('sku', 'Product not found');
    const rating = Number(b.rating), body = str(b.body);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('rating', 'Choose 1 to 5 stars');
    if (body.length > 1000) throw bad('body', 'Your review is too long (max 1000 characters)');
    const order = await eligibleOrder(req.user.id, p.product_id);
    if (!order) throw bad('sku', 'You can review a product after your order with it is Delivered or Picked Up');
    const r = await pool.query(
      `INSERT INTO product_reviews (product_id, user_id, order_id, rating, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, product_id) DO NOTHING RETURNING review_id`,
      [p.product_id, req.user.id, order.order_id, rating, body]);
    if (!r.rowCount) throw bad('sku', 'You have already reviewed this product');
    res.status(201).json({ ok: true });
  }));

  // Finance: see every review (visible and hidden), hide or restore one.
  app.get('/api/finance/reviews', auth('cashier'), wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.review_id, r.rating, r.body, r.status, r.created_at, r.hidden_at, r.hidden_reason, p.sku, p.name AS product, r.user_id, u.full_name, u.email, o.order_no, h.full_name AS hidden_by_name
         FROM product_reviews r JOIN products p ON p.product_id = r.product_id JOIN users u ON u.user_id = r.user_id
         LEFT JOIN orders o ON o.order_id = r.order_id LEFT JOIN users h ON h.user_id = r.hidden_by
        ORDER BY r.created_at DESC LIMIT 500`);
    res.json(rows.map((r) => ({ id: Number(r.review_id), rating: r.rating, body: r.body, status: r.status, product: r.product, sku: r.sku,
      customer: r.full_name, userId: Number(r.user_id), email: r.email, orderNo: r.order_no || undefined, createdAt: ms(r.created_at),
      hiddenAt: ms(r.hidden_at), hiddenReason: r.hidden_reason || undefined, hiddenBy: r.hidden_by_name || undefined })));
  }));
  app.post('/api/finance/reviews/:id/visibility', auth('cashier'), wrap(async (req, res) => {
    const hide = !!(req.body && req.body.hidden), reason = str(req.body && req.body.reason);
    if (hide && reason.length < 3) throw bad('reason', 'Write a short reason for hiding this review');
    if (reason.length > 300) throw bad('reason', 'The reason is too long (max 300 characters)');
    if (!/^\d{1,15}$/.test(req.params.id)) throw bad('id', 'Review not found');
    await tx(async (client) => {
      const r = await client.query(
        `UPDATE product_reviews SET status = $2, hidden_by = $3, hidden_at = $4, hidden_reason = $5 WHERE review_id = $1
         RETURNING review_id, product_id`,
        [req.params.id, hide ? 'hidden' : 'visible', hide ? req.user.id : null, hide ? new Date() : null, hide ? reason : null]);
      if (!r.rowCount) throw bad('id', 'Review not found');
      await audit(client, req.user, 'Record edited', `Review #${r.rows[0].review_id} ${hide ? 'hidden' : 'restored'}${hide ? ' \u2014 ' + reason : ''}`);
    });
    res.json({ ok: true });
  }));

  /* =====================================================
     Used by pos-shop.js: adds min order, rating and alert info to the shop catalog
  ===================================================== */
  async function decorate(rows, user) {
    if (user && Date.now() - lastCheck > 60 * 1000) checkAlerts();        // fire-and-forget
    try {
      await ready;
      const [ex, al] = await Promise.all([
        pool.query(`SELECT p.sku, p.min_order_qty, r.avg, r.cnt
                      FROM products p LEFT JOIN (SELECT product_id, ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*)::int AS cnt
                                                   FROM product_reviews WHERE status = 'visible' GROUP BY product_id) r ON r.product_id = p.product_id
                     WHERE p.department = 'Finished Goods'`),
        user ? pool.query(`SELECT p.sku, a.notified_at FROM stock_alerts a JOIN products p ON p.product_id = a.product_id WHERE a.user_id = $1`, [user.id]) : { rows: [] }]);
      const by = new Map(ex.rows.map((r) => [r.sku.toUpperCase(), r]));
      const alerts = new Map(al.rows.map((r) => [r.sku.toUpperCase(), r.notified_at]));
      for (const p of rows) {
        const k = String(p.sku).toUpperCase(), r = by.get(k), a = alerts.get(k);
        p.minOrder = effectiveMin(r ? r.min_order_qty : null, p.available);   // MIN_ORDER_FLOOR..CAP, never more than what is in stock
        p.maxOrder = Math.max(0, +p.available);                              // the most that can be ordered = what is in stock
        p.rating = r && r.avg != null ? +r.avg : 0;
        p.reviewCount = r && r.cnt ? r.cnt : 0;
        p.notifyMe = alerts.has(k) && !a;
        p.backInStock = !!a && p.available > 0 && Date.now() - new Date(a).getTime() < BACK_IN_STOCK_DAYS * 86400000;
      }
    } catch (err) { console.warn('[shop] could not add min-order / rating info to the catalog:', err.message); }
    return rows;
  }

  app.locals.shopExtras = { decorate, checkMinimums, effectiveMin, MIN_ORDER_FLOOR, MIN_ORDER_CAP };
};
module.exports.pure = { paymentReminderPlan };
