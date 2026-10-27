/* cash-shift-reports.js — Finance "Sales Transactions" → Payment summary + Cash shifts (monitoring).
   Loaded after sales-orders.js. sales-orders.js calls CashReports.show(), which fills both the Payment Summary and Cash Shifts tables. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const payLabel = (m) => (m === 'Xendit' ? 'Online payment' : m);   // Xendit is only the gateway behind it; the stored value stays 'Xendit'
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (t) => t ? new Date(t).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const dur = (a, b) => { const m = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 60000)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  let from = iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to = iso(new Date()), data = null, busy = 0;   // defaults to this month

  const css = document.createElement('style');
  css.textContent = `
  .cr-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 16px}
  .cr-bar label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.8px}
  .cr-bar input[type=date]{width:auto;padding:7px 10px;font-size:14px}
  .cr-quick{display:flex;gap:6px;flex-wrap:wrap}
  .cr-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:0 0 18px}
  .cr-stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--card)}
  .cr-stat .l{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:var(--text-faint)}
  .cr-stat .v{font-family:Oswald,sans-serif;font-size:24px;font-weight:600;margin-top:4px}
  .cr-stat .f{font-size:12.5px;color:var(--text-dim);margin-top:2px}
  .cr-stat.bad .v{color:#e35b5b}.cr-stat.good .v{color:var(--green)}.cr-stat.warn .v{color:var(--amber)}
  .cr-h{font-size:15px;font-weight:600;margin:20px 0 8px}
  .cr-note{font-size:13px;color:var(--text-dim);margin:8px 0}
  .cr-tag{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid var(--border);margin:1px 3px 1px 0}
  .cr-tag.bad{color:#e35b5b;border-color:rgba(227,91,91,.5)}.cr-tag.warn{color:var(--amber);border-color:rgba(217,164,65,.5)}.cr-tag.good{color:var(--green);border-color:rgba(67,196,122,.5)}
  .cr-var.bad{color:#e35b5b;font-weight:600}.cr-var.good{color:var(--green);font-weight:600}
  .cr-rule{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px;padding:10px 14px;border:1px solid var(--border);border-radius:10px;background:var(--card);font-size:14px}
  .cr-rule input{width:110px;padding:6px 10px;font-size:14px}
  .cr-rule .m{font-size:13px;color:var(--text-dim)}
  tr.cr-row{cursor:pointer}tr.cr-row:hover{background:var(--hover)}
  tr.cr-detail td{background:var(--inset);padding:12px 16px}
  .cr-mv{display:grid;grid-template-columns:auto auto 1fr;gap:4px 14px;font-size:13.5px}
  .cr-empty{padding:28px;text-align:center;color:var(--text-faint)}
  .cr-r{text-align:right}
  `;
  document.head.appendChild(css);

  async function api(path) {
    const r = await fetch('/api' + path, { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  function bar(withCsv) {
    return '<div class="cr-bar"><label>From<input type="date" data-crdate="from" value="' + esc(from) + '"></label>' +
      '<label>To<input type="date" data-crdate="to" value="' + esc(to) + '"></label>' +
      '<div class="cr-quick"><button type="button" class="btn-secondary btn-sm" data-cr="today">Today</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-cr="yesterday">Yesterday</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-cr="7">Last 7 days</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-cr="month">This month</button>' +
      (withCsv ? '<button type="button" class="btn-secondary btn-sm" data-cr="csv">Download CSV</button>' : '') + '</div></div>';
  }
  const stat = (l, v, f, cls) => '<div class="cr-stat ' + (cls || '') + '"><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div>' + (f ? '<div class="f">' + esc(f) + '</div>' : '') + '</div>';

  function paymentsHtml() {
    const pos = data.payments.pos, on = data.payments.online;
    const posRet = pos.reduce((n, x) => n + (x.returned || 0), 0);   // approved partial returns, taken off the sale totals
    const posTotal = pos.reduce((n, x) => n + x.total - (x.returned || 0), 0), posCash = (() => { const c = pos.find(x => x.method === 'Cash'); return c ? c.total - (c.returned || 0) : 0; })(), posCard = pos.filter(x => x.method === 'Card' || x.method === 'Xendit').reduce((n, x) => n + x.total - (x.returned || 0), 0);
    const onCollected = on.reduce((n, x) => n + x.collected, 0), awaiting = on.reduce((n, x) => n + x.awaiting, 0), refunded = on.reduce((n, x) => n + x.refunded, 0);
    const net = posTotal + onCollected - refunded;
    let h = '<div class="cr-stats">' +
      stat('Net collected', peso(net), 'POS + online − refunds & returns', 'good') +
      stat('POS cash', peso(posCash), 'goes to cashier drawers') +
      stat('POS card & online', peso(posCard), 'card / online payment, not in drawer') +
      stat('Online collected', peso(onCollected), 'paid / confirmed orders') +
      stat('Awaiting confirmation', peso(awaiting), 'not counted as collected yet', awaiting ? 'warn' : '') +
      stat('Refunds approved', peso(refunded), 'online orders', refunded ? 'bad' : '') +
      stat('POS returns approved', peso(posRet), 'items brought back at the counter', posRet ? 'bad' : '') + '</div>';
    h += '<div class="cr-h">POS walk-in sales by payment method</div><div class="table-wrapper"><table><thead><tr><th>Method</th><th class="cr-r">Sales</th><th class="cr-r">Total</th><th class="cr-r">Returned</th><th class="cr-r">Voided</th></tr></thead><tbody>' +
      (pos.length ? pos.map(x => '<tr><td>' + esc(payLabel(x.method)) + '</td><td class="cr-r">' + x.count + '</td><td class="cr-r">' + peso(x.total - (x.returned || 0)) + (x.returned ? '<div class="faint" style="font-size:12px">of ' + peso(x.total) + ' sold</div>' : '') + '</td><td class="cr-r">' + (x.returned ? '−' + peso(x.returned) : '—') + '</td><td class="cr-r">' + (x.voided ? x.voided + ' · ' + peso(x.voidedTotal) : '—') + '</td></tr>').join('') +
        '<tr><td><b>Total</b></td><td class="cr-r"><b>' + pos.reduce((n, x) => n + x.count, 0) + '</b></td><td class="cr-r"><b>' + peso(posTotal) + '</b></td><td class="cr-r"><b>' + (posRet ? '−' + peso(posRet) : '') + '</b></td><td></td></tr>'
        : '<tr><td colspan="5" class="cr-empty">No POS sales in this period.</td></tr>') + '</tbody></table></div>';
    h += '<div class="cr-h">Online orders by payment method</div><div class="table-wrapper"><table><thead><tr><th>Method</th><th class="cr-r">Paid orders</th><th class="cr-r">Collected</th><th class="cr-r">Awaiting</th><th class="cr-r">Refunded</th><th class="cr-r">Cancelled</th></tr></thead><tbody>' +
      (on.length ? on.map(x => '<tr><td>' + esc(payLabel(x.method)) + (/^Cash on/.test(x.method) ? '<div class="faint" style="font-size:12px">collected on delivery/pickup, not in a POS drawer</div>' : '') + '</td><td class="cr-r">' + x.count + '</td><td class="cr-r">' + peso(x.collected) + '</td><td class="cr-r">' + (x.awaitingCount ? x.awaitingCount + ' · ' + peso(x.awaiting) : '—') + '</td><td class="cr-r">' + (x.refunded ? peso(x.refunded) : '—') + '</td><td class="cr-r">' + (x.cancelled || '—') + '</td></tr>').join('')
        : '<tr><td colspan="6" class="cr-empty">No online orders in this period.</td></tr>') + '</tbody></table></div>';
    h += '<p class="cr-note">Online orders are grouped by the date the order was placed. An order counts as collected once Finance confirms payment (or Xendit confirms it).</p>';
    return h;
  }

  function varCell(s) {
    if (s.difference == null) return '<span class="faint">—</span>';
    if (Math.abs(s.difference) < 0.005) return '<span class="cr-var good">Balanced</span>';
    return '<span class="cr-var bad">' + (s.difference < 0 ? 'Short ' : 'Over ') + peso(Math.abs(s.difference)) + '</span>';
  }

  function shiftsHtml() {
    const t = data.totals, net = t.shortage + t.overage;
    let h = '<div class="cr-stats">' +
      stat('Shifts', t.shifts, t.open + ' still open') +
      stat('Expected cash', peso(t.expectedCash), 'opening + sales + added − removed − refunds') +
      stat('Counted cash', peso(t.countedCash), 'closed shifts only') +
      stat('Net variance', (net < 0 ? '−' : net > 0 ? '+' : '') + peso(Math.abs(net)), 'short ' + peso(Math.abs(t.shortage)) + ' · over ' + peso(t.overage), Math.abs(net) < 0.005 ? 'good' : 'bad') +
      stat('Needs review', t.needsReview, 'variance ≥ ' + peso(data.varianceAlert) + ', open too long, void or return pending', t.needsReview ? 'warn' : 'good') + '</div>';
    h += '<div class="cr-rule"><label for="crLimit"><b>Closing reason required when the drawer is more than</b></label>₱<input id="crLimit" inputmode="decimal" autocomplete="off" value="' + esc(Number(data.reasonThreshold).toFixed(2)) + '"><button type="button" class="btn-secondary btn-sm" data-crrule>Save</button><span class="m" id="crRuleMsg">Short or over by less than this, the cashier may close without a note. Changes are written to the audit log.</span></div>';
    h += '<div class="table-wrapper"><table><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Open for</th><th class="cr-r">Opening</th><th class="cr-r">Cash sales</th><th class="cr-r">In / Out</th><th class="cr-r">Refunds</th><th class="cr-r">Expected</th><th class="cr-r">Counted</th><th>Result</th><th>Flags</th></tr></thead><tbody>';
    if (!data.shifts.length) h += '<tr><td colspan="12" class="cr-empty">No cash shifts in this period.</td></tr>';
    data.shifts.forEach((s) => {
      h += '<tr class="cr-row" data-crrow="' + esc(s.id) + '"><td>' + esc(s.cashierName) + '</td><td>' + esc(when(s.openedAt)) + '</td><td>' + (s.closedAt ? esc(when(s.closedAt)) : '<span class="cr-tag good">Open</span>') + '</td><td>' + dur(s.openedAt, s.closedAt) + '</td><td class="cr-r">' + peso(s.openingCash) + '</td><td class="cr-r">' + peso(s.cashSales) + '<div class="faint" style="font-size:12px">' + s.cashTransactions + ' sale(s)</div></td><td class="cr-r">+' + peso(s.cashIn) + '<div class="faint" style="font-size:12px">−' + peso(s.cashOut) + '</div></td><td class="cr-r">' + (s.cashReturns ? '−' + peso(s.cashReturns) + '<div class="faint" style="font-size:12px">' + s.cashReturnTransactions + ' return(s)</div>' : '<span class="faint">—</span>') + '</td><td class="cr-r">' + peso(s.expectedCash) + '</td><td class="cr-r">' + (s.closingCash == null ? '—' : peso(s.closingCash)) + '</td><td>' + varCell(s) + '</td><td>' + (s.flags.map(f => '<span class="cr-tag warn">' + esc(f) + '</span>').join('') || '<span class="faint">—</span>') + '</td></tr>';
      const mv = s.movements.length ? '<div class="cr-mv">' + s.movements.map(m => '<span class="faint">' + esc(when(m.createdAt)) + '</span><b>' + (m.kind === 'cash_in' ? '+' : '−') + peso(m.amount) + '</b><span>' + esc(m.reason) + '</span>').join('') + '</div>' : '<span class="faint">No cash added or removed.</span>';
      h += '<tr class="cr-detail" id="crd-' + esc(s.id) + '" hidden><td colspan="12"><b>Shift #' + esc(s.id) + '</b> · card sales (not in drawer): ' + peso(s.cardSales) + ' (' + s.cardTransactions + ')' +
        (s.closingNote ? '<div style="margin:8px 0"><b>Cashier note:</b> ' + esc(s.closingNote) + '</div>' : '') +
        (s.closingBreakdown ? '<div class="cr-note">Counted: ' + Object.entries(s.closingBreakdown).sort((a, b) => b[0] - a[0]).map(([k, v]) => v + ' × ₱' + k).join(' · ') + '</div>' : '') +
        '<div style="margin-top:8px"><b>Cash added / removed</b></div>' + mv + '</td></tr>';
    });
    return h + '</tbody></table></div><p class="cr-note">Click a row to see the cashier note, the notes/coins counted and cash movements. Expected cash = opening cash + cash sales + cash added − cash removed − cash refunds for returned items.</p>';
  }

  function csv() {
    const rows = [['Shift', 'Cashier', 'Opened', 'Closed', 'Opening', 'Cash sales', 'Cash added', 'Cash removed', 'Cash refunds', 'Expected', 'Counted', 'Difference', 'Note']];
    data.shifts.forEach(s => rows.push([s.id, s.cashierName, s.openedAt, s.closedAt || '', s.openingCash, s.cashSales, s.cashIn, s.cashOut, s.cashReturns || 0, s.expectedCash, s.closingCash == null ? '' : s.closingCash, s.difference == null ? '' : s.difference, s.closingNote]));
    const text = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = 'cash-shifts-' + data.from + '_to_' + data.to + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function show() {
    const payBox = $('soPay'), shBox = $('soShifts'); if (!payBox || !shBox) return;
    const my = ++busy;
    $('soPaySub').textContent = 'Loading…'; $('soShiftSub').textContent = 'Loading…';
    try {
      const d = await api('/finance/cash-shifts/report?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
      if (my !== busy) return;
      data = d; from = d.from; to = d.to;
      const range = d.from === d.to ? d.from : d.from + ' to ' + d.to;
      $('soPaySub').textContent = range;
      $('soShiftSub').textContent = range + ' · ' + d.totals.shifts + ' shift(s)';
      payBox.innerHTML = bar(false) + paymentsHtml();
      shBox.innerHTML = bar(true) + shiftsHtml();
    } catch (e) {
      if (my !== busy) return;
      $('soPaySub').textContent = e.message; $('soShiftSub').textContent = e.message;
      const err = bar(false) + '<div class="cr-empty">' + esc(e.message) + '</div>';
      payBox.innerHTML = err; shBox.innerHTML = err;
    }
  }

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-crrule]')) {
      const box = $('crLimit'), msg = $('crRuleMsg'), v = Number(String(box.value).replace(/,/g, '').trim());
      if (!/^\d{1,5}(\.\d{1,2})?$/.test(String(box.value).replace(/,/g, '').trim()) || v > 10000) { msg.textContent = 'Enter an amount from 0 to 10,000 pesos (up to 2 decimals).'; return; }
      try {
        const r = await fetch('/api/finance/cash-shifts/rules', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reasonThreshold: v }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Could not save');
        data.reasonThreshold = d.reasonThreshold; box.value = d.reasonThreshold.toFixed(2); msg.textContent = 'Saved. Cashiers now need a reason above ' + peso(d.reasonThreshold) + '.';
      } catch (err) { msg.textContent = err.message; }
      return;
    }
    const q = e.target.closest('[data-cr]');
    if (q) {
      const k = q.dataset.cr, now = new Date();
      if (k === 'csv') return data && csv();
      if (k === 'today') from = to = iso(now);
      else if (k === 'yesterday') { const y = new Date(now); y.setDate(y.getDate() - 1); from = to = iso(y); }
      else if (k === '7') { const y = new Date(now); y.setDate(y.getDate() - 6); from = iso(y); to = iso(now); }
      else if (k === 'month') { from = iso(new Date(now.getFullYear(), now.getMonth(), 1)); to = iso(now); }
      return show();
    }
    const row = e.target.closest('[data-crrow]');
    if (row) { const d = $('crd-' + row.dataset.crrow); if (d) d.hidden = !d.hidden; }
  });
  document.addEventListener('change', (e) => {
    const k = e.target.dataset && e.target.dataset.crdate; if (!k) return;
    const b = e.target.closest('.cr-bar');
    from = b.querySelector('[data-crdate="from"]').value; to = b.querySelector('[data-crdate="to"]').value;
    if (from && to) show();
  });
  document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'soPayRefreshBtn' || e.target.closest('#soPayRefreshBtn') || e.target.id === 'saOverviewRefresh' || e.target.closest('#saOverviewRefresh'))) {
      show();
    }
  });

  function watchSalesPages() {
    ['sales-overview', 'sales'].forEach((id) => {
      const sec = $(id);
      if (sec) {
        new MutationObserver(() => {
          if (sec.classList.contains('active-page')) show();
        }).observe(sec, { attributes: true, attributeFilter: ['class'] });
        if (sec.classList.contains('active-page')) show();
      }
    });
    window.addEventListener('focus', () => {
      if (['sales-overview', 'sales'].some((id) => $(id) && $(id).classList.contains('active-page'))) show();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSalesPages);
  else watchSalesPages();

  window.CashReports = { show };
})();