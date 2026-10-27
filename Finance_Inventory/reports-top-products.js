/* reports-top-products.js — Finance > Reports > "Top-Selling Products".
   Ranks products from real, realized sales lines (POS + online combined, voided / cancelled / unpaid excluded,
   returns and refunds deducted). All figures come from /api/reports/top-products (SQL). Philippine days.
   Needs reports-sales.css and a <div id="repTopRoot"></div> inside the Reports page. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  const state = { preset: '30d', from: '', to: '', channel: 'all', sort: 'revenue', limit: 10, search: '', data: null, loading: false, error: '', seq: 0, built: false, loadedOnce: false };

  const qs = () => 'from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to) + '&channel=' + state.channel + '&sort=' + state.sort + '&limit=' + state.limit;
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

  function build() {
    const root = $('repTopRoot'); if (!root || state.built) return;
    state.built = true;
    root.innerHTML =
      '<div class="panel rs-panel">' +
        '<div class="panel-head rs-head"><div><div class="panel-title">Top-Selling Products</div>' +
        '<div class="panel-sub" id="tpSub">Ranked from completed sales lines. POS and online are combined, each sale counted once.</div></div>' +
        '<div class="rs-actions"><button type="button" class="btn-secondary" id="tpRefresh">Refresh</button><button type="button" class="btn-primary" id="tpCsv">Export CSV</button></div></div>' +
        '<div class="rs-filters">' +
          '<div class="rs-follow" title="Change the dates in Report Period at the top of this page"><span class="rs-follow-dot"></span>Dates follow <b>Report Period</b>: <span id="tpFollow">…</span></div>' +
          '<label class="rs-date">Channel <select id="tpChannel" class="inv-select"><option value="all">POS + Online</option><option value="pos">POS only</option><option value="online">Online only</option></select></label>' +
          '<label class="rs-date">Rank by <select id="tpSort" class="inv-select"><option value="revenue">Revenue</option><option value="units">Units sold</option></select></label>' +
          '<label class="rs-date">Show <select id="tpLimit" class="inv-select"><option>10</option><option selected>20</option><option>50</option><option>100</option></select></label>' +
          '<input type="search" id="tpSearch" class="rs-search" placeholder="Search SKU or product" autocomplete="off" aria-label="Search products">' +
          '<div class="rs-msg" id="tpMsg" role="alert"></div>' +
        '</div>' +
      '</div><div id="tpBody"></div>';

    $('tpChannel').addEventListener('change', (e) => { state.channel = e.target.value; load(); });
    $('tpSort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });
    $('tpLimit').addEventListener('change', (e) => { state.limit = +e.target.value; load(); });
    $('tpSearch').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
    $('tpRefresh').addEventListener('click', load); $('tpCsv').addEventListener('click', downloadCsv);
    $('tpBody').addEventListener('click', (e) => { if (e.target.closest('#tpRetry')) load(); });
    const r = sharedRange() || presetRange(state.preset); state.from = r.from; state.to = r.to; sync();
    window.addEventListener('tripleE:reportrange', (e) => applyRange(e.detail));
  }
  /* the dates come from the Report Period panel at the top of the Reports page */
  function sharedRange() { try { const r = window.TripleEReportRange && window.TripleEReportRange.get(); return r && r.from && r.to ? r : null; } catch (e) { return null; } }
  function applyRange(r) {
    if (!r || !r.from || !r.to) return;
    state.from = r.from; state.to = r.to; sync();
    const page = $('reports'); if (state.loadedOnce || (page && page.classList.contains('active-page'))) load();
  }
  function sync() {
    const f = $('tpFollow'); if (f) f.textContent = state.from === state.to ? state.from : state.from + ' to ' + state.to;
  }

  async function load() {
    const err = checkDates(); $('tpMsg').textContent = err; if (err) return;
    const seq = ++state.seq; state.loading = true; state.error = ''; render();
    try { const d = await getJson('/reports/top-products?' + qs()); if (seq !== state.seq) return; state.data = d; }
    catch (e) { if (seq !== state.seq) return; state.error = e.message; state.data = null; }
    state.loading = false; state.loadedOnce = true; render();
  }
  async function downloadCsv() {
    const err = checkDates(); if (err) return toast(err, 'error');
    const btn = $('tpCsv'); btn.disabled = true;
    try {
      const res = await fetch('/api/reports/top-products.csv?' + qs(), { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not export.'); }
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a');
      a.href = url; a.download = 'top-products_' + state.from + '_to_' + state.to + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  }

  /* the "Top seller" box in the summary at the top of the Reports page */
  function setTopSeller(row) {
    const v = $('repTopSeller'), sub = $('repTopSellerSub'); if (!v) return;
    v.textContent = row ? row.name : '\u2014'; v.title = row ? row.name : '';
    if (sub) sub.textContent = row ? num(row.units) + ' sold \u00B7 ' + peso(row.revenue) : 'no completed sales in this period';
  }
  function render() {
    const body = $('tpBody'); if (!body) return;
    if (state.loading && !state.data) { body.innerHTML = '<div class="rs-kpis three">' + '<div class="rs-kpi rs-skel"></div>'.repeat(3) + '</div><div class="panel rs-skel rs-skel-chart"></div>'; return; }
    if (state.error) { setTopSeller(null); body.innerHTML = '<div class="panel rs-empty"><strong>Could not load top-selling products</strong><p>' + esc(state.error) + '</p><button type="button" class="btn-secondary" id="tpRetry">Try again</button></div>'; return; }
    const d = state.data; if (!d) return;
    $('tpSub').textContent = 'Completed sales only, returns and refunds deducted. ' + d.range.from + ' to ' + d.range.to + ', Philippine time.';
    if (!d.rows.length) { setTopSeller(null); body.innerHTML = '<div class="panel rs-empty"><strong>No products sold in this period</strong><p>No completed sales lines between ' + esc(d.range.from) + ' and ' + esc(d.range.to) + (d.channel !== 'all' ? ' for this channel' : '') + '. Try a wider date range.</p></div>'; return; }
    body.classList.toggle('rs-busy', state.loading);
    const rows = state.search ? d.rows.filter((r) => String(r.sku).toLowerCase().includes(state.search) || String(r.name).toLowerCase().includes(state.search)) : d.rows;
    const card = (l, v, s) => '<div class="rs-kpi"><div class="rs-kpi-label">' + l + '</div><div class="rs-kpi-value">' + v + '</div><div class="rs-kpi-sub">' + s + '</div></div>';
    const best = d.rows[0]; setTopSeller(best);
    body.innerHTML = '<div class="rs-kpis two">' + card('Products sold', num(d.totals.products), 'best seller: ' + esc(best.name)) + card('Units sold', num(d.totals.units), 'after returns') + '</div>' +
      table(d, rows);
  }

  function table(d, rows) {
    const hasProfit = d.rows.some((r) => r.estProfit != null);
    const body = rows.map((r) => {
      const tot = r.posUnits + r.onlineUnits, pp = tot ? r.posUnits / tot * 100 : 0;
      return '<tr><td><span class="rs-rank' + (r.rank <= 3 ? ' top' : '') + '">' + r.rank + '</span></td><td class="rs-sku">' + esc(r.sku) + '</td><td>' + esc(r.name) + '</td>' +
        '<td class="rs-num">' + num(r.units) + ' <span class="rs-dim">' + esc(r.unit || '') + '</span></td><td class="rs-num"><strong>' + peso(r.revenue) + '</strong></td><td class="rs-num">' + r.sharePct.toFixed(1) + '%</td><td class="rs-num">' + peso(r.avgPrice) + '</td>' +
        '<td title="POS ' + num(r.posUnits) + ' / Online ' + num(r.onlineUnits) + '"><span class="rs-split"><i class="rs-pos" style="width:' + pp.toFixed(1) + '%"></i><i class="rs-online" style="width:' + (100 - pp).toFixed(1) + '%"></i></span></td>' +
        '<td class="rs-num">' + num(r.transactions) + '</td>' + (hasProfit ? '<td class="rs-num' + (r.estProfit != null && r.estProfit < 0 ? ' rs-loss' : '') + '">' + (r.estProfit == null ? '\u2014' : peso(r.estProfit)) + '</td>' : '') + '</tr>';
    }).join('');
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Ranking</div><div class="panel-sub">' + rows.length + ' of ' + d.rows.length + ' shown' + (d.truncated ? ' (top ' + d.rows.length + ' of ' + num(d.totals.products) + ' products; raise "Show" to see more)' : '') +
      (hasProfit ? ' \u00B7 Est. profit uses the current unit cost and is blank where no cost is recorded' : '') + '</div></div></div><div class="rs-scroll"><table class="rs-table"><thead><tr><th>#</th><th>SKU</th><th>Product</th><th class="rs-num">Units</th><th class="rs-num">Revenue</th><th class="rs-num">Share</th><th class="rs-num">Avg price</th><th>POS / Online</th><th class="rs-num">Sales</th>' + (hasProfit ? '<th class="rs-num">Est. profit</th>' : '') + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="10" class="rs-none">No product matches your search.</td></tr>') + '</tbody></table></div></div>';
  }

  function init() {
    build(); const page = $('reports'); if (!page || !state.built) return;
    const kick = () => { if (page.classList.contains('active-page') && !state.loadedOnce && !state.loading) load(); };
    new MutationObserver(kick).observe(page, { attributes: true, attributeFilter: ['class'] }); kick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();