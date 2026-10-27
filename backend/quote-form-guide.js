/* quote-form-guide.js — the system GUIDES the person sending a quote; the person only confirms or explains a change.

   For one quote request it works out, from the recipe cost, stock, supplier lead times and Finance's approval rules:
     • the price to quote (and the band the person may move it within without explaining)
     • the date it can be ready (a real calendar date, not "2 weeks") and whether that is late for the customer's needed-by date
     • how long the price should stay valid (a date)
     • a ready-to-send message to the customer
     • a plain-words "why" for every number, shown at the bottom of the form
   and it checks what the person finally enters. Anything that goes against the guidance needs a written reason, which is saved
   in the decision log. Nothing here sends a quote: shop-extras.js still does that, after calling checkPlan().

   Mounted in server.js AFTER quote-automation.js:
     require('./quote-form-guide')({ app, pool, auth, wrap, ValidationError, str });

   GUIDE below holds starting assumptions for how long work takes. They are not measured from your shop floor: change them here. */
const GUIDE = {
  validDays: { suggested: 7, min: 1, max: 30 },
  readyMaxDays: 365,
  // working days (Mon-Fri) of work once the materials are in hand
  catalogPrepWorkdays: 2,          // a finished good that is in stock: pack and hand over
  customBaseWorkdays: 7,           // a custom run: set-up and making
  customExtraWorkdaysPer100: 1,    // plus this many working days for every 100 pieces after the first 100
  finishWorkdays: 2,               // when a finish (paint, plating...) is asked for
  machiningWorkdays: 2,            // when machining / secondary work is asked for
  bufferWorkdays: 1,               // a cushion so the date is one we can keep
  defaultSupplierLeadDays: 7       // a short material with no supplier lead time on file
};

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const addWorkdays = (iso, n) => { let d = new Date(iso + 'T00:00:00Z'), left = n; while (left > 0) { d = new Date(d.getTime() + 86400000); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left--; } return d.toISOString().slice(0, 10); };
const workdaysBetween = (fromIso, toIso) => { let n = 0, d = new Date(fromIso + 'T00:00:00Z'); const end = new Date(toIso + 'T00:00:00Z');
  while (d < end) { d = new Date(d.getTime() + 86400000); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; } return n; };
const nice = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const NICE = nice;
const dateStr = (d) => { if (!d) return null; if (typeof d === 'string') return d.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const qtyOf = (t) => { const m = /^\s*([\d,.]+)/.exec(String(t || '')); const n = m ? Number(m[1].replace(/,/g, '')) : NaN; return Number.isFinite(n) && n > 0 ? n : 1; };
const NONE_RE = /^(none|n\/a|as is|not sure|no finish|-)/i;
const wants = (v) => !!String(v || '').trim() && !NONE_RE.test(String(v).trim()) && !/\(as is\)/i.test(String(v));

/* ---------------- pure: when can it be ready ---------------- */
function suggestReady({ today, catalog, quantity, specs, materialWaitDays, neededBy }) {
  const parts = [];
  let work = 0;
  if (catalog) { work += GUIDE.catalogPrepWorkdays; parts.push({ label: 'Pack and hand over (in stock)', days: GUIDE.catalogPrepWorkdays }); }
  else {
    const extra = Math.max(0, Math.ceil((quantity - 100) / 100)) * GUIDE.customExtraWorkdaysPer100;
    work += GUIDE.customBaseWorkdays + extra;
    parts.push({ label: `Make ${quantity} pcs`, days: GUIDE.customBaseWorkdays + extra,
      note: `${GUIDE.customBaseWorkdays} for set-up and the first 100` + (extra ? `, +${extra} for the rest` : '') });
    if (wants((specs || {}).finish)) { work += GUIDE.finishWorkdays; parts.push({ label: `Finish: ${specs.finish}`, days: GUIDE.finishWorkdays }); }
    if (wants((specs || {}).service)) { work += GUIDE.machiningWorkdays; parts.push({ label: `Secondary work: ${specs.service}`, days: GUIDE.machiningWorkdays }); }
  }
  work += GUIDE.bufferWorkdays; parts.push({ label: 'Buffer', days: GUIDE.bufferWorkdays });
  const wait = Math.max(0, Math.ceil(Number(materialWaitDays) || 0));
  const start = addDays(today, wait);
  const earliestDate = addWorkdays(start, work);
  let date = earliestDate;
  let late = false;
  let lateByDays = 0;
  if (neededBy) {
    if (earliestDate <= neededBy) {
      date = neededBy;
    } else {
      late = true;
      lateByDays = Math.round((Date.parse(earliestDate) - Date.parse(neededBy)) / 86400000);
      date = earliestDate;
    }
  }
  const out = { date, earliestDate, workdays: work, materialWaitDays: wait, startsOn: start, parts, neededBy: neededBy || null, late, lateByDays };
  return out;
}

/* ---------------- pure: the price band ---------------- */
function priceBand({ draft, settings }) {
  if (!draft || !draft.ok) return { ok: false };
  const S = settings || {}, tol = +S.tolerancePct || 0, minMargin = Math.min(+S.minMarginPct || 0, 99);
  const floorByMargin = r2(draft.costTotal / (1 - minMargin / 100));
  return { ok: true, suggested: draft.total, lowest: Math.max(floorByMargin, r2(draft.total * (1 - tol / 100))), highest: r2(draft.total * (1 + tol / 100)),
    cost: draft.costTotal, floor: floorByMargin, tolerancePct: tol, minMarginPct: +S.minMarginPct || 0 };
}

/* ---------------- pure: check what the person entered against the guidance ----------------
   returns { errors: {field: msg}, flags: [{ code, text }], needsReason } — flags are things that are allowed IF explained. */
function checkPlan({ today, input, guide }) {
  const errors = {}, flags = [];
  const amount = Number(input.amount);
  if (!(amount > 0)) errors.amount = 'Enter the quoted amount';
  if (!isIso(input.readyBy)) errors.readyBy = 'Pick the date it will be ready';
  else if (input.readyBy <= today) errors.readyBy = 'The ready date must be after today';
  else if (input.readyBy > addDays(today, GUIDE.readyMaxDays)) errors.readyBy = 'The ready date is too far away (more than a year)';
  if (!isIso(input.validUntil)) errors.validUntil = 'Pick the date the price stays valid until';
  else if (input.validUntil < addDays(today, GUIDE.validDays.min)) errors.validUntil = 'The price must stay valid until tomorrow or later';
  else if (input.validUntil > addDays(today, GUIDE.validDays.max)) errors.validUntil = `A price cannot stay valid for more than ${GUIDE.validDays.max} days: material costs move`;
  if (Object.keys(errors).length) return { errors, flags, needsReason: false };

  const P = guide.price;
  if (!P.ok) flags.push({ code: 'not_priced', text: 'The system could not work out this price, so it was typed by hand' });
  else {
    const dev = r2((amount - P.suggested) / P.suggested * 100);
    if (amount < P.cost - 0.004) flags.push({ code: 'below_cost', text: `${peso(amount)} is below the cost of ${peso(P.cost)}` });
    else if (amount < P.floor - 0.004) flags.push({ code: 'below_margin', text: `${peso(amount)} is below the minimum margin price of ${peso(P.floor)}` });
    else if (amount < P.lowest - 0.004) flags.push({ code: 'under_band', text: `${Math.abs(dev)}% below the system price of ${peso(P.suggested)} (allowed without a reason: ${P.tolerancePct}%)` });
    else if (amount > P.highest + 0.004) flags.push({ code: 'over_band', text: `${dev}% above the system price of ${peso(P.suggested)} (allowed without a reason: ${P.tolerancePct}%)` });
  }
  const minReady = guide.ready.earliestDate || guide.ready.date;
  if (input.readyBy < minReady) flags.push({ code: 'faster', text: `${nice(input.readyBy)} is earlier than the date the system can support (${nice(minReady)})` });
  if (guide.ready.neededBy && input.readyBy > guide.ready.neededBy) flags.push({ code: 'late', text: `${nice(input.readyBy)} is after the customer's needed-by date (${nice(guide.ready.neededBy)})` });
  const reason = String(input.overrideReason || '').trim();
  const needsReason = flags.length > 0;
  if (needsReason && reason.length < 10) errors.overrideReason = 'Write why (at least 10 characters): ' + flags.map((f) => f.text).join('; ');
  if (reason.length > 500) errors.overrideReason = 'Keep the reason within 500 characters';
  return { errors, flags, needsReason };
}

/* ---------------- pure: the customer message and the "why" ---------------- */
function writeMessage({ quote, readyBy, validUntil, fmt }) {
  const nice = fmt || NICE;
  const bits = [`This price is for the full quantity (${quote.quantity}).`];
  const targetNote = quote.neededBy && readyBy === quote.neededBy ? ' as requested' : '';
  bits.push(quote.fulfillment === 'Delivery' ? `We aim to have it ready by ${nice(readyBy)}${targetNote}, then deliver it. The delivery fee is extra.` : `We aim to have it ready for pickup by ${nice(readyBy)}${targetNote}.`);
  bits.push(`The price is valid until ${nice(validUntil)}.`);
  return bits.join(' ');
}
function writeWhy({ quote, draft, band, settings, ready, valid }) {
  const why = [];
  if (band.ok) {
    why.push({ title: 'Price', text: draft.catalog
      ? `${peso(draft.pricePerPiece)} each (the product's selling price) x ${draft.quantity} = ${peso(draft.total)}. Cost is ${peso(draft.costTotal)}, a margin of ${draft.marginPct}%.`
      : `Materials cost ${peso(draft.costTotal)} for ${draft.quantity} pcs. Adding the ${draft.markupPct}% quote markup gives ${peso(draft.pricePerPiece)} each, ${peso(draft.total)} in all (margin ${draft.marginPct}%).` });
    why.push({ title: 'What you may change', text: `Anything from ${peso(band.lowest)} to ${peso(band.highest)} (within ±${band.tolerancePct}% and not under the ${band.minMarginPct}% minimum margin) goes out without a reason. Outside that, the system asks you to write one.` });
  } else why.push({ title: 'Price', text: 'The system could not price this: ' + (draft && draft.missing && draft.missing.length ? 'the request does not give the ' + draft.missing.join(', ') : ((draft && draft.problems) || []).map((p) => p.message).join(' ') || 'something is missing') + '. Type the price and write why.' });
  const waitTxt = ready.materialWaitDays > 0 ? `Some material is short, so work starts after about ${ready.materialWaitDays} day(s) of waiting for the supplier (${nice(ready.startsOn)}). ` : 'Materials are in stock, so work can start today. ';
  const earliestTxt = ready.earliestDate && ready.earliestDate !== ready.date ? ` (earliest possible completion: ${nice(ready.earliestDate)})` : '';
  why.push({ title: 'Ready date', text: waitTxt + 'Then ' + ready.parts.map((p) => `${p.label} ${p.days} working day(s)`).join(', ') + ` = ${ready.workdays} working days${earliestTxt}, scheduled for promised ready date of ${nice(ready.date)}. Weekends are skipped; holidays are not known, so this is an estimate.` });
  if (ready.neededBy) why.push({ title: 'Customer\'s date', text: ready.late ? `The customer needs it by ${nice(ready.neededBy)}. This is ${ready.lateByDays} day(s) later. You can still send it, but tell them why.` : `The customer needs it by ${nice(ready.neededBy)}. Scheduled for ready pickup/delivery on their requested date.` });
  why.push({ title: 'Price valid until', text: `${GUIDE.validDays.suggested} days, until ${nice(valid.date)}. Short enough that a material price change does not leave an old price standing; the longest allowed is ${GUIDE.validDays.max} days.` });
  return why;
}

module.exports = function mountQuoteGuide({ app, pool, auth, wrap, ValidationError, str }) {
  const bad = (field, msg) => new ValidationError({ [field]: msg });
  const qa = () => app.locals.quoteAutomation;

  async function materialWait(db, draft) {
    const short = ((draft && draft.shortfalls) || []).map((s) => String(s.sku).toUpperCase());
    if (!short.length) return 0;
    const { rows } = await db.query(
      `SELECT upper(p.sku) AS sku, (SELECT s.lead_time_days FROM product_suppliers ps JOIN suppliers s USING (supplier_id)
                                     WHERE ps.product_id = p.product_id AND ps.is_primary AND s.status = 'active' LIMIT 1) AS lead
         FROM products p WHERE upper(p.sku) = ANY($1)`, [short]);
    const leads = short.map((sku) => { const r = rows.find((x) => x.sku === sku); return r && r.lead != null ? +r.lead : GUIDE.defaultSupplierLeadDays; });
    return Math.max(...leads);
  }

  async function build(db, no) {
    const A = qa(); if (!A) throw bad('guide', 'The automatic price checks are not available');
    await A.ready;
    const q = (await db.query('SELECT * FROM quote_requests WHERE quote_no = $1', [no])).rows[0];
    if (!q) throw bad('id', 'Quote request not found');
    if (['completed', 'declined'].includes(q.status)) throw bad('status', 'This request is finished and cannot be quoted');
    const [settings, draft] = [await A.settings(db), await A.draftForQuote(db, q)];
    const today = todayPH(), quantity = draft && draft.quantity ? draft.quantity : qtyOf(q.quantity);
    const neededBy = dateStr(q.needed_by);
    const ready = suggestReady({ today, catalog: !!(draft && draft.catalog), quantity, specs: q.specs || {}, materialWaitDays: await materialWait(db, draft), neededBy });
    const valid = { date: addDays(today, GUIDE.validDays.suggested), min: addDays(today, GUIDE.validDays.min), max: addDays(today, GUIDE.validDays.max) };
    const band = priceBand({ draft, settings });
    const quote = { id: q.quote_no, product: q.product_name || 'Custom item', quantity: q.quantity, fulfillment: q.fulfillment || 'Pickup', neededBy };
    const checks = [];
    checks.push(band.ok ? { level: 'ok', text: 'Fully costed from the recipe and current material prices' } : { level: 'warn', text: 'The system cannot price this yet, so type the price and explain' });
    if (draft && (draft.shortfalls || []).length) checks.push({ level: 'warn', text: 'Short on material: ' + draft.shortfalls.map((s) => s.name).join(', ') + '. A purchase suggestion is made if the customer accepts' });
    else if (band.ok) checks.push({ level: 'ok', text: 'All materials are in stock' });
    checks.push(ready.late ? { level: 'warn', text: `Ready date is ${ready.lateByDays} day(s) after the customer's needed-by date` } : neededBy ? { level: 'ok', text: 'Ready date meets the customer\'s needed-by date' } : { level: 'ok', text: 'The customer gave no needed-by date' });
    const guide = {
      quote,
      price: band.ok ? { ok: true, suggested: band.suggested, perPiece: draft.pricePerPiece, cost: band.cost, marginPct: draft.marginPct, floor: band.floor, lowest: band.lowest, highest: band.highest, tolerancePct: band.tolerancePct, minMarginPct: band.minMarginPct, basis: draft.catalog ? 'catalog' : 'recipe' } : { ok: false },
      ready: { date: ready.date, earliestDate: ready.earliestDate, min: addDays(today, 1), max: addDays(today, GUIDE.readyMaxDays), workdays: ready.workdays, materialWaitDays: ready.materialWaitDays, startsOn: ready.startsOn, neededBy, late: ready.late, lateByDays: ready.lateByDays, parts: ready.parts },
      valid: { date: valid.date, min: valid.min, max: valid.max },
      checks
    };
    guide.message = writeMessage({ quote, readyBy: ready.date, validUntil: valid.date });
    guide.messageTemplate = writeMessage({ quote, readyBy: '{READY}', validUntil: '{VALID}', fmt: (v) => v });   // the screen fills in the dates the person picks
    guide.why = writeWhy({ quote, draft, band, settings, ready, valid });
    return guide;
  }

  /* what shop-extras.js calls before it saves a quote: returns what to store, or throws the field errors */
  async function readPlan(db, no, input) {
    const guide = await build(db, no), today = todayPH();
    const res = checkPlan({ today, input, guide });
    if (Object.keys(res.errors).length) throw new ValidationError(res.errors);
    const n = Math.max(1, workdaysBetween(today, input.readyBy));
    return { readyBy: input.readyBy, validUntil: input.validUntil, leadTime: n + ' working day' + (n === 1 ? '' : 's'),   // lead_time text still feeds the older screens and emails
      overrideReason: res.needsReason ? String(input.overrideReason).trim() : null, flags: res.flags, guide };
  }

  for (const [base, role] of [['/api/finance', 'finance'], ['/api/pos', 'cashier']]) {
    app.get(base + '/quotes/:no/guide', auth(role), wrap(async (req, res) => res.json(await build(pool, str(req.params.no)))));
  }
  app.locals.quoteGuide = { build, readPlan };
};
module.exports.pure = { GUIDE, suggestReady, priceBand, checkPlan, writeMessage, workdaysBetween, addWorkdays };
