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
 // notes & coins; value in centavos so the total never has floating point errors
 const DENOMS = [['1000', 100000], ['500', 50000], ['200', 20000], ['100', 10000], ['50', 5000], ['20', 2000], ['10', 1000], ['5', 500], ['1', 100], ['0.25', 25], ['0.05', 5]];
 let current = null, ticker = null, hours = null;   // hours: {open, close, openError, minutesToClose} from the server clock

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
 const fieldErr = (id, msg) => { const i = $(id), e = $(id + 'Err'); if (i) i.classList.toggle('is-bad', !!msg); if (e) e.textContent = msg || ''; };

 /* ---------- dialog helper ---------- */
 function dialog(html) {
  const m = document.createElement('div');
  m.className = 'cs-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
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
 }
 function render() {
  const app = $('csApp'); if (!app) return;
  badge();
  const hoursText = hours ? 'Shift hours: open from ' + esc(hours.open) + ', close before ' + esc(hours.close) + '.' : '';
  if (!current) {
   app.innerHTML = `<div class="cs-hero closed"><div><div class="cs-state"><span class="cs-dot"></span>No open shift</div><div class="cs-meta">Count the cash in your drawer, then enter it below to start selling. ${hoursText}</div></div></div>
   ${hours && hours.openError ? '<div class="cs-warn"><b>' + esc(hours.openError) + '</b></div>' : ''}
   <div class="cs-grid cs-startgrid"><div class="panel cs-card cs-start"><h3>Start your shift</h3><p>Enter the starting cash (change fund) you put in the drawer.</p>
    <div class="cs-field"><label for="csOpening">Starting cash</label><div class="cs-money"><span>₱</span><input id="csOpening" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csOpeningErr"></div>
     <div class="cs-chips" title="Each tap adds that amount">${[100, 500, 1000, 2000, 5000].map(v => '<button type="button" class="cs-chip" data-fill="' + v + '">+' + fmt(v).replace('.00', '') + '</button>').join('')}<button type="button" class="cs-chip" data-fill="clear">Clear</button></div></div>
    <button class="btn-primary cs-btn" id="csOpenBtn"${hours && hours.openError ? ' disabled' : ''}>Open cash shift</button></div>
    <div class="panel cs-card cs-tips"><h3>Before you open</h3><p>A quick check keeps your end-of-shift count accurate.</p>
     <ol class="cs-steps"><li><b>Count the drawer</b><span>Count every bill and coin currently in the cash drawer.</span></li><li><b>Enter the change fund</b><span>Type the total, or tap the amounts: each tap adds up (e.g. +₱1,000 twice = ₱2,000).</span></li><li><b>Start selling</b><span>Cash sales are tracked automatically and compared to your count when you close.</span></li></ol></div></div>`;
   return;
  }
  const c = current, mv = c.movements || [];
  app.innerHTML = `<div class="cs-hero open"><div><div class="cs-state"><span class="cs-dot"></span>Shift #${esc(c.id)} is open</div>
    <div class="cs-meta">${esc(c.cashierName)} · opened ${esc(timeOnly(c.openedAt))} · open for <b id="csElapsed">${dur(c.openedAt)}</b></div></div>
    <button class="btn-primary" id="csCloseBtn">Count &amp; close shift</button></div>
   ${c.pastClosing ? '<div class="cs-warn"><b>It is past the ' + esc(hours ? hours.close : '5:00 PM') + ' closing time.</b> Sales and cash movements are stopped. Count and close this shift now.</div>'
     : hours && hours.minutesToClose <= 30 ? '<div class="cs-warn"><b>Closing in ' + hours.minutesToClose + ' min.</b> Close your shift before ' + esc(hours.close) + '.</div>' : ''}
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
  try { [current, hours] = await Promise.all([request('/api/pos/cash-shifts/current'), request('/api/pos/cash-shifts/hours').catch(() => hours)]); }
  catch (e) { const a = $('csApp'); if (a) a.innerHTML = '<div class="panel cs-loading">Could not load your shift: ' + esc(e.message) + ' <button class="btn-secondary btn-sm" id="csRetry">Try again</button></div>'; return; }
  const typing = document.activeElement && $('csApp') && $('csApp').contains(document.activeElement) && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (!typing) render(); else badge();   // do not wipe what the cashier is typing when a sale refreshes the shift
  clearInterval(ticker);
  if (current) ticker = setInterval(() => { const e = $('csElapsed'); if (e && current) e.textContent = dur(current.openedAt); }, 30000);
  // re-check the hours every minute so the 5:00 PM warning / 8:00 AM open button appear without a reload
  clearInterval(refresh.clock); refresh.clock = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
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

 function closeDialog() {
  const exp = current.expectedCash;
  const d = dialog(`<h3>Count &amp; close shift #${esc(current.id)}</h3><p class="lead">Count everything in the drawer, including the starting cash. Enter how many of each note and coin you have.</p>
   <div class="cs-tabs"><button type="button" class="on" data-mode="count">Count notes &amp; coins</button><button type="button" data-mode="total">I know the total</button></div>
   <div id="csModeCount" class="cs-count">${DENOMS.map(([k, c]) => `<div class="cs-den"><span class="d">₱${k}</span><input type="number" inputmode="numeric" min="0" step="1" data-den="${k}" placeholder="0" aria-label="How many ₱${k}"><span class="s" data-sub="${k}">₱0.00</span></div>`).join('')}</div>
   <div id="csModeTotal" hidden><div class="cs-field"><label for="csTotal">Total cash counted</label><div class="cs-money"><span>₱</span><input id="csTotal" data-money inputmode="decimal" autocomplete="off" placeholder="0.00"></div><div class="cs-err" id="csTotalErr"></div></div></div>
   <div class="cs-recon" id="csRecon"><div><small>Expected</small><b>${fmt(exp)}</b></div><div><small>Counted</small><b id="csCounted">—</b></div><div><small>Difference</small><b class="df" id="csDiff">—</b></div></div>
   <div class="cs-field"><label for="csNote" id="csNoteLabel">Closing note (optional)</label><textarea id="csNote" maxlength="500" placeholder="Anything Finance should know about this shift"></textarea><div class="cs-err" id="csNoteErr"></div></div>
   <label class="cs-check"><input type="checkbox" id="csSure"><span>I counted the cash in my drawer and the amount above is correct.</span></label>
   <div class="cs-err" id="csFormErr" style="margin-bottom:10px"></div>
   <div class="cs-actions"><button class="btn-secondary" data-cancel>Cancel</button><button class="btn-primary" id="csConfirmClose" disabled>Close shift</button></div>`);
  let mode = 'count';
  const counts = () => { const o = {}; d.el.querySelectorAll('[data-den]').forEach(i => { const n = Math.floor(Number(i.value)); if (n > 0) o[i.dataset.den] = n; }); return o; };
  const counted = () => {
   if (mode === 'count') { const c = counts(); const touched = Object.keys(c).length > 0 || [...d.el.querySelectorAll('[data-den]')].some(i => i.value !== ''); let cents = 0; DENOMS.forEach(([k, v]) => cents += (c[k] || 0) * v); return { ok: touched, value: cents / 100, counts: c }; }
   const p = parseAmount($('csTotal').value); return p.ok ? { ok: true, value: p.value } : { ok: false, error: p.error };
  };
  const update = () => {
   d.el.querySelectorAll('[data-den]').forEach(i => { const n = Math.max(0, Math.floor(Number(i.value)) || 0); const sub = d.q('[data-sub="' + i.dataset.den + '"]'); sub.textContent = fmt(n * (DENOMS.find(x => x[0] === i.dataset.den)[1]) / 100); });
   const c = counted(), box = $('csRecon'), diff = c.ok ? Math.round((c.value - exp) * 100) / 100 : null;
   $('csCounted').textContent = c.ok ? fmt(c.value) : '—';
   $('csDiff').textContent = diff == null ? '—' : Math.abs(diff) < 0.005 ? 'Balanced' : (diff < 0 ? 'Short ' : 'Over ') + fmt(Math.abs(diff));
   box.className = 'cs-recon' + (diff == null ? '' : Math.abs(diff) < 0.005 ? ' good' : diff < 0 ? ' bad' : ' warn');
   const needNote = diff != null && Math.abs(diff) >= 0.005;
   $('csNoteLabel').textContent = needNote ? 'Explain the difference (required)' : 'Closing note (optional)';
   const noteOk = !needNote || $('csNote').value.trim().length >= 5;
   $('csConfirmClose').disabled = !(c.ok && $('csSure').checked && noteOk);
   return { c, diff, needNote, noteOk };
  };
  d.el.addEventListener('input', update); d.el.addEventListener('change', update);
  d.el.querySelectorAll('.cs-tabs button').forEach(b => b.onclick = () => {
   mode = b.dataset.mode; d.el.querySelectorAll('.cs-tabs button').forEach(x => x.classList.toggle('on', x === b));
   $('csModeCount').hidden = mode !== 'count'; $('csModeTotal').hidden = mode !== 'total'; update();
  });
  d.q('[data-cancel]').onclick = d.close;
  $('csConfirmClose').onclick = async () => {
   const { c, needNote, noteOk } = update();
   if (!c.ok) return; if (needNote && !noteOk) return fieldErr('csNote', 'Please explain the difference (at least 5 characters).');
   const btn = $('csConfirmClose'); btn.disabled = true; $('csFormErr').textContent = '';
   try {
    const s = await request('/api/pos/cash-shifts/close', { method: 'POST', body: JSON.stringify({ closingCash: c.value, note: $('csNote').value, breakdown: mode === 'count' ? c.counts : undefined }) });
    d.close(); resultDialog(s); await reload();
   } catch (e) { $('csFormErr').textContent = e.message; fieldErr('csNote', e.fields.note || ''); btn.disabled = false; }
  };
  update();
  const first = d.el.querySelector('[data-den]'); if (first) first.focus();
 }
 function resultDialog(s) {
  const bal = Math.abs(s.difference) < 0.005;
  const d = dialog(`<h3>Shift #${esc(s.id)} closed</h3><p class="lead">${bal ? 'Your drawer balances. Great job.' : 'Your count is ' + (s.difference < 0 ? 'short' : 'over') + ' by <b>' + fmt(Math.abs(s.difference)) + '</b>. Finance can see your note.'}</p>
   <div class="cs-sum"><div><span>Starting cash</span><b>${fmt(s.openingCash)}</b></div><div><span>Cash sales (${s.cashTransactions})</span><b>${fmt(s.cashSales)}</b></div><div><span>Cash added</span><b>+${fmt(s.cashIn)}</b></div><div><span>Cash removed</span><b>−${fmt(s.cashOut)}</b></div>${s.cashReturns ? '<div><span>Cash refunds (returns)</span><b>−' + fmt(s.cashReturns) + '</b></div>' : ''}<div><span>Expected</span><b>${fmt(s.expectedCash)}</b></div><div><span>Counted</span><b>${fmt(s.closingCash)}</b></div><div><span>Difference</span><b style="color:var(${bal ? '--green' : '--red'})">${bal ? 'Balanced' : fmt(s.difference)}</b></div></div>
   <div class="cs-actions"><button class="btn-primary" data-done>Done</button></div>`);
  d.q('[data-done]').onclick = d.close; d.q('[data-done]').focus();
 }

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
 reload();
})();