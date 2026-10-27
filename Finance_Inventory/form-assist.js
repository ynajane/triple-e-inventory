/* form-assist.js — Task 9: small helpers every form uses the same way (Finance, POS, online shop, sign-up).

   FormAssist.validation.bind(input, rule, errorBox)   live field feedback; rule returns a message or ''
   FormAssist.validation.show(input, message)          display a server or submit error beside the field
   FormAssist.phone.format(raw)          '0917-123-4567' -> '+63 917 123 4567'  (the one stored format; '' when it is not a PH number)
   FormAssist.phone.bind(input)          rewrites the box in that format when the person leaves it
   FormAssist.email.suggest(email)       'juan@gmial.com' -> 'juan@gmail.com'   ('' when nothing looks mistyped)
   FormAssist.email.bind(input)          shows "Did you mean …? Use it" under the box
   FormAssist.similar(name, items, key)  near-duplicate names ("did you mean…"), best first; exact matches are left to the duplicate check
   FormAssist.note(input, html, kind)    a small note under a field (kind: 'warn' | 'ok' | 'info'); html '' removes it
   FormAssist.guard(form, o)             warns before unsaved changes are lost (modal close / Escape / leaving the page)
   FormAssist.markClean(form)            after a successful save
   FormAssist.keyboard(form)             Enter moves to the next field, Enter on the last one (or Ctrl+Enter anywhere) submits
   FormAssist.draft(key, form, ids)      keeps a draft in this browser while typing and offers it back next time
   FormAssist.zipFill(o)                 a "ZIP code" box that fills Region > Province > City > Barangay from backend/data/ph-zip.json
   Nothing here replaces the server's checks; it only gives earlier, friendlier feedback. */
(function () {
  'use strict';
  if (window.FormAssist) return;
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var css = '.fa-note{margin-top:5px;font-size:12.5px;line-height:1.45;color:var(--text-dim,var(--text-faint,#8aa0b2))}' +
    '.fa-note.warn{color:#d9a03f}.fa-note.ok{color:#5fbf8a}' +
    '.fa-note button.fa-link{background:none;border:0;padding:0 2px;font:inherit;font-weight:600;color:var(--blue-bright,#4a90d9);text-decoration:underline;cursor:pointer}' +
    '.fa-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
    '.fa-chip{border:1px solid var(--border,#2a4458);background:transparent;color:inherit;border-radius:14px;padding:3px 10px;font-size:12.5px;cursor:pointer}' +
    '.fa-chip:hover{border-color:var(--blue-bright,#4a90d9)}' +
    '.fa-zip{margin:0 0 10px}.fa-zip label{display:block;font-size:12.5px;font-weight:600;margin-bottom:4px}' +
    '.fa-zip input{max-width:140px}' +
    '.fa-draft{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px;padding:8px 12px;border-radius:8px;font-size:13px;' +
    'background:rgba(74,144,217,.1);border:1px solid rgba(74,144,217,.35)}' +
    '.fa-unit{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text-dim,#8aa0b2)}' +
    '.fa-onhand{float:right;font-weight:500;font-size:12px;color:var(--text-dim,var(--text-faint,#8aa0b2))}';
  var st = document.createElement('style'); st.id = 'formAssistStyles'; st.textContent = css; document.head.appendChild(st);

  /* ---------- notes under a field ---------- */
  function holder(input) { return input.closest('.form-group, .q-field, .field, .fa-host') || input.parentNode; }
  function note(input, html, kind, slot) {
    if (!input) return null;
    var h = holder(input), id = (input.id || 'x') + (slot ? '-' + slot : '');
    var n = h.querySelector('.fa-note[data-fa="' + id + '"]');
    if (!html) { if (n) n.remove(); return null; }
    if (!n) { n = document.createElement('div'); n.className = 'fa-note'; n.dataset.fa = id; n.setAttribute('role', 'status'); h.appendChild(n); }
    n.className = 'fa-note' + (kind ? ' ' + kind : '');
    n.innerHTML = html;
    return n;
  }
  // value set by a helper: tell the page's own listeners (validation, totals), and count it as an edit
  function setValue(input, v) {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    var f = input.form || input.closest('form'); if (f) f.dataset.faDirty = '1';
  }

  /* ---------- phone: one format ---------- */
  // mobiles: +63 917 123 4567 ; Metro Manila landline: +63 2 8123 4567 ; provincial landline: +63 32 123 4567
  function formatPhone(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || /[^\d+\s().-]/.test(s)) return '';
    var d = s.replace(/\D/g, ''), n;
    if (/^\+?63/.test(s.replace(/[\s().-]/g, ''))) n = d.slice(2);
    else if (d.charAt(0) === '0') n = d.slice(1);
    else if (d.charAt(0) === '9' && d.length === 10) n = d;
    else return '';
    if (/^9\d{9}$/.test(n)) return '+63 ' + n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6);
    if (/^2\d{8}$/.test(n)) return '+63 2 ' + n.slice(1, 5) + ' ' + n.slice(5);
    if (/^[3-8]\d{8}$/.test(n)) return '+63 ' + n.slice(0, 2) + ' ' + n.slice(2, 5) + ' ' + n.slice(5);
    return '';
  }
  function bindPhone(input) {
    if (!input || input.dataset.faPhone) return;
    input.dataset.faPhone = '1';
    input.addEventListener('blur', function () {
      var f = formatPhone(input.value);
      if (f && f !== input.value) setValue(input, f);
    });
  }

  /* ---------- email: typo hints ---------- */
  var DOMAINS = ['gmail.com', 'yahoo.com', 'yahoo.com.ph', 'outlook.com', 'hotmail.com', 'icloud.com', 'live.com', 'ymail.com', 'proton.me', 'protonmail.com', 'outlook.ph', 'aol.com', 'msn.com'];
  var TLD_FIX = { con: 'com', cmo: 'com', ocm: 'com', vom: 'com', xom: 'com', comm: 'com', coom: 'com', cpm: 'com', om: 'com', 'co,': 'com', hp: 'ph', 'ph.': 'ph' };
  function dist(a, b) {                                           // edit distance; a swapped pair of letters counts as one
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  function suggestEmail(email) {
    var m = /^([^\s@]+)@([^\s@]+)$/.exec(String(email || '').trim().toLowerCase());
    if (!m) return '';
    var local = m[1], domain = m[2].replace(/\.+$/, '');
    if (DOMAINS.indexOf(domain) >= 0) return '';
    var parts = domain.split('.'), tld = parts[parts.length - 1];
    if (parts.length > 1 && TLD_FIX[tld]) { parts[parts.length - 1] = TLD_FIX[tld]; domain = parts.join('.'); if (DOMAINS.indexOf(domain) >= 0) return local + '@' + domain; }
    if (parts.length === 1) { var bare = DOMAINS.filter(function (d) { return d.split('.')[0] === domain; })[0]; if (bare) return local + '@' + bare; }
    var best = '', bestD = 9;
    DOMAINS.forEach(function (d) { var x = dist(domain, d); if (x < bestD) { bestD = x; best = d; } });
    if (best && bestD > 0 && bestD <= (domain.length >= 9 ? 2 : 1)) return local + '@' + best;
    return parts.length > 1 && TLD_FIX[tld] ? local + '@' + domain : '';
  }
  function bindEmail(input) {
    if (!input || input.dataset.faEmail) return;
    input.dataset.faEmail = '1';
    var timer = null;
    var show = function () {
      var s = suggestEmail(input.value);
      var n = note(input, s ? 'Did you mean <b>' + esc(s) + '</b>? <button type="button" class="fa-link">Use it</button>' : '', 'warn', 'mail');
      if (n) n.querySelector('button').onclick = function () { setValue(input, s); note(input, '', '', 'mail'); input.focus(); };
    };
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(show, 500); });
    input.addEventListener('blur', function () { clearTimeout(timer); show(); });
  }

  /* ---------- near-duplicate names ---------- */
  var normName = function (v) { return String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); };
  function similar(name, items, key) {
    var a = normName(name); if (a.length < 3) return [];
    var at = a.split(' ');
    return (items || []).map(function (it) {
      var b = normName(key ? key(it) : it); if (!b || b === a) return null;
      var bt = b.split(' '), common = at.filter(function (w) { return bt.indexOf(w) >= 0; }).length;
      var jac = common / (at.length + bt.length - common);
      var ratio = 1 - dist(a, b) / Math.max(a.length, b.length);
      var inside = Math.min(a.length, b.length) >= 5 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
      var score = Math.max(ratio, jac, inside ? 0.8 : 0);
      return score >= 0.75 ? { item: it, score: score } : null;
    }).filter(Boolean).sort(function (x, y) { return y.score - x.score; }).slice(0, 3).map(function (x) { return x.item; });
  }

  /* ---------- unsaved changes ---------- */
  var guarded = [];
  function isDirty(f) { return f.dataset.faDirty === '1'; }
  function markClean(f) { if (f) delete f.dataset.faDirty; }
  var ask = function () {
    var o = { title: 'Discard your changes?', message: 'What you typed in this form has not been saved yet.', confirm: 'Discard changes', cancel: 'Keep editing', danger: true };
    return window.uiConfirm ? window.uiConfirm(o) : Promise.resolve(window.confirm(o.title + ' ' + o.message));
  };
  // o: { overlay: element (a modal) , closeSelector: buttons that close it, close: function that closes it }
  function guard(form, o) {
    if (!form || form.dataset.faGuard) return;
    form.dataset.faGuard = '1';
    o = o || {};
    var g = { form: form, overlay: o.overlay || null,
      isOpen: o.isOpen || (o.overlay ? function () { return o.overlay.classList.contains('open'); } : function () { return form.offsetParent !== null; }) };
    guarded.push(g);
    var touch = function (e) { if (e.isTrusted && !(e.target && e.target.dataset && e.target.dataset.faIgnore)) form.dataset.faDirty = '1'; };
    form.addEventListener('input', touch);
    form.addEventListener('change', touch);
    form.addEventListener('reset', function () { markClean(form); });
    if (!o.overlay) return;
    var wasOpen = g.isOpen();
    new MutationObserver(function () { var now = g.isOpen(); if (now !== wasOpen) markClean(form); wasOpen = now; })   // opened or closed: start clean
      .observe(o.overlay, { attributes: true, attributeFilter: ['class', 'hidden'] });
    var confirmClose = function (e) {
      if (!g.isOpen() || !isDirty(form)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      ask().then(function (ok) { if (ok) { markClean(form); o.close(); } });
    };
    // capture phase: runs before the page's own close handlers
    document.addEventListener('click', function (e) {
      if (e.target === o.overlay || (o.closeSelector && e.target.closest && e.target.closest(o.closeSelector) && o.overlay.contains(e.target))) confirmClose(e);
    }, true);
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || document.querySelector('.uic-overlay')) return;
      var a = document.activeElement;
      if (a && a.getAttribute && a.getAttribute('aria-expanded') === 'true') return;    // Escape closes an open search list first
      confirmClose(e);
    }, true);
  }
  window.addEventListener('beforeunload', function (e) {
    if (guarded.some(function (g) { return isDirty(g.form) && g.isOpen() && document.contains(g.form); })) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ---------- keyboard flow ---------- */
  function fields(form) {
    return [].filter.call(form.querySelectorAll('input, select, textarea, button[type="submit"]'), function (x) {
      return !x.disabled && !x.readOnly && x.type !== 'hidden' && x.type !== 'file' && x.tabIndex >= 0 && x.offsetParent !== null;
    });
  }
  function keyboard(form) {
    if (!form || form.dataset.faKeys) return;
    form.dataset.faKeys = '1';
    form.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return;
      var t = e.target;
      if ((e.ctrlKey || e.metaKey) && form.requestSubmit) { e.preventDefault(); form.requestSubmit(); return; }
      if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.type === 'checkbox' || t.type === 'radio' || t.getAttribute('list') || t.getAttribute('aria-expanded') === 'true') return;
      var list = fields(form), i = list.indexOf(t);
      if (i < 0) return;
      e.preventDefault();
      var next = list.slice(i + 1).filter(function (x) { return x.tagName !== 'BUTTON'; })[0];
      if (next) { next.focus(); if (next.select && next.tagName === 'INPUT') try { next.select(); } catch (_) { /* not selectable */ } }
      else if (form.requestSubmit) form.requestSubmit();
    });
  }

  /* ---------- drafts (this browser only) ---------- */
  var store = {
    get: function (k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode / full */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } }
  };
  // ids are saved and restored in this order (a select before the boxes that depend on it). o.banner = where the "draft restored" bar goes.
  function draft(key, form, ids, o) {
    o = o || {};
    var K = 'tripleE.draft.' + key, timer = null;
    var read = function () {
      var v = {}, any = false;
      ids.forEach(function (id) {
        var x = document.getElementById(id); if (!x) return;
        v[id] = x.type === 'checkbox' || x.type === 'radio' ? x.checked : x.value;
        if (x.type !== 'checkbox' && x.type !== 'radio' && String(x.value).trim() && !(o.ignoreDefault && o.ignoreDefault(id, x.value))) any = true;
      });
      return any ? v : null;
    };
    var save = function () { var v = read(); if (v) store.set(K, { at: Date.now(), v: v }); else store.del(K); };
    form.addEventListener('input', function (e) { if (e.isTrusted) { clearTimeout(timer); timer = setTimeout(save, 400); } });
    form.addEventListener('change', function (e) { if (e.isTrusted) { clearTimeout(timer); timer = setTimeout(save, 400); } });
    var api = {
      clear: function () { clearTimeout(timer); store.del(K); var b = form.querySelector('.fa-draft'); if (b) b.remove(); },
      restore: async function () {
        var d = store.get(K); if (!d || !d.v) return false;
        if (Date.now() - d.at > 14 * 864e5) { store.del(K); return false; }       // two weeks old: forget it
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i], x = document.getElementById(id); if (!x || !(id in d.v)) continue;
          if (x.type === 'checkbox' || x.type === 'radio') { if (x.checked !== d.v[id]) { x.checked = d.v[id]; x.dispatchEvent(new Event('change', { bubbles: true })); } continue; }
          if (d.v[id] === '' || x.value === d.v[id]) continue;
          if (x.tagName === 'SELECT') await waitFor(function () { return !x.disabled && [].some.call(x.options, function (op) { return op.value === d.v[id]; }); }, 4000);
          else await waitFor(function () { return !x.disabled; }, 4000);
          x.value = d.v[id];
          x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true }));
        }
        form.dataset.faDirty = '1';
        var bar = document.createElement('div');
        bar.className = 'fa-draft'; bar.setAttribute('role', 'status');
        bar.innerHTML = '<span>Your unsent draft from ' + esc(new Date(d.at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) + ' was filled back in.</span>' +
          '<button type="button" class="fa-link fa-chip">Start over</button>';
        bar.querySelector('button').onclick = function () { api.clear(); markClean(form); if (o.onDiscard) o.onDiscard(); };
        var at = o.banner || form;
        at.insertBefore(bar, at.firstChild);
        return true;
      }
    };
    return api;
  }

  /* ---------- ZIP -> address ---------- */
  function waitFor(test, ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() { var ok = false; try { ok = test(); } catch (_) { ok = false; } if (ok) return resolve(true); if (Date.now() - t0 > ms) return resolve(false); setTimeout(tick, 80); })();
    });
  }
  var placeNorm = function (v) {
    return String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\(.*?\)/g, ' ')
      .replace(/\bcity of\b|\bmunicipality of\b|\bcity\b|\bmunicipality\b|\bbarangay\b|\bbrgy\.?\b|\bpoblacion\b/g, ' ')
      .replace(/\bsta\.?\b/g, 'santa').replace(/\bsto\.?\b/g, 'santo').replace(/[^a-z0-9]+/g, ' ').trim();
  };
  function bestName(names, wanted) {
    var w = placeNorm(wanted); if (!w) return '';
    var exact = names.filter(function (n) { return placeNorm(n) === w; })[0];
    if (exact) return exact;
    var ws = w.split(' ').sort().join(' ');
    var same = names.filter(function (n) { return placeNorm(n).split(' ').sort().join(' ') === ws; })[0];     // "Bicutan Western" = "Western Bicutan"
    if (same) return same;
    var part = names.filter(function (n) { var x = placeNorm(n); return x && (x.indexOf(w) >= 0 || w.indexOf(x) >= 0); });
    return part.length === 1 ? part[0] : '';
  }
  function choices(el) {
    if (el.tagName === 'SELECT') return [].map.call(el.options, function (o) { return o.value; }).filter(Boolean);
    var list = el.list || (el.getAttribute('list') && document.getElementById(el.getAttribute('list')));
    return list ? [].map.call(list.options, function (o) { return o.value; }).filter(Boolean) : [];
  }
  // fills one level: waits until its list is loaded, picks the matching name and fires the events that load the next level
  async function fillLevel(el, wanted) {
    if (!el || !wanted) return false;
    var ready = await waitFor(function () { return (el.value && bestName([el.value], wanted)) || (!el.disabled && choices(el).length); }, 8000);
    if (!ready) return false;
    if (el.value && bestName([el.value], wanted)) return true;          // already right (NCR's province is set by itself)
    var name = bestName(choices(el), wanted);
    if (!name) return false;
    setValue(el, name);
    return true;
  }
  var zipCache = {};
  function lookupZip(zip, api) {
    if (zipCache[zip]) return Promise.resolve(zipCache[zip]);
    var get = api || function (u) { return fetch(u, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : { places: [] }; }); };
    return Promise.resolve(get('/api/geo/zip-lookup?zip=' + encodeURIComponent(zip))).then(function (r) { var p = (r && r.places) || []; if (p.length) zipCache[zip] = p; return p; });
  }
  /* o: { region, province, city, barangay, zip: elements; before: the element the ZIP box goes in front of; api: optional fetch helper;
          fill: optional async (place) => {} for widgets that are not plain select / datalist boxes; onFilled: (place) => {} } */
  function zipFill(o) {
    if (!o.before || o.before.dataset.faZip) return null;
    o.before.dataset.faZip = '1';
    var wrap = document.createElement('div');
    wrap.className = 'fa-zip fa-host';
    var id = 'faZip' + Math.random().toString(36).slice(2, 7);
    wrap.innerHTML = '<label for="' + id + '">Know the ZIP code? <span style="font-weight:400;opacity:.75">(fills the address for you)</span></label>' +
      '<input id="' + id + '" class="form-input" inputmode="numeric" maxlength="4" autocomplete="postal-code" placeholder="e.g. 1630" data-fa-ignore="1">';
    o.before.parentNode.insertBefore(wrap, o.before);
    var box = wrap.querySelector('input'), seq = 0;
    var apply = async function (place) {
      var my = ++seq;
      note(box, 'Filling in ' + esc([place.city, place.province].filter(Boolean).join(', ')) + '…', 'info');
      if (o.fill) await o.fill(place);
      else {
        if (!(await fillLevel(o.region, place.region))) { if (my === seq) note(box, 'Could not find the region for this ZIP. Choose it below.', 'warn'); return; }
        await fillLevel(o.province, place.province);
        if (!(await fillLevel(o.city, place.city))) { if (my === seq) note(box, 'Choose the city below (the ZIP list names it ' + esc(place.city) + ').', 'warn'); return; }
        if (place.barangay) await fillLevel(o.barangay, place.barangay);
      }
      if (my !== seq) return;
      if (o.zip) { await waitFor(function () { return !o.zip.disabled; }, 4000); if (!o.zip.value || o.zip.value !== place.zip) setValue(o.zip, place.zip); }
      var bgyMissing = o.barangay && !o.barangay.value;
      note(box, '✓ ' + esc([place.city, place.province].filter(Boolean).join(', ')) + (bgyMissing ? ' — now choose the barangay.' : ''), 'ok');
      if (bgyMissing && !o.barangay.disabled) o.barangay.focus();
      if (o.onFilled) o.onFilled(place);
    };
    box.addEventListener('input', async function () {
      var z = box.value.replace(/\D/g, '').slice(0, 4); if (z !== box.value) box.value = z;
      if (z.length < 4) { note(box, '', ''); return; }
      note(box, 'Looking up ZIP ' + z + '…', 'info');
      var places = [];
      try { places = await lookupZip(z, o.api); } catch (_) { places = []; }
      if (box.value !== z) return;
      if (!places.length) { note(box, 'ZIP ' + z + ' is not in our list. Fill in the address below.', 'warn'); return; }
      // several cities share a ZIP only rarely; several barangays of one city often do: ask which one
      var cities = []; places.forEach(function (p) { var k = p.province + '|' + p.city; if (cities.indexOf(k) < 0) cities.push(k); });
      if (cities.length > 1 || (places.length > 1 && places.filter(function (p) { return p.barangay; }).length > 1)) {
        var n = note(box, 'ZIP ' + z + ' covers several places — pick one:<div class="fa-chips">' + places.map(function (p, i) {
          return '<button type="button" class="fa-chip" data-i="' + i + '">' + esc([p.barangay, p.city].filter(Boolean).join(', ')) + '</button>'; }).join('') + '</div>', 'info');
        n.querySelectorAll('[data-i]').forEach(function (b) { b.onclick = function () { apply(places[+b.dataset.i]); }; });
        return;
      }
      apply(places[0]);
    });
    return { input: box, apply: apply };
  }

  /* Field feedback for dialogs drawn after page load. Rules are supplied by the
     owning form so conditional and optional fields keep their existing contract. */
  var validations = new WeakMap(), feedbackBoxes = new WeakMap(), errorSerial = 0;
  function fieldFeedback(input, message, box) {
    if (!input) return;
    var state = validations.get(input);
    box = box || (state && state.box) || feedbackBoxes.get(input);
    if (!box && !message) return;
    if (!box) {
      box = document.createElement('div'); box.className = 'fa-error';
      input.insertAdjacentElement('afterend', box);
      if (state) state.box = box;
    }
    feedbackBoxes.set(input, box);
    if (!box.id) box.id = 'faError' + (++errorSerial);
    box.setAttribute('aria-live', 'polite');
    box.textContent = message || '';
    input.classList.toggle('fa-invalid', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    var ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (ids.indexOf(box.id) < 0) { ids.push(box.id); input.setAttribute('aria-describedby', ids.join(' ')); }
  }
  function bindValidation(input, rule, box) {
    if (!input) return function () { return ''; };
    var state = validations.get(input);
    if (state) { state.rule = rule; return state.check; }
    state = { rule: rule, box: box, touched: false };
    validations.set(input, state);
    state.check = function (force) {
      if (force) state.touched = true;
      if (!state.touched) return '';
      var active = !input.disabled && !input.readOnly && input.getClientRects().length > 0;
      var message = active ? state.rule(input.value, input) || '' : '';
      fieldFeedback(input, message, state.box);
      return message;
    };
    ['input', 'change', 'blur'].forEach(function (type) {
      input.addEventListener(type, function () { state.check(true); });
    });
    if (input.form) input.form.addEventListener('reset', function () {
      state.touched = false; fieldFeedback(input, '', state.box);
    });
    return state.check;
  }
  var validationStyle = document.createElement('style');
  validationStyle.textContent = '.fa-error{display:block;color:var(--red,#c0392b);font-size:12.5px;line-height:1.45;margin-top:5px}' +
    '.fa-invalid{border-color:var(--red,#c0392b)!important}';
  document.head.appendChild(validationStyle);

  // every phone / email box on the page gets the same treatment, including boxes drawn later (modals, address forms)
  var PHONE_SEL = 'input[type="tel"], input[inputmode="tel"], input[autocomplete="tel"]';
  var EMAIL_SEL = 'input[type="email"], input[inputmode="email"], input[autocomplete="email"]';
  document.addEventListener('focusin', function (e) {
    var t = e.target;
    if (!t || !t.matches || t.dataset.faOff) return;
    if (t.matches(PHONE_SEL)) bindPhone(t);
    else if (t.matches(EMAIL_SEL) && !t.readOnly && t.getAttribute('autocomplete') !== 'username') bindEmail(t);
  });

  window.FormAssist = {
    validation: { bind: bindValidation, show: fieldFeedback },
    phone: { format: formatPhone, bind: bindPhone },
    email: { suggest: suggestEmail, bind: bindEmail },
    similar: similar, note: note, setValue: setValue,
    guard: guard, markClean: markClean, isDirty: isDirty,
    keyboard: keyboard, draft: draft,
    zipFill: zipFill, lookupZip: lookupZip, bestName: bestName, waitFor: waitFor
  };
})();
