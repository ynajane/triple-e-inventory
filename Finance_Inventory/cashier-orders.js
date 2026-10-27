/* Cashier · Online Orders
   The cashier runs the whole life of an online order here: confirm -> pack -> ready for pickup / out for delivery -> picked up / delivered.
   - Store pickups are processed at the counter: ID check, the person collecting, and the cash (for "Cash on Pickup") go into the cashier's open Cash Shift.
   - Deliveries have no rider assignment: the cashier marks "Out for delivery" and later "Delivered" (who received it). Cash on Delivery is recorded the same way.
   - The server enforces every rule again (one step at a time, payment before release, shift open, names / ID / amounts), so this page only guides and pre-checks. */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (t) => (t ? new Date(t).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (t) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24); return d + (d === 1 ? ' day ago' : ' days ago');
};
const say = (text, bad) => { if (typeof toast === 'function') toast(text, !!bad); };

/* ---------- rules (the same ones the server checks) ---------- */
const NAME_RE = /^\p{L}[\p{L}\s.'\u2019-]{1,79}$/u;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 \-_/]{3,39}$/;
const ID_TYPES = ['National ID', 'Driver License', 'Passport', 'School ID', 'Company ID', 'Other Government ID'];
const FINAL = ['Delivered', 'Picked Up'];
const isOpen = (o) => o.status !== 'Cancelled' && !FINAL.includes(o.status);
const TABS = [
  { key: 'open', label: 'Open', test: isOpen },
  { key: 'confirm', label: 'To confirm', hot: true, test: (o) => o.status === 'Pending Confirmation' },
  { key: 'pack', label: 'To pack', hot: true, test: (o) => o.status === 'Paid' },
  { key: 'ready', label: 'Packed & ready', test: (o) => ['Packed', 'Ready for Pickup', 'Out for Delivery'].includes(o.status) },
  { key: 'done', label: 'Completed', test: (o) => FINAL.includes(o.status) },
  { key: 'cancelled', label: 'Cancelled', test: (o) => o.status === 'Cancelled' }
];
const ACTION = {
  'Paid': 'Confirm order', 'Packed': 'Mark as packed', 'Ready for Pickup': 'Ready for pickup',
  'Out for Delivery': 'Send out for delivery', 'Picked Up': 'Release to customer', 'Delivered': 'Mark as delivered'
};
const statusLabel = (o) => (o.status === 'Paid' ? 'Confirmed' : o.status);
const statusClass = (s) => (s === 'Pending Confirmation' ? 's-pending' : FINAL.includes(s) ? 's-done' : s === 'Cancelled' ? 's-off' : 's-active');
const isCash = (o) => /^Cash on /.test(o.method || '');
/* The money comes from the ledger (orders.paid_amount / payment_state), never from a checkout redirect or a typed
   invoice number. §5: "Paid" only when the ledger says the balance is zero. */
const STATE_LABEL = { unpaid: 'Unpaid', partially_paid: 'Partially paid', paid: 'Paid', refunded: 'Refunded', partially_refunded: 'Partially refunded' };
const dueOf = (o) => Number(o.outstanding != null ? o.outstanding : Math.max(0, Number(o.total || 0) - Number(o.paidAmount || 0)));
const paidOf = (o) => Number(o.paidAmount || 0);
function payLabel(o) {
  if (o.paymentState === 'paid') return 'Paid';
  if (o.paymentState === 'partially_paid') return 'Partially paid \u00B7 ' + peso(dueOf(o)) + ' due';
  if (o.paymentState === 'partially_refunded' || o.paymentState === 'refunded') return STATE_LABEL[o.paymentState];
  if (o.advance && !o.advance.paid) return 'Waiting for the ' + o.advance.label + ' online';
  if (o.advance) return 'Paid online: ' + o.advance.label + ' \u00B7 ' + peso(dueOf(o)) + ' cash';
  if (isCash(o)) return o.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at counter';
  if (o.paymentStatus === 'expired') return 'Payment expired';
  return 'Awaiting payment';
}
function parseMoney(v) {
  const s = String(v == null ? '' : v).replace(/[\u20B1,\s]/g, '');
  return /^\d{1,8}(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) / 100 : null;
}

/* ---------- state ---------- */
let orders = [], tab = 'open', chosen = null, target = '', busy = false, shiftOpen = null, opener = null, loading = false;

async function request(path, options = {}) {
  let r;
  try { r = await fetch('/api' + path, { credentials: 'same-origin', signal: AbortSignal.timeout(15000), ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); }
  catch { throw Object.assign(new Error('Cannot reach the server. Check the connection and try again.'), { fields: {} }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw Object.assign(new Error('Your session has ended. Please sign in again.'), { fields: {} });
  if (!r.ok) throw Object.assign(new Error(j.error || Object.values(j.fields || {}).join('; ') || 'Request failed'), { fields: j.fields || {} });
  return j;
}
function message(t, bad) { const m = $('coMessage'); m.textContent = t || ''; m.classList.toggle('err', !!bad); }

/* ---------- list ---------- */
function visible() {
  const t = TABS.find((x) => x.key === tab) || TABS[0];
  const q = $('coSearch').value.trim().toLowerCase(), f = $('coFilter').value;
  const list = orders.filter((o) => t.test(o) && (!f || o.fulfillment === f)
    && (!q || [o.id, o.customer, o.phone, o.customerPhone, o.recipient].join(' ').toLowerCase().includes(q)));
  const oldestFirst = ['open', 'confirm', 'pack', 'ready'].includes(tab);          // the queue: whoever has waited longest first
  return list.sort((a, b) => (oldestFirst ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
}
function renderTabs() {
  $('coTabs').innerHTML = TABS.map((t) => {
    const n = orders.filter(t.test).length;
    return `<button type="button" role="tab" class="co-tab${t.hot && n ? ' hot' : ''}" data-tab="${t.key}" aria-selected="${t.key === tab}">${esc(t.label)} <b>${n}</b></button>`;
  }).join('');
  const toConfirm = orders.filter((o) => o.status === 'Pending Confirmation').length, badge = $('navOrdersBadge');
  if (badge) { badge.textContent = toConfirm; badge.hidden = !toConfirm; }
}
function flagsFor(o) {
  const out = [];
  if (o.cancelRequested) out.push('<div class="co-flag bad">The customer asked to cancel this order. Finance must approve or reject it before it can move.</div>');
  else if (o.awaitingPayment) out.push('<div class="co-flag">Waiting for the customer\u2019s online payment (' + esc(o.method) + '). It cannot be confirmed until it is paid.</div>');
  else if (o.awaitingAdvance) out.push(`<div class="co-flag">Waiting for the customer to pay the <b>${peso(o.advance.amount)}</b> ${o.advance.label} online. The order confirms itself when it is paid; then <b>${peso(o.advance.cash)}</b> is collected in cash ${o.fulfillment === 'Delivery' ? 'on delivery' : 'at pickup'}.</div>`);
  else if (o.cashOnHandover) out.push(`<div class="co-flag">Collect <b>${peso(dueOf(o))}</b> in cash when the order is ${o.fulfillment === 'Delivery' ? 'received' : 'picked up'}.${paidOf(o) ? ' ' + peso(paidOf(o)) + ' is already recorded against it.' : ''}</div>`);
  if (o.forfeited) out.push(`<div class="co-flag">${o.fulfillment === 'Delivery' ? 'Delivery fee and down payment' : 'Down payment'} of <b>${peso(o.forfeited)}</b> kept: the customer did not ${o.fulfillment === 'Delivery' ? 'receive' : 'pick up'} the order.</div>`);
  if (o.hold && !o.cancelRequested && !o.awaitingPayment && !o.awaitingAdvance) out.push(`<div class="co-flag bad">${esc(o.hold)}</div>`);
  if (o.failedAttempts && !['Cancelled', 'Delivered', 'Picked Up'].includes(o.status)) out.push(`<div class="co-flag bad">${o.failedAttempts} failed ${o.fulfillment === 'Delivery' ? 'delivery attempt' : 'pickup'}${o.failedAttempts === 1 ? '' : 's'} on this order. See its history in Details.</div>`);
  if (o.creditException) out.push(`<div class="co-flag">Finance granted a credit exception: ${peso(dueOf(o))} may stay outstanding. ${esc(o.creditException.note)}</div>`);
  return out.join('');
}
function moneyFoot(o) {
  if (!isOpen(o)) return `<div class="co-total">${peso(o.total)}<span class="co-due">${esc(o.method)}</span></div>`;
  const due = dueOf(o);
  return `<div class="co-total">${peso(o.total)}<span class="co-due">${due > 0 ? peso(due) + ' still due' : 'fully paid'}${paidOf(o) && due > 0 ? ' \u00B7 ' + peso(paidOf(o)) + ' in' : ''}</span></div>`;
}
function actionButton(o) {
  if (!o.next || o.cancelRequested) return '';
  if (o.next === 'Paid' && o.awaitingPayment && o.method === 'Xendit') return `<button type="button" class="btn-primary" data-check="${esc(o.id)}">Check payment</button>`;
  // the server's money gate says this step is not allowed yet: show it, but it cannot be pressed (Collect payment comes first)
  if (o.hold) return `<button type="button" class="btn-primary" disabled title="${esc(o.hold)}">${esc(ACTION[o.next] || 'Next step')}</button>`;
  return `<button type="button" class="btn-primary" data-act="${esc(o.id)}">${esc(ACTION[o.next] || 'Next step')}</button>`;
}
// the delivery did not go through, or nobody came for the pickup: record it (try again / cancel and restock)
function failButton(o) {
  if (o.cancelRequested && o.status === 'Out for Delivery') return '';
  if (o.status === 'Out for Delivery') return `<button type="button" class="btn-secondary" data-fail="${esc(o.id)}">Not delivered…</button>`;
  if (o.status === 'Ready for Pickup') return `<button type="button" class="btn-secondary" data-fail="${esc(o.id)}">Not picked up…</button>`;
  return '';
}
const FAIL_REASONS = {
  Delivery: [['not_home', 'Nobody home to receive it'], ['refused', 'Customer refused the order or the cash payment'], ['unreachable', 'Customer could not be reached'],
    ['wrong_address', 'Wrong or incomplete address'], ['shop_issue', 'Our side: vehicle, weather or schedule'], ['other', 'Other reason']],
  Pickup: [['not_picked_up', 'Customer did not pick it up'], ['other', 'Other reason']]
};
let failFor = null, failReq = false;
function openFail(o) {
  if (busy || failReq) return;
  failFor = o; const del = o.fulfillment === 'Delivery';
  $('coAction').innerHTML = `<form class="co-sheet" id="coFailForm" novalidate>
    <h2>${del ? 'Delivery did not go through' : 'Order not picked up'}</h2><div class="co-sub">${esc(o.id)} · ${esc(o.customer)} · ${peso(o.total)}</div>
    ${fld('failReason', 'What happened?', '<select id="co_failReason"><option value="">Choose…</option>' + FAIL_REASONS[o.fulfillment].map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('') + '</select>')}
    ${del ? fld('failAction', 'What now?', `<div class="co-choice"><label><input type="radio" name="co_failAction" value="retry" checked> <span><b>Try again</b> — back to Packed, the stock stays reserved for the next run</span></label>
      <label><input type="radio" name="co_failAction" value="cancel"> <span><b>Cancel the order</b> — the stock goes back on sale${paidOf(o) ? ' and the ' + peso(paidOf(o)) + ' received is queued for refund' : ''}</span></label></div>`)
      : `<div class="co-flag">The order is cancelled and its stock goes back on sale${paidOf(o) ? '; the ' + peso(paidOf(o)) + ' received is queued for refund' : ''}.</div>`}
    ${fld('failNote', 'Note <span class="faint">(optional, required for “Other”)</span>', '<textarea id="co_failNote" rows="2" maxlength="200" placeholder="e.g. Called twice, no answer"></textarea>')}
    <p class="faint" style="font-size:12.5px;margin:6px 0 0">Reasons caused by the customer count as a missed delivery or pickup. After too many, the customer can only pay online.</p>
    <p class="co-err" id="coActErr" role="alert"></p>
    <div class="co-actions"><button type="button" class="btn-secondary" id="coCancel">Close</button><button type="submit" class="btn-primary" id="coFailGo">${del ? 'Save' : 'Cancel the order'}</button></div></form>`;
  openModal($('coAction'));
}
async function submitFail() {
  const o = failFor; if (!o || busy || failReq) return; clearErrs();
  const reason = $('co_failReason').value, note = $('co_failNote').value.trim(), pick = document.querySelector('input[name="co_failAction"]:checked');
  const action = o.fulfillment === 'Delivery' ? (pick ? pick.value : '') : 'cancel';
  let ok = true;
  if (!reason) { setErr('failReason', 'Choose what happened'); ok = false; }
  if (reason === 'other' && note.length < 5) { setErr('failNote', 'Describe what happened (at least 5 characters)'); ok = false; }
  if (!ok) return;
  const btn = $('coFailGo'); failReq = true; btn.disabled = true;
  try {
    const r = await request('/orders/' + encodeURIComponent(o.id) + '/not-completed', { method: 'POST', body: JSON.stringify({ reason, note, action }) });
    closeAction(true); await load(true);
    say(r.status === 'Packed' ? o.id + ' is back in Packed for another delivery.' : o.id + ' was cancelled and its stock returned' + (r.refundQueued ? '; the refund is queued for Finance.' : '.'));
  } catch (e) {
    Object.entries(e.fields || {}).forEach(([k, m]) => setErr(k === 'reason' ? 'failReason' : k === 'note' ? 'failNote' : k === 'action' ? 'failAction' : k, m));
    $('coActErr').textContent = e.message; btn.disabled = false;
  } finally { failReq = false; }
}
/* §4: money is collected against the order from the ledger, separately from moving the order along.
   A released order with an approved balance still takes its balance payments here. */
function payButton(o) {
  if (['Cancelled', 'Returned'].includes(o.status) || o.cancelRequested) return '';
  if (o.awaitingPayment || dueOf(o) <= 0 || o.paymentState === 'refunded') return '';
  // Pickup: only collect payment once the order has been packed and is Ready for Pickup (or already released with terms)
  if (o.fulfillment === 'Pickup' && ['Pending Confirmation', 'Paid'].includes(o.status)) return '';
  // Delivery: COD balance is collected upon delivery handover at doorstep, not before packing
  if (o.fulfillment === 'Delivery' && ['Pending Confirmation', 'Paid'].includes(o.status)) return '';
  return `<button type="button" class="btn-secondary" data-pay="${esc(o.id)}">Collect payment</button>`;
}
function render() {
  renderTabs();
  const data = visible();
  $('coList').innerHTML = data.length ? data.map((o) => {
    const items = (o.items || []).map((i) => esc(i.qty + ' \u00D7 ' + i.name)).join(', ');
    return `<article class="co-card${o.status === 'Pending Confirmation' || o.cashOnHandover ? ' attn' : ''}">
      <div class="co-card-head">
        <div><div class="co-no">${esc(o.id)}</div><div class="co-who">${esc(o.customer)} \u00B7 ${esc(o.phone || o.customerPhone || '')} \u00B7 ${esc(ago(o.createdAt))}</div></div>
        <div class="co-pills"><span class="co-pill ${statusClass(o.status)}">${esc(statusLabel(o))}</span><span class="co-pill">${esc(o.fulfillment)}</span><span class="co-pill ${o.paymentState === 'paid' ? 's-done' : o.paymentState === 'partially_paid' ? 's-active' : ''}">${esc(payLabel(o))}</span></div>
      </div>
      <div class="co-items">${items || 'No items'}</div>
      ${flagsFor(o)}
      <div class="co-foot">
        ${moneyFoot(o)}
        <div class="co-btns"><button type="button" class="btn-secondary" data-detail="${esc(o.id)}">Details</button>${failButton(o)}${payButton(o)}${actionButton(o)}</div>
      </div></article>`;
  }).join('') : `<div class="co-empty">${orders.length ? 'No orders match this view.' : 'No online orders yet.'}</div>`;
}
async function load(silent) {
  if (loading) return; loading = true;
  if (!silent) message('Loading orders\u2026');
  try {
    orders = await request('/orders');
    render();
    message(silent ? '' : orders.length + ' orders \u00B7 updated ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }));
    return true;
  } catch (e) { if (!silent) message(e.message, true); return false; }
  finally { loading = false; }
}
const byId = (id) => orders.find((x) => String(x.id) === String(id));

/* ---------- modal plumbing ---------- */
function openModal(el) { opener = document.activeElement; el.hidden = false; document.body.style.overflow = 'hidden'; const f = el.querySelector('input:not([type=checkbox]),select,textarea,button.btn-primary,button'); if (f) setTimeout(() => f.focus(), 30); }
function closeModal(el) { el.hidden = true; el.innerHTML = ''; if ($('coDetail').hidden && $('coAction').hidden) document.body.style.overflow = ''; if (opener && document.contains(opener)) opener.focus(); }
function closeAction(force = false) { if (!force && (busy || failReq)) return; chosen = null; target = ''; payFor = null; payDraft = null; closeModal($('coAction')); }
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!$('coAction').hidden) closeAction(); else if (!$('coDetail').hidden) closeModal($('coDetail')); });
['coDetail', 'coAction'].forEach((id) => $(id).addEventListener('mousedown', (e) => { if (e.target === $(id)) (id === 'coAction' ? closeAction() : closeModal($(id))); }));

/* ---------- details ---------- */
function detailHtml(o) {
  const lines = (o.items || []).map((i) => `<tr><td>${esc(i.name)}<br><small class="faint">${esc(i.sku || '')}</small></td><td class="r">${esc(i.qty)} ${esc(i.unit || '')}</td><td class="r">${peso(i.price)}</td><td class="r">${peso(i.qty * i.price)}</td></tr>`).join('');
  const ship = o.shipTo;
  const where = o.fulfillment === 'Delivery'
    ? `<p><b>${esc(o.recipient || o.customer)}</b>${o.recipientPhone ? ' \u00B7 ' + esc(o.recipientPhone) : ''}<br>${esc(ship ? [ship.addressLine, ship.barangay, ship.city, ship.province, ship.zip].filter(Boolean).join(', ') : o.address || '')}${ship && ship.landmark ? '<br><small class="faint">Landmark: ' + esc(ship.landmark) + '</small>' : ''}</p>`
    : '<p>Store pickup \u2014 the customer brings the order number and a valid ID.</p>';
  const dl = o.delivery || {};
  const dInfo = [dl.trackingNo && 'Tracking no. ' + esc(dl.trackingNo), dl.dispatchedAt && 'Out for delivery ' + esc(when(dl.dispatchedAt)), dl.deliveredAt && 'Delivered ' + esc(when(dl.deliveredAt)), o.receivedBy && 'Received by ' + esc(o.receivedBy), dl.customerReceivedAt && 'Customer confirmed receipt ' + esc(when(dl.customerReceivedAt))].filter(Boolean).join('<br>');
  const pay = [esc(o.method), STATE_LABEL[o.paymentState] || 'Unpaid', 'Total ' + peso(o.total) + ' \u00B7 in ' + peso(paidOf(o)) + ' \u00B7 outstanding ' + peso(dueOf(o)),
    o.terms ? (o.terms.key === 'full' ? 'Full Payment' : (o.terms.percent != null ? o.terms.percent + '% initial (' + peso(o.terms.amount) + ')' : peso(o.terms.amount) + ' initial') + ' \u2014 ' + esc(o.terms.condition || '')) : '',
    o.paymentRef && 'Online ref. ' + esc(o.paymentRef), o.cashTendered != null && 'Cash received ' + peso(o.cashTendered) + ' \u00B7 change ' + peso(o.cashChange || 0)].filter(Boolean).join('<br>');
  const hist = (o.history || []).map((h) => `<li><b>${esc(h.to === 'Paid' ? 'Confirmed' : h.to)}</b>${h.note ? ' \u2014 ' + esc(h.note) : ''}<small>${esc(when(h.at))} \u00B7 ${esc(h.by)}</small></li>`).join('');
  return `<div class="co-sheet wide">
    <div class="co-card-head"><div><h2 id="coDetailTitle">${esc(o.id)}</h2><div class="co-sub">${esc(o.customer)} \u00B7 placed ${esc(when(o.createdAt))}</div></div>
      <div class="co-pills"><span class="co-pill ${statusClass(o.status)}">${esc(statusLabel(o))}</span><span class="co-pill">${esc(o.fulfillment)}</span></div></div>
    ${flagsFor(o)}
    <div class="co-kpis"><div class="co-kpi"><small>Order total</small><b>${peso(o.total)}</b></div><div class="co-kpi ok"><small>Paid so far</small><b>${peso(paidOf(o))}</b></div><div class="co-kpi ${dueOf(o) > 0.004 ? 'due' : 'ok'}"><small>${dueOf(o) > 0.004 ? 'To collect' : 'Balance'}</small><b>${dueOf(o) > 0.004 ? peso(dueOf(o)) : 'Settled'}</b></div><div class="co-kpi"><small>Items</small><b>${(o.items || []).length}</b></div></div>
    <div class="co-grid">
      <div><h3>Customer</h3><p>${esc(o.customer)}<br>${o.customerPhone ? '<a href="tel:' + esc(o.customerPhone) + '">' + esc(o.customerPhone) + '</a><br>' : ''}${esc(o.customerEmail || '')}</p></div>
      <div><h3>${o.fulfillment === 'Delivery' ? 'Deliver to' : 'Pickup'}</h3>${where}</div>
      <div><h3>Payment</h3><p>${pay}</p></div>
      ${dInfo ? `<div><h3>Delivery record</h3><p>${dInfo}</p></div>` : ''}
    </div>
    <table class="co-table"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${lines}</tbody>
      <tfoot>${o.deliveryFee ? `<tr><td colspan="3" class="r">Subtotal</td><td class="r">${peso(o.subtotal)}</td></tr><tr><td colspan="3" class="r">Delivery fee</td><td class="r">${peso(o.deliveryFee)}</td></tr>` : ''}<tr><td colspan="3" class="r">Total</td><td class="r">${peso(o.total)}</td></tr></tfoot></table>
    <h3 class="co-sec">Payments received</h3>
    <div id="coLedger" class="co-sub" aria-live="polite">Loading\u2026</div>
    <h3 class="co-sec">History</h3>
    <ul class="co-line">${hist || '<li>No history yet.</li>'}</ul>
    <div class="co-actions"><button type="button" class="btn-secondary" data-slip="${esc(o.id)}">Print slip</button><button type="button" class="btn-secondary" data-close-detail>Close</button>${failButton(o)}${payButton(o)}${actionButton(o)}</div></div>`;
}
function openDetail(o) {
  if (busy || failReq) return;
  $('coDetail').innerHTML = detailHtml(o); openModal($('coDetail'));
  /* §4: the counter reads total / received / outstanding from one place — the ledger, not this page's arithmetic. */
  const box = $('coLedger');
  request('/pos/payment-ledger/order/' + encodeURIComponent(o.id))
    .then((l) => { if (box && box.isConnected) box.innerHTML = ledgerHtml(l); })
    .catch(() => { if (box && box.isConnected) box.innerHTML = '<p class="faint">The payment ledger could not be read.</p>'; });
}
function ledgerHtml(l) {
  const rows = (l.payments || []).map((p) => `<tr><td>${esc(when(p.at))}</td><td>${esc(p.receivedBy || 'System')}</td><td>${esc(p.method)}</td>
    <td>${esc(p.purpose)}${p.providerRef ? ' \u00B7 ' + esc(p.providerRef) : ''}${p.note ? '<br><small class="faint">' + esc(p.note) + '</small>' : ''}</td>
    <td class="r">${p.direction === 'out' ? '\u2212' : ''}${peso(p.amount)}</td></tr>`).join('');
  return `<table class="co-table"><thead><tr><th>When</th><th>By</th><th>Method</th><th>What</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="faint">Nothing has been paid on this order yet.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="4" class="r">Total ${peso(l.total)} \u00B7 ${STATE_LABEL[l.paymentState] || 'Unpaid'}</td><td class="r">${peso(l.paidAmount)}</td></tr>
      <tr><td colspan="4" class="r">Outstanding balance</td><td class="r">${peso(l.outstanding)}</td></tr></tfoot></table>`;
}

function printSlip(o) {
  const del = o.fulfillment === 'Delivery', ship = o.shipTo;
  const where = ship ? [ship.addressLine, ship.barangay, ship.city, ship.province, ship.zip].filter(Boolean).join(', ') : (o.address || '');
  const rows = (o.items || []).map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${esc(i.qty)} ${esc(i.unit || '')}</td><td class="r">${peso(i.price)}</td><td class="r">${peso(i.qty * i.price)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">No items on this order.</td></tr>';
  const paid = paidOf(o), due = dueOf(o);
  const tot = [['Subtotal', peso(o.subtotal != null ? o.subtotal : o.total)]]
    .concat(Number(o.deliveryFee) > 0 ? [['Delivery fee', peso(o.deliveryFee)]] : [])
    .concat([['Total', peso(o.total)]])
    .concat(paid > 0 ? [[o.advance && o.advance.paid ? 'Paid online (' + o.advance.label + ')' : 'Already paid', '\u2212' + peso(paid)]] : []);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.id)}</title><style>
    @page{size:A4;margin:14mm} html{color-scheme:light} body{font:12.5px Arial,Helvetica,sans-serif;margin:0;color:#111;background:#fff}
    .head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #1b3a5c;padding-bottom:8px}
    .co{font:700 17px Georgia,serif;letter-spacing:.5px;color:#1b3a5c} .kind{font:700 13px Arial;text-transform:uppercase;letter-spacing:1px;color:#1b3a5c}
    .meta{text-align:right;font-size:12px} .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:14px 0}
    .grid small{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#555} .grid b{font-weight:600}
    table{width:100%;border-collapse:collapse;margin:6px 0 0} th{font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;text-align:left;border-bottom:1.5px solid #1b3a5c;padding:5px 4px;color:#1b3a5c}
    td{border-bottom:1px solid #ccd3da;padding:6px 4px;vertical-align:top} .r{text-align:right;white-space:nowrap} .muted{color:#666;font-style:italic}
    .tot{margin:8px 0 0 auto;width:340px} .tot div{display:flex;justify-content:space-between;gap:12px;padding:3px 0} .tot div span:last-child{white-space:nowrap}
    .due{margin-top:6px;border:2px solid #1b3a5c;padding:8px 10px;font:700 15px Arial;display:flex;justify-content:space-between}
    .sigs{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:46px} .sig{border-top:1px solid #000;padding-top:4px;font-size:11px}
    </style></head><body>
    <div class="head"><div><div class="co">TRIPLE E METAL PRODUCTS</div><div class="kind">${del ? 'Delivery' : 'Pickup'} slip</div></div>
      <div class="meta"><b>${esc(o.id)}</b><br>${esc(when(o.createdAt))}</div></div>
    <div class="grid">
      <div><small>Customer</small><b>${esc(o.customer || '')}</b>${o.phone ? ' \u00B7 ' + esc(o.phone) : ''}</div>
      <div><small>Payment</small><b>${esc(o.method || '')}</b> \u00B7 ${esc(STATE_LABEL[o.paymentState] || 'Unpaid')}</div>
      ${del ? `<div style="grid-column:1/-1"><small>Deliver to</small><b>${esc(o.recipient || o.customer || '')}</b>${o.recipientPhone ? ' \u00B7 ' + esc(o.recipientPhone) : ''}<br>${esc(where || 'No address on record')}${ship && ship.landmark ? '<br>Landmark: ' + esc(ship.landmark) : ''}</div>` : ''}
    </div>
    <table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="tot">${tot.map((t) => `<div><span>${esc(t[0])}</span><span>${t[1]}</span></div>`).join('')}
      <div class="due"><span>${o.paymentState === 'paid' || due <= 0 ? 'PAID IN FULL' : 'TO COLLECT'}</span><span>${o.paymentState === 'paid' || due <= 0 ? '' : peso(due)}</span></div></div>
    ${o.cashTendered != null ? `<p>Cash received ${peso(o.cashTendered)} \u00B7 change ${peso(o.cashChange || 0)}</p>` : ''}
    <div class="sigs"><div class="sig">Released by (staff)</div><div class="sig">Received by (signature over printed name) / date</div></div>
    </body></html>`;
  printFrame(html, o.id);
}

/* One shared printer path: the slip and the payment invoice are both built as a document string and sent to a
   hidden iframe, so the browser print dialog is the only thing the page opens. */
function printFrame(html, label) {
  const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'; document.body.appendChild(f);
  const d = f.contentWindow.document; d.open(); d.write(html); d.close();
  // the frame is removed only after printing ends (some browsers print in the background; removing it early prints a blank page)
  const done = () => setTimeout(() => f.remove(), 500);
  try { f.contentWindow.addEventListener('afterprint', done); } catch { /* ignore */ }
  setTimeout(() => f.remove(), 60000);
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch { say('Could not open the print dialog for ' + label + '.', true); f.remove(); } }, 250);
}

/* ---------- collecting a payment (§4), reviewed before anything is written (§7) ----------
   The amounts on this sheet come from the ledger (total / already paid / outstanding), never from what the page
   assumes. One requestId is generated per payment attempt and re-used on every send, so a double click or a retry
   after a timeout adds one ledger row, not two.                                       */
// what the counter can take by hand. Xendit is never typed in here: it is confirmed by Xendit itself (Check payment).
const ONLINE_PAY = ['GCash', 'Maya', 'Bank transfer', 'Credit / debit card'];
let payFor = null, payDraft = null, payReceipt = null, payReq = '';

const moneyBox = (o) => `<div class="co-box co-grid" style="margin:0">
    <div><h3>Order total</h3><div class="big">${peso(o.total)}</div></div>
    <div><h3>Already paid</h3><div class="big">${peso(paidOf(o))}</div></div>
    <div><h3>Outstanding</h3><div class="big">${peso(dueOf(o))}</div></div></div>`;
const termsLine = (o) => (o.terms && o.terms.key !== 'full'
  ? `${esc(o.terms.key === 'custom' ? 'Custom partial payment' : o.terms.key === 'half' ? 'Half Payment' : 'Down Payment')} \u2014 ${peso(o.terms.amount)} (${o.terms.percent}%) now, ${esc(o.terms.condition || 'balance due before release')}`
  : 'Full Payment \u2014 the whole amount before the goods are released');

async function openPay(o, force = false) {
  if (!force && (busy || failReq)) return;
  payFor = o; payDraft = null; payReceipt = null; shiftOpen = null;
  payReq = 'pos-' + String(o.id).replace(/[^A-Za-z0-9]/g, '') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const due = Number(o.dueNow != null ? o.dueNow : dueOf(o));
  const bills = [...new Set([due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000])].filter((x) => x >= due).slice(0, 4);
  const quick = bills.map((b) => `<button type="button" class="btn-secondary" data-cash="${b.toFixed(2)}">${peso(b)}</button>`).join('');
  const other = dueOf(o) !== due ? `<button type="button" class="btn-secondary" data-amt="${dueOf(o).toFixed(2)}">Full balance ${peso(dueOf(o))}</button>` : '';
  const fields = fld('amount', 'Amount being paid', `<input id="co_amount" inputmode="decimal" autocomplete="off" value="${due.toFixed(2)}" maxlength="12">`,
      `Outstanding ${peso(dueOf(o))}. Quick amounts: <button type="button" class="btn-secondary" data-amt="${due.toFixed(2)}">${peso(due)}</button> ${other}`)
    + fld('method', 'Received as', `<select id="co_method">${['Cash'].concat(ONLINE_PAY).map((m) => `<option value="${esc(m)}"${m === 'Cash' ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>`)
    + `<div id="coRefBox" hidden>${fld('reference', 'Provider reference no.', '<input id="co_reference" maxlength="40" autocomplete="off" placeholder="e.g. GCASH-7788 or the bank statement no.">')}</div>`
    + `<div id="coCashBox" hidden>${fld('tendered', 'Cash handed over', '<input id="co_tendered" inputmode="decimal" autocomplete="off" placeholder="0.00">')}
        <div class="co-quick">${quick}</div><div class="co-change" id="coChange" aria-live="polite"></div><div id="coShiftWarn"></div></div>`
    + fld('note', 'Note (optional)', '<textarea id="co_note" rows="2" maxlength="200"></textarea>');
  $('coAction').innerHTML = `<form class="co-sheet" id="coPayForm" novalidate>
    <h2 id="coActionTitle">Collect a payment</h2><div class="co-sub">${esc(o.id)} \u00B7 ${esc(o.customer)} \u00B7 ${esc(o.method)}</div>
    ${moneyBox(o)}<p class="faint">${termsLine(o)}</p>${fields}
    <p class="co-err" id="coActErr" role="alert"></p>
    <div class="co-actions"><button type="button" class="btn-secondary" id="coCancel">Cancel</button><button type="submit" class="btn-primary" id="coSubmit">Review payment</button></div></form>`;
  openModal($('coAction'));
  syncPayMethod();
  const sheet = $('coPayForm');
  let open = null;
  try { open = !!(await request('/pos/cash-shifts/current')); } catch { /* unknown until retried */ }
  if (!sheet.isConnected) return;
  shiftOpen = open; syncShiftWarn();
}
function syncPayMethod() {
  const m = $('co_method') ? $('co_method').value : 'Cash';
  $('coRefBox').hidden = m === 'Cash';
  $('coCashBox').hidden = m !== 'Cash';
  syncShiftWarn();
}
function syncShiftWarn() {
  const warn = $('coShiftWarn'); if (!warn) return;
  const cash = $('co_method') && $('co_method').value === 'Cash';
  warn.innerHTML = cash && shiftOpen === false
    ? '<div class="co-flag bad" style="margin-top:10px">You have no open Cash Shift, so this cash cannot reach a drawer. <button type="button" class="btn-secondary" id="coGoShift" style="margin-top:6px">Open Cash Shift</button></div>' : '';
}
function updatePayChange() {
  const box = $('coChange'); if (!box || !payFor) return;
  const amt = parseMoney($('co_amount').value), v = parseMoney($('co_tendered').value);
  if (v === null || amt === null) { box.innerHTML = ''; return; }
  box.innerHTML = v + 1e-9 >= amt ? `Change to give: <b>${peso(Math.round((v - amt) * 100) / 100)}</b>` : `<span style="color:var(--red)">Short by <b>${peso(Math.round((amt - v) * 100) / 100)}</b></span>`;
}
function collectPay() {                        // entry step: validate and hold the draft for the review screen
  const o = payFor, body = {}; let ok = true; clearErrs();
  const bad = (n, m) => { setErr(n, m); ok = false; };
  const val = (id) => ($('co_' + id) ? $('co_' + id).value.trim() : '');
  const amt = parseMoney(val('amount'));
  if (amt === null) bad('amount', 'Enter the amount, e.g. 1500 or 1500.50');
  else if (amt <= 0) bad('amount', 'The amount must be more than zero');
  else if (amt > dueOf(o) + 0.001) bad('amount', `Only ${peso(dueOf(o))} is outstanding on this order`);
  else body.amount = amt.toFixed(2);
  const method = val('method'); if (!method) bad('method', 'Choose how the money was received');
  body.method = method; body.requestId = payReq;
  if (method !== 'Cash') { const r = val('reference'); if (!REF_RE.test(r)) bad('reference', 'Enter the reference from the app, receipt or statement (4\u201340 characters)'); body.reference = r; }
  else { const t = parseMoney(val('tendered'));
    if (t === null) bad('tendered', 'Enter the cash handed over');
    else if (amt !== null && t + 1e-9 < amt) bad('tendered', 'That is less than the amount being paid (' + peso(amt) + ')');
    else if (t > amt + 100000) bad('tendered', 'That is far above the amount. Check the cash');
    else body.tendered = t.toFixed(2);
    if (shiftOpen === false) { setErr('tendered', 'Open your Cash Shift first'); ok = false; }
  }
  const note = val('note'); if (note.length > 200) bad('note', 'The note must be 200 characters or fewer'); body.note = note;
  return ok ? body : null;
}
function reviewPay(d) {                        // §7: the figures are read back before the ledger is touched
  const o = payFor, after = Math.round((dueOf(o) - Number(d.amount)) * 100) / 100;
  const cash = d.method === 'Cash';
  $('coAction').innerHTML = `<form class="co-sheet" id="coPayForm" novalidate>
    <h2 id="coActionTitle">Confirm this payment</h2><div class="co-sub">Check it against the money in front of you before recording it</div>
    <table class="co-table"><tbody>
      <tr><td>Customer</td><td class="r">${esc(o.customer)}</td></tr>
      <tr><td>Order reference</td><td class="r">${esc(o.id)}</td></tr>
      <tr><td>Order total</td><td class="r">${peso(o.total)}</td></tr>
      <tr><td>Payment terms</td><td class="r">${termsLine(o)}</td></tr>
      <tr><td>Previously paid</td><td class="r">${peso(paidOf(o))}</td></tr>
      <tr><td><b>Amount being collected</b></td><td class="r"><b>${peso(d.amount)}</b> as ${esc(d.method)}</td></tr>
      ${cash ? `<tr><td>Cash handed over \u00B7 change</td><td class="r">${peso(d.tendered)} \u00B7 <b>${peso(Math.round((Number(d.tendered) - Number(d.amount)) * 100) / 100)}</b></td></tr>`
             : `<tr><td>Provider reference</td><td class="r">${esc(d.reference)}</td></tr>`}
      <tr><td><b>Balance after this payment</b></td><td class="r"><b>${peso(after)}</b>${after <= 0.001 ? ' \u2014 the order can be released' : ''}</td></tr>
    </tbody></table>
    <p class="faint">Recording this adds one payment to the order ledger${cash ? ' and goes into your open Cash Shift' : ' and is reconciled against the provider, not the drawer'}. It does not change the delivery status.</p>
    <p class="co-err" id="coActErr" role="alert"></p>
    <div class="co-actions"><button type="button" class="btn-secondary" id="coPayBack">Back</button><button type="submit" class="btn-primary" id="coSubmit">Confirm payment</button></div></form>`;
  $('coSubmit').focus();
}
function receiptSheet(r, o) {
  payReceipt = Object.assign({}, r, { order: o });
  $('coAction').innerHTML = `<div class="co-sheet">
    <h2 id="coActionTitle">Payment recorded</h2><div class="co-sub">${esc(o.id)} \u00B7 ${esc(o.customer)} \u00B7 invoice ${esc(r.receiptNo)}</div>
    <div class="co-box"><div class="faint">${esc(r.method)} \u00B7 ${r.purpose === 'initial' ? 'initial payment' : 'balance payment'}</div>
      <div class="big">${peso(r.amount)}</div>
      ${r.change != null ? `<div class="co-change">Give change: <b>${peso(r.change)}</b> (received ${peso(r.tendered)})</div>` : ''}
      <div class="faint">Total ${peso(r.total)} \u00B7 now in ${peso(r.paidAmount)} \u00B7 outstanding ${peso(r.balance)}</div></div>
    ${r.replayed ? '<div class="co-flag">This is the same payment sent a moment ago, so it was recorded once.</div>' : ''}
    <div class="co-actions"><button type="button" class="btn-secondary" data-payreceipt="${esc(r.paymentId)}">Print invoice</button>
      <button type="button" class="btn-secondary" id="coPayAgain">Another payment</button><button type="button" class="btn-primary" id="coDone">Done</button></div></div>`;
}
async function submitPay() {
  if (busy || failReq || !payFor) return;
  const o = payFor;
  if (!payDraft) { payDraft = collectPay(); if (!payDraft) { const f = document.querySelector('#coAction .co-fld.bad input,#coAction .co-fld.bad select'); if (f) f.focus(); return; } reviewPay(payDraft); return; }
  const btn = $('coSubmit'); busy = true; btn.disabled = true; btn.textContent = 'Saving\u2026';
  const back = $('coPayBack'); if (back) back.disabled = true;
  try {
    const r = await request('/pos/orders/' + encodeURIComponent(o.id) + '/payment', { method: 'POST', body: JSON.stringify(payDraft) });
    await load(true);
    const fresh = byId(o.id) || o;
    receiptSheet(Object.assign({ total: fresh.total, paidAmount: paidOf(fresh), balance: dueOf(fresh) }, r), fresh);
    payDraft = null;
    message('', false); say('Payment of ' + peso(r.amount) + ' recorded on ' + o.id + '.');
  } catch (err) {
    const names = Object.keys(err.fields || {});
    if (names.length) names.forEach((n) => setErr(n, err.fields[n]));
    $('coActErr').textContent = err.message;
    if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Confirm payment'; if ($('coPayBack')) $('coPayBack').disabled = false; }
    await load(true);                                          // the balance may have moved somewhere else: show the truth
    const fresh = byId(o.id);
    if (fresh && (dueOf(fresh) !== dueOf(o) || fresh.paymentState !== o.paymentState)) { payDraft = null; openPay(fresh, true); message(o.id + ': the balance changed to ' + peso(dueOf(fresh)) + ' while you were working.', true); }
  } finally { busy = false; }
}

/* ---------- print a payment invoice ---------- */
function printPaymentReceipt(r) {
  if (!r) { say('That invoice is no longer on the screen. Print it from the order details.', true); return; }
  const o = r.order || {};
  const html = `<!doctype html><html><head><title>Invoice ${esc(r.receiptNo || '')}</title><style>body{font:13px Arial,sans-serif;margin:18px;color:#000}h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:10px 0}td,th{border-bottom:1px solid #999;padding:5px 3px;text-align:left}.sig{margin-top:38px;border-top:1px solid #000;width:260px;padding-top:4px}</style></head><body>
    <h1>Triple E Metal Products \u2014 sales invoice</h1>
    <div><b>${esc(r.receiptNo || '')}</b> \u00B7 ${esc(when(Date.now()))}</div>
    <div>Order: ${esc(o.id || '')} \u00B7 Customer: ${esc(o.customer || '')}</div>
    <table><tbody>
      <tr><td>Order total</td><td style="text-align:right">${peso(r.total != null ? r.total : o.total)}</td></tr>
      <tr><td>Payment received (${esc(r.method || '')})</td><td style="text-align:right">${peso(r.amount)}</td></tr>
      ${r.tendered != null ? `<tr><td>Cash handed over</td><td style="text-align:right">${peso(r.tendered)}</td></tr><tr><td>Change given</td><td style="text-align:right">${peso(r.change || 0)}</td></tr>` : ''}
      ${r.providerRef ? `<tr><td>Provider reference</td><td style="text-align:right">${esc(r.providerRef)}</td></tr>` : ''}
      <tr><td>Total now paid</td><td style="text-align:right">${peso(r.paidAmount)}</td></tr>
      <tr><td><b>Balance still outstanding</b></td><td style="text-align:right"><b>${peso(r.balance)}</b></td></tr>
    </tbody></table>
    <div>This invoice is for one payment on the order. It is not proof that the order is fully paid \u2014 check the balance above.</div>
    <div class="sig">Cashier signature</div></body></html>`;
  printFrame(html, r.receiptNo || 'the invoice');
}

/* ---------- action dialog ---------- */
const fld = (name, label, control, hint) => `<div class="co-fld" data-fld="${name}"><label for="co_${name}">${label}</label>${control}${hint ? '<small class="faint">' + hint + '</small>' : ''}<span class="co-err" data-err="${name}" role="alert"></span></div>`;
function setErr(name, msg) {
  const box = document.querySelector(`#coAction [data-err="${name}"]`);
  if (!box) { const g = $('coActErr'); if (g) g.textContent = msg || ''; return; }
  box.textContent = msg || ''; box.closest('.co-fld').classList.toggle('bad', !!msg);
  const input = $('co_' + name); if (input) { if (!box.id) box.id = 'coError_' + name; input.setAttribute('aria-describedby', box.id); input.setAttribute('aria-invalid', String(!!msg)); }
}
function clearErrs() { document.querySelectorAll('#coAction [data-err]').forEach((x) => { x.textContent = ''; x.closest('.co-fld').classList.remove('bad'); }); $('coActErr').textContent = ''; }

function actionBody(o, t) {
  const who = o.fulfillment === 'Delivery' ? (o.recipient || o.customer) : o.customer;
  const handover = FINAL.includes(t);
  let h = '';
  if (t === 'Paid') {
    if (o.paymentState === 'paid') h += `<p>Payment is complete in the ledger (${peso(paidOf(o))} on ${peso(o.total)}). Confirming reserves the stock for this order.</p>`;
    else if (isCash(o)) h += `<p>Accepting this order reserves the stock now. <b>${peso(dueOf(o))}</b> is collected in cash when the customer ${o.fulfillment === 'Delivery' ? 'receives' : 'picks up'} it.</p>`;
    else h += `<p>The initial payment of ${peso(paidOf(o))} is in the ledger. Confirming reserves the stock for this order.</p>`;
    if (o.terms && o.terms.key !== 'full' && o.paymentState !== 'paid') h += `<div class="co-flag">This order is on a partial payment option: ${peso(o.terms.amount)} (${o.terms.percent}%) now, ${peso(dueOf(o))} later \u2014 ${esc(o.terms.condition)}.</div>`;
  } else if (t === 'Packed') {
    h += `<p>Count the items against the order.</p><ul style="margin:6px 0 0 18px">${(o.items || []).map((i) => `<li>${esc(i.qty)} ${esc(i.unit || '')} \u00D7 ${esc(i.name)}</li>`).join('')}</ul>`
      + '<label class="co-check"><input type="checkbox" id="co_checked"> I checked the items and quantities</label><div class="co-fld" data-fld="checked" style="margin:0"><span class="co-err" data-err="checked" role="alert"></span></div>';
  } else if (t === 'Ready for Pickup') {
    h += '<p>The customer is told the order is ready. They bring the order number and a valid ID.</p>';
  } else if (t === 'Out for Delivery') {
    h += `<p>The customer is told the order is on its way. A tracking number is created automatically; no rider needs to be assigned.</p><p class="faint">${esc(o.recipient || o.customer)} \u00B7 ${esc(o.recipientPhone || o.phone || '')}<br>${esc(o.address || '')}</p>`;
  } else if (handover) {
    h += fld('receivedBy', t === 'Delivered' ? 'Received by' : 'Picked up by', `<input id="co_receivedBy" maxlength="80" autocomplete="off" value="${esc(who)}">`)
      + `<label class="co-check"><input type="checkbox" id="co_rep"> Someone else is ${t === 'Delivered' ? 'receiving' : 'collecting'} it for the customer</label>`
      + `<div id="coRepBox" hidden>${fld('relationship', 'Relationship / authorisation', '<input id="co_relationship" maxlength="60" autocomplete="off" placeholder="e.g. Driver of the company, spouse, with authorisation letter">')}</div>`;
    if (t === 'Picked Up') h += `<div class="co-grid" style="margin:0">${fld('pickupIdType', 'ID presented', `<select id="co_pickupIdType"><option value="">Choose ID type</option>${ID_TYPES.map((x) => `<option>${esc(x)}</option>`).join('')}</select>`)}${fld('pickupIdLast4', 'Last 4 characters of the ID', '<input id="co_pickupIdLast4" maxlength="4" autocomplete="off" placeholder="Last 4 only">')}</div><p class="faint">Check the original ID in person. Never photograph or write down the full ID number.</p>`;
    if (o.cashOnHandover) {
      const due = dueOf(o), bills = [...new Set([due, Math.ceil(due / 100) * 100, Math.ceil(due / 500) * 500, Math.ceil(due / 1000) * 1000])].filter((x) => x >= due).slice(0, 4);
      h += `<div class="co-box"><div class="faint">Outstanding balance to collect${paidOf(o) ? ' (of ' + peso(o.total) + ', ' + peso(paidOf(o)) + ' already in)' : ''}</div><div class="big">${peso(due)}</div>
        ${fld('cashReceived', 'Cash received', '<input id="co_cashReceived" inputmode="decimal" autocomplete="off" placeholder="0.00">')}
        <div class="co-quick">${bills.map((b, i) => `<button type="button" class="btn-secondary" data-cash="${b}">${i === 0 ? 'Exact ' : ''}${peso(b)}</button>`).join('')}</div>
        <div class="co-change" id="coChange" aria-live="polite"></div><div id="coShiftWarn"></div></div>`;
    }
  }
  return h + fld('note', 'Note (optional)', '<textarea id="co_note" rows="2" maxlength="200"></textarea>');
}
let actReq = '';
async function openAction(o) {
  if (busy || failReq) return;
  chosen = o; target = o.next; shiftOpen = null; actReq = '';
  const t = target;
  $('coAction').innerHTML = `<form class="co-sheet" id="coForm" novalidate>
    <h2 id="coActionTitle">${esc(ACTION[t] || 'Next step')}</h2><div class="co-sub">${esc(o.id)} \u00B7 ${esc(o.customer)} \u00B7 ${peso(o.total)}</div>
    ${actionBody(o, t)}<p class="co-err" id="coActErr" role="alert"></p>
    <div class="co-actions"><button type="button" class="btn-secondary" id="coCancel">Cancel</button><button type="submit" class="btn-primary" id="coSubmit">${esc(ACTION[t] || 'Confirm')}</button></div></form>`;
  openModal($('coAction'));
  if (FINAL.includes(t) && o.cashOnHandover) {          // cash must land in an open Cash Shift
    const sheet = $('coForm');
    let open = null;
    try { open = !!(await request('/pos/cash-shifts/current')); } catch { /* unknown until retried */ }
    if (!sheet.isConnected) return;
    shiftOpen = open;
    if (shiftOpen === false && $('coShiftWarn')) {
      $('coShiftWarn').innerHTML = '<div class="co-flag bad" style="margin-top:10px">You have no open Cash Shift. Open one first so this cash is counted in your drawer. <button type="button" class="btn-secondary" id="coGoShift" style="margin-top:6px">Open Cash Shift</button></div>';
      $('coSubmit').disabled = true;
    }
  }
}
function updateChange() {
  const box = $('coChange'); if (!box || !chosen) return;
  const v = parseMoney($('co_cashReceived').value), due = dueOf(chosen);
  if (v === null) { box.innerHTML = ''; return; }
  box.innerHTML = v + 1e-9 >= due ? `Change to give: <b>${peso(Math.round((v - due) * 100) / 100)}</b>` : `<span style="color:var(--red)">Short by <b>${peso(Math.round((due - v) * 100) / 100)}</b></span>`;
}

function collect() {                    // reads + validates the form; returns the request body or null
  const o = chosen, t = target, body = {}; let ok = true; clearErrs();
  const bad = (n, m) => { setErr(n, m); ok = false; };
  const val = (id) => ($('co_' + id) ? $('co_' + id).value.trim() : '');
  const note = val('note'); if (note.length > 200) bad('note', 'The note must be 200 characters or fewer'); body.note = note;
  if (t !== 'Paid') {
    body.status = t;
    if (t === 'Packed' && !$('co_checked').checked) bad('checked', 'Tick the box once you have counted the items');
    if (FINAL.includes(t)) {
      const name = val('receivedBy'), rep = $('co_rep').checked;
      if (!NAME_RE.test(name)) bad('receivedBy', 'Enter the full name (2\u201380 letters, no numbers)');
      body.receivedBy = name;
      if (rep) { const rel = val('relationship'); if (rel.length < 3 || rel.length > 60) bad('relationship', 'Enter how this person is related or authorised (3\u201360 characters)'); body.representative = true; body.relationship = rel; }
      if (t === 'Picked Up') {
        const type = val('pickupIdType'), last4 = val('pickupIdLast4');
        if (!ID_TYPES.includes(type)) bad('pickupIdType', 'Choose the ID that was presented');
        if (!/^[A-Za-z0-9]{4}$/.test(last4)) bad('pickupIdLast4', 'Enter exactly 4 letters or numbers');
        body.pickupIdType = type; body.pickupIdLast4 = last4;
      }
      if (o.cashOnHandover) {
        const cash = parseMoney(val('cashReceived')), due = dueOf(o);
        if (cash === null) bad('cashReceived', 'Enter the cash received, e.g. 1500 or 1500.50');
        else if (cash + 1e-9 < due) bad('cashReceived', 'Less than the outstanding balance (' + peso(due) + ')');
        else if (cash > due + 100000) bad('cashReceived', 'That is far above the balance. Check the amount');
        else body.cashReceived = cash;
        if (shiftOpen === false) { $('coActErr').textContent = 'Open your Cash Shift first.'; ok = false; }
      }
    }
  }
  return ok ? body : null;
}
async function submit(e) {
  e.preventDefault(); if (busy || failReq || !chosen) return;
  const body = collect(); if (!body) { const first = document.querySelector('#coAction .co-fld.bad input,#coAction .co-fld.bad select'); if (first) first.focus(); return; }
  const o = chosen, t = target, btn = $('coSubmit'); busy = true; btn.disabled = true; btn.textContent = 'Saving\u2026';
  if (body.cashReceived != null) body.requestId = actReq || (actReq = 'pos-' + String(o.id).replace(/[^A-Za-z0-9]/g, '') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  try {
    const res = await request('/orders/' + encodeURIComponent(o.id) + (t === 'Paid' ? '/confirm' : '/status'), { method: 'POST', body: JSON.stringify(body) });
    await load(true);
    if (res && res.receiptNo) {                                   // cash handover: the ledger row this move just created
      $('coAction').innerHTML = `<div class="co-sheet"><h2 id="coActionTitle">${esc(t === 'Delivered' ? 'Delivered' : 'Released')} \u2014 payment recorded</h2><div class="co-sub">${esc(o.id)} \u00B7 invoice ${esc(res.receiptNo)} \u00B7 in your Cash Shift</div>
        <div class="co-box"><div class="faint">Cash received ${peso(res.tendered)} \u00B7 applied to the order ${peso(res.amount)}</div>
          <div class="co-change" style="font-size:16px">Give change: <b style="font-size:26px">${peso(res.change)}</b></div>
          <div class="faint">Order total ${peso(o.total)} \u00B7 now in ${peso(res.paidAmount)} \u00B7 outstanding ${peso(res.balance)}</div></div>
        <div class="co-actions"><button type="button" class="btn-secondary" data-payreceipt="${esc(res.paymentId)}">Print invoice</button><button type="button" class="btn-primary" id="coDone">Done</button></div></div>`;
      payReceipt = Object.assign({ order: o }, res);
      render(); return;
    }
    closeAction(true); message('', false); say(o.id + ': ' + (t === 'Paid' ? 'order confirmed' : t === 'Picked Up' ? 'released to the customer' : t === 'Delivered' ? 'marked delivered' : 'marked ' + t.toLowerCase()) + '.');
  } catch (err) {
    const names = Object.keys(err.fields || {});
    if (names.length) names.forEach((n) => setErr(n, err.fields[n])); else $('coActErr').textContent = err.message;
    if (err.fields && err.fields.status === undefined && !names.length) { /* plain error already shown */ }
    await load(true);                                                      // someone else may have changed the order: show the truth
    const fresh = byId(o.id);
    if (fresh && fresh.status !== o.status) { closeAction(true); message(o.id + ' changed in the meantime: ' + err.message, true); }
    else if (btn.isConnected) { btn.disabled = shiftOpen === false; btn.textContent = ACTION[t] || 'Confirm'; }
  } finally { busy = false; if ($('coSubmit') && !$('coSubmit').disabled) $('coSubmit').textContent = ACTION[target] || 'Confirm'; }
}
async function checkPayment(id, btn) {
  if (busy || failReq) return; busy = true; const old = btn.textContent; btn.disabled = true; btn.textContent = 'Checking\u2026';
  try {
    const r = await request('/orders/' + encodeURIComponent(id) + '/check-payment', { method: 'POST', body: '{}' });
    await load(true);
    say(r.paymentStatus === 'paid' ? id + ': payment received, order confirmed.' : id + ': not paid yet.', r.paymentStatus !== 'paid');
  } catch (e) { message(e.message, true); say(e.message, true); }
  finally { busy = false; if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

/* ---------- events ---------- */
$('coTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; render(); } });
document.addEventListener('click', (e) => {
  const t = e.target; if (!t.closest || ((busy || failReq) && t.closest('#coAction'))) return;
  const detail = t.closest('[data-detail]'), act = t.closest('[data-act]'), chk = t.closest('[data-check]'), slip = t.closest('[data-slip]'), cash = t.closest('[data-cash]'), pay = t.closest('[data-pay]'), amt = t.closest('[data-amt]');
  if (detail && $('coList').contains(detail)) { const o = byId(detail.dataset.detail); if (o) openDetail(o); }
  else if (act && (act.closest('#coList') || act.closest('#coDetail'))) { const o = byId(act.dataset.act); if (o) { closeModal($('coDetail')); openAction(o); } }
  else if (pay && (pay.closest('#coList') || pay.closest('#coDetail'))) { const o = byId(pay.dataset.pay); if (o) { closeModal($('coDetail')); openPay(o); } }
  else if (chk && (chk.closest('#coList') || chk.closest('#coDetail'))) checkPayment(chk.dataset.check, chk);
  else if (t.closest('[data-fail]') && (t.closest('#coList') || t.closest('#coDetail'))) { const o = byId(t.closest('[data-fail]').dataset.fail); if (o) { closeModal($('coDetail')); openFail(o); } }
  else if (slip) { const o = byId(slip.dataset.slip); if (o) printSlip(o); }
  else if (t.closest('[data-payreceipt]')) printPaymentReceipt(payReceipt);
  else if (cash && $('coAction').contains(cash)) { const f = $('co_cashReceived') || $('co_tendered'); if (f) { f.value = cash.dataset.cash; ($('co_cashReceived') ? updateChange : updatePayChange)(); } }
  else if (amt && $('coAction').contains(amt)) { $('co_amount').value = amt.dataset.amt; setErr('amount', ''); updatePayChange(); }
  else if (t.closest('[data-close-detail]')) closeModal($('coDetail'));
  else if (t.id === 'coPayBack') { const d = payDraft; openPay(payFor); if (d) { ['amount', 'method', 'reference', 'tendered', 'note'].forEach((k) => { if ($('co_' + k) && d[k] != null) $('co_' + k).value = d[k]; }); syncPayMethod(); } }
  else if (t.id === 'coPayAgain') { const fresh = byId(payFor && payFor.id) || payFor; if (fresh) openPay(fresh); }
  else if (t.id === 'coCancel') closeAction();
  else if (t.id === 'coDone') closeAction();
  else if (t.id === 'coGoShift') { closeAction(); if (typeof showPage === 'function') showPage('shift'); }
});
$('coAction').addEventListener('submit', (e) => { if (e.target.id === 'coForm') submit(e); else if (e.target.id === 'coPayForm') { e.preventDefault(); submitPay(); } else if (e.target.id === 'coFailForm') { e.preventDefault(); submitFail(); } });
$('coAction').addEventListener('input', (e) => {
  if (e.target.id === 'co_cashReceived') updateChange();
  if (e.target.id === 'co_amount' || e.target.id === 'co_tendered') updatePayChange();
  liveActionField(e.target);
});
function liveActionField(input) {
  const field = input?.closest?.('.co-fld')?.dataset.fld; if (!field) return;
  const v = input.value.trim(), n = parseMoney(v); let message = '';
  if (!input.disabled && input.getClientRects().length) {
    if (field === 'amount') message = n === null || n <= 0 ? 'Enter an amount greater than zero, with at most 2 decimals.' : payFor && n > dueOf(payFor) + 0.001 ? 'Only ' + peso(dueOf(payFor)) + ' is outstanding on this order.' : '';
    if (field === 'tendered' || field === 'cashReceived') {
      const due = field === 'tendered' ? parseMoney($('co_amount')?.value || '') : chosen ? dueOf(chosen) : null;
      message = n === null ? 'Enter the cash handed over.' : due !== null && n + 1e-9 < due ? 'That is less than the amount due (' + peso(due) + ').' : due !== null && n > due + 100000 ? 'That is far above the amount. Check the cash.' : '';
    }
    if (field === 'reference') message = REF_RE.test(v) ? '' : 'Enter the reference from the app, receipt or statement (4–40 characters).';
    if (field === 'receivedBy') message = NAME_RE.test(v) ? '' : 'Enter the full name (2–80 letters, no numbers).';
    if (field === 'relationship') message = v.length >= 3 && v.length <= 60 ? '' : 'Enter how this person is related or authorised (3–60 characters).';
    if (field === 'pickupIdType') message = ID_TYPES.includes(v) ? '' : 'Choose the ID that was presented.';
    if (field === 'pickupIdLast4') message = /^[A-Za-z0-9]{4}$/.test(v) ? '' : 'Enter exactly 4 letters or numbers.';
    if (field === 'failReason') message = v ? '' : 'Choose what happened.';
    if (field === 'failNote') message = $('co_failReason')?.value === 'other' && v.length < 5 ? 'Describe what happened (at least 5 characters).' : '';
    if (field === 'note' && v.length > 200) message = 'The note must be 200 characters or fewer.';
  }
  setErr(field, message);
  if (field === 'amount' && $('co_tendered')?.value) liveActionField($('co_tendered'));
}
$('coAction').addEventListener('focusout', e => liveActionField(e.target));
$('coAction').addEventListener('change', (e) => {
  liveActionField(e.target);
  if (e.target.id === 'co_failReason' && $('co_failNote')) liveActionField($('co_failNote'));
  if (e.target.id === 'co_method') { syncPayMethod(); ['co_reference','co_tendered'].forEach(id => liveActionField($(id))); return; }
  if (e.target.id !== 'co_rep' || !chosen) return;                         // "someone else is collecting": the name must be typed fresh
  $('coRepBox').hidden = !e.target.checked;
  const n = $('co_receivedBy'); n.value = e.target.checked ? '' : (chosen.fulfillment === 'Delivery' ? (chosen.recipient || chosen.customer) : chosen.customer);
  if (e.target.checked) n.focus();
  liveActionField($('co_relationship')); liveActionField(n);
});
$('coSearch').addEventListener('input', render); $('coFilter').addEventListener('change', render); $('coRefresh').addEventListener('click', () => load(false));

window.cashierOrdersLoad = () => load(false);
load(true);                                                                // fills the "To confirm" badge in the menu right away
setInterval(() => { if (!document.hidden && $('coDetail').hidden && $('coAction').hidden && !busy && !failReq) load(true); }, 45000);
})();
