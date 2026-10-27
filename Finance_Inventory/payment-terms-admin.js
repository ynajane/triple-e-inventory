/* payment-terms-admin.js — Finance: the payment-terms screen (§9).
   Four things the specification makes Finance own, on one page:
     • which payment terms exist and may be offered at all, and for which kind of order;
     • the partial term a cashier proposed on a quotation, which only becomes real when Finance signs it;
     • who owes money right now, order by order and quotation by quotation;
     • every payment and every refund the ledger holds, with the drawer each cash payment went into.
   Every amount is read from the backend ledger — this file never works one out. No browser dialogs are used: the
   errors come back from the server and are shown against the row they belong to.
   Server routes (backend/payment-terms.js, backend/shop-extras.js):
     GET  /api/finance/payment-terms · POST /api/finance/payment-terms/:key
     GET  /api/finance/quotes        · POST /api/finance/quotes/:no/terms
     GET  /api/finance/receivables   · GET  /api/finance/payments?kind=order|quote                  */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (ms) { return ms ? new Date(ms).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };

  var POLICY = [], QUOTES = [], DEBT = null, MONEY = null, LEDGER_READY = true, busy = false;

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields || {} });
    return data;
  }
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  /* ---------------- the page ---------------- */
  var PANELS = [
    ['ptrPolicy', 'Payment terms on offer',
     'Changes save by themselves. Switch a term on to offer it; set an automatic limit and part-payments up to it are approved without you. Payments already recorded are not affected.',
     '<th style="min-width:160px">Term</th><th style="width:190px">Pay now</th><th style="width:160px">Allowed for</th><th style="width:200px">Balance due</th><th style="width:230px">Approval</th><th style="width:220px">Status</th>'],
    ['ptrDebt', 'Balances outstanding',
     'Orders and quotations with money still owed.',
     '<th>Reference</th><th>Customer</th><th>Payment option</th><th class="mono">Value</th><th class="mono">Collected</th><th class="mono">Outstanding</th><th>Payment state</th><th>Exception</th>'],
    ['ptrMoney', 'Payments and refunds',
     'Newest first. Drawer cash and online payments are kept apart.',
     '<th>When</th><th>Against</th><th class="mono">Amount</th><th>How</th><th>Reference / drawer</th><th>Recorded by</th><th>Note</th>']
  ];

  (function styles() {
    var st = document.createElement('style');
    st.textContent = '#payment-terms input:not([type=checkbox]):not([type=hidden]),#payment-terms select{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 9px;font:inherit;font-size:13px;min-height:34px;max-width:100%}'
      + '#payment-terms input:focus,#payment-terms select:focus{outline:none;border-color:var(--blue-bright);box-shadow:0 0 0 3px rgba(74,144,217,.18)}'
      + '#payment-terms input[type=checkbox]{accent-color:var(--blue-bright);width:16px;height:16px;vertical-align:-3px;margin-right:6px}'
      + '#payment-terms td{vertical-align:top;padding-top:14px;padding-bottom:14px}#payment-terms td label{line-height:1.9}'
      + '#payment-terms .faint{color:var(--text-faint);font-size:12.5px;line-height:1.5}#payment-terms select[data-f=balanceCondition]{width:100%}';
    document.head.appendChild(st);
  })();
  function panelHtml(p) {
    var isPolicy = p[0] === 'ptrPolicy', clickable = p[0] === 'ptrDebt' || p[0] === 'ptrMoney';
    return '<div class="panel" id="' + p[0] + 'Box" style="margin-bottom:18px">'
      + '<div class="panel-head"><div><div class="panel-title">' + (isPolicy ? 'Automated Payment Terms Policy' : p[1]) + '</div>'
      + '<div class="panel-sub">' + (isPolicy ? 'The policy engine enforces these rules automatically for cashiers and online checkouts. No manual calculation required.' : p[2]) + '</div></div>'
      + '<div class="inv-filters">'
      + (isPolicy ? '<button type="button" class="btn-secondary btn-sm" id="ptrTogglePolicyEdit">Configure Parameters</button> ' : '')
      + '<button type="button" class="btn-secondary btn-sm" data-reload="' + p[0] + '">Reload</button></div></div>'
      + '<div class="faint" id="' + p[0] + 'Status" data-status="' + p[0] + '" style="padding:8px 16px 0;min-height:18px"></div>'
      + (isPolicy ? '<div id="ptrPolicyCards" class="policy-cards-grid"></div>' : '')
      + '<div class="table-wrapper' + (clickable ? ' ptr-clickable' : '') + '" id="' + p[0] + 'TableWrapper"' + (isPolicy ? ' hidden' : '') + '><table><thead><tr>' + p[3] + '</tr></thead>'
      + '<tbody id="' + p[0] + 'Body"><tr><td class="faint">Loading\u2026</td></tr></tbody></table></div></div>';
  }
  (function moreStyles() {
    var st = document.createElement('style');
    st.textContent = '#payments td{vertical-align:top;padding-top:14px;padding-bottom:14px}#payments .faint{color:var(--text-faint);font-size:12.5px;line-height:1.5}'
      + '.ptr-clickable tbody tr.ptr-row{cursor:pointer;transition:background .12s}.ptr-clickable tbody tr.ptr-row:hover,.ptr-clickable tbody tr.ptr-row:focus-visible{background:rgba(74,144,217,.10);outline:none}'
      + '.ptr-clickable tbody tr.ptr-row:focus-visible{box-shadow:inset 3px 0 0 var(--blue-bright)}'
      + '.ptr-modal{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px}.ptr-modal[hidden]{display:none}'
      + '.ptr-modal-bg{position:absolute;inset:0;background:rgba(5,12,20,.62);backdrop-filter:blur(5px)}'
      + '.ptr-modal-card{position:relative;width:min(640px,100%);max-height:90vh;overflow:auto;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:20px;padding:28px 30px 24px;box-shadow:0 40px 80px -30px rgba(0,0,0,.65)}'
      + '.ptr-x{position:absolute;top:14px;right:14px;width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:22px;line-height:1;cursor:pointer}.ptr-x:hover{border-color:var(--blue-bright)}'
      + '.ptr-eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--blue-bright);margin-bottom:6px;padding-right:44px}'
      + '.ptr-modal-card h2{font-family:Oswald,sans-serif;font-weight:600;font-size:30px;line-height:1.2;margin:0 0 4px}'
      + '.ptr-modal-card h3{font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-weight:500;letter-spacing:1.4px;text-transform:uppercase;color:var(--text-faint);margin:22px 0 10px}'
      + '.ptr-money{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}'
      + '.ptr-money>div{padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--inset)}.ptr-money span{display:block;font-size:12px;color:var(--text-faint);margin-bottom:4px}'
      + '.ptr-money b{font-size:17px}.ptr-money .owe{border-color:rgba(217,164,65,.45)}.ptr-money .owe b{color:var(--amber,#d9a441)}'
      + '.ptr-bar{height:8px;border-radius:99px;background:var(--border);overflow:hidden;margin-top:12px}.ptr-bar i{display:block;height:100%;background:var(--green,#43c47a);border-radius:99px}'
      + '.ptr-kvs{display:grid;gap:0;border:1px solid var(--border);border-radius:12px;overflow:hidden}'
      + '.ptr-kv{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:14px}.ptr-kv:last-child{border-bottom:0}'
      + '.ptr-kv span{color:var(--text-dim)}.ptr-kv b{font-weight:600;overflow-wrap:anywhere}'
      + '.ptr-hist{border:1px solid var(--border);border-radius:12px;overflow:auto}.ptr-hist table{width:100%;border-collapse:collapse;font-size:13.5px}'
      + '.ptr-hist th{text-align:left;padding:8px 12px;font-size:11.5px;letter-spacing:1px;text-transform:uppercase;color:var(--text-faint);background:var(--inset)}.ptr-hist td{padding:9px 12px;border-top:1px solid var(--border);vertical-align:top}'
      + '.ptr-hist tr.here td{background:rgba(74,144,217,.10)}'
      + '.ptr-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:24px}'
      + '@media(max-width:560px){.ptr-modal-card{padding:22px 18px 18px;border-radius:18px}.ptr-money{grid-template-columns:1fr}.ptr-kv{grid-template-columns:1fr;gap:2px}}';
    document.head.appendChild(st);
  })();
  function build() {
    var host = $('payment-terms');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';
    // Balances outstanding and Payments and refunds are money-in-motion, not policy: they live in their own Sales section
    // (#payments). If an older page has no such section they stay here, so nothing is ever lost.
    var payHost = $('payments') || host;
    var policyPanels = PANELS.filter(function (p) { return p[0] === 'ptrPolicy'; }), moneyPanels = PANELS.filter(function (p) { return p[0] !== 'ptrPolicy'; });
    host.innerHTML = '<div class="catalog-header"><div><div class="catalog-eyebrow">Sales &amp; Transactions</div><h1 class="catalog-title">Payment &amp; Fulfillment Policies</h1>'
      + '<div class="panel-sub">Automated part-payment terms, cash on delivery thresholds, regional delivery rates, and weight surcharges.</div></div>'
      + '<button type="button" class="btn-secondary btn-sm" data-reload="all">Reload</button></div>'
      + policyPanels.map(panelHtml).join('')
      + (payHost === host ? moneyPanels.map(panelHtml).join('') : '');
    if (payHost !== host) {
      payHost.innerHTML = '<div class="catalog-header"><div><div class="catalog-eyebrow">Sales &amp; Transactions</div><h1 class="catalog-title">Payments &amp; Balances</h1>'
        + '<div class="panel-sub">Who still owes money, and every payment and refund on the ledger. Click any row to see its full details.</div></div>'
        + '<button type="button" class="btn-secondary btn-sm" data-reload="all">Reload</button></div>'
        + moneyPanels.map(panelHtml).join('');
      payHost.dataset.built = '1';
    }
    // cash on delivery / pickup rules sit right under the terms they go with
    var pol = $('ptrPolicyBox'); if (pol) pol.insertAdjacentHTML('afterend', codPanel());

    var btnPol = $('ptrTogglePolicyEdit');
    if (btnPol) {
      btnPol.addEventListener('click', function () {
        var cards = $('ptrPolicyCards'), tbl = $('ptrPolicyTableWrapper');
        if (!cards || !tbl) return;
        var showEdit = tbl.hidden;
        tbl.hidden = !showEdit;
        cards.hidden = showEdit;
        btnPol.textContent = showEdit ? 'View Active Policies' : 'Configure Parameters';
      });
    }

    var btnCod = $('ptrToggleCodEdit');
    if (btnCod) {
      btnCod.addEventListener('click', function () {
        var cards = $('ptrCodCards'), inputs = $('ptrCodInputs');
        if (!cards || !inputs) return;
        var showEdit = inputs.hidden;
        inputs.hidden = !showEdit;
        cards.hidden = showEdit;
        btnCod.textContent = showEdit ? 'View Active Policies' : 'Configure Parameters';
      });
    }
  }

  /* ---------------- cash on delivery / pickup rules (order_rules) ---------------- */
  var RULES = null;
  function codPanel() {
    var f = function (id, label, hint, attrs) {
      return '<div style="flex:1 1 200px;min-width:180px;display:flex;flex-direction:column"><label for="' + id + '" style="display:flex;align-items:flex-end;min-height:40px;margin-bottom:6px">' + label + '</label>'
        + '<input id="' + id + '" class="mono" inputmode="numeric" autocomplete="off" ' + attrs + ' style="width:100%">'
        + '<div class="faint" style="margin-top:5px">' + hint + '</div><div class="faint" data-coderr="' + id + '" role="alert" style="color:var(--red,#c0392b)"></div></div>';
    };
    return '<div class="panel" id="ptrCodBox" style="margin-bottom:18px">'
      + '<div class="panel-head"><div><div class="panel-title">Automated Cash on Delivery &amp; Pickup Policies</div>'
      + '<div class="panel-sub">Real-time checkout safeguards. Orders exceeding limits or high-risk accounts are automatically guided to secure online payment.</div></div>'
      + '<div class="inv-filters"><button type="button" class="btn-secondary btn-sm" id="ptrToggleCodEdit">Configure Parameters</button></div></div>'
      + '<div id="ptrCodCards" class="policy-cards-grid"></div>'
      + '<div id="ptrCodInputs" hidden>'
      + '<div style="display:flex;gap:18px;flex-wrap:wrap;padding:4px 16px 0">'
      + f('codLimit', 'Cash on delivery limit (\u20B1)', 'Bigger delivery orders must be paid online. 0 = no limit.', 'placeholder="10000"')
      + f('codShows', 'Missed deliveries or pickups before cash is blocked', 'The customer can then only pay online. 0 = never block.', 'placeholder="2"')
      + f('codHold', 'Days to hold a paid-online pickup', 'Not collected by then: cancelled, restocked and refunded (reminder 2 days before).', 'placeholder="7"')
      + '</div><div style="display:flex;gap:18px;flex-wrap:wrap;padding:14px 16px 0">'
      + f('copDeposit', 'Cash on pickup down payment (\u20B1)', 'Paid online to reserve the items; taken off the total. 0 = no down payment (pay everything at the counter).', 'placeholder="200"')
      + f('copHours', 'Hours to hold a cash-on-pickup order', 'Counted from \u201CReady for pickup\u201D. Not picked up by then: cancelled, restocked, and the down payment is kept.', 'placeholder="48"')
      + f('codDeposit', 'Cash on delivery down payment (\u20B1)', 'Paid online together with the delivery fee; taken off what the rider collects. 0 = delivery fee only.', 'placeholder="200"')
      + '</div><div style="display:flex;gap:12px;align-items:center;padding:14px 16px 16px"><button type="button" class="btn-primary btn-sm" data-cod-save>Save rules</button>'
      + '<span class="faint" id="codStatus"></span></div>'
      + '</div></div>';
  }
  function renderCod() {
    if (!RULES) return;
    var cards = $('ptrCodCards');
    if (cards) {
      cards.innerHTML = '<div class="policy-card">'
        + '<div class="policy-card-head">'
        + '<div><div class="policy-card-title">Cash on Delivery (COD)</div><div class="faint">Delivery fulfillment safeguard</div></div>'
        + '<span class="status-pill in">Active Policy</span>'
        + '</div>'
        + '<div class="policy-card-rule">Customer pays online reservation deposit + delivery fee; courier collects remaining cash on turnover.</div>'
        + '<div class="policy-card-metrics">'
        + '<div><div class="policy-metric-label">Maximum Order Limit</div><div class="policy-metric-val">' + (Number(RULES.codLimit) > 0 ? peso(RULES.codLimit) : 'No limit') + '</div></div>'
        + '<div><div class="policy-metric-label">Online Deposit Required</div><div class="policy-metric-val">' + (Number(RULES.codDeposit) > 0 ? peso(RULES.codDeposit) + ' + fee' : 'Delivery fee only') + '</div></div>'
        + '<div><div class="policy-metric-label">Abuse Safeguard</div><div class="policy-metric-val">' + (Number(RULES.maxNoShows) > 0 ? 'Blocked after ' + RULES.maxNoShows + ' no-shows' : 'Never blocked') + '</div></div>'
        + '<div><div class="policy-metric-label">Checkout Behavior</div><div class="policy-metric-val">Auto-locks when exceeding limit</div></div>'
        + '</div>'
        + '</div>'
        + '<div class="policy-card">'
        + '<div class="policy-card-head">'
        + '<div><div class="policy-card-title">Cash on Counter Pickup</div><div class="faint">In-store pickup safeguard</div></div>'
        + '<span class="status-pill in">Active Policy</span>'
        + '</div>'
        + '<div class="policy-card-rule">Customer reserves online with initial deposit; balance paid in cash or card at counter checkout.</div>'
        + '<div class="policy-card-metrics">'
        + '<div><div class="policy-metric-label">Reservation Deposit</div><div class="policy-metric-val">' + (Number(RULES.copDeposit) > 0 ? peso(RULES.copDeposit) : 'Pay at counter') + '</div></div>'
        + '<div><div class="policy-metric-label">Unpaid Hold Window</div><div class="policy-metric-val">' + (Number(RULES.copHoldHours) || 48) + ' hours from Ready status</div></div>'
        + '<div><div class="policy-metric-label">Prepaid Hold Window</div><div class="policy-metric-val">' + (Number(RULES.pickupHoldDays) || 7) + ' days before restock</div></div>'
        + '<div><div class="policy-metric-label">No-Show Ruling</div><div class="policy-metric-val">Stock auto-released to inventory</div></div>'
        + '</div>'
        + '</div>'
        + '<div class="policy-card">'
        + '<div class="policy-card-head">'
        + '<div><div class="policy-card-title">Policy Engine Ruling</div><div class="faint">System automation status</div></div>'
        + '<span class="status-pill ok">Automated</span>'
        + '</div>'
        + '<div class="policy-card-rule">Checkout dynamically evaluates user credit standing, order value, and item availability in real time.</div>'
        + '<div class="policy-card-metrics">'
        + '<div><div class="policy-metric-label">Risk Evaluation</div><div class="policy-metric-val">Instant verification</div></div>'
        + '<div><div class="policy-metric-label">Manual Calculation</div><div class="policy-metric-val">0 manual steps</div></div>'
        + '<div><div class="policy-metric-label">Audit Log Tracking</div><div class="policy-metric-val">Enforced &amp; logged</div></div>'
        + '<div><div class="policy-metric-label">Last Policy Update</div><div class="policy-metric-val">' + (RULES.updatedBy ? esc(RULES.updatedBy) : 'System defaults') + '</div></div>'
        + '</div>'
        + '</div>';
    }

    if ($('codLimit')) {
      $('codLimit').value = RULES.codLimit; $('codShows').value = RULES.maxNoShows; $('codHold').value = RULES.pickupHoldDays;
      $('copDeposit').value = RULES.copDeposit != null ? RULES.copDeposit : 200; $('copHours').value = RULES.copHoldHours != null ? RULES.copHoldHours : 48;
      $('codDeposit').value = RULES.codDeposit != null ? RULES.codDeposit : 200;
      if (window.FormAssist) {
        var rules = {
          codLimit: function (v) { return /^\d{1,9}(\.\d{1,2})?$/.test(v.replace(/[,₱\s]/g, '')) ? '' : 'Enter the limit in pesos, e.g. 10000 (0 = no limit)'; },
          codShows: function (v) { return Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10 ? '' : 'Enter a whole number from 0 (off) to 10'; },
          codHold: function (v) { return Number.isInteger(Number(v)) && Number(v) >= 2 && Number(v) <= 60 ? '' : 'Enter a whole number of days from 2 to 60'; },
          copHours: function (v) { return Number.isInteger(Number(v)) && Number(v) >= 6 && Number(v) <= 336 ? '' : 'Enter a whole number of hours from 6 to 336'; }
        };
        ['copDeposit', 'codDeposit'].forEach(function (id) { rules[id] = function (v) {
          var raw = v.replace(/[,₱\s]/g, '');
          return /^\d{1,6}(\.\d{1,2})?$/.test(raw) && Number(raw) <= 100000 ? '' : 'Enter the down payment in pesos, from 0 to 100,000';
        }; });
        Object.keys(rules).forEach(function (id) {
          FormAssist.validation.bind($(id), rules[id], document.querySelector('[data-coderr="' + id + '"]'));
          FormAssist.validation.show($(id), '');
        });
      }
      $('codStatus').textContent = RULES.updatedBy ? 'Last changed by ' + RULES.updatedBy + ' \u00B7 ' + when(RULES.updatedAt) : 'Default rules (not changed yet)';
    }
  }
  async function saveCod(btn) {
    document.querySelectorAll('[data-coderr]').forEach(function (x) { x.textContent = ''; });
    var body = { codLimit: $('codLimit').value.trim(), maxNoShows: Number($('codShows').value), pickupHoldDays: Number($('codHold').value),
      copDeposit: $('copDeposit').value.trim(), copHoldHours: Number($('copHours').value), codDeposit: $('codDeposit').value.trim() };
    btn.disabled = true;
    try { RULES = await api('/finance/order-rules', { method: 'PUT', body: JSON.stringify(body) }); renderCod(); toast('Cash rules saved.'); }
    catch (e) {
      if (e.message === 'Not signed in') return;
      var map = { codLimit: 'codLimit', maxNoShows: 'codShows', pickupHoldDays: 'codHold', copDeposit: 'copDeposit', copHoldHours: 'copHours', codDeposit: 'codDeposit' }, shown = false;
      Object.keys(e.fields || {}).forEach(function (k) { var el = document.querySelector('[data-coderr="' + (map[k] || k) + '"]'); if (el) { el.textContent = e.fields[k]; shown = true; } });
      if (!shown) toast(e.message, true);
    } finally { btn.disabled = false; }
  }

  /* ---------------- the policy table ---------------- */
  // when the rest is paid: a moment in the order flow the system enforces (never a free-typed promise)
  var BALANCE_DUE = [['balance due before release', 'Before pickup / delivery'], ['balance due before production starts', 'Before production starts']];
  var STATE_PILL = { unpaid: ['unpaid', 'Not paid'], partially_paid: ['low', 'Partly paid'], paid: ['in', 'Paid'],
    refunded: ['out', 'Refunded'], partially_refunded: ['watch', 'Partly refunded'] };

  function policyRow(t) {
    var lock = t.key === 'full';
    return '<tr data-term="' + esc(t.key) + '">'
      + '<td><b>' + esc(t.label) + '</b><div class="faint">' + (lock ? 'Default for every order' : 'Hidden until switched on') + '</div></td>'
      + '<td>' + (lock ? '<span class="mono">100% of the order</span>'
        : '<label class="faint" style="display:block">Basis</label>'
          + '<select data-f="basis"><option value="percent"' + (t.basis === 'fixed' ? '' : ' selected') + '>Percentage</option>'
          + '<option value="fixed"' + (t.basis === 'fixed' ? ' selected' : '') + '>Fixed amount</option></select>'
          // only the box that matches the basis is shown
          + '<div data-basis="percent" style="margin-top:6px"' + (t.basis === 'fixed' ? ' hidden' : '') + '><input data-f="percent" class="mono" inputmode="decimal" placeholder="50" aria-label="percentage" value="' + (t.percent == null ? '' : esc(t.percent)) + '" style="width:80px"> %</div>'
          + '<div data-basis="fixed" style="margin-top:6px"' + (t.basis === 'fixed' ? '' : ' hidden') + '>\u20B1 <input data-f="fixedAmount" class="mono" inputmode="decimal" placeholder="5000" aria-label="fixed amount" value="' + (t.fixedAmount == null ? '' : esc(t.fixedAmount)) + '" style="width:110px"></div>') + '</td>'
      + '<td>' + (lock ? '<label><input type="checkbox" data-f="retailAllowed" checked disabled> Ready stock</label>'
        : '<label style="display:block"><input type="checkbox" data-f="retailAllowed"' + (t.retailAllowed ? ' checked' : '') + '> Ready stock</label>'
          + '<label style="display:block"><input type="checkbox" data-f="madeToOrderAllowed"' + (t.madeToOrderAllowed ? ' checked' : '') + '> Made-to-order</label>') + '</td>'
      + '<td>' + (lock ? '<span class="faint">Nothing further</span><input type="hidden" data-f="balanceCondition" value="nothing further to pay">'
        : '<select data-f="balanceCondition" aria-label="when the balance is due">' + BALANCE_DUE.map(function (c) {
            return '<option value="' + esc(c[0]) + '"' + (c[0] === t.balanceCondition ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('')
          + (BALANCE_DUE.some(function (c) { return c[0] === t.balanceCondition; }) || !t.balanceCondition ? '' : '<option selected value="' + esc(t.balanceCondition) + '">' + esc(t.balanceCondition) + '</option>') + '</select>') + '</td>'
      // automation: up to this total the system signs a cashier's part-payment itself (empty = Finance approves each one)
      + '<td>' + (lock ? '<span class="faint">No approval needed</span>'
        : '<label class="faint" style="display:block">Approve automatically up to</label>'
          + '\u20B1 <input data-f="autoApproveLimit" class="mono" inputmode="decimal" placeholder="e.g. 50000" aria-label="approve automatically up to" value="' + (t.autoApproveLimit == null ? '' : esc(t.autoApproveLimit)) + '" style="width:120px">'
          + '<div class="faint" data-auto-hint>' + autoHint(t) + '</div>') + '</td>'
      + '<td><label><input type="checkbox" data-f="enabled"' + (lock ? ' checked disabled' : (t.enabled ? ' checked' : '')) + '> Offer this term</label>'
        + '<div class="faint" data-on-hint>' + onHint(t) + '</div>'
        + '<div class="faint" data-saved aria-live="polite" style="margin-top:6px"></div>'
        + '<div class="faint" data-err role="alert" style="color:var(--red,#c0392b);margin-top:6px"></div></td>'
      + '</tr>';
  }
  function autoHint(t) {
    return t.autoApproveLimit ? 'Up to ' + peso(t.autoApproveLimit) + ' the system approves it, when the customer owes nothing elsewhere. Above that it comes to you.'
      : 'Empty: every ' + esc(t.label || t.key) + ' comes to you to approve.';
  }
  function onHint(t) {
    return t.key === 'full' ? 'Always on' : t.enabled ? 'On since ' + esc(when(t.enabledAt)) + ' \u00B7 ' + esc(t.enabledBy || 'Finance') : 'Off';
  }

  function policyCard(t) {
    var lock = t.key === 'full';
    var payNowText = lock ? '100% of order total' : (t.basis === 'fixed' ? peso(t.fixedAmount) + ' fixed down payment' : (t.percent || 50) + '% of order total');
    var scopeText = lock ? 'Ready stock & Custom projects' : [t.retailAllowed ? 'Ready stock' : '', t.madeToOrderAllowed ? 'Made-to-order' : ''].filter(Boolean).join(' and ') || 'Disabled';
    var balanceText = lock ? 'Settled upfront (no remainder)' : (t.balanceCondition || 'Before pickup / delivery');
    var approvalText = lock ? 'Instant automated clearance' : (t.autoApproveLimit ? 'Auto-approved up to ' + peso(t.autoApproveLimit) + ' (above routes to Finance)' : 'Requires Finance approval');
    var statusClass = (lock || t.enabled) ? 'in' : 'low';
    var statusLabel = lock ? 'Active · Default' : (t.enabled ? 'Active · Auto-enforced' : 'Disabled');

    return '<div class="policy-card">'
      + '<div class="policy-card-head">'
      + '<div><div class="policy-card-title">' + esc(t.label) + '</div>'
      + '<div class="faint">' + (lock ? 'Standard payment ruling' : 'Configured part-payment policy') + '</div></div>'
      + '<span class="status-pill ' + statusClass + '">' + statusLabel + '</span>'
      + '</div>'
      + '<div class="policy-card-rule">'
      + (lock ? 'Default policy for transactions. Customers pay in full at checkout or cashier counter.'
        : 'Automated installment policy. Cashier can propose this schedule and the system validates limits instantly.')
      + '</div>'
      + '<div class="policy-card-metrics">'
      + '<div><div class="policy-metric-label">Upfront Requirement</div><div class="policy-metric-val">' + esc(payNowText) + '</div></div>'
      + '<div><div class="policy-metric-label">Applicable Orders</div><div class="policy-metric-val">' + esc(scopeText) + '</div></div>'
      + '<div><div class="policy-metric-label">Balance Due</div><div class="policy-metric-val">' + esc(balanceText) + '</div></div>'
      + '<div><div class="policy-metric-label">Automation Ruling</div><div class="policy-metric-val">' + esc(approvalText) + '</div></div>'
      + '</div>'
      + '</div>';
  }

  function renderPolicy() {
    var body = $('ptrPolicyBody');
    var cards = $('ptrPolicyCards');
    if (!body) return;
    renderPolicyStatus();
    body.innerHTML = POLICY.map(policyRow).join('');
    if (cards) cards.innerHTML = POLICY.map(policyCard).join('');
    if (window.FormAssist) document.querySelectorAll('[data-term] input[data-f]').forEach(function (input) {
      var field = input.dataset.f;
      if (['percent', 'fixedAmount', 'autoApproveLimit'].indexOf(field) < 0) return;
      FormAssist.validation.bind(input, function (value) {
        var raw = value.replace(field === 'percent' ? /[,\s%]/g : /[,₱\s]/g, '');
        if (field === 'autoApproveLimit' && (raw === '' || /^0+(\.0+)?$/.test(raw))) return '';
        if (field === 'percent') return /^\d{1,3}(\.\d{1,2})?$/.test(raw) && Number(raw) > 0 && Number(raw) < 100 ? '' : 'Enter a percentage greater than 0 and less than 100.';
        return /^\d{1,9}(\.\d{1,2})?$/.test(raw) && Number(raw) > 0 ? '' : 'Enter an amount greater than zero, with at most 2 decimal places.';
      });
    });
  }
  function renderPolicyStatus() {
    var offered = POLICY.filter(function (t) { return t.enabled && (t.key === 'full' || t.retailAllowed || t.madeToOrderAllowed); });
    $('ptrPolicyStatus').innerHTML = POLICY.length
      + ' term(s) on file \u00B7 offered now: ' + (offered.map(function (t) { return esc(t.label); }).join(', ') || 'none')
      + (LEDGER_READY ? '' : ' \u00B7 <b style="color:var(--red,#c0392b)">the payment ledger is not active in this database. Run backend/db/020_payment_terms.sql before relying on any balance below.</b>');
  }

  /* ---------------- proposals waiting for Finance ---------------- */
  function proposedRows() {
    return (QUOTES || []).filter(function (q) { return q.terms && q.terms.state === 'proposed'; });
  }
  function renderProposed() {
    var body = $('ptrProposedBody'), rows = proposedRows();
    if (!body) return;
    $('ptrProposedStatus').textContent = rows.length
      ? rows.length + ' waiting'
      : 'Nothing waiting.';
    if (!rows.length) { body.innerHTML = '<tr><td class="faint" colspan="6">No quotation has proposed a partial payment.</td></tr>'; return; }
    body.innerHTML = rows.map(function (q) {
      var t = q.terms;
      return '<tr data-quote="' + esc(q.id) + '">'
        + '<td><b>' + esc(q.id) + '</b><div class="faint">' + esc(q.product || 'Custom item') + ' \u00B7 qty ' + esc(q.quantity || '') + '</div>'
        + '<div class="faint">sent by ' + esc(q.handledBy || 'the cashier') + '</div></td>'
        + '<td>' + esc(q.customer || '\u2014') + '</td>'
        + '<td class="mono">' + peso(q.quotedAmount == null ? t.total : q.quotedAmount) + '</td>'
        + '<td>' + esc(t.percent) + '% now = <span class="mono">' + peso(t.amount) + '</span>'
        + '<div class="faint"><span class="mono">' + peso(t.balance) + '</span> later</div></td>'
        + '<td>' + esc(t.condition || '\u2014') + '<div class="faint">' + esc(t.availability || '') + '</div></td>'
        + '<td><input data-f="note" maxlength="300" aria-label="note for the record" placeholder="note for the record" style="width:100%">'
        + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">'
        + '<button type="button" class="btn-primary btn-sm" data-approve>Approve these terms</button>'
        + '<button type="button" class="btn-secondary btn-sm" data-refuse>Refuse \u2192 full payment</button></div>'
        + '<div class="faint" data-err role="alert" style="color:var(--red,#c0392b);margin-top:6px"></div></td></tr>';
    }).join('');
  }

  /* ---------------- who owes money ---------------- */
  function debtRow(x) {
    var pill = STATE_PILL[x.paymentState] || ['low', x.paymentState];
    var term = x.termsKey === 'full' ? 'Full payment' : x.termsKey + (x.termsPercent == null ? '' : ' \u00B7 ' + x.termsPercent + '%');
    return '<tr class="ptr-row" tabindex="0" role="button" data-debt="' + esc(x.kind + ':' + x.no) + '" title="Click for details">'
      + '<td><b>' + esc(x.no) + '</b><div class="faint">' + (x.kind === 'quote' ? 'Quotation' : 'Order') + ' \u00B7 ' + esc(x.status || '') + '</div></td>'
      + '<td>' + esc(x.customer || '\u2014') + '</td>'
      + '<td>' + esc(term) + '<div class="faint">' + esc(x.termsCondition || '') + '</div></td>'
      + '<td class="mono">' + peso(x.total) + '</td><td class="mono">' + peso(x.paidAmount) + '</td>'
      + '<td class="mono"><b>' + peso(x.outstanding) + '</b></td>'
      + '<td><span class="status-pill ' + pill[0] + '">' + esc(pill[1]) + '</span>' + (x.method ? '<div class="faint">' + esc(x.method) + '</div>' : '') + '</td>'
      + '<td>' + (x.creditException ? '<span class="chip-pill warn">exception on file</span><div class="faint">' + esc(x.creditException.note) + '</div>' : '\u2014') + '</td></tr>';
  }
  function renderDebt() {
    var body = $('ptrDebtBody');
    if (!body) return;
    if (!DEBT) { body.innerHTML = '<tr><td class="faint" colspan="8">Loading\u2026</td></tr>'; return; }
    var t = DEBT.totals;
    $('ptrDebtStatus').innerHTML = 'Orders ' + t.openOrders + ' \u00B7 ' + peso(t.ordersOwed)
      + ' \u00B7 quotations ' + t.openQuotes + ' \u00B7 ' + peso(t.quotesOwed)
      + ' \u00B7 <b>total still to collect ' + peso(t.allOwed) + '</b>';
    var rows = DEBT.orders.concat(DEBT.quotes).sort(function (a, b) { return b.outstanding - a.outstanding; });
    if (!rows.length) { body.innerHTML = '<tr><td class="faint" colspan="8">Nothing is owed. Every order and quotation with money on it has been fully collected.</td></tr>'; return; }
    body.innerHTML = rows.map(debtRow).join('');
  }

  /* ---------------- the ledger ---------------- */
  function moneyRow(p) {
    return '<tr class="ptr-row" tabindex="0" role="button" data-pay="' + esc(p.id) + '" title="Click for details">'
      + '<td class="faint">' + esc(when(p.at)) + '</td>'
      + '<td><b>' + esc(p.ref || '') + '</b><div class="faint">' + (p.kind === 'quote' ? 'Quotation' : 'Order') + '</div></td>'
      + '<td class="mono"' + (p.direction === 'out' ? ' style="color:var(--red,#c0392b)"' : '') + '>'
      + (p.direction === 'out' ? '\u2212' : '+') + peso(p.amount) + '</td>'
      + '<td>' + esc(p.method) + '<div class="faint">' + esc(p.purpose || '') + '</div></td>'
      + '<td class="faint">' + esc(p.providerRef || (p.cashShiftId != null ? 'drawer #' + p.cashShiftId : '\u2014')) + '</td>'
      + '<td>' + esc(p.actor || 'system') + '</td>'
      + '<td class="faint">' + esc(p.note || '') + (p.reversedOf ? ' reverses payment #' + esc(p.reversedOf) : '') + '</td></tr>';
  }
  function renderMoney() {
    var body = $('ptrMoneyBody');
    if (!body) return;
    if (!MONEY) { body.innerHTML = '<tr><td class="faint" colspan="7">Loading\u2026</td></tr>'; return; }
    var t = MONEY.totals;
    $('ptrMoneyStatus').innerHTML = MONEY.count + ' money event(s) \u00B7 collected ' + peso(t.collected)
      + ' \u00B7 refunded back ' + peso(t.refunded)
      + ' \u00B7 <b>cash in drawers ' + peso(t.cashInDrawer) + '</b> \u00B7 paid online or otherwise ' + peso(t.onlineAndOther);
    if (!MONEY.payments.length) { body.innerHTML = '<tr><td class="faint" colspan="7">No payment has been recorded on the ledger yet.</td></tr>'; return; }
    body.innerHTML = MONEY.payments.map(moneyRow).join('');
  }

  /* ---------------- click a row: the full picture ---------------- */
  var DEBT_ALL = function () { return DEBT ? DEBT.orders.concat(DEBT.quotes) : []; };
  function kv(label, value) {
    return value == null || value === '' ? '' : '<div class="ptr-kv"><span>' + esc(label) + '</span><b>' + value + '</b></div>';
  }
  function historyTable(ref, kind, exceptId) {
    var list = ((MONEY && MONEY.payments) || []).filter(function (p) { return p.ref === ref && p.kind === kind; });
    if (!list.length) return '<div class="faint">No payment on the ledger for this yet.</div>';
    return '<div class="ptr-hist"><table><thead><tr><th>When</th><th>Amount</th><th>How</th><th>Recorded by</th></tr></thead><tbody>'
      + list.map(function (p) {
        return '<tr' + (p.id === exceptId ? ' class="here"' : '') + '><td>' + esc(when(p.at)) + '</td>'
          + '<td class="mono" ' + (p.direction === 'out' ? 'style="color:var(--red,#c0392b)"' : '') + '>' + (p.direction === 'out' ? '\u2212' : '+') + peso(p.amount) + '</td>'
          + '<td>' + esc(p.method) + (p.purpose ? '<div class="faint">' + esc(p.purpose) + '</div>' : '') + '</td><td>' + esc(p.actor || 'system') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function standing(x) {
    var pct = x.total > 0 ? Math.max(0, Math.min(100, x.paidAmount / x.total * 100)) : 0, pill = STATE_PILL[x.paymentState] || ['low', x.paymentState];
    return '<div class="ptr-money"><div><span>Value</span><b class="mono">' + peso(x.total) + '</b></div><div><span>Collected</span><b class="mono">' + peso(x.paidAmount) + '</b></div>'
      + '<div class="owe"><span>Still to collect</span><b class="mono">' + peso(x.outstanding) + '</b></div></div>'
      + '<div class="ptr-bar" aria-label="' + Math.round(pct) + '% collected"><i style="width:' + pct.toFixed(1) + '%"></i></div>'
      + '<div class="faint" style="margin-top:4px">' + Math.round(pct) + '% collected \u00B7 <span class="status-pill ' + pill[0] + '">' + esc(pill[1]) + '</span></div>';
  }
  function goTo(kind) { closeDetail(); if (typeof window.navigateToPage === 'function') window.navigateToPage(kind === 'quote' ? 'quotes' : 'orders'); }
  function debtDetail(x) {
    var term = x.termsKey === 'full' ? 'Full payment' : x.termsKey + (x.termsPercent == null ? '' : ' \u00B7 ' + x.termsPercent + '%');
    return '<div class="ptr-eyebrow">' + (x.kind === 'quote' ? 'Quotation' : 'Order') + (x.status ? ' \u00B7 ' + esc(x.status) : '') + '</div>'
      + '<h2 id="ptrModalTitle">' + esc(x.no) + '</h2><div class="faint">' + esc(x.customer || 'No customer name') + (x.at ? ' \u00B7 ' + esc(when(x.at)) : '') + '</div>'
      + standing(x)
      + '<h3>Payment option</h3><div class="ptr-kvs">' + kv('Terms', esc(term)) + kv('Balance due', esc(x.termsCondition || '')) + kv('Paid by', esc(x.method || ''))
      + (x.creditException ? kv('Credit exception', '<span class="chip-pill warn">on file</span> ' + esc(x.creditException.note)) : '') + '</div>'
      + '<h3>Payments on this ' + (x.kind === 'quote' ? 'quotation' : 'order') + '</h3>' + historyTable(x.no, x.kind)
      + '<div class="ptr-actions"><button type="button" class="btn-primary btn-sm" data-ptr-go="' + esc(x.kind) + '">Open ' + (x.kind === 'quote' ? 'in Quote Approvals' : 'in Online Orders') + '</button>'
      + '<button type="button" class="btn-secondary btn-sm" data-ptr-close>Close</button></div>';
  }
  function payDetail(p) {
    var out = p.direction === 'out', owing = DEBT_ALL().filter(function (x) { return x.no === p.ref && x.kind === p.kind; })[0];
    return '<div class="ptr-eyebrow">' + (out ? 'Refund' : 'Payment received') + (p.moved ? ' \u00B7 moved from quotation to order' : '') + '</div>'
      + '<h2 id="ptrModalTitle" class="mono" ' + (out ? 'style="color:var(--red,#c0392b)"' : '') + '>' + (out ? '\u2212' : '+') + peso(p.amount) + '</h2>'
      + '<div class="faint">' + esc(when(p.at)) + ' \u00B7 against ' + (p.kind === 'quote' ? 'quotation ' : 'order ') + '<b>' + esc(p.ref) + '</b></div>'
      + '<h3>Details</h3><div class="ptr-kvs">' + kv('How it was paid', esc(p.method)) + kv('Purpose', esc(p.purpose || ''))
      + kv('Provider reference', p.providerRef ? '<span class="mono">' + esc(p.providerRef) + '</span>' : '')
      + kv('Cash drawer', p.cashShiftId != null ? 'Drawer #' + esc(p.cashShiftId) : (p.providerRef ? '' : 'Not through a drawer'))
      + kv('Cash handed over', p.tendered != null ? '<span class="mono">' + peso(p.tendered) + '</span>' : '') + kv('Change given', p.changeGiven != null ? '<span class="mono">' + peso(p.changeGiven) + '</span>' : '')
      + kv('Recorded by', esc(p.actor || 'system')) + kv('Reverses payment', p.reversedOf ? '#' + esc(p.reversedOf) : '') + kv('Ledger no.', '#' + esc(p.id)) + kv('Note', esc(p.note || '')) + '</div>'
      + '<h3>Where ' + esc(p.ref) + ' stands now</h3>'
      + (owing ? standing(owing) : '<div class="faint">Nothing is owed on this ' + (p.kind === 'quote' ? 'quotation' : 'order') + ' (fully collected, or closed).</div>')
      + '<h3>All payments on ' + esc(p.ref) + '</h3>' + historyTable(p.ref, p.kind, p.id)
      + '<div class="ptr-actions"><button type="button" class="btn-primary btn-sm" data-ptr-go="' + esc(p.kind) + '">Open ' + (p.kind === 'quote' ? 'in Quote Approvals' : 'in Online Orders') + '</button>'
      + '<button type="button" class="btn-secondary btn-sm" data-ptr-close>Close</button></div>';
  }
  var lastFocus = null;
  function ensureModal() {
    var m = $('ptrModal'); if (m) return m;
    m = document.createElement('div'); m.id = 'ptrModal'; m.className = 'ptr-modal'; m.hidden = true;
    m.innerHTML = '<div class="ptr-modal-bg" data-ptr-close></div><div class="ptr-modal-card" role="dialog" aria-modal="true" aria-labelledby="ptrModalTitle">'
      + '<button type="button" class="ptr-x" data-ptr-close aria-label="Close">\u00D7</button><div id="ptrModalBody"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) {
      var go = e.target.closest('[data-ptr-go]'); if (go) { goTo(go.dataset.ptrGo); return; }
      if (e.target.closest('[data-ptr-close]')) closeDetail();
    });
    return m;
  }
  function openDetail(html) {
    var m = ensureModal(); lastFocus = document.activeElement;
    $('ptrModalBody').innerHTML = html; m.hidden = false; document.body.style.overflow = 'hidden';
    var c = m.querySelector('.ptr-x'); if (c) c.focus();
  }
  function closeDetail() {
    var m = $('ptrModal'); if (!m || m.hidden) return;
    m.hidden = true; document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
  }
  function rowDetail(tr) {
    if (tr.dataset.debt) {
      var key = tr.dataset.debt, x = DEBT_ALL().filter(function (d) { return d.kind + ':' + d.no === key; })[0];
      if (x) openDetail(debtDetail(x));
    } else if (tr.dataset.pay) {
      var p = ((MONEY && MONEY.payments) || []).filter(function (m) { return String(m.id) === tr.dataset.pay; })[0];
      if (p) openDetail(payDetail(p));
    }
  }

  /* ---------------- loading and saving ---------------- */
  function setErr(scope, msg) {
    var box = scope && scope.querySelector('[data-err]');
    if (box) box.textContent = msg || '';
    else if (msg) toast(msg, true);
  }

  async function loadAll() {
    if (busy) return;
    busy = true;
    try {
      var res = await Promise.all([
        api('/finance/payment-terms'), api('/finance/quotes').catch(function () { return []; }),
        api('/finance/receivables'), api('/finance/payments'), api('/finance/order-rules').catch(function () { return null; })
      ]);
      RULES = res[4];
      POLICY = res[0].terms || []; LEDGER_READY = res[0].ledgerReady !== false;
      QUOTES = Array.isArray(res[1]) ? res[1] : []; DEBT = res[2]; MONEY = res[3];
    } catch (e) {
      if (e.message !== 'Not signed in') toast(e.message || 'The payment-terms screen could not be loaded.', true);
      busy = false; return;
    }
    renderPolicy(); renderProposed(); renderDebt(); renderMoney(); renderCod();
    busy = false;
  }

  async function saveTerm(tr) {
    var key = tr.dataset.term,
      val = function (f) { var el = tr.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; },
      on = function (f) { var el = tr.querySelector('[data-f="' + f + '"]'); return !!(el && el.checked); };
    var enabled = key === 'full' ? true : on('enabled'), saved = tr.querySelector('[data-saved]');
    setErr(tr, '');
    // the rule the server enforces, checked here only so the row answers straight away
    if (enabled && key !== 'full' && !on('retailAllowed') && !on('madeToOrderAllowed')) return setErr(tr, 'Tick which orders this term covers (ready stock and / or made-to-order) and it is saved.');
    var basis = val('basis');
    if (key !== 'full' && !String(basis === 'fixed' ? val('fixedAmount') : val('percent')).trim()) return setErr(tr, basis === 'fixed' ? 'Enter the amount to pay now.' : 'Enter the percentage to pay now.');
    // Full Payment has no scope or percentage to choose: it is always 100% and always allowed, so the row must not
    // send those fields at all — leaving them out is what keeps the stored policy as it is.
    // Who changed what is written to the audit log by the server, so nothing has to be typed for it.
    var body = { enabled: enabled, balanceCondition: val('balanceCondition') };
    if (key !== 'full') { body.retailAllowed = on('retailAllowed'); body.madeToOrderAllowed = on('madeToOrderAllowed'); body.basis = basis;
      if (basis === 'fixed') body.fixedAmount = val('fixedAmount'); else body.percent = val('percent');
      body.autoApproveLimit = val('autoApproveLimit'); }
    var was = (POLICY.find(function (t) { return t.key === key; }) || {}).enabled;
    if (saved) saved.textContent = 'Saving…';
    try {
      var out = await api('/finance/payment-terms/' + encodeURIComponent(key), { method: 'POST', body: JSON.stringify(body) });
      POLICY = POLICY.map(function (t) { return t.key === key ? out.term : t; });
      // only the row's notes are repainted, so the box being typed in keeps its focus
      var ah = tr.querySelector('[data-auto-hint]'), oh = tr.querySelector('[data-on-hint]');
      if (ah) ah.innerHTML = autoHint(out.term);
      if (oh) oh.innerHTML = onHint(out.term);
      if (saved) saved.textContent = 'Saved ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
      renderPolicyStatus();
      if (was !== out.term.enabled) toast(out.term.enabled ? out.term.label + ' is now offered where you allowed it.' : out.term.label + ' is no longer offered.');
    } catch (e) {
      if (e.message === 'Not signed in') return;
      if (saved) saved.textContent = '';
      setErr(tr, (e.fields && (e.fields.percent || e.fields.fixedAmount || e.fields.scope || e.fields.autoApproveLimit || e.fields.note)) || e.message);
    }
  }
  // a row saves itself: at once for a tick box or a list, a moment after typing stops in a box
  var saveTimers = {};
  function queueSave(tr, delay) {
    var key = tr.dataset.term;
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function () { saveTerm(tr); }, delay);
  }

  async function decide(row, action) {
    var no = row.dataset.quote, t = (QUOTES.find(function (q) { return q.id === no; }) || {}).terms || {};
    var note = ((row.querySelector('[data-f="note"]') || {}).value || '').trim();
    setErr(row, '');
    if (String(note).length > 0 && String(note).length < 5) return setErr(row, 'Write at least 5 characters in the note, or leave it empty.');
    if (action === 'approve' && t.key === 'custom' && !(Number(t.percent) > 0 && Number(t.percent) < 100)) return setErr(row, 'This custom term has no usable percentage \u2014 refuse it and price the quotation on full payment.');
    try {
      await api('/finance/quotes/' + encodeURIComponent(no) + '/terms', { method: 'POST',
        body: JSON.stringify(action === 'refuse' ? { action: 'refuse', note: note }
          : { action: 'approve', termKey: t.key, percent: t.percent, condition: t.condition, note: note }) });
      toast(action === 'refuse' ? no + ' is back to full payment.' : no + ': the partial terms are approved and the customer told.');
      loadAll();
    } catch (e) {
      if (e.message === 'Not signed in') return;
      setErr(row, (e.fields && (e.fields.note || e.fields.terms || e.fields.termKey || e.fields.percent || e.fields.payment || e.fields.status || e.fields.amount)) || e.message);
    }
  }

  function start() {
    build();
    var host = $('payment-terms');
    if (!host) return;
    var hosts = [host]; if ($('payments') && $('payments') !== host) hosts.push($('payments'));
    loadAll();
    hosts.forEach(function (h) {
      h.addEventListener('click', function (e) {
        var row = e.target.closest('tr.ptr-row');
        if (row && !e.target.closest('a,button,input,select')) rowDetail(row);
      });
      h.addEventListener('keydown', function (e) {
        var row = e.target.closest && e.target.closest('tr.ptr-row');
        if (row && e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); rowDetail(row); }
      });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDetail(); });
    var onClick = function (e) {
      var reload = e.target.closest('[data-reload]');
      if (reload) { e.preventDefault(); loadAll(); return; }
      var cod = e.target.closest('[data-cod-save]');
      if (cod) { e.preventDefault(); saveCod(cod); return; }
      var ap = e.target.closest('[data-approve]'), rf = e.target.closest('[data-refuse]');
      if (ap || rf) { e.preventDefault(); var row = (ap || rf).closest('tr[data-quote]'); if (row) decide(row, ap ? 'approve' : 'refuse'); }
    };
    hosts.forEach(function (h) { h.addEventListener('click', onClick); });
    // the policy rows save themselves (no Save button)
    host.addEventListener('change', function (e) {
      var tr = e.target.closest && e.target.closest('#ptrPolicyBody tr[data-term]'); if (!tr) return;
      if (e.target.dataset.f === 'basis') tr.querySelectorAll('[data-basis]').forEach(function (x) { x.hidden = x.dataset.basis !== e.target.value; });
      queueSave(tr, 0);
    });
    host.addEventListener('input', function (e) {
      var tr = e.target.closest && e.target.closest('#ptrPolicyBody tr[data-term]'); if (!tr || e.target.type === 'checkbox') return;
      queueSave(tr, 900);
    });
    // finance lives with this screen open; refresh it when it comes back into view
    new MutationObserver(function () { if (host.classList.contains('active-page')) loadAll(); }).observe(host, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && host.classList.contains('active-page')) loadAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();