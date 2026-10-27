/* cash-shift-ui.js — POS "Cash Shift" page: open a drawer, record cash added/removed, count notes & coins and close.
   Exposes window.refreshCashShift() (called by the POS after every sale). */
(() => {
 'use strict';
 const $ = id => document.getElementById(id);
 const fmt = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
 const esc = s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
 const when = t => t ? new Date(t).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
 const timeOnly = t => new Date(t).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
 const dur = (a, b) => { const m = Math.max(0, Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 60000)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
 const say = (m, err) => (window.toast ? window.toast(m, err) : console.log(m));
 const MAX = 10000000, AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
 const cents = x => Math.round(Number(x) * 100);
 // notes & coins; value in centavos so the total never has floating point errors
 const DENOMS = [['1000', 100000], ['500', 50000], ['200', 20000], ['100', 10000], ['50', 5000], ['20', 2000], ['10', 1000], ['5', 500], ['1', 100], ['0.25', 25], ['0.05', 5]];
 let current = null, ticker = null;
 // the gate: nothing else on the POS works until a shift is open. THRESHOLD = difference above which closing needs a reason (set by Finance).
 let gated = true, THRESHOLD = 20, SUGGEST = null, paintedKey = '', pollN = 0, pendingPage = null;
 // store hours from the server (8:00 AM - 5:00 PM). nowMinutes is moved forward on this screen between refreshes.
 let HOURS = null, hoursAt = 0, lastForceAsk = 0;
 const nowMin = () => HOURS ? HOURS.nowMinutes + Math.floor((Date.now() - hoursAt) / 60000) : null;
 const left = () => HOURS ? HOURS.closeMinutes - nowMin() : null;
 const hm = (m) => { m = Math.max(0, Math.round(m)); return (m >= 60 ? Math.floor(m / 60) + 'h ' : '') + (m % 60) + 'm'; };
 const canOpenNow = () => !HOURS || HOURS.canOpenShift !== false || (nowMin() >= HOURS.openMinutes - HOURS.earlyMinutes && nowMin() < HOURS.closeMinutes);
 async function loadHours() { try { HOURS = await request('/api/pos/business-hours'); hoursAt = Date.now(); } catch (e) { /* keep the last one */ } }
 function hoursLine() {
  if (!HOURS) return '';
  return 'Store hours ' + HOURS.open + ' \u2013 ' + HOURS.close + '. ' + (canOpenNow() ? '' : nowMin() < HOURS.openMinutes ? 'You can open your shift from ' + HOURS.firstOpen + '.' : 'The store is closed for today.');
 }

 async function request(url, options = {}) {
  const r = await fetch(url, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.fields = d.fields || {}; throw e; }
  return d;
 }
 // returns {ok, value, error}
 function parseAmount(text, { allowZero = true } = {}) {
  const t = window.MoneyInput ? MoneyInput.raw(text) : String(text ?? '').trim();      // the box shows commas: 1,500.00
  if (!t) return { ok: false, error: 'Enter an amount.' };
  if (!AMOUNT_RE.test(t)) return { ok: false, error: 'Use numbers only, with at most 2 decimals (e.g. 1500.50).' };
  const v = Number(t);
  if (v > MAX) return { ok: false, error: 'That amount is too large.' };
  if (!allowZero && v <= 0) return { ok: false, error: 'Amount must be more than 0.' };
  return { ok: true, value: v };
 }
 const fieldErr = (id, msg) => { const i = $(id), e = $(id + 'Err'); if (i) { i.classList.toggle('is-bad', !!msg); i.setAttribute('aria-invalid', String(!!msg)); if (e) i.setAttribute('aria-describedby', e.id); } if (e) { e.textContent = msg || ''; e.setAttribute('aria-live', 'polite'); } };

 // Empty boxes mean zero; typed counts must match the server's integer-count contract.
 function readCashCount(inputs) {
  const counts = {}; let touched = false, total = 0, valid = true;
  for (const input of inputs) {
   const raw = input.value.trim(), n = Number(raw);
   const denomination = DENOMS.find(([key]) => key === input.dataset.den);
   const ok = !input.validity?.badInput && (!raw || (/^\d+$/.test(raw) && Number.isInteger(n) && n <= 100000)) && !!denomination;
   input.classList.toggle('is-bad', !ok); input.setAttribute('aria-invalid', String(!ok));
   if (raw || input.validity?.badInput) touched = true;
   if (!ok) { valid = false; continue; }
   if (n > 0) counts[input.dataset.den] = n;
   total += n * denomination[1];
  }
  if (!valid) return { ok: false, counts, error: 'Use whole counts from 0 to 100,000 for each note or coin.' };
  if (total > MAX * 100) return { ok: false, counts, error: 'The counted cash cannot exceed ' + fmt(MAX) + '.' };
  return { ok: touched, value: total / 100, counts, error: touched ? '' : 'Enter the notes and coins you counted, including 0 for an empty drawer.' };
 }

 /* ---------- dialog helper ---------- */
 function dialog(html, { locked = false } = {}) {          // locked = no Escape, no click-outside, no Cancel: the only way out is finishing it
  const m = document.createElement('div');
  m.className = 'cs-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
  if (locked) m.dataset.locked = '1';
  m.innerHTML = '<div class="cs-dialog">' + html + '</div>';
  document.body.appendChild(m);
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !m.dataset.locked) close(); };
  document.addEventListener('keydown', onKey);
  m.addEventListener('mousedown', e => { if (e.target === m && !m.dataset.locked) close(); });
  return { el: m, close, q: s => m.querySelector(s) };
 }
 const confirmBox = (title, body, yes) => new Promise(res => {
  const d = dialog('<h3>' + esc(title) + '</h3><p class="lead">' + body + '</p><div class="cs-actions"><button class="btn-secondary" data-n>Cancel</button><button class="btn-primary" data-y>' + esc(yes) + '</button></div>');
  d.q('[data-n]').onclick = () => { d.close(); res(false); }; d.q('[data-y]').onclick = () => { d.close(); res(true); }; d.q('[data-y]').focus();
 });

 /* ---------- main render ---------- */
 function badge() {
  const b = $('navShiftBadge'); if (!b) return;
  b.hidden = false; b.className = 'count ' + (current ? 'on' : 'off'); b.textContent = current ? 'OPEN' : 'CLOSED';
  const bn = $('shiftBanner'); if (bn) bn.hidden = !!current;
  side();
 }
 /* the shift card in the sidebar (and so in the burger menu on a phone): state + time left until closing */
 function side() {
  const bar = $('sidebar'); if (!bar) return;
  let box = $('shiftSide');
  if (!box) { box = document.createElement('button'); box.type = 'button'; box.id = 'shiftSide'; box.className = 'cs-side'; const foot = bar.querySelector('.sidebar-foot'); bar.insertBefore(box, foot || null);
   box.addEventListener('click', () => { if (window.showPage) window.showPage('shift'); const bd = $('sidebarBackdrop'); if (bd && bar.classList.contains('open')) bd.click(); }); }
  const l = left();
  if (!current) {
   box.className = 'cs-side off';
   box.innerHTML = '<span class="cs-side-t">No cash shift open</span><span class="cs-side-s">' + (canOpenNow() ? 'Tap to open your shift and start selling' : esc(hoursLine())) + '</span>';
   return;
  }
  const late = l != null && l < 0, soon = l != null && l >= 0 && HOURS && l <= HOURS.remindMinutes;
  const span = HOURS ? Math.max(1, HOURS.closeMinutes - HOURS.openMinutes) : 1, done = HOURS ? Math.min(100, Math.max(0, ((nowMin() - HOURS.openMinutes) / span) * 100)) : 0;
  box.className = 'cs-side on' + (late ? ' late' : soon ? ' soon' : '');
  box.innerHTML = '<span class="cs-side-t">Shift #' + esc(current.id) + ' open \u00B7 ' + dur(current.openedAt) + '</span>' +
   '<span class="cs-side-s">' + (l == null ? '' : late ? 'Past closing (' + esc(HOURS.close) + ') by ' + hm(-l) + ': count &amp; close now' : hm(l) + ' left \u00B7 closes ' + esc(HOURS.close)) + '</span>' +
   (HOURS ? '<span class="cs-side-bar"><i style="width:' + done.toFixed(1) + '%"></i></span>' : '');
 }
  function render() {
  const app = $('csApp'); if (!app) return;
  badge();
  if (!current) {
   app.innerHTML = `<div class="cs-hero closed"><div><div class="cs-state"><span class="cs-dot"></span>No open shift</div><div class="cs-meta">Count the cash in your drawer, then enter it below to start selling.${HOURS ? ' ' + esc(hoursLine()) : ''}</div></div></div>`
    + (canOpenNow() ? '' : `<div class="cs-warn"><b>${esc(hoursLine())}</b></div>`) + `
   <div class="cs-grid cs-startgrid"><div class="panel cs-card cs-start"><h3>Start your shift</h3><p>Enter the starting cash (change fund) you put in the drawer.</p>
    <div class="cs-field"><label for="csOpening">Starting cash</label><div class="cs-money"><span>₱</span><input id="csOpening" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csOpeningErr"></div>
     <div class="cs-chips" title="Each tap adds that amount">${[100, 500, 1000, 2000, 5000].map(v => '<button type="button" class="cs-chip" data-fill="' + v + '">+' + fmt(v).replace('.00', '') + '</button>').join('')}<button type="button" class="cs-chip" data-fill="clear">Clear</button></div></div>
    <button class="btn-primary cs-btn" id="csOpenBtn"${canOpenNow() ? '' : ' disabled'}>Open cash shift</button></div>
    <div class="panel cs-card cs-tips"><h3>Before you open</h3><p>A quick check keeps your end-of-shift count accurate.</p>
     <ol class="cs-steps"><li><b>Count the drawer</b><span>Count every bill and coin currently in the cash drawer.</span></li><li><b>Enter the change fund</b><span>Type the total, or tap the amounts: each tap adds up (e.g. +₱1,000 twice = ₱2,000).</span></li><li><b>Start selling</b><span>Cash sales are tracked automatically and compared to your count when you close.</span></li></ol></div></div>`;
   return;
  }
  const c = current, mv = c.movements || [];
  app.innerHTML = `<div class="cs-hero open"><div><div class="cs-state"><span class="cs-dot"></span>Shift #${esc(c.id)} is open</div>
    <div class="cs-meta">${esc(c.cashierName)} · opened ${esc(timeOnly(c.openedAt))} · open for <b id="csElapsed">${dur(c.openedAt)}</b>${HOURS ? ' · store closes ' + esc(HOURS.close) + ' (<b id="csLeft">' + (left() < 0 ? 'past closing' : hm(left()) + ' left') + '</b>)' : ''}</div></div>
    <button class="btn-primary" id="csCloseBtn">Count &amp; close shift</button></div>
   ${HOURS && left() < 0 ? '<div class="cs-warn"><b>It is past closing time (' + esc(HOURS.close) + ').</b> Count your drawer and close this shift now. Finance is told when a shift stays open.</div>' : HOURS && left() <= HOURS.remindMinutes ? '<div class="cs-warn"><b>Closing soon:</b> the store closes at ' + esc(HOURS.close) + '. Finish your last sales, then count and close your shift.</div>' : ''}
   ${c.pendingVoids ? '<div class="cs-warn"><b>' + c.pendingVoids + ' void request(s) waiting for Finance.</b> Your expected cash may change once they are decided.</div>' : ''}
   ${c.pendingReturns ? '<div class="cs-warn"><b>' + c.pendingReturns + ' return(s) waiting for Finance.</b> Once approved, the cash refund is taken off the cash that should be in your drawer.</div>' : ''}
   <div class="cs-expected"><div class="lab">Cash that should be in your drawer</div><div class="big">${fmt(c.expectedCash)}</div>
    <div class="cs-eq"><span class="term"><small>Starting</small>${fmt(c.openingCash)}</span><span class="op">+</span><span class="term"><small>Cash sales</small>${fmt(c.cashSales)}</span><span class="op">+</span><span class="term"><small>Added</small>${fmt(c.cashIn)}</span><span class="op">−</span><span class="term"><small>Removed</small>${fmt(c.cashOut)}</span>${c.cashReturns ? '<span class="op">−</span><span class="term"><small>Refunds</small>' + fmt(c.cashReturns) + '</span>' : ''}</div></div>
   <div class="cs-sub"><div class="stat-card"><div class="stat-label">Cash sales</div><div class="stat-value">${c.cashTransactions}</div><div class="stat-foot">${fmt(c.cashSales)}</div></div>
    <div class="stat-card"><div class="stat-label">Card sales</div><div class="stat-value">${c.cardTransactions}</div><div class="stat-foot">${fmt(c.cardSales)} · not in the drawer</div></div></div>
   <div class="panel cs-card"><h3>Cash added or removed</h3><p>Record any cash that goes in or out of the drawer that is not a sale (change fund, petty cash, bank drop).</p>
    <div class="cs-grid" style="gap:0 14px">
     <div class="cs-field" style="grid-column:1/-1"><label>Type</label><div class="cs-seg" id="csKind"><button type="button" class="in on" data-kind="cash_in">+ Cash added</button><button type="button" class="out" data-kind="cash_out">− Cash removed</button></div></div>
     <div class="cs-field"><label for="csMvAmount">Amount</label><div class="cs-money"><span>₱</span><input id="csMvAmount" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csMvAmountErr"></div></div>
     <div class="cs-field"><label for="csMvReason">Reason</label><input id="csMvReason" maxlength="300" autocomplete="off" placeholder="At least 5 characters"><div class="cs-err" id="csMvReasonErr"></div></div>
    </div>
    <div class="cs-chips" id="csReasons" style="margin:-4px 0 14px"></div>
    <button class="btn-secondary cs-btn" id="csMvBtn">Record movement</button>
    <div class="cs-list">${mv.length ? mv.slice().reverse().map(m => `<div class="cs-mv"><span class="cs-t">${esc(timeOnly(m.createdAt))}</span><span class="cs-why">${esc(m.reason)}</span><span class="cs-amt ${m.kind === 'cash_in' ? 'in' : 'out'}">${m.kind === 'cash_in' ? '+' : '−'}${fmt(m.amount)}</span></div>`).join('') : '<div class="cs-none">Nothing recorded this shift.</div>'}</div></div>`;
  reasonChips();
 }
 let kind = 'cash_in';
 const REASONS = { cash_in: ['Change fund', 'Float top-up', 'Customer deposit'], cash_out: ['Bank deposit', 'Petty cash', 'Supplies purchase', 'Safe drop'] };
 function reasonChips() {
  const box = $('csReasons'); if (!box) return;
  box.innerHTML = REASONS[kind].map(r => '<button type="button" class="cs-chip" data-reason="' + esc(r) + '">' + esc(r) + '</button>').join('');
 }

 /* ---------- data ---------- */
 async function refresh() {
  let g;
  try { g = await request('/api/pos/cash-shifts/gate'); }
  catch (e) {
   if (gated) { lockApp(true); paintError(e.message); }                      // never signed the shift state: stay locked, offer a retry
   else { const a = $('csApp'); if (a) a.innerHTML = '<div class="panel cs-loading">Could not load your shift: ' + esc(e.message) + ' <button class="btn-secondary btn-sm" id="csRetry">Try again</button></div>'; }
   return;
  }
  HOURS = g.hours; hoursAt = Date.now(); THRESHOLD = g.reasonThreshold; SUGGEST = g.suggested; current = g.shift;
  paintGate(g);
  if (g.state === 'close_now' && current && !document.querySelector('.cs-modal')) closeDialog({ forced: true });   // end of day: the count-and-close window opens by itself
  const typing = document.activeElement && $('csApp') && $('csApp').contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (!typing) render(); else badge();   // do not wipe what the cashier is typing when a sale refreshes the shift
  clearInterval(ticker);
  ticker = setInterval(() => { const e = $('csElapsed'); if (e && current) e.textContent = dur(current.openedAt); const lf = $('csLeft'); if (lf && HOURS) lf.textContent = left() < 0 ? 'past closing' : hm(left()) + ' left'; side(); checkForceClose(); }, 30000); checkForceClose();
 }
 async function history() {
  const body = $('shiftHistory'); if (!body) return;
  try {
   const rows = await request('/api/pos/cash-shifts/history');
   body.innerHTML = rows.length ? rows.map(s => {
    let res = '<span class="cs-pill warn">Open</span>';
    if (s.closedAt) res = Math.abs(s.difference) < 0.005 ? '<span class="cs-pill good">Balanced</span>' : '<span class="cs-pill bad">' + (s.difference < 0 ? 'Short ' : 'Over ') + fmt(Math.abs(s.difference)) + '</span>';
    return `<tr><td>#${esc(s.id)}</td><td>${esc(when(s.openedAt))}</td><td>${s.closedAt ? esc(when(s.closedAt)) : '—'}</td><td>${dur(s.openedAt, s.closedAt)}</td><td class="cs-r">${fmt(s.cashSales)}</td><td class="cs-r">${s.closingCash == null ? '—' : fmt(s.closingCash)}</td><td>${res}</td></tr>`;
   }).join('') : '<tr><td colspan="7" class="cs-none">No shifts yet.</td></tr>';
  } catch (e) { body.innerHTML = '<tr><td colspan="7" class="cs-none">' + esc(e.message) + '</td></tr>'; }
 }
 const reload = async () => { await refresh(); await history(); };
 const start = async () => {
  lockApp(true);                                  // locked from the first paint, until the server says a shift is open
  await reload();
  // while locked, look again every 30 s (store opens, closing time passes); while selling, every 5 min (a shift left open past midnight becomes "yesterday's")
  setInterval(() => { if (document.hidden || document.querySelector('.cs-modal')) return; pollN++; if (gated || pollN % 10 === 0) refresh(); }, 30000);
 };

 /* ---------- actions ---------- */
 async function openShift() {
  const p = parseAmount($('csOpening').value);
  if (!p.ok) return fieldErr('csOpening', p.error);
  fieldErr('csOpening', '');
  if (p.value > 50000 && !(await confirmBox('Large starting cash', 'You entered <b>' + fmt(p.value) + '</b>. Is that the correct amount in your drawer?', 'Yes, open shift'))) return;
  const btn = $('csOpenBtn'); btn.disabled = true;
  try { await request('/api/pos/cash-shifts/open', { method: 'POST', body: JSON.stringify({ openingCash: p.value }) }); say('Shift opened. You can start selling.'); await reload(); }
  catch (e) { fieldErr('csOpening', e.fields.openingCash || e.message); btn.disabled = false; }
 }
 async function recordMovement() {
  const a = parseAmount($('csMvAmount').value, { allowZero: false }), reason = $('csMvReason').value.trim();
  let ok = true;
  fieldErr('csMvAmount', a.ok ? '' : a.error); if (!a.ok) ok = false;
  if (kind === 'cash_out' && a.ok && current && a.value > current.expectedCash + 0.004) { fieldErr('csMvAmount', 'Only ' + fmt(current.expectedCash) + ' should be in the drawer.'); ok = false; }
  if (reason.length < 5) { fieldErr('csMvReason', 'Write a reason (at least 5 characters).'); ok = false; } else fieldErr('csMvReason', '');
  if (!ok) return;
  const btn = $('csMvBtn'); btn.disabled = true;
  try { await request('/api/pos/cash-shifts/movements', { method: 'POST', body: JSON.stringify({ kind, amount: a.value, reason }) }); say(kind === 'cash_in' ? 'Cash added recorded.' : 'Cash removed recorded.'); await refresh(); }
  catch (e) { fieldErr('csMvAmount', e.fields.amount || ''); fieldErr('csMvReason', e.fields.reason || ''); if (!Object.keys(e.fields).length) say(e.message, true); btn.disabled = false; }
 }

  /* End of day: from HOURS.forceCloseMinutes before closing (e.g. 4:45 PM for a 5:00 PM close) the shift must be closed. While selling, this asks the
     server once a minute once that window is near; the server knows when the shift was opened and answers 'close_now', which locks the screen
     and opens the count-and-close window (see refresh()). The server also refuses sales on that shift, so this cannot be bypassed by hiding the window. */
  function checkForceClose() {
    if (!current || gated || !HOURS || !(HOURS.forceCloseMinutes > 0)) return;
    const l = left(); if (l == null || l > HOURS.forceCloseMinutes) return;
    if (Date.now() - lastForceAsk < 60000) return;
    lastForceAsk = Date.now(); refresh();
  }
  function closeDialog(opts) {
  const forced = !!(opts && opts.forced);
  const exp = current.expectedCash;
    const banner = forced ? '<div class="cs-warn" style="margin-bottom:14px"><b>Time to close your shift.</b> The store closes at ' + esc(HOURS ? HOURS.close : '') + '. Count the notes and coins in your drawer and close this shift now. Selling is paused until it is closed; this window cannot be dismissed.</div>' : '';
    const d = dialog(banner + `<h3>Count &amp; close shift</h3>
   <div class="cs-tabs"><button type="button" class="on" data-mode="count">Count notes &amp; coins</button><button type="button" data-mode="total">I know the total</button></div>
   <div id="csModeCount" class="cs-count">${DENOMS.map(([k, c]) => `<div class="cs-den"><span class="d">₱${k}</span><input type="number" inputmode="numeric" min="0" max="100000" step="1" aria-describedby="csFormErr" data-den="${k}" placeholder="0" aria-label="How many ₱${k}"><span class="s" data-sub="${k}">₱0.00</span></div>`).join('')}</div>
   <div id="csModeTotal" hidden><div class="cs-field"><label for="csTotal">Total cash counted</label><div class="cs-money"><span>₱</span><input id="csTotal" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csTotalErr"></div></div></div>
   <div class="cs-recon" id="csRecon"><div><small>Expected</small><b>${fmt(exp)}</b></div><div><small>Counted</small><b id="csCounted">—</b></div><div><small>Difference</small><b class="df" id="csDiff">—</b></div></div>
   <div class="cs-limit" id="csLimit"></div>
   <div class="cs-field"><label for="csNote" id="csNoteLabel">Closing note (optional)</label><textarea id="csNote" maxlength="500" placeholder="Anything Finance should know about this shift"></textarea><div class="cs-err" id="csNoteErr"></div></div>
   <div class="cs-field"><label for="csDeposit">Cash you are taking out for the bank or safe (optional)</label><div class="cs-money"><span>₱</span><input id="csDeposit" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csDepositErr"></div><div class="cs-hint" id="csNext"></div></div>
   <label class="cs-check"><input type="checkbox" id="csSure"><span>I counted the cash in my drawer and the amount above is correct.</span></label>
   <div class="cs-err" role="alert" id="csFormErr" style="margin-bottom:10px"></div>
   <div class="cs-actions">${forced ? '' : '<button class="btn-secondary" data-cancel>Cancel</button>'}<button class="btn-primary" id="csConfirmClose" disabled>Close shift</button></div>`, { locked: forced });
  let mode = 'count';
  const counted = () => {
   if (mode === 'count') return readCashCount(d.el.querySelectorAll('[data-den]'));
   const p = parseAmount($('csTotal').value); return p.ok ? { ok: true, value: p.value } : { ok: false, error: p.error };
  };
  const depositNow = c => {
   const raw = window.MoneyInput ? MoneyInput.raw($('csDeposit').value) : String($('csDeposit').value || '').trim();
   if (!raw) return { ok: true, value: 0 };
   const p = parseAmount(raw); if (!p.ok) return p;
   if (c.ok && cents(p.value) > cents(c.value)) return { ok: false, error: 'The deposit cannot be more than the cash you counted.' };
   return p;
  };
  const update = () => {
   d.el.querySelectorAll('[data-den]').forEach(i => { const n = (i.validity.badInput || (i.value !== '' && !/^\d+$/.test(i.value)) || Number(i.value) > 100000 ? null : Number(i.value)); const sub = d.q('[data-sub="' + i.dataset.den + '"]'); sub.textContent = n === null ? '—' : fmt(n * (DENOMS.find(x => x[0] === i.dataset.den)[1]) / 100); });
   const c = counted(), box = $('csRecon'), diff = c.ok ? Math.round((c.value - exp) * 100) / 100 : null;
   $('csFormErr').textContent = c.ok ? '' : c.error;
   $('csCounted').textContent = c.ok ? fmt(c.value) : '—';
   $('csDiff').textContent = diff == null ? '—' : Math.abs(diff) < 0.005 ? 'Balanced' : (diff < 0 ? 'Short ' : 'Over ') + fmt(Math.abs(diff));
   box.className = 'cs-recon' + (diff == null ? '' : Math.abs(diff) < 0.005 ? ' good' : diff < 0 ? ' bad' : ' warn');
   const needNote = diff != null && cents(Math.abs(diff)) > cents(THRESHOLD);   // a reason is only needed ABOVE the set difference
   $('csNoteLabel').textContent = needNote ? 'Explain the difference (required)' : 'Closing note (optional)';
   $('csLimit').textContent = 'A written reason is only needed when the drawer is more than ' + fmt(THRESHOLD) + ' short or over.';
   const dep = depositNow(c); fieldErr('csDeposit', dep.ok ? '' : dep.error);
   $('csNext').textContent = c.ok && dep.ok ? 'Stays in the drawer, and is pre-filled when the next shift opens: ' + fmt((cents(c.value) - cents(dep.value)) / 100) : '';
   const noteOk = !needNote || $('csNote').value.trim().length >= 5;
   fieldErr('csNote', !noteOk ? 'Please explain the difference (at least 5 characters).' : '');
   $('csConfirmClose').disabled = !(c.ok && dep.ok && $('csSure').checked && noteOk);
   return { c, diff, needNote, noteOk, dep };
  };
  d.el.addEventListener('input', update); d.el.addEventListener('change', update);
  d.el.querySelectorAll('.cs-tabs button').forEach(b => b.onclick = () => {
   mode = b.dataset.mode; d.el.querySelectorAll('.cs-tabs button').forEach(x => x.classList.toggle('on', x === b));
   $('csModeCount').hidden = mode !== 'count'; $('csModeTotal').hidden = mode !== 'total'; update();
  });
  const cancelBtn = d.q('[data-cancel]'); if (cancelBtn) cancelBtn.onclick = d.close;     // a forced (end-of-day) window has no Cancel
  $('csConfirmClose').onclick = async () => {
   const { c, needNote, noteOk, dep } = update();
   if (!c.ok || !dep.ok) return; if (needNote && !noteOk) return fieldErr('csNote', 'Please explain the difference (at least 5 characters).');
   const btn = $('csConfirmClose'); btn.disabled = true; $('csFormErr').textContent = '';
   try {
    const s = await request('/api/pos/cash-shifts/close', { method: 'POST', body: JSON.stringify({ closingCash: c.value, note: $('csNote').value, breakdown: mode === 'count' ? c.counts : undefined, deposit: dep.value }) });
    d.close(); resultDialog(s); await reload();
   } catch (e) { $('csFormErr').textContent = e.message; fieldErr('csNote', e.fields.note || ''); fieldErr('csDeposit', e.fields.deposit || ''); btn.disabled = false; }
  };
  update();
  const first = d.el.querySelector('[data-den]'); if (first) first.focus();
 }
 function resultDialog(s) {
  const bal = Math.abs(s.difference) < 0.005;
  const d = dialog(`<h3>Shift #${esc(s.id)} closed</h3><p class="lead">${bal ? 'Your drawer balances. Great job.' : 'Your count is ' + (s.difference < 0 ? 'short' : 'over') + ' by <b>' + fmt(Math.abs(s.difference)) + '</b>. Finance can see your note.'}</p>
   <div class="cs-sum"><div><span>Starting cash</span><b>${fmt(s.openingCash)}</b></div><div><span>Cash sales (${s.cashTransactions})</span><b>${fmt(s.cashSales)}</b></div><div><span>Cash added</span><b>+${fmt(s.cashIn)}</b></div><div><span>Cash removed</span><b>−${fmt(s.cashOut)}</b></div>${s.cashReturns ? '<div><span>Cash refunds (returns)</span><b>−' + fmt(s.cashReturns) + '</b></div>' : ''}<div><span>Expected</span><b>${fmt(s.expectedCash)}</b></div><div><span>Counted</span><b>${fmt(s.closingCash)}</b></div><div><span>Difference</span><b style="color:var(${bal ? '--green' : '--red'})">${bal ? 'Balanced' : fmt(s.difference)}</b></div></div>
   ${s.nextOpening != null ? '<p class="cs-hours">Next shift will start with <b>' + fmt(s.nextOpening) + '</b>' + (s.closingDeposit > 0 ? ' (counted ' + fmt(s.closingCash) + ' − deposit ' + fmt(s.closingDeposit) + ')' : '') + '.</p>' : ''}
   <div class="cs-actions"><button class="btn-primary" data-done>Done</button></div>`);
  d.q('[data-done]').onclick = d.close; d.q('[data-done]').focus();
 }

 /* ---------- the gate: full-screen, no dismiss ----------
    Shown right after sign-in and whenever no shift is open. The sidebar and the page behind it are made inert (no mouse, no keyboard),
    showPage() refuses to move, Escape does nothing. The only ways out are opening a shift, closing yesterday's, or logging out. */
 function lockApp(on) {
  gated = on;
  const g = $('shiftGate'); if (g) g.hidden = !on;
  ['main', 'sidebar', 'sidebarBackdrop'].forEach(id => { const e = $(id); if (e) { if (on) e.setAttribute('inert', ''); else e.removeAttribute('inert'); } });
  document.body.classList.toggle('sg-on', on);
  if (on) { const sb = $('sidebar'); if (sb) sb.classList.remove('open'); document.body.classList.remove('nav-open'); }
  else { paintedKey = ''; const pg = pendingPage; pendingPage = null; if (pg && pg !== 'terminal' && window.showPage) window.showPage(pg); }   // e.g. a refresh on #sales, or a reminder link to #shift
 }
 const who = () => { try { return USER && USER.name ? USER.name : ''; } catch (e) { return ''; } };
 function gateShell(title, html) {
  const c = $('sgCard'); if (!c) return;
  c.innerHTML = '<div class="sg-mark" aria-hidden="true">3<span>E</span></div><h1 id="sgTitle">' + title + '</h1>' + html +
   '<div class="sg-foot"><span>' + esc(who()) + '</span><button type="button" class="link-btn" id="sgLogout">Log out</button></div>';
 }
 function paintError(msg) {
  paintedKey = 'error';
  gateShell('Could not check your cash shift', '<p class="sg-lead">' + esc(msg) + '</p><button type="button" class="btn-primary cs-btn" id="sgRetry">Try again</button>');
 }
 function paintGate(g) {
  if (g.state === 'open') { lockApp(false); return; }
  lockApp(true);
  const sug = g.suggested, h = g.hours, sh = g.shift;
  const key = [g.state, sh ? sh.id : '', sug ? sug.fromShiftId + ':' + sug.amount : ''].join('|');
  if (key === paintedKey && $('sgCard') && $('sgCard').children.length) return;   // same screen: leave what the cashier is typing alone
  paintedKey = key;
  if (g.state === 'store_closed') {
   gateShell('Store closed', '<p class="sg-lead">Store hours are <b>' + esc(h.open) + ' \u2013 ' + esc(h.close) + '</b>. Cash shifts cannot be opened now.</p><p class="sg-lead dim">You can open your shift again tomorrow from ' + esc(h.firstOpen) + '.</p>');
  } else if (g.state === 'too_early') {
   gateShell('Store not open yet', '<p class="sg-lead">The store opens at <b>' + esc(h.open) + '</b>. You can open your shift from <b>' + esc(h.firstOpen) + '</b>.</p><p class="sg-lead dim">This screen updates by itself when it is time.</p>');
  } else if (g.state === 'close_previous') {
   gateShell('Close your earlier shift first',
    '<p class="sg-lead">Shift <b>#' + esc(sh.id) + '</b> opened <b>' + esc(when(sh.openedAt)) + '</b> was never closed. Count the drawer and close it before you open a new shift. Selling stays blocked until then.</p>' +
    '<div class="sg-carry"><span>Cash that should be in the drawer</span><b>' + fmt(sh.expectedCash) + '</b><small>' + esc(sh.cashTransactions) + ' cash sale(s) \u00B7 started with ' + fmt(sh.openingCash) + '</small></div>' +
    '<button type="button" class="btn-primary cs-btn" id="sgClosePrev">Count &amp; close shift #' + esc(sh.id) + '</button>');
  } else if (g.state === 'close_now') {   // end of day: the shift must be counted and closed, no dismiss
   gateShell('Time to close your shift',
    '<p class="sg-lead">The store closes at <b>' + esc(h.close) + '</b>. From <b>' + esc(h.forceCloseFrom) + '</b> every open shift must be counted and closed. Selling is paused until shift <b>#' + esc(sh.id) + '</b> is closed.</p>' +
    '<div class="sg-carry"><span>Cash that should be in the drawer</span><b>' + fmt(sh.expectedCash) + '</b><small>' + esc(sh.cashTransactions) + ' cash sale(s) \u00b7 started with ' + fmt(sh.openingCash) + '</small></div>' +
    '<button type="button" class="btn-primary cs-btn" id="sgCloseNow">Count &amp; close shift #' + esc(sh.id) + '</button>');
  } else {   // can_open
   const hint = '<p class="cs-hours">Store hours <b>' + esc(h.open) + ' \u2013 ' + esc(h.close) + '</b>. ' + (h.forceCloseMinutes > 0 ? 'Your shift must be closed from <b>' + esc(h.forceCloseFrom) + '</b>.' : 'Close your shift before ' + esc(h.close) + '.') + '</p>';
   gateShell('Open cash shift',
    '<p class="sg-lead">Count the cash in the drawer and confirm the starting amount. You cannot sell until a shift is open.</p>' +
    (sug ? '<div class="sg-carry"><span>Carried over from shift #' + esc(sug.fromShiftId) + (sug.cashierName ? ' (' + esc(sug.cashierName) + ')' : '') + ', closed ' + esc(when(sug.closedAt)) + '</span><b>' + fmt(sug.amount) + '</b><small>Counted ' + fmt(sug.closingCash) + ' \u2212 deposit ' + fmt(sug.deposit) + '</small></div>'
         : '<p class="sg-lead dim">No earlier shift on record, so type the starting cash (change fund).</p>') +
    '<div class="cs-field"><label for="sgCash">Starting cash</label><div class="cs-money"><span>\u20B1</span><input id="sgCash" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="sgCashErr"></div><div class="sg-diff" id="sgDiff" aria-live="polite"></div>' +
    (sug ? '' : '<div class="cs-chips">' + [100, 500, 1000, 2000, 5000].map(v => '<button type="button" class="cs-chip" data-sgfill="' + v + '">+' + fmt(v).replace('.00', '') + '</button>').join('') + '<button type="button" class="cs-chip" data-sgfill="clear">Clear</button></div>') + '</div>' +
    '<label class="cs-check"><input type="checkbox" id="sgSure"><span>I counted the drawer and this starting amount is correct.</span></label>' +
    '<button type="button" class="btn-primary cs-btn" id="sgOpen" disabled>Confirm &amp; open shift</button>' + hint);
   const box = $('sgCash');
   if (window.MoneyInput && sug) MoneyInput.set(box, sug.amount.toFixed(2));
   gateUpdate(); setTimeout(() => box.focus(), 50);
  }
 }
 function gateUpdate() {
  const box = $('sgCash'); if (!box) return;
  const p = parseAmount(box.value), diffEl = $('sgDiff'), sure = $('sgSure').checked;
  let msg = '', cls = '';
  if (p.ok && SUGGEST) {
   const d = (cents(p.value) - cents(SUGGEST.amount)) / 100;
   if (d === 0) { msg = 'Matches the carried-over amount.'; cls = 'good'; }
   else { msg = 'Different from the carried-over ' + fmt(SUGGEST.amount) + ' by ' + fmt(Math.abs(d)) + ' (' + (d < 0 ? 'less' : 'more') + '). Recount the drawer before you confirm; Finance can see this.'; cls = 'warn'; }
  }
  diffEl.textContent = msg; diffEl.className = 'sg-diff ' + cls;
  $('sgOpen').disabled = !(p.ok && sure);
 }
 async function gateOpen() {
  const box = $('sgCash'), p = parseAmount(box.value);
  if (!p.ok) return fieldErr('sgCash', p.error);
  fieldErr('sgCash', '');
  if (p.value > 50000 && !(await confirmBox('Large starting cash', 'You entered <b>' + fmt(p.value) + '</b>. Is that the correct amount in your drawer?', 'Yes, open shift'))) return;
  const btn = $('sgOpen'); btn.disabled = true;
  try { await request('/api/pos/cash-shifts/open', { method: 'POST', body: JSON.stringify({ openingCash: p.value }) }); say('Shift opened. You can start selling.'); await reload(); }
  catch (e) { fieldErr('sgCash', (e.fields && e.fields.openingCash) || e.message); btn.disabled = false; refresh(); }   // e.g. the store just closed: the screen follows
 }
 const logOut = async () => { try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* leave anyway */ } location.href = 'Login_Inventory.html'; };
 document.addEventListener('click', e => {
  const t = e.target.closest('#shiftGate button'); if (!t) return;
  if (t.id === 'sgOpen') gateOpen();
  else if (t.id === 'sgLogout') logOut();
  else if (t.id === 'sgRetry') refresh();
  else if (t.id === 'sgClosePrev') { if (current) closeDialog(); else refresh(); }
  else if (t.id === 'sgCloseNow') { if (current) closeDialog({ forced: true }); else refresh(); }
  else if (t.dataset.sgfill) { const box = $('sgCash'), now = MoneyInput.parse(box.value) || 0; MoneyInput.set(box, t.dataset.sgfill === 'clear' ? '' : ((cents(now) + cents(t.dataset.sgfill)) / 100).toFixed(2)); fieldErr('sgCash', ''); gateUpdate(); box.focus(); }
 });
 function liveCashField(input) {
  const id = input.id;
  if (['sgCash', 'csOpening', 'csMvAmount', 'csTotal'].includes(id)) {
   const p = parseAmount(input.value, {allowZero:id !== 'csMvAmount'});
   fieldErr(id, !p.ok ? p.error : id === 'csMvAmount' && kind === 'cash_out' && current && p.value > current.expectedCash + 0.004 ? 'Only ' + fmt(current.expectedCash) + ' should be in the drawer.' : '');
  } else if (id === 'csMvReason') fieldErr(id, input.value.trim().length < 5 ? 'Write a reason (at least 5 characters).' : '');
  if (id === 'sgCash') gateUpdate();
 }
 ['input', 'focusout'].forEach(event => document.addEventListener(event, e => liveCashField(e.target)));
 document.addEventListener('change', e => { if (e.target.id === 'sgSure') gateUpdate(); });
 document.addEventListener('keydown', e => {
  if (!gated) return;
  if (e.key === 'Enter' && e.target.id === 'sgCash' && !$('sgOpen').disabled) gateOpen();
  if (e.key === 'Escape' && !document.querySelector('.cs-modal')) e.preventDefault();   // the gate has no dismiss
 });
 // other pages stay disabled while locked, whoever asks (menu, notification link, address-bar #page, Back button)
 if (typeof window.showPage === 'function') { const goTo = window.showPage; window.showPage = function (p) { if (gated) { pendingPage = p; return; } return goTo.apply(this, arguments); }; }

 /* ---------- events ---------- */
 document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.id === 'csOpenBtn') openShift();
  // each chip ADDS to the starting cash (tap +₱1,000 twice = ₱2,000); Clear empties it
  else if (t.dataset.fill) { const box = $('csOpening'), now = MoneyInput.parse(box.value) || 0; MoneyInput.set(box, t.dataset.fill === 'clear' ? '' : ((Math.round(now * 100) + Math.round(Number(t.dataset.fill) * 100)) / 100).toFixed(2)); fieldErr('csOpening', ''); box.focus(); }
  else if (t.id === 'csMvBtn') recordMovement();
  else if (t.id === 'csCloseBtn') { current ? closeDialog() : refresh(); }
  else if (t.id === 'csRetry') reload();
  else if (t.id === 'shiftBannerBtn') { if (window.showPage) window.showPage('shift'); }
  else if (t.closest('#csKind') && t.dataset.kind) { kind = t.dataset.kind; document.querySelectorAll('#csKind button').forEach(b => b.classList.toggle('on', b === t)); reasonChips(); }
  else if (t.dataset.reason) { $('csMvReason').value = t.dataset.reason; fieldErr('csMvReason', ''); $('csMvReason').focus(); }
 });
 document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'csOpening') openShift(); if (e.key === 'Enter' && e.target.id === 'csMvAmount') recordMovement(); });
 const nav = document.querySelector('[data-page="shift"]');
 if (nav) nav.addEventListener('click', reload);
 window.refreshCashShift = refresh;
 window.addEventListener('focus', refresh);
 start();
})();
