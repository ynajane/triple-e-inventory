/* production-admin.js — Finished Goods production (Finance > Stock In / Out)
   1. Stock-In Source picker. "Produced Internally" shows a material preview with editable actual quantities;
      materials are only deducted when "Confirm Production" is pressed and the server finishes its transaction.
   2. Production history with the material details of each record.
   The materials needed to make ONE finished unit are set in Products > New / Edit product (product-materials.js).
   Loaded after api-bridge.js (which provides window.TripleEBridge). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const B = () => window.TripleEBridge;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const fmt = (n) => String(+Number(n).toFixed(4));
  const api = (path, opt) => B().api(path, opt);
  const toast = (m, t) => B().toast(m, t);

  // Finished goods are made in our own workshop, so there is no "Received from Supplier" source here.
  // The server refuses a supplier delivery on a Finished Goods product as well (REASON_DEPTS in server.js).
  const SOURCES = [
    { v: 'produced', label: 'Produced Internally', reason: 'produced_batch', hint: 'Made in our own workshop. The materials used are deducted automatically when you confirm.' },
    { v: 'adjustment', label: 'Inventory Adjustment', reason: 'count_correction_up', hint: 'Correct the count when the physical stock is higher than the system. A note is required.' },
    { v: 'return', label: 'Returned by customer', reason: 'customer_return', hint: 'A customer sent finished goods back and they go back on the shelf.' }
  ];

  const st = { key: null, seq: 0, timer: null, data: null, edited: {}, busy: false };
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 14)));

  /* ---------- which mode is the Stock In form in? ---------- */
  const item = () => { const sku = ($('movementProduct') || {}).value; return B().inventory().find((i) => i.sku === sku); };
  const dept = () => { const it = item(); return it ? it.department : (($('movementDept') || {}).value || ''); };
  const isFGIn = () => !!$('movementForm') && B().movementType() === 'in' && dept() === 'Finished Goods';
  const source = () => (($('movementSource') || {}).value || '');
  const isProduction = () => isFGIn() && source() === 'produced';
  const qtyValue = () => {
    const raw = ($('movementQuantity') || {}).value;
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n <= 0 || n > 1e6 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
    return n;
  };

  function buildSourceOptions() {
    const sel = $('movementSource');
    if (!sel || sel.dataset.built) return;
    sel.dataset.built = '1';
    sel.innerHTML = '<option value="">Select the source…</option>' + SOURCES.map((s) => '<option value="' + s.v + '">' + esc(s.label) + '</option>').join('');
  }

  // runs inside syncMovementForm, BEFORE it reads the reason: a source decides the reason that is stored
  function beforeSync() {
    const grp = $('movementSourceGroup'), rg = $('movementReasonGroup');
    if (!grp || !rg) return;
    const on = isFGIn();
    grp.style.display = on ? '' : 'none';
    rg.style.display = on ? 'none' : '';
    if (!on) { const s = $('movementSource'); if (s) s.value = ''; return; }
    buildSourceOptions();
    const src = SOURCES.find((s) => s.v === source());
    $('movementReason').value = src ? src.reason : '';
    const h = $('movementSourceHint'); if (h) h.textContent = src ? src.hint : 'Where did these finished goods come from?';
  }

  // runs at the end of syncMovementForm
  function afterSync() {
    const btn = $('movementSubmitBtn'), box = $('productionPreview');
    if (!box) return;
    if (!isProduction()) {
      box.style.display = 'none'; st.data = null;
      if (btn) { btn.textContent = 'Save Movement'; btn.disabled = false; }
      return;
    }
    box.style.display = '';
    if (btn) btn.textContent = 'Confirm Production';
    const sku = ($('movementProduct') || {}).value, qty = qtyValue();
    if (!sku || qty === null) { st.data = null; st.key = null; box.innerHTML = '<div class="prod-info">Choose the finished product and enter the quantity produced to see the materials that will be used.</div>'; if (btn) btn.disabled = true; return; }
    if (st.data && st.data.sku === sku && st.data.quantity === qty) { refreshStatus(); return; }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => fetchPreview(sku, qty), 350);
    if (btn) btn.disabled = true;
  }

  async function fetchPreview(sku, qty) {
    const box = $('productionPreview'); const my = ++st.seq;
    box.innerHTML = '<div class="prod-info">Calculating materials…</div>';
    try {
      const d = await api('/production/preview', { method: 'POST', body: JSON.stringify({ sku, quantity: qty }) });
      if (my !== st.seq) return;
      st.data = d; st.edited = {}; st.key = newKey();
      renderPreview();
    } catch (err) {
      if (my !== st.seq) return;
      st.data = null;
      box.innerHTML = '<div class="prod-warn">' + esc(err.message) + '</div>';
    }
  }

  function renderPreview() {
    const d = st.data, box = $('productionPreview');
    if (!d) return;
    let html = '<h4>Materials used for ' + esc(fmt(d.quantity)) + ' ' + esc(d.unit) + ' of ' + esc(d.name) + '</h4>';
    if (!d.hasRequirements) {
      html += '<div class="prod-warn">No materials are set for this product yet, so the materials used cannot be calculated. Add them in the product form.</div>' +
        '<div class="prod-actions"><button type="button" class="prod-btn ghost" id="prodGoReq">Add materials to this product</button></div>';
      box.innerHTML = html;
      $('prodGoReq').addEventListener('click', () => goToRequirements(d.sku));
      refreshStatus();
      return;
    }
    html += '<div class="prod-scroll"><table class="prod-table"><thead><tr><th>Material</th><th>Category</th><th>Per unit</th><th>Calculated</th><th>Actual used</th><th>Available</th><th>Status</th></tr></thead><tbody>' +
      d.materials.map((m) => '<tr data-sku="' + esc(m.sku) + '">' +
        '<td>' + esc(m.name) + '</td><td class="dim">' + esc(m.department) + '</td>' +
        '<td class="dim">' + esc(fmt(m.qtyPerUnit)) + ' ' + esc(m.unit) + '</td>' +
        '<td class="dim">' + esc(fmt(m.calculated)) + ' ' + esc(m.unit) + '</td>' +
        '<td><input type="number" class="prod-in" data-actual="' + esc(m.sku) + '" min="0" step="any" inputmode="decimal" value="' + esc(m.calculated) + '"> ' + esc(m.unit) + '</td>' +
        '<td class="dim">' + esc(fmt(m.onHand)) + ' ' + esc(m.unit) + '</td>' +
        '<td data-status="' + esc(m.sku) + '"></td></tr>').join('') +
      '</tbody></table></div><div id="prodShort"></div>' +
      '<p class="prod-note">The quantities are calculated from the saved requirements. Change “Actual used” if the real consumption was different. Nothing is deducted until you press Confirm Production.</p>';
    box.innerHTML = html;
    box.querySelectorAll('[data-actual]').forEach((inp) => inp.addEventListener('input', () => {
      st.edited[inp.dataset.actual] = inp.value; st.key = newKey(); refreshStatus();
    }));
    refreshStatus();
  }

  // checks every actual quantity, paints the status column and enables/disables the confirm button
  function refreshStatus() {
    const d = st.data, btn = $('movementSubmitBtn');
    if (!d) return { ok: false };
    if (!d.hasRequirements) { if (btn) btn.disabled = true; return { ok: false }; }
    const short = [], items = [];
    let bad = false;
    d.materials.forEach((m) => {
      const inp = document.querySelector('[data-actual="' + m.sku + '"]'), cell = document.querySelector('[data-status="' + m.sku + '"]');
      if (!inp || !cell) return;
      const raw = inp.value, n = Number(raw);
      let msg = '', cls = 'prod-ok';
      if (m.archived) { msg = 'Deleted material'; cls = 'prod-bad'; bad = true; }
      else if (m.unitChanged) { msg = 'Unit changed — save the product\'s materials again'; cls = 'prod-bad'; bad = true; }
      else if (raw === '' || !Number.isFinite(n) || n < 0) { msg = 'Enter 0 or more'; cls = 'prod-bad'; bad = true; }
      else if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) { msg = 'Max 2 decimals'; cls = 'prod-bad'; bad = true; }
      else if (n > m.onHand) { msg = 'Short by ' + fmt(n - m.onHand) + ' ' + m.unit; cls = 'prod-bad'; short.push(m.name + ' (needs ' + fmt(n) + ', has ' + fmt(m.onHand) + ' ' + m.unit + ')'); bad = true; }
      else msg = 'OK';
      cell.innerHTML = '<span class="' + cls + '">' + esc(msg) + '</span>';
      inp.classList.toggle('bad', cls === 'prod-bad');
      if (!bad || cls !== 'prod-bad') items.push({ sku: m.sku, actualQty: n });
    });
    const sb = $('prodShort');
    if (sb) sb.innerHTML = short.length ? '<div class="prod-warn">Not enough stock for: ' + esc(short.join('; ')) + '. Production cannot be confirmed.</div>' : '';
    if (btn) btn.disabled = bad || st.busy;
    return { ok: !bad, items: d.materials.map((m) => ({ sku: m.sku, actualQty: Number(document.querySelector('[data-actual="' + m.sku + '"]').value) })) };
  }

  function showBanner(msg) {
    const b = $('movementFormError');
    if (b) { b.textContent = msg; b.classList.add('show'); }
  }
  const hideBanner = () => { const b = $('movementFormError'); if (b) b.classList.remove('show'); };

  async function submit() {
    if (st.busy) return;
    const d = st.data, form = $('movementForm');
    hideBanner();
    if (!d || !st.key) { showBanner('Choose the finished product and enter the quantity produced first.'); return; }
    const status = refreshStatus();
    if (!status.ok) { showBanner(d.hasRequirements ? 'Fix the highlighted material quantities first.' : 'Add the materials needed to this product first (Products > Edit).'); return; }
    const lines = d.materials.map((m, i) => [m.name, '\u2212' + fmt(status.items[i].actualQty) + ' ' + m.unit]).concat([[d.name + ' (Finished Goods)', '+' + fmt(d.quantity) + ' ' + d.unit]]);
    if (!(await uiConfirm({ title: 'Confirm production', message: 'Record ' + fmt(d.quantity) + ' ' + d.unit + ' of ' + d.name + ' as produced internally. These materials are deducted now and cannot be undone here:', lines, confirm: 'Confirm production' }))) return;
    st.busy = true;
    const btn = $('movementSubmitBtn'); if (btn) btn.disabled = true;
    try {
      const r = await api('/production', { method: 'POST', body: JSON.stringify({ sku: d.sku, quantity: d.quantity, items: status.items, requestKey: st.key }) });
      toast(r.duplicate ? 'Already recorded as ' + r.ref + ' — nothing was deducted again.' : 'Production ' + r.ref + ' confirmed. Materials deducted and ' + fmt(d.quantity) + ' ' + d.unit + ' added.');
      st.data = null; st.key = null; st.edited = {};
      form.reset();
      await B().reload();
      loadHistory();
    } catch (err) {
      const f = err.fields || {};
      Object.keys(f).forEach((k) => {
        if (k.indexOf('mat:') !== 0) return;
        const inp = document.querySelector('[data-actual="' + k.slice(4) + '"]'), cell = document.querySelector('[data-status="' + k.slice(4) + '"]');
        if (inp) inp.classList.add('bad');
        if (cell) cell.innerHTML = '<span class="prod-bad">' + esc(f[k]) + '</span>';
      });
      showBanner(err.message + ' Nothing was deducted.');
      st.busy = false;
      if (btn) btn.disabled = false;
    } finally { st.busy = false; }
  }

  // the form is handled here (document capture runs before the form's own listeners)
  document.addEventListener('submit', (e) => {
    if (!e.target || e.target.id !== 'movementForm' || !isFGIn()) return;
    if (!source()) {
      e.preventDefault(); e.stopImmediatePropagation();
      showBanner('Choose the Stock-In Source.');
      const s = $('movementSource'); if (s) s.focus();
      return;
    }
    if (source() === 'produced') { e.preventDefault(); e.stopImmediatePropagation(); submit(); }
  }, true);

  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'movementSource') {
      hideBanner();
      $('movementReason').dispatchEvent(new Event('change'));       // re-runs the form logic (supplier box, note box ...)
    }
  });

  // the materials list now lives in the product form: open "Edit product" for this finished good
  function goToRequirements(sku) {
    if (typeof openNewProductModal === 'function') openNewProductModal(sku);
  }

  /* =====================================================
     PRODUCTION HISTORY
  ===================================================== */
  let history = [];
  const open = new Set();

  async function loadHistory() {
    try { history = await api('/production?limit=200'); renderHistory(); }
    catch (err) { console.warn('[production]', err.message); }
  }

  const summary = (list) => !list.length ? '<span class="dim">—</span>' :
    esc(list.slice(0, 2).map((m) => m.name + ' ' + fmt(m.actual) + ' ' + m.unit).join(', ')) + (list.length > 2 ? ' <span class="dim">+' + (list.length - 2) + ' more</span>' : '');

  let prodDetailOverlay = null;
  function ensureProdDetailModal() {
    if (prodDetailOverlay) return prodDetailOverlay;
    prodDetailOverlay = document.createElement('div');
    prodDetailOverlay.className = 'modal-overlay';
    prodDetailOverlay.id = 'prodDetailOverlay';
    prodDetailOverlay.innerHTML =
      '<div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="prdTitle" style="max-width:680px">' +
        '<button type="button" class="modal-close" id="prdClose" aria-label="Close">×</button>' +
        '<div id="prdBody"></div>' +
      '</div>';
    document.body.appendChild(prodDetailOverlay);
    const close = () => {
      prodDetailOverlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    };
    prodDetailOverlay.addEventListener('click', (e) => { if (e.target === prodDetailOverlay) close(); });
    prodDetailOverlay.querySelector('#prdClose').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && prodDetailOverlay.classList.contains('open')) close();
    });
    return prodDetailOverlay;
  }

  function openProductionDetails(ref) {
    const h = (history || []).find((x) => x.ref === ref);
    if (!h) return;
    const overlay = ensureProdDetailModal();
    const all = h.rawMaterials.concat(h.finishingSupplies);
    const row = (dt, dd) => '<div class="pd-row"><dt>' + dt + '</dt><dd>' + dd + '</dd></div>';

    overlay.querySelector('#prdBody').innerHTML =
      '<div class="supplier-modal-head">' +
        '<div class="supplier-modal-icon">' +
          '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="modal-eyebrow">Production Batch Record · Finished Goods</div>' +
          '<h2 class="modal-title" id="prdTitle" style="margin-bottom:0;">' + esc(h.product) + '</h2>' +
          '<div class="pd-sub"><span class="mono">' + esc(h.ref) + '</span> ' +
            '<span class="status-pill in">+' + esc(fmt(h.quantity)) + ' ' + esc(h.unit) + ' Confirmed</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<dl class="pd-grid" style="margin-bottom:16px">' +
        row('Finished Good Stock-In', '<span class="mono">' + esc(h.stockInRef || '—') + '</span>') +
        row('Recorded By', esc(h.recordedBy)) +
        row('Production Date', esc(h.dateTime)) +
        row('Total Output', '<b>+' + esc(fmt(h.quantity)) + ' ' + esc(h.unit) + '</b>') +
      '</dl>' +
      '<div style="font-weight:600;font-size:13.5px;color:var(--text);margin:14px 0 8px">Materials &amp; Supplies Deducted</div>' +
      '<div class="table-wrapper" style="border:1px solid var(--border);border-radius:8px;max-height:280px;overflow-y:auto">' +
        '<table style="margin:0;font-size:13px">' +
          '<thead><tr><th>Material</th><th>Category</th><th>Per unit</th><th>Calculated</th><th>Actual used</th><th>Stock-Out ref</th></tr></thead>' +
          '<tbody>' +
            (all.length ? all.map((m) => '<tr>' +
              '<td style="font-weight:500">' + esc(m.name) + '</td>' +
              '<td class="dim">' + esc(m.department) + '</td>' +
              '<td class="dim">' + esc(fmt(m.perUnit)) + ' ' + esc(m.unit) + '</td>' +
              '<td class="dim">' + esc(fmt(m.calculated)) + ' ' + esc(m.unit) + '</td>' +
              '<td><b>' + esc(fmt(m.actual)) + ' ' + esc(m.unit) + '</b></td>' +
              '<td class="mono dim">' + esc(m.movementRef || '—') + '</td>' +
            '</tr>').join('') : '<tr><td colspan="6" class="dim" style="text-align:center;padding:16px">No materials were recorded.</td></tr>') +
          '</tbody>' +
        '</table>' +
      '</div>' +
      (h.note ? '<div class="pd-note" style="margin-top:12px"><b>Production note:</b> ' + esc(h.note) + '</div>' : '') +
      '<div class="modal-footer" style="margin-top:18px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="btn-secondary" id="prdCloseBtn">Close</button>' +
      '</div>';

    overlay.querySelector('#prdCloseBtn').addEventListener('click', () => {
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

  function renderHistory() {
    const body = $('prodHistBody'); if (!body) return;
    const term = (($('prodHistSearch') || {}).value || '').trim().toLowerCase();
    const rows = history.filter((h) => !term || h.ref.toLowerCase().indexOf(term) >= 0 || h.product.toLowerCase().indexOf(term) >= 0);
    const sub = $('prodHistSub'); if (sub) sub.textContent = 'Showing ' + rows.length + ' of ' + history.length + ' confirmed production records';
    if (!rows.length) { body.innerHTML = '<tr><td colspan="9" class="dim" style="text-align:center;padding:24px">' + (history.length ? 'No records match your search.' : 'No production recorded yet.') + '</td></tr>'; return; }
    body.innerHTML = rows.map((h) => {
      return '<tr class="prod-row" data-prod-ref="' + esc(h.ref) + '" style="cursor:pointer">' +
        '<td class="mono">' + esc(h.ref) + '</td><td>' + esc(h.product) + '</td>' +
        '<td class="dim">+' + esc(fmt(h.quantity)) + ' ' + esc(h.unit) + '</td>' +
        '<td class="dim">' + summary(h.rawMaterials) + '</td><td class="dim">' + summary(h.finishingSupplies) + '</td>' +
        '<td class="dim">' + esc(h.dateTime) + '</td><td class="dim">' + esc(h.recordedBy) + '</td>' +
        '<td><span class="status-pill in">Confirmed</span></td>' +
        '<td><button type="button" class="btn-secondary btn-sm" data-prod-ref="' + esc(h.ref) + '">Details</button></td></tr>';
    }).join('');

    body.querySelectorAll('tr.prod-row').forEach((row) => row.addEventListener('click', (e) => {
      openProductionDetails(row.dataset.prodRef);
    }));
  }

  /* ---------- start ---------- */
  function init() {
    if (!$('movementForm') || !window.TripleEBridge) return;
    if ($('prodHistSearch')) $('prodHistSearch').addEventListener('input', renderHistory);
    loadHistory();
    window.addEventListener('focus', loadHistory);
    // materials changed in the product form: a preview for that product must be recalculated
    document.addEventListener('triplee:materials-saved', () => { st.data = null; if (isProduction()) afterSync(); });
  }

  window.ProductionUI = { beforeSync, afterSync, isProduction, submit };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
