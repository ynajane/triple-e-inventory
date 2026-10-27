/* sales-orders.js — Finance "Online Orders" and "POS Sales & Shifts" pages (monitoring).
   The cashier now processes every order and sale (POS > Online Orders). Finance only FOLLOWS them here, so there are no
   confirm / pack / deliver / cancel buttons. Finance keeps the decisions that only Finance can make:
     • cancellation requests from customers (Approve / Reject)      • POS void requests         • POS return requests
   Loaded after api-bridge.js in Finance_Inventory.html. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (t) => new Date(t).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  let ORDERS = [], POS = [], VOIDS = {}, RETURNS = {}, posLoadSeq = 0;   // VOIDS / RETURNS: invoice no. -> pending void request {id, reason} / pending partial return {id, items, amount, ...}
  const payLabel = (m) => (m === 'Xendit' ? 'Online payment' : m);   // Xendit is only the gateway behind it; the stored value stays 'Xendit'

  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (err ? ' error' : '');
    el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4000);
  }
  async function api(path, opts) {
    const r = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' } }, opts));
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { fields: d.fields });
    return d;
  }
  const pill = (st) => {
    const c = ['Delivered', 'Picked Up', 'Completed'].includes(st) ? 'in'
      : ['Cancelled', 'Voided'].includes(st) ? 'out'
      : ['Pending Confirmation', 'Void Pending', 'Return Pending'].includes(st) ? 'low' : 'watch';
    return '<span class="status-pill ' + c + '">' + esc(st) + '</span>';
  };
  const FINAL = ['Delivered', 'Picked Up'];
  // Who has the order right now, in words (the cashier moves it; Finance only reads this).
  const holder = (o) => {
    if (o.status === 'Cancelled') return 'Closed';
    if (FINAL.includes(o.status)) return 'Completed';
    return { 'Pending Confirmation': 'Waiting for the cashier to confirm', Paid: 'Cashier: to pack', Packed: 'Cashier: to release', 'Ready for Pickup': 'Cashier: customer collecting', 'Out for Delivery': 'On its way (cashier)' }[o.status] || 'With the cashier';
  };
  // Small progress line under the status: done steps, the current step in bold, steps still to come in grey.
  const tracker = (o) => {
    const flow = o.flow || []; const at = flow.indexOf(o.status);
    if (!flow.length || o.status === 'Cancelled') return '';
    return '<div style="font-size:11.5px;margin-top:6px;line-height:1.5">' + flow.map((st, i) =>
      i < at ? '<span class="faint">' + esc(st) + '</span>' : i === at ? '<b>' + esc(st) + '</b>' : '<span class="faint" style="opacity:.55">' + esc(st) + '</span>').join(' <span class="faint">›</span> ') + '</div>';
  };

  // Delivery details under the status: who has it, when it left, tracking, when it arrived, proof photos (Delivery orders only).
  const dlvInfo = (o) => {
    if (o.fulfillment !== 'Delivery') return '';
    const d = o.delivery || {}, line = (t) => '<div class="faint" style="font-size:12px;margin-top:3px;line-height:1.45">' + t + '</div>';
    const who = [d.driverName, d.courier, d.vehiclePlate].filter(Boolean).map(esc).join(' · ');
    let h = '';
    if (who) h += line('<b>Rider:</b> ' + who + (d.driverPhone ? ' · ' + esc(d.driverPhone) : ''));
    if (d.trackingNo) h += line('<b>Tracking:</b> ' + esc(d.trackingNo));
    if (d.dispatchedAt) h += line('<b>Left:</b> ' + esc(when(d.dispatchedAt)));
    if (o.status === 'Delivered') h += line('<b>Delivered:</b> ' + (d.deliveredAt ? esc(when(d.deliveredAt)) : '—') + (o.receivedBy ? ' · received by ' + esc(o.receivedBy) : ''));
    if (o.status === 'Delivered') h += line('<b>Customer confirmed:</b> ' + (d.customerReceivedAt ? esc(when(d.customerReceivedAt)) : '<span style="opacity:.7">not yet</span>'));
    if (d.notes) h += line('<b>Note:</b> ' + esc(d.notes));
    if (d.proofIds && d.proofIds.length)
      h += line('<b>Proof:</b> ' + d.proofIds.map((id, i) => '<a href="/api/orders/' + encodeURIComponent(o.id) + '/delivery-proof/' + id + '" target="_blank" rel="noopener">Photo ' + (i + 1) + '</a>').join(', '));
    else if (o.status === 'Delivered') h += line('<b>Proof:</b> none attached');
    return h;
  };

  // Each list draws as soon as ITS request answers, so one slow request can no longer leave every panel on "Loading…".
  // A request that gets no answer within 20 s shows a message instead of waiting forever.
  const TIMEOUT_MS = 20000;
  const limit = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('The server did not answer in time. Check that it is running, then press Refresh.')), TIMEOUT_MS))]);
  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const pUrl = posUrl();
      const tasks = [
        limit(api('/orders')).then((v) => { ORDERS = v; renderOrders(); }, (e) => { $('soSub').textContent = 'Could not load orders: ' + e.message; }),
        pUrl ? limit(api(pUrl)).then((v) => { POS = v; renderPos(); }, (e) => { $('soPosSub').textContent = 'Could not load POS sales: ' + e.message; })
             : Promise.resolve($('soPosSub').textContent = 'Choose a valid date range (From must not exceed To).'),
        limit(api('/pos/void-requests')).then((v) => { VOIDS = {}; v.forEach((r) => { VOIDS[r.receiptNo] = r; }); }, () => {}),
        limit(api('/pos/return-requests')).then((v) => { RETURNS = {}; v.forEach((r) => { RETURNS[r.receiptNo] = r; }); }, () => {})
      ];
      await Promise.allSettled(tasks);
      if (POS.length || Object.keys(VOIDS).length || Object.keys(RETURNS).length) renderPos();   // void / return flags arrived after the sales
      if (window.CashReports) window.CashReports.show();   // payment summary + cash shifts
    } finally { loading = false; }
  }

  function updateSalesBadge() {
    const count = (ORDERS || []).filter(o => o.status === 'Pending Confirmation' || o.cancelRequested).length;
    const attn = document.getElementById('salesNavAttention');
    if (attn) {
      if (count > 0) {
        attn.textContent = count;
        attn.hidden = false;
        attn.className = 'ngt-ind attn';
      } else {
        attn.hidden = true;
      }
    }
    const tabBadge = document.getElementById('ordersTabBadge');
    if (tabBadge) {
      tabBadge.textContent = count;
      tabBadge.hidden = count <= 0;
    }
  }

  
  /* ---------- Card Modals on Row Click ---------- */
  let orderModalOverlay = null;
  function ensureOrderModal() {
    if (orderModalOverlay) return orderModalOverlay;
    orderModalOverlay = document.createElement('div');
    orderModalOverlay.className = 'modal-overlay';
    orderModalOverlay.id = 'orderCardModalOverlay';
    orderModalOverlay.innerHTML =
      '<div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="orderCardTitle" style="max-width:680px">' +
        '<button type="button" class="modal-close" id="orderCardClose" aria-label="Close">&times;</button>' +
        '<div id="orderCardBody"></div>' +
      '</div>';
    document.body.appendChild(orderModalOverlay);
    const close = () => {
      orderModalOverlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    };
    orderModalOverlay.addEventListener('click', (e) => { if (e.target === orderModalOverlay) close(); });
    orderModalOverlay.querySelector('#orderCardClose').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && orderModalOverlay.classList.contains('open')) close();
    });
    return orderModalOverlay;
  }

  function openOrderCard(orderId) {
    const o = (ORDERS || []).find((x) => x.id === orderId);
    if (!o) return;
    const overlay = ensureOrderModal();
    const isDel = o.fulfillment === 'Delivery';

    let cancelBanner = '';
    if (o.cancelRequested) {
      cancelBanner = '<div class="sa-banner warn" style="margin:14px 0 16px">' +
        '<b>Cancellation Requested by Customer</b><br>Customer has requested to cancel this order. Review and make your decision below.<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button type="button" class="btn-primary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve Cancellation</button>' +
        '<button type="button" class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject Cancellation</button>' +
        '</div></div>';
    } else if (o.status === 'Cancelled') {
      cancelBanner = '<div class="sa-banner bad" style="margin:14px 0 16px">This order was cancelled.</div>';
    }

    const row = (dt, dd) => '<div class="pd-row"><dt>' + dt + '</dt><dd>' + (dd || '—') + '</dd></div>';

    let itemsTable = '<div class="table-wrapper" style="margin:12px 0">' +
      '<table style="font-size:13.5px">' +
      '<thead><tr><th>Product Item</th><th style="text-align:right">Unit Price</th><th style="text-align:center">Qty</th><th style="text-align:right">Subtotal</th></tr></thead>' +
      '<tbody>' +
      o.items.map(i => {
        const lineTotal = (Number(i.qty) || 0) * (Number(i.price) || 0);
        return '<tr>' +
          '<td><b>' + esc(i.name) + '</b>' + (i.sku ? '<div class="faint" style="font-size:12px">' + esc(i.sku) + '</div>' : '') + '</td>' +
          '<td style="text-align:right" class="mono">' + peso(i.price) + '</td>' +
          '<td style="text-align:center"><b>' + esc(i.qty) + '</b> ' + esc(i.unit || 'pcs') + '</td>' +
          '<td style="text-align:right" class="mono"><b>' + peso(lineTotal) + '</b></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>';

    let deliverySection = '';
    if (isDel) {
      const d = o.delivery || {};
      deliverySection = '<div class="pd-section-title" style="margin-top:16px">Fulfillment &amp; Courier Logistics</div>' +
        '<dl class="pd-grid">' +
        row('Courier Service', esc(d.courier || 'Triple E In-House Delivery')) +
        row('Rider / Driver', esc([d.driverName, d.driverPhone].filter(Boolean).join(' · ') || 'Assigned upon packing')) +
        row('Vehicle Plate', esc(d.vehiclePlate || '—')) +
        row('Tracking Number', d.trackingNo ? '<span class="mono">' + esc(d.trackingNo) + '</span>' : '—') +
        row('Dispatched At', d.dispatchedAt ? esc(when(d.dispatchedAt)) : 'Pending dispatch') +
        row('Delivered At', d.deliveredAt ? esc(when(d.deliveredAt)) : 'In transit') +
        '</dl>';
      if (d.proofIds && d.proofIds.length) {
        deliverySection += '<div class="faint" style="margin-top:8px"><b>Proof of Delivery:</b> ' +
          d.proofIds.map((id, i) => '<a href="/api/orders/' + encodeURIComponent(o.id) + '/delivery-proof/' + id + '" target="_blank" rel="noopener" style="color:var(--blue-bright)">Photo ' + (i + 1) + '</a>').join(', ') +
          '</div>';
      }
    }

    const flowHtml = tracker(o);

    overlay.querySelector('#orderCardBody').innerHTML =
      '<div class="supplier-modal-head">' +
        '<div class="supplier-modal-icon">' +
          '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="modal-eyebrow">Online Customer Order · Sales &amp; Transactions</div>' +
          '<h2 class="modal-title" id="orderCardTitle" style="margin-bottom:2px;">Order ' + esc(o.id) + '</h2>' +
          '<div class="pd-sub">' +
            '<span class="faint">' + esc(when(o.createdAt)) + '</span> · ' +
            pill(o.status) + ' ' +
            '<span class="status-pill ' + (isDel ? 'info' : 'active') + '">' + esc(o.fulfillment) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      cancelBanner +
      (flowHtml ? '<div style="margin:12px 0 14px;padding:10px 14px;background:rgba(74,144,217,0.06);border:1px solid var(--border);border-radius:8px">' +
        '<div class="faint" style="font-size:11.5px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">Order Status Progress</div>' +
        flowHtml + '</div>' : '') +
      '<div class="pd-section-title">Customer Information</div>' +
      '<dl class="pd-grid">' +
        row('Account Customer', '<b>' + esc(o.customer) + '</b>') +
        row('Customer Phone', esc(o.customerPhone || o.phone || '—')) +
        (isDel ? row('Deliver To Recipient', '<b>' + esc(o.recipient || o.customer) + '</b>' + (o.recipientPhone ? ' · ' + esc(o.recipientPhone) : '')) : '') +
        (isDel ? row('Delivery Address', esc(o.address || '—')) : '') +
        (isDel && o.landmark ? row('Landmark Notes', '<span class="faint">' + esc(o.landmark) + '</span>') : '') +
        row('Payment Method', esc(payLabel(o.method))) +
      '</dl>' +
      '<div class="pd-section-title" style="margin-top:16px">Purchased Items (' + o.items.length + ')</div>' +
      itemsTable +
      '<div class="sa-totals" style="margin-top:12px">' +
        '<div><span>Items Subtotal</span><span class="mono">' + peso(o.subtotal || o.total) + '</span></div>' +
        (o.deliveryFee ? '<div><span>Delivery Fee</span><span class="mono">' + peso(o.deliveryFee) + '</span></div>' : '') +
        (o.vat ? '<div><span>VAT (12% included)</span><span class="mono">' + peso(o.vat) + '</span></div>' : '') +
        '<div class="grand"><span>Order Total</span><span class="mono">' + peso(o.total) + '</span></div>' +
      '</div>' +
      deliverySection +
      '<div style="margin-top:20px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="btn-secondary" id="orderCardCloseBtn">Close</button>' +
      '</div>';

    overlay.querySelector('#orderCardCloseBtn').addEventListener('click', () => {
      overlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    });

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  let posModalOverlay = null;
  function ensurePosModal() {
    if (posModalOverlay) return posModalOverlay;
    posModalOverlay = document.createElement('div');
    posModalOverlay.className = 'modal-overlay';
    posModalOverlay.id = 'posSaleCardModalOverlay';
    posModalOverlay.innerHTML =
      '<div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="posModalTitle" style="max-width:680px">' +
        '<button type="button" class="modal-close" id="posModalClose" aria-label="Close">&times;</button>' +
        '<div id="posModalBody"></div>' +
      '</div>';
    document.body.appendChild(posModalOverlay);
    const close = () => {
      posModalOverlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    };
    posModalOverlay.addEventListener('click', (e) => { if (e.target === posModalOverlay) close(); });
    posModalOverlay.querySelector('#posModalClose').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && posModalOverlay.classList.contains('open')) close();
    });
    return posModalOverlay;
  }

  function openPosSaleCard(receiptNo) {
    const s = (POS || []).find((x) => x.receiptNo === receiptNo) || (Object.values(RETURNS).find(r => r.receiptNo === receiptNo));
    if (!s) return;
    const overlay = ensurePosModal();
    const rq = s.returnPending && RETURNS[s.receiptNo];
    const isVoid = VOIDS[s.receiptNo];

    let actionBanner = '';
    if (s.status === 'Void Pending' && isVoid) {
      actionBanner = '<div class="sa-banner warn" style="margin:14px 0 16px">' +
        '<b>Void Requested by Cashier</b><br>Reason: ' + esc(isVoid.reason || 'No reason provided') +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button type="button" class="btn-danger-sm btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="1">Approve Void</button>' +
        '<button type="button" class="btn-secondary btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="0">Reject Void</button>' +
        '</div></div>';
    } else if (rq) {
      actionBanner = '<div class="sa-banner warn" style="margin:14px 0 16px">' +
        '<b>Return Requested (' + esc(rq.returnNo) + ')</b><br>' +
        'Items: ' + rq.items.map(i => esc(i.qty + ' ' + i.unit + ' ' + i.name)).join(', ') + '<br>' +
        'Refund: ' + peso(rq.amount) + ' · Reason: ' + esc(rq.reason || '—') +
        '<div style="display:flex;gap:8px;margin-top:10px">' +
        '<button type="button" class="btn-primary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="1">Approve Return</button>' +
        '<button type="button" class="btn-secondary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="0">Reject Return</button>' +
        '</div></div>';
    } else if (s.status === 'Voided') {
      actionBanner = '<div class="sa-banner bad" style="margin:14px 0 16px">This sale was voided and stock was returned.</div>';
    }

    const row = (dt, dd) => '<div class="pd-row"><dt>' + dt + '</dt><dd>' + (dd || '—') + '</dd></div>';

    let itemsTable = '<div class="table-wrapper" style="margin:12px 0">' +
      '<table style="font-size:13.5px">' +
      '<thead><tr><th>Product Item</th><th style="text-align:right">Price</th><th style="text-align:center">Qty Sold</th><th style="text-align:right">Total</th></tr></thead>' +
      '<tbody>' +
      (s.items || []).map(i => {
        const lineTotal = (Number(i.qty) || 0) * (Number(i.price) || 0);
        return '<tr>' +
          '<td><b>' + esc(i.name) + '</b>' + (i.returnedQty ? ' <span class="status-pill out" style="font-size:11px;padding:1px 6px">' + esc(i.returnedQty) + ' returned</span>' : '') + '</td>' +
          '<td style="text-align:right" class="mono">' + peso(i.price) + '</td>' +
          '<td style="text-align:center"><b>' + esc(i.qty) + '</b> ' + esc(i.unit || 'pcs') + '</td>' +
          '<td style="text-align:right" class="mono"><b>' + peso(lineTotal) + '</b></td>' +
          '</tr>';
      }).join('') +
      '</tbody></table></div>';

    overlay.querySelector('#posModalBody').innerHTML =
      '<div class="supplier-modal-head">' +
        '<div class="supplier-modal-icon">' +
          '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15h0M2 9.5h20"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="modal-eyebrow">POS Sale Invoice · Cashier Counter</div>' +
          '<h2 class="modal-title" id="posModalTitle" style="margin-bottom:2px;">Invoice ' + esc(s.receiptNo) + '</h2>' +
          '<div class="pd-sub">' +
            '<span class="faint">' + esc(when(s.createdAt)) + '</span> · ' +
            (rq ? pill('Return Pending') : pill(s.status)) + ' ' +
            '<span class="status-pill active">' + esc(payLabel(s.method)) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      actionBanner +
      '<div class="pd-section-title">Transaction Information</div>' +
      '<dl class="pd-grid">' +
        row('Cashier Staff', '<b>' + esc(s.cashierName || 'Counter Staff') + '</b>') +
        row('Customer Name', esc(s.customerName || 'Walk-in Customer')) +
        (s.customerPhone ? row('Customer Phone', esc(s.customerPhone)) : '') +
        row('Fulfillment Type', esc(s.fulfillment || 'In-Store Pickup')) +
        (s.shipTo ? row('Delivery Address', esc(s.shipTo.fullAddress || '') + (s.shipTo.landmark ? ' (Landmark: ' + esc(s.shipTo.landmark) + ')' : '')) : '') +
        row('Payment Method', esc(payLabel(s.method))) +
      '</dl>' +
      '<div class="pd-section-title" style="margin-top:16px">Sold Items (' + (s.items ? s.items.length : 0) + ')</div>' +
      itemsTable +
      '<div class="sa-totals" style="margin-top:12px">' +
        '<div><span>Gross Total</span><span class="mono">' + peso(s.total) + '</span></div>' +
        (s.refunded ? '<div><span>Refunded / Returned</span><span class="mono" style="color:var(--red,#e35b5b)">−' + peso(s.refunded) + '</span></div>' : '') +
        (s.tendered != null ? '<div><span>Cash Tendered</span><span class="mono">' + peso(s.tendered) + '</span></div>' : '') +
        (s.change != null ? '<div><span>Change Given</span><span class="mono">' + peso(s.change) + '</span></div>' : '') +
        '<div class="grand"><span>Net Realized Sale</span><span class="mono">' + peso(s.refunded ? s.total - s.refunded : s.total) + '</span></div>' +
      '</div>' +
      '<div style="margin-top:20px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="btn-secondary" id="posModalCloseBtn">Close</button>' +
      '</div>';

    overlay.querySelector('#posModalCloseBtn').addEventListener('click', () => {
      overlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    });

    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
  }

  function renderOrders() {
    updateSalesBadge();
    const q = $('soSearch').value.trim().toLowerCase(), st = $('soStatus').value, ty = $('soType') ? $('soType').value : 'all';
    const rows = ORDERS.filter(o => (st === 'all' || o.status === st) && (ty === 'all' || o.fulfillment === ty) &&
      (!q || (o.id + ' ' + o.customer + ' ' + (o.customerPhone || '') + ' ' + (o.phone || '') + ' ' + (o.recipient || '') + ' ' + [(o.delivery || {}).driverName, (o.delivery || {}).trackingNo, (o.delivery || {}).vehiclePlate, (o.delivery || {}).courier].filter(Boolean).join(' ') + ' ' + o.items.map(i => i.name + ' ' + i.sku).join(' ')).toLowerCase().includes(q)));
    $('soSub').textContent = rows.length + ' of ' + ORDERS.length + ' orders';
    $('soHead').innerHTML = '<tr><th style="min-width:110px">Order</th><th>Date</th><th>Customer</th><th>Items Summary</th><th style="text-align:right">Total</th><th>Type / Payment</th><th>Status</th><th>Follow-up</th></tr>';
    $('soBody').innerHTML = rows.length ? rows.map(o => {
      let act;
      if (o.cancelRequested) act = '<button class="btn-primary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="1">Approve cancel</button> <button class="btn-secondary btn-sm" data-so-cancel="' + esc(o.id) + '" data-ok="0">Reject</button>';
      else act = '<span class="faint">' + esc(holder(o)) + '</span>';

      const firstItem = o.items[0];
      const itemCount = o.items.reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
      const itemsHtml = firstItem
        ? '<div><b>' + esc(firstItem.qty + ' × ' + firstItem.name) + '</b></div>' +
          (o.items.length > 1 ? '<div class="faint" style="font-size:12.5px">+' + (o.items.length - 1) + ' other product' + (o.items.length > 2 ? 's' : '') + ' (' + itemCount + ' pcs total)</div>' : '')
        : '<span class="faint">—</span>';

      const whoHtml = '<div><b>' + esc(o.customer) + '</b></div>' +
        '<div class="faint">' + esc(o.customerPhone || o.phone || '—') + '</div>';

      return '<tr class="order-click-row" data-order-id="' + esc(o.id) + '" title="Click to view full order details card">' +
        '<td><span class="order-ref">' + esc(o.id) + '</span></td>' +
        '<td><span style="white-space:nowrap">' + esc(when(o.createdAt)) + '</span></td>' +
        '<td>' + whoHtml + '</td>' +
        '<td>' + itemsHtml + '</td>' +
        '<td style="text-align:right"><b class="mono" style="font-size:14.5px">' + peso(o.total) + '</b></td>' +
        '<td><div>' + esc(o.fulfillment) + '</div><div class="faint">' + esc(payLabel(o.method)) + '</div></td>' +
        '<td>' + pill(o.status) + (o.cancelRequested ? '<div class="faint" style="color:var(--red,#e35b5b);font-weight:600;margin-top:2px">Cancel requested</div>' : '') + '</td>' +
        '<td style="white-space:nowrap">' + act + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="8" class="report-note">No orders yet. Orders placed in the shop appear here.</td></tr>';

    $('soBody').querySelectorAll('tr.order-click-row').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        openOrderCard(tr.dataset.orderId);
      });
    });
  }

  function localISO(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
  let posPeriodMode = 'week';
  function setPosRange(mode) {
    posPeriodMode = mode;
    const now = new Date(); let from = '', to = localISO(now);
    if (mode === 'today') from = to;
    else if (mode === 'yesterday') { now.setDate(now.getDate()-1); from = to = localISO(now); }
    else if (mode === 'week') { now.setDate(now.getDate()-6); from = localISO(now); }
    else if (mode === 'month') from = localISO(new Date(now.getFullYear(),now.getMonth(),1));
    else if (mode === 'year') from = localISO(new Date(now.getFullYear(),0,1));
    $('soPosFrom').value = from;
    $('soPosTo').value = mode === 'all' ? '' : to;
    document.querySelectorAll('[data-pos-period]').forEach(b => {
      const active = b.dataset.posPeriod === mode;
      b.classList.toggle('active',active);
      b.setAttribute('aria-pressed',String(active));
    });
  }
  function posUrl() {
    const from = $('soPosFrom')?.value || '', to = $('soPosTo')?.value || '';
    if (posPeriodMode === 'all') return '/pos/sales?all=1';
    if (!from || !to || from > to) return null;
    return '/pos/sales?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  }
  async function reloadPos() {
    const url = posUrl();
    if (!url) { $('soPosSub').textContent = 'Choose a valid date range (From must not exceed To).'; return; }
    const seq = ++posLoadSeq;
    $('soPosSub').textContent = 'Loading sales history…';
    try { const rows = await api(url); if (seq !== posLoadSeq) return; POS = rows; renderPos(); }
    catch (e) { if (seq === posLoadSeq) $('soPosSub').textContent = e.message; }
  }
  if ($('soPosFrom') && $('soPosTo')) {
    setPosRange('week');
    document.querySelectorAll('[data-pos-period]').forEach(b => b.addEventListener('click', () => { setPosRange(b.dataset.posPeriod); reloadPos(); }));
    ['soPosFrom','soPosTo'].forEach(id => $(id).addEventListener('change', () => {
      posPeriodMode = 'custom';
      document.querySelectorAll('[data-pos-period]').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed','false'); });
      if ($('soPosFrom').value && $('soPosTo').value) reloadPos();
    }));
    $('soPosExport')?.addEventListener('click', () => {
      const q = $('soPosSearch').value.trim().toLowerCase();
      const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + (s.customerName||'') + ' ' + (s.customerPhone||'') + ' ' + (s.items||[]).map(i=>i.name).join(' ')).toLowerCase().includes(q));
      const fields = ['Invoice','Date','Customer','Customer phone','Cashier','Items','Total','Refunded','Net','Payment','Status'];
      const csv = [fields,...rows.map(s => [s.receiptNo,s.createdAt,s.customerName||'Walk-in',s.customerPhone||'',s.cashierName,(s.items||[]).map(i=>i.qty+' x '+i.name).join('; '),s.total,s.refunded||0,s.status==='Voided'?0:Number(s.total)-Number(s.refunded||0),s.method,s.status])]
        .map(row => row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
      const link = document.createElement('a'); link.href=url; link.download='pos-sales-'+(posPeriodMode==='all'?'all':($('soPosFrom').value+'-to-'+$('soPosTo').value))+'.csv';
      document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  }

  function renderPos() {
    const q = $('soPosSearch').value.trim().toLowerCase();
    const rows = POS.filter(s => !q || (s.receiptNo + ' ' + s.cashierName + ' ' + (s.customerName||'') + ' ' + (s.customerPhone||'') + ' ' + s.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
    const live = rows.filter(s => s.status !== 'Voided');
    $('soPosSub').textContent = rows.length + ' sales · ' + peso(live.reduce((n, s) => n + s.total - (s.refunded || 0), 0)) + ' collected (after returns)';
    $('soPosHead').innerHTML = '<tr><th style="min-width:130px">Invoice</th><th>Time</th><th>Customer</th><th>Cashier</th><th>Items Summary</th><th style="text-align:right">Total</th><th>Payment</th><th>Status</th><th>Action</th></tr>';
    $('soPosBody').innerHTML = (rows.length || Object.keys(RETURNS).length) ? rows.map(s => {
      const rq = s.returnPending && RETURNS[s.receiptNo];
      const firstItem = s.items && s.items[0];
      const totalQty = (s.items || []).reduce((sum, it) => sum + (Number(it.qty) || 0), 0);
      const itemsHtml = firstItem
        ? '<div><b>' + esc(firstItem.qty + ' × ' + firstItem.name) + '</b></div>' +
          (s.items.length > 1 ? '<div class="faint" style="font-size:12.5px">+' + (s.items.length - 1) + ' other product' + (s.items.length > 2 ? 's' : '') + ' (' + totalQty + ' pcs total)</div>' : '')
        : '<span class="faint">—</span>';

      const custHtml = '<div><b>' + esc(s.customerName || 'Walk-in Customer') + '</b></div>' +
        (s.customerPhone ? '<div class="faint">' + esc(s.customerPhone) + '</div>' : '');

      let actHtml = '<span class="faint">—</span>';
      if (s.status === 'Void Pending' && VOIDS[s.receiptNo]) {
        actHtml = '<button class="btn-danger-sm btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="1">Approve void</button> <button class="btn-secondary btn-sm" data-so-void="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>';
      } else if (rq) {
        actHtml = '<button class="btn-primary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(s.receiptNo) + '" data-ok="0">Reject</button>';
      }

      return '<tr class="pos-click-row" data-receipt-no="' + esc(s.receiptNo) + '" title="Click to view full sale invoice card">' +
        '<td><span class="order-ref">' + esc(s.receiptNo) + '</span></td>' +
        '<td><span style="white-space:nowrap">' + esc(when(s.createdAt)) + '</span></td>' +
        '<td>' + custHtml + '</td>' +
        '<td>' + esc(s.cashierName || 'Counter') + '</td>' +
        '<td>' + itemsHtml + '</td>' +
        '<td style="text-align:right"><b class="mono" style="font-size:14.5px">' + peso(s.total) + '</b>' +
          (s.refunded ? '<div class="faint" style="color:var(--red,#e35b5b)">−' + peso(s.refunded) + '</div>' : '') +
        '</td>' +
        '<td><div>' + esc(payLabel(s.method)) + '</div>' + (s.fulfillment === 'Delivery' ? '<div class="faint">Delivery</div>' : '') + '</td>' +
        '<td>' + (rq ? pill('Return Pending') : pill(s.status)) + '</td>' +
        '<td style="white-space:nowrap">' + actHtml + '</td>' +
        '</tr>';
    }).join('') + Object.values(RETURNS).filter(r => !rows.some(s => s.receiptNo === r.receiptNo)).map(r =>
        '<tr class="pos-click-row" data-receipt-no="' + esc(r.receiptNo) + '" title="Click to view full sale invoice card">' +
        '<td><span class="order-ref">' + esc(r.receiptNo) + '</span></td>' +
        '<td colspan="3"><span class="faint">Earlier sale</span></td>' +
        '<td>' + (r.items ? r.items.map(i => esc(i.qty + ' × ' + i.name)).join('<br>') : '—') + '</td>' +
        '<td style="text-align:right"><b class="mono" style="font-size:14.5px">' + peso(r.amount) + '</b></td>' +
        '<td>' + esc(r.refundMethod === 'Xendit' ? 'Online payment' : r.refundMethod) + '</td>' +
        '<td>' + pill('Return Pending') + '</td>' +
        '<td><button class="btn-primary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="1">Approve return</button> <button class="btn-secondary btn-sm" data-so-return="' + esc(r.receiptNo) + '" data-ok="0">Reject</button></td></tr>').join('')
      : '<tr><td colspan="9" class="report-note">No POS sales for this period.</td></tr>';

    $('soPosBody').querySelectorAll('tr.pos-click-row').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, a, input, select')) return;
        openPosSaleCard(tr.dataset.receiptNo);
      });
    });
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-so-cancel],[data-so-void],[data-so-return]'); if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.soReturn) {
        const no = b.dataset.soReturn, ok = b.dataset.ok === '1', r = RETURNS[no];
        if (!r) { toast('No pending return for ' + no + '. Refreshing…', true); await load(); return; }
        const items = r.items.map(i => '  • ' + i.qty + ' ' + i.unit + ' ' + i.name).join('\n');
        const how = r.refundMethod === 'Cash' ? 'The ' + peso(r.amount) + ' is paid in cash from ' + (r.requestedBy || 'the cashier') + '\'s open drawer and taken off that shift\'s expected cash.'
          : 'This sale was paid by ' + (r.refundMethod === 'Xendit' ? 'online payment' : 'card') + ': send the ' + peso(r.amount) + ' refund through the payment provider. No drawer cash is involved.';
        const body = { approve: ok };
        if (ok) {
          if (!window.confirm('Approve return ' + r.returnNo + ' for ' + no + '?\n\n' + items + '\n\nRefund: ' + peso(r.amount) + '\n' + how + '\n\nCashier\'s reason: ' + r.reason)) { b.disabled = false; return; }
          body.restock = window.confirm('Are the returned items in resellable condition?\n\nOK = put them back in stock\nCancel = refund only, do NOT add them back to stock (damaged goods)');
        } else {
          const why = await FormAssist.askReason({title:'Reject return ' + r.returnNo, label:'Why is this return rejected? The cashier will see this.', min:5, max:200, confirm:'Reject return'});
          if (why === null) { b.disabled = false; return; }
          body.note = why.trim();
        }
        await api('/pos/return-requests/' + encodeURIComponent(r.id) + '/decision', { method: 'POST', body: JSON.stringify(body) });
        toast(ok ? r.returnNo + ' approved' + (body.restock ? ' and the items are back in stock.' : '. Items were not added back to stock.') : r.returnNo + ' rejected.');
      } else if (b.dataset.soVoid) {
        const no = b.dataset.soVoid, ok = b.dataset.ok === '1', v = VOIDS[no], sale = POS.find(x => x.receiptNo === no);
        if (!v) { toast('No pending void request for ' + no + '. Refreshing…', true); await load(); return; }
        const online = sale && sale.method === 'Xendit';
        const msg = (ok ? 'Approve the void of ' + no + '?\nAll items go back into stock. This cannot be undone.' : 'Reject the void request for ' + no + '?\nThe sale stays completed.')
          + '\n\nCashier\'s reason: ' + v.reason + (ok && online ? '\n\nThis sale was paid online. Voiding does not refund the customer: send the refund from your Xendit dashboard.' : '');
        if (!window.confirm(msg)) { b.disabled = false; return; }
        await api('/pos/void-requests/' + encodeURIComponent(v.id) + '/decision', { method: 'POST', body: JSON.stringify({ approve: ok }) });
        toast(ok ? no + ' was voided and the stock returned.' : 'Void request for ' + no + ' rejected.');
      } else {
        if (b.dataset.ok === '1') { if (!await window.PaymentSafeguards.cancel(b.dataset.soCancel, true)) return; }
        else await api('/orders/' + encodeURIComponent(b.dataset.soCancel) + '/cancel-decision', { method: 'POST', body: JSON.stringify({ approve: false }) });
        toast(b.dataset.ok === '1' ? 'Cancellation approved. Stock restored.' : 'Cancellation rejected.');
      }
      await load();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  });

  $('soStatus') && $('soStatus').addEventListener('change', renderOrders);
  $('soSearch') && $('soSearch').addEventListener('input', renderOrders);
  $('soPosSearch') && $('soPosSearch').addEventListener('input', renderPos);
  $('soType') && $('soType').addEventListener('change', renderOrders);
  document.querySelectorAll('.so-refresh').forEach(b => b.addEventListener('click', load));
  document.querySelectorAll('.nav-item[data-page="sales-hub"], .nav-item[data-page="sales"], .nav-item[data-page="orders"], .nav-item[data-page="sales-overview"], .sales-tab[data-page="sales"], .sales-tab[data-page="orders"], .sales-tab[data-page="sales-overview"]').forEach(n => n.addEventListener('click', load));
  const watching = () => ['orders', 'sales', 'sales-overview'].some(id => $(id) && $(id).classList.contains('active-page'));
  if (watching()) load();
  // Load whenever any sales page is opened, however it was opened (menu, tab strip, dashboard link, refresh on #orders, Back button)
  ['orders', 'sales', 'sales-overview'].forEach(id => { const sec = $(id); if (sec) new MutationObserver(() => { if (sec.classList.contains('active-page')) load(); }).observe(sec, { attributes: true, attributeFilter: ['class'] }); });
  // Monitoring page: keep it current while it is open, since the cashier is moving orders along
  setInterval(() => { if (!document.hidden && watching()) load(); }, 15000);
})();
