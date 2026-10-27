/* pos-customer-account.js — "Customer account" card on the counter sale.
   Type (or paste) the customer's phone number and the cashier sees, before taking payment:
     • what the customer still owes (part-paid orders and accepted quotations), with due dates
     • how much they have paid to date and how many orders they have
     • the payment terms the shop currently offers
   Read-only. Data: GET /api/pos/customer-account?phone=…  (balance-reminders.js). Nothing is posted from here. */
(function () {
  'use strict';
  var host = document.getElementById('acctHost'), phoneEl = document.getElementById('custPhone');
  if (!host || !phoneEl) return;

  var money = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var dayFmt = function (t) { return new Date(t).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }); };
  var TERM_SHORT = { full: 'Full', half: 'Half', down: 'Down', custom: 'Custom' };
  var timer = null, seq = 0, last = '', data = null;

  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }

  function dueChip(i) {
    if (i.creditException) return '<span class="acct-chip info">Credit exception</span>';
    if (i.overdueDays > 0) return '<span class="acct-chip bad">Overdue ' + i.overdueDays + 'd</span>';
    if (i.daysLeft != null && i.daysLeft <= 0) return '<span class="acct-chip bad">Due today</span>';
    if (i.daysLeft != null) return '<span class="acct-chip ' + (i.daysLeft <= 2 ? 'warn' : 'ok') + '">Due ' + dayFmt(i.dueAt) + ' \u00B7 ' + i.daysLeft + 'd left</span>';
    return '<span class="acct-chip">No due date yet</span>';
  }

  function itemRow(i) {
    var pct = i.total > 0 ? Math.max(4, Math.min(100, Math.round(i.paid / i.total * 100))) : 0;
    var term = i.termsKey && i.termsKey !== 'full'
      ? '<span class="acct-chip">' + esc(TERM_SHORT[i.termsKey] || 'Part') + (i.termsPercent ? ' ' + i.termsPercent + '%' : '') + '</span>' : '';
    var go = i.kind === 'order'
      ? '<button type="button" class="acct-go" data-acct-order="' + esc(i.no) + '">Collect \u203A</button>'
      : '<button type="button" class="acct-go" data-acct-quote="1">Open quotes \u203A</button>';
    return '<div class="acct-item' + (i.overdueDays > 0 ? ' is-late' : '') + '">' +
      '<div class="acct-item-top"><div><b class="mono">' + esc(i.no) + '</b><span class="acct-kind">' + (i.kind === 'quote' ? 'Quotation' : esc(i.status || 'Order')) + '</span></div>' +
      '<b class="mono acct-bal">' + money(i.balance) + '</b></div>' +
      '<div class="acct-bar" title="Paid ' + money(i.paid) + ' of ' + money(i.total) + '"><i style="width:' + pct + '%"></i></div>' +
      '<div class="acct-item-foot"><span class="faint">' + money(i.paid) + ' of ' + money(i.total) + ' paid</span>' +
      '<span class="acct-tags">' + term + dueChip(i) + go + '</span></div></div>';
  }

  function termsRow(terms) {
    if (!terms || !terms.length) return '';
    return '<div class="acct-terms"><span class="acct-terms-lbl">Terms offered</span>' + terms.map(function (t) {
      return '<span class="acct-chip" title="' + esc(t.condition || '') + '">' + esc(TERM_SHORT[t.key] || t.label) + (t.percent ? ' ' + t.percent + '%' : '') + '</span>';
    }).join('') + '</div>';
  }

  function render(d) {
    if (!d || !d.found) {
      host.innerHTML = '<div class="acct acct-new"><div class="acct-avatar">+</div><div><b>New customer</b><div class="faint">No account, order or open balance for this number. Counter sales are paid in full.</div></div></div>';
      host.hidden = false; return;
    }
    var c = d.customer, name = c ? c.name : 'Walk-in customer', owes = d.owed > 0.004;
    var state = !owes ? 'clear' : d.overdue ? 'late' : 'owes';
    var head = '<div class="acct-head"><div class="acct-avatar">' + esc(initials(name)) + '</div>' +
      '<div class="acct-who"><b>' + esc(name) + '</b><div class="faint">' + (c ? 'Registered account' + (c.since ? ' \u00B7 since ' + new Date(c.since).getFullYear() : '') : 'Known walk-in number') + '</div></div>' +
      '<span class="acct-chip ' + (state === 'clear' ? 'ok' : state === 'late' ? 'bad' : 'warn') + '">' + (state === 'clear' ? 'Account clear' : state === 'late' ? 'Overdue balance' : 'Balance due') + '</span></div>';
    var kpis = '<div class="acct-kpis">' +
      '<div class="acct-kpi ' + state + '"><small>Outstanding</small><b class="mono">' + money(d.owed) + '</b></div>' +
      '<div class="acct-kpi"><small>Paid to date</small><b class="mono">' + money(d.paidToDate) + '</b></div>' +
      '<div class="acct-kpi"><small>Orders</small><b class="mono">' + (d.orders || 0) + '</b></div></div>';
    var list = d.items && d.items.length ? '<div class="acct-list">' + d.items.map(itemRow).join('') + '</div>' : '';
    var warn = owes ? '<div class="acct-note ' + (state === 'late' ? 'bad' : 'warn') + '">This customer still owes ' + money(d.owed) +
      '. This sale is paid in full now; the old balance is collected from <b>Online Orders</b> (it does not change this total).</div>' : '';
    host.innerHTML = '<div class="acct ' + state + '">' + head + kpis + warn + list + termsRow(d.terms) + '</div>';
    host.hidden = false;
  }

  function load(phone) {
    var my = ++seq;
    host.hidden = false;
    host.innerHTML = '<div class="acct acct-loading"><i></i><i></i><i></i></div>';
    fetch('/api/pos/customer-account?phone=' + encodeURIComponent(phone), { credentials: 'same-origin' })
      .then(function (r) { if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('auth'); } return r.ok ? r.json() : null; })
      .then(function (d) { if (my !== seq) return; data = d; if (d) render(d); else { host.hidden = true; } })
      .catch(function () { if (my === seq) host.hidden = true; });   // preview mode / offline: the card simply stays hidden
  }

  function onPhone() {
    clearTimeout(timer);
    var digits = phoneEl.value.replace(/\D/g, '');
    if (digits.length < 10) { seq++; last = ''; data = null; host.hidden = true; host.innerHTML = ''; return; }
    var key = digits.slice(-10);
    if (key === last && data) return;
    last = key;
    timer = setTimeout(function () { load(key); }, 350);
  }

  host.addEventListener('click', function (e) {
    var o = e.target.closest('[data-acct-order]'), q = e.target.closest('[data-acct-quote]');
    if (o && typeof showPage === 'function') {
      showPage('orders');
      var s = document.getElementById('coSearch');
      if (s) { s.value = o.getAttribute('data-acct-order'); s.dispatchEvent(new Event('input', { bubbles: true })); }
    } else if (q && typeof showPage === 'function') showPage('quotes');
  });

  phoneEl.addEventListener('input', onPhone);
  phoneEl.addEventListener('change', onPhone);
  // a finished sale clears the customer boxes: hide the card with them
  document.addEventListener('click', function (e) {
    if (e.target.closest('#complete, #clear, #holdOk')) setTimeout(function () { if (!phoneEl.value.trim()) onPhone(); }, 400);
  });
  window.PosAccount = { state: function () { return data; }, reload: function () { last = ''; onPhone(); } };
  onPhone();
})();
