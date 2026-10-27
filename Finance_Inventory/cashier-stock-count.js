/* cashier-stock-count.js — Cashier POS · Stock Count (staff side of the physical count).
   Staff type what is really on the shelf and hand the count in. They never see the system quantity, the cost or the difference,
   so the count stays honest. If an item is far from the system (above the variance limit Finance set), the server sends back ONLY
   that item for a recount; staff count it again from scratch. Finance then reviews and posts: staff cannot post.
   Server routes: GET /api/stock-counts/active · PUT /api/stock-counts/:id/lines · POST /api/stock-counts/:id/submit
   Load it in POS_Cashier.html after the page's own script:   <script src="cashier-stock-count.js?v=1"></script>
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var say = function (text, bad) { if (typeof window.toast === 'function') window.toast(text, !!bad); };

  var cur = null, dirty = false, busy = false, filter = 'todo', term = '', saveTimer = null, confirming = false;

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields });
    return data;
  }

  /* ---------- page shell ---------- */
  function addStyles() {
    var css =
      '.scs{max-width:760px}.scs .panel{margin-bottom:14px}' +
      '.scs-head{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;margin-bottom:10px}' +
      '.scs-head b{font-size:16px}.scs-sub{font-size:13.5px;color:var(--text-faint)}' +
      '.scs-bar{height:8px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;margin:10px 0 4px}.scs-bar i{display:block;height:100%;background:var(--blue-bright);transition:width .2s}' +
      '.scs-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}.scs-tools input[type=search]{flex:1;min-width:160px;padding:9px 10px;box-sizing:border-box}' +
      '.scs-tabs{display:flex;gap:6px}.scs-tabs button{padding:8px 12px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:13.5px;cursor:pointer}.scs-tabs button.on{border-color:var(--blue-bright);color:var(--blue-bright);font-weight:700}' +
      '.scs-item{display:grid;grid-template-columns:1fr auto;gap:8px 12px;align-items:center;padding:12px 0;border-top:1px solid var(--border)}.scs-item:first-child{border-top:0}' +
      '.scs-name{font-weight:600;overflow-wrap:anywhere}.scs-meta{font-size:12.5px;color:var(--text-faint);margin-top:2px}' +
      '.scs-qty{display:flex;align-items:center;gap:6px}.scs-qty input{width:104px;text-align:right;padding:10px 8px;font-size:16px;box-sizing:border-box}.scs-qty span{font-size:13px;color:var(--text-faint);min-width:24px}' +
      '.scs-item input.scs-note{grid-column:1/-1;width:100%;padding:8px 10px;font-size:14px;box-sizing:border-box}' +
      '.scs-item.done .scs-name::after{content:" \\2713";color:var(--green,#43c47a)}' +
      '.scs-banner{padding:10px 12px;border-radius:6px;font-size:13.5px;border:1px solid var(--border);margin:0 0 12px}.scs-banner.warn{border-color:rgba(217,164,65,.55);background:rgba(217,164,65,.09)}' +
      '.scs-err{display:none;margin:10px 0;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.scs-err.show{display:block}' +
      '.scs-actions{display:flex;gap:10px;flex-wrap:wrap;position:sticky;bottom:0;padding:12px 0 4px;background:var(--card)}.scs-actions button{flex:1 1 140px;min-height:44px}' +
      '.scs-empty{padding:26px 8px;text-align:center;color:var(--text-faint)}' +
      '@media (max-width:480px){.scs-item{grid-template-columns:1fr}.scs-qty{justify-content:flex-end}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }
  function build() {
    if ($('page-stockcount') && $('page-stockcount').getAttribute('data-built')) return true;
    var sec = $('page-stockcount');
    if (!sec) return false;
    sec.setAttribute('data-built', '1');
    sec.innerHTML = '<div class="welcome"><h1>Stock Count</h1><p>Count what is on the shelf and hand it in. Finance reviews and posts it.</p></div><div class="scs" id="scsBody"></div>';
    return true;
  }

  /* ---------- views ---------- */
  function progress() { var c = cur.items.filter(function (i) { return i.countedQty !== null; }).length; return { counted: c, total: cur.items.length }; }
  function setBadge() {
    var b = $('navStockCountBadge'); if (!b) return;
    var left = cur && (cur.status === 'open' || cur.status === 'recount') ? cur.items.filter(function (i) { return i.countedQty === null; }).length : 0;
    b.textContent = left; b.hidden = !left;
  }
  function renderEmpty() {
    $('scsBody').innerHTML = '<div class="panel"><div class="scs-empty"><b>No stock count to do right now.</b><br>When Finance or the weekly schedule starts one, you will get a notification and it will show up here.<br><br><button class="btn-secondary" data-scs="refresh">Check again</button></div></div>';
  }
  function renderWaiting() {
    $('scsBody').innerHTML = '<div class="panel"><div class="scs-empty"><b>' + esc(cur.no) + ' is submitted.</b><br>Thank you. Finance is reviewing it, and may ask for a recount of a few items. You will get a notification if so.<br><br><button class="btn-secondary" data-scs="refresh">Check again</button></div></div>';
  }
  function renderSheet() {
    var recount = cur.status === 'recount', p = progress();
    $('scsBody').innerHTML = '<div class="panel">' +
      '<div class="scs-head"><div><b>' + esc(cur.no) + '</b> <span class="scs-sub">' + esc(cur.scope) + (cur.note ? ' · ' + esc(cur.note) : '') + '</span></div><span class="scs-sub" id="scsCount"></span></div>' +
      (recount ? '<div class="scs-banner warn"><b>Recount.</b> These items did not match closely enough the first time. Count each one again from scratch, without looking at the earlier number, and submit.</div>'
               : '<div class="scs-banner">Count what is physically there and type it in. Type <b>0</b> if there is none. Notes are optional.</div>') +
      '<div class="scs-bar"><i id="scsFill" style="width:0"></i></div>' +
      '<div class="scs-tools"><input id="scsSearch" type="search" placeholder="Search item, SKU or shelf…" value="' + esc(term) + '" autocomplete="off" aria-label="Search items">' +
      '<div class="scs-tabs" role="group" aria-label="Filter"><button type="button" data-scs-filter="todo">Left to count</button><button type="button" data-scs-filter="all">All</button></div></div>' +
      '<div id="scsRows"></div>' +
      '<div class="scs-err" id="scsErr"></div><div id="scsConfirm"></div>' +
      '<div class="scs-actions"><button class="btn-secondary" data-scs="save">Save progress</button><button class="btn-primary" data-scs="submit">Submit ' + (recount ? 'recount' : 'count') + '</button></div></div>';
    renderRows(); renderProgress();
  }
  function visible() {
    var t = term.trim().toLowerCase();
    return cur.items.filter(function (i) {
      if (t && (i.name + ' ' + i.sku + ' ' + i.location).toLowerCase().indexOf(t) < 0) return false;
      return filter === 'all' || i.countedQty === null;
    });
  }
  function renderRows() {
    var rows = visible();
    document.querySelectorAll('[data-scs-filter]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-scs-filter') === filter); });
    $('scsRows').innerHTML = rows.length ? rows.map(function (i) {
      return '<div class="scs-item' + (i.countedQty !== null ? ' done' : '') + '" data-row="' + esc(i.sku) + '"><div><div class="scs-name">' + esc(i.name) + '</div>' +
        '<div class="scs-meta">' + esc(i.sku) + (i.location ? ' · Shelf ' + esc(i.location) : '') + ' · ' + esc(i.department) + '</div></div>' +
        '<div class="scs-qty"><input type="number" inputmode="decimal" min="0" step="any" data-in="' + esc(i.sku) + '" value="' + (i.countedQty === null ? '' : i.countedQty) + '" placeholder="Qty" aria-label="Counted quantity for ' + esc(i.name) + '"><span>' + esc(i.unit) + '</span></div>' +
        '<input class="scs-note" maxlength="200" data-note="' + esc(i.sku) + '" value="' + esc(i.note) + '" placeholder="Note (optional)" autocomplete="off"></div>';
    }).join('') : '<div class="scs-empty">' + (filter === 'todo' && !term ? 'Everything is counted. Review it, then submit.' : 'No items match.') + '</div>';
  }
  function renderProgress() {
    var p = progress(); if (!$('scsFill')) return;
    $('scsFill').style.width = (p.total ? Math.round(p.counted / p.total * 100) : 0) + '%';
    $('scsCount').textContent = p.counted + ' of ' + p.total + ' counted';
    setBadge();
  }
  function showErr(msg) { var e = $('scsErr'); if (!e) return say(msg, true); e.textContent = msg; e.classList.toggle('show', !!msg); }

  /* ---------- actions ---------- */
  function sig(c) { return c.status + '|' + c.items.map(function (i) { return i.sku + ':' + i.countedQty + ':' + i.note; }).join(','); }
  async function load(quiet) {
    if (!build()) return;
    if (dirty && cur) return;                       // keep unsaved typing when the page is opened again
    try {
      var r = await api('/stock-counts/active');
      var next = r.count;
      if (!next) { cur = null; renderEmpty(); setBadge(); return; }
      var wasSame = cur && cur.id === next.id && cur.status === next.status;
      var same = wasSame && sig(cur) === sig(next);
      cur = next;
      if (next.status === 'submitted') { if (!(quiet && same)) renderWaiting(); return setBadge(); }
      if (!wasSame) { filter = 'todo'; term = ''; }
      if (quiet && same) return setBadge();               // nothing changed: do not redraw the sheet under the user's finger
      renderSheet();
    } catch (e) { if (!quiet) $('scsBody').innerHTML = '<div class="panel"><p class="scs-sub" style="padding:14px">' + esc(e.message) + '</p></div>'; }
  }
  async function save(quiet) {
    if (!cur || (cur.status !== 'open' && cur.status !== 'recount')) return true;
    clearTimeout(saveTimer);
    var lines = cur.items.map(function (i) { return { sku: i.sku, countedQty: i.countedQty, note: i.note }; });
    if (!lines.length) return true;
    try { await api('/stock-counts/' + encodeURIComponent(cur.id) + '/lines', { method: 'PUT', body: JSON.stringify({ lines: lines }) }); dirty = false; if (!quiet) say('Progress saved'); return true; }
    catch (e) { showErr(e.message); return false; }
  }
  function onInput(e) {
    var t = e.target, sku = t.getAttribute('data-in'), nsku = t.getAttribute('data-note');
    if (!sku && !nsku) return;
    var it = cur.items.filter(function (i) { return i.sku === (sku || nsku); })[0]; if (!it) return;
    if (sku) {
      var raw = t.value.trim();
      if (raw === '') { it.countedQty = null; t.classList.remove('field-invalid'); }
      else {
        var n = Number(raw);
        if (!isFinite(n) || n < 0 || n > 1e8 || Math.round(n * 100) / 100 !== n) {      // not a valid quantity: treat the item as not counted until it is fixed
          t.classList.add('field-invalid'); it.countedQty = null; var r0 = t.closest('.scs-item'); if (r0) r0.classList.remove('done'); renderProgress(); dirty = true; return;
        }
        t.classList.remove('field-invalid'); it.countedQty = n;
      }
      var row = t.closest('.scs-item'); if (row) row.classList.toggle('done', it.countedQty !== null);
      renderProgress();
    } else it.note = t.value;
    dirty = true; showErr('');
    clearTimeout(saveTimer); saveTimer = setTimeout(function () { if (!busy) save(true); }, 2500);   // quiet autosave, so nothing is lost if the phone locks
  }
  function askSubmit() {
    var p = progress(), left = cur.items.filter(function (i) { return i.countedQty === null; });
    if (left.length) { filter = 'todo'; renderRows(); return showErr(left.length + ' item(s) are not counted yet. Enter every quantity (0 if there is none), then submit.'); }
    $('scsConfirm').innerHTML = '<div class="scs-banner warn" style="margin-top:12px"><b>Submit ' + p.total + ' item(s) to Finance?</b> You cannot change them after this' + (cur.status === 'open' ? ', unless Finance asks for a recount of some items' : '') + '.' +
      '<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap"><button class="btn-primary" data-scs="confirm-submit">Yes, submit</button><button class="btn-secondary" data-scs="cancel-submit">Keep counting</button></div></div>';
    confirming = true;
  }
  async function doSubmit(btn) {
    if (busy) return; busy = true; btn.disabled = true; btn.textContent = 'Submitting…';
    try {
      if (!(await save(true))) throw new Error('Could not save your counts. Check your connection and try again.');
      var r = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/submit', { method: 'POST' });
      say(r.status === 'recount' ? r.recount + ' item(s) need a recount. Please count only those again.' : 'Count submitted. Thank you!', false);
      dirty = false; confirming = false; await load();
    } catch (e) { $('scsConfirm').innerHTML = ''; confirming = false; showErr(e.message); }
    busy = false;
  }

  function bind() {
    document.addEventListener('click', async function (e) {
      var b = e.target.closest && e.target.closest('#page-stockcount [data-scs], #page-stockcount [data-scs-filter]'); if (!b) return;
      var act = b.getAttribute('data-scs'), f = b.getAttribute('data-scs-filter');
      try {
        if (f) { filter = f; renderRows(); }
        else if (act === 'refresh') await load();
        else if (act === 'save') await save(false);
        else if (act === 'submit') askSubmit();
        else if (act === 'cancel-submit') { $('scsConfirm').innerHTML = ''; confirming = false; }
        else if (act === 'confirm-submit') await doSubmit(b);
      } catch (err) { showErr(err.message); }
    });
    document.addEventListener('input', function (e) {
      if (!e.target.closest || !e.target.closest('#page-stockcount')) return;
      if (e.target.id === 'scsSearch') { term = e.target.value; renderRows(); } else onInput(e);
    });
    window.addEventListener('beforeunload', function (ev) { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });
    // pick up a count that Finance started or sent back for a recount, without disturbing someone who is typing
    setInterval(function () {
      var sec = $('page-stockcount');
      if (document.hidden || busy || dirty || confirming) return;
      var ae = document.activeElement; if (ae && sec && sec.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;
      load(true);
    }, 60000);
  }

  window.cashierStockCount = { load: function () { return load(); } };
  function init() { addStyles(); if (!build()) return; bind(); load(true); }   // load once at start so the menu badge shows what is left
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
