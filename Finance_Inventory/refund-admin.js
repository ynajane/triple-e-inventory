/* refund-admin.js — Finance Admin: review customer refund requests.
   Adds a "Refund Requests" panel to the top of the Online Orders page and a small counter on the
   "Online Orders" menu item. Works next to either sales script (sales-orders.js or sales-admin.js) because it only
   needs the #orders section.  Load it last in Finance_Inventory.html:
       <script src="refund-admin.js?v=1"></script>
   Server routes: GET /api/refund-requests · POST /api/orders/:no/refund-decision
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  var TZ = 'Asia/Manila';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (ms) { return new Date(ms).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };

  var list = [], openId = null, busy = false, loading = false, built = false;

  /* ---------------- helpers ---------------- */
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
  var pending = function () { return list.filter(function (r) { return r.status === 'pending'; }); };
  var pill = function (st) {
    var cls = st === 'approved' ? 'in' : st === 'rejected' ? 'out' : 'low';
    var label = st === 'approved' ? 'Approved' : st === 'rejected' ? 'Declined' : 'Pending';
    return '<span class="status-pill ' + cls + '">' + label + '</span>';
  };

  /* ---------------- styles (only what Finance's own CSS does not have) ---------------- */
  function addStyles() {
    var css =
      '.ra-panel{margin-bottom:18px}' +
      '.ra-badge{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:var(--red);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}' +
      '.ra-modal{max-width:640px;width:100%;max-height:92vh;overflow-y:auto}' +
      '.ra-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding-right:34px}' +
      '.ra-head h2{margin:0;font-size:22px}' +
      '.ra-info{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:0 0 14px}' +
      '.ra-info dt{font-size:12.5px;color:var(--text-faint);margin:0}.ra-info dd{margin:2px 0 0;font-size:15px;overflow-wrap:anywhere}' +
      '.ra-box{margin:0 0 14px;padding:11px 13px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:14.5px;overflow-wrap:anywhere}' +
      '.ra-box b{display:block;margin-bottom:3px}' +
      '.ra-items{width:100%;min-width:0;table-layout:fixed;border-collapse:collapse;margin:0 0 14px;font-size:14px}.ra-items th,.ra-items td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}.ra-items .r{text-align:right}.ra-items th:nth-child(1){width:50%}.ra-items th:nth-child(2){width:22%}.ra-items th:nth-child(3){width:28%}' +
      '.ra-form label{display:block;font-size:13.5px;font-weight:600;color:var(--text-dim);margin:12px 0 6px}' +
      '.ra-form .form-input{width:100%;box-sizing:border-box}' +
      '.ra-form textarea{min-height:70px;resize:vertical}' +
      '.ra-form label.ra-check{display:flex;gap:10px;align-items:flex-start;margin-top:12px;font-size:14.5px;font-weight:500;color:var(--text);cursor:pointer}.ra-check input{margin-top:3px;width:auto;flex:none}' +
      '.ra-err{display:none;margin-top:10px;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.ra-err.show{display:block}' +
      '.ra-fe{font-size:12.5px;color:var(--red);margin-top:4px}' +
      '.ra-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}' +
      '.ra-empty{padding:22px;text-align:center;color:var(--text-faint)}' +
      '@media(max-width:560px){.ra-info{grid-template-columns:1fr}}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------- panel on the Sales page ---------------- */
  function build() {
    var section = $('orders');
    if (!section || built) return;
    built = true;
    var panel = document.createElement('div');
    panel.className = 'panel ra-panel';
    panel.id = 'raPanel';
    panel.innerHTML =
      '<div class="panel-head"><div><div class="panel-title">Refund Requests</div><div class="panel-sub" id="raSub">Loading\u2026</div></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Order</th><th>Customer</th><th>Reason</th><th>Refund</th><th>Requested</th><th>Status</th><th></th></tr></thead>' +
      '<tbody id="raBody"></tbody></table></div>';
    var header = section.querySelector('.catalog-header');
    if (header && header.nextSibling) section.insertBefore(panel, header.nextSibling); else section.insertBefore(panel, section.firstChild);
    $('raBody').addEventListener('click', function (e) {
      var b = e.target.closest('[data-ra]'); if (b) openModal(b.dataset.ra);
    });
  }

  function render() {
    if (!built) return;
    var n = pending().length;
    $('raSub').textContent = list.length
      ? (n ? n + ' waiting for your decision' : 'Nothing waiting \u2014 all requests have been answered') + ' \u00B7 ' + list.length + ' in total'
      : 'Customers can ask for a refund after an order is delivered or picked up. Their requests appear here.';
    $('raBody').innerHTML = list.length ? list.map(function (r) {
      return '<tr><td>' + esc(r.orderNo) + '</td><td>' + esc(r.customer) + '<div class="faint" style="font-size:12px">' + esc(r.phone) + '</div></td>' +
        '<td>' + esc(r.reasonLabel) + '</td><td>' + peso(r.amount) + '</td><td>' + esc(when(r.requestedAt)) + '</td><td>' + pill(r.status) + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="' + (r.status === 'pending' ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-ra="' + r.id + '">' + (r.status === 'pending' ? 'Review' : 'View') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="ra-empty">No refund requests yet.</td></tr>';
    paintBadge();
  }

  function paintBadge() {
    var nav = document.querySelector('.nav-item[data-page="orders"]');
    if (!nav) return;
    var n = pending().length, b = nav.querySelector('.ra-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'ra-badge'; nav.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.title = n + ' refund request(s) waiting';
  }

  /* ---------------- data ---------------- */
  async function load() {
    if (loading) return;
    loading = true;
    try {
      list = await api('/refund-requests');
      if (!Array.isArray(list)) list = [];
      if (!openId || !busy) render();
      if (openId && !busy) paintModal();
    } catch (e) {
      if (e.message === 'Not signed in') return;
      if (built && !list.length) $('raSub').textContent = 'Could not load refund requests: ' + e.message;
    } finally { loading = false; }
  }

  /* ---------------- review dialog ---------------- */
  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'raOverlay';
    overlay.innerHTML = '<div class="account-modal ra-modal" role="dialog" aria-modal="true" aria-labelledby="raTitle"><button type="button" class="modal-close" id="raClose" aria-label="Close">\u00D7</button><div id="raModalBody"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !busy) closeModal(); });
    $('raClose').addEventListener('click', function () { if (!busy) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && openId && !busy) closeModal(); });
    return overlay;
  }
  function closeModal() { openId = null; if (overlay) overlay.classList.remove('open'); }
  function openModal(id) { openId = Number(id); paintModal(); ensureOverlay().classList.add('open'); }
  var byId = function (id) { return list.find(function (r) { return r.id === id; }); };
  var info = function (label, value) { return value ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : ''; };

  function paintModal() {
    var r = byId(openId);
    ensureOverlay();
    if (!r) { closeModal(); return; }
    var h = '<div class="ra-head"><h2 id="raTitle">Refund \u00B7 ' + esc(r.orderNo) + '</h2>' + pill(r.status) + '</div>' +
      '<dl class="ra-info">' + info('Customer', r.customer) + info('Phone', r.phone) + info('Order type', r.fulfillment) + info('Paid with', r.method) +
      info('Order total', peso(r.orderTotal)) + info('Requested', when(r.requestedAt)) + '</dl>' +
      '<div class="ra-box"><b>' + esc(r.reasonLabel) + '</b>' + esc(r.details) + '</div>' +
      '<table class="ra-items"><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Amount</th></tr></thead><tbody>' +
      r.items.map(function (i) { return '<tr><td>' + esc(i.name) + '<div class="faint" style="font-size:12px">' + esc(i.sku) + '</div></td><td class="r">' + i.qty + ' ' + esc(i.unit) + '</td><td class="r">' + peso(i.qty * i.price) + '</td></tr>'; }).join('') +
      '</tbody></table>';

    if (r.status === 'pending') {
      h += '<div class="ra-form">' +
        '<label for="raAmount">Refund amount (\u20B1)</label><input type="text" data-money class="form-input" id="raAmount" inputmode="decimal" value="' + MoneyInput.fmt(r.amount) + '" autocomplete="off">' +
        '<div class="ra-fe" id="raAmountErr"></div>' +
        '<label class="ra-check"><input type="checkbox" id="raRestock"><span>The goods came back in good condition \u2014 put them back in stock</span></label>' +
        '<label for="raNote">Note to the customer <span class="faint" style="font-weight:400">(required when declining)</span></label>' +
        '<textarea id="raNote" class="form-input" maxlength="300" placeholder="e.g. Refund will be sent to your e-wallet within 3 working days"></textarea>' +
        '<div class="ra-fe" id="raNoteErr"></div>' +
        '<div class="ra-err" id="raErr" role="alert"></div>' +
        '<div class="ra-actions"><button type="button" class="btn-primary" id="raApprove">Approve refund</button>' +
        '<button type="button" class="btn-danger" id="raReject">Decline request</button></div></div>';
    } else {
      h += '<div class="ra-box"><b>' + (r.status === 'approved' ? 'Approved \u2014 ' + peso(r.amount) : 'Declined') + '</b>' +
        (r.decidedBy ? 'By ' + esc(r.decidedBy) + (r.decidedAt ? ' \u00B7 ' + esc(when(r.decidedAt)) : '') : '') +
        (r.status === 'approved' ? '<br>' + (r.restocked ? 'The items were put back in stock.' : 'The items were not put back in stock.') : '') +
        (r.decisionNote ? '<br>Note: ' + esc(r.decisionNote) : '') + '</div>';
    }
    $('raModalBody').innerHTML = h;
    var ap = $('raApprove'), rj = $('raReject');
    if (ap) ap.addEventListener('click', function () { decide(r, true); });
    if (rj) rj.addEventListener('click', function () { decide(r, false); });
    if (ap && window.FormAssist) {
      FormAssist.validation.bind($('raAmount'), function (value) {
        var amount = MoneyInput.parse(value);
        return !Number.isFinite(amount) || amount <= 0 || amount > r.orderTotal ? 'Enter an amount between ' + peso(0.01) + ' and ' + peso(r.orderTotal) : '';
      }, $('raAmountErr'));
      FormAssist.validation.bind($('raNote'), function (value) {
        return $('raNote').dataset.declining && value.trim().length < 5 ? 'Tell the customer why (at least 5 characters)' : '';
      }, $('raNoteErr'));
    }
  }

  function showErr(msg) { var b = $('raErr'); if (b) { b.textContent = msg; b.classList.add('show'); } }

  async function decide(r, approve) {
    if (busy) return;
    var amountEl = $('raAmount'), noteEl = $('raNote');
    $('raAmountErr').textContent = ''; $('raNoteErr').textContent = ''; $('raErr').classList.remove('show');
    if (approve) delete noteEl.dataset.declining; else noteEl.dataset.declining = '1';
    var note = noteEl.value.trim(), amount = MoneyInput.parse(amountEl.value);
    if (approve && (!Number.isFinite(amount) || amount <= 0 || amount > r.orderTotal)) { $('raAmountErr').textContent = 'Enter an amount between ' + peso(0.01) + ' and ' + peso(r.orderTotal); amountEl.focus(); return; }
    if (!approve && note.length < 5) { $('raNoteErr').textContent = 'Tell the customer why (at least 5 characters)'; noteEl.focus(); return; }
    var text = approve
      ? 'Approve a refund of ' + peso(amount) + ' for ' + r.orderNo + '? This cannot be undone.'
      : 'Decline the refund request for ' + r.orderNo + '? The customer will see your note.';
    if (!window.confirm(text)) return;
    var keep = { amount: amountEl.value, note: noteEl.value, restock: $('raRestock').checked };
    busy = true;
    overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      await api('/orders/' + encodeURIComponent(r.orderNo) + '/refund-decision', { method: 'POST', body: JSON.stringify({
        approve: approve, note: note, amount: approve ? Number(amount.toFixed(2)) : undefined, restock: approve && $('raRestock').checked }) });
      toast(approve ? 'Refund approved for ' + r.orderNo + '. Return ' + peso(amount) + ' to the customer.' : 'Refund request declined.');
      busy = false;
      await load();
    } catch (e) {
      if (e.message === 'Not signed in') return;
      busy = false;
      await load();
      if (openId) { paintModal(); var f = e.fields || {};
        if ($('raAmount')) { $('raAmount').value = keep.amount; $('raNote').value = keep.note; $('raRestock').checked = keep.restock; }
        if (f.amount && $('raAmountErr')) $('raAmountErr').textContent = f.amount;
        if (f.note && $('raNoteErr')) $('raNoteErr').textContent = f.note;
        showErr(e.message); }
    } finally { busy = false; }
  }

  /* ---------------- start ---------------- */
  function start() {
    if (!$('orders')) return;
    addStyles();
    build();
    load();
    var section = $('orders');
    new MutationObserver(function () { if (section.classList.contains('active-page')) load(); }).observe(section, { attributes: true, attributeFilter: ['class'] });
    var refreshBtn = null;  // refresh buttons are wired in sales-orders.js
    setInterval(function () { if (!document.hidden && !busy && !openId) load(); }, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !openId) load(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
