/* stock-count-admin.js — Finance: physical inventory (stock count).
   Adds a "Stock Count" page under Inventory. Load it last in Finance_Inventory.html:
       <script src="stock-count-admin.js?v=1"></script>
   Server routes: GET/POST /api/stock-counts · GET /api/stock-counts/:id · PUT .../lines · POST .../submit · POST .../recount · POST .../post · POST .../cancel
   Flow: staff (cashier POS, Stock Count page) count blind and submit -> items above the variance limit are counted again (only those) -> Finance reviews here and posts.
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return (n < 0 ? '−' : '') + '₱' + Math.abs(Number(n || 0)).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var num = function (n) { return Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 }); };
  var when = function (ms) { return new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  var round2 = function (n) { return Math.round((n + Number.EPSILON) * 100) / 100; };

  var list = [], cur = null, busy = false, dirty = false, filter = 'all', term = '', blind = false;

  var VARIANCE_REASONS = {
    'Raw Materials': [
      'Cutting offcut / scrap loss',
      'Material oxidation / rust degradation',
      'Scale / weighing tolerance variance',
      'Material misplaced in storage rack',
      'Supplier delivery packing discrepancy',
      'Unrecorded workshop batch deduction'
    ],
    'Finished Goods': [
      'Pallet packing count discrepancy',
      'Handling damage / scratch during transfer',
      'Sample / customer demonstration piece',
      'Defective piece set aside for inspection',
      'Customer return restock variance',
      'Order staging discrepancy'
    ],
    'Finishing Supplies': [
      'Evaporation / container residue loss',
      'Application overspray / hopper residue',
      'Chemical container tare weight discrepancy',
      'Spillage / damaged packaging in store'
    ]
  };
  var MANUAL_REASONS = [
    'Discrepancy spot check',
    'Suspected theft / unexplained loss',
    'Large delivery received (verify quantities)',
    'Damaged or expired stock check',
    'Stock transferred or relocated',
    'Customer or supplier dispute',
    'Audit or management request',
    'Other (specify)'
  ];
  var ACTIVE = ['open', 'recount', 'submitted'];
  var isActive = function (st) { return ACTIVE.indexOf(st) >= 0; };
  var DEPTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields });
    return data;
  }
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  /* ---------------- page shell ---------------- */
  function addStyles() {
    var css =
      '.sc-top{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}' +
      '.sc-top .grow{flex:1;min-width:220px}' +
      '.sc-top label{display:block;font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:6px}' +
      '.sc-sheet input.sc-in{width:96px;text-align:right;padding:6px 8px;box-sizing:border-box}' +
      '.sc-sheet input.sc-note{width:100%;min-width:130px;padding:6px 8px;box-sizing:border-box}' +
      '.sc-sheet td,.sc-sheet th{vertical-align:middle}.sc-sheet .r{text-align:right;white-space:nowrap}.sc-sheet input.sc-in{display:inline-block}' +
      '.sc-up{color:var(--green,#43c47a);font-weight:600}.sc-down{color:var(--red,#e35b5b);font-weight:600}.sc-same{color:var(--text-faint)}' +
      '.sc-row-diff td{background:rgba(217,164,65,.07)}' +
      '.sc-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}' +
      '.sc-bar .sp{flex:1}' +
      '.sc-auto{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--blue-bright);border:1px solid var(--blue-bright);vertical-align:1px}' +
      '.sc-sched .panel-head{align-items:flex-start;gap:12px}.sc-sched .panel-sub b{color:var(--text)}.sc-top[hidden]{display:none!important}' +
      '.sc-acts{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;margin-left:auto}.sc-acts>button{height:40px;white-space:nowrap}' +
      '@media (max-width:640px){.sc-acts{flex-wrap:wrap;width:100%}.sc-acts>button{flex:1 1 auto}}' +
      '.sc-sum{display:flex;gap:10px 22px;flex-wrap:wrap;margin:0 0 14px;font-size:14.5px}.sc-sum b{font-size:17px}' +
      '.sc-err{display:none;margin:10px 0;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.sc-err.show{display:block}' +
      '.sc-chk{display:flex;gap:8px;align-items:center;font-size:14px;cursor:pointer}.sc-chk input{width:auto}' +
      '.sc-hint{font-size:13px;color:var(--text-faint);margin:0 0 12px}' +
      '.sc-row-over td{background:rgba(227,91,91,.09)}.sc-row-over.sc-row-diff td{background:rgba(227,91,91,.09)}' +
      '.sc-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:999px;font-size:11px;font-weight:700;border:1px solid var(--border);color:var(--text-dim);vertical-align:1px;white-space:nowrap}' +
      '.sc-tag.bad{color:var(--red,#e35b5b);border-color:var(--red,#e35b5b)}.sc-tag.wk{color:var(--blue-bright);border-color:var(--blue-bright)}' +
      '.sc-banner{margin:0 0 14px;padding:10px 12px;border-radius:6px;font-size:13.5px;border:1px solid var(--border);background:rgba(255,255,255,.03)}' +
      '.sc-banner.warn{border-color:rgba(217,164,65,.55);background:rgba(217,164,65,.09)}.sc-banner b{font-weight:700}' +
      '.sc-set{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:0 0 12px;width:100%}.sc-set .grow{flex:1;min-width:150px}.sc-set .sc-sub{flex-basis:100%;font-size:12.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-faint);margin:6px 0 -4px}' +
      '.sc-set label{display:block;font-size:13px;font-weight:600;color:var(--text-dim);margin-bottom:6px}' +
      '.sc-explain{display:grid;gap:8px;margin:12px 0 0}.sc-explain label{font-size:13px;color:var(--text-dim)}.sc-explain input{width:100%;box-sizing:border-box}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    // make sure the Stock Count look is loaded even if the <link> was not added to the HTML
    if (!document.querySelector('link[href*="ui2-stockcount.css"]')) {
      var lk = document.createElement('link'); lk.rel = 'stylesheet'; lk.href = 'ui2-stockcount.css?v=1'; document.head.appendChild(lk);
    }
  }

  function build() {
    if ($('stockcount')) return true;
    var after = $('stockflow');
    if (!after) return false;
    var sec = document.createElement('section');
    sec.id = 'stockcount'; sec.className = 'page ui2';
    sec.innerHTML =
      '<div class="ui2-hero"><div><div class="ui2-eyebrow"><span class="ui2-live"></span> Physical inventory</div><h1>Stock Count</h1>' +
      '<p>Count what is really on the shelf, recount anything above the variance limit, then review and post the corrections.</p></div>' +
      '<div class="ui2-chip"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg><span>Staff count blind on their POS</span></div></div>' +
      '<div id="scBody"></div>';
    after.parentNode.insertBefore(sec, after.nextSibling);

    var existingNav = document.querySelector('.nav-item[data-page="stockcount"], .nav-item[data-page="stock-count"]');
    if (existingNav) {
      existingNav.setAttribute('data-page', 'stockcount');
      existingNav.addEventListener('click', function () {
        if (typeof navigateToPage === 'function') navigateToPage('stockcount');
        else onOpen();
      });
    } else {
      var nav = document.querySelector('.nav-item[data-page="stockflow"]');
      if (nav) {
        var b = document.createElement('button');
        b.className = 'nav-item'; b.setAttribute('data-page', 'stockcount');
        b.innerHTML = '<span class="dot"></span> Stock Count';
        nav.parentNode.insertBefore(b, nav.nextSibling);
        b.addEventListener('click', function () {
          if (typeof navigateToPage === 'function') navigateToPage('stockcount');
          else onOpen();
        });
      }
    }
    try { if (typeof pageInformation !== 'undefined') pageInformation.stockcount = { title: 'Stock Count', subtitle: 'Physical inventory audit and variance reconciliation' }; } catch (e) {}
    return true;
  }

  /* ---------------- views ---------------- */
  var STATUS_LABEL = { posted: 'Posted', cancelled: 'Cancelled', open: 'Counting', recount: 'Recount', submitted: 'Awaiting review' };
  function statusPill(st) {
    var cls = st === 'posted' ? 'in' : st === 'cancelled' ? 'out' : 'low';
    return '<span class="status-pill ' + cls + '">' + (STATUS_LABEL[st] || st) + '</span>';
  }
  // the same variance rule the server uses (see isOver in stock-count.js): above the % of the system quantity, or above the peso value of the difference
  function overOf(it) {
    if (!cur || it.countedQty === null) return false;
    var diff = round2(it.countedQty - it.systemQty); if (diff === 0) return false;
    var pct = Number(cur.varPct) || 0, val = Number(cur.varValue) || 0;
    if (pct <= 0 && val <= 0) return true;
    return (pct > 0 && Math.abs(diff) * 100 > pct * it.systemQty) || (val > 0 && Math.abs(diff) * it.unitCost > val);
  }

  function renderList() {
    cur = null;
    var open = list.filter(function (c) { return isActive(c.status); })[0];
    var html = scheduleHtml() + '<div class="panel sc-start"><div class="panel-head"><div><div class="panel-title">' + (open ? 'Count in progress' : 'Start a new count') + '</div>' +
      '<div class="panel-sub">' + (open ? 'Only one count can be in progress at a time.' : 'The system quantities are saved when you start. Staff count on their POS screen without seeing them; you review and post.') + '</div></div></div>';
    if (open) {
      var todo = open.status === 'recount' ? open.needRecount + ' item(s) being recounted' : open.status === 'submitted' ? 'submitted ' + (open.submittedAt ? when(open.submittedAt) : '') + (open.submittedBy ? ' by ' + open.submittedBy : '') : open.counted + ' of ' + open.lines + ' counted';
      html += '<div class="sc-sum"><span>' + esc(open.no) + ' · ' + esc(open.scope) + '</span><span>' + statusPill(open.status) + '</span><span>' + esc(todo) + '</span><span>started ' + esc(when(open.createdAt)) + ' by ' + esc(open.createdBy) + '</span></div>' +
        '<button class="btn-primary" data-sc="open" data-id="' + esc(open.id) + '">' + (open.status === 'submitted' ? 'Review count' : 'Open count') + '</button>';
    } else {
      var cadOn = !sched || sched.cadenceOn !== false;
      var nextDateStr = sched && sched.nextRun ? new Date(sched.nextRun + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Mon, Oct 26';
      html += '<div class="sc-lock">' +
        '<div class="sc-lock-row">' +
          '<div class="sc-lock-main"><span class="sc-lock-ico"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' +
            '<span class="sc-badge bad">Weekly audit cadence locked</span>' +
            '<span class="sc-lock-text">Next automated cycle opens <b>' + esc(nextDateStr) + ' at 8:00 AM</b></span>' +
          '</div>' +
          '<button type="button" class="btn-secondary btn-sm" id="scToggleManualBtn" aria-expanded="false">Unlock manual count</button>' +
        '</div>' +
        '<div id="scManualStartForm" class="sc-manual" hidden>' +
          '<div class="sc-reason-card">' +
            '<div class="sc-reason-head"><span class="sc-reason-ico"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg></span>' +
              '<div><div class="sc-reason-title">Manual count request</div><div class="sc-reason-sub">A reason is required. It is saved with the count and logged in the audit trail.</div></div></div>' +
            '<div class="sc-top">' +
              '<div class="grow"><label for="scReason">Reason for manual count <span class="sc-req">Required</span></label><select id="scReason" class="form-select" required><option value="">Select a reason…</option>' +
              MANUAL_REASONS.map(function (r) { return '<option>' + esc(r) + '</option>'; }).join('') + '</select></div>' +
              '<div class="grow"><label for="scDept">Department</label><select id="scDept" class="form-select"><option value="">All departments</option>' +
              DEPTS.map(function (d) { return '<option>' + esc(d) + '</option>'; }).join('') + '</select></div>' +
              '<div class="grow"><label for="scMode">Which items?</label><select id="scMode" class="form-select"><option value="due"' + (cadOn ? ' selected' : '') + '>Items due now (weekly + slow ones)</option><option value="all"' + (cadOn ? '' : ' selected') + '>All products</option></select></div>' +
            '</div>' +
            '<div class="sc-top sc-other" id="scOtherWrap" hidden><div class="grow"><label for="scNote">Specify the reason <span class="sc-req">Required</span></label><input id="scNote" class="form-input" maxlength="250" placeholder="Describe why this count is needed" autocomplete="off"></div></div>' +
            '<div class="sc-err" id="scErr"></div>' +
            '<div class="sc-reason-foot"><p class="sc-hint">Stop sales and stock movements for the area while counting.</p><button class="btn-primary" id="scStart">Start count</button></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }
    html += '</div><div class="panel"><div class="panel-head"><div><div class="panel-title">Count history</div><div class="panel-sub">Posted counts have already corrected the stock</div></div></div>' +
      '<div class="table-wrapper"><table class="sc-hist"><thead><tr><th>Count</th><th>Scope</th><th>Status</th><th class="r">Counted</th><th class="r">Differences</th><th class="r">Net value</th><th>Date</th><th></th></tr></thead><tbody>' +
      (list.length ? list.map(function (c) {
        return '<tr><td class="mono">' + esc(c.no) + (c.scheduled ? ' <span class="sc-auto" title="Started by the weekly schedule">Weekly</span>' : '') + '</td><td>' + esc(c.scope) + '</td><td>' + statusPill(c.status) + '</td><td class="r">' + c.counted + ' / ' + c.lines + '</td>' +
          '<td class="r">' + (c.status === 'cancelled' ? '—' : c.differences) + '</td><td class="r ' + (c.netValue < 0 ? 'sc-down' : c.netValue > 0 ? 'sc-up' : '') + '">' + (c.status === 'posted' ? peso(c.netValue) : '—') + '</td>' +
          '<td class="dim">' + esc(when(c.closedAt || c.createdAt)) + '</td><td class="r"><button class="btn-secondary btn-sm" data-sc="open" data-id="' + esc(c.id) + '">' + (c.status === 'open' ? 'Continue' : 'View') + '</button></td></tr>';
      }).join('') : '<tr><td colspan="8" class="sc-empty">No stock counts yet.</td></tr>') +
      '</tbody></table></div></div>';
    $('scBody').innerHTML = html;
    if (window.FormAssist) {
      FormAssist.validation.bind($('scReason'), function (value) { return value ? '' : 'Select a reason for the manual count.'; });
      var checkNote = FormAssist.validation.bind($('scNote'), function (value) { return $('scReason').value.indexOf('Other') === 0 && !value.trim() ? 'Describe the reason for the manual count.' : ''; });
      if ($('scReason')) $('scReason').addEventListener('change', function () { checkNote(false); });
    }
  }

  // difference for one line: only when a quantity was typed
  function diffOf(it) { return it.countedQty === null ? null : round2(it.countedQty - it.systemQty); }

  function renderCount() {
    var st = cur.status, editable = isActive(st), items = cur.items;
    var hideSys = blind && (st === 'open' || st === 'recount');
    var over = items.filter(overOf);
    var html = '<div class="sc-bar"><button class="btn-secondary btn-sm" data-sc="back">&larr; All counts</button><b class="mono">' + esc(cur.no) + '</b> ' + statusPill(st) +
      '<span class="dim">' + esc(cur.scope) + ' · started ' + esc(when(cur.createdAt)) + ' by ' + esc(cur.createdBy) + (cur.note ? ' · ' + esc(cur.note) : '') + '</span></div>' + banner() +
      '<div class="panel sc-sheet-panel"><div class="sc-sum" id="scSum"></div>' +
      '<div class="sc-bar"><input id="scSearch" class="inv-search" placeholder="Search product or SKU…" value="' + esc(term) + '" autocomplete="off">' +
      '<select id="scFilter" class="inv-select"><option value="all">All products</option><option value="todo">Not counted yet</option><option value="diff">Differences only</option><option value="over">Above variance limit</option></select>' +
      (st === 'open' || st === 'recount' ? '<label class="sc-chk"><input type="checkbox" id="scBlind"' + (blind ? ' checked' : '') + '> Hide system quantity (blind count)</label>' : '') +
      '<span class="sp"></span>' +
      (editable ? '<span class="sc-acts"><button class="btn-danger" id="scCancel">Cancel count</button><button class="btn-secondary" id="scSave">Save progress</button>' +
        (st === 'recount' ? '<button class="btn-primary" id="scSubmit">Submit recount</button>' : '') +
        (st === 'submitted' && recountable().length ? '<button class="btn-secondary" id="scRecountBtn">Request recount (' + recountable().length + ')</button>' : '') +
        (st === 'open' || st === 'submitted' ? '<button class="btn-primary" id="scPost">Review &amp; post…</button>' : '') + '</span>' : '') + '</div>' +
      '<div class="sc-err" id="scErr"></div>' +
      '<div class="table-wrapper"><table class="sc-sheet"><thead><tr><th>SKU</th><th>Product</th><th>Location</th>' + (hideSys ? '' : '<th class="r">System</th>') +
      '<th class="r">Counted</th><th class="r">Difference</th><th class="r">Value</th><th>Note</th></tr></thead><tbody id="scRows"></tbody></table></div></div>';
    $('scBody').innerHTML = html;
    $('scFilter').value = filter;
    renderRows(); renderSummary();
  }
  // items above the variance limit that can still be sent back (each item at most 3 times)
  function recountable() { return cur.items.filter(function (i) { return overOf(i) && i.recounts < 3; }); }
  function limitText() { return (cur.varPct > 0 ? cur.varPct + '%' : '') + (cur.varPct > 0 && cur.varValue > 0 ? ' or ' : '') + (cur.varValue > 0 ? peso(cur.varValue) : '') || 'any difference'; }
  function banner() {
    if (cur.status === 'open') return '<div class="sc-banner">Staff can count this on the <b>Stock Count</b> page of their POS. They do not see the system quantity. When they submit, any item above the variance limit (<b>' + esc(limitText()) + '</b>) is sent back for a recount of only that item.</div>';
    if (cur.status === 'recount') return '<div class="sc-banner warn"><b>Recount in progress.</b> ' + cur.needRecount + ' item(s) were above the variance limit (' + esc(limitText()) + ') and are being counted again. You can review and post once the recount is submitted.</div>';
    if (cur.status === 'submitted') return '<div class="sc-banner' + (cur.overThreshold ? ' warn' : '') + '">Submitted' + (cur.submittedBy ? ' by <b>' + esc(cur.submittedBy) + '</b>' : '') + (cur.submittedAt ? ' ' + esc(when(cur.submittedAt)) : '') + '. ' +
      (cur.overThreshold ? '<b>' + cur.overThreshold + '</b> item(s) are still above the variance limit (' + esc(limitText()) + ') after the recount: check them and add a note before posting.' : 'Nothing is above the variance limit. Check the differences and post.') + '</div>';
    return '';
  }

  function renderSummary() {
    var items = cur.items, counted = items.filter(function (i) { return i.countedQty !== null; });
    var diffs = counted.filter(function (i) { return diffOf(i) !== 0; });
    var net = diffs.reduce(function (s, i) { return s + diffOf(i) * i.unitCost; }, 0);
    var el = $('scSum'); if (!el) return;
    var hide = blind && (cur.status === 'open' || cur.status === 'recount');
    el.innerHTML = '<span><b>' + counted.length + '</b> of ' + items.length + ' counted</span>' +
      '<span><b>' + diffs.length + '</b> with differences</span>' +
      (hide ? '' : '<span><b class="' + (items.filter(overOf).length ? 'sc-down' : '') + '">' + items.filter(overOf).length + '</b> above variance limit</span>' +
        '<span>Net value of differences <b class="' + (net < 0 ? 'sc-down' : net > 0 ? 'sc-up' : '') + '">' + peso(net) + '</b></span>');
  }

  function visible() {
    var t = term.trim().toLowerCase();
    return cur.items.filter(function (i) {
      if (t && (i.name + ' ' + i.sku).toLowerCase().indexOf(t) < 0) return false;
      if (filter === 'todo') return i.countedQty === null;
      if (filter === 'diff') return i.countedQty !== null && diffOf(i) !== 0;
      if (filter === 'over') return overOf(i);
      return true;
    });
  }

  function diffCell(it) {
    var d = diffOf(it);
    if (d === null) return '<span class="sc-same">—</span>';
    if (d === 0) return '<span class="sc-same">0</span>';
    return '<span class="' + (d > 0 ? 'sc-up' : 'sc-down') + '">' + (d > 0 ? '+' : '−') + num(Math.abs(d)) + ' ' + esc(it.unit) + '</span>';
  }

  function renderRows() {
    var editable = isActive(cur.status), rows = visible();
    var hideSys = blind && (cur.status === 'open' || cur.status === 'recount');
    $('scRows').innerHTML = rows.length ? rows.map(function (it) {
      var d = diffOf(it), v = d === null ? null : d * it.unitCost, o = overOf(it);
      var cad = it.cadence ? '<span class="sc-tag ' + (it.cadence === 'weekly' ? 'wk' : '') + '" title="' + esc(it.why) + '">' + (it.cadence === 'weekly' ? 'Weekly' : 'Monthly') + '</span>' : '';
      var flags = (it.needsRecount ? '<span class="sc-tag bad">Recount</span>' : '') + (o && !hideSys ? '<span class="sc-tag bad">Above limit</span>' : '');
      var first = it.firstQty !== null && !hideSys ? '<div class="dim sc-subline">1st count: ' + num(it.firstQty) + '</div>' : '';
      return '<tr data-sku="' + esc(it.sku) + '" class="' + (d ? 'sc-row-diff ' : '') + (o && !hideSys ? 'sc-row-over' : '') + '"><td class="mono">' + esc(it.sku) + '</td><td>' + esc(it.name) + cad + flags + '<div class="dim sc-subline">' + esc(it.department) + (it.why ? ' · ' + esc(it.why) : '') + (it.countedBy ? ' · counted by ' + esc(it.countedBy) : '') + '</div></td>' +
        '<td class="dim">' + esc(it.location || '—') + '</td>' +
        (hideSys ? '' : '<td class="r">' + num(it.systemQty) + ' ' + esc(it.unit) + '</td>') +
        '<td class="r">' + (editable ? '<input class="form-input sc-in" type="number" inputmode="decimal" min="0" step="any" data-in="' + esc(it.sku) + '" value="' + (it.countedQty === null ? '' : it.countedQty) + '" aria-label="Counted quantity for ' + esc(it.name) + '"' + (it.needsRecount ? ' placeholder="recount"' : '') + '> ' + esc(it.unit) + first : (it.countedQty === null ? '—' : num(it.countedQty) + ' ' + esc(it.unit)) + first) + '</td>' +
        '<td class="r" data-d="' + esc(it.sku) + '">' + (hideSys ? '<span class="sc-same">hidden</span>' : diffCell(it)) + '</td>' +
        '<td class="r" data-v="' + esc(it.sku) + '">' + (hideSys || v === null || v === 0 ? '—' : '<span class="' + (v > 0 ? 'sc-up' : 'sc-down') + '">' + peso(v) + '</span>') + '</td>' +
        '<td>' + (editable ? '<input class="form-input sc-note" maxlength="200" data-note="' + esc(it.sku) + '" value="' + esc(it.note) + '" placeholder="' + (o && it.recounts > 0 ? 'Why is it still off? (required)' : 'Why? (optional)') + '" autocomplete="off">' : esc(it.note)) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="sc-empty">No products match.</td></tr>';
  }

  /* ---------------- actions ---------------- */
  function showErr(msg) { var e = $('scErr'); if (!e) return toast(msg, true); e.textContent = msg; e.classList.toggle('show', !!msg); }

  var sched = null;
  async function loadList() { list = await api('/stock-counts'); try { sched = await api('/stock-counts/schedule'); } catch (e) { sched = null; } }
  // weekly schedule card: the system starts the count by itself on count day (stock-count.js weeklyCount)
  var DAYNAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function scheduleHtml() {
    if (!sched) return '';
    var next = sched.nextRun ? new Date(sched.nextRun + 'T00:00:00').toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Mon, Oct 26';
    var lim = (sched.varPct > 0 ? sched.varPct + '%' : '') + (sched.varPct > 0 && sched.varValue > 0 ? ' or ' : '') + (sched.varValue > 0 ? peso(sched.varValue) : '') || '3% or ₱1,000.00';

    var rule = function (tone, ico, label, title, lines, foot) {
      return '<div class="sc-rule ' + tone + '"><div class="sc-rule-ico">' + ico + '</div><div class="sc-rule-body">' +
        '<div class="sc-rule-label">' + label + '</div><div class="sc-rule-title">' + title + '</div>' +
        lines.map(function (l) { return '<div class="sc-rule-line">' + l + '</div>'; }).join('') +
        (foot ? '<div class="sc-rule-foot">' + foot + '</div>' : '') + '</div></div>';
    };
    return '<div class="panel sc-sched">' +
      '<div class="panel-head"><div>' +
        '<div class="sc-titlerow"><div class="panel-title">Automated Count Schedule &amp; Auditing Rules</div><span class="sc-badge ok">Automated</span></div>' +
        '<div class="panel-sub">System-led cycle counts and recount variance auditing. Zero manual scheduling needed.</div>' +
      '</div></div>' +
      '<div class="sc-rules">' +
        rule('blue', '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>', 'Recurring schedule', 'Every ' + esc(sched.day || 'Monday') + ' at Store Opening',
          ['Scope: ' + esc(sched.scopeLabel || 'All departments') + ' · Due in ' + (sched.dueDays || 2) + ' days'], 'Next count: ' + esc(next)) +
        rule('green', '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>', 'Cadence automation', 'Weekly High-Value / 14-day Slow',
          ['Weekly: ' + peso(sched.highValue || 25000) + '+ on-hand or 2+ stock-outs/30d', 'Slow items: automatically cycled every ' + (sched.slowDays || 14) + ' days'], '') +
        rule('red', '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>', 'Automated recount trigger', 'Variance &gt; ' + esc(lim),
          ['Automatic discrepancy flag requires supervisor recount', 'Category variance reasons pre-selected'], '') +
      '</div>' +
    '</div>';
  }

  async function openCount(id) {
    cur = await api('/stock-counts/' + encodeURIComponent(id)); dirty = false; term = ''; filter = 'all'; renderCount();
  }
  async function showList() { await loadList(); renderList(); }
  async function onOpen() {
    if (!build()) return;
    if (cur && dirty) return;                 // keep unsaved typing when the user comes back to this page
    try { if (cur && isActive(cur.status)) await openCount(cur.id); else await showList(); }
    catch (e) { $('scBody').innerHTML = '<div class="panel"><p class="dim" style="padding:18px">' + esc(e.message) + '</p></div>'; }
  }

  async function save(quiet) {
    if (!cur || !isActive(cur.status)) return true;
    var invalid = document.querySelector('#stockcount [data-in].field-invalid');
    if (invalid) { showErr('Fix the highlighted counted quantity before saving.'); invalid.focus(); return false; }
    // Send every line (so cleared boxes are saved as "not counted" too)
    var lines = cur.items.map(function (i) { return { sku: i.sku, countedQty: i.countedQty, note: i.note }; });
    try { await api('/stock-counts/' + encodeURIComponent(cur.id) + '/lines', { method: 'PUT', body: JSON.stringify({ lines: lines }) }); dirty = false; if (!quiet) toast('Progress saved'); return true; }
    catch (e) { showErr(e.message); return false; }
  }

  function onInput(e) {
    var t = e.target, sku = t.getAttribute('data-in'), nsku = t.getAttribute('data-note');
    if (!sku && !nsku) return;
    var it = cur.items.filter(function (i) { return i.sku === (sku || nsku); })[0]; if (!it) return;
    if (sku) {
      var raw = t.value.trim();
      if (raw === '') { it.countedQty = null; t.classList.remove('field-invalid'); }
      else { var n = Number(raw); if (!isFinite(n) || n < 0) { t.classList.add('field-invalid'); if (window.FormAssist) FormAssist.validation.show(t, 'Enter a quantity of zero or more.'); return; } t.classList.remove('field-invalid'); it.countedQty = round2(n); }
      if (window.FormAssist) FormAssist.validation.show(t, '');
      var row = t.closest('tr'), d = diffOf(it), v = d === null ? null : d * it.unitCost;
      row.classList.toggle('sc-row-diff', !!d);
      row.classList.toggle('sc-row-over', overOf(it) && !(blind && (cur.status === 'open' || cur.status === 'recount')));
      if (!blind) { row.querySelector('[data-d]').innerHTML = diffCell(it); row.querySelector('[data-v]').innerHTML = v === null || v === 0 ? '—' : '<span class="' + (v > 0 ? 'sc-up' : 'sc-down') + '">' + peso(v) + '</span>'; }
      renderSummary();
    } else it.note = t.value;
    dirty = true; showErr('');
  }

  // Review dialog. Step 1: items above the variance limit that were never recounted must be recounted first (nothing can be posted).
  // Step 2: lists only the lines that will change stock; items still above the limit after a recount need a note.
  function changeText(i) { var d = diffOf(i); return (d > 0 ? '+' : '−') + num(Math.abs(d)) + ' ' + esc(i.unit); }
  function diffTable(list) {
    return '<div class="table-wrapper"><table><thead><tr><th>Product</th><th class="r">System</th><th class="r">Counted</th><th class="r">Change</th><th class="r">Value</th></tr></thead><tbody>' +
      list.map(function (i) { var d = diffOf(i); return '<tr><td>' + esc(i.name) + (i.recounts ? '<div class="dim" style="font-size:12px">1st count ' + num(i.firstQty) + ' · recounted</div>' : '') + '</td><td class="r">' + num(i.systemQty) + '</td><td class="r">' + num(i.countedQty) + '</td><td class="r ' + (d > 0 ? 'sc-up' : 'sc-down') + '">' + changeText(i) + '</td><td class="r">' + peso(d * i.unitCost) + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }
  function review() {
    var counted = cur.items.filter(function (i) { return i.countedQty !== null; });
    if (!counted.length) return showErr('Enter at least one counted quantity first.');
    var diffs = counted.filter(function (i) { return diffOf(i) !== 0; });
    var net = diffs.reduce(function (s, i) { return s + diffOf(i) * i.unitCost; }, 0);
    var over = counted.filter(overOf);
    var must = over.filter(function (i) { return i.recounts === 0; });
    var explain = over.filter(function (i) { return i.recounts > 0; });
    var ov = document.createElement('div'); ov.className = 'modal-overlay open'; ov.style.zIndex = 1200;
    var shell = function (inner) { return '<div class="account-modal" style="max-width:640px;width:100%;max-height:92vh;overflow:auto" role="dialog" aria-modal="true">' + inner + '</div>'; };
    if (must.length) {
      ov.innerHTML = shell('<h3 style="margin:0 0 8px">Recount needed before posting</h3>' +
        '<p class="dim"><b>' + must.length + '</b> item(s) are above the variance limit (' + esc(limitText()) + '). Only these items are counted again, with the box emptied so it is a fresh count. Then you can post ' + esc(cur.no) + '.</p>' + diffTable(must) +
        '<div class="sc-err" id="scPostErr"></div><div class="modal-actions" style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap"><button class="btn-primary" id="scConfirm">Send ' + must.length + ' item(s) for recount</button><button class="btn-secondary" id="scBack">Go back</button></div>');
      document.body.appendChild(ov);
      $('scBack').onclick = function () { ov.remove(); };
      $('scConfirm').onclick = async function () {
        if (busy) return; busy = true; this.disabled = true; this.textContent = 'Sending…';
        try {
          if (!(await save(true))) throw new Error('Could not save your counts — check your connection and try again.');
          var r = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/recount', { method: 'POST', body: JSON.stringify({ skus: must.map(function (i) { return i.sku; }) }) });
          ov.remove(); toast(r.recount + ' item(s) sent for recount.'); await openCount(cur.id);
        } catch (e) { var pe = $('scPostErr'); pe.textContent = e.message; pe.classList.add('show'); this.disabled = false; this.textContent = 'Send ' + must.length + ' item(s) for recount'; }
        busy = false;
      };
      return;
    }
    ov.innerHTML = shell('<h3 style="margin:0 0 8px">Post ' + esc(cur.no) + '?</h3>' +
      '<p class="dim">' + counted.length + ' product(s) counted, <b>' + diffs.length + '</b> will change stock. Products you left blank are not touched. This cannot be undone — it writes Stock In / Stock Out entries.</p>' +
      (diffs.length ? diffTable(diffs) + '<p style="margin:10px 0 0">Net value of corrections: <b class="' + (net < 0 ? 'sc-down' : net > 0 ? 'sc-up' : '') + '">' + peso(net) + '</b></p>'
        : '<p>Everything counted matches the system. Posting will just close this count.</p>') +
      (explain.length ? '<div class="sc-explain"><b>Still above the variance limit after recount — select reason</b>' + explain.map(function (i) {
        var reasons = VARIANCE_REASONS[i.department] || VARIANCE_REASONS['Raw Materials'];
        return '<div style="margin-bottom:8px"><label style="font-weight:600">' + esc(i.name) + ' (' + changeText(i) + ' · ' + esc(i.department) + ')</label>' +
          '<select class="form-select" data-need-note="' + esc(i.sku) + '" style="margin-top:4px">' +
          '<option value="">Select standard variance reason…</option>' +
          reasons.map(function (r) { return '<option value="' + esc(r) + '"' + (i.note === r ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') +
          '</select></div>'; }).join('') + '</div>' : '') +
      '<div class="sc-err" id="scPostErr"></div>' +
      '<div class="modal-actions" style="display:flex;gap:10px;margin-top:16px"><button class="btn-primary" id="scConfirm">Post corrections</button><button class="btn-secondary" id="scBack">Go back</button></div>');
    document.body.appendChild(ov);
    $('scBack').onclick = function () { ov.remove(); };
    $('scConfirm').onclick = async function () {
      if (busy) return;
      var pe = $('scPostErr'); pe.classList.remove('show');
      var boxes = ov.querySelectorAll('[data-need-note]');
      for (var k = 0; k < boxes.length; k++) {
        var val = boxes[k].value.trim(), it = cur.items.filter(function (i) { return i.sku === boxes[k].getAttribute('data-need-note'); })[0];
        if (!val) { boxes[k].classList.add('field-invalid'); pe.textContent = 'Add a note for ' + (it ? it.name : 'every item that is still above the limit') + '.'; pe.classList.add('show'); boxes[k].focus(); return; }
        if (it && it.note !== val) { it.note = val; dirty = true; }
      }
      busy = true; this.disabled = true; this.textContent = 'Posting…';
      try {
        if (!(await save(true))) throw new Error('Could not save your counts — check your connection and try again.');
        var r = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/post', { method: 'POST' });
        ov.remove(); toast(r.no + ' posted: ' + r.increased + ' increased, ' + r.decreased + ' decreased.');
        await openCount(cur.id); await refreshInventory();
      } catch (e) { pe.textContent = e.message; pe.classList.add('show'); this.disabled = false; this.textContent = 'Post corrections'; }
      busy = false;
    };
  }

  // the Finance app reloads its stock numbers by itself every 10 seconds, so nothing else is needed after posting
  async function refreshInventory() {}

  function bind() {
    document.addEventListener('click', async function (e) {
      var b = e.target.closest('#stockcount button, #stockcount [data-sc]');
      if (!b || !$('stockcount')) return;
      if (b.id === 'scPresetStd') {
        if ($('scHV')) $('scHV').value = '50000';
        if ($('scFM')) $('scFM').value = '4';
        if ($('scFD')) $('scFD').value = '30';
        if ($('scSD')) $('scSD').value = '28';
        if ($('scVP')) $('scVP').value = '5';
        if ($('scVV')) $('scVV').value = '2000';
        toast('Standard rules preset applied');
        return;
      }
      if (b.id === 'scPresetStrict') {
        if ($('scHV')) $('scHV').value = '25000';
        if ($('scFM')) $('scFM').value = '2';
        if ($('scFD')) $('scFD').value = '30';
        if ($('scSD')) $('scSD').value = '14';
        if ($('scVP')) $('scVP').value = '3';
        if ($('scVV')) $('scVV').value = '1000';
        toast('Strict rules preset applied');
        return;
      }
      var act = b.getAttribute('data-sc');
      try {
        if (act === 'open') await openCount(b.getAttribute('data-id'));
        else if (b.id === 'scToggleManualBtn') {
          var mf = $('scManualStartForm'); if (mf) { mf.hidden = !mf.hidden; b.setAttribute('aria-expanded', String(!mf.hidden)); b.textContent = mf.hidden ? 'Unlock manual count' : 'Hide manual count'; }
        }
        else if (act === 'sched-edit') { var f = $('scSchedForm'); if (f) f.hidden = !f.hidden; }
        else if (act === 'sched-save') {
          var se = $('scSchedErr'); if (se) se.textContent = '';
          try {
            sched = await api('/stock-counts/schedule', { method: 'PUT', body: JSON.stringify({ enabled: $('scSchedOn').value === '1', weekday: Number($('scSchedDay').value), scope: $('scSchedScope').value, dueDays: Number($('scSchedDue').value),
              cadenceOn: $('scCad').value === '1', highValue: $('scHV').value, fastMoves: $('scFM').value, fastDays: $('scFD').value, slowDays: $('scSD').value, varPct: $('scVP').value, varValue: $('scVV').value }) });
            toast('Count rules saved.'); renderList();
          } catch (e2) { if (se) se.textContent = e2.message; }
        }
        else if (act === 'back') { if (dirty && !(await save(true))) return; await showList(); }
        else if (b.id === 'scStart') {
          showErr('');
          var reason = $('scReason').value, other = ($('scNote').value || '').trim();
          if (!reason) { $('scReason').classList.add('field-invalid'); $('scReason').focus(); return showErr('Select a reason for the manual count.'); }
          if (reason.indexOf('Other') === 0 && !other) { $('scNote').classList.add('field-invalid'); $('scNote').focus(); return showErr('Describe the reason for the manual count.'); }
          var noteText = (reason.indexOf('Other') === 0 ? 'Other: ' + other : reason).slice(0, 300);
          var r = await api('/stock-counts', { method: 'POST', body: JSON.stringify({ department: $('scDept').value, mode: $('scMode').value, note: noteText }) });
          await openCount(r.id);
        }
        else if (b.id === 'scSave') await save(false);
        else if (b.id === 'scSubmit') {
          if (!(await save(true))) return;
          var sr = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/submit', { method: 'POST' });
          toast(sr.status === 'submitted' ? cur.no + ' submitted for review.' : sr.recount + ' item(s) still above the limit were sent back for a recount.'); await openCount(cur.id);
        }
        else if (b.id === 'scRecountBtn') {
          var rc = recountable();
          if (!(await uiConfirm({ title: 'Request a recount?', message: rc.length + ' item(s) are above the variance limit. Only those items go back to staff, with the box emptied.', confirm: 'Request recount', cancel: 'Not now' }))) return;
          var rr = await api('/stock-counts/' + encodeURIComponent(cur.id) + '/recount', { method: 'POST', body: JSON.stringify({}) });
          toast(rr.recount + ' item(s) sent for recount.'); await openCount(cur.id);
        }
        else if (b.id === 'scPost') { if (await save(true)) review(); }
        else if (b.id === 'scCancel') {
          if (!(await uiConfirm({ title: 'Cancel ' + cur.no + '?', message: 'Stock is not changed. The counts you typed stay in the history.', confirm: 'Cancel count', cancel: 'Keep counting', danger: true }))) return;
          await api('/stock-counts/' + encodeURIComponent(cur.id) + '/cancel', { method: 'POST' }); toast(cur.no + ' cancelled'); await showList();
        }
      } catch (err) { showErr(err.message); if (!$('scErr')) toast(err.message, true); }
    });
    document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#stockcount')) { if (e.target.id === 'scSearch') { term = e.target.value; renderRows(); } else onInput(e); } });
    document.addEventListener('change', function (e) {
      if (!e.target.closest || !e.target.closest('#stockcount')) return;
      if (e.target.id === 'scFilter') { filter = e.target.value; renderRows(); }
      if (e.target.id === 'scReason') {
        e.target.classList.remove('field-invalid'); showErr('');
        var ow = $('scOtherWrap'); if (ow) { ow.hidden = e.target.value.indexOf('Other') !== 0; if (!ow.hidden) $('scNote').focus(); }
      }
      if (e.target.id === 'scBlind') { blind = e.target.checked; renderCount(); }
    });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  // Staff work on their own screens, so every 20 seconds this page quietly picks up their progress (submitted, recount, ...).
  // It never replaces the screen while you are typing or have unsaved changes.
  function sig(c) { return c.status + '|' + (c.items || []).map(function (i) { return i.sku + ':' + i.countedQty + ':' + i.needsRecount + ':' + i.note; }).join(','); }
  async function poll() {
    var sec = $('stockcount');
    if (!sec || !sec.classList.contains('active-page') || document.hidden || busy || dirty) return;
    var ae = document.activeElement; if (ae && sec.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    try {
      if (cur && isActive(cur.status)) {
        var fresh = await api('/stock-counts/' + encodeURIComponent(cur.id));
        if (!dirty && !busy && cur && fresh.id === cur.id && sig(fresh) !== sig(cur)) { cur = fresh; renderCount(); }
      } else if (!cur) {
        var f = $('scSchedForm'); if (f && !f.hidden) return;
        await showList();
      }
    } catch (e) { /* try again in 20 seconds */ }
  }

  function init() {
    addStyles(); if (!build()) return; bind();
    // load the page whenever it is shown, not only from its own menu button (page memory, links and refresh use navigateToPage too)
    if (typeof window.navigateToPage === 'function' && !window.navigateToPage.scWrapped) {
      var nav = window.navigateToPage;
      window.navigateToPage = function (page) { var r = nav.apply(this, arguments); if (page === 'stockcount') onOpen(); return r; };
      window.navigateToPage.scWrapped = true;
    }
    if (location.hash === '#stockcount' && typeof navigateToPage === 'function') navigateToPage('stockcount');   // page reloaded while on Stock Count
    setInterval(poll, 20000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();