/* reports-inventory.js — Finance > Reports > "Inventory Reports".
   Stock in / out, material consumption, finished-goods production, stock adjustments, returns & restocking and the
   full movement ledger. All figures come from /api/reports/inventory (SQL over stock_movements, production_*,
   pos_return_requests, order_refund_requests). Values are at cost. Philippine days.
   Needs reports-sales.css and a <div id="repInvRoot"></div> inside the Reports page. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pesoShort = (n) => { const a = Math.abs(n); return '\u20B1' + (a >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n)); };
  const num = (n) => Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 });
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => y + '-' + pad(m) + '-' + pad(d);
  const todayPH = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const parts = (s) => s.split('-').map(Number);
  const addDays = (s, n) => { const p = parts(s), t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
  const lastOfMonth = (y, m) => ymd(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
  const PRESETS = [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year'], ['custom', 'Custom']];
  function presetRange(key) {
    const t = todayPH(), p = parts(t);
    switch (key) {
      case 'today': return { from: t, to: t };
      case '7d': return { from: addDays(t, -6), to: t };
      case '30d': return { from: addDays(t, -29), to: t };
      case 'month': return { from: ymd(p[0], p[1], 1), to: t };
      case 'lastmonth': { const y = p[1] === 1 ? p[0] - 1 : p[0], m = p[1] === 1 ? 12 : p[1] - 1; return { from: ymd(y, m, 1), to: lastOfMonth(y, m) }; }
      case 'year': return { from: ymd(p[0], 1, 1), to: t };
      default: return null;
    }
  }
  const REASON = { supplier_receipt: 'Received from supplier', customer_return: 'Returned by customer', produced_batch: 'Produced \u2014 new batch', production_output: 'Produced in-house', count_correction_up: 'Stock count correction (+)', count_correction_down: 'Stock count correction (\u2212)',
    rust_corrosion: 'Rust / corrosion', damaged: 'Damaged', damage: 'Damaged', scrap_cutting_waste: 'Scrap / cutting waste', production_use: 'Used in production', quality_rejection: 'Failed quality inspection', lost_missing: 'Lost / missing', returned_to_supplier: 'Returned to supplier',
    sale: 'POS sale', online_order: 'Online order', return: 'Return restocked', refund: 'Cancelled / refunded order restocked', correction: 'Correction', opening_balance: 'Opening balance', write_off: 'Write-off', other: 'Other' };
  const GROUPS = ['Supplier receipts', 'Finished goods produced', 'Returns and restocking', 'Stock adjustments', 'Sales', 'Material consumption', 'Losses and write-offs', 'Returned to supplier', 'Other'];
  
  const state = { preset: '30d', from: '', to: '', grain: '', dept: 'all', type: 'all', group: 'all', search: '', page: 1, data: null, loading: false, error: '', seq: 0, built: false, loadedOnce: false, timer: null };

  const qs = (extra) => 'from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to) + (state.grain ? '&grain=' + state.grain : '') + '&dept=' + encodeURIComponent(state.dept) + '&type=' + state.type + '&group=' + encodeURIComponent(state.group) + '&q=' + encodeURIComponent(state.search) + '&page=' + state.page + '&pageSize=10' + (extra || '');
  async function getJson(path) {
    const res = await fetch('/api' + path, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 403 ? 'Only Finance-Admin can view financial reports.' : 'Could not load the report.'));
    return data;
  }
  function toast(message, type) {
    const el = document.createElement('div'); el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 4500);
  }
  function checkDates() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.from) || !/^\d{4}-\d{2}-\d{2}$/.test(state.to)) return 'Choose both dates.';
    if (state.from > state.to) return 'The start date must not be after the end date.';
    if ((Date.parse(state.to) - Date.parse(state.from)) / 86400000 + 1 > 1100) return 'Choose a range of 1,100 days or less.';
    return '';
  }
  const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>';

  function build() {
    const root = $('repInvRoot'); if (!root || state.built) return;
    state.built = true;
    root.innerHTML =
      '<div class="panel rs-panel">' +
        '<div class="panel-head rs-head"><div><div class="panel-title" id="ivTitle">Stock in, stock out and production</div>' +
        '<div class="panel-sub" id="ivSub">Stock in and out, material use, production, adjustments and returns. Values are at cost.</div></div>' +
        '<div class="rs-actions"><button type="button" class="btn-secondary" id="ivRefresh">Refresh</button><button type="button" class="btn-primary" id="ivCsv">Export CSV</button></div></div>' +
        '<div class="rs-filters">' +
          '<div class="rs-msg" id="ivMsg" role="alert"></div>' +
        '</div>' +
      '</div>' +
      '<div id="ivBody"></div>';

    $('ivRefresh').addEventListener('click', load); $('ivCsv').addEventListener('click', downloadCsv);
    $('ivBody').addEventListener('click', (e) => {
      if (e.target.closest('#ivRetry')) return load();
      if (e.target.closest('#ivPrev')) { state.page = Math.max(1, state.page - 1); return load(); }
      if (e.target.closest('#ivNext')) { state.page += 1; return load(); }
    });
    $('ivBody').addEventListener('change', (e) => {
      const t = e.target; if (!t.dataset.f) return;
      state[t.dataset.f] = t.value; state.page = 1; load();
    });
    $('ivBody').addEventListener('input', (e) => {
      if (e.target.id !== 'ivSearch') return;
      state.search = e.target.value.trim().slice(0, 60); clearTimeout(state.timer); state.timer = setTimeout(() => { state.page = 1; load(true); }, 300);
    });
    const r = sharedRange() || presetRange(state.preset); state.from = r.from; state.to = r.to; sync();
    window.addEventListener('tripleE:reportrange', (e) => applyRange(e.detail));
  }
  /* the dates come from the Report Period panel at the top of the Reports page */
  function sharedRange() { try { const r = window.TripleEReportRange && window.TripleEReportRange.get(); return r && r.from && r.to ? r : null; } catch (e) { return null; } }
  function applyRange(r) {
    if (!r || !r.from || !r.to) return;
    state.from = r.from; state.to = r.to; state.page = 1; sync();
    const page = $('reports'); if (state.loadedOnce || (page && page.classList.contains('active-page'))) load();
  }
  function sync() {
  }

  async function load(keepFocus) {
    const err = checkDates(); $('ivMsg').textContent = err; if (err) return;
    const seq = ++state.seq; state.loading = true; state.error = ''; if (!keepFocus) render();
    try { const d = await getJson('/reports/inventory?' + qs()); if (seq !== state.seq) return; state.data = d; }
    catch (e) { if (seq !== state.seq) return; state.error = e.message; state.data = null; }
    state.loading = false; state.loadedOnce = true; render(keepFocus === true);
  }
  async function downloadCsv() {
    const err = checkDates(); if (err) return toast(err, 'error');
    const btn = $('ivCsv'); btn.disabled = true;
    try {
      const res = await fetch('/api/reports/inventory.csv?' + qs(), { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not export.'); }
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a');
      a.href = url; a.download = 'inventory_' + state.from + '_to_' + state.to + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  }

  const card = (l, v, s, cls) => '<div class="rs-kpi ' + (cls || '') + '"><div class="rs-kpi-label">' + l + '</div><div class="rs-kpi-value">' + v + '</div><div class="rs-kpi-sub">' + s + '</div></div>';
  const empty = (title, msg) => '<div class="panel rs-empty"><strong>' + title + '</strong><p>' + msg + '</p></div>';

  function render(keepFocus) {
    const body = $('ivBody'); if (!body) return;
    if (state.loading && !state.data) { body.innerHTML = '<div class="rs-kpis four">' + '<div class="rs-kpi rs-skel"></div>'.repeat(4) + '</div><div class="panel rs-skel rs-skel-chart"></div>'; return; }
    if (state.error) { body.innerHTML = '<div class="panel rs-empty"><strong>Could not load the inventory report</strong><p>' + esc(state.error) + '</p><button type="button" class="btn-secondary" id="ivRetry">Try again</button></div>'; return; }
    const d = state.data; if (!d) return;
    paintHead(d);
    const section = (id, title, inner) => '<section class="rs-section" id="' + id + '"><h3 class="rs-section-title">' + title + '</h3>' + inner + '</section>';
    const html = section('ivOverview', 'Stock in &amp; out', overview(d)) + section('ivMaterials', 'Materials &amp; production', materials(d)) +
      section('ivReturns', 'Returns &amp; restocking', returns(d)) + section('ivMovements', 'Stock Movement Log', movements(d));
    const active = document.activeElement && document.activeElement.id, pos = active === 'ivSearch' ? document.activeElement.selectionStart : null;
    body.classList.toggle('rs-busy', state.loading); body.innerHTML = html;
    if (keepFocus && active === 'ivSearch') { const s = $('ivSearch'); if (s) { s.focus(); try { s.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }
  }

  /* The one-page report shows this twice: totals and trends under "Inventory Report", and the entries behind them under "Stock Movement Log". */
  function paintHead(d) {
    const t = $('ivTitle'), s = $('ivSub'); if (!t || !s) return;
    const range = d ? ' ' + d.range.from + ' to ' + d.range.to + ', Philippine time.' : '';
    t.textContent = 'Stock in, stock out and production';
    s.textContent = 'Totals and trends: what came in, went out, was used, produced or returned. Values at cost.' + range;
  }

  /* ---------- overview ---------- */
  function overview(d) {
    const t = d.totals, net = t.inValue - t.outValue;
    if (!t.movements && !d.production.batches) return empty('No inventory activity in this period', 'No stock movements were recorded between ' + esc(d.range.from) + ' and ' + esc(d.range.to) + '. Try a wider date range.');
    // Produced and Restocked returns are shown (once) in their own sections below, so they are not repeated here.
    return '<div class="rs-kpis four">' + card('Stock in', peso(t.inValue), 'at cost') + card('Stock out', peso(t.outValue), 'at cost') +
      card('Net change', (net >= 0 ? '+' : '\u2212') + peso(Math.abs(net)), 'in minus out', net < 0 ? 'warn' : '') + card('Movements', num(t.movements), 'ledger entries') + '</div>' +
      '<div class="rs-grid">' + trend(d) + deptPanel(d) + '</div>' + groupsPanel(d);
  }

  function niceMax(v) { if (v <= 0) return 100; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
  function trend(d) {
    const b = d.trend, W = 900, H = 300, L = 62, R = 10, T = 14, B = 34, iw = W - L - R, ih = H - T - B;
    const max = niceMax(Math.max.apply(null, b.map((x) => Math.max(x.in, x.out)).concat([0]))), step = iw / b.length, bw = Math.max(2, Math.min(24, step * 0.36)), y = (v) => T + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = max / 4 * i, yy = y(v); g += '<line class="rs-grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/><text class="rs-ax" x="' + (L - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + pesoShort(v) + '</text>'; }
    const every = Math.ceil(b.length / 12);
    b.forEach((x, i) => {
      const cx = L + step * i + step / 2, tip = esc(x.label) + '|Stock in ' + peso(x.in) + '|Stock out ' + peso(x.out);
      g += '<g class="rs-bar" data-tip="' + tip + '"><rect class="rs-hit" x="' + (cx - step / 2) + '" y="' + T + '" width="' + step + '" height="' + ih + '"/>' +
        (x.in > 0 ? '<rect class="rs-in" x="' + (cx - bw - 1) + '" y="' + y(x.in) + '" width="' + bw + '" height="' + (y(0) - y(x.in)) + '" rx="2"/>' : '') +
        (x.out > 0 ? '<rect class="rs-out" x="' + (cx + 1) + '" y="' + y(x.out) + '" width="' + bw + '" height="' + (y(0) - y(x.out)) + '" rx="2"/>' : '') + '</g>';
      if (i % every === 0) g += '<text class="rs-ax" x="' + cx + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(x.label) + '</text>';
    });
    return '<div class="panel rs-card rs-wide"><div class="panel-head"><div><div class="panel-title">Stock in vs stock out</div><div class="panel-sub">Value at cost per ' + esc(d.range.grain) + '</div></div>' +
      '<div class="rs-legend"><span><i class="rs-in"></i>In</span><span><i class="rs-out"></i>Out</span></div></div>' +
      '<div class="rs-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Stock in and stock out">' + g + '</svg><div class="rs-tip" id="ivTip" hidden></div></div></div>';
  }

  function deptPanel(d) {
    const max = Math.max.apply(null, d.departments.map((x) => Math.max(x.inValue, x.outValue)).concat([1]));
    const rows = d.departments.map((x) => '<div class="rs-ch"><div class="rs-ch-top"><span>' + esc(x.department) + '</span><strong>' + num(x.movements) + ' movements</strong></div>' +
      '<div class="rs-track" title="In ' + peso(x.inValue) + '"><div class="rs-in" style="width:' + (x.inValue / max * 100).toFixed(1) + '%"></div></div>' +
      '<div class="rs-track" title="Out ' + peso(x.outValue) + '"><div class="rs-out" style="width:' + (x.outValue / max * 100).toFixed(1) + '%"></div></div>' +
      '<div class="rs-ch-sub">In ' + peso(x.inValue) + ' \u00B7 Out ' + peso(x.outValue) + '</div></div>').join('');
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">By department</div><div class="panel-sub">Raw Materials, Finishing Supplies, Finished Goods</div></div></div>' + rows + '</div>';
  }

  function groupsPanel(d) {
    const ins = d.groups.filter((g) => g.type === 'in'), outs = d.groups.filter((g) => g.type === 'out');
    const tbl = (title, rows, cls) => '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">' + title + '</div></div></div><div class="rs-scroll"><table class="rs-table"><thead><tr><th>Reason group</th><th class="rs-num">Movements</th><th class="rs-num">Value</th></tr></thead><tbody>' +
      (rows.map((g) => '<tr><td><span class="rs-pill ' + cls + '">' + (cls === 'in' ? 'IN' : 'OUT') + '</span> ' + esc(g.group) + '</td><td class="rs-num">' + num(g.movements) + '</td><td class="rs-num"><strong>' + peso(g.value) + '</strong></td></tr>').join('') || '<tr><td colspan="3" class="rs-none">None in this period.</td></tr>') + '</tbody></table></div></div>';
    return '<div class="rs-two">' + tbl('Stock in', ins, 'in') + tbl('Stock out', outs, 'out') + '</div>';
  }

  /* ---------- materials & production ---------- */
  function materials(d) {
    const cons = d.consumption, usage = d.materialUsage, prod = d.production;
    const consRows = cons.map((c) => '<tr><td class="rs-sku">' + esc(c.sku) + '</td><td>' + esc(c.name) + '</td><td>' + esc(c.department) + '</td><td class="rs-num">' + num(c.qty) + ' <span class="rs-dim">' + esc(c.unit) + '</span></td><td class="rs-num"><strong>' + peso(c.value) + '</strong></td></tr>').join('');
    const useRows = usage.map((u) => { const v = u.variance, cls = v > 0 ? 'over' : v < 0 ? 'under' : 'even'; return '<tr><td class="rs-sku">' + esc(u.sku) + '</td><td>' + esc(u.name) + '</td><td class="rs-num">' + num(u.planned) + ' <span class="rs-dim">' + esc(u.unit) + '</span></td><td class="rs-num">' + num(u.actual) + '</td><td class="rs-num"><span class="rs-var ' + cls + '">' + (v > 0 ? '+' : '') + num(v) + '</span></td></tr>'; }).join('');
    const prodRows = prod.products.map((p) => '<tr><td class="rs-sku">' + esc(p.sku) + '</td><td>' + esc(p.name) + '</td><td class="rs-num">' + num(p.batches) + '</td><td class="rs-num"><strong>' + num(p.qty) + '</strong> <span class="rs-dim">' + esc(p.unit) + '</span></td></tr>').join('');
    const t = (title, sub, head, rows, cols) => '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">' + title + '</div><div class="panel-sub">' + sub + '</div></div></div><div class="rs-scroll"><table class="rs-table"><thead><tr>' + head + '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + cols + '" class="rs-none">Nothing recorded in this period.</td></tr>') + '</tbody></table></div></div>';
    return '<div class="rs-kpis three">' + card('Materials used', num(cons.length), 'distinct materials / supplies') + card('Consumption value', peso(cons.reduce((n, c) => n + c.value, 0)), 'used in production, at cost') + card('Finished goods made', num(prod.units), num(prod.batches) + ' confirmed batch' + (prod.batches === 1 ? '' : 'es')) + '</div>' +
      t('Material consumption', 'Stock taken out for production', '<th>SKU</th><th>Material</th><th>Department</th><th class="rs-num">Used</th><th class="rs-num">Value</th>', consRows, 5) +
      '<div style="height:14px"></div><div class="rs-two">' +
      t('Planned vs actual use', 'From confirmed production records. Over = more material than the recipe says.', '<th>SKU</th><th>Material</th><th class="rs-num">Planned</th><th class="rs-num">Actual</th><th class="rs-num">Variance</th>', useRows, 5) +
      t('Finished goods production', 'Confirmed production batches', '<th>SKU</th><th>Product</th><th class="rs-num">Batches</th><th class="rs-num">Quantity</th>', prodRows, 4) + '</div>';
  }

  /* ---------- returns ---------- */
  function returns(d) {
    const rows = d.returns.map((r) => '<tr><td>' + esc(r.source) + '</td><td class="rs-num">' + num(r.count) + '</td><td class="rs-num"><strong>' + peso(r.amount) + '</strong></td><td class="rs-num">' + num(r.restocked) + '</td><td class="rs-num">' + num(r.count - r.restocked) + '</td></tr>').join('');
    const tot = d.returns.reduce((a, r) => ({ c: a.c + r.count, m: a.m + r.amount, s: a.s + r.restocked }), { c: 0, m: 0, s: 0 });
    const gr = (n) => (d.groups.find((g) => g.group === 'Returns and restocking' && g.type === 'in') || {})[n] || 0;
    return '<div class="rs-kpis three">' + card('Approved returns / refunds', num(tot.c), 'POS returns + online refunds') + card('Money refunded', peso(tot.m), 'approved in this period', tot.m > 0 ? 'warn' : '') + card('Stock put back', peso(gr('value')), num(gr('movements')) + ' restock movement' + (gr('movements') === 1 ? '' : 's') + ', at cost') + '</div>' +
      '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Product returns and restocking</div><div class="panel-sub">Approved by Finance in this period. \u201CNot restocked\u201D items were refunded but not put back on the shelf (damaged or unsellable).</div></div></div><div class="rs-scroll"><table class="rs-table"><thead><tr><th>Source</th><th class="rs-num">Approved</th><th class="rs-num">Refunded</th><th class="rs-num">Restocked</th><th class="rs-num">Not restocked</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="5" class="rs-none">No returns in this period.</td></tr>') + '</tbody></table></div></div>';
  }

  /* ---------- movement ledger ---------- */
  function movements(d) {
    const m = d.movements;
    const filters = '<div class="panel rs-panel"><div class="rs-filters" style="margin-top:0">' +
      '<label class="rs-date">Department <select class="inv-select" data-f="dept">' + opt('all', 'All', state.dept) + ['Raw Materials', 'Finishing Supplies', 'Finished Goods'].map((x) => opt(x, x, state.dept)).join('') + '</select></label>' +
      '<label class="rs-date">Direction <select class="inv-select" data-f="type">' + opt('all', 'In and out', state.type) + opt('in', 'Stock in', state.type) + opt('out', 'Stock out', state.type) + '</select></label>' +
      '<label class="rs-date">Reason <select class="inv-select" data-f="group">' + opt('all', 'All reasons', state.group) + GROUPS.filter((x) => x !== 'Other').map((x) => opt(x, x, state.group)).join('') + '</select></label>' +
      '<input type="search" id="ivSearch" class="rs-search" placeholder="Search SKU, product or reference" value="' + esc(state.search) + '" autocomplete="off" aria-label="Search movements"></div></div>';
    const rows = m.rows.map((r) => '<tr><td>' + esc(r.day) + '</td><td class="rs-sku">' + esc(r.ref) + '</td><td><span class="rs-pill ' + r.type + '">' + (r.type === 'in' ? 'IN' : 'OUT') + '</span></td>' +
      '<td>' + esc(REASON[r.reason] || r.reason) + '<span class="rs-dim" style="display:block">' + esc(r.group) + '</span></td><td><span class="rs-sku">' + esc(r.sku) + '</span><span class="rs-dim" style="display:block">' + esc(r.name) + '</span></td>' +
      '<td class="rs-num"><strong>' + (r.type === 'in' ? '+' : '\u2212') + num(r.qty) + '</strong> <span class="rs-dim">' + esc(r.unit) + '</span></td><td class="rs-num">' + peso(r.value) + '</td><td>' + esc(r.department) + '</td><td>' + esc(r.by || '\u2014') + '</td><td class="rs-dim" style="white-space:normal;min-width:140px">' + esc(r.note) + '</td></tr>').join('');
    return filters + '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Inventory movements</div><div class="panel-sub">' + num(m.total) + ' movement' + (m.total === 1 ? '' : 's') + ' match, newest first. Quantities are per product, so they are not added together.</div></div></div>' +
      '<div class="rs-scroll"><table class="rs-table"><thead><tr><th>Date</th><th>Reference</th><th>Direction</th><th>Reason</th><th>Product</th><th class="rs-num">Quantity</th><th class="rs-num">Value</th><th>Department</th><th>By</th><th>Note</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="10" class="rs-none">No movements match these filters.</td></tr>') + '</tbody></table></div>' +
      '<div class="rs-pager"><span>Page ' + m.page + ' of ' + m.pages + '</span><div class="rs-actions"><button type="button" class="btn-secondary" id="ivPrev"' + (m.page <= 1 ? ' disabled' : '') + '>Previous</button><button type="button" class="btn-secondary" id="ivNext"' + (m.page >= m.pages ? ' disabled' : '') + '>Next</button></div></div></div>';
  }

  /* ---------- chart tooltip ---------- */
  document.addEventListener('mouseover', (e) => {
    const g = e.target.closest && e.target.closest('#ivBody .rs-bar'); if (!g) return;
    const tip = $('ivTip'); if (!tip) return;
    const box = tip.parentNode.getBoundingClientRect(), r = g.getBoundingClientRect(), p = g.dataset.tip.split('|');
    tip.innerHTML = '<strong>' + p[0] + '</strong>' + p.slice(1).map((x) => '<div>' + x + '</div>').join(''); tip.hidden = false;
    const x = r.left - box.left + r.width / 2, w = tip.offsetWidth; tip.style.left = Math.max(4, Math.min(box.width - w - 4, x - w / 2)) + 'px'; tip.style.top = '4px';
  });
  document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('#ivBody .rs-bar')) { const t = $('ivTip'); if (t) t.hidden = true; } });

  function init() {
    build(); const page = $('reports'); if (!page || !state.built) return;
    const kick = () => { if (page.classList.contains('active-page') && !state.loadedOnce && !state.loading) load(); };
    new MutationObserver(kick).observe(page, { attributes: true, attributeFilter: ['class'] }); kick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();