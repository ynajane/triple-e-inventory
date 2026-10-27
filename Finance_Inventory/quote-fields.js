/* quote-fields.js — the shared "what do you need?" part of a quote request (online shop and POS counter).
   Order on the form (below "Describe the item"):
     Item type           Die-cast part (aluminum), Forged part (brass) or Fitting / valve (forged brass)  (custom items only)
     Sizes and details   dropdowns: material, size, thickness, finish, machining / secondary work (size and thickness also accept a typed value)
                         The choices follow the ITEM TYPE and the MATERIAL: a die-cast part only offers aluminum (ADC12 / A380) and aluminum finishes,
                         a fitting only offers brass, standard pipe sizes and no thickness, brass is never offered powder coating... They come from
                         options.matrix[itemType][material], the very table the server checks with, so what the form offers is what the server accepts.
     Quantity            number + unit dropdown. The unit list follows the item type (parts by the pc or set, fittings also by the box).
                         A ready-made catalog product (a finished good) is locked to the unit it is sold in: pcs.
     Needed by           date picker: tomorrow at the earliest, up to 6 months from today
     Extra notes         optional
   The choices and rules come from the server (GET /api/shop/quote-options or /api/pos/quote-options), so the page and the
   server always agree.  The server checks every rule again; the checks here only give faster feedback.
   Usage:  QuoteFields.mount(hostElement, { prefix: 'q', options })   then   QuoteFields.read('q') / validate('q') / reset('q') */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var OTHER = '__other__';
  var FIELDS = [['material', 'Material'], ['size', 'Size'], ['thickness', 'Thickness'], ['finish', 'Finish'], ['service', 'Machining / secondary work']];
  var CUSTOM_HINT = { material: 'e.g. Aluminum ADC12', size: 'e.g. 100 x 60 x 40 mm', thickness: 'e.g. 2.5 mm', finish: 'e.g. Mirror polish', service: 'e.g. CNC machining' };
  var NEEDS_NUMBER = { size: 1, thickness: 1 };         // a typed size / thickness must contain a number; the others are free text
  var CUSTOM_RE = /^[\p{L}\p{N}\s.,x\u00D7\-"'\/()+*]+$/u;
  var state = {};                                           // prefix -> { options, picked, hint, offKey, timer }

  var opts = function (list, first) { return '<option value="">' + esc(first) + '</option>' + list.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join(''); };
  var escRe = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var hasWord = function (text, w) { return new RegExp('(^|[^a-z0-9])' + escRe(w), 'i').test(text); };   // word start, so "steel" never matches "tee"
  var wholeWord = function (text, w) { return new RegExp('(^|[^a-z0-9])' + escRe(w) + '(e?s)?(?![a-z0-9])', 'i').test(text); };   // "valves" yes, "capacity" no
  var isCustom = function (o, k) { return (o.customAllowed || []).indexOf(k) >= 0; };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var dayText = function (s) { return new Date(s + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }); };

  // earliest / latest date: the server tells us (Philippine time); this is only the fallback
  function minWorkingDaysDate(days) {
    var d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    var added = 0;
    while (added < days) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() !== 0) added++; // Skip Sundays
    }
    return ymd(d);
  }
  function leadForQty(qty) {
    var q = Number(String(qty || '').replace(/,/g, '').trim()) || 0;
    if (q > 500) return { days: 12, minDate: minWorkingDaysDate(12) };
    if (q > 100) return { days: 7, minDate: minWorkingDaysDate(7) };
    return { days: 2, minDate: minWorkingDaysDate(2) };
  }
  function updateLeadRule(p) {
    var qEl = $(p + 'Qty'), nEl = $(p + 'Needed'), hEl = $(p + 'NeededHint'), qhEl = $(p + 'QtyHint');
    if (!qEl || !nEl) return;
    var q = Number((qEl.value || '').replace(/,/g, '').trim()) || 0;
    var lead = leadForQty(q);
    state[p].minLeadDate = lead.minDate;
    state[p].minLeadDays = lead.days;
    nEl.min = lead.minDate;
    if (hEl) {
      if (q > 100) {
        hEl.innerHTML = 'Orders over 100 units require at least <b>' + lead.days + ' working days</b> for fabrication &amp; QC. Earliest available date: <b>' + dayText(lead.minDate) + '</b>.';
      } else {
        hEl.textContent = 'Pick a date from ' + dayText(lead.minDate) + ' up to ' + dayText(limits(state[p].options).max) + '.';
      }
    }
    if (qhEl) {
      var mq = state[p].options.minQty || 20;
      if (q > 0 && q < mq && !state[p].locked) {
        qhEl.innerHTML = '<span style="color:#b45309">Minimum order for custom fabrication is ' + mq + ' ' + $(p + 'Unit').value + '.</span>';
      } else if (q > 500) {
        qhEl.innerHTML = '<span style="color:#1d4ed8;font-weight:600">Large batch (500+ units) · min. 12 working days fabrication &amp; QC.</span>';
      } else if (q > 100) {
        qhEl.innerHTML = '<span style="color:#1d4ed8;font-weight:600">Volume batch (100+ units) · min. 7 working days fabrication &amp; QC.</span>';
      } else if (q >= mq) {
        qhEl.textContent = 'Standard order batch · typical lead time 3–5 working days.';
      } else {
        qhEl.textContent = '';
      }
    }
    if (nEl.value) check(p, 'neededBy');
  }
  function limits(o) {
    if (o.neededMin && o.neededMax) return { min: o.neededMin, max: o.neededMax };
    var today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })), min = new Date(today), max = new Date(today);
    min.setDate(min.getDate() + 1); max.setMonth(max.getMonth() + (o.neededMaxMonths || 6));
    return { min: ymd(min), max: ymd(max) };
  }
  var wholeUnit = function (p) { var o = state[p].options, u = $(p + 'Unit').value; return (o.decimalUnits || []).indexOf(u) < 0; };

  function mount(host, cfg) {
    var p = cfg.prefix, o = cfg.options || {}, lim = limits(o);
    state[p] = { options: o, picked: false, hint: null, offKey: null, timer: null, flexible: cfg.flexible || null, locked: false,
      estimate: cfg.estimate || null, productSku: cfg.productSku || null, estTimer: null, estSeq: 0 };
    var hasTypes = !!(o.itemTypes && o.itemTypes.length && o.matrix);
    var h = '<div class="qx-title">Sizes and details</div>' +
      '<div class="qx-narrow" id="' + p + 'Narrow" hidden></div>' +
      (hasTypes ? '<div class="q-field" id="' + p + 'TypeWrap"><label for="' + p + 'S_itemType">Item type</label>' +
        '<select id="' + p + 'S_itemType">' + opts(o.itemTypes, 'Choose the kind of item') + '</select>' +
        '<small class="q-hint" id="' + p + 'TypeNote"></small><div class="err-text" id="' + p + 'E_itemType"></div></div>' : '') +
      '<div class="qx-narrow" id="' + p + 'Cleared" role="status" hidden></div>' +
      '<div class="qx-lockbar" id="' + p + 'Locked" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><span><b>Catalog product</b> \u2014 details come from the product record and are sold by pcs. Just enter the quantity and date.</span></div>' +
      '<div class="q-grid">' +
      FIELDS.map(function (f) {
        var k = f[0], custom = isCustom(o, k);
        return '<div class="q-field"><label for="' + p + 'S_' + k + '">' + f[1] + '</label>' +
          '<select id="' + p + 'S_' + k + '">' + opts(o[k] || [], 'Choose ' + f[1].toLowerCase()) + (custom ? '<option value="' + OTHER + '">Other (type it)</option>' : '') + '</select>' +
          // the typed value is built from the small boxes below it (length x width x height + unit, a pipe size + unit, a thickness in mm)
          (custom ? '<input id="' + p + 'C_' + k + '" type="hidden" hidden><div class="qx-typed" id="' + p + 'X_' + k + '" hidden></div>' : '') +
          '<small class="q-hint qx-stock" id="' + p + 'Stock_' + k + '" hidden></small><div class="err-text" id="' + p + 'E_' + k + '"></div></div>';
      }).join('') + '</div>' +
      '<div class="q-grid">' +
      '<div class="q-field"><label for="' + p + 'Qty">Quantity</label>' +
        '<div class="qx-row"><input id="' + p + 'Qty" type="text" inputmode="decimal" maxlength="12" autocomplete="off" placeholder="e.g. 200">' +
        '<select id="' + p + 'Unit" aria-label="Unit">' + (o.units || []).map(function (u) { return '<option value="' + esc(u) + '">' + esc(u) + '</option>'; }).join('') + '</select></div>' +
        '<small id="' + p + 'QtyHint" class="q-hint"></small><div class="err-text" id="' + p + 'E_quantity"></div></div>' +
      '<div class="q-field"><label for="' + p + 'Needed">Needed by</label>' +
        '<input id="' + p + 'Needed" type="date" min="' + lim.min + '" max="' + lim.max + '">' +
        '<small id="' + p + 'NeededHint" class="q-hint">Pick a date from ' + esc(dayText(lim.min)) + ' up to ' + esc(dayText(lim.max)) + '.</small><div class="err-text" id="' + p + 'E_neededBy"></div></div></div>' +
      (cfg.estimate ? '<div class="qx-est" id="' + p + 'Est" aria-live="polite" hidden></div>' : '') +
      '<div class="q-field"><label for="' + p + 'Notes">Extra notes <span class="q-optional">(optional)</span></label>' +
        '<textarea id="' + p + 'Notes" rows="3" maxlength="1000" placeholder="e.g. hole spacing, thread type, packing"></textarea>' +
        '<div class="q-meta"><div class="err-text" id="' + p + 'E_notes"></div><span class="q-count" id="' + p + 'NotesCount">0 / 1000</span></div></div>';
    host.innerHTML = h;
    FIELDS.forEach(function (f) {
      var k = f[0], sel = $(p + 'S_' + k), c = $(p + 'C_' + k);
      sel.addEventListener('change', function () {
        if (c) { typedMode(p, k, sel.value === OTHER); var first = $(p + 'X_' + k) && $(p + 'X_' + k).querySelector('input'); if (sel.value === OTHER && first) first.focus(); }
        if (k === 'material') { state[p].picked = true; describeNote(p); }                     // the person chose it, so the "pre-selected" note no longer applies
        var fn = $(p + 'A_' + k); if (fn) { fn.hidden = true; fn.textContent = ''; }
        sel.removeAttribute('data-filled'); sel.removeAttribute('data-auto');
        if (k !== 'material') { var cl = $(p + 'Cleared'); if (cl && sel.value) { cl.hidden = true; cl.innerHTML = ''; } }     // they chose again: the "cleared" note has done its job
        if (k === 'material' && !state[p].locked) cascade(p, sel.value ? 'the material ' + sel.value : '');     // finish, thickness and cutting that do not go with it are dropped
        check(p, k);
      });
      if (c) { c.addEventListener('input', function () { check(p, k); }); c.addEventListener('blur', function () { check(p, k); }); }
      var box = $(p + 'X_' + k);
      if (box) {
        box.addEventListener('input', function (e) {
          if (e.target.matches('input[data-n]')) { var t = e.target, clean = t.value.replace(t.getAttribute('data-n') === 'pipe' ? /[^\d.\/\- ]/g : /[^\d.]/g, ''); if (clean !== t.value) t.value = clean; }
          compose(p, k); check(p, k);
        });
        box.addEventListener('change', function () { compose(p, k); if (box.querySelector('input[data-n]').value) check(p, k); });
        box.addEventListener('focusout', function (e) { if (!box.contains(e.relatedTarget)) { compose(p, k); check(p, k); } });
      }
    });
    var ity = $(p + 'S_itemType');
    if (ity) ity.addEventListener('change', function () {
      var r = ity.value && o.itemRules[ity.value]; var tn = $(p + 'TypeNote'); if (tn) tn.textContent = r ? r.note : '';
      if (!state[p].autoChange) { state[p].typePicked = !!ity.value; state[p].typeAuto = null; }
      var kind = r ? r.typed : '', sz = $(p + 'S_size');
      if (sz && sz.value === OTHER && state[p].typedKind && state[p].typedKind !== kind) { clearTyped(p, 'size'); sz.value = ''; state[p].clearedTyped = true; }
      state[p].typedKind = kind;
      cascade(p, r ? r.label : '', true); check(p, 'itemType'); describeNote(p);
    });
    $(p + 'Qty').addEventListener('blur', function () { check(p, 'quantity'); });
    $(p + 'Qty').addEventListener('input', function () { var el = $(p + 'Qty'), d = el.value.replace(wholeUnit(p) ? /[^\d,]/g : /[^\d.,]/g, ''); if (d !== el.value) el.value = d; if (el.value || el.classList.contains('is-bad')) check(p, 'quantity'); updateLeadRule(p); });
    $(p + 'Unit').addEventListener('change', function () { state[p].unitTouched = true; var el = $(p + 'Qty'); if (wholeUnit(p)) el.value = el.value.replace(/\..*$/, ''); if (el.value) check(p, 'quantity'); });
    ['input', 'change'].forEach(function (event) { $(p + 'Needed').addEventListener(event, function () { check(p, 'neededBy'); neededNote(p); }); });
    $(p + 'Notes').addEventListener('input', function () { $(p + 'NotesCount').textContent = $(p + 'Notes').value.length + ' / 1000'; check(p, 'notes'); });
    $(p + 'Narrow').addEventListener('click', function (e) { if (e.target.closest('[data-showall]')) { state[p].offKey = state[p].hint && state[p].hint.key; refresh(p); } });
    var item = itemInput(p); if (item) item.addEventListener('input', function () { clearTimeout(state[p].timer); state[p].timer = setTimeout(function () { refresh(p); }, 250); });
    refresh(p); syncUnits(p);
    updateLeadRule(p);
    // automatic price: every change re-works the estimate (pricing.js on the server does the maths, so every screen agrees)
    if (cfg.estimate) {
      var again = function () { clearTimeout(state[p].estTimer); state[p].estTimer = setTimeout(function () { estimate(p); }, 400); };
    host.addEventListener('change', function (e) { if (e.target && /S_size$|XU_size$/.test(e.target.id) && $(p + 'S_thickness') && $(p + 'S_thickness').value) check(p, 'thickness'); });
      host.addEventListener('change', again); host.addEventListener('input', again);
      estimate(p);
    }
  }

  // ---- the price estimate under the form ---------------------------------------------------------------------------------
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  function estimate(p) {
    var s = state[p], box = $(p + 'Est'); if (!s || !box) return;
    var r = read(p), sku = typeof s.productSku === 'function' ? s.productSku() : '';
    var body = { itemType: r.itemType || (s.locked ? s.catalogType : undefined), quantity: r.quantity, specs: r.specs, productSku: sku || undefined };
    var my = ++s.estSeq;
    fetch('/api/pricing/quote-estimate', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (d) {
        if (my !== s.estSeq || !d) return;
        box.hidden = false;
        if (d.status === 'incomplete' || (!d.ok && d.missing)) {
          box.className = 'qx-est is-wait';
          box.innerHTML = '<b>Automatic price</b><span>Choose the ' + esc((d.missing || []).join(', ')) + ' to see the estimated price.</span>';
          return;
        }
        var staff = s.estimate === 'staff';
        // never a wrong number: no cost on file -> "cannot price yet"; stock that cannot cover the quantity -> "short by X"
        if (!d.ok) {
          box.className = 'qx-est is-wait';
          box.innerHTML = '<b>' + (staff ? 'Cannot price yet' : 'Estimated price') + '</b><span>' + esc(staff ? (d.problems || []).map(function (x) { return x.message; }).join(' ') : (d.cannotPrice || 'Our staff will work out this price.')) + '</span>';
          return;
        }
        var num = function (n) { return (+Number(n).toFixed(4)).toLocaleString('en-PH', { maximumFractionDigits: 4 }); };
        box.className = 'qx-est' + (d.status === 'short' || d.stockNote ? ' is-short' : '');
        box.innerHTML = '<div class="qx-est-head"><b>' + (staff ? 'System price' : 'Estimated price') + '</b><strong>' + peso(d.total) + '</strong></div>' +
          '<span>' + peso(d.pricePerPiece) + ' per piece \u00D7 ' + esc(d.quantity) + (d.catalog ? ' (catalog price)' : '') + '</span>' +
          (staff && d.lines ? '<details class="qx-est-how"><summary>Materials and stock</summary><ul>' +
            d.lines.map(function (l) { return '<li><span>' + esc(l.name) + ': ' + num(l.needed) + ' ' + esc(l.unit) + ' for the order' + (l.estimate ? ' <i>(estimate)</i>' : '') +
              '<br><small>' + (l.short > 0 ? '<em class="qx-short">short by ' + num(l.short) + ' ' + esc(l.unit) + '</em> \u00B7 ' : '') + num(l.onHand) + ' ' + esc(l.unit) + ' on hand</small></span><b>' + peso(l.costPerPiece) + '/pc</b></li>'; }).join('') +
            '<li class="sum"><span>Cost per piece \u00B7 total cost ' + peso(d.costTotal) + '</span><b>' + peso(d.costPerPiece) + '</b></li>' +
            '<li class="sum"><span>Price = cost \u00D7 ' + (1 + d.markupPct / 100).toFixed(2) + ' \u00B7 margin ' + esc(d.marginPct) + '%</span><b>' + peso(d.pricePerPiece) + '</b></li></ul></details>' : '') +
          (d.notes && d.notes.length ? '<small>' + esc(d.notes.join(' ')) + '</small>' : '') +
          (d.stockNote ? '<small class="qx-short">' + esc(d.stockNote) + '</small>' : '') +
          '<small>' + (staff ? 'Materials only, priced at today\u2019s costs; the weight per piece is an estimate. Price the request on the Quotations desk.' : 'A first estimate from your details, at today\u2019s material prices. Our staff confirm the final price in your quotation.') + '</small>';
      }).catch(function () {});
  }

  // ---- the item type and the material decide what the other details can be ------------------------------------------------
  var typeVal = function (p) { var e = $(p + 'S_itemType'); return e && !state[p].locked ? e.value : ''; };
  var typeRule = function (p) { var t = typeVal(p) || (state[p].locked && state[p].catalogType) || ''; return t && state[p].options.itemRules ? state[p].options.itemRules[t] || null : null; };
  // the unit list follows the item type: a sheet is counted in sheets, a fitting in pcs. A catalog product keeps its own locked unit (setUnit).
  function syncUnits(p) {
    var s = state[p], sel = $(p + 'Unit'); if (!s || !sel || s.locked) return;
    var r = typeRule(p), list = r ? r.units : (s.options.units || []), cur = sel.value;
    sel.innerHTML = list.map(function (u) { return '<option value="' + esc(u) + '">' + esc(u) + '</option>'; }).join('');
    // until the person picks a unit themselves, the item type's own unit is the default (pcs for every item type)
    sel.value = list.indexOf(cur) >= 0 && (s.unitTouched || !r) ? cur : (r ? r.unit : list[0]);
    sel.title = r ? 'Choose how it is counted: ' + list.join(', ') : '';
    var q = $(p + 'Qty'); if (q && wholeUnit(p)) q.value = q.value.replace(/\..*$/, '');
    if (q && q.classList.contains('is-bad')) check(p, 'quantity');
  }
  // item type or material changed: rebuild size / thickness / finish / cutting / unit, and say what had to be cleared
  function cascade(p, why, withMaterial) {
    var s = state[p]; s.cleared = [];
    if (withMaterial) rebuild(p, 'material');                              // a die-cast part is aluminum, a forged part or fitting is brass: a material that does not go with the new item type is dropped
    rebuildAll(p, true); syncUnits(p); updateAvailability(p);
    if (s.clearedTyped) { s.clearedTyped = false; s.cleared.unshift({ label: 'Size', value: 'the typed size, which is measured differently' }); }
    var box = $(p + 'Cleared');
    if (box) {
      if (s.cleared.length) { box.innerHTML = '<span>Cleared because ' + (why ? 'it does not go with <b>' + esc(why) + '</b>' : 'the choices changed') + ': ' +
        s.cleared.map(function (c) { return '<b>' + esc(c.label) + '</b> (' + esc(c.value) + ')'; }).join(', ') + '. Please choose again.</span>'; box.hidden = false; }
      else { box.innerHTML = ''; box.hidden = true; }
    }
    ['size', 'thickness'].forEach(function (k) { var c = $(p + 'C_' + k); if (c && !c.hidden && c.value) check(p, k); });      // a typed value must fit the new item type too
  }
  // the typed-size pattern of the chosen item type (from the server): sheets need width x length, pipes need a size with its unit
  function typedRule(p, field) {
    var r = typeRule(p), o = state[p].options; if (field !== 'size' || !r || !o.typedSizes || !o.typedSizes[r.typed]) return null;
    var t = o.typedSizes[r.typed]; return { re: new RegExp(t.pattern, t.flags), hint: t.hint, maxMm: t.maxMm, maxIn: t.maxIn };
  }

  // ---- typed values: small boxes instead of one free-text box -----------------------------------------------------------
  // part size: length x width x height (height optional) + mm / cm / in; pipe size: one number + in / mm; thickness: a number in mm.
  // The boxes write the same text the server checks ("100 x 60 x 40 mm", "25 mm", "2.5 mm") into the hidden p+'C_'+field input.
  function typedKind(p, k) { if (k === 'thickness') return 'thick'; var r = typeRule(p); return r && r.typed === 'pipe' ? 'pipe' : 'part'; }
  function buildTyped(p, k) {
    var box = $(p + 'X_' + k); if (!box) return;
    var kind = typedKind(p, k); if (box.getAttribute('data-kind') === kind) return;
    box.setAttribute('data-kind', kind);
    var num = function (id, label, ph, opt) { return '<label class="qx-dim"><span>' + label + (opt ? ' <i>(optional)</i>' : '') + '</span><input id="' + p + id + '" data-n="' + (kind === 'pipe' ? 'pipe' : 'num') + '" type="text" inputmode="decimal" maxlength="9" autocomplete="off" placeholder="' + ph + '"></label>'; };
    var unit = function (list) { return '<label class="qx-dim qx-unit"><span>Unit</span><select id="' + p + 'XU_' + k + '">' + list.map(function (u) { return '<option value="' + u + '">' + u + '</option>'; }).join('') + '</select></label>'; };
    if (kind === 'part') box.innerHTML = '<div class="qx-dims">' + num('XL_' + k, 'Length', '100') + '<b aria-hidden="true">\u00D7</b>' + num('XW_' + k, 'Width', '60') + '<b aria-hidden="true">\u00D7</b>' + num('XH_' + k, 'Height', '40', true) + unit(['mm', 'cm', 'in']) + '</div><small class="q-hint">The overall size of the part, up to 1000 mm on the longest side.</small>';
    else if (kind === 'pipe') box.innerHTML = '<div class="qx-dims">' + num('XL_' + k, 'Pipe size', '25 or 1-1/4') + unit(['mm', 'in']) + '</div><small class="q-hint">Up to 50 mm (2 in). The standard sizes are in the list above.</small>';
    else box.innerHTML = '<div class="qx-dims">' + num('XL_' + k, 'Thickness', '2.5') + '<span class="qx-suffix">mm</span></div>';
    var c = $(p + 'C_' + k); if (c) c.value = '';
  }
  function typedMode(p, k, on) {
    var c = $(p + 'C_' + k), box = $(p + 'X_' + k); if (!c) return;
    if (on) buildTyped(p, k);
    c.hidden = !on; if (box) box.hidden = !on;
    if (box) box.parentNode.classList.toggle('qx-wide', on && box.getAttribute('data-kind') === 'part');      // three boxes need the full row
    if (!on) setErr(p, k, $(p + 'E_' + k) && $(p + 'E_' + k).textContent && $(p + 'S_' + k).value ? rule(p, k) : '');
  }
  function clearTyped(p, k) { var box = $(p + 'X_' + k), c = $(p + 'C_' + k); if (box) Array.prototype.forEach.call(box.querySelectorAll('input'), function (i) { i.value = ''; }); if (c) c.value = ''; }
  var boxVal = function (p, id) { var e = $(p + id); return e ? e.value.trim() : ''; };
  function compose(p, k) {
    var c = $(p + 'C_' + k), box = $(p + 'X_' + k); if (!c || !box || box.hidden) return;
    var kind = box.getAttribute('data-kind'), u = boxVal(p, 'XU_' + k);
    if (kind === 'part') { var d = [boxVal(p, 'XL_' + k), boxVal(p, 'XW_' + k), boxVal(p, 'XH_' + k)].filter(Boolean); c.value = d.length ? d.join(' x ') + ' ' + u : ''; }
    else if (kind === 'pipe') { var v = boxVal(p, 'XL_' + k); c.value = v ? v + ' ' + u : ''; }
    else { var t = boxVal(p, 'XL_' + k); c.value = t ? t + ' mm' : ''; }
  }
  // which box is wrong, with a message about THAT box (null = the boxes are fine, check the whole value)
  var NUM_RE = /^\d+(?:\.\d{1,2})?$/, PIPE_RE = /^\d+(?:[-\s]\d+\/\d+|\/\d+|\.\d{1,2})?$/;
  function boxProblem(p, k) {
    var box = $(p + 'X_' + k); if (!box || box.hidden) return null;
    var kind = box.getAttribute('data-kind'), bad = function (id, msg) { var e = $(p + id); return { id: id, msg: msg, el: e }; };
    if (kind === 'part') {
      var L = boxVal(p, 'XL_' + k), W = boxVal(p, 'XW_' + k), H = boxVal(p, 'XH_' + k);
      if (!L) return bad('XL_' + k, 'Enter the length of the part.');
      if (!NUM_RE.test(L) || !(+L > 0)) return bad('XL_' + k, 'The length must be a number above 0, e.g. 100.');
      if (!W) return bad('XW_' + k, 'Enter the width of the part (for a round part, its diameter).');
      if (!NUM_RE.test(W) || !(+W > 0)) return bad('XW_' + k, 'The width must be a number above 0, e.g. 60.');
      if (H && (!NUM_RE.test(H) || !(+H > 0))) return bad('XH_' + k, 'The height must be a number above 0, or leave it empty.');
      return null;
    }
    if (kind === 'pipe') {
      var v = boxVal(p, 'XL_' + k);
      if (!v) return bad('XL_' + k, 'Enter the pipe size.');
      if (!PIPE_RE.test(v) || !(sizeMm(v + ' mm')[0] > 0)) return bad('XL_' + k, 'Type the pipe size as a number, e.g. 25 or 1-1/4.');
      return null;
    }
    var t = boxVal(p, 'XL_' + k);
    if (!t) return bad('XL_' + k, 'Enter the thickness in mm.');
    if (!NUM_RE.test(t) || !(+t > 0)) return bad('XL_' + k, 'The thickness must be a number above 0, e.g. 2.5.');
    return null;
  }

  // ---- the options follow the item --------------------------------------------------------------------------------------
  // "Describe the item" is free text, so it is only used to NARROW the dropdowns (stainless sheet -> stainless materials, sheet sizes,
  // stainless finishes). The chosen material then decides the finish / thickness / cutting that fit it. Nothing is ever forced:
  // "Show all options" puts every choice back, and the server checks the final combination again.
  var itemInput = function (p) { return $(p + 'ProductName') || $(p + 'Item'); };
  function itemText(p) {
    var sel = $(p + 'Product');
    if (sel && sel.value) return sel.options[sel.selectedIndex].text.toLowerCase();       // a catalog product: use its name
    var it = itemInput(p); return it ? it.value.toLowerCase() : '';
  }
  function detect(p) {
    var o = state[p].options, text = itemText(p), fam = null, form = null;
    (o.families || []).some(function (f) { if (f.words.some(function (w) { return hasWord(text, w); })) { fam = f; return true; } });
    (o.forms || []).some(function (f) { if (f.words.some(function (w) { return hasWord(text, w); })) { form = f; return true; } });
    var types = null, wordTypes = [];
    // a product word (valve, elbow, housing) beats a process word (forged, cast): fittings are forged too. Same rule as itemTypeFromName on the server.
    var weak = o.processWords || [], hit = function (strongOnly) { return Object.keys(o.typeWords || {}).filter(function (t) { return o.typeWords[t].some(function (w) { return (!strongOnly || weak.indexOf(w) < 0) && wholeWord(text, w); }); }); };
    wordTypes = hit(true); if (!wordTypes.length) wordTypes = hit(false);
    if (fam || wordTypes.length) {
      types = (o.itemTypes || []).filter(function (t) {
        var r = o.itemRules && o.itemRules[t]; if (!r) return false;
        var famOk = !fam || r.materials.some(function (m) { return fam.materials.indexOf(m) >= 0; });
        return famOk && (!wordTypes.length || wordTypes.indexOf(t) >= 0);
      });
    }
    if (!fam && !form && !types) return null;
    var mats = fam ? fam.materials : null, pick = null;
    if (fam && fam.grades) Object.keys(fam.grades).forEach(function (g) { if (!pick && text.indexOf(g) >= 0) pick = fam.grades[g]; });   // "SS 316" -> Stainless Steel 316
    if (!pick && mats && mats.length === 1) pick = mats[0];
    return { key: (fam ? fam.label : '') + '|' + (form ? form.label : '') + '|' + wordTypes.join(','), famLabel: fam && fam.label, famName: fam && fam.name, formLabel: form && form.label, materials: mats, sizes: form && form.sizes, pick: pick,
      types: types, wordTypes: wordTypes };
  }
  // The item type and the material narrow size / thickness / finish / cutting (see the matrix above). Only the MATERIAL list itself is never narrowed:
  // the words in "Describe the item" just put the likely materials FIRST (stainless sheet -> stainless materials on top).
  function listFor(p, k) {
    var s = state[p], all = s.options[k] || [], h = s.hint, pref = h && (k === 'material' ? h.materials : k === 'size' ? h.sizes : null);
    if (k === 'material' && (!s.locked || s.catalogType)) {                                                             // the item type decides the material
      var r0 = typeRule(p); if (r0 && r0.materials) all = all.filter(function (v) { return r0.materials.indexOf(v) >= 0 || /^Not sure/i.test(v); });
    }
    if (k !== 'material' && (!s.locked || s.catalogType)) {
      var t = typeVal(p) || s.catalogType, m = $(p + 'S_material') ? $(p + 'S_material').value : '', mx = s.options.matrix;
      if (t && mx && mx[t]) { var cell = mx[t][m && mx[t][m] ? m : '']; if (cell && cell[k]) return cell[k]; }          // item type + material together
      if (m && s.options.rules && s.options.rules[m] && s.options.rules[m][k]) return s.options.rules[m][k];             // no item type yet: the material alone
    }
    if (!pref || !pref.length) return all;
    return all.filter(function (v) { return pref.indexOf(v) >= 0; }).concat(all.filter(function (v) { return pref.indexOf(v) < 0; }));
  }
  function rebuild(p, k) {
    var o = state[p].options, sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel) return;
    var cur = sel.getAttribute('data-auto') && sel.getAttribute('data-auto') === sel.value ? '' : sel.value, list = listFor(p, k).slice(), label = FIELDS.filter(function (f) { return f[0] === k; })[0][1], r = typeRule(p);
    if (cur && cur !== OTHER && list.indexOf(cur) < 0 && cur === sel.getAttribute('data-added')) list.push(cur);      // a value taken from the product record stays selectable
    var canType = isCustom(o, k) && !(k === 'thickness' && r && r.thickness === 'none');                               // a fitting has no thickness to type
    var locked = state[p].locked, waiting = !locked && !!state[p].options.itemTypes && !typeVal(p);                    // nothing below the item type can be chosen before it
    var otherText = k === 'thickness' ? 'Other thickness (type it)' : k === 'size' ? (r && r.typed === 'pipe' ? 'Other pipe size (type it)' : 'Exact dimensions (type them)') : 'Other (type it)';
    sel.innerHTML = opts(list, waiting ? 'Choose the item type first' : 'Choose ' + label.toLowerCase()) + (canType ? '<option value="' + OTHER + '">' + otherText + '</option>' : '');
    if (!locked) { sel.disabled = waiting; sel.parentNode.classList.toggle('qx-wait', waiting); }
    sel.value = !waiting && ((cur === OTHER && canType) || list.indexOf(cur) >= 0) ? cur : '';
    sel.removeAttribute('data-auto');
    if (!sel.value && !waiting && k === 'thickness' && r && r.thickness === 'none' && list.length === 1 && !sel.disabled) { sel.value = list[0]; sel.setAttribute('data-auto', list[0]); }   // the only possible answer (dropped again if the item type changes)
    if (!sel.value && !waiting && k === 'size' && !list.length && canType && !locked) sel.value = OTHER;                     // nothing to pick from: go straight to typing it
    if (c) {
      if (sel.value === OTHER) { var bx = $(p + 'X_' + k); if (bx && bx.getAttribute('data-kind') !== typedKind(p, k)) { buildTyped(p, k); if (cur === OTHER && state[p].cleared) state[p].cleared.push({ label: label, value: 'what you typed' }); } }
      typedMode(p, k, sel.value === OTHER);
    }
    if (cur && sel.value !== cur) { setErr(p, k, ''); if (!locked && !waiting && state[p].cleared) state[p].cleared.push({ label: label, value: cur === OTHER ? 'what you typed' : cur }); }
  }
  // the item type list follows the description: "brass" leaves forged parts and fittings, "valve" leaves fittings. The others are
  // switched off (not hidden) with the reason, and "Show all item types" turns them back on. One possible type is picked for them.
  function rebuildType(p) {
    var s = state[p], sel = $(p + 'S_itemType'); if (!sel || s.locked) return;
    var o = s.options, h = s.hint, showAll = h && s.offKey === h.key, fit = h && h.types && h.types.length && !showAll ? h.types : null;
    var famOf = function (t) { var r = o.itemRules[t], f = (o.families || []).filter(function (x) { return r && x.materials.indexOf(r.materials[0]) >= 0; })[0]; return f ? f.name.toLowerCase() : ''; };
    var cur = sel.value;
    sel.innerHTML = '<option value="">Choose the kind of item</option>' + o.itemTypes.map(function (t) {
      var off = fit && fit.indexOf(t) < 0 && !(t === cur && s.typePicked);                  // their own choice stays; the note says it does not match
      return '<option value="' + esc(t) + '"' + (off ? ' disabled' : '') + '>' + esc(t) + (off ? ' \u2014 not ' + (h.famName && famOf(t) !== h.famName.toLowerCase() ? h.famName.toLowerCase() + ' (' + famOf(t) + ' only)' : 'what you described') : '') + '</option>';
    }).join('');
    sel.value = cur && (!fit || fit.indexOf(cur) >= 0 || s.typePicked) ? cur : '';
    var fire = function (v) { sel.value = v; s.typeAuto = v || null; s.autoChange = true; try { sel.dispatchEvent(new Event('change')); } finally { s.autoChange = false; } return true; };
    if (!sel.value && fit && fit.length === 1) return fire(fit[0]);                        // only one kind fits the description: pick it
    if (cur && !sel.value) return fire('');                                                // the type we picked earlier no longer fits
    return false;
  }
  // the note under the description: what it suggested, or why it does not fit what was chosen
  function describeNote(p) {
    var s = state[p], h = s.hint, note = $(p + 'Narrow'); if (!note) return;
    if (s.locked || !h) { note.innerHTML = ''; note.hidden = true; return; }
    var t = typeVal(p), r = typeRule(p), parts = [];
    var showAll = s.offKey === h.key;
    if (h.types && !h.types.length) parts.push('We do not make ' + esc([h.famName && h.famName.toLowerCase(), h.wordTypes.length ? h.wordTypes.map(function (x) { return x.toLowerCase(); }).join(' / ') : 'that item'].filter(Boolean).join(' ')) + ': die-cast parts are aluminum, forged parts and fittings / valves are brass. Choose what fits, or ask our staff.');
    else if (h.types && t && h.types.indexOf(t) < 0) parts.push('Your description says <b>' + esc(h.famName || h.wordTypes.join(', ')) + '</b>, but <b>' + esc(t) + '</b> is ' + esc(r && r.materials[0] ? r.materials[0].split(' ')[0].toLowerCase() : 'different') + '. Check the description or the item type.');
    else if (h.types && h.types.length) parts.push((s.typeAuto && t === s.typeAuto && !s.typePicked ? 'Item type picked from your description: <b>' + esc(t) + '</b>. ' : '') +
      'Your description fits <b>' + esc(h.types.join(' or ')) + '</b>' + (h.types.length < (s.options.itemTypes || []).length && !showAll ? '; the other item types are switched off.' : '.'));
    if (h.pick && $(p + 'S_material').value === h.pick && !s.picked) parts.push('Material pre-selected: <b>' + esc(h.pick) + '</b>.');
    var canWiden = h.types && h.types.length && h.types.length < (s.options.itemTypes || []).length && !showAll;
    note.innerHTML = parts.length ? '<span>' + parts.join(' ') + ' You can change any of it.</span>' + (canWiden ? '<button type="button" class="qx-link" data-showall>Show all item types</button>' : '') : '';
    note.hidden = !parts.length;
  }
  function rebuildAll(p, dependentsOnly) {
    FIELDS.forEach(function (f) { if (!dependentsOnly || ['size', 'thickness', 'finish', 'service'].indexOf(f[0]) >= 0) rebuild(p, f[0]); });
  }
  function updateAvailability(p) {
    FIELDS.forEach(function (f) {
      var sel = $(p + 'S_' + f[0]); if (!sel) return;
      var valid = Array.prototype.filter.call(sel.options, function (x) { return x.value && x.value !== OTHER; }).length;
      var empty = sel.parentNode.querySelector('.qx-empty');
      if (!valid && !empty) { empty = document.createElement('small'); empty.className = 'qx-empty q-hint'; sel.parentNode.appendChild(empty); }
      var typeOnly = !valid && !!sel.querySelector('option[value="' + OTHER + '"]'), tr = f[0] === 'size' ? typedRule(p, 'size') : null;
      if (empty) { empty.textContent = valid ? '' : typeOnly ? (tr ? 'Made to order \u2014 type the size below.' : 'Type it below.') : 'No predefined options. Contact staff for a custom specification.'; empty.hidden = !!valid; }
      sel.setAttribute('aria-label', f[1] + (valid ? ' (' + valid + ' available)' : ' (no predefined options)'));
    });
  }
  function refresh(p) {
    var s = state[p]; if (!s) return;
    if (s.locked) { $(p + 'Narrow').hidden = true; return; }                             // a catalog product decides every detail
    var h = detect(p), changed = (s.hint && s.hint.key) !== (h && h.key); s.hint = h;
    var msel = $(p + 'S_material'), note = $(p + 'Narrow'), pre = '';
    if (changed) s.picked = false;                                                            // a new description starts afresh
    if (rebuildType(p)) return;                                                               // the item type changed: its change handler rebuilt everything
    rebuild(p, 'material');
    if (h && h.pick && !s.picked && !msel.getAttribute('data-filled') && msel.value !== h.pick && Array.prototype.some.call(msel.options, function (x) { return x.value === h.pick; })) { msel.value = h.pick; pre = h.pick; }
    else if (h && h.pick && !s.picked && msel.value === h.pick && !msel.getAttribute('data-filled')) pre = h.pick;       // only until the person picks a material themselves
    rebuildAll(p, false);
    void note; void pre;
    describeNote(p);
    updateAvailability(p);
  }

  // ---- checks -------------------------------------------------------------------------------------------------------------
  function neededNote(p) {
    var el = $(p + 'Needed'), hint = $(p + 'NeededHint'), lim = limits(state[p].options);
    if (!el.value || el.value < lim.min || el.value > lim.max) { hint.textContent = 'Pick a date from ' + dayText(lim.min) + ' up to ' + dayText(lim.max) + '.'; return; }
    var days = Math.round((new Date(el.value + 'T00:00:00') - new Date(lim.min + 'T00:00:00')) / 864e5) + 1;
    hint.textContent = days < 7 ? 'About ' + days + (days === 1 ? ' day' : ' days') + ' from today.' : 'About ' + Math.round(days / 7) + (Math.round(days / 7) === 1 ? ' week' : ' weeks') + ' from today.';
  }
  function setErr(p, field, msg) {
    var box = $(p + 'E_' + field); if (box) box.textContent = msg || '';
    var el = field === 'quantity' ? $(p + 'Qty') : field === 'neededBy' ? $(p + 'Needed') : field === 'notes' ? $(p + 'Notes') : $(p + 'S_' + field);
    if (el) el.classList.toggle('is-bad', !!msg);
    var bx = $(p + 'X_' + field);
    if (bx) {
      Array.prototype.forEach.call(bx.querySelectorAll('input'), function (i) { i.classList.remove('is-bad'); i.removeAttribute('aria-invalid'); });
      if (msg && !bx.hidden) { var bp = boxProblem(p, field), bad = bp && bp.el; Array.prototype.forEach.call(bad ? [bad] : bx.querySelectorAll('input[data-n]'), function (i) { if (!bp && !i.value.trim()) return; i.classList.add('is-bad'); i.setAttribute('aria-invalid', 'true'); }); }
      if (el && msg && !bx.hidden) el.classList.remove('is-bad');                         // the dropdown is right; it is what was typed
    }
    return !msg;
  }
  function rule(p, field) {
    if (field === 'itemType') return !state[p].options.itemTypes || state[p].locked || $(p + 'S_itemType').value ? '' : 'Choose what kind of item you need.';
    if (field === 'quantity') {
      var v = $(p + 'Qty').value.replace(/,/g, '').trim(); if (!v) return 'Enter the quantity you need.';
      var n = Number(v); if (!isFinite(n) || n <= 0) return 'Enter a number greater than 0, e.g. 200.';
      if (n > 1000000) return 'That is too large. Enter up to 1,000,000.';
      if (wholeUnit(p) && !Number.isInteger(n)) return 'Use a whole number for ' + $(p + 'Unit').value + ', e.g. 200.';
      if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return 'Use at most 2 decimals.';
      var mq = state[p].options.minQty; if (mq && !state[p].locked && n < mq) return 'The minimum order for a custom item is ' + mq + ' ' + $(p + 'Unit').value + '.';
      return '';
    }
    if (field === 'neededBy') {
      var d = $(p + 'Needed').value, lim = limits(state[p].options), flex = state[p].flexible;
      if (!d) return (flex && flex()) ? '' : 'Choose the date you need it.';
      var q = Number(($(p + 'Qty').value || '').replace(/,/g, '').trim()) || 0;
      var lead = leadForQty(q);
      if (d < lead.minDate) {
        if (q > 100) return 'Orders over 100 units require at least ' + lead.days + ' working days for fabrication & QC. Please choose ' + dayText(lead.minDate) + ' or later.';
        return 'Choose a date from ' + dayText(lead.minDate) + ' or later.';
      }
      if (d > lim.max) return 'Choose a date within the next 6 months (up to ' + dayText(lim.max) + ').';
      return '';
    }
    if (field === 'notes') return $(p + 'Notes').value.length > 1000 ? 'Keep notes within 1,000 characters.' : '';
    var label = FIELDS.filter(function (f) { return f[0] === field; })[0][1].toLowerCase(), v2 = $(p + 'S_' + field).value;
    if (!state[p].locked && state[p].options.itemTypes && !typeVal(p)) return '';           // "choose the item type" is the one message until then
    if (!v2) return 'Choose the ' + label + '.';
    if (v2 === OTHER) { compose(p, field); var bp = boxProblem(p, field); if (bp) return bp.msg;
      var t = $(p + 'C_' + field).value.trim(), tr = typedRule(p, field);
      if (tr) {
        if (!(t.length >= 2 && t.length <= 40 && CUSTOM_RE.test(t) && tr.re.test(t))) return 'Type the size as ' + tr.hint + '.';
        if (/^Fitting/.test(typeVal(p)) && PIPE_SIZES_IN(t, state[p].options)) return 'That is a standard size: choose ' + PIPE_SIZES_IN(t, state[p].options) + ' from the list above.';
        var n = sizeMm(t);                                                           // same limits as the server
        if (n.some(function (x) { return !(x > 0); })) return 'Each dimension must be more than 0.';
        if (tr.maxMm && n.some(function (x) { return x > tr.maxMm; })) return 'Parts larger than ' + tr.maxMm + ' mm are quoted by our staff.';
        if (tr.maxIn && n.some(function (x) { return x > tr.maxIn * 25.4 + 0.01; })) return 'Fittings are made up to ' + tr.maxIn + '" (50 mm).';
        return '';
      }
      if (field === 'thickness') {
        var tm = /^(\d+(?:\.\d+)?)\s*mm$/i.exec(t); if (!tm) return 'Type the thickness in mm, e.g. 2.5 mm.';
        var mat = $(p + 'S_material').value, lims = state[p].options.thicknessLimits || {}, lim = lims[mat] || lims[''];
        if (lim && (+tm[1] < lim.min || +tm[1] > lim.max)) return (lims[mat] ? mat : 'These parts') + ' are made ' + lim.min + ' to ' + lim.max + ' mm thick. Type a thickness in that range.';
        return '';
      }
      return t.length >= 2 && t.length <= 40 && (!NEEDS_NUMBER[field] || /\d/.test(t)) && CUSTOM_RE.test(t) && !/[<>]/.test(t) ? '' : NEEDS_NUMBER[field] ? 'Type the ' + label + ' with its number, ' + CUSTOM_HINT[field] + '.' : 'Type the ' + label + ' (2 to 40 letters or numbers), ' + CUSTOM_HINT[field] + '.'; }
    // required per item type (same rule as the server): a part typed as length x width only cannot be priced without its wall thickness
    if (field === 'thickness' && !/\d\s*mm$/i.test(v2) && needsWall(p)) return 'A size with only length and width needs the wall thickness too. Choose it, or type it in mm.';
    return '';
  }
  function needsWall(p) {
    var r = typeRule(p), sel = $(p + 'S_size'); if (!r || !r.thicknessFor2D || !sel || state[p].locked) return false;
    var v = sel.value === OTHER ? ($(p + 'C_size') ? $(p + 'C_size').value.trim() : '') : sel.value;
    return !!v && (r.sizes || []).indexOf(v) < 0 && !/^[\u00D8\u00F8\u2300]/.test(v) && sizeMm(v).length === 2;
  }
  // what the stock records say about the chosen material / finish (options.inventory comes from the server)
  function stockNote(p, field) {
    var el = $(p + 'Stock_' + field), sel = $(p + 'S_' + field), inv = state[p] && state[p].options.inventory; if (!el || !sel) return;
    var e = inv && inv[field === 'material' ? 'materials' : 'finishes'] ? inv[field === 'material' ? 'materials' : 'finishes'][sel.value] : null;
    if (!sel.value || !e || e.free || state[p].locked) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false; el.setAttribute('data-stock', e.status);
    el.textContent = e.status === 'out' ? 'Not on the shelf right now. We order it first, so this may take longer.' : 'Available in our stock.';
  }
  function check(p, field) { if (field === 'material' || field === 'finish') stockNote(p, field); return setErr(p, field, rule(p, field)); }
  // a typed pipe size that is already in the list ("1 in" -> 1") — pick it from the list instead, so the request is not "custom"
  function PIPE_SIZES_IN(t, o) {
    var m = /^\s*([\d.\/\- ]+?)\s*(in|inch|inches|")\s*$/i.exec(t); if (!m) return '';
    var v = m[1].trim().replace(/\s+/, '-'), r = o.itemRules && o.itemRules['Fitting / valve'];
    return r && r.sizes.indexOf(v + '"') >= 0 ? v + '"' : '';
  }
  // the numbers inside a typed size, in mm ("1-1/4 in" -> 31.75); mirrors sizeNumbersMm in shop-extras.js
  function sizeMm(v) {
    var u = (/(mm|cm|inches|inch|in|")\s*$/i.exec(v) || [])[1] || 'mm', f = /^mm$/i.test(u) ? 1 : /^cm$/i.test(u) ? 10 : 25.4;
    return (v.replace(/(mm|cm|inches|inch|in|")\s*$/i, '').match(/\d+(?:[-\s]\d+\/\d+|\/\d+|\.\d+)?/g) || []).map(function (t) {
      var mx = /^(\d+)[-\s](\d+)\/(\d+)$/.exec(t), fr = /^(\d+)\/(\d+)$/.exec(t);
      return (mx ? +mx[1] + mx[2] / mx[3] : fr ? fr[1] / fr[2] : +t) * f;
    });
  }

  // checks everything; returns { ok, focus } where focus is the id of the first field that needs attention (top to bottom)
  function validate(p) {
    var first = null, order = [['itemType', p + 'S_itemType']].concat(FIELDS.map(function (f) { return [f[0], p + 'S_' + f[0]]; })).concat([['quantity', p + 'Qty'], ['neededBy', p + 'Needed'], ['notes', p + 'Notes']]);
    order.forEach(function (x) { if (!check(p, x[0]) && !first) first = x[1]; });
    return { ok: !first, focus: first };
  }
  function read(p) {
    var specs = {};
    FIELDS.forEach(function (f) { var v = $(p + 'S_' + f[0]).value; if (v === OTHER) compose(p, f[0]); specs[f[0]] = v === OTHER ? $(p + 'C_' + f[0]).value.trim() : v; });
    return { itemType: typeVal(p) || undefined, quantity: $(p + 'Qty').value.replace(/,/g, '').trim(), quantityUnit: $(p + 'Unit').value, neededBy: $(p + 'Needed').value || undefined, specs: specs, notes: $(p + 'Notes').value.trim() || undefined };
  }
  function reset(p) {
    var s = state[p], lim = limits(s.options);
    $(p + 'Qty').value = ''; $(p + 'Needed').value = ''; $(p + 'Needed').min = lim.min; $(p + 'Needed').max = lim.max; neededNote(p);
    $(p + 'Notes').value = ''; $(p + 'NotesCount').textContent = '0 / 1000';
    autofill(p, null);
    var ity = $(p + 'S_itemType'); if (ity) { ity.value = ''; var tn = $(p + 'TypeNote'); if (tn) tn.textContent = ''; }
    var cl = $(p + 'Cleared'); if (cl) { cl.innerHTML = ''; cl.hidden = true; }
    FIELDS.forEach(function (f) { $(p + 'S_' + f[0]).value = ''; var c = $(p + 'C_' + f[0]); if (c) { clearTyped(p, f[0]); typedMode(p, f[0], false); } });
    s.picked = false; s.offKey = null; s.unitTouched = false; s.typePicked = false; s.typeAuto = null; s.typedKind = ''; refresh(p); syncUnits(p);
    ['quantity', 'neededBy', 'itemType'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { setErr(p, k, ''); });
  }
  // show the server's message under the matching field; returns true if it belonged here
  function showServerError(p, fields) {
    var shown = false; fields = fields || {};
    ['quantity', 'neededBy', 'notes', 'itemType'].concat(FIELDS.map(function (f) { return f[0]; })).forEach(function (k) { if (fields[k]) { setErr(p, k, fields[k]); shown = true; } });
    return shown;
  }
  // pick the unit of the chosen catalog product (adds it to the list if the list does not have it)
  function setUnit(p, unit) {
    var sel = $(p + 'Unit'); if (!sel || !unit) return; var u = String(unit).toLowerCase();
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === u; });
    if (!has) { var o = document.createElement('option'); o.value = u; o.textContent = u; sel.appendChild(o); }
    sel.value = u; sel.disabled = true; sel.title = 'Sold per ' + u + ' (set by the product)';
    var q = $(p + 'Qty'); if (q && wholeUnit(p)) q.value = q.value.replace(/\..*$/, '');
  }
  // A catalog product is a ready-made finished good (forged brass, die-cast aluminum...). Its Material / Size / Thickness / Finish come from the
  // product's own record and are LOCKED: nothing to choose or retype. A value the record does not have shows "Not specified"; the material is read
  // from the product name when it names one (brass, aluminum, ADC12...). Machining / secondary work is always "None (as is)". The server applies the same rule
  // (readQuote in shop-extras.js), so what is locked here is what is saved. Call with the product's specs object, or with nothing (custom item) to
  // unlock everything and clear what a product filled in.
  var ALIAS = { material: ['material'], size: ['size', 'dimensions'], thickness: ['thickness'], finish: ['finish'] };
  var NOT_SET = 'Not specified', AS_IS = 'None (as is)';
  function lockNote(p, sel, text) {
    var k = sel.id.slice((p + 'S_').length), note = $(p + 'A_' + k);
    if (!note) { note = document.createElement('small'); note.id = p + 'A_' + k; note.className = 'q-hint'; sel.parentNode.insertBefore(note, sel.nextSibling); }
    note.textContent = text || ''; note.hidden = !text;
  }
  function setLocked(p, k, v, why) {
    var sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel) return;
    var has = Array.prototype.some.call(sel.options, function (x) { return x.value === v; }), added = sel.getAttribute('data-added');
    if (added && added !== v) { Array.prototype.forEach.call(sel.options, function (x) { if (x.value === added) x.remove(); }); sel.removeAttribute('data-added'); }
    if (!has) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); sel.setAttribute('data-added', v); }
    sel.value = v; sel.setAttribute('data-filled', '1'); sel.disabled = true;
    if (c) { clearTyped(p, k); typedMode(p, k, false); }
    sel.parentNode.classList.remove('qx-wait'); sel.parentNode.classList.add('qx-locked');
    lockNote(p, sel, why); setErr(p, k, '');
  }
  function unlock(p, k) {
    var sel = $(p + 'S_' + k), c = $(p + 'C_' + k); if (!sel) return;
    var added = sel.getAttribute('data-added');
    sel.disabled = false; sel.parentNode.classList.remove('qx-locked', 'qx-required');
    if (sel.getAttribute('data-filled')) { sel.value = ''; sel.removeAttribute('data-filled'); }
    if (added) { Array.prototype.forEach.call(sel.options, function (x) { if (x.value === added) x.remove(); }); sel.removeAttribute('data-added'); }
    if (c) { clearTyped(p, k); typedMode(p, k, false); }
    lockNote(p, sel, ''); setErr(p, k, '');
  }
  function autofill(p, specs) {
    var s = state[p]; if (!s) return;
    var banner = $(p + 'Locked'), unit = $(p + 'Unit');
    if (specs === null) {                                                                          // custom item: everything is editable again (a catalog product with no specs object still locks)
      s.locked = false; s.catalogType = null;
      FIELDS.forEach(function (f) { unlock(p, f[0]); });
      if (banner) banner.hidden = true;
      if (unit) { unit.disabled = false; unit.title = ''; }
      var tw = $(p + 'TypeWrap'); if (tw) tw.hidden = false;
      s.picked = false; refresh(p); syncUnits(p); return;
    }
    s.locked = true;
    var tw2 = $(p + 'TypeWrap'); if (tw2) { tw2.hidden = true; setErr(p, 'itemType', ''); }        // a ready-made product has no "kind of item" to choose
    var cl2 = $(p + 'Cleared'); if (cl2) { cl2.innerHTML = ''; cl2.hidden = true; }
    specs = specs || {};
    var lower = {}; Object.keys(specs).forEach(function (k) { lower[k.trim().toLowerCase()] = String(specs[k] == null ? '' : specs[k]).trim(); });
    var h = detect(p), fromName = h && (h.pick || h.famName);              // a grade in the name (ADC12) gives the exact material; a name that only says "brass" gives "Brass"
    // what kind of item the product is (from its name), so a detail its record leaves out offers the right choices
    s.catalogType = h && h.types && h.types.length === 1 ? h.types[0] : null;
    Object.keys(ALIAS).forEach(function (k) {
      var v = ALIAS[k].map(function (a) { return lower[a]; }).filter(Boolean)[0], why = 'From the product record. Locked.';
      if (!v && k === 'material' && fromName) { v = fromName; why = 'Read from the product name. Locked.'; }
      if (!v) { v = NOT_SET; why = 'Not stated on the product record. Sold as is.'; }
      setLocked(p, k, v, why);
    });
    updateAvailability(p);
    setLocked(p, 'service', AS_IS, 'Ready-made item, sold as is. Locked.');
    if (banner) banner.hidden = false;
    $(p + 'Narrow').hidden = true;
  }
  // small setters the pages call (Shop_Customer.html: price hint under Quantity, "delivery quote" prefill of quantity and notes)
  function setHint(p, text) { var h = $(p + 'QtyHint'); if (h) h.textContent = text || ''; }
  function setQuantity(p, n) { $(p + 'Qty').value = n == null ? '' : String(n); }
  function setNotes(p, text) { $(p + 'Notes').value = text || ''; $(p + 'NotesCount').textContent = ($(p + 'Notes').value.length) + ' / 1000'; }

  var st = document.createElement('style');
  st.textContent = '.qx-row{display:flex;gap:8px}.qx-row input{flex:1 1 auto;min-width:0}.qx-row select{flex:0 0 38%;min-width:0}' +
    '.qx-title{margin:6px 0 10px;font-size:13.5px;font-weight:700;color:var(--text-dim)}.qx-custom{margin-top:8px}' +
    '.qx-typed{margin-top:8px;padding:10px;border:1px dashed var(--border);border-radius:9px;background:var(--inset)}.qx-dims{display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap}' +
    '.qx-dims>b{padding-bottom:10px;color:var(--text-faint);font-weight:600}.qx-dim{display:flex;flex-direction:column;gap:4px;flex:1 1 64px;min-width:64px;margin:0}' +
    '.qx-dim span{font-size:11.5px;font-weight:650;color:var(--text-faint);text-transform:none;letter-spacing:0}.qx-dim i{font-style:normal;font-weight:500}.qx-dim input,.qx-dim select{width:100%;min-height:38px}' +
    '.qx-unit{flex:0 0 96px;min-width:96px}.q-grid>.q-field.qx-wide{grid-column:1/-1}.qx-suffix{padding-bottom:10px;font-weight:650;color:var(--text-dim)}.qx-typed .q-hint{display:block;margin-top:6px}' +
    '.qx-wait select{opacity:.6;cursor:not-allowed}.qx-required>label:after{content:" *";color:var(--red)}.qx-required .q-hint{color:var(--amber)}' +
    '.qx-narrow{margin:-4px 0 12px;font-size:12.5px;color:var(--text-faint)}.qx-narrow b{color:var(--text-dim);font-weight:600}' +
    '.qx-est{margin:2px 0 14px;padding:12px 14px;border:1px solid var(--blue-bright);border-radius:10px;background:var(--inset);display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--text-dim)}' +
    '.qx-est.is-wait{border-color:var(--border);border-style:dashed}.qx-est-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px}.qx-est-head b{color:var(--text);font-size:13.5px}' +
    '.qx-est-head strong{font-size:19px;color:var(--blue-bright);font-weight:750}.qx-est small{color:var(--text-faint);font-size:12px}.qx-est-how summary{cursor:pointer;color:var(--blue-bright);font-weight:600;margin-top:2px}' +
    '.qx-est.is-short{border-color:var(--amber)}.qx-short{color:var(--amber);font-style:normal;font-weight:650}.qx-est-how i{font-style:normal;color:var(--text-faint)}' +
    '.qx-est-how ul{list-style:none;margin:6px 0 0;padding:0}.qx-est-how li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dashed var(--border)}.qx-est-how li b{white-space:nowrap;color:var(--text)}.qx-est-how li.sum{font-weight:650;color:var(--text)}' +
    '.qx-link{background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 9px;margin:4px 0 0 6px;font:inherit;font-weight:650;color:var(--blue-bright);cursor:pointer;min-height:30px}.qx-link:hover,.qx-link:focus-visible{background:var(--hover);border-color:var(--blue-bright);outline-offset:2px}.qx-narrow{padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--inset);line-height:1.6}.qx-empty{display:block;margin-top:6px}.q-field select{width:100%;max-width:100%;min-height:40px}.q-grid{min-width:0}.q-field{min-width:0}@media(max-width:600px){.qx-narrow{padding:9px}.qx-link{display:inline-block;margin-left:0}}';
  document.head.appendChild(st);

  window.QuoteFields = { estimate: estimate, mount: mount, read: read, validate: validate, reset: reset, showServerError: showServerError, setUnit: setUnit, autofill: autofill, setHint: setHint, setQuantity: setQuantity, setNotes: setNotes };
})();
