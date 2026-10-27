/* reports-sales.js — Finance > Reports > "Sales Overview".
   The browser only draws what /api/reports/sales-overview returns; every total is worked out on the server (SQL).
   Dates are Philippine days (Asia/Manila). Needs reports-sales.css and a <div id="repSalesRoot"></div> inside the Reports page. */
(function () {
  'use strict';

  const TZ = 'Asia/Manila';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pesoShort = (n) => { const a = Math.abs(n); return '\u20B1' + (a >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(n / 1e3).toFixed(1) + 'k' : Math.round(n)); };
  const int = (n) => Number(n || 0).toLocaleString('en-PH');
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

  const state = { preset: 'month', from: '', to: '', grain: '', data: null, loading: false, error: '', seq: 0, built: false, loadedOnce: false };
  const CH = { POS: 'rs-pos', Online: 'rs-online' };

  /* ---------- server calls ---------- */
  const qs = () => 'from=' + encodeURIComponent(state.from) + '&to=' + encodeURIComponent(state.to) + (state.grain ? '&grain=' + state.grain : '');
  async function getJson(path) {
    const res = await fetch('/api' + path, { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || (res.status === 403 ? 'Only Finance-Admin can view financial reports.' : 'Could not load the report.'));
    return data;
  }
  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message; document.body.appendChild(el); setTimeout(() => el.remove(), 4500);
  }

  /* ---------- skeleton ---------- */
  function build() {
    const root = $('repSalesRoot'); if (!root || state.built) return;
    state.built = true;
    root.innerHTML =
      '<div class="panel rs-panel">' +
        '<div class="panel-head rs-head">' +
          '<div><div class="panel-title">Sales Overview</div>' +
          '<div class="panel-sub" id="rsSub">Realized sales only: completed POS sales plus fully paid online orders, net of refunds. Philippine time.</div></div>' +
          '<div class="rs-actions"><button type="button" class="btn-secondary" id="rsRefresh">Refresh</button><button type="button" class="btn-primary" id="rsCsv">Export CSV</button></div>' +
        '</div>' +
        '<div class="rs-filters">' +
          '<div class="rs-follow" title="Change the dates in Report Period at the top of this page"><span class="rs-follow-dot"></span>Dates follow <b>Report Period</b>: <span id="rsFollow">…</span></div>' +
          '<label class="rs-date">Group by <select id="rsGrain" class="inv-select"><option value="">Auto</option><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option></select></label>' +
          '<div class="rs-msg" id="rsMsg" role="alert"></div>' +
        '</div>' +
      '</div>' +
      '<div id="rsBody"></div>';

    $('rsGrain').addEventListener('change', (e) => { state.grain = e.target.value; load(); });
    $('rsRefresh').addEventListener('click', load);
    $('rsCsv').addEventListener('click', downloadCsv);
    $('rsBody').addEventListener('mouseover', tipOver); $('rsBody').addEventListener('mouseout', tipOut); $('rsBody').addEventListener('click', (e) => { if (e.target.closest('#rsRetry')) load(); });
    const r = sharedRange() || presetRange(state.preset); state.from = r.from; state.to = r.to; syncControls();
    window.addEventListener('tripleE:reportrange', (e) => applyRange(e.detail));
  }
  /* the dates come from the Report Period panel at the top of the Reports page */
  function sharedRange() { try { const r = window.TripleEReportRange && window.TripleEReportRange.get(); return r && r.from && r.to ? r : null; } catch (e) { return null; } }
  function applyRange(r) {
    if (!r || !r.from || !r.to) return;
    state.from = r.from; state.to = r.to; syncControls();
    const page = $('reports'); if (state.loadedOnce || (page && page.classList.contains('active-page'))) load();
  }

  function checkDates() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(state.from) || !/^\d{4}-\d{2}-\d{2}$/.test(state.to)) return 'Choose both dates.';
    if (state.from > state.to) return 'The start date must not be after the end date.';
    if ((Date.parse(state.to) - Date.parse(state.from)) / 86400000 + 1 > 1100) return 'Choose a range of 1,100 days or less.';
    return '';
  }
  function syncControls() {
    const f = $('rsFollow'); if (f) f.textContent = state.from === state.to ? state.from : state.from + ' to ' + state.to;
    $('rsGrain').value = state.grain;
  }

  /* ---------- load ---------- */
  async function load() {
    const err = checkDates(); $('rsMsg').textContent = err; if (err) return;
    const seq = ++state.seq; state.loading = true; state.error = ''; render();
    try { const d = await getJson('/reports/sales-overview?' + qs()); if (seq !== state.seq) return; state.data = d; }
    catch (e) { if (seq !== state.seq) return; state.error = e.message; state.data = null; }
    state.loading = false; state.loadedOnce = true; render();
  }

  async function downloadCsv() {
    const err = checkDates(); if (err) return toast(err, 'error');
    const btn = $('rsCsv'); btn.disabled = true;
    try {
      const res = await fetch('/api/reports/sales-overview.csv?' + qs(), { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not export.'); }
      const url = URL.createObjectURL(await res.blob()), a = document.createElement('a');
      a.href = url; a.download = 'sales-overview_' + state.from + '_to_' + state.to + '.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
  }

  /* ---------- drawing ---------- */
  function render() {
    const body = $('rsBody'); if (!body) return;
    if (state.loading && !state.data) { body.innerHTML = '<div class="rs-kpis four">' + '<div class="rs-kpi rs-skel"></div>'.repeat(4) + '</div><div class="panel rs-skel rs-skel-chart"></div>'; return; }
    if (state.error) { body.innerHTML = '<div class="panel rs-empty"><strong>Could not load the sales overview</strong><p>' + esc(state.error) + '</p><button type="button" class="btn-secondary" id="rsRetry">Try again</button></div>'; return; }
    const d = state.data; if (!d) return;
    const empty = !d.statuses.length;
    $('rsSub').textContent = 'Realized sales only: completed POS sales plus fully paid online orders, net of refunds. ' + d.range.from + ' to ' + d.range.to + ' (' + d.range.days + ' day' + (d.range.days === 1 ? '' : 's') + '), Philippine time.';
    if (empty) { body.innerHTML = '<div class="panel rs-empty"><strong>No sales in this period</strong><p>No POS sales or online orders were recorded between ' + esc(d.range.from) + ' and ' + esc(d.range.to) + '. Try a wider date range.</p></div>'; return; }
    body.classList.toggle('rs-busy', state.loading);
    body.innerHTML = kpis(d) + '<div class="rs-grid">' + trendPanel(d) + channelPanel(d) + '</div><div class="rs-grid rs-grid-b">' + methodsPanel(d) + outcomePanel(d) + '</div>' + notes(d);
  }

  function delta(k) {
    if (k.netSalesChangePct == null) return '<span class="rs-delta flat">no sales in the previous period</span>';
    const up = k.netSalesChangePct >= 0;
    return '<span class="rs-delta ' + (up ? 'up' : 'down') + '">' + (up ? '\u25B2 ' : '\u25BC ') + Math.abs(k.netSalesChangePct).toLocaleString('en-PH', { maximumFractionDigits: 1 }) + '% vs previous ' + (state.data.range.days === 1 ? 'day' : state.data.range.days + ' days') + '</span>';
  }
  function kpis(d) {
    const k = d.kpis;
    const card = (label, value, sub, cls) => '<div class="rs-kpi ' + (cls || '') + '"><div class="rs-kpi-label">' + label + '</div><div class="rs-kpi-value">' + value + '</div><div class="rs-kpi-sub">' + sub + '</div></div>';
    // One job per card. Gross and refunds are the two halves of net sales, so they sit under Net sales instead of
    // repeating the same peso figure in three boxes; the cancelled rate lives in "Completed vs cancelled" below.
    const net = '<span class="rs-kpi-line">Gross ' + peso(k.grossSales) + ' \u2212 refunds ' + peso(k.refunds) + '</span>' + delta(k);
    return '<div class="rs-kpis four">' +
      card('Net sales', peso(k.netSales), net, 'rs-main') +
      card('Refunds', peso(k.refunds), k.grossSales ? (k.refunds / k.grossSales * 100).toFixed(1) + '% of gross sales' : 'none', k.refunds > 0 ? 'warn' : '') +
      card('Transactions', int(k.transactions), 'completed POS sales and paid online orders') +
      card('Average sale', peso(k.avgSale), 'net per transaction') +
      '</div>';
  }

  function niceMax(v) { if (v <= 0) return 100; const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
  function trendPanel(d) {
    const b = d.trend, W = 900, H = 300, L = 62, R = 10, T = 14, B = 34, iw = W - L - R, ih = H - T - B;
    const max = niceMax(Math.max.apply(null, b.map((x) => Math.max(0, x.pos) + Math.max(0, x.online)).concat([0])));
    const step = iw / b.length, bw = Math.max(2, Math.min(46, step * 0.66));
    const y = (v) => T + ih - (v / max) * ih;
    let g = '';
    for (let i = 0; i <= 4; i++) { const v = max / 4 * i, yy = y(v); g += '<line class="rs-grid-l" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/><text class="rs-ax" x="' + (L - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + pesoShort(v) + '</text>'; }
    const every = Math.ceil(b.length / 12);
    b.forEach((x, i) => {
      const cx = L + step * i + step / 2, p = Math.max(0, x.pos), o = Math.max(0, x.online);
      const tip = esc(x.label) + '|POS ' + peso(x.pos) + '|Online ' + peso(x.online) + '|Net ' + peso(x.net) + '|' + int(x.count) + ' transaction' + (x.count === 1 ? '' : 's');
      g += '<g class="rs-bar" data-tip="' + tip + '"><rect class="rs-hit" x="' + (cx - step / 2) + '" y="' + T + '" width="' + step + '" height="' + ih + '"/>' +
        (p ? '<rect class="rs-pos" x="' + (cx - bw / 2) + '" y="' + y(p) + '" width="' + bw + '" height="' + (y(0) - y(p)) + '" rx="2"/>' : '') +
        (o ? '<rect class="rs-online" x="' + (cx - bw / 2) + '" y="' + y(p + o) + '" width="' + bw + '" height="' + (y(p) - y(p + o)) + '" rx="2"/>' : '') + '</g>';
      if (i % every === 0) g += '<text class="rs-ax" x="' + cx + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(x.label) + '</text>';
    });
    const grainName = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[d.range.grain] || '';
    return '<div class="panel rs-card rs-wide"><div class="panel-head"><div><div class="panel-title">Sales trend</div><div class="panel-sub">Net sales per ' + esc(d.range.grain) + ', ' + grainName + ' view</div></div>' +
      '<div class="rs-legend"><span><i class="rs-pos"></i>POS</span><span><i class="rs-online"></i>Online</span></div></div>' +
      '<div class="rs-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Net sales trend, POS and online">' + g + '</svg><div class="rs-tip" id="rsTip" hidden></div></div></div>';
  }

  function channelPanel(d) {
    const pos = d.channels[0], on = d.channels[1], tot = d.kpis.netSales || 0;
    const share = (c) => (tot > 0 ? Math.max(0, c.net) / tot * 100 : 0);
    const row = (c, cls) => '<div class="rs-ch"><div class="rs-ch-top"><span><i class="' + cls + '"></i>' + c.channel + (c.channel === 'POS' ? ' (counter)' : ' (shop)') + '</span><strong>' + peso(c.net) + '</strong></div>' +
      '<div class="rs-track"><div class="' + cls + '" style="width:' + share(c).toFixed(1) + '%"></div></div>' +
      '<div class="rs-ch-sub">' + share(c).toFixed(1) + '% of net \u00B7 ' + int(c.count) + ' sale' + (c.count === 1 ? '' : 's') + ' \u00B7 gross ' + peso(c.gross) + (c.refunds ? ' \u00B7 refunds ' + peso(c.refunds) : '') + '</div></div>';
    const vp = pos.voidPending ? '<div class="rs-note warn">' + int(pos.voidPending) + ' POS sale' + (pos.voidPending === 1 ? ' is' : 's are') + ' waiting for a void decision. They still count until the void is approved.</div>' : '';
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">POS vs online</div><div class="panel-sub">Share of net sales by channel</div></div></div>' + row(pos, 'rs-pos') + row(on, 'rs-online') + vp + '</div>';
  }

  function methodsPanel(d) {
    const tot = d.kpis.netSales || 0;
    const rows = d.methods.map((m) => '<tr><td>' + esc(m.method) + '</td><td><span class="rs-tag ' + CH[m.channel] + '">' + esc(m.channel) + '</span></td><td class="rs-num">' + int(m.count) + '</td><td class="rs-num">' + peso(m.gross) + '</td><td class="rs-num">' + (m.refunds ? peso(m.refunds) : '\u2014') + '</td><td class="rs-num"><strong>' + peso(m.net) + '</strong></td><td class="rs-num">' + (tot > 0 ? (m.net / tot * 100).toFixed(1) + '%' : '\u2014') + '</td></tr>').join('');
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Payment methods</div><div class="panel-sub">Realized sales by how the customer paid</div></div></div><div class="rs-scroll"><table class="rs-table"><thead><tr><th>Method</th><th>Channel</th><th class="rs-num">Sales</th><th class="rs-num">Gross</th><th class="rs-num">Refunds</th><th class="rs-num">Net</th><th class="rs-num">Share</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="7" class="rs-none">No realized sales in this period.</td></tr>') + '</tbody></table></div></div>';
  }

  function outcomePanel(d) {
    const o = d.outcome, all = o.completed.count + o.cancelled.count + o.pending.count;
    const seg = (n, cls) => (all ? '<div class="' + cls + '" style="width:' + (n / all * 100).toFixed(2) + '%"></div>' : '');
    const tone = { Completed: 'ok', Paid: 'ok', Voided: 'bad', Cancelled: 'bad', 'Partly paid': 'warn', Unpaid: 'warn' };
    const rows = d.statuses.map((s) => '<tr><td><span class="rs-dot ' + (tone[s.label] || '') + '"></span>' + esc(s.label) + '</td><td><span class="rs-tag ' + CH[s.channel] + '">' + esc(s.channel) + '</span></td><td class="rs-num">' + int(s.count) + '</td><td class="rs-num">' + peso(s.amount) + '</td></tr>').join('');
    return '<div class="panel rs-card"><div class="panel-head"><div><div class="panel-title">Completed vs cancelled</div><div class="panel-sub">Only completed sales are counted as revenue \u00B7 cancelled / voided rate <strong>' + o.cancellationRate.toLocaleString('en-PH', { maximumFractionDigits: 1 }) + '%</strong> (' + int(o.cancelled.count) + ' of ' + int(o.completed.count + o.cancelled.count) + ' decided)</div></div></div>' +
      '<div class="rs-stack">' + seg(o.completed.count, 'ok') + seg(o.pending.count, 'warn') + seg(o.cancelled.count, 'bad') + '</div>' +
      '<div class="rs-outcome"><span><i class="rs-dot ok"></i>Completed <strong>' + int(o.completed.count) + '</strong></span><span><i class="rs-dot warn"></i>Awaiting payment <strong>' + int(o.pending.count) + '</strong></span><span><i class="rs-dot bad"></i>Cancelled / voided <strong>' + int(o.cancelled.count) + '</strong></span></div>' +
      '<div class="rs-scroll"><table class="rs-table"><thead><tr><th>Status</th><th>Channel</th><th class="rs-num">Count</th><th class="rs-num">Order value</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function notes(d) {
    let h = '';
    if (d.customQuotes && d.customQuotes.received > 0) h += '<div class="rs-note">Custom-quote down payments of <strong>' + peso(d.customQuotes.received) + '</strong> (' + int(d.customQuotes.quotes) + ' quotation' + (d.customQuotes.quotes === 1 ? '' : 's') + ' not yet converted) were received in this period. They are not in net sales; once a quotation becomes an order or POS invoice, its money is counted there, once.</div>';
    if (d.keptAdvances && d.keptAdvances.amount > 0) h += '<div class="rs-note">Kept from cash orders the customer did not receive or pick up: <strong>' + peso(d.keptAdvances.amount) + '</strong> (' + int(d.keptAdvances.orders) + ' order' + (d.keptAdvances.orders === 1 ? '' : 's') + ', delivery fees and down payments paid online). These orders are cancelled, so this money is not in the sales totals above.</div>';
    h += '<div class="rs-note faint">Refunds are deducted from the day of the original sale, so each period stays consistent with the product ranking. Delivery fees of ' + peso(d.kpis.deliveryFees) + ' are included in net sales.</div>';
    return '<div class="rs-notes">' + h + '</div>';
  }

  /* ---------- chart tooltip ---------- */
  function tipOver(e) {
    const g = e.target.closest('.rs-bar'); if (!g) return;
    const tip = $('rsTip'), box = tip.parentNode.getBoundingClientRect(), r = g.getBoundingClientRect(), p = g.dataset.tip.split('|');
    tip.innerHTML = '<strong>' + p[0] + '</strong>' + p.slice(1).map((x) => '<div>' + x + '</div>').join('');
    tip.hidden = false;
    const x = r.left - box.left + r.width / 2, w = tip.offsetWidth;
    tip.style.left = Math.max(4, Math.min(box.width - w - 4, x - w / 2)) + 'px'; tip.style.top = '4px';
  }
  function tipOut(e) { if (e.target.closest('.rs-bar')) { const t = $('rsTip'); if (t) t.hidden = true; } }

  /* ---------- start: build now, load the first time the Reports page is opened ---------- */
  function init() {
    build(); const page = $('reports'); if (!page || !state.built) return;
    const active = () => page.classList.contains('active-page');
    const kick = () => { if (active() && !state.loadedOnce && !state.loading) load(); };
    new MutationObserver(kick).observe(page, { attributes: true, attributeFilter: ['class'] }); kick();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();