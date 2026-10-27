/* quick-stock.js — shortcut: double-click a product row in Inventory Monitoring to record Stock In / Stock Out.

   Window 1: choose Stock In or Stock Out, quantity, reason (and supplier / invoice for a supplier delivery, note when the reason needs one).
   Window 2: "Are you sure you want to proceed?" with a recap. Only "Yes, save" writes the movement (POST /api/movements),
   the same call the Stock In / Out page makes, so the server checks, the reference number and the audit log are identical.
   The reason list and supplier list follow the product (department / linked suppliers) exactly like the full form.
   Finished Goods + Stock In + "Produced Internally" also works here: the window shows the materials that will be used
   (editable "actual used"), and saving goes through POST /api/production, which deducts them in one transaction. */
(function () {
  'use strict';
  const B = () => (typeof window !== "undefined" ? window.TripleEBridge : null);
  const $ = (id) => document.getElementById(id);
  let item = null, type = 'in', step = 'form', busy = false, overlay = null;
  const PRODUCED = 'produced_batch';
  const PRODUCED_HINT = 'Made in our own workshop. The materials used are deducted automatically when you confirm.';
  const prod = { data: null, edited: {}, key: null, seq: 0, timer: null };
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 14)));
  const fmt = (n) => String(+Number(n).toFixed(4));
  const prodResetState = () => { clearTimeout(prod.timer); prod.seq++; prod.data = null; prod.edited = {}; prod.key = null; };
  const isProduced = () => type === 'in' && !!$('qsReason') && $('qsReason').value === PRODUCED;
  const prodQtyOk = (n) => Number.isFinite(n) && n > 0 && n <= 1e6 && Math.abs(n * 100 - Math.round(n * 100)) <= 1e-6;

  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const esc = (v) => (B() && B().esc ? B().esc(v) : String(v == null ? "" : v).replace(/[&<>"']/g, ""));

  function build() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'quickStockOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = '<div class="account-modal qs-modal" id="qsModal"></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !busy) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open') && !busy) close(); });
  }
  function close() { if (overlay) overlay.classList.remove('open'); item = null; step = 'form'; }

  function calcSuggestedStockIn(it) {
    if (!it) return null;
    const onHand = Number(it.onHand) || 0;
    const reorder = Number(it.reorderLevel) || 0;
    const unit = it.unit || 'units';

    let baseQty = 0;
    let reason = '';
    let isShortage = false;

    if (reorder > 0 && onHand <= reorder) {
      isShortage = true;
      const deficit = Math.max(1, Math.round(reorder - onHand));
      baseQty = deficit;
      reason = 'Replenish deficit (' + num(deficit) + ' ' + esc(unit) + ' to reorder level)';
    } else {
      // Stock is healthy: supplier standard order batch / standard pallet / MOQ calculation
      if (reorder >= 1000) {
        baseQty = Math.round((reorder * 0.5) / 50) * 50;
      } else if (reorder >= 200) {
        baseQty = Math.round((reorder * 0.5) / 25) * 25;
      } else if (reorder >= 50) {
        baseQty = Math.round((reorder * 0.5) / 10) * 10;
      } else if (reorder > 0) {
        baseQty = Math.max(5, Math.round(reorder));
      } else {
        const u = String(unit).toLowerCase();
        if (u === 'kg') baseQty = 500;
        else if (u === 'g') baseQty = 1000;
        else if (u === 't' || u.indexOf('ton') !== -1) baseQty = 1;
        else if (u === 'm' || u.indexOf('meter') !== -1) baseQty = 50;
        else if (u === 'l' || u.indexOf('liter') !== -1) baseQty = 100;
        else baseQty = 50;
      }
      baseQty = Math.max(1, baseQty);
      reason = 'Supplier standard batch (' + num(baseQty) + ' ' + esc(unit) + ')';
    }

    const half = Math.max(1, Math.round(baseQty * 0.5));
    const dbl = Math.max(1, Math.round(baseQty * 2));
    const rawLots = [half, baseQty, dbl];
    const lots = [];
    for (let i = 0; i < rawLots.length; i++) {
      if (lots.indexOf(rawLots[i]) === -1) lots.push(rawLots[i]);
    }
    lots.sort((a, b) => a - b);

    return {
      qty: baseQty,
      isShortage: isShortage,
      reason: reason,
      lots: lots
    };
  }

  const reasons = () => B().reasonsFor(type, item.department).map((r) => r.key === PRODUCED ? Object.assign({}, r, { label: 'Produced Internally', help: PRODUCED_HINT }) : r);

  function renderForm(keep) {
    keep = keep || {};
    const suggestion = type === 'in' ? calcSuggestedStockIn(item) : null;
    if (type === 'in' && !keep.qty && suggestion) {
      keep.qty = suggestion.qty;
    }
    const rs = reasons();
    const modal = $('qsModal');

    let suggestHtml = '';
    if (suggestion) {
      suggestHtml =
        '<div class="qs-suggest-bar" id="qsSuggestBar">' +
        '<span class="qs-suggest-label">Suggested:</span>' +
        '<button type="button" class="qs-suggest-chip" id="qsUseSuggested" title="Click to use suggested standard quantity" data-qty="' + suggestion.qty + '">' +
        '<strong>' + num(suggestion.qty) + ' ' + esc(item.unit) + '</strong>' +
        '</button>' +
        '<span class="qs-suggest-reason">(' + esc(suggestion.reason) + ')</span>' +
        '<div class="qs-chips" aria-label="Quick batch lots">' +
        suggestion.lots.map((q) => '<button type="button" class="qs-chip-sm" data-qs-fill="' + q + '" title="Set ' + num(q) + ' ' + esc(item.unit) + '">' + num(q) + '</button>').join('') +
        '</div></div>';
    }

    modal.innerHTML =
      '<button type="button" class="modal-close" id="qsClose" aria-label="Close">×</button>' +
      '<div class="qs-head"><div class="modal-eyebrow">Quick stock entry</div><h2>' + esc(item.name) + '</h2>' +
      '<div class="qs-meta"><span>' + esc(item.sku) + '</span><span>' + esc(item.department) + '</span><span>On hand: <b>' + num(item.onHand) + ' ' + esc(item.unit) + '</b></span></div></div>' +
      '<div class="segmented" id="qsType"><button type="button" class="seg-btn seg-in' + (type === 'in' ? ' active' : '') + '" data-type="in">Stock In</button>' +
      '<button type="button" class="seg-btn seg-out' + (type === 'out' ? ' active' : '') + '" data-type="out">Stock Out</button></div>' +
      '<form id="qsForm" novalidate autocomplete="off">' +
      '<div class="qs-row"><div class="form-group"><label class="form-label" for="qsQty">Quantity <span class="required-mark">*</span></label>' +
      '<input type="number" inputmode="decimal" id="qsQty" class="form-input" min="0" step="any" placeholder="e.g. 500" value="' + esc(keep.qty || '') + '"></div>' +
      '<div class="form-group"><label class="form-label" for="qsUnit">Unit</label><input type="text" id="qsUnit" class="form-input" readonly tabindex="-1" value="' + esc(item.unit) + '"></div></div>' +
      suggestHtml +
      '<div class="form-group"><label class="form-label" for="qsReason">Reason <span class="required-mark">*</span></label>' +
      '<select id="qsReason" class="form-select"><option value="">' + (type === 'out' ? 'Why is this stock going out?' : 'Why is this stock coming in?') + '</option>' +
      rs.map((r) => '<option value="' + esc(r.key) + '"' + (keep.reason === r.key ? ' selected' : '') + '>' + esc(r.label) + '</option>').join('') + '</select>' +
      '<div class="field-hint" id="qsReasonHint"></div></div>' +
      '<div id="qsReceipt" hidden><div class="form-group"><label class="form-label" for="qsSupplier">Supplier <span class="required-mark">*</span></label>' +
      '<select id="qsSupplier" class="form-select"></select><div class="field-hint" id="qsSupplierHint"></div></div>' +
      '<div class="form-group"><label class="form-label" for="qsInvoice">Invoice / delivery no.</label>' +
      '<input type="text" id="qsInvoice" class="form-input" maxlength="40" placeholder="Supplier\u2019s document no." value="' + esc(keep.invoice || '') + '"></div></div>' +
      '<div id="qsProd" class="prod-preview" hidden></div>' +
      '<div class="form-group" id="qsNoteWrap" hidden><label class="form-label" for="qsNote">Note <span class="required-mark">*</span></label>' +
      '<textarea id="qsNote" class="form-textarea" rows="2" maxlength="300" placeholder="Explain what happened (required)…">' + esc(keep.note || '') + '</textarea></div>' +
      '<div class="qs-summary"><span>After this entry</span><b id="qsAfter">—</b></div>' +
      '<p class="qs-error" id="qsError" role="alert"></p>' +
      '<div class="modal-footer"><button type="button" class="btn-secondary" id="qsCancel">Cancel</button>' +
      '<button type="submit" class="btn-primary" id="qsNext">Continue</button></div></form>';
    $('qsClose').onclick = $('qsCancel').onclick = () => close();
    $('qsType').onclick = (e) => {
      const b = e.target.closest('.seg-btn'); if (!b || b.dataset.type === type) return;
      type = b.dataset.type; renderForm({ qty: $('qsQty').value, note: $('qsNote').value });   // reasons differ for in / out
    };
    $('qsReason').onchange = sync; $('qsQty').oninput = sync; $('qsSupplier').onchange = clearErr;
    $('qsInvoice').oninput = clearErr; $('qsNote').oninput = clearErr;
    $('qsForm').onsubmit = (e) => { e.preventDefault(); toConfirm(); };
    if (window.FormAssist) {
      const rules = {
        qsQty: () => {
          const v = read();
          if (!$('qsQty').value || !isFinite(v.qty) || v.qty <= 0) return 'Enter a quantity greater than zero.';
          if (v.produced && !prodQtyOk(v.qty)) return 'Quantity produced can have at most 2 decimals.';
          return type === 'out' && v.qty > item.onHand ? 'Only ' + num(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + num(v.qty) + '.' : '';
        },
        qsReason: () => $('qsReason').value ? '' : type === 'out' ? 'Choose why this stock is going out.' : 'Choose why this stock is coming in.',
        qsSupplier: () => type === 'in' && $('qsReason').value === 'supplier_receipt' && !$('qsSupplier').value ? 'Choose the supplier this delivery came from.' : '',
        qsNote: () => B().noteRequired($('qsReason').value) && read().note.length < 3 ? 'Please explain this entry in the note.' : '',
        qsInvoice: () => $('qsInvoice').value.trim().length > 40 ? 'Invoice / delivery no. must be at most 40 characters.' : ''
      };
      const checks = Object.fromEntries(Object.keys(rules).map((id) => [id, FormAssist.validation.bind($(id), rules[id])]));
      $('qsReason').addEventListener('change', () => Object.values(checks).forEach((check) => check(false)));
      $('qsForm').addEventListener('submit', () => Object.values(checks).forEach((check) => check(true)), true);
    }

    const suggestBar = $('qsSuggestBar');
    if (suggestBar) {
      suggestBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-qs-fill], #qsUseSuggested');
        if (!btn) return;
        const val = btn.dataset.qsFill || btn.dataset.qty;
        if (val) {
          const inp = $('qsQty');
          inp.value = val;
          sync();
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.focus();
          inp.select();
        }
      });
    }

    sync();
    if (keep.supplier && $('qsSupplier').querySelector('option[value="' + keep.supplier + '"]')) $('qsSupplier').value = keep.supplier;
    setTimeout(() => {
      const q = $('qsQty');
      if (q) {
        q.focus();
        if (q.value) q.select();
      }
    }, 30);
  }

    const clearErr = () => { const e = $('qsError'); if (e) e.textContent = ''; };

  // show / hide the supplier + note boxes for the chosen reason and update the "after" figure
  function sync() {
    clearErr();
    const reason = $('qsReason').value, qty = Number($('qsQty').value) || 0;
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    $('qsReceipt').hidden = !isReceipt;
    if (isReceipt) {
      const sel = $('qsSupplier'), m = B().suppliersFor(item), prev = sel.value;
      sel.innerHTML = '<option value="">' + (m.anyActive ? 'Select the supplier…' : 'No active suppliers yet') + '</option>' +
        m.list.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
      if (prev && m.list.some((s) => s.id === prev)) sel.value = prev; else if (m.linkedOnly && m.list.length === 1) sel.value = m.list[0].id;
      $('qsSupplierHint').textContent = m.linkedOnly ? 'Showing only suppliers that supply this product.' : 'No supplier is linked to this product yet — showing all active suppliers.';
    }
    $('qsNoteWrap').hidden = !B().noteRequired(reason);
    const produced = isProduced();
    $('qsModal').classList.toggle('qs-wide', produced);
    $('qsProd').hidden = !produced;
    if (produced) prodSync(); else { clearTimeout(prod.timer); $('qsNext').disabled = false; }
    const r = reasons().find((x) => x.key === reason);
    $('qsReasonHint').textContent = r ? r.help : '';
    const after = item.onHand + (type === 'in' ? qty : -qty), a = $('qsAfter');
    a.textContent = qty ? num(Math.max(after, 0)) + ' ' + item.unit + (after < 0 ? ' (not enough stock)' : '') : '—';
    a.className = after < 0 ? 'bad' : '';
  }

  /* ---------- Produced Internally: material preview ---------- */
  function prodSync() {
    const box = $('qsProd'), qty = Number($('qsQty').value);
    if (!prodQtyOk(qty)) {
      prodResetState(); $('qsNext').disabled = true;
      box.innerHTML = '<div class="prod-info">' + ($('qsQty').value ? 'Enter a quantity greater than zero (up to 2 decimals).' : 'Enter the quantity produced to see the materials that will be used.') + '</div>';
      return;
    }
    if (prod.data && prod.data.sku === item.sku && prod.data.quantity === qty) { prodRender(); return; }
    clearTimeout(prod.timer); $('qsNext').disabled = true;
    prod.timer = setTimeout(() => prodFetch(qty), 350);
  }
  async function prodFetch(qty) {
    const box = $('qsProd'), my = ++prod.seq;
    box.innerHTML = '<div class="prod-info">Calculating materials…</div>';
    try {
      const d = await B().api('/production/preview', { method: 'POST', body: JSON.stringify({ sku: item.sku, quantity: qty }) });
      if (my !== prod.seq || !$('qsProd')) return;
      prod.data = d; prod.edited = {}; prod.key = newKey(); prodRender();
    } catch (err) {
      if (my !== prod.seq || !$('qsProd')) return;
      prod.data = null; box.innerHTML = '<div class="prod-warn">' + esc(err.message) + '</div>';
    }
  }
  function prodRender() {
    const d = prod.data, box = $('qsProd'); if (!d || !box) return;
    let html = '<h4>Materials used for ' + esc(fmt(d.quantity)) + ' ' + esc(d.unit) + ' of ' + esc(d.name) + '</h4>';
    if (!d.hasRequirements) {
      box.innerHTML = html + '<div class="prod-warn">No materials are set for this product yet, so the materials used cannot be calculated. Add them first in Products > Edit product > Materials Needed.</div>';
      $('qsNext').disabled = true; return;
    }
    html += '<div class="prod-scroll"><table class="prod-table"><thead><tr><th>Material</th><th>Calculated</th><th>Actual used</th><th>Available</th><th>Status</th></tr></thead><tbody>' +
      d.materials.map((m) => {
        const val = prod.edited[m.sku] !== undefined ? prod.edited[m.sku] : m.calculated;
        return '<tr><td>' + esc(m.name) + '</td><td class="dim">' + esc(fmt(m.calculated)) + ' ' + esc(m.unit) + '</td>' +
          '<td><input type="number" class="prod-in" data-qsact="' + esc(m.sku) + '" min="0" step="any" inputmode="decimal" value="' + esc(val) + '"> ' + esc(m.unit) + '</td>' +
          '<td class="dim">' + esc(fmt(m.onHand)) + ' ' + esc(m.unit) + '</td><td data-qsst="' + esc(m.sku) + '"></td></tr>';
      }).join('') + '</tbody></table></div><div id="qsShort"></div>' +
      '<p class="prod-note">Change “Actual used” if the real consumption was different. Nothing is deducted until you confirm.</p>';
    box.innerHTML = html;
    box.querySelectorAll('[data-qsact]').forEach((inp) => inp.addEventListener('input', () => { prod.edited[inp.dataset.qsact] = inp.value; prod.key = newKey(); prodStatus(); clearErr(); }));
    prodStatus();
  }
  // paints each row's status; returns { ok, items } and enables / disables Continue
  function prodStatus() {
    const d = prod.data; if (!d || !d.hasRequirements) return { ok: false, items: [] };
    const short = [], items = []; let bad = false;
    d.materials.forEach((m) => {
      const inp = document.querySelector('[data-qsact="' + m.sku + '"]'), cell = document.querySelector('[data-qsst="' + m.sku + '"]');
      if (!inp || !cell) { bad = true; return; }
      const raw = inp.value, n = Number(raw); let msg = 'OK', cls = 'prod-ok';
      if (m.archived) { msg = 'Archived material'; cls = 'prod-bad'; }
      else if (m.unitChanged) { msg = 'Unit changed — save the product\'s materials again'; cls = 'prod-bad'; }
      else if (raw === '' || !Number.isFinite(n) || n < 0) { msg = 'Enter 0 or more'; cls = 'prod-bad'; }
      else if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) { msg = 'Max 2 decimals'; cls = 'prod-bad'; }
      else if (n > m.onHand) { msg = 'Short by ' + fmt(n - m.onHand) + ' ' + m.unit; cls = 'prod-bad'; short.push(m.name); }
      if (cls === 'prod-bad') bad = true;
      cell.innerHTML = '<span class="' + cls + '">' + esc(msg) + '</span>'; inp.classList.toggle('bad', cls === 'prod-bad');
      items.push({ sku: m.sku, actualQty: n });
    });
    const sb = $('qsShort'); if (sb) sb.innerHTML = short.length ? '<div class="prod-warn">Not enough stock for: ' + esc(short.join(', ')) + '. Production cannot be confirmed.</div>' : '';
    if ($('qsNext')) $('qsNext').disabled = bad;
    return { ok: !bad, items };
  }

  function read() {
    const reason = $('qsReason').value, qty = Number($('qsQty').value);
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    const supSel = $('qsSupplier');
    return { qty, reason, reasonLabel: ($('qsReason').selectedOptions[0] || {}).text || '', note: $('qsNote').value.trim().replace(/\s+/g, ' '),
      supplier: isReceipt ? supSel.value : '', supplierName: isReceipt && supSel.selectedOptions[0] ? supSel.selectedOptions[0].text : '',
      invoice: isReceipt ? $('qsInvoice').value.trim() : '', produced: type === 'in' && reason === PRODUCED };
  }
  function problem(v) {
    if (!$('qsQty').value || !isFinite(v.qty) || v.qty <= 0) return ['qsQty', 'Enter a quantity greater than zero.'];
    if (v.produced) {
      if (!prodQtyOk(v.qty)) return ['qsQty', 'Quantity produced can have at most 2 decimals.'];
      if (!prod.data || !prod.key || prod.data.quantity !== v.qty) return ['qsQty', 'Wait for the materials to be calculated.'];
      if (!prod.data.hasRequirements) return ['qsReason', 'Add the materials needed first (Products > Edit product).'];
      if (!prodStatus().ok) return ['qsReason', 'Fix the highlighted material quantities first.'];
    }
    if (type === 'out' && v.qty > item.onHand) return ['qsQty', 'Only ' + num(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + num(v.qty) + '.'];
    if (!v.reason) return ['qsReason', type === 'out' ? 'Choose why this stock is going out.' : 'Choose why this stock is coming in.'];
    if (type === 'in' && v.reason === 'supplier_receipt' && !v.supplier) return ['qsSupplier', 'Choose the supplier this delivery came from.'];
    if (B().noteRequired(v.reason) && v.note.length < 3) return ['qsNote', 'Please explain this entry in the note.'];
    return null;
  }

  // window 2: "are you sure?"
  function toConfirm() {
    const v = read(), p = problem(v);
    if (p) { $('qsError').textContent = p[1]; $(p[0]).focus(); return; }
    step = 'confirm';
    const mats = v.produced ? prodStatus().items : [];
    v.items = mats;                                   // the material boxes disappear once this window is drawn, so keep the quantities
    const after = item.onHand + (type === 'in' ? v.qty : -v.qty);
    const line = (k, val, cls) => '<div><span>' + k + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + val + '</b></div>';
    $('qsModal').innerHTML =
      '<button type="button" class="modal-close" id="qsClose" aria-label="Close">×</button>' +
      '<div class="qs-confirm"><div class="qs-confirm-ico" aria-hidden="true">?</div><h3>Do you want to proceed?</h3>' +
      '<p>This ' + (type === 'in' ? 'adds to' : 'removes from') + ' stock.' + (v.produced ? ' The materials listed below are deducted at the same time.' : '') + ' Please check the details before saving.</p>' +
      '<div class="qs-recap">' + line('Product', esc(item.name)) + line('Movement', type === 'in' ? 'Stock In' : 'Stock Out', type) +
      line('Quantity', num(v.qty) + ' ' + esc(item.unit)) + line('Reason', esc(v.reasonLabel)) +
      (v.supplierName ? line('Supplier', esc(v.supplierName)) : '') + (v.invoice ? line('Invoice / delivery no.', esc(v.invoice)) : '') +
      (v.note ? line('Note', esc(v.note)) : '') +
      (v.produced ? line('Materials deducted', prod.data.materials.map((m, i) => '-' + fmt(mats[i].actualQty) + ' ' + esc(m.unit) + ' ' + esc(m.name)).join('<br>')) : '') +
      line('Stock after', num(Math.max(after, 0)) + ' ' + esc(item.unit)) + '</div>' +
      '<p class="qs-error" id="qsError" role="alert"></p></div>' +
      '<div class="modal-footer"><button type="button" class="btn-secondary" id="qsBack">Go back</button>' +
      '<button type="button" class="btn-primary" id="qsConfirm">Yes, save it</button></div>';
    $('qsClose').onclick = () => { if (!busy) close(); };
    $('qsBack').onclick = () => { step = 'form'; renderForm({ qty: String(v.qty), reason: v.reason, note: v.note, invoice: v.invoice, supplier: v.supplier }); };
    $('qsConfirm').onclick = () => save(v);
    $('qsConfirm').focus();
  }

  async function save(v) {
    if (busy) return;
    busy = true; const btn = $('qsConfirm'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (v.produced) {
        const pr = await B().api('/production', { method: 'POST', body: JSON.stringify({ sku: item.sku, quantity: prod.data.quantity, items: v.items, requestKey: prod.key }) });
        const unit = item.unit, q = fmt(prod.data.quantity);
        busy = false; close(); prodResetState();
        B().toast(pr.duplicate ? 'Already recorded as ' + pr.ref + ' — nothing was deducted again.' : 'Production ' + pr.ref + ' confirmed. Materials deducted and ' + q + ' ' + unit + ' added.');
        await B().reload(); return;
      }
      const r = await B().api('/movements', { method: 'POST', body: JSON.stringify({ sku: item.sku, type, reason: v.reason, quantity: v.qty, note: v.note,
        supplier: v.supplier || undefined, invoiceNo: v.invoice || undefined }) });
      busy = false; close(); B().toast('Saved. Reference no. ' + r.ref); await B().reload();
    } catch (err) {
      busy = false; btn.disabled = false; btn.textContent = 'Yes, save it';
      const f = err.fields && Object.values(err.fields)[0];
      $('qsError').textContent = f || err.message || 'Could not save. Please try again.';
    }
  }

  function open(sku) {
    const found = B() && B().inventory().find((i) => i.sku === sku);
    if (!found) return;
    build(); item = found; type = 'in'; step = 'form'; prodResetState();
    renderForm();
    overlay.classList.add('open');
  }

  if (typeof document !== "undefined") {
    document.addEventListener('dblclick', (e) => {
      const row = e.target.closest && e.target.closest('#stockLevelsTableBody tr[data-sku]');
      if (!row) return;
      const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges();      // double-click also selects a word: clear it
      open(row.dataset.sku);
    });
  }

  if (typeof window !== "undefined") {
    window.QuickStock = { open, calcSuggestedStockIn };
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { calcSuggestedStockIn };
  }
})();