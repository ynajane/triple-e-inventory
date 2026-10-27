/* api-bridge.js — connects the pages in script.js to the Triple E API.
   Loaded AFTER script.js in Finance_Inventory.html:
       <script src="script.js"></script>
       <script src="api-bridge.js"></script>
*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const FA = window.FormAssist;                  // form-assist.js (Task 9 form helpers); every use checks it is there
  const esc = (v) => (typeof escapeHTML === 'function' ? escapeHTML(String(v)) : String(v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'));
  const NEEDS_SUPPLIER = ['Raw Materials', 'Finishing Supplies'];
  const DEPARTMENTS = ['Raw Materials', 'Finished Goods', 'Finishing Supplies'];
  const NOTE_REQUIRED = ['other'];

  let REASONS = { in: {}, out: {} };
  const ALL_D = DEPARTMENTS;
  // Which departments each reason applies to. The server sends the same table; this copy is the fallback,
  // so the form still filters correctly (and ignores retired reasons) if an older server is running.
  const DEFAULT_REASON_DEPTS = {
    in: {
      supplier_receipt: ['Raw Materials', 'Finishing Supplies'], // finished goods are produced in-house
      customer_return: ['Finished Goods'],
      produced_batch: ['Finished Goods'],
      other: ALL_D
    },
    out: {
      rust_corrosion: ['Raw Materials', 'Finished Goods'],
      damaged: ALL_D,
      scrap_cutting_waste: ['Raw Materials'],
      quality_rejection: ['Raw Materials', 'Finished Goods'],
      lost_missing: ALL_D,
      returned_to_supplier: ['Raw Materials', 'Finishing Supplies'],
      other: ALL_D
    }
  };
  let REASON_DEPTS = DEFAULT_REASON_DEPTS;
  let inventoryCache = [];
  let CATEGORIES = [];
  const NEW_CATEGORY = '__new__';
  let movementCache = [];
  let quotesCache = [];     // custom quote requests with their payments (counted in the sales reports once money is received)
  let salesCache = [];      // every POS sale + online order from /api/sales (used by the Sales Transaction Report)
  let currentUser = null;
  let avatarState = { has: false, v: 0 };   // profile photo (stored in the users table)

  /* ---------------- helpers ---------------- */
  async function api(path, options) {
    const res = await fetch('/api' + path, Object.assign(
      { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields, status: res.status });
    return data;
  }
  const replace = (arr, rows) => arr.splice(0, arr.length, ...rows);
  const safe = (fn) => { try { fn(); } catch (e) { console.warn('[api-bridge]', e.message); } };
  // small helper set for production-admin.js (production / material requirements)
  window.TripleEBridge = { api, toast, esc, inventory: () => inventoryCache, reload: () => load(), movementType: () => movementType(),
    // used by quick-stock.js (double-click a row in Inventory Monitoring)
    reasonsFor: (type, dept) => reasonKeysFor(type, dept).map((k) => ({ key: k, label: REASONS[type][k], help: REASON_HELP[type + ':' + k] || '' })),
    noteRequired: (reason) => NOTE_REQUIRED.indexOf(reason) >= 0,
    suppliersFor: (item) => suppliersForItem(item),
    reloadUsers: () => (typeof window.reloadUserAccounts === "function" ? window.reloadUserAccounts() : null) };

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'app-toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  function clearErrors(root) {
    root.querySelectorAll('.field-msg').forEach((n) => n.remove());
    root.querySelectorAll('.field-invalid').forEach((n) => { n.classList.remove('field-invalid'); n.setAttribute('aria-invalid', 'false'); });
  }
  function setError(id, message) {
    const el = $(id);
    if (!el) return;
    el.classList.add('field-invalid');
    const group = el.closest('.form-group') || el.parentNode;
    group.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
    const msg = document.createElement('div');
    msg.className = 'field-msg';
    msg.dataset.for = id;
    msg.textContent = message;
    group.appendChild(msg);
  }
  // errors: { elementId: message }
  function showErrors(form, banner, errors, fallback) {
    clearErrors(form);
    const ids = Object.keys(errors);
    ids.forEach((id) => setError(id, errors[id]));
    if (banner) {
      banner.textContent = ids.length ? 'Please fix the highlighted fields.' : (fallback || 'Something went wrong.');
      banner.classList.add('show');
    }
    const first = ids.map($).find(Boolean);
    if (first && first.focus && first.tagName !== 'DIV') first.focus();
  }
  function hideBanner(banner) { if (banner) banner.classList.remove('show'); }
  function mapFields(fields, map) {
    const out = {};
    Object.keys(fields || {}).forEach((k) => { if (map[k]) out[map[k]] = fields[k]; });
    return out;
  }

  /* ---------------- client-side validation (mirrors the server rules) ---------------- */
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  function vText(errs, id, label, o) {
    o = Object.assign({ min: 1, max: 120, required: true }, o);
    const v = clean($(id) && $(id).value);
    if (!v) { if (o.required) errs[id] = label + ' is required'; return v; }
    if (v.length < o.min) errs[id] = label + ' must be at least ' + o.min + ' characters';
    else if (v.length > o.max) errs[id] = label + ' must be at most ' + o.max + ' characters';
    return v;
  }
  function vNum(errs, id, label, o) {
    o = Object.assign({ min: 0, max: 1e8, dp: 2, required: true, gt: false }, o);
    const box = $(id); let raw = box ? box.value : '';
    if (box && box.hasAttribute('data-money') && window.MoneyInput) raw = MoneyInput.raw(raw);     // money boxes show commas (2,000.00)
    if (raw === '' || raw == null) { if (o.required) errs[id] = label + ' is required'; return null; }
    // a quantity typed with a leading zero (05, 007, 00.5) is refused: type 5, 7 or 0.5. A plain 0 or 0.5 is fine.
    if (o.noLeadingZero && /^\s*0\d/.test(String(raw))) { errs[id] = label + ' cannot start with 0. Type ' + String(Number(raw)) + ', not ' + String(raw).trim(); return null; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { errs[id] = label + ' must be a number'; return null; }
    if (o.gt ? n <= o.min : n < o.min) { errs[id] = o.gt ? label + ' must be greater than ' + o.min : label + ' cannot be negative'; return null; }
    if (n > o.max) { errs[id] = label + ' is too large'; return null; }
    if (Math.round(n * Math.pow(10, o.dp)) / Math.pow(10, o.dp) !== n) { errs[id] = label + ' can have at most ' + o.dp + ' decimal places'; return null; }
    return n;
  }

  /* ---------------- loading data ---------------- */
  // Dashboard "Total Orders" card: online shop orders (and how many still need action) + POS sales
  function updateOrderStats() {
    const shop = salesCache.filter((t) => t.source === 'Shop');
    const done = ['Delivered', 'Picked Up', 'Cancelled', 'Completed'];
    Object.assign(dashboardMockDisplay, {
      orders: shop.length,
      ordersOpen: shop.filter((t) => done.indexOf(t.status) < 0).length,
      posSales: salesCache.filter((t) => t.source === 'POS').length
    });
    safe(renderDashboardStats);
  }

  async function load() {
    const me = await api('/auth/me');
    currentUser = me;
    safe(applyUser);
    const soft = (path, fallback) => api(path).catch((e) => {
      if (e.message === 'Not signed in') throw e;
      console.warn('[api-bridge] ' + path + ' failed: ' + e.message); return fallback;
    });
    const archivedRes = soft('/products?archived=1', archivedProductData.slice());
    const [inventory, products, suppliers, movements, audit, reasons, categories, salesRes] = await Promise.all([
      soft('/inventory', inventoryCache), soft('/products', productCatalogData.slice()),
      soft('/suppliers', supplierData.slice()), soft('/movements?limit=1000', movementCache),
      soft('/audit', auditLogData.slice()), soft('/reasons', REASONS), soft('/categories', CATEGORIES),
      soft('/sales', { sales: [] })]);
    salesCache = (salesRes && salesRes.sales) || [];
    replace(archivedProductData, Array.isArray(await archivedRes) ? await archivedRes : []);
    try { const qr = await api('/finance/quotes'); quotesCache = Array.isArray(qr) ? qr : []; } catch (e) { if (e.message === 'Not signed in') throw e; console.warn('[api-bridge] /finance/quotes failed: ' + e.message); }
    updateOrderStats();
    // dropdown list = categories table + any category already used by a product (so it is never empty if products exist)
    const catSet = new Map();
    (Array.isArray(categories) ? categories : []).concat(
      (Array.isArray(products) ? products : []).map((p) => p && p.category)
    ).forEach((c) => {
      c = clean(c);
      if (c && c !== 'Uncategorized' && !catSet.has(c.toLowerCase())) catSet.set(c.toLowerCase(), c);
    });
    CATEGORIES = Array.from(catSet.values()).sort((a, b) => a.localeCompare(b));
    safe(fillCategories);
    REASONS = reasons;
    REASON_DEPTS = reasons.depts || DEFAULT_REASON_DEPTS;
    inventoryCache = inventory;

    replace(inventoryMonitoringData, inventory);
    replace(productCatalogData, products);
    replace(supplierData, suppliers);
    replace(recentMovementMockData, movements.slice(0, 6));
    movementCache = movements;
    safe(renderMovementLog);
    safe(renderReports);
    if (typeof window.reloadUserAccounts === 'function') await window.reloadUserAccounts(false);
    replace(auditLogData, audit);

    const low = inventory.filter((i) => getStockStatus(i) === 'low');
    replace(lowStockMockData, low.slice(0, 6));
    Object.assign(dashboardMockDisplay, {
      totalSkus: inventory.length,
      departments: new Set(inventory.map((i) => i.department)).size,
      lowStock: low.length,
      movements: movements7d(movements),
      inventoryValue: inventory.reduce((s, i) => s + i.onHand * i.unitCost, 0)
    });
    const colors = { 'Raw Materials': '#4a90d9', 'Finished Goods': '#43c47a', 'Finishing Supplies': '#9b6bd1' };
    replace(dashboardHealthMock, Object.keys(colors).map((name) => {
      const items = inventory.filter((i) => i.department === name);
      return { name, total: items.length, healthy: items.filter((i) => getStockStatus(i) === 'ok').length, color: colors[name] };
    }).filter((d) => d.total > 0));

    safe(loadDashboard);
    safe(() => renderInventoryMonitoringStats(inventoryMonitoringData));
    safe(applyInventoryFilters);
    safe(renderCategoryPills); safe(applyCatalogFilters);
    safe(renderStockAlerts);
    safe(renderDashKpiTable);
    safe(renderWarehousePills); safe(applySupplierFilters);
    safe(renderAccountsTable);
    safe(applyAuditFilters);

    refreshMovementForm();
    return me;
  }

  /* =====================================================
     STOCK IN / STOCK OUT
     Flow: Department -> Product -> Reason.
     - the reason list follows the product's department (taken from the database), so only sensible reasons show
     - reference number is generated by the system
  ===================================================== */
  const movementType = () => {
    const t = $('movementTypeToggle');
    const active = t && t.querySelector('.seg-btn.active');
    return (active && active.dataset.type) || 'in';
  };
  const movementItem = () => inventoryCache.find((i) => i.sku === ($('movementProduct') || {}).value);

  // The department that decides the reasons: the chosen product's department, else the Department dropdown.
  const movementDepartment = () => {
    const item = movementItem();
    return item ? item.department : (($('movementDept') || {}).value || '');
  };
  // only reasons that have a department rule are offered (anything else, e.g. "Produced in-house", is ignored)
  const reasonKeysFor = (type, dept) => Object.keys(REASONS[type] || {}).filter((k) =>
    REASON_DEPTS[type] && REASON_DEPTS[type][k] && REASON_DEPTS[type][k].indexOf(dept) >= 0);

  // One short sentence under the Reason box saying what each choice means
  const REASON_HELP = {
    'in:supplier_receipt': 'New stock delivered by a supplier.',
    'in:customer_return': 'A customer sent finished goods back and they are going back on the shelf.',
    'in:produced_batch': 'Finished goods produced in a new batch and added to stock.',
    'in:other': 'Anything not listed. Note required: explain what happened.',
    'out:rust_corrosion': 'Stock lost to rust or corrosion.',
    'out:damaged': 'Bent, cracked or broken stock.',
    'out:scrap_cutting_waste': 'Offcuts and cutting waste that cannot be used.',
    'out:quality_rejection': 'Failed quality inspection.',
    'out:lost_missing': 'Cannot be found.',
    'out:returned_to_supplier': 'Sent back to the supplier.',
    'out:other': 'Anything not listed. Note required: explain what happened.'
  };

  // department dropdown: dynamically built from inventory data
  function fillMovementDepartments() {
    const select = $('movementDept');
    if (!select) return;
    const depts = [...new Set(inventoryCache.map((i) => i.department).filter(Boolean))].sort();
    const sig = depts.join(',');
    if (select.dataset.deptSig === sig) return;
    select.dataset.deptSig = sig;
    const prev = select.value;
    select.innerHTML = '<option value="">All departments</option>' +
      depts.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
    if (depts.indexOf(prev) >= 0) select.value = prev;
  }

  // product dropdown only lists products of the chosen department
  function fillMovementProducts() {
    const select = $('movementProduct');
    if (!select) return;
    const dept = ($('movementDept') || {}).value || '';
    const list = inventoryCache.filter((i) => !dept || i.department === dept);
    const sig = dept + '§' + list.map((i) => i.sku + '|' + i.name).join(';');
    if (select.dataset.sig === sig) return;
    select.dataset.sig = sig;
    const prev = select.value;
    select.innerHTML = '<option value="">' + (list.length ? 'Select a product…' : 'No products in ' + (dept || 'stock') + ' yet') + '</option>' +
      list.map((i) => '<option value="' + esc(i.sku) + '">' + esc(i.name) + ' (' + esc(i.sku) + ')</option>').join('');
    if (list.some((i) => i.sku === prev)) select.value = prev;
  }

  // Reason dropdown: only the reasons that apply to this department, for Stock In or Stock Out
  function fillReasons() {
    const sel = $('movementReason');
    if (!sel) return;
    const type = movementType();
    const dept = movementDepartment();
    const keys = dept ? reasonKeysFor(type, dept) : [];
    const sig = type + '|' + dept + '|' + keys.join(',');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      const prev = sel.value;
      const ask = type === 'out' ? 'Why is this stock going out?' : 'Why is this stock coming in?';
      sel.innerHTML = '<option value="">' + (dept ? ask : 'Choose a department or product first') + '</option>' +
        keys.map((k) => '<option value="' + k + '">' + esc(REASONS[type][k]) + '</option>').join('');
      if (keys.indexOf(prev) >= 0) sel.value = prev;
    }
    sel.disabled = !dept;
  }

  /* ---------- Task 9: Stock In / Out helpers ----------
     Unit conversion: the quantity can be typed in another unit of the same kind (g / tonne / lb for a kg product, ft for a meter
     product); it is converted to the product's own unit before it is checked and saved (2 decimals, like the ledger).
     On hand is shown beside the quantity, and a Stock Out larger than what is on hand cannot be saved.
     Supplier delivery: the last supplier and the last cost per unit are filled in (still editable), with the storage location;
     a cost more than COST_JUMP away from the last purchase asks "is this right?" before saving. */
  const COST_JUMP = 0.30;                       // assumption: a 30% change from the last purchase price is worth a second look
  const UNIT_GROUPS = [{ kg: 1, g: 0.001, tonne: 1000, lb: 0.45359237 }, { m: 1, ft: 0.3048 }];
  const unitGroup = (u) => UNIT_GROUPS.find((g) => g[u] != null) || null;
  const enterUnit = () => ($('movementEnterUnit') && !$('movementEnterUnit').hidden && $('movementEnterUnit').value) || '';
  // the typed quantity in the product's own unit (null when nothing valid is typed)
  function movementQty(raw) {
    const n = Number(raw == null ? $('movementQuantity').value : raw), item = movementItem();
    if (!(n > 0) || !item) return Number.isFinite(n) ? n : null;
    const from = enterUnit(), g = unitGroup(item.unit);
    if (!from || from === item.unit || !g || g[from] == null) return n;
    return Math.round((n * g[from] / g[item.unit]) * 100) / 100;
  }
  function syncEnterUnit(item) {
    let sel = $('movementEnterUnit');
    const unitBox = $('movementUnit'); if (!unitBox) return;
    if (!sel) {
      sel = document.createElement('select');
      sel.id = 'movementEnterUnit'; sel.className = 'form-select'; sel.style.marginTop = '6px';
      sel.setAttribute('aria-label', 'Unit the quantity is typed in');
      unitBox.parentNode.appendChild(sel);
      sel.addEventListener('change', () => { syncMovementForm(); syncCostHint(); validateField('movementQuantity', false); });
    }
    const g = item ? unitGroup(item.unit) : null;
    const sig = item ? item.sku + '|' + item.unit : '';
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = g ? Object.keys(g).map((u) => '<option value="' + u + '">Type it in ' + u + (u === item.unit ? ' (product unit)' : '') + '</option>').join('') : '';
      if (g) sel.value = item.unit;
    }
    sel.hidden = !g;
  }
  function syncOnHandLabel(item, type, qty) {
    const lab = document.querySelector('label[for="movementQuantity"]'); if (!lab) return;
    let tag = lab.querySelector('.fa-onhand');
    if (!tag) { tag = document.createElement('span'); tag.className = 'fa-onhand'; lab.appendChild(tag); }
    tag.textContent = item ? 'On hand: ' + formatNumber(item.onHand) + ' ' + item.unit + (item.location ? ' · ' + item.location : '') : '';
    tag.style.color = item && type === 'out' && qty > item.onHand ? '#ef7a7a' : '';
    const conv = $('movementQuantity') && FA ? $('movementQuantity') : null, from = enterUnit();
    if (conv) {
      if (item && from && from !== item.unit && qty > 0) {
        FA.note(conv, '= <b>' + formatNumber(qty) + ' ' + esc(item.unit) + '</b> (saved in the product’s unit)', 'info', 'conv');
      } else if (item && type === 'in') {
        const qBox = $('movementQuantity');
        let suggest = 1;
        let noteText = '';
        if (item.reorderLevel > 0 && item.onHand <= item.reorderLevel) {
          suggest = Math.max(1, Math.round(item.reorderLevel - item.onHand));
          noteText = 'Auto-filled replenishment (<b>' + suggest + ' ' + esc(item.unit) + '</b> to reach reorder level). You can adjust.';
        } else {
          suggest = item.reorderLevel > 0 ? Math.round(item.reorderLevel) : (item.unit === 'kg' ? 50 : 20);
          noteText = 'Suggested restock quantity (<b>' + suggest + ' ' + esc(item.unit) + '</b> standard lot). You can adjust.';
        }
        if (qBox && (!qBox.value || qBox.dataset.autoFill)) {
          qBox.value = suggest;
          qBox.dataset.autoFill = '1';
          setTimeout(() => { syncCostHint(); }, 0);
        }
        FA.note(conv, noteText, 'info', 'restock');
      } else {
        FA.note(conv, '', '', 'restock');
      }
    }
  }
  // an impossible Stock Out cannot be sent (runs after production-admin.js has set the button for this sync)
  function syncOutBlock() {
    const btn = $('movementSubmitBtn'), item = movementItem(), type = movementType(), qty = movementQty() || 0;
    if (!btn || (window.ProductionUI && window.ProductionUI.isProduction && window.ProductionUI.isProduction())) return;
    const block = !!(item && type === 'out' && (qty > item.onHand || item.onHand <= 0));
    if (block) { btn.disabled = true; btn.title = item.onHand <= 0 ? 'Nothing on hand to take out' : 'More than what is on hand'; }
    else if (btn.title) { btn.disabled = false; btn.title = ''; }
  }
  const receiptCache = new Map();               // sku -> last delivery (forgotten after every save)
  let receiptSeq = 0;
  async function prefillReceipt() {
    const item = movementItem(), type = movementType(), reason = $('movementReason').value;
    const hint = $('movementCostHint');
    if (!item || !(type === 'in' && reason === 'supplier_receipt')) { if (FA) FA.note($('movementUnitCost'), '', '', 'last'); return; }
    const my = ++receiptSeq;
    let r = receiptCache.get(item.sku);
    if (!r) { try { r = await api('/products/' + encodeURIComponent(item.sku) + '/last-receipt'); receiptCache.set(item.sku, r); } catch (e) { return; } }
    if (my !== receiptSeq || !movementItem() || movementItem().sku !== item.sku) return;
    if (!r.last || movementType() !== 'in' || $('movementReason').value !== 'supplier_receipt') { if (FA) FA.note($('movementUnitCost'), '', '', 'last'); return; }
    const sup = $('movementSupplier'), cost = $('movementUnitCost');
    if (sup && r.last.supplier && (!sup.value || sup.dataset.auto) && [].some.call(sup.options, (o) => o.value === r.last.supplier)) { sup.value = r.last.supplier; sup.dataset.auto = '1'; }
    if (cost && r.last.unitCost != null && (!cost.value || cost.dataset.auto)) { cost.value = r.last.unitCost.toFixed(2); cost.dataset.auto = '1'; syncCostHint(); }
    if (FA) FA.note(cost, 'Last delivery ' + esc(r.last.day) + (r.last.supplierName ? ' from ' + esc(r.last.supplierName) : '') +
      (r.last.unitCost != null ? ' at <b>₱' + r.last.unitCost.toFixed(2) + '</b> per ' + esc(item.unit) : '') + '. Filled in for you — change it to match this invoice.', 'info', 'last');
    if (hint) syncCostHint();
    syncCostWarning();
  }
  // "is this right?": the cost per unit is far from the last purchase
  function costJump(item, cost) {
    const r = item && receiptCache.get(item.sku), last = r && r.last && r.last.unitCost;
    if (!(cost > 0) || !(last > 0)) return null;
    const diff = (cost - last) / last;
    return Math.abs(diff) > COST_JUMP ? { last, diff } : null;
  }
  function syncCostWarning() {
    const box = $('movementUnitCost'); if (!box || !FA) return;
    const j = costJump(movementItem(), Number(String(box.value).replace(/[,₱\s]/g, '')));
    FA.note(box, j ? 'This is ' + Math.round(Math.abs(j.diff) * 100) + '% ' + (j.diff > 0 ? 'higher' : 'lower') + ' than the last purchase (₱' + j.last.toFixed(2) + '). Check the invoice.' : '', 'warn', 'jump');
  }

  function syncMovementForm() {
    const form = $('movementForm');
    if (!form) return;
    const type = movementType();
    fillMovementDepartments();
    fillMovementProducts();
    fillReasons();
    if (window.ProductionUI) window.ProductionUI.beforeSync();   // Finished Goods Stock In: source picker sets the reason
    const reason = $('movementReason').value;
    syncEnterUnit(movementItem());
    const qty = movementQty() || 0;
    syncOnHandLabel(movementItem(), type, qty);
    const item = movementItem();
    const dept = movementDepartment();

    const deptHint = $('movementDeptHint');
    if (deptHint) deptHint.textContent = ($('movementDept') || {}).value
      ? 'Showing only ' + $('movementDept').value + ' products.'
      : 'Optional — pick a department to narrow down the product list.';

    if ($('movementUnit')) $('movementUnit').value = item ? item.unit : '';
    if ($('recordProductName')) $('recordProductName').textContent = item ? item.name : 'Select a product';
    if ($('movementRef')) $('movementRef').value = '';

    // hint under the reason box: which department the list is for, then what the chosen reason means
    const hint = $('movementReasonHint');
    if (hint) hint.textContent = !dept ? 'The reasons shown depend on the product\u2019s department.'
      : reason ? (REASON_HELP[type + ':' + reason] || '')
      : 'Showing reasons for ' + dept + ' products.';

    // the Note box only appears when the reason needs an explanation (Other, stock count corrections) — and is then required
    const noteGroup = $('movementNoteGroup');
    const needNote = NOTE_REQUIRED.indexOf(reason) >= 0;
    if (noteGroup) {
      noteGroup.style.display = needNote ? '' : 'none';
      if (!needNote) {
        $('movementNote').value = '';
        noteGroup.querySelectorAll('.field-msg').forEach((n) => n.remove());
        $('movementNote').classList.remove('field-invalid');
      }
    }

    // supplier delivery details (only for "Received from supplier")
    const isReceipt = type === 'in' && reason === 'supplier_receipt';
    const rg = $('movementReceiptGroup');
    if (rg) {
      rg.style.display = isReceipt ? '' : 'none';
      if (isReceipt) {
        fillMovementSuppliers(item);
        syncDeliveryTiming();
      } else {
        ['movementSupplier', 'movementInvoice', 'movementUnitCost', 'movementOrderDate'].forEach((id) => { const el = $(id); if (el) { el.value = ''; el.classList.remove('field-invalid'); } });
        rg.querySelectorAll('.field-msg').forEach((n) => n.remove());
        if ($('movementDeliveryTiming')) $('movementDeliveryTiming').innerHTML = '<span class="faint">Select supplier &amp; order date to check timing</span>';
      }
    }

    // stock summary
    const cur = $('summaryCurrentStock'), aft = $('summaryAfterStock');
    if (window.ProductionUI) setTimeout(() => window.ProductionUI.afterSync(), 0);
    if (cur) cur.textContent = item ? formatNumber(item.onHand) + ' ' + item.unit : '—';
    if (aft) {
      if (!item) aft.textContent = '—';
      else {
        const after = item.onHand + (type === 'in' ? qty : -qty);
        aft.textContent = formatNumber(Math.max(after, 0)) + ' ' + item.unit + (after < 0 ? ' (not enough stock)' : '');
        aft.style.color = after < 0 ? '#ef7a7a' : '';
      }
    }
    setTimeout(syncOutBlock, 0);
  }

  // Suppliers that match a product: only the active suppliers linked to it. If none is linked yet, every active supplier
  // is offered instead (so a delivery can still be recorded) and `linkedOnly` is false.
  function suppliersForItem(item) {
    const active = supplierData.filter((s) => s.status !== 'archived');
    const linked = item ? active.filter((s) => (s.products || []).some((p) => p.sku === item.sku)) : [];
    return { list: linked.length ? linked : active, linkedOnly: linked.length > 0, anyActive: active.length > 0 };
  }

  function syncSupplierLeadHint(item) {
    const h = $('movementSupplierHint'), sel = $('movementSupplier');
    if (!h) return;
    const m = suppliersForItem(item);
    let baseText = !item ? '' : m.linkedOnly ? 'Showing only suppliers that supply this product.'
      : 'No supplier is linked to this product yet \u2014 showing all active suppliers. Link one in Supplier Management.';
    const supId = sel ? sel.value : '';
    if (!supId) {
      h.innerHTML = esc(baseText);
      return;
    }
    const sup = (supplierData || []).find((s) => String(s.id) === String(supId));
    if (sup) {
      const lead = sup.leadTimeDays != null ? sup.leadTimeDays : 7;
      const arrDate = new Date(Date.now() + lead * 86400000);
      const dateStr = arrDate.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      h.innerHTML = (baseText ? '<div style="margin-bottom:4px">' + esc(baseText) + '</div>' : '') +
        '<div style="color:#0369a1;font-weight:600;font-size:12.5px">Supplier lead time: ' +
        lead + ' day' + (lead === 1 ? '' : 's') + ' &mdash; Estimated delivery by <b>' + dateStr + '</b></div>';
    } else {
      h.innerHTML = esc(baseText);
    }
  }

  // Supplier dropdown: shows only the suppliers that supply the chosen product
  function fillMovementSuppliers(item) {
    const sel = $('movementSupplier');
    if (!sel) return;
    const m = suppliersForItem(item);
    const sig = (item ? item.sku : '') + '|' + m.linkedOnly + '|' + m.list.map((s) => s.id + s.name).join(';');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      const prev = sel.value;
      const opt = (s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>';
      sel.innerHTML = '<option value="">' + (!m.anyActive ? 'No active suppliers yet' : item ? 'Select the supplier\u2026' : 'Choose a product first') + '</option>' +
        (item ? m.list.map(opt).join('') : '');
      sel.disabled = !item;
      if (prev && m.list.some((s) => s.id === prev)) sel.value = prev;
      else if (m.linkedOnly && m.list.length === 1) sel.value = m.list[0].id;
    }
    syncSupplierLeadHint(item);
    syncDeliveryTiming();
  }

  function syncDeliveryTiming() {
    const timingBox = $('movementDeliveryTiming');
    if (!timingBox) return;
    const supId = ($('movementSupplier') || {}).value;
    const orderDateVal = ($('movementOrderDate') || {}).value;
    if (!supId || !orderDateVal) {
      timingBox.innerHTML = '<span class="faint">Select supplier &amp; order date to check timing</span>';
      return;
    }
    const sup = (supplierData || []).find((s) => String(s.id) === String(supId));
    const lead = sup && sup.leadTimeDays != null ? sup.leadTimeDays : 7;
    const orderDate = new Date(orderDateVal + 'T00:00:00');
    const expectedArrival = new Date(orderDate.getTime() + lead * 86400000);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expStr = expectedArrival.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    const diffDays = Math.round((today.getTime() - expectedArrival.getTime()) / 86400000);
    if (diffDays > 0) {
      timingBox.innerHTML = '<span style="color:#b91c1c;font-weight:700">LATE: ' + diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' past expected delivery (' + expStr + ')</span>';
    } else if (diffDays === 0) {
      timingBox.innerHTML = '<span style="color:#15803d;font-weight:600">On time: Expected arrival today (' + expStr + ')</span>';
    } else {
      const earlyDays = Math.abs(diffDays);
      timingBox.innerHTML = '<span style="color:#15803d;font-weight:600">On time: ' + earlyDays + ' day' + (earlyDays === 1 ? '' : 's') + ' ahead of schedule (' + expStr + ')</span>';
    }
  }

  function refreshMovementForm() {
    if (!$('movementProduct')) return;
    syncMovementForm();
  }

  const MOVE_FIELDS = { sku: 'movementProduct', quantity: 'movementQuantity', reason: 'movementReason', note: 'movementNote',
    supplier: 'movementSupplier', invoiceNo: 'movementInvoice', unitCost: 'movementUnitCost' };
  // line total and moving-average cost computation
  function syncCostHint() {
    const hint = $('movementCostHint'), it = movementItem(); if (!hint) return;
    const raw = ($('movementUnitCost') && $('movementUnitCost').value || '').replace(/[,\u20B1\s]/g, ''), cost = Number(raw), qty = movementQty() || 0;
    if (!it) { hint.textContent = ''; return; }
    const now = Number(it.unitCost) || 0, peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!raw || !(cost > 0)) {
      hint.innerHTML = 'Current unit cost: <b>' + peso(now) + '</b> per ' + esc(it.unit) + '. Enter invoice unit cost to compute delivery total and update average cost.';
      return;
    }
    const have = Math.max(0, Number(it.onHand) || 0);
    const avg = qty > 0 ? Math.round(((have * now + qty * cost) / (have + qty)) * 100) / 100 : now;
    const lineTotal = qty > 0 ? Math.round(qty * cost * 100) / 100 : 0;
    hint.innerHTML = '<div style="margin-bottom:4px;color:#1e40af;font-weight:700">Line total: ' + peso(lineTotal) + ' ' +
      '<span class="faint" style="font-weight:normal">(' + formatNumber(qty) + ' ' + esc(it.unit) + ' &times; ' + peso(cost) + ')</span></div>' +
      '<div class="faint">Average cost update: ' + peso(now) + ' &rarr; <b style="color:#0f172a">' + peso(avg) + '</b> per ' + esc(it.unit) +
      ' (' + have + ' on hand at ' + peso(now) + ' + ' + qty + ' incoming at ' + peso(cost) + ')</div>';
  }

  function setupMovementForm() {
    const form = $('movementForm');
    if (!form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    $('movementProduct').addEventListener('change', () => {
      const it = movementItem();                                   // the product decides the department, so the reasons and suppliers match it
      if (it && $('movementDept').value !== it.department) $('movementDept').value = it.department;
      syncMovementForm();
    });
    $('movementDept').addEventListener('change', syncMovementForm);
    form.addEventListener('reset', () => { setTimeout(syncMovementForm, 0); });
    $('movementReason').addEventListener('change', () => {
      const wasHidden = $('movementNoteGroup').style.display === 'none';
      syncMovementForm();
      if (wasHidden && NOTE_REQUIRED.indexOf($('movementReason').value) >= 0) $('movementNote').focus();
    });
    $('movementQuantity').addEventListener('input', syncMovementForm);
    $('movementQuantity').addEventListener('input', syncCostHint);
    $('movementProduct').addEventListener('change', syncCostHint);
    if ($('movementUnitCost')) $('movementUnitCost').addEventListener('input', syncCostHint);
    // last supplier / last cost: filled in when a supplier delivery is being recorded; a value typed or picked by hand is kept
    $('movementProduct').addEventListener('change', () => { ['movementSupplier', 'movementUnitCost'].forEach((id) => { const x = $(id); if (x && x.dataset.auto) { x.value = ''; delete x.dataset.auto; } }); prefillReceipt(); });
    $('movementReason').addEventListener('change', prefillReceipt);
    if ($('movementSupplier')) $('movementSupplier').addEventListener('change', () => { syncSupplierLeadHint(movementItem()); syncDeliveryTiming(); });
    if ($('movementOrderDate')) $('movementOrderDate').addEventListener('change', syncDeliveryTiming);
    ['movementSupplier', 'movementUnitCost'].forEach((id) => { const x = $(id); if (x) { x.addEventListener('input', (e) => { if (e.isTrusted) delete x.dataset.auto; }); x.addEventListener('change', (e) => { if (e.isTrusted) delete x.dataset.auto; }); } });
    if ($('movementUnitCost')) $('movementUnitCost').addEventListener('input', syncCostWarning);
    form.addEventListener('reset', () => {
      ['movementSupplier', 'movementUnitCost', 'movementOrderDate'].forEach((id) => { if ($(id)) delete $(id).dataset.auto; });
      if (FA) ['last', 'jump'].forEach((k) => FA.note($('movementUnitCost'), '', '', k));
      if ($('movementDeliveryTiming')) $('movementDeliveryTiming').innerHTML = '<span class="faint">Select supplier &amp; order date to check timing</span>';
    });
    if (FA) { FA.keyboard(form); FA.guard(form); }
    ['movementSupplier', 'movementInvoice', 'movementUnitCost'].forEach((id) => {       // clear an old error message as soon as the field is changed
      const el = $(id); if (!el) return;
      const clear = () => { el.classList.remove('field-invalid'); const g = el.closest('.form-group'); if (g) g.querySelectorAll('.field-msg').forEach((n) => n.remove()); };
      el.addEventListener('input', clear); el.addEventListener('change', clear);
    });
    const toggle = $('movementTypeToggle');
    if (toggle) toggle.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => setTimeout(() => { syncMovementForm(); prefillReceipt(); }, 0)));

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      if (window.ProductionUI && window.ProductionUI.isProduction()) { window.ProductionUI.submit(); return; }   // Produced Internally has its own confirm step
      const banner = $('movementFormError');
      const type = movementType();
      const reason = $('movementReason').value;
      const errs = {};
      if (!$('movementProduct').value) errs.movementProduct = 'Choose a product';
      if (!reason) errs.movementReason = type === 'out' ? 'Choose why this stock is going out' : 'Choose why this stock is coming in';
      const typed = vNum(errs, 'movementQuantity', 'Quantity', { gt: true });
      const qty = typed === null ? null : movementQty(typed);           // in the product's own unit
      if (typed !== null && !(qty > 0)) errs.movementQuantity = 'That is less than 0.01 ' + ((movementItem() || {}).unit || '') + ' \u2014 enter a bigger quantity';
      const note = vText(errs, 'movementNote', 'Note', { required: false, max: 300 });
      const isReceipt = type === 'in' && reason === 'supplier_receipt';
      let supplier = '', invoiceNo = '', unitCost = '';
      if (isReceipt) {
        supplier = $('movementSupplier').value;
        if (!supplier) errs.movementSupplier = 'Choose the supplier this delivery came from';
        invoiceNo = vText(errs, 'movementInvoice', 'Invoice / delivery no.', { required: false, max: 40 });
        unitCost = ($('movementUnitCost') ? $('movementUnitCost').value : '').replace(/[,\u20B1\s]/g, '');
        if (unitCost && !(/^\d{1,8}(\.\d{1,2})?$/.test(unitCost) && Number(unitCost) > 0)) errs.movementUnitCost = 'Enter the cost per unit in pesos, e.g. 145.50';
      }
      if (reason && NOTE_REQUIRED.indexOf(reason) >= 0 && note.length < 3) errs.movementNote = 'Please explain this entry in the note';
      const item = movementItem();
      if (item && reason && !errs.movementReason && reasonKeysFor(type, item.department).indexOf(reason) < 0)
        errs.movementReason = 'That reason does not apply to ' + item.department + ' products';
      if (item && type === 'out' && qty !== null && !errs.movementQuantity && qty > item.onHand)
        errs.movementQuantity = 'Only ' + formatNumber(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + formatNumber(qty);
      if (Object.keys(errs).length) return showErrors(form, banner, errs);
      // "is this right?" when the price is far from the last purchase
      const jump = isReceipt && unitCost ? costJump(item, Number(unitCost)) : null;
      if (jump && window.uiConfirm && !(await uiConfirm({ title: 'Is this cost right?', confirm: 'Yes, save it', cancel: 'Let me check',
        message: 'The cost per unit is ' + Math.round(Math.abs(jump.diff) * 100) + '% ' + (jump.diff > 0 ? 'higher' : 'lower') + ' than the last purchase. It changes the average cost of ' + item.name + '.',
        lines: [['Last purchase', '\u20B1' + jump.last.toFixed(2) + ' / ' + item.unit], ['This delivery', '\u20B1' + Number(unitCost).toFixed(2) + ' / ' + item.unit]] }))) { $('movementUnitCost').focus(); return; }

      clearErrors(form); hideBanner(banner);
      try {
        const r = await api('/movements', {
          method: 'POST',
          body: JSON.stringify({ sku: $('movementProduct').value, type, reason, quantity: qty, note, supplier: supplier || undefined, invoiceNo: invoiceNo || undefined, unitCost: unitCost || undefined })
        });
        toast('Saved. Reference no. ' + r.ref + (r.previousCost != null && r.unitCost !== r.previousCost ? ' \u00B7 average cost is now \u20B1' + Number(r.unitCost).toFixed(2) : '') +
          (r.ripple ? ' \u00B7 ' + r.ripple.recalculated + ' finished good cost' + (r.ripple.recalculated === 1 ? '' : 's') + ' updated, ' + r.ripple.repriced + ' repriced' + (r.ripple.quotesFlagged ? ', ' + r.ripple.quotesFlagged + ' open quote' + (r.ripple.quotesFlagged === 1 ? '' : 's') + ' to check' : '') + (r.ripple.blocked ? ', ' + r.ripple.blocked + ' cannot be priced yet' : '') : ''));
        if ($('movementCostHint')) $('movementCostHint').textContent = '';
        receiptCache.clear();
        form.reset();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, MOVE_FIELDS), err.message);
      }
    }, true);
  }

  /* =====================================================
     SUPPLIER <-> PRODUCT CHECKLISTS
  ===================================================== */
  function productModalState() {
    return typeof editingProductSku !== 'undefined' && editingProductSku ? editingProductSku : null;
  }

  // Edit Product shows the suppliers read-only. Links are managed in Supplier Management.
  function renderProductSupplierList(product) {
    const box = $('npSource');
    const linked = (product && product.suppliers) || [];
    const needs = product && NEEDS_SUPPLIER.indexOf(product.department) >= 0;
    box.innerHTML = linked.length
      ? linked.map((s) => '<div>' + esc(s.name) +
          (s.primary && linked.length > 1 ? ' <em class="prod-tag">Primary</em>' : '') +
          (s.status === 'archived' ? ' <em class="prod-tag muted">Deleted</em>' : '') + '</div>').join('')
      : (needs
        ? '<div class="sup-empty warn">No supplier yet. Link one in Supplier Management.</div>'
        : '<div class="sup-empty">In-house production — made by the company, so no supplier is needed.</div>');
  }

  /* ---------- Storage locations belong to the selected product department ---------- */
  const NEW_LOCATION = '__new_location__';
  const STARTER_LOCATIONS = {
    'Raw Materials': ['Raw Materials Storage'],
    'Finishing Supplies': ['Finishing Supplies Storage'],
    'Finished Goods': ['Finished Goods Storage']
  };
  function locationList() {
    const seen = new Map();
    const department = $('npDept').value;
    (STARTER_LOCATIONS[department] || []).concat((productCatalogData || [])
      .filter((p) => p && p.department === department).map((p) => p.location)).forEach((l) => {
      l = clean(l); if (l && !seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), l);
    });
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  function fillLocations(keep) {
    const sel = $('npLocation');
    if (!sel || sel.tagName !== 'SELECT') return;
    sel.innerHTML = '<option value="">Select a location…</option>' +
      locationList().map((l) => '<option value="' + esc(l) + '">' + esc(l) + '</option>').join('') +
      ($('npDept').value ? '<option value="' + NEW_LOCATION + '">+ Add new location…</option>' : '');
    sel.disabled = !$('npDept').value;
    delete sel.dataset.auto;
    setLocationValue(keep);
  }
  function setLocationValue(name) {
    const sel = $('npLocation'); if (!sel) return;
    name = clean(name);
    if (name && name !== NEW_LOCATION && ![].some.call(sel.options, (o) => o.value.toLowerCase() === name.toLowerCase())) {
      const opt = document.createElement('option');      // an older product whose location is not in the list
      opt.value = name; opt.textContent = name; sel.insertBefore(opt, sel.lastElementChild);
    }
    const hit = [].find.call(sel.options, (o) => name && o.value.toLowerCase() === name.toLowerCase());
    sel.value = hit ? hit.value : '';
    syncLocationNew();
  }
  function syncLocationNew() {
    const wrap = $('npLocationNewWrap'); if (!wrap) return;
    const isNew = $('npLocation').value === NEW_LOCATION;
    wrap.style.display = isNew ? '' : 'none';
    if (!isNew) { $('npLocationNew').value = ''; $('npLocationNew').classList.remove('field-invalid'); wrap.querySelectorAll('.field-msg').forEach((n) => n.remove()); }
  }
  // the location to save: the chosen one, or the typed new name (matched to an existing one ignoring upper/lower case)
  function chosenLocation(errs) {
    const v = $('npLocation').value;
    if (!v) { errs.npLocation = 'Choose the storage location'; return ''; }
    if (v !== NEW_LOCATION) return v;
    const typed = vText(errs, 'npLocationNew', 'Storage location', { min: 2, max: 100 });
    const same = locationList().find((l) => l.toLowerCase() === String(typed).toLowerCase());
    return same || typed;
  }

  /* ---------- Supplier dropdown (new Raw Materials / Finishing Supplies only; Finished Goods are made in-house) ---------- */
  function fillSupplierPick() {
    const sel = $('npSupplier'); if (!sel) return;
    const active = (supplierData || []).filter((s) => s.status !== 'archived');
    sel.innerHTML = '<option value="">Select a supplier…</option>' +
      active.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
    $('npSupplierHint').textContent = active.length ? 'Who you buy this material from. You can link more suppliers later in Supplier Management.'
      : 'No active suppliers yet. Add one in Suppliers first, then come back to create this product.';
  }
  function syncSupplierPick() {
    const wrap = $('npSupplierPickWrap'); if (!wrap) return;
    const show = !productModalState() && NEEDS_SUPPLIER.indexOf($('npDept').value) >= 0;
    wrap.style.display = show ? '' : 'none';
    if (!show) { $('npSupplier').value = ''; $('npSupplier').classList.remove('field-invalid'); wrap.querySelectorAll('.field-msg').forEach((n) => n.remove()); }
  }

  /* ---------- Reorder level: automatic (average daily use x lead + safety days) unless "Set manually" ---------- */
  let REORDER = { leadDays: 7, safetyDays: 3, lookbackDays: 90, minHistoryDays: 14 };
  function syncReorderUI(product) {
    const manual = $('npReorderManual'), box = $('npReorder'), hint = $('npReorderHint');
    if (!manual || !box || !hint) return;
    const auto = !manual.checked;
    box.readOnly = auto;
    if (auto) {
      box.value = product && product.reorderLevel != null ? product.reorderLevel : '';
      box.placeholder = 'Auto';
      hint.textContent = product && product.reorderAuto && product.reorderBasis ? product.reorderBasis
        : 'Automatic: average daily use over the last ' + REORDER.lookbackDays + ' days × (' + REORDER.leadDays + ' lead-time days + ' + REORDER.safetyDays + ' safety days). ' +
          'A new product has no usage history yet, so it starts at 0 and calculates itself after ' + REORDER.minHistoryDays + ' days of use. Tick "Set manually" to enter a starting level now.';
    } else {
      box.placeholder = '0';
      hint.textContent = 'You are setting this yourself. Untick "Set manually" to let the system work it out from usage.';
    }
  }

  /* ---------- Category dropdown (list comes from the database; last option adds a new one) ---------- */
  // Finished goods are only the two product lines Triple E makes; the other departments keep their own list (and can add one)
  const FG_CATEGORIES = ['Aluminum Die-Cast Products', 'Forged Brass Products'];
  // Raw materials: Triple E only works in aluminum and brass, so those are the only metal categories (no steel, iron, stainless...)
  const RM_CATEGORIES = ['Aluminum Alloy', 'Brass / Copper Alloy'];
  const OTHER_METAL = /steel|stainless|iron|zinc|nickel|bronze|titanium|aluminium|aluminum|brass|copper|metal/i;
  function fillCategories(keep) {
    const sel = $('npCategory');
    if (!sel || sel.tagName !== 'SELECT') return;
    const cur = keep === undefined ? sel.value : keep;
    const dept = ($('npDept') || {}).value, fg = dept === 'Finished Goods', rm = dept === 'Raw Materials';
    // Finished Goods and Raw Materials have a fixed list; Finishing Supplies keep the database list, minus every metal category
    const list = fg ? FG_CATEGORIES : rm ? RM_CATEGORIES
      : CATEGORIES.filter((c) => FG_CATEGORIES.indexOf(c) < 0 && RM_CATEGORIES.indexOf(c) < 0 && !OTHER_METAL.test(c));
    sel.innerHTML = '<option value="">Select a category…</option>' +
      list.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('') +
      (fg || rm ? '' : '<option value="' + NEW_CATEGORY + '">+ Add new category…</option>');
    // switching department by hand: a category that belongs to the other department is dropped (an old product being edited keeps its own)
    setCategoryValue(keep === undefined && cur !== NEW_CATEGORY && list.indexOf(cur) < 0 ? '' : cur);
  }
  function setCategoryValue(name) {
    const sel = $('npCategory');
    if (!sel) return;
    name = clean(name);
    if (name === 'Uncategorized') name = '';            // old records without a category: user must pick one
    if (name && name !== NEW_CATEGORY && ![].some.call(sel.options, (o) => o.value === name)) {
      const opt = document.createElement('option');      // a category that is no longer in the list
      opt.value = name; opt.textContent = name; opt.dataset.legacy = '1';
      sel.insertBefore(opt, sel.lastElementChild);
    }
    sel.value = name || '';
    syncCategoryNew();
  }
  function syncCategoryNew() {
    const wrap = $('npCategoryNewWrap');
    if (!wrap) return;
    const isNew = $('npCategory').value === NEW_CATEGORY;
    wrap.style.display = isNew ? '' : 'none';
    if (!isNew) {
      $('npCategoryNew').value = '';
      wrap.querySelectorAll('.field-msg').forEach((n) => n.remove());
      $('npCategoryNew').classList.remove('field-invalid');
    }
  }
  // the category to save: the chosen one, or the typed new name (matched to an existing one ignoring upper/lower case)
  function chosenCategory(errs) {
    const v = $('npCategory').value;
    if (v !== NEW_CATEGORY) return v;
    const typed = vText(errs, 'npCategoryNew', 'Category name', { min: 2, max: 60 });
    const same = CATEGORIES.find((c) => c.toLowerCase() === String(typed).toLowerCase());
    return same || typed;
  }

  // Only Finished Goods are sold. Raw Materials and Finishing Supplies have no selling price.
  const SELLS_DEPT = ['Finished Goods'];
  const sellsNow = () => SELLS_DEPT.indexOf(($('npDept') || {}).value) >= 0;
  // Finished goods are priced automatically: unit cost + the markup (20% by default, Finance > Products > Pricing rules).
  // The database trigger (pricing.js) applies the same formula on save, so the shown price is exactly what gets stored.
  let FG_MARKUP = 20;
  const priceManual = () => !!($('npPriceManual') && $('npPriceManual').checked);
  function autoPrice() {
    const raw = window.MoneyInput ? MoneyInput.raw($('npUnitCost').value) : $('npUnitCost').value, c = Number(raw);
    return raw !== '' && Number.isFinite(c) && c > 0 ? Math.round(c * (1 + FG_MARKUP / 100) * 100) / 100 : null;
  }
  function syncPriceField() {
    const input = $('npListPrice'); if (!input) return;
    const sells = sellsNow(), row = $('npPriceManualRow'), hint = $('npPriceHint');
    const label = document.querySelector('label[for="npListPrice"]');
    if (label) label.innerHTML = 'Selling Price (&#8369;)' + (sells ? ' <span class="required-mark">*</span>' : '');
    if (row) row.style.display = sells ? '' : 'none';
    input.disabled = !sells;
    if (!sells) { input.value = ''; input.readOnly = false; input.placeholder = 'Not sold'; showLive('npListPrice', ''); if (hint) hint.textContent = ''; return; }
    const auto = !priceManual();
    input.readOnly = auto;
    input.placeholder = auto ? 'Enter the unit cost first' : 'Type the selling price';
    if (auto) {
      const v = autoPrice();
      if (window.MoneyInput) MoneyInput.set(input, v == null ? '' : v.toFixed(2)); else input.value = v == null ? '' : v.toFixed(2);
      showLive('npListPrice', '');
      if (hint) hint.textContent = v == null ? 'Automatic: markup on cost ' + FG_MARKUP + '%. The price appears once the unit cost is known.'
        : (function (cost) { return 'Automatic: unit cost \u20B1' + cost.toFixed(2) + ' + markup on cost ' + FG_MARKUP + '% = \u20B1' + v.toFixed(2) + ' \u00B7 margin ' + (v > 0 ? (((v - cost) / v) * 100).toFixed(1) : '0.0') + '%. It follows the cost by itself. Tick \u201CSet manually\u201D only for a special price.'; })(v / (1 + FG_MARKUP / 100));
    } else if (hint) {
      const raw = window.MoneyInput ? MoneyInput.raw($('npListPrice').value) : $('npListPrice').value, c = Number(window.MoneyInput ? MoneyInput.raw($('npUnitCost').value) : $('npUnitCost').value), p = Number(raw);
      const minPrice = c > 0 ? Math.round(c * 1.20 * 100) / 100 : 0;
      if (p > 0 && c > 0 && p < minPrice) {
        hint.innerHTML = '<span style="color:var(--red,#e35b5b);font-weight:600">Manual price: ₱' + p.toFixed(2) + ' is below 20% margin. Minimum recommended: ₱' + minPrice.toFixed(2) + ' (markup 20% on cost).</span>';
      } else {
        hint.textContent = 'Manual price: it no longer follows the unit cost.' + (p > 0 && c > 0 ? ' Margin ' + (((p - c) / p) * 100).toFixed(1) + '%' + (p < c ? ' \u2014 BELOW COST' : '') + '.' : '') + ' Untick to go back to unit cost + markup on cost ' + FG_MARKUP + '%.';
      }
    }
  }

  // Finished goods: the unit cost is "auto" (worked out from the materials needed, product-materials.js). Override needs a reason.
  const costOverridden = () => !!($('npCostOverride') && $('npCostOverride').checked);
  const costAuto = () => sellsNow() && !costOverridden();
  function syncCostField() {
    const input = $('npUnitCost'); if (!input) return;
    const fg = sellsNow(), row = $('npCostOverrideRow'), reason = $('npCostReason'), hint = $('npCostHint'), lab = $('npUnitCostLabel'), req = $('npUnitCostReq');
    const sku = productModalState(), product = sku ? productCatalogData.find((p) => p.sku === sku) : null, bom = window.TripleEBom;
    const has = !!(fg && bom && bom.hasRecipe());
    if (lab) lab.innerHTML = 'Unit Cost (&#8369;)' + (fg ? ' <span class="auto-tag" style="font-weight:600;font-size:11px;padding:1px 6px;border-radius:8px;background:#e8f1ff;color:#1d4f9f">' + (costOverridden() ? 'override' : 'auto') + '</span>' : '');
    if (req) req.style.display = fg ? 'none' : '';
    input.required = !fg;
    if (row) row.style.display = fg && has ? '' : 'none';
    if (reason) reason.style.display = fg && costOverridden() ? '' : 'none';
    if (!fg) { input.readOnly = false; if (hint) hint.textContent = ''; return; }
    if (costOverridden()) {
      input.readOnly = false;
      if (hint) hint.textContent = 'Overridden: this cost no longer follows the recipe and the reason is logged. Untick Override to go back to auto.';
      return;
    }
    input.readOnly = true;
    const c = bom ? bom.cost() : { total: 0, complete: false, problems: [] };
    let v = '';
    if (has && c.complete && c.total > 0) v = c.total.toFixed(2);
    else if (product && product.stdCost > 0 && !(bom && bom.dirty())) v = Number(product.stdCost).toFixed(2);
    if (window.MoneyInput) MoneyInput.set(input, v); else input.value = v;
    input.placeholder = 'Auto';
    if (hint) hint.textContent = !has ? 'Auto: add the materials needed below and the cost is worked out from them (materials only, no labour, process or tooling).'
      : c.problems.length ? 'Cannot price yet: ' + c.problems[0] + (c.problems.length > 1 ? ' (+' + (c.problems.length - 1) + ' more)' : '')
      : 'Auto: materials per piece \u00D7 their current cost (materials only, no labour, process or tooling). It updates by itself when a material cost or the recipe changes.';
    if (sellsNow() && !priceManual()) syncPriceField();
  }

  // duplicate checks against the loaded product list (the server re-checks on save)
  const sameText = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();
  function duplicateProductName(name) {
    const v = clean(name); if (!v) return null;
    const me = productModalState();
    return productCatalogData.find((p) => sameText(p.name, v) && p.sku !== me) || null;
  }
  function duplicateSku(sku) {
    const v = clean(sku).toUpperCase(); if (!v || productModalState()) return null;   // SKU is locked when editing
    return productCatalogData.find((p) => String(p.sku).toUpperCase() === v) || null;
  }
  const dupNameMsg = (p) => 'A product named "' + p.name + '" already exists (SKU ' + p.sku + ')';

  /* ---------- Task 9: product form helpers (form-assist.js) ----------
     New product: the SKU is suggested from the department + category (next free number, still editable), the unit / category /
     location start as what that department mostly uses, a name close to an existing one gets "Did you mean …?", and the
     stock typed here is saved as an "Opening balance" ledger entry. Anything the person picks by hand is never overwritten. */
  const mostCommon = (list) => {
    const c = new Map(); list.filter(Boolean).forEach((v) => c.set(v, (c.get(v) || 0) + 1));
    let best = '', n = 0; c.forEach((k, v) => { if (k > n) { n = k; best = v; } });
    return best;
  };
  let skuSeq = 0;
  async function suggestSku() {
    const box = $('npSku'); if (!box || productModalState()) return;
    if (clean(box.value) && !box.dataset.auto) return;                 // typed by hand: leave it alone
    const cat = $('npCategory').value === NEW_CATEGORY ? clean($('npCategoryNew').value) : $('npCategory').value;
    const my = ++skuSeq;
    try {
      const r = await api('/products/next-sku?department=' + encodeURIComponent($('npDept').value) + '&category=' + encodeURIComponent(cat || ''));
      if (my !== skuSeq || productModalState() || (clean(box.value) && !box.dataset.auto)) return;
      box.value = r.sku; box.dataset.auto = '1';
      validateField('npSku', false);
      if (FA) FA.note(box, 'Next free code for ' + esc(r.prefix) + '. You can change it.', 'info');
    } catch (e) { /* the SKU can still be typed */ }
  }
  function applyDeptDefaults() {
    if (productModalState()) return;
    const dept = $('npDept').value, same = productCatalogData.filter((p) => p.department === dept);
    const unit = $('npUnit');
    if (unit && !unit.disabled && (!unit.value || unit.dataset.auto)) { const u = mostCommon(same.map((p) => p.unit)); if (u) { setUnitValue(u); unit.dataset.auto = '1'; } }
    const cat = $('npCategory');
    if (cat && (!cat.value || cat.dataset.auto)) {
      [].filter.call(cat.options, (o) => o.dataset.legacy).forEach((o) => o.remove());   // the last department's default is not in this list
      const c = mostCommon(same.map((p) => p.category).filter((x) => x && x !== 'Uncategorized'));
      setCategoryValue(c || ''); if (c) cat.dataset.auto = '1'; else delete cat.dataset.auto;
    }
    const loc = $('npLocation');
    if (loc && (!loc.value || loc.dataset.auto)) { const l = mostCommon(same.map((p) => p.location)); if (l) { setLocationValue(l); loc.dataset.auto = '1'; } }
  }
  function nameHint() {
    const box = $('npName'); if (!box || !FA) return;
    const me = productModalState();
    const near = duplicateProductName(box.value) ? [] : FA.similar(box.value, productCatalogData.filter((p) => p.sku !== me), (p) => p.name);
    FA.note(box, near.length ? 'Did you mean ' + near.map((p) => '<b>' + esc(p.name) + '</b> (' + esc(p.sku) + ')').join(', ') +
      '? A similar product already exists — check this is not the same item.' : '', 'warn');
  }
  function productAssistOpen(product) {
    ['npSku', 'npUnit', 'npCategory', 'npLocation'].forEach((id) => { if ($(id)) delete $(id).dataset.auto; });
    if (FA) { FA.note($('npSku'), ''); FA.note($('npName'), ''); }
    const lab = document.querySelector('label[for="npOnHand"]');
    if (lab) lab.innerHTML = (product ? 'On Hand' : 'Opening Stock') + ' <span class="required-mark">*</span>';
    if (FA) FA.note($('npOnHand'), product ? '' : 'Saved as an <b>opening balance</b> entry in the stock ledger. Later changes go through Stock In / Out.', 'info');
    if (product) return;
    applyDeptDefaults();
    suggestSku();
  }

  // weight per piece: only finished goods are delivered, so only they have it
  function syncWeightField(product) {
    const wrap = $('npWeightWrap'); if (!wrap) return;
    const fg = $('npDept').value === 'Finished Goods';
    wrap.style.display = fg ? '' : 'none';
    if (!fg) $('npWeight').value = '';
    else if (product !== undefined) $('npWeight').value = product && product.weightKg != null ? String(product.weightKg) : '';
  }
  function onProductModalOpen() {
    const form = $('newProductForm');
    clearErrors(form); hideBanner($('newProductFormError'));
    const sku = productModalState();
    const product = sku ? productCatalogData.find((p) => p.sku === sku) : null;
    // suppliers are only shown when editing; a new product gets its suppliers from Supplier Management afterwards
    $('npSupplierSection').style.display = product ? '' : 'none';
    if (product) renderProductSupplierList(product);
    fillCategories(product ? product.category : '');
    fillLocations(product && product.location ? product.location : '');
    fillSupplierPick(); syncSupplierPick();
    $('npReorderManual').checked = product ? !product.reorderAuto : false;   // new products are automatic; old ones stay manual until someone unticks it
    syncReorderUI(product);
    MoneyInput.set($('npListPrice'), product && product.listPrice ? product.listPrice : '');
    if ($('npPriceManual')) $('npPriceManual').checked = !!(product && product.department === 'Finished Goods' && product.priceAuto === false);
    if ($('npCostOverride')) $('npCostOverride').checked = !!(product && product.department === 'Finished Goods' && product.costMode === 'override');
    if ($('npCostReason')) $('npCostReason').value = product && product.costOverrideReason ? product.costOverrideReason : '';
    syncCostField();
    syncPriceField();
    // SKU and opening stock are fixed once a product exists (stock only changes through Stock In / Out)
    $('npSku').readOnly = !!product;
    $('npOnHand').readOnly = !!product;
    $('npOnHand').title = product ? 'Change stock using Stock In / Stock Out' : '';
    setUnitValue(product ? product.unit : '');
    syncUnitField(product);
    fillCategories(product ? product.category : '');          // the department is set by now: Finished Goods only lists its two product lines
    productAssistOpen(product);
    syncWeightField(product);
  }

  const PRODUCT_FIELDS = { weightKg: 'npWeight', sku: 'npSku', name: 'npName', department: 'npDept', category: 'npCategory', unit: 'npUnit',
    unitCost: 'npUnitCost', costOverrideReason: 'npCostReason', listPrice: 'npListPrice', reorderLevel: 'npReorder', onHand: 'npOnHand', location: 'npLocation', supplier: 'npSupplier' };

  function setupProductModal() {
    const overlay = $('newProductModalOverlay'), form = $('newProductForm');
    if (!overlay || !form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    $('npDept').addEventListener('change', () => {
      fillCategories(); fillLocations(''); validateField('npLocation', false); syncCostField(); syncPriceField(); validateField('npListPrice', false); syncSupplierPick(); syncWeightField();
      const sku = productModalState(); syncUnitField(sku ? productCatalogData.find((p) => p.sku === sku) : null); validateField('npUnit', false);
      applyDeptDefaults(); suggestSku();
    });
    // a value picked by hand is the person's choice: the department defaults no longer change it
    ['npUnit', 'npCategory', 'npLocation'].forEach((id) => $(id).addEventListener('change', (e) => { if (e.isTrusted) delete $(id).dataset.auto; }));
    $('npCategory').addEventListener('change', suggestSku);
    let catTimer = null, nameTimer = null;
    $('npCategoryNew').addEventListener('input', () => { clearTimeout(catTimer); catTimer = setTimeout(suggestSku, 400); });
    $('npSku').addEventListener('input', (e) => { if (e.isTrusted) { delete $('npSku').dataset.auto; if (FA) FA.note($('npSku'), ''); } });
    $('npName').addEventListener('input', () => { clearTimeout(nameTimer); nameTimer = setTimeout(nameHint, 300); });
    if (FA) {
      FA.guard(form, { overlay, closeSelector: '#newProductCloseBtn, #newProductCancelBtn', close: () => closeNewProductModal() });
      FA.keyboard(form);
    }
    $('npLocation').addEventListener('change', () => { syncLocationNew(); if ($('npLocation').value === NEW_LOCATION) $('npLocationNew').focus(); });
    if ($('npPriceManual')) $('npPriceManual').addEventListener('change', () => { syncPriceField(); if (priceManual()) $('npListPrice').focus(); });
    if ($('npCostOverride')) $('npCostOverride').addEventListener('change', () => { syncCostField(); if (costOverridden()) { $('npUnitCost').focus(); if ($('npCostReason')) $('npCostReason').value = ''; } else syncPriceField(); });
    document.addEventListener('triplee:recipe-changed', () => { if (sellsNow()) syncCostField(); });
    $('npUnitCost').addEventListener('input', () => { if (sellsNow() && !priceManual()) syncPriceField(); });
    $('npUnitCost').addEventListener('blur', () => { if (sellsNow() && !priceManual()) syncPriceField(); });
    api('/pricing').then((r) => { if (r && r.fgMarkupPct != null) { FG_MARKUP = +r.fgMarkupPct; syncPriceField(); } }).catch(() => {});
    document.addEventListener('triplee:pricing-saved', (e) => { if (e.detail && e.detail.fgMarkupPct != null) { FG_MARKUP = +e.detail.fgMarkupPct; syncPriceField(); } });
    $('npReorderManual').addEventListener('change', () => {
      const sku = productModalState(), product = sku ? productCatalogData.find((p) => p.sku === sku) : null;
      if ($('npReorderManual').checked) { if (!product) $('npReorder').value = ''; $('npReorder').focus(); }
      syncReorderUI(product);
    });
    api('/reorder-settings').then((r) => { if (r && r.leadDays != null) { REORDER = r; syncReorderUI(null); } }).catch(() => {});
    $('npCategory').addEventListener('change', () => { syncCategoryNew(); if ($('npCategory').value === NEW_CATEGORY) $('npCategoryNew').focus(); });
    form.addEventListener('reset', () => setTimeout(() => { fillCategories(''); fillLocations(''); syncSupplierPick(); $('npReorderManual').checked = false; syncReorderUI(null); syncUnitField(null); syncWeightField(null); if ($('npPriceManual')) $('npPriceManual').checked = false; if ($('npCostOverride')) $('npCostOverride').checked = false; syncCostField(); syncPriceField(); }, 0));
    new MutationObserver(() => { if (overlay.classList.contains('open')) onProductModalOpen(); })
      .observe(overlay, { attributes: true, attributeFilter: ['class'] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      const banner = $('newProductFormError');
      const editing = productModalState();
      const errs = {};
      const sku = clean($('npSku').value).toUpperCase();
      if (!sku) errs.npSku = 'SKU is required';
      else if (!/^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(sku)) errs.npSku = 'SKU must be 3–40 characters: letters, numbers, dot, dash or underscore';
      else if (duplicateSku(sku)) errs.npSku = 'That SKU already exists (' + duplicateSku(sku).name + ')';
      const name = vText(errs, 'npName', 'Product name', { min: 2 });
      if (name && !errs.npName && duplicateProductName(name)) errs.npName = dupNameMsg(duplicateProductName(name));
      const department = $('npDept').value;
      if (DEPARTMENTS.indexOf(department) < 0) errs.npDept = 'Choose a valid department';
      let category = '';
      if (!$('npCategory').value) errs.npCategory = 'Choose a category';
      else category = chosenCategory(errs);
      const unit = clean($('npUnit').value);
      if (!unit) errs.npUnit = 'Unit is required';
      else if (!/^[A-Za-z][A-Za-z./ ]{0,19}$/.test(unit)) errs.npUnit = 'Unit must be letters only, e.g. kg or pcs';
      else if (department === 'Finished Goods' && unit !== 'pcs') errs.npUnit = 'Finished goods are sold by the piece. Choose pcs';
      const fgAuto = costAuto();               // Finished Goods: the server works the cost out from the recipe, so it is never sent
      const unitCost = fgAuto ? null : vNum(errs, 'npUnitCost', 'Unit cost', { max: 1e7 });
      const costReason = clean(($('npCostReason') || {}).value);
      if (sellsNow() && costOverridden() && costReason.length < 5) errs.npCostReason = 'Give a reason for overriding the cost (at least 5 characters)';
      const listPrice = sellsNow() && priceManual() ? vNum(errs, 'npListPrice', 'Selling price', { max: 1e7, gt: true }) : sellsNow() ? autoPrice() : 0;
      if (sellsNow() && priceManual() && listPrice) {
        const curCost = fgAuto ? (window.TripleEBom ? window.TripleEBom.cost().total : 0) : (unitCost || 0);
        if (curCost > 0 && listPrice < Math.round(curCost * 1.20 * 100) / 100) {
          errs.npListPrice = 'Selling price cannot be below 20% margin floor (minimum ₱' + (Math.round(curCost * 1.20 * 100) / 100).toFixed(2) + ')';
        }
      }
      if (sellsNow() && !priceManual() && !fgAuto && autoPrice() == null && !errs.npUnitCost) errs.npUnitCost = 'Enter the unit cost: the selling price is worked out from it';
      const reorderManual = $('npReorderManual').checked;
      const reorderLevel = reorderManual ? vNum(errs, 'npReorder', 'Reorder level', { noLeadingZero: true }) : null;
      const onHand = editing ? null : vNum(errs, 'npOnHand', 'On hand', { noLeadingZero: true });
      let weightKg = null;
      if (department === 'Finished Goods') {
        const w = clean($('npWeight').value);
        if (w) { if (!/^\d{1,6}(\.\d{1,3})?$/.test(w) || !(Number(w) > 0)) errs.npWeight = 'Enter the weight of one piece in kg, e.g. 1.25'; else weightKg = Number(w); }
      }
      const location = chosenLocation(errs);
      let supplierCode = '';
      if (!editing && NEEDS_SUPPLIER.indexOf(department) >= 0) { supplierCode = $('npSupplier').value; if (!supplierCode) errs.npSupplier = 'Choose the supplier for this material'; }
      // Finished Goods: the materials needed to make one unit (product-materials.js)
      const bomProblem = department === 'Finished Goods' && window.TripleEBom ? window.TripleEBom.problem() : '';
      if (bomProblem) errs.npBomList = bomProblem;
      if (Object.keys(errs).length) return showErrors(form, banner, errs);

      clearErrors(form); hideBanner(banner);
      const payload = { sku, name, department, category, unit, listPrice, reorderAuto: !reorderManual, location: location || null };
      if (unitCost != null) payload.unitCost = unitCost;
      if (department === 'Finished Goods') payload.priceAuto = !priceManual();
      if (department === 'Finished Goods' && costOverridden()) payload.costOverrideReason = costReason;
      if (department === 'Finished Goods' && editing && !costOverridden()) { const cur = productCatalogData.find((p) => p.sku === editing); if (cur && cur.costMode === 'override') payload.costBackToAuto = true; }
      if (reorderManual) payload.reorderLevel = reorderLevel;
      if (department === 'Finished Goods') payload.weightKg = weightKg;
      if (!editing) { payload.onHand = onHand; if (supplierCode) payload.supplierCode = supplierCode; }
      try {
        if (editing) await api('/products/' + encodeURIComponent(editing), { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/products', { method: 'POST', body: JSON.stringify(payload) });
        let bomMsg = '';
        try { const n = window.TripleEBom ? await window.TripleEBom.saveWithProduct(sku) : 0; if (n) { bomMsg = ' · ' + n + ' material' + (n === 1 ? '' : 's') + ' saved'; const rr = window.TripleEBom && window.TripleEBom.lastResult && window.TripleEBom.lastResult.cost; if (rr && rr.newCost != null) bomMsg += ' · cost \u20B1' + Number(rr.newCost).toFixed(2) + (rr.newPrice != null ? ', price \u20B1' + Number(rr.newPrice).toFixed(2) : ''); if (rr && rr.problems && rr.problems.length) bomMsg += ' · cannot price yet: ' + rr.problems[0]; } }
        catch (bomErr) { toast('Product saved, but the materials needed were NOT saved: ' + bomErr.message + ' Open Edit to add them again.', 'error'); closeNewProductModal(); await load(); return; }
        let shopMsg = '';
        try { if (window.TripleEShop && await window.TripleEShop.saveWithProduct(sku)) shopMsg = ' · online shop details saved'; }
        catch (shopErr) { toast('Product saved, but the online shop details were NOT saved: ' + shopErr.message, 'error'); await load(); return; }
        toast((editing ? 'Product updated' : 'Product added') + bomMsg + shopMsg);
        closeNewProductModal();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, PRODUCT_FIELDS), err.message);
      }
    }, true);
  }

  /* ---------------- supplier modal ---------------- */
  function onSupplierModalOpen() {
    const form = $('newSupplierForm');
    clearErrors(form); hideBanner($('newSupplierFormError'));
    const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
    const supplier = id ? supplierData.find((s) => s.id === id) : null;
    const linked = supplier ? (supplier.products || []).map((p) => p.sku) : [];
    const rows = productCatalogData.filter((p) => NEEDS_SUPPLIER.indexOf(p.department) >= 0 || linked.indexOf(p.sku) >= 0).map((p) =>
      '<label class="check-row"><input type="checkbox" class="prod-check" value="' + esc(p.sku) + '"' + (linked.indexOf(p.sku) >= 0 ? ' checked' : '') + '>' +
      '<span class="check-label">' + esc(p.name) + ' <span class="check-sub">· ' + esc(p.sku) + ' · ' + esc(p.department || '') + '</span></span></label>');
    $('newSupplierProducts').innerHTML = rows.length ? rows.join('') : '<div class="check-empty">No Raw Materials or Finishing Supplies products yet.</div>';
    const fill = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
    fill('newSupplierName', supplier ? supplier.name : '');
    fill('newSupplierContactPerson', supplier ? supplier.contactPerson : '');
    fill('newSupplierPhone', supplier ? supplier.phone : '');
    fill('newSupplierEmail', supplier ? supplier.email : '');
    fill('newSupplierAddress', supplier ? supplier.address : '');
    fill('newSupplierLeadTime', supplier && supplier.leadTimeDays != null ? supplier.leadTimeDays : '');
    if ($('newSupplierLeadTime')) $('newSupplierLeadTime').placeholder = String(REORDER && REORDER.leadDays != null ? REORDER.leadDays : 7);
    setupAddressFields();
    prefillAddress(supplier);
    setEmailStatus(EMAIL_HINT);
    setupSupplierInputFilters();
    const archive = $('archiveSupplierBtn');
    if (archive) {
      archive.style.display = supplier ? '' : 'none';
      if (supplier) archive.textContent = supplier.status === 'archived' ? 'RESTORE SUPPLIER' : 'DELETE SUPPLIER';
    }
  }

  /* =====================================================
     SUPPLIER FORM HELPERS: Title Case, PH phone, email domain check
  ===================================================== */
  const TITLE_KEEP = { gmbh: 'GmbH', llc: 'LLC', plc: 'PLC', cnc: 'CNC', ph: 'PH', usa: 'USA', uae: 'UAE' };
  function titleCase(v) {
    return String(v || '')
      .toLowerCase()
      .replace(/(^|[\s\-\/(])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
      .replace(/\b(gmbh|llc|plc|cnc|ph|usa|uae)\b/gi, (w) => TITLE_KEEP[w.toLowerCase()]);
  }
  // rewrites the box in Title Case while typing, keeping the cursor where it was
  function liveTitleCase(id) {
    const el = $(id);
    if (!el || el.dataset.titleCase) return;
    el.dataset.titleCase = '1';
    el.addEventListener('input', () => {
      const next = titleCase(el.value);
      if (next === el.value) return;
      const a = el.selectionStart, b = el.selectionEnd;
      el.value = next;
      try { el.setSelectionRange(a, b); } catch (e) { /* ignore */ }
    });
    el.addEventListener('blur', () => { el.value = titleCase(clean(el.value)); });
  }

  const OUTSIDE_PH = 'Outside the Philippines';
  const PHONE_MSG = 'Phone number must start with +63 or 09, e.g. +63 917 123 4567 or 0917 123 4567';
  function phoneError(raw) {
    if (/[^\d+\s().-]/.test(raw)) return 'Phone number can only have digits, +, spaces and dashes';
    const p = raw.replace(/[\s().-]/g, '');
    if (p.indexOf('+63') === 0) {
      const r = p.slice(3);
      if (!/^\d+$/.test(r)) return PHONE_MSG;
      if (r[0] === '9') return r.length === 10 ? '' : 'A +63 mobile number needs 10 digits after +63, e.g. +63 917 123 4567';
      return r.length >= 9 && r.length <= 10 ? '' : PHONE_MSG;
    }
    if (p.indexOf('09') === 0) return /^09\d{9}$/.test(p) ? '' : 'A 09 mobile number needs 11 digits, e.g. 0917 123 4567';
    return PHONE_MSG;
  }
  const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function zipError(zip, region) {
    if (region === OUTSIDE_PH) return /^[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/.test(zip) ? '' : 'ZIP / postal code must be 3-10 letters or numbers';
    return /^\d{4}$/.test(zip) ? '' : 'ZIP code must be 4 digits, e.g. 1000';
  }

  // the supplier being edited (null when adding a new one)
  function editedSupplier() {
    const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
    return id ? supplierData.find((s) => s.id === id) || null : null;
  }
  // an old phone / email that is left exactly as it was does not have to follow the new rules
  const phoneUnchanged = () => { const sup = editedSupplier(); return !!(sup && sup.phone && clean(sup.phone) === clean($('newSupplierPhone').value)); };
  const emailUnchanged = () => { const sup = editedSupplier(); return !!(sup && sup.email && clean(sup.email).toLowerCase() === clean($('newSupplierEmail').value).toLowerCase()); };

  const emailResults = new Map();   // email -> { ok, message }
  async function checkEmail(email) {
    const key = email.toLowerCase();
    if (emailResults.has(key)) return emailResults.get(key);
    let r;
    try { r = await api('/validate-email?email=' + encodeURIComponent(email)); }
    catch (err) { return { ok: false, message: 'Could not check the email right now. Try again.' }; }
    if (!r.unverified && !/right now|Check the internet/.test(r.message || '')) emailResults.set(key, r);   // do not remember "could not check"
    return r;
  }
  function setEmailStatus(text, color) {
    const el = $('newSupplierEmailStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('tick', !!color);
    el.style.color = color || '';
  }
  const EMAIL_HINT = 'Domain is checked automatically';
  let emailTimer = null;
  function scheduleEmailCheck() {
    clearTimeout(emailTimer);
    const el = $('newSupplierEmail');
    if (!el) return;
    const value = clean(el.value);
    if (!value) return setEmailStatus(EMAIL_HINT);
    if (!EMAIL_FORMAT.test(value) || emailUnchanged()) return setEmailStatus(EMAIL_HINT);
    const known = emailResults.get(value.toLowerCase());
    if (known) { setEmailStatus(known.ok ? 'Email domain is valid' : EMAIL_HINT, known.ok ? '#5fbf8a' : ''); validateField('newSupplierEmail', false); return; }
    setEmailStatus('Checking email domain…');
    emailTimer = setTimeout(async () => {
      const r = await checkEmail(value);
      if (clean(el.value) !== value) return;            // the box changed while we were checking
      setEmailStatus(r.ok ? (r.unverified ? 'Email format is OK (domain could not be checked right now)' : 'Email domain is valid') : EMAIL_HINT, r.ok && !r.unverified ? '#5fbf8a' : '');
      validateField('newSupplierEmail', true);
    }, 600);
  }

  // phone: only phone characters; zip: digits only for Philippine addresses
  function setupSupplierInputFilters() {
    const phone = $('newSupplierPhone');
    if (phone && !phone.dataset.filter) {
      phone.dataset.filter = '1';
      phone.addEventListener('input', () => {
        const next = phone.value.replace(/[^\d+\s().-]/g, '');
        if (next !== phone.value) phone.value = next;
      });
    }
    const zip = $('newSupplierZip'), region = $('newSupplierRegion');
    if (zip && region && !zip.dataset.filter) {
      zip.dataset.filter = '1';
      const trim = () => {
        if (region.value && region.value !== OUTSIDE_PH) {
          const next = zip.value.replace(/\D/g, '').slice(0, 4);
          if (next !== zip.value) zip.value = next;
        }
        zip.maxLength = region.value === OUTSIDE_PH ? 10 : 4;
      };
      zip.addEventListener('input', trim);
      region.addEventListener('change', trim);
      trim();
    }
  }


  /* =====================================================
     ADDRESS: Region -> Province -> City / Municipality -> ZIP
     Lists come from the PSGC API (through our server); the ZIP code is checked against the chosen city.
  ===================================================== */
  const GEO = { regions: [], provinces: [], cities: [], barangays: [], zip: null, zipTimer: null, ready: false };
  const geoMemo = new Map();
  async function geoGet(path) {
    if (geoMemo.has(path)) return geoMemo.get(path);
    const data = await api(path);              // failures are not remembered
    geoMemo.set(path, data);
    return data;
  }
  const gnorm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ').replace(/\bcity of\b|\bmunicipality of\b|\bcity\b|\bmunicipality\b/g, ' ')
    .replace(/\bsta\.?\b/g, 'santa').replace(/\bsto\.?\b/g, 'santo').replace(/[^a-z0-9]+/g, ' ').trim();
  const findByName = (list, name) => list.find((x) => x.name === name) || list.find((x) => gnorm(x.name) === gnorm(name));
  const isOutsidePH = () => clean(($('newSupplierRegion') || {}).value) === OUTSIDE_PH;
  const NCR_PROVINCE = 'Metro Manila';

  function injectGeoStyles() {
    if (document.getElementById('geoStyles')) return;
    const st = document.createElement('style');
    st.id = 'geoStyles';
    st.textContent =
      '.geo-combo{position:relative}' +
      '.geo-list{position:absolute;left:0;right:0;top:100%;z-index:60;max-height:220px;overflow-y:auto;margin-top:2px;' +
        'background:var(--bg-card,#0d1f2d);border:1px solid var(--border,#1d3a50);border-radius:6px;box-shadow:0 10px 24px rgba(0,0,0,.45);padding:4px 0}' +
      '.geo-list[hidden]{display:none}' +
      '.geo-opt{padding:8px 12px;font-size:16px;color:var(--text,#e6eef5);cursor:pointer}' +
      '.geo-opt:hover,.geo-opt.active{background:rgba(74,144,217,.18)}' +
      '.geo-empty{padding:8px 12px;font-size:15px;color:var(--text-faint,#8aa0b2)}' +
      '.geo-input:disabled{opacity:.6;cursor:not-allowed}' +
      'html[data-theme="light"] .geo-list{background:#fff;border-color:#c9d6e0;box-shadow:0 10px 24px rgba(20,40,60,.18)}' +
      'html[data-theme="light"] .geo-opt{color:#1c2b39}' +
      'html[data-theme="light"] .geo-opt:hover,html[data-theme="light"] .geo-opt.active{background:#e3eefa}';
    document.head.appendChild(st);
  }

  // type-to-search box: the value must be picked from the list loaded from the API
  function makeCombo(id, getItems, onPick) {
    const input = $(id);
    if (!input || input.dataset.combo) return;
    input.dataset.combo = '1';
    const list = input.parentNode.querySelector('.geo-list');
    let shown = [], active = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
    const paint = () => {
      [].forEach.call(list.children, (n, i) => n.classList.toggle('active', i === active));
      if (list.children[active]) list.children[active].scrollIntoView({ block: 'nearest' });
    };
    const open = () => {
      if (input.disabled || input.dataset.free || (isOutsidePH() && id !== 'newSupplierRegion')) return;   // typed by hand: no list
      const items = getItems() || [];
      const picked = input.dataset.name && input.value === input.dataset.name;
      const q = picked ? '' : gnorm(input.value);
      shown = items.filter((x) => !q || gnorm(x.name).indexOf(q) >= 0 || x.name.toLowerCase().indexOf(input.value.trim().toLowerCase()) >= 0).slice(0, 300);
      list.innerHTML = shown.length ? shown.map((x, i) => '<div class="geo-opt" role="option" data-i="' + i + '">' + esc(x.name) + '</div>').join('')
        : '<div class="geo-empty">' + (items.length ? 'No match — pick from the list' : 'Nothing to show yet') + '</div>';
      list.hidden = false; input.setAttribute('aria-expanded', 'true'); active = -1;
    };
    const pick = (item) => {
      input.value = item.name; input.dataset.code = item.code; input.dataset.name = item.name;
      close(); onPick(item);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    list.addEventListener('mousedown', (e) => {
      const n = e.target.closest('.geo-opt'); if (!n) return;
      e.preventDefault(); pick(shown[Number(n.dataset.i)]);
    });
    input.addEventListener('focus', () => { if (input.dataset.retry) input.dispatchEvent(new CustomEvent('geo-retry')); open(); });
    input.addEventListener('input', () => {
      if (input.dataset.code) { delete input.dataset.code; delete input.dataset.name; onPick(null); }
      open();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) open(); active = Math.min(active + 1, shown.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
      else if (e.key === 'Enter' && !list.hidden && shown.length) { e.preventDefault(); e.stopPropagation(); pick(shown[active >= 0 ? active : 0]); }
      else if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        close();
        if (input.dataset.code || !input.value.trim()) return;
        const exact = (getItems() || []).find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
        if (exact) pick(exact);
      }, 120);
    });
  }
  function setBox(id, o) {          // o: { value, code, disabled, placeholder }
    const el = $(id); if (!el) return;
    el.value = o.value || '';
    if (o.code) { el.dataset.code = o.code; el.dataset.name = o.value; } else { delete el.dataset.code; delete el.dataset.name; }
    delete el.dataset.free;
    el.disabled = !!o.disabled;
    if (o.placeholder != null) el.placeholder = o.placeholder;
    showLive(id, '');
    const list = el.parentNode.querySelector && el.parentNode.querySelector('.geo-list');
    if (list) list.hidden = true;
  }
  const picked = (id) => { const el = $(id); return !!(el && (el.dataset.code || el.dataset.free || isOutsidePH())); };

  function resetBelowRegion(keepRegion) {
    GEO.provinces = []; GEO.cities = []; GEO.barangays = []; GEO.zip = null;
    clearTimeout(GEO.zipTimer);
    setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Choose a region first' });
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Choose a province first' });
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' });
    const zip = $('newSupplierZip');
    if (zip) { zip.value = ''; zip.disabled = true; zip.placeholder = 'Choose a barangay first'; showLive('newSupplierZip', ''); }
    setZipStatus('Checked against the selected city');
    if (!keepRegion) setBox('newSupplierRegion', { value: '', disabled: false, placeholder: GEO.regions.length ? 'Type to search region…' : 'Loading regions…' });
  }
  function setZipStatus(text, color) {
    const el = $('newSupplierZipStatus'); if (!el) return;
    el.textContent = text; el.classList.toggle('tick', !!color); el.style.color = color || '';
  }

  async function ensureRegions() {
    if (GEO.regions.length) return true;
    const box = $('newSupplierRegion');
    try {
      const rows = await geoGet('/geo/regions');
      GEO.regions = rows.concat([{ code: 'OUT', name: OUTSIDE_PH }]);
      delete box.dataset.retry; delete box.dataset.warned;
      if (!box.value) box.placeholder = 'Type to search region…';
      return true;
    } catch (err) {
      box.dataset.retry = '1';
      box.placeholder = 'Could not load regions — click here to retry';
      console.warn('[api-bridge] regions', err.message);
      if (!box.dataset.warned) { box.dataset.warned = '1'; toast(err.message, 'error'); }
      return false;
    }
  }

  async function onRegionPick(item) {
    resetBelowRegion(true);
    if (!item) return;
    if (item.name === OUTSIDE_PH) {                      // foreign address: typed in by hand
      setBox('newSupplierProvince', { value: '', disabled: false, placeholder: 'State / province' });
      setBox('newSupplierCity', { value: '', disabled: false, placeholder: 'City' });
      setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'District / barangay (optional)' });
      const zip = $('newSupplierZip'); zip.disabled = false; zip.placeholder = 'Postal code';
      setZipStatus('Postal code format is checked');
      return;
    }
    setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Loading provinces…' });
    try {
      const provs = await geoGet('/geo/regions/' + encodeURIComponent(item.code) + '/provinces');
      if ($('newSupplierRegion').dataset.code !== item.code) return;       // region changed while loading
      if (provs.length) {
        GEO.provinces = provs;
        setBox('newSupplierProvince', { value: '', disabled: false, placeholder: 'Type to search province…' });
      } else {                                           // NCR has no provinces
        setBox('newSupplierProvince', { value: NCR_PROVINCE, code: 'NCR', disabled: true });
        await loadCities('/geo/regions/' + encodeURIComponent(item.code) + '/cities');
      }
    } catch (err) {
      setBox('newSupplierProvince', { value: '', disabled: true, placeholder: 'Could not load — pick the region again' });
      toast(err.message, 'error');
    }
  }
  async function loadCities(path) {
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Loading cities…' });
    try {
      GEO.cities = await geoGet(path);
      setBox('newSupplierCity', { value: '', disabled: false, placeholder: 'Type to search city / municipality…' });
    } catch (err) {
      setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Could not load — pick the province again' });
      toast(err.message, 'error');
    }
  }
  async function onProvincePick(item) {
    GEO.cities = []; GEO.barangays = []; GEO.zip = null; clearTimeout(GEO.zipTimer);
    setBox('newSupplierCity', { value: '', disabled: true, placeholder: 'Choose a province first' });
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' });
    const zip = $('newSupplierZip');
    zip.value = ''; zip.disabled = true; zip.placeholder = 'Choose a barangay first'; showLive('newSupplierZip', '');
    setZipStatus('Checked against the selected city');
    if (item) await loadCities('/geo/provinces/' + encodeURIComponent(item.code) + '/cities');
  }
  async function loadBarangays(city) {                   // -> true when the barangay box is ready
    const box = $('newSupplierBarangay');
    setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Loading barangays…' });
    try {
      GEO.barangays = await geoGet('/geo/cities/' + encodeURIComponent(city.code) + '/barangays');
    } catch (err) { GEO.barangays = []; }
    if ($('newSupplierCity').dataset.code !== city.code) return false;     // city changed while loading
    if (GEO.barangays.length) setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'Type to search barangay…' });
    else {                                                // list not available for this city: allow typing it
      setBox('newSupplierBarangay', { value: '', disabled: false, placeholder: 'Type the barangay' });
      box.dataset.free = '1';
    }
    return true;
  }
  function unlockZip(on) {
    const zip = $('newSupplierZip');
    zip.disabled = !on;
    zip.placeholder = on ? 'e.g. 2009' : 'Choose a barangay first';
    setZipStatus(on ? 'Checked against ' + (clean($('newSupplierCity').value) || 'the selected city') : 'Checked against the selected city');
    if (on && clean(zip.value)) scheduleZipCheck(0);
  }
  function onCityPick(item) {
    GEO.zip = null; GEO.barangays = []; clearTimeout(GEO.zipTimer);
    const zip = $('newSupplierZip');
    zip.value = ''; showLive('newSupplierZip', '');
    unlockZip(false);
    if (!item) { setBox('newSupplierBarangay', { value: '', disabled: true, placeholder: 'Choose a city first' }); return; }
    loadBarangays(item);
  }
  function onBarangayPick(item) { unlockZip(!!item); }

  const zipKey = () => [clean($('newSupplierZip').value), clean($('newSupplierBarangay').value), clean($('newSupplierCity').value), clean($('newSupplierProvince').value), clean($('newSupplierRegion').value)].join('|');
  const zipMemo = new Map();
  async function checkZipMatch() {                       // -> { ok, message, unknown? }
    const zip = clean($('newSupplierZip').value), city = clean($('newSupplierCity').value),
      province = clean($('newSupplierProvince').value), region = clean($('newSupplierRegion').value),
      barangay = clean($('newSupplierBarangay').value);
    const key = zipKey();
    if (zipMemo.has(key)) return zipMemo.get(key);
    let r;
    try {
      r = await api('/geo/check-zip?zip=' + encodeURIComponent(zip) + '&city=' + encodeURIComponent(city) +
        '&province=' + encodeURIComponent(province) + '&region=' + encodeURIComponent(region) + '&barangay=' + encodeURIComponent(barangay));
    } catch (err) { return { ok: false, unknown: true, message: 'Could not check the ZIP code right now. Try again.' }; }
    if (!r.unknown) zipMemo.set(key, r);
    return r;
  }
  function scheduleZipCheck(delay) {
    clearTimeout(GEO.zipTimer);
    GEO.zip = null;
    const zip = clean($('newSupplierZip').value);
    if (isOutsidePH() || !/^\d{4}$/.test(zip) || !picked('newSupplierCity') || !picked('newSupplierProvince') || !picked('newSupplierBarangay')) return;
    const key = zipKey();
    setZipStatus('Checking ZIP code…');
    GEO.zipTimer = setTimeout(async () => {
      const r = await checkZipMatch();
      if (zipKey() !== key) return;                      // the boxes changed while we were checking
      GEO.zip = Object.assign({ key }, r);
      setZipStatus(r.ok ? 'ZIP code matches ' + clean($('newSupplierCity').value) : 'Checked against ' + clean($('newSupplierCity').value), r.ok ? '#5fbf8a' : '');
      validateField('newSupplierZip', true);
    }, delay == null ? 450 : delay);
  }

  const ADDRESS_KEYS = [['region', 'newSupplierRegion'], ['province', 'newSupplierProvince'], ['city', 'newSupplierCity'], ['barangay', 'newSupplierBarangay'], ['zip', 'newSupplierZip']];
  // an old address that is left exactly as it was does not have to be re-picked from the lists
  function addressUnchanged() {
    const sup = editedSupplier();
    return !!(sup && sup.region && ADDRESS_KEYS.every(([k, id]) => clean(sup[k]) === clean($(id).value)));
  }

  function setupAddressFields() {
    if (!$('newSupplierRegion')) return;
    injectGeoStyles();
    makeCombo('newSupplierRegion', () => GEO.regions, onRegionPick);
    makeCombo('newSupplierProvince', () => GEO.provinces, onProvincePick);
    makeCombo('newSupplierCity', () => GEO.cities, onCityPick);
    makeCombo('newSupplierBarangay', () => GEO.barangays, onBarangayPick);
    const brgy = $('newSupplierBarangay');
    if (brgy && !brgy.dataset.freeBound) {                // when the list is not available the barangay is typed by hand
      brgy.dataset.freeBound = '1';
      brgy.addEventListener('input', () => { if (brgy.dataset.free || isOutsidePH()) { brgy.value = titleCase(brgy.value); unlockZip(clean(brgy.value).length >= 2); } });
    }
    const zip = $('newSupplierZip');
    if (zip && !zip.dataset.geo) {
      zip.dataset.geo = '1';
      zip.addEventListener('input', () => scheduleZipCheck());
    }
    const region = $('newSupplierRegion');
    if (!region.dataset.retryBound) {
      region.dataset.retryBound = '1';
      region.addEventListener('geo-retry', () => { ensureRegions(); });
    }
  }

  let prefillToken = 0;
  async function prefillAddress(sup) {
    const token = ++prefillToken;
    resetBelowRegion(false);
    if (!(await ensureRegions()) || token !== prefillToken) return;
    if (!sup || !sup.region) return;
    const reg = findByName(GEO.regions, sup.region);
    if (!reg) {                                          // older record with a region name we do not know: show it as it was
      setBox('newSupplierRegion', { value: sup.region, disabled: false });
      setBox('newSupplierProvince', { value: sup.province, disabled: false });
      setBox('newSupplierCity', { value: sup.city, disabled: false });
      setBox('newSupplierBarangay', { value: sup.barangay, disabled: false });
      const z = $('newSupplierZip'); z.value = sup.zip || ''; z.disabled = false;
      return;
    }
    setBox('newSupplierRegion', { value: reg.name, code: reg.code, disabled: false });
    await onRegionPick(reg);
    if (token !== prefillToken) return;
    if (reg.name === OUTSIDE_PH) {
      setBox('newSupplierProvince', { value: sup.province, disabled: false });
      setBox('newSupplierCity', { value: sup.city, disabled: false });
      setBox('newSupplierBarangay', { value: sup.barangay, disabled: false, placeholder: 'District / barangay (optional)' });
    } else {
      if (GEO.provinces.length) {
        const prov = findByName(GEO.provinces, sup.province);
        if (prov) { setBox('newSupplierProvince', { value: prov.name, code: prov.code, disabled: false }); await onProvincePick(prov); }
        else { setBox('newSupplierProvince', { value: sup.province, disabled: false }); GEO.cities = []; }
      }
      if (token !== prefillToken) return;
      const city = findByName(GEO.cities, sup.city);
      if (city) {
        setBox('newSupplierCity', { value: city.name, code: city.code, disabled: false });
        if (await loadBarangays(city) && token === prefillToken) {
          const bg = findByName(GEO.barangays, sup.barangay);
          if (bg) setBox('newSupplierBarangay', { value: bg.name, code: bg.code, disabled: false });
          else if ($('newSupplierBarangay').dataset.free) $('newSupplierBarangay').value = sup.barangay || '';
        }
      } else setBox('newSupplierCity', { value: sup.city, disabled: false });
    }
    if (token !== prefillToken) return;
    const z = $('newSupplierZip');
    z.disabled = false; z.value = sup.zip || ''; z.placeholder = 'e.g. 2009';
    setZipStatus('Checked against ' + (sup.city || 'the selected city'));
  }

  // ZIP -> supplier address: picks each level from the PSGC lists exactly as a click would (the ZIP is then checked as usual)
  async function supplierZipFill(place) {
    const pick = (list, want) => { const n = want && FA.bestName(list.map((x) => x.name), want); return n ? list.find((x) => x.name === n) : null; };
    if (!(await ensureRegions())) return;
    const reg = pick(GEO.regions, place.region); if (!reg) return;
    setBox('newSupplierRegion', { value: reg.name, code: reg.code }); await onRegionPick(reg);
    if (GEO.provinces.length) {
      const prov = pick(GEO.provinces, place.province); if (!prov) return;
      setBox('newSupplierProvince', { value: prov.name, code: prov.code }); await onProvincePick(prov);
    }
    const city = pick(GEO.cities, place.city); if (!city) return;
    setBox('newSupplierCity', { value: city.name, code: city.code });
    GEO.zip = null; clearTimeout(GEO.zipTimer); unlockZip(false);     // what picking the city does, but waiting for the barangay list
    if (!(await loadBarangays(city))) return;
    const bg = pick(GEO.barangays, place.barangay);
    if (bg) { setBox('newSupplierBarangay', { value: bg.name, code: bg.code }); onBarangayPick(bg); }
    const zip = $('newSupplierZip'); zip.value = place.zip;
    if (bg) scheduleZipCheck(0);
    $('newSupplierForm').dataset.faDirty = '1';
    ['newSupplierRegion', 'newSupplierProvince', 'newSupplierCity', 'newSupplierBarangay'].forEach((id) => validateField(id, false));
  }

  const SUPPLIER_FIELDS = { name: 'newSupplierName', contactPerson: 'newSupplierContactPerson', phone: 'newSupplierPhone', email: 'newSupplierEmail',
    address: 'newSupplierAddress', leadTimeDays: 'newSupplierLeadTime', city: 'newSupplierCity', barangay: 'newSupplierBarangay', province: 'newSupplierProvince', region: 'newSupplierRegion', zip: 'newSupplierZip',
    products: 'newSupplierProducts' };

  // duplicate supplier checks against the loaded list (the server re-checks on save)
  const phoneKey = (p) => String(p || '').replace(/[\s().-]/g, '').replace(/^\+63/, '0');
  const editingSupplier = () => (typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null);
  const otherSuppliers = () => supplierData.filter((x) => x.id !== editingSupplier());
  function supplierDup(field, value) {
    const v = clean(value); if (!v) return '';
    const mine = supplierData.find((x) => x.id === editingSupplier());
    if (field === 'name') {
      const d = otherSuppliers().find((x) => sameText(x.name, v));
      return d && !(mine && sameText(mine.name, v)) ? 'A supplier named "' + d.name + '" already exists' + (d.status === 'archived' ? ' (archived)' : '') : '';
    }
    if (field === 'email') {
      const d = otherSuppliers().find((x) => x.email && sameText(x.email, v));
      return d && !(mine && mine.email && sameText(mine.email, v)) ? 'This email is already used by ' + d.name : '';
    }
    const d = otherSuppliers().find((x) => x.phone && phoneKey(x.phone) === phoneKey(v));
    return d && !(mine && phoneKey(mine.phone) === phoneKey(v)) ? 'This phone number is already used by ' + d.name : '';
  }
  const CONTACT_PERSON_RE = /^[A-Za-z][A-Za-z .,'’-]*$/;

  function setupSupplierModal() {
    const overlay = $('newSupplierModalOverlay'), form = $('newSupplierForm');
    if (!overlay || !form || form.dataset.bridge) return;
    form.dataset.bridge = '1';
    ['newSupplierName', 'newSupplierContactPerson', 'newSupplierAddress'].forEach(liveTitleCase);
    setupSupplierInputFilters();
    setupAddressFields();
    if (FA) {
      FA.phone.bind($('newSupplierPhone'));
      FA.email.bind($('newSupplierEmail'));
      // "Know the ZIP code?": fills Region > Province > City (> Barangay) through the same search lists the person would use
      const regionGroup = $('newSupplierRegion').closest('.form-row');
      FA.zipFill({ before: regionGroup, fill: supplierZipFill });
      FA.guard(form, { overlay, closeSelector: '#newSupplierCloseBtn, #newSupplierCancelBtn', close: () => closeNewSupplierModal() });
      FA.keyboard(form);
    }
    $('newSupplierEmail').addEventListener('input', scheduleEmailCheck);
    $('newSupplierEmail').addEventListener('blur', scheduleEmailCheck);
    form.addEventListener('reset', () => setTimeout(() => { setEmailStatus(EMAIL_HINT); setupSupplierInputFilters(); prefillToken++; resetBelowRegion(false); }, 0));
    new MutationObserver(() => { if (overlay.classList.contains('open')) onSupplierModalOpen(); })
      .observe(overlay, { attributes: true, attributeFilter: ['class'] });

    form.addEventListener('submit', async (e) => {
      e.preventDefault(); e.stopImmediatePropagation();
      const banner = $('newSupplierFormError');
      const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
      const errs = {};
      const T = (id, label, o) => { const v = vText(errs, id, label, o); return v && !errs[id] ? titleCase(v) : v; };
      const name = T('newSupplierName', 'Supplier name', { min: 2 });
      if (name && !errs.newSupplierName) errs.newSupplierName = (!/[A-Za-z]/.test(name) ? 'Supplier name must contain letters' : supplierDup('name', name)) || undefined;
      if (!errs.newSupplierName) delete errs.newSupplierName;
      const contactPerson = T('newSupplierContactPerson', 'Contact person', { min: 2, max: 80 });
      if (contactPerson && !errs.newSupplierContactPerson && !CONTACT_PERSON_RE.test(contactPerson)) errs.newSupplierContactPerson = 'Contact person can only have letters, spaces, . , \' and -';
      const phone = vText(errs, 'newSupplierPhone', 'Phone number', { min: 7, max: 30, required: false });
      if (phone && !errs.newSupplierPhone && !phoneUnchanged()) { const m = phoneError(phone) || supplierDup('phone', phone); if (m) errs.newSupplierPhone = m; }
      const email = vText(errs, 'newSupplierEmail', 'Email', { min: 5, max: 120, required: false }).toLowerCase();
      if (email && !errs.newSupplierEmail && !emailUnchanged() && !EMAIL_FORMAT.test(email)) errs.newSupplierEmail = 'Enter a valid email address, e.g. name@company.com';
      if (email && !errs.newSupplierEmail && supplierDup('email', email)) errs.newSupplierEmail = supplierDup('email', email);
      if (!phone && !email) { errs.newSupplierPhone = errs.newSupplierPhone || 'Enter a phone number or an email address'; errs.newSupplierEmail = errs.newSupplierEmail || 'Enter a phone number or an email address'; }
      const address = T('newSupplierAddress', 'Warehouse address', { min: 5, max: 150 });
      const outside = isOutsidePH();
      const sameAddr = addressUnchanged();
      let city = vText(errs, 'newSupplierCity', 'City / Municipality', { min: 2, max: 60 });
      let province = vText(errs, 'newSupplierProvince', 'Province / State', { min: 2, max: 60 });
      let barangay = vText(errs, 'newSupplierBarangay', 'Barangay', { min: 2, max: 80, required: !outside });
      if (outside) { city = titleCase(city); province = titleCase(province); barangay = titleCase(barangay); }
      const region = clean($('newSupplierRegion').value);
      if (!region) errs.newSupplierRegion = 'Choose a region';
      else if (!sameAddr && !picked('newSupplierRegion')) errs.newSupplierRegion = 'Pick a region from the list';
      if (!errs.newSupplierProvince && !sameAddr && !picked('newSupplierProvince')) errs.newSupplierProvince = 'Pick a province from the list';
      if (!errs.newSupplierCity && !sameAddr && !picked('newSupplierCity')) errs.newSupplierCity = 'Pick a city / municipality from the list';
      if (!errs.newSupplierBarangay && !sameAddr && !outside && !picked('newSupplierBarangay')) errs.newSupplierBarangay = 'Pick a barangay from the list';
      const zip = vText(errs, 'newSupplierZip', 'ZIP code', { min: 1, max: 10 });
      if (zip && !errs.newSupplierZip && region) { const m = zipError(zip, region); if (m) errs.newSupplierZip = m; }
      // the ZIP code must belong to the chosen city (checked with the postal list)
      if (zip && !outside && !sameAddr && !errs.newSupplierZip && !errs.newSupplierCity && !errs.newSupplierBarangay && !errs.newSupplierProvince && !errs.newSupplierRegion) {
        setZipStatus('Checking ZIP code…');
        const z = await checkZipMatch();
        if (z.unknown) setZipStatus('Could not check the ZIP code right now — the server will check it');
        else if (!z.ok) { errs.newSupplierZip = z.message; setZipStatus('Checked against ' + city); }
        else setZipStatus('ZIP code matches ' + city, '#5fbf8a');
      }
      const leadRaw = clean(($('newSupplierLeadTime') || {}).value);
      if (leadRaw && !(/^\d{1,3}$/.test(leadRaw) && +leadRaw <= 365)) errs.newSupplierLeadTime = 'Lead time must be a whole number of days from 0 to 365';
      const productSkus = [].map.call($('newSupplierProducts').querySelectorAll('.prod-check:checked'), (c) => c.value);
      if (!productSkus.length) errs.newSupplierProducts = 'Tick at least one product this supplier provides';
      // the email's domain must really exist and be able to receive mail
      if (email && !errs.newSupplierEmail && !emailUnchanged()) {
        setEmailStatus('Checking email domain…');
        const r = await checkEmail(email);
        if (!r.ok) { emailResults.delete(email); errs.newSupplierEmail = r.message; setEmailStatus(EMAIL_HINT); }
        else if (r.unverified) setEmailStatus('Email format is OK (domain could not be checked right now)');
        else setEmailStatus('Email domain is valid', '#5fbf8a');
      }
      if (Object.keys(errs).length) return showErrors(form, banner, errs);

      clearErrors(form); hideBanner(banner);
      const payload = { name, contactPerson, phone, email, address, city, barangay, province, region, zip, productSkus };
      if (leadRaw) payload.leadTimeDays = Number(leadRaw);
      try {
        if (id) await api('/suppliers/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/suppliers', { method: 'POST', body: JSON.stringify(payload) });
        toast(id ? 'Supplier updated' : 'Supplier added');
        closeNewSupplierModal();
        await load();
      } catch (err) {
        showErrors(form, banner, mapFields(err.fields, SUPPLIER_FIELDS), err.message);
      }
    }, true);

    const archive = $('archiveSupplierBtn');
    if (archive) archive.addEventListener('click', async () => {
      const id = typeof editingSupplierId !== 'undefined' && editingSupplierId ? editingSupplierId : null;
      const supplier = id && supplierData.find((s) => s.id === id);
      if (!supplier) return;
      const next = supplier.status === 'archived' ? 'active' : 'archived';
      const del = next === 'archived';
      const reason = await uiConfirm({ title: (del ? 'Delete ' : 'Restore ') + supplier.name + '?', message: del ? 'The supplier is hidden from new purchase records. It is kept, not erased: you can restore it from the Deleted tab.' : 'The supplier can be used again.', confirm: del ? 'Delete' : 'Restore', danger: del, reason: del ? { label: 'Reason for deleting' } : undefined });
      if (!reason) return;
      try {
        await api('/suppliers/' + encodeURIComponent(id) + '/status', { method: 'PATCH', body: JSON.stringify(del ? { status: next, reason } : { status: next }) });
        toast('Supplier ' + (del ? 'deleted' : 'restored'));
        closeNewSupplierModal();
        await load();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  /* =====================================================
     MOVEMENT LOG  (fills the table on Stock In / Out and filters it)
  ===================================================== */
  let movementDetailOverlay = null;
  function ensureMovementDetailModal() {
    if (movementDetailOverlay) return movementDetailOverlay;
    movementDetailOverlay = document.createElement('div');
    movementDetailOverlay.className = 'modal-overlay';
    movementDetailOverlay.id = 'movementDetailOverlay';
    movementDetailOverlay.innerHTML =
      '<div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="movTitle" style="max-width:580px">' +
        '<button type="button" class="modal-close" id="movClose" aria-label="Close">×</button>' +
        '<div id="movBody"></div>' +
      '</div>';
    document.body.appendChild(movementDetailOverlay);
    const close = () => {
      movementDetailOverlay.classList.remove('open');
      if (!document.querySelector('.modal-overlay.open')) {
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
      }
    };
    movementDetailOverlay.addEventListener('click', (e) => { if (e.target === movementDetailOverlay) close(); });
    movementDetailOverlay.querySelector('#movClose').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && movementDetailOverlay.classList.contains('open')) close();
    });
    return movementDetailOverlay;
  }

  function openMovementDetails(ref) {
    const m = (movementCache || []).find((x) => x.ref === ref);
    if (!m) return;
    const overlay = ensureMovementDetailModal();
    const isIn = m.type === 'in';
    const totalCost = (m.unitCost != null && !isNaN(m.unitCost)) ? (Number(m.unitCost) * Number(m.qty)) : null;
    const formattedTotal = totalCost != null ? (typeof formatCurrency === 'function' ? formatCurrency(totalCost) : 'PHP ' + totalCost.toFixed(2)) : '—';
    const formattedUnit = (m.unitCost != null && !isNaN(m.unitCost)) ? (typeof formatCurrency === 'function' ? formatCurrency(m.unitCost) : 'PHP ' + Number(m.unitCost).toFixed(2)) : '—';

    const row = (dt, dd) => '<div class="pd-row"><dt>' + dt + '</dt><dd>' + dd + '</dd></div>';

    overlay.querySelector('#movBody').innerHTML =
      '<div class="supplier-modal-head">' +
        '<div class="supplier-modal-icon">' +
          '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 12 5 5 5-5"/><path d="M12 7v10"/></svg>' +
        '</div>' +
        '<div>' +
          '<div class="modal-eyebrow">Stock Movement · ' + esc(m.department || '') + '</div>' +
          '<h2 class="modal-title" id="movTitle" style="margin-bottom:0;">' + esc(m.product) + '</h2>' +
          '<div class="pd-sub"><span class="mono">' + esc(m.ref) + '</span> ' +
            '<span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'Stock In (Replenishment)' : 'Stock Out (Deduction)') + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<dl class="pd-grid">' +
        row('Quantity', '<b>' + (isIn ? '+' : '-') + esc(formatNumber(m.qty)) + ' ' + esc(m.unit) + '</b>') +
        row('Cost & Value', formattedUnit + ' (Total: <b>' + formattedTotal + '</b>)') +
        row('Reason', esc(m.reason || '—')) +
        row('Supplier', m.supplier ? esc(m.supplier) : '<span class="dim">Internal / Not specified</span>') +
        row('Invoice / PO No.', m.invoiceNo ? '<span class="mono">' + esc(m.invoiceNo) + '</span>' : '<span class="dim">None recorded</span>') +
        row('Production Batch', m.productionRef ? '<span class="mono">' + esc(m.productionRef) + '</span>' + (m.relatedProduct ? ' (for ' + esc(m.relatedProduct) + ')' : '') : '<span class="dim">Not linked</span>') +
        row('Handled By', esc(m.handledBy)) +
        row('Date & Time', esc(m.dateTime)) +
      '</dl>' +
      (m.note ? '<div class="pd-note" style="margin-top:12px"><b>Transaction note:</b> ' + esc(m.note) + '</div>' : '') +
      '<div class="modal-footer" style="margin-top:18px;display:flex;justify-content:flex-end">' +
        '<button type="button" class="btn-secondary" id="movCloseBtn">Close</button>' +
      '</div>';

    overlay.querySelector('#movCloseBtn').addEventListener('click', () => {
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

  function renderMovementLog() {
    const body = $('movementLogTableBody');
    if (!body) return;
    const term = (($('logSearch') || {}).value || '').trim().toLowerCase();
    const type = ($('logTypeFilter') || {}).value || 'all';
    const rows = movementCache.filter((m) =>
      (type === 'all' || m.type === type) &&
      (!term || (m.product || '').toLowerCase().indexOf(term) >= 0 || (m.ref || '').toLowerCase().indexOf(term) >= 0 ||
        (m.reason || '').toLowerCase().indexOf(term) >= 0 || (m.productionRef || '').toLowerCase().indexOf(term) >= 0 ||
        (m.relatedProduct || '').toLowerCase().indexOf(term) >= 0));
    const sub = $('logPanelSub');
    if (sub) sub.textContent = 'Showing ' + rows.length + ' of ' + movementCache.length + ' recorded stock in / out entries';
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="dim" style="text-align:center;padding:24px">' +
        (movementCache.length ? 'No movements match your search.' : 'No stock movements recorded yet.') + '</td></tr>';
      return;
    }
    body.innerHTML = rows.map((m) => {
      const isIn = m.type === 'in';
      const formattedUnit = (m.unitCost != null && !isNaN(m.unitCost)) ? (typeof formatCurrency === 'function' ? formatCurrency(m.unitCost) : 'PHP ' + Number(m.unitCost).toFixed(2)) : '—';

      return '<tr class="mov-row" data-mov-ref="' + esc(m.ref) + '" style="cursor:pointer">' +
        '<td class="mono">' + esc(m.ref) + '</td>' +
        '<td>' + esc(m.product) + '</td>' +
        '<td><span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'In' : 'Out') + '</span></td>' +
        '<td class="dim">' + esc(m.reason || '') + (m.productionRef ? '<div style="font-size:12.5px">' + esc(m.productionRef) + (m.relatedProduct ? ' · for ' + esc(m.relatedProduct) : '') + '</div>' : '') + '</td>' +
        '<td class="dim">' + (isIn ? '+' : '-') + esc(formatNumber(m.qty)) + ' ' + esc(m.unit) + '</td>' +
        '<td class="dim">' + esc(m.department) + '</td>' +
        '<td class="dim">' + formattedUnit + '</td>' +
        '<td class="dim">' + esc(m.handledBy) + '</td>' +
        '<td class="dim">' + esc(m.dateTime) + '</td></tr>';
    }).join('');

    body.querySelectorAll('tr.mov-row').forEach((row) => {
      row.addEventListener('click', () => {
        openMovementDetails(row.dataset.movRef);
      });
    });
  }

  function setupMovementLog() {
    const s = $('logSearch'), t = $('logTypeFilter');
    if (s) s.addEventListener('input', renderMovementLog);
    if (t) t.addEventListener('change', renderMovementLog);
  }

  /* =====================================================
     STOCK ALERTS - a banner that stays on every page until stock is added.
     Out of stock (0) = critical, at/below reorder level = low.
     It cannot be dismissed: it clears by itself once Stock In lifts the item above its reorder level.
  ===================================================== */
  const ALERT_SOUND_KEY = 'te_alert_sound';
  const ALERT_EVERY = { critical: 45000, low: 180000 };      // how often the sound repeats
  let alertList = [], alertSeen = null, alertCtx = null, alertExpanded = false;
  const alertLast = { critical: 0, low: 0 };
  let alertBaseTitle = '', alertFlip = false;
  const alertSoundOn = () => { try { return localStorage.getItem(ALERT_SOUND_KEY) !== 'off'; } catch (e) { return true; } };

  function alertAction(i) {
    if (NEEDS_SUPPLIER.indexOf(i.department) < 0) return 'Schedule production (made in-house)';
    const sup = (i.suppliers || []).filter((s) => s.status !== 'archived');
    const main = sup.find((s) => s.primary) || sup[0];
    return main ? 'Reorder from ' + main.name : 'No supplier linked: link one in Supplier Management';
  }
  function computeAlerts() {
    return inventoryCache
      .filter((i) => Number(i.onHand) <= Number(i.reorderLevel))
      .map((i) => ({ item: i, critical: Number(i.onHand) <= 0 }))
      .sort((a, b) => (b.critical - a.critical) ||
        (Number(a.item.onHand) / (Number(a.item.reorderLevel) || 1)) - (Number(b.item.onHand) / (Number(b.item.reorderLevel) || 1)));
  }

  function alertBeep(critical) {
    if (!alertSoundOn() || !alertCtx) return;                 // browsers allow sound only after the first click on the page
    try {
      if (alertCtx.state === 'suspended') alertCtx.resume();
      (critical ? [880, 660, 880, 660, 880] : [660, 660]).forEach((freq, n) => {
        const o = alertCtx.createOscillator(), g = alertCtx.createGain();
        o.type = 'square'; o.frequency.value = freq; g.gain.value = 0.05;
        o.connect(g); g.connect(alertCtx.destination);
        const t = alertCtx.currentTime + n * 0.26;
        o.start(t); o.stop(t + 0.18);
      });
    } catch (e) { /* sound is a bonus; the banner is the alert */ }
  }

  function alertBanner() {
    let el = $('stockAlertBanner');
    if (el) return el;
    const bar = document.querySelector('.topbar');
    if (!bar) return null;
    el = document.createElement('div');
    el.id = 'stockAlertBanner'; el.className = 'stock-alert'; el.hidden = true;
    el.setAttribute('role', 'alert'); el.setAttribute('aria-live', 'assertive');
    bar.parentNode.insertBefore(el, bar.nextSibling);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sa]');
      if (!b) return;
      if (b.dataset.sa === 'toggle') { alertExpanded = !alertExpanded; renderStockAlerts(); }
      else if (b.dataset.sa === 'sound') {
        try { localStorage.setItem(ALERT_SOUND_KEY, alertSoundOn() ? 'off' : 'on'); } catch (err) { /* ignore */ }
        renderStockAlerts(); if (alertSoundOn()) alertBeep(false);
      } else if (b.dataset.sa === 'stockin') goStockIn(b.dataset.sku);
    });
    return el;
  }

  function goStockIn(sku, suggestedQty, supplierId, unitCost, orderDate) {
    const item = inventoryCache.find((i) => i.sku === sku);
    if (!item) return;
    const nav = document.querySelector('.nav-item[data-page="stockflow"]');
    if (nav) nav.click();
    const seg = document.querySelector('#movementTypeToggle .seg-btn[data-type="in"]');
    if (seg && !seg.classList.contains('active')) seg.click();
    const dept = $('movementDept');
    if (dept) { dept.value = item.department; dept.dispatchEvent(new Event('change', { bubbles: true })); }
    const prod = $('movementProduct');
    if (prod) { prod.value = sku; prod.dispatchEvent(new Event('change', { bubbles: true })); }
    const reason = $('movementReason');
    if (reason && (!reason.value || reason.value !== 'supplier_receipt')) {
      reason.value = 'supplier_receipt';
      reason.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const qtyVal = suggestedQty != null ? suggestedQty : (item.reorderLevel > item.onHand ? Math.max(1, Math.round(item.reorderLevel - item.onHand)) : '');
    const qty = $('movementQuantity');
    if (qty) {
      if (qtyVal) qty.value = qtyVal;
      qty.dispatchEvent(new Event('input', { bubbles: true }));
      qty.focus();
    }
    if (supplierId && $('movementSupplier')) {
      $('movementSupplier').value = supplierId;
      $('movementSupplier').dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (unitCost != null && $('movementUnitCost')) {
      $('movementUnitCost').value = Number(unitCost).toFixed(2);
      $('movementUnitCost').dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (orderDate && $('movementOrderDate')) {
      $('movementOrderDate').value = orderDate;
      $('movementOrderDate').dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  window.goStockIn = goStockIn;

  /* ---------------- Dashboard: every KPI card opens its own matching table ---------------- */
  const KPI_ICONS = {
    skus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    low: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    alerts: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
    movements: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/></svg>',
    orders: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>'
  };
  const dashKpi = { sel: 'low', bound: false, alerts: null, alertsAt: 0, alertsErr: '' };
  const KPI_CARD = { skus: 'totalSkus', low: 'dashLowStock', alerts: 'ncStatValue', movements: 'dashMovements', orders: 'totalOrders' };
  const ratioOf = (i) => (i.reorderLevel > 0 ? i.onHand / i.reorderLevel : (i.onHand <= 0 ? 0 : 99));
  const byPriority = (list) => {
    const rank = { low: 0, watch: 1, ok: 2 };
    return list.slice().sort((a, b) => {
      const ra = rank[getStockStatus(a)], rb = rank[getStockStatus(b)];
      if (ra !== rb) return ra - rb;
      return ra < 2 ? ratioOf(a) - ratioOf(b) : String(a.name).localeCompare(String(b.name));
    });
  };
  function movements7d(list) {
    const to = saleDay(Date.now()), from = saleDay(Date.now() - 6 * 86400000);
    return (list || []).filter((m) => m.date && m.date >= from && m.date <= to).length;
  }
  const dTable = (heads, rows, empty, cols) => '<div class="table-wrapper"><table><thead><tr>' + heads.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
    (rows.length ? rows.join('') : '<tr><td colspan="' + cols + '" class="report-note">' + empty + '</td></tr>') + '</tbody></table></div>';
  const statusCell = (i) => { const st = getStockStatus(i); return '<span class="status-pill ' + st + '">' + (st === 'low' && i.onHand <= 0 ? 'Out of stock' : getStockStatusLabel(st)) + '</span>'; };

  async function fetchDashAlerts() {
    try {
      const d = await api('/notifications?unread=1&limit=10');
      dashKpi.alerts = d; dashKpi.alertsErr = '';
    } catch (e) { if (e.message === 'Not signed in') throw e; dashKpi.alertsErr = e.message || 'Could not load alerts.'; }
    dashKpi.alertsAt = Date.now();
    if (dashKpi.sel === 'alerts') safe(renderDashKpiTable);
  }

  function renderDashKpiTable() {
    const box = $('dashKpiPanel'); if (!box) return;
    const dash = $('dashboard');
    if (!dashKpi.bound && dash) {
      dashKpi.bound = true;
      Object.keys(KPI_CARD).forEach((k) => {
        const v = $(KPI_CARD[k]), card = v && v.closest('.stat-card');
        if (!card) return;
        card.dataset.kpi = k; card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); card.classList.add('dash-kpi');
      });
      const pick = (e) => {
        const card = e.target.closest('.stat-card[data-kpi]'); if (!card) return false;
        e.preventDefault(); e.stopPropagation();       // the Unread Alerts card used to jump away; now it shows its table here
        dashKpi.sel = card.dataset.kpi;
        if (dashKpi.sel === 'alerts') fetchDashAlerts();
        renderDashKpiTable();
        return true;
      };
      dash.addEventListener('click', (e) => { if (pick(e)) return; }, true);
      dash.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pick(e); }, true);
      box.addEventListener('click', (e) => {
        const go = e.target.closest('[data-kpi-go]'); if (!go) return;
        const t = go.dataset.kpiGo;
        if (t === 'notifications' && window.NotificationCenter) window.NotificationCenter.openPage();
        else { const nav = document.querySelector('.nav-item[data-page="' + t + '"]'); if (nav) nav.click(); }
      });
      if (dashKpi.sel === 'alerts') fetchDashAlerts();
    }
    document.querySelectorAll('#dashboard .stat-card[data-kpi]').forEach((c) => c.classList.toggle('is-selected', c.dataset.kpi === dashKpi.sel));

    const inv = inventoryCache || [];
    let title = '', sub = '', go = '', goLabel = '', body = '';
    if (dashKpi.sel === 'skus') {
      title = 'All SKUs'; sub = inv.length + ' product' + (inv.length === 1 ? '' : 's') + ' \u00B7 low stock listed first'; go = 'inventory'; goLabel = 'Open Inventory Monitoring';
      body = dTable(['Product', 'SKU', 'Department', 'On hand', 'Reorder level', 'Status'],
        byPriority(inv).slice(0, 12).map((i) => '<tr class="inv-row ' + getStockStatus(i) + '"><td>' + esc(i.name) + '</td><td class="mono">' + esc(i.sku) + '</td><td class="dim">' + esc(i.department) + '</td><td>' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td><td class="dim">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td>' + statusCell(i) + '</td></tr>'),
        'No products yet.', 6) + (inv.length > 12 ? '<div class="dash-kpi-more">Showing 12 of ' + inv.length + '. Open Inventory Monitoring for the full list.</div>' : '');
    } else if (dashKpi.sel === 'low') {
      const low = byPriority(inv.filter((i) => getStockStatus(i) === 'low'));
      title = 'Low stock'; sub = low.length ? low.length + ' at or below reorder level \u00B7 most urgent first' : 'Nothing is at or below its reorder level'; go = 'inventory'; goLabel = 'Open Inventory Monitoring';
      body = dTable(['Product', 'SKU', 'Department', 'On hand', 'Reorder level', 'Need', 'Location'],
        low.slice(0, 12).map((i) => '<tr class="inv-row low"><td>' + esc(i.name) + '</td><td class="mono">' + esc(i.sku) + '</td><td class="dim">' + esc(i.department) + '</td><td class="qty-out">' + (i.onHand <= 0 ? 'Out of stock' : esc(num(i.onHand)) + ' ' + esc(i.unit)) + '</td><td class="dim">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td class="qty-out">' + esc(num(Math.max(i.reorderLevel - i.onHand, 0))) + ' ' + esc(i.unit) + '</td><td class="dim">' + esc(i.location || '') + '</td></tr>'),
        'All stock is healthy.', 7) + (low.length > 12 ? '<div class="dash-kpi-more">Showing 12 of ' + low.length + '. Open Inventory Monitoring for the rest.</div>' : '');
    } else if (dashKpi.sel === 'alerts') {
      const d = dashKpi.alerts, items = (d && d.items) || [];
      title = 'Unread alerts'; sub = d ? (d.unread || 0) + ' unread \u00B7 newest first' : 'Loading...'; go = 'notifications'; goLabel = 'Open Notification Center';
      body = dashKpi.alertsErr ? '<div class="dash-kpi-more">' + esc(dashKpi.alertsErr) + '</div>'
        : dTable(['Type', 'Alert', 'Details', 'When'], items.map((n) => '<tr><td><span class="status-pill ' + (n.severity === 'critical' ? 'low' : n.severity === 'warn' ? 'watch' : 'ok') + '">' + esc(n.category || '') + '</span></td><td>' + esc(n.title) + '</td><td class="dim">' + esc(n.body || '') + '</td><td class="dim">' + esc(n.when || '') + '</td></tr>'),
          d ? 'You are all caught up.' : 'Loading...', 4);
      if (!dashKpi.alerts && !dashKpi.alertsErr && Date.now() - dashKpi.alertsAt > 3000) fetchDashAlerts();
    } else if (dashKpi.sel === 'movements') {
      const to = saleDay(Date.now()), from = saleDay(Date.now() - 6 * 86400000);
      const mv = movementCache.filter((m) => m.date && m.date >= from && m.date <= to);
      title = 'Stock movements, last 7 days'; sub = mv.length + ' entr' + (mv.length === 1 ? 'y' : 'ies') + ' \u00B7 ' + niceDate(from) + ' to ' + niceDate(to); go = 'stockflow'; goLabel = 'Open Stock In / Out';
      body = dTable(['Ref', 'Date', 'Product', 'Type', 'Quantity', 'Reason', 'Handled by'],
        mv.slice(0, 12).map((m) => { const isIn = m.type === 'in'; return '<tr><td class="mono">' + esc(m.ref) + '</td><td class="dim">' + esc(niceDate(m.date)) + '</td><td>' + esc(m.product) + '</td><td><span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'In' : 'Out') + '</span></td><td class="' + (isIn ? 'qty-in' : 'qty-out') + '">' + (isIn ? '+' : '-') + esc(num(m.qty)) + ' ' + esc(m.unit) + '</td><td class="dim">' + esc(m.reason || '') + '</td><td class="dim">' + esc(m.handledBy || '') + '</td></tr>'; }),
        'No stock movements in the last 7 days.', 7) + (mv.length > 12 ? '<div class="dash-kpi-more">Showing 12 of ' + mv.length + '. Open Stock In / Out for the full log.</div>' : '');
    } else {
      const all = salesCache.slice().sort((a, b) => b.createdAt - a.createdAt);
      title = 'Orders and sales'; sub = dashboardMockDisplay.orders === null ? 'Loading...' : dashboardMockDisplay.orders + ' online order' + (dashboardMockDisplay.orders === 1 ? '' : 's') + ' (' + dashboardMockDisplay.ordersOpen + ' to process) \u00B7 ' + dashboardMockDisplay.posSales + ' POS sales \u00B7 latest first'; go = 'sales'; goLabel = 'Open POS Sales & Shifts';
      body = dTable(['Ref', 'Date', 'Source', 'Customer', 'Total', 'Status'],
        all.slice(0, 12).map((t) => '<tr><td class="mono">' + esc(t.ref) + '</td><td class="dim">' + esc(niceDate(saleDay(t.createdAt))) + '</td><td class="dim">' + (t.source === 'POS' ? 'POS walk-in' : 'Online shop') + '</td><td>' + esc(t.customer || '') + '</td><td>' + esc(money(t.total || 0)) + '</td><td><span class="status-pill ' + (/cancel|void/i.test(t.status) ? 'low' : /deliver|picked|complete|paid/i.test(t.status) ? 'ok' : 'watch') + '">' + esc(t.status || '') + '</span></td></tr>'),
        'No orders or sales yet.', 6) + (all.length > 12 ? '<div class="dash-kpi-more">Showing 12 of ' + all.length + '. Open POS Sales & Shifts for everything.</div>' : '');
    }
    const navOk = go === 'notifications' ? !!window.NotificationCenter : !!document.querySelector('.nav-item[data-page="' + go + '"]');
    box.className = 'panel dash-kpi-panel kpi-' + dashKpi.sel;
    box.innerHTML = '<div class="panel-head"><div class="dash-kpi-title"><span class="dash-kpi-ico">' + KPI_ICONS[dashKpi.sel] + '</span><div><div class="panel-title">' + esc(title) + '</div><div class="panel-sub">' + esc(sub) + '</div></div></div>' +
      (navOk ? '<button type="button" class="btn-secondary" data-kpi-go="' + go + '">' + esc(goLabel) + '</button>' : '') + '</div>' + body;
  }

  function renderStockAlerts() {
    alertList = computeAlerts();
    const el = alertBanner();
    if (el) { el.hidden = true; el.className = 'stock-alert'; el.innerHTML = ''; }
    ['inventory', 'stockflow'].forEach((page) => {
      const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
      if (!nav) return;
      const badge = nav.querySelector('.nav-alert');
      if (badge) badge.remove();
    });
  }

  function setupStockAlerts() {
    /* Low-stock banners/sounds moved to the Notification Center. Detection stays on the server. */
  }

  /* ---- keep data live: refresh every 10 s and whenever the tab is shown again ---- */
  let refreshing = false, refreshAgain = false;
  async function liveRefresh(force) {
    if (force === true && refreshing) { refreshAgain = true; return; }   // run once more right after the current one
    if (refreshing || document.hidden) return;
    refreshing = true;
    try { await load(); } catch (e) { console.warn('[api-bridge] refresh', e.message); } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; liveRefresh(true); }
    }
  }
  function setupLiveRefresh() {
    setInterval(() => liveRefresh(), 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) liveRefresh(); });
    window.addEventListener('focus', () => liveRefresh());
  }

  /* =====================================================
     STAY ON THE SAME PAGE AFTER A REFRESH
     (page is kept in the address bar, e.g. #usermgmt, and in localStorage)
  ===================================================== */
  const PAGE_KEY = 'tripleE.currentPage';
  const pageExists = (id) => !!id && /^[A-Za-z][\w-]*$/.test(id) && !!document.querySelector('.page#' + id);

  function setupPagePersistence() {
    const original = window.navigateToPage;
    if (typeof original !== 'function') return;
    window.navigateToPage = function (id) {
      original.apply(this, arguments);
      if (!pageExists(id)) return;
      try { localStorage.setItem(PAGE_KEY, id); } catch (e) { /* storage blocked */ }
      if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
      window.scrollTo(0, 0);
      liveRefresh(true);
    };
    window.addEventListener('popstate', () => {            // browser Back / Forward
      const id = location.hash.slice(1);
      if (pageExists(id)) original(id);
    });
    let saved = null;
    try { saved = localStorage.getItem(PAGE_KEY); } catch (e) { /* ignore */ }
    const wanted = [location.hash.slice(1), saved].find(pageExists);
    if (wanted && wanted !== 'dashboard') original(wanted);
    if (wanted && location.hash !== '#' + wanted) history.replaceState(null, '', '#' + wanted);
  }

  /* =====================================================
     LIVE VALIDATION — message appears under the box while typing / on leaving it
  ===================================================== */
  const LIVE = {};         // field id -> () => error message ('' when OK)
  const FORM_BANNERS = { movementForm: 'movementFormError', newProductForm: 'newProductFormError',
    newSupplierForm: 'newSupplierFormError', inviteUserForm: 'inviteUserFormError', editUserForm: 'editUserFormError' };
  const DEPENDS = {                                        // when X changes, re-check these (if already touched)
    movementProduct: ['movementQuantity', 'movementReason'],
    movementReason: ['movementNote', 'movementSupplier', 'movementInvoice', 'movementUnitCost'],
    movementDept: ['movementProduct', 'movementReason'],
    npCategory: ['npCategoryNew'],
    npDept: ['npListPrice', 'npWeight', 'npCostReason', 'npUnitCost'],
    npCostOverride: ['npCostReason', 'npUnitCost'],
    npUnitCost: ['npListPrice'],
    newSupplierPhone: ['newSupplierEmail'],
    newSupplierEmail: ['newSupplierPhone'],
    newSupplierRegion: ['newSupplierProvince', 'newSupplierCity', 'newSupplierBarangay', 'newSupplierZip'],
    newSupplierProvince: ['newSupplierCity', 'newSupplierBarangay', 'newSupplierZip'],
    newSupplierCity: ['newSupplierBarangay', 'newSupplierZip'],
    newSupplierBarangay: ['newSupplierZip']
  };
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  const textRule = (id, label, o) => () => { const e = {}; vText(e, id, label, o); return e[id] || ''; };
  const numRule = (id, label, o) => () => { const e = {}; vNum(e, id, label, o); return e[id] || ''; };
  const selectRule = (id, msg) => () => ($(id) && $(id).value ? '' : msg);
  const emailRule = (id) => () => {
    const v = clean($(id).value);
    if (!v) return 'Email is required';
    if (v.length > 120) return 'Email must be at most 120 characters';
    return EMAIL_RE.test(v) ? '' : 'Enter a valid email address, e.g. name@company.com';
  };

  function defineRules() {
    Object.assign(LIVE, {
      /* stock in / out */
      movementProduct: selectRule('movementProduct', 'Choose a product'),
      movementReason: () => $('movementReason').value ? '' :
        (movementType() === 'out' ? 'Choose why this stock is going out' : 'Choose why this stock is coming in'),
      movementQuantity: () => {
        const e = {}; const typed = vNum(e, 'movementQuantity', 'Quantity', { gt: true });
        if (e.movementQuantity) return e.movementQuantity;
        const item = movementItem(), q = movementQty(typed);
        if (item && movementType() === 'out' && q > item.onHand)
          return 'Only ' + formatNumber(item.onHand) + ' ' + item.unit + ' on hand — cannot take out ' + formatNumber(q);
        return '';
      },
      movementNote: () => {
        const v = clean($('movementNote').value);
        if (v.length > 300) return 'Note must be at most 300 characters';
        if (NOTE_REQUIRED.indexOf($('movementReason').value) >= 0 && v.length < 3) return 'Please explain this entry in the note';
        return '';
      },
      movementSupplier: () => movementType() === 'in' && $('movementReason').value === 'supplier_receipt' && !$('movementSupplier').value ? 'Choose the supplier this delivery came from' : '',
      movementInvoice: () => movementType() === 'in' && $('movementReason').value === 'supplier_receipt' ? textRule('movementInvoice', 'Invoice / delivery no.', { required: false, max: 40 })() : '',
      movementUnitCost: () => {
        if (movementType() !== 'in' || $('movementReason').value !== 'supplier_receipt') return '';
        const v = $('movementUnitCost').value.replace(/[,\u20B1\s]/g, '');
        return !v || (/^\d{1,8}(\.\d{1,2})?$/.test(v) && Number(v) > 0) ? '' : 'Enter the cost per unit in pesos, e.g. 145.50';
      },
      /* product */
      npWeight: () => {
        const v = clean($('npWeight').value);
        return $('npDept').value !== 'Finished Goods' || !v || (/^\d{1,6}(\.\d{1,3})?$/.test(v) && Number(v) > 0) ? '' : 'Enter the weight of one piece in kg, e.g. 1.25';
      },
      npCostReason: () => sellsNow() && costOverridden() && clean($('npCostReason').value).length < 5 ? 'Give a reason for overriding the cost (at least 5 characters)' : '',
      npSku: () => {
        const v = clean($('npSku').value).toUpperCase();
        if (!v) return 'SKU is required';
        if (!/^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(v)) return 'SKU must be 3–40 characters: letters, numbers, dot, dash or underscore';
        const d = duplicateSku(v);
        return d ? 'That SKU already exists (' + d.name + ')' : '';
      },
      npName: () => {
        const m = textRule('npName', 'Product name', { min: 2 })();
        if (m) return m;
        const d = duplicateProductName($('npName').value);
        return d ? dupNameMsg(d) : '';
      },
      npDept: () => DEPARTMENTS.indexOf($('npDept').value) >= 0 ? '' : 'Choose a department',
      npCategory: selectRule('npCategory', 'Choose a category'),
      npCategoryNew: textRule('npCategoryNew', 'Category name', { min: 2, max: 60 }),
      npUnit: selectRule('npUnit', 'Choose a unit'),
      npUnitCost: () => costAuto() ? '' : numRule('npUnitCost', 'Unit cost', { max: 1e7 })(),
      npOnHand: () => $('npOnHand').readOnly ? '' : numRule('npOnHand', 'On hand', { noLeadingZero: true })(),
      npReorder: () => ($('npReorderManual') && $('npReorderManual').checked ? numRule('npReorder', 'Reorder level', { noLeadingZero: true })() : ''),   // automatic = nothing to type
      npListPrice: () => {
        if (!sellsNow() || !priceManual()) return '';
        const bad = numRule('npListPrice', 'Selling price', { max: 1e7, gt: true })();
        if (bad) return bad;
        const c = Number(window.MoneyInput ? MoneyInput.raw($('npUnitCost').value) : $('npUnitCost').value);
        const p = Number(window.MoneyInput ? MoneyInput.raw($('npListPrice').value) : $('npListPrice').value);
        if (c > 0 && p < Math.round(c * 1.20 * 100) / 100) {
          return 'Selling price cannot be below 20% margin floor (minimum ₱' + (Math.round(c * 1.20 * 100) / 100).toFixed(2) + ')';
        }
        return '';
      },
      npLocation: selectRule('npLocation', 'Choose the storage location'),
      npLocationNew: textRule('npLocationNew', 'Storage location', { min: 2, max: 100 }),
      npSupplier: () => (!productModalState() && NEEDS_SUPPLIER.indexOf($('npDept').value) >= 0 && !$('npSupplier').value ? 'Choose the supplier for this material' : ''),
      /* supplier */
      newSupplierName: () => {
        const m = textRule('newSupplierName', 'Supplier name', { min: 2 })();
        if (m) return m;
        const v = clean($('newSupplierName').value);
        return !/[A-Za-z]/.test(v) ? 'Supplier name must contain letters' : supplierDup('name', v);
      },
      newSupplierContactPerson: () => {
        const m = textRule('newSupplierContactPerson', 'Contact person', { min: 2, max: 80 })();
        if (m) return m;
        const v = clean($('newSupplierContactPerson').value);
        return v && !CONTACT_PERSON_RE.test(v) ? 'Contact person can only have letters, spaces, . , \' and -' : '';
      },
      newSupplierPhone: () => {
        const e = {}; const v = vText(e, 'newSupplierPhone', 'Phone number', { min: 7, max: 30, required: false });
        if (e.newSupplierPhone) return e.newSupplierPhone;
        if (!v) return clean($('newSupplierEmail').value) ? '' : 'Enter a phone number or an email address';
        return phoneUnchanged() ? '' : (phoneError(v) || supplierDup('phone', v));
      },
      newSupplierEmail: () => {
        const e = {}; const v = vText(e, 'newSupplierEmail', 'Email', { min: 5, max: 120, required: false });
        if (e.newSupplierEmail) return e.newSupplierEmail;
        if (!v) return clean($('newSupplierPhone').value) ? '' : 'Enter a phone number or an email address';
        if (emailUnchanged()) return '';
        if (!EMAIL_FORMAT.test(v)) return 'Enter a valid email address, e.g. name@company.com';
        const dup = supplierDup('email', v);
        if (dup) return dup;
        const known = emailResults.get(v.toLowerCase());
        return known && !known.ok ? known.message : '';
      },
      newSupplierAddress: textRule('newSupplierAddress', 'Warehouse address', { min: 5, max: 150 }),
      newSupplierLeadTime: () => { const v = clean($('newSupplierLeadTime').value); return !v || (/^\d{1,3}$/.test(v) && +v <= 365) ? '' : 'Lead time must be a whole number of days from 0 to 365'; },
      newSupplierCity: () => {
        const m = textRule('newSupplierCity', 'City / Municipality', { min: 2, max: 60 })();
        return m || (picked('newSupplierCity') || addressUnchanged() ? '' : 'Pick a city / municipality from the list');
      },
      newSupplierBarangay: () => {
        const m = textRule('newSupplierBarangay', 'Barangay', { min: 2, max: 80, required: !isOutsidePH() })();
        return m || (picked('newSupplierBarangay') || addressUnchanged() || !clean($('newSupplierBarangay').value) ? '' : 'Pick a barangay from the list');
      },
      newSupplierProvince: () => {
        const m = textRule('newSupplierProvince', 'Province / State', { min: 2, max: 60 })();
        return m || (picked('newSupplierProvince') || addressUnchanged() ? '' : 'Pick a province from the list');
      },
      newSupplierRegion: () => {
        if (!clean($('newSupplierRegion').value)) return 'Choose a region';
        return picked('newSupplierRegion') || addressUnchanged() ? '' : 'Pick a region from the list';
      },
      newSupplierZip: () => {
        const v = clean($('newSupplierZip').value);
        if (!v) return 'ZIP code is required';
        const region = clean($('newSupplierRegion').value);
        const fmt = region ? zipError(v, region) : '';
        if (fmt) return fmt;
        // result of the live check against the selected city (the submit check also runs it)
        return GEO.zip && GEO.zip.key === zipKey() && !GEO.zip.ok && !GEO.zip.unknown ? GEO.zip.message : '';
      },
      newSupplierProducts: () => $('newSupplierProducts').querySelector('.prod-check:checked') ? '' : 'Tick at least one product this supplier provides',
      /* users */
      inviteName: textRule('inviteName', 'Full name', { min: 2, max: 100 }),
      inviteEmail: emailRule('inviteEmail'),
      inviteRole: selectRule('inviteRole', 'Choose a role'),
      editUserName: textRule('editUserName', 'Full name', { min: 2, max: 100 }),
      editUserEmail: emailRule('editUserEmail'),
      editUserRole: selectRule('editUserRole', 'Choose a role')
    });
  }

  const isActive = (el) => {
    if (!el || el.disabled || el.readOnly || !el.getClientRects().length) return false;
    const grp = el.closest('#movementNoteGroup, #npCategoryNewWrap, #npLocationNewWrap');
    return !(grp && grp.style.display === 'none');
  };

  function showLive(id, message) {
    const el = $(id);
    if (!el) return;
    const group = el.closest('.form-group') || el.parentNode;
    group.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
    el.classList.toggle('field-invalid', !!message);
    el.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) {
      const m = document.createElement('div');
      m.className = 'field-msg'; m.dataset.for = id; m.textContent = message;
      m.id = id + 'LiveError'; m.setAttribute('aria-live', 'polite');
      const descriptions = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!descriptions.includes(m.id)) descriptions.push(m.id);
      el.setAttribute('aria-describedby', descriptions.join(' '));
      group.appendChild(m);
    }
  }

  function validateField(id, force) {
    const el = $(id), rule = LIVE[id];
    if (!el || !rule) return '';
    if (!isActive(el)) { showLive(id, ''); return ''; }
    if (force) el.dataset.touched = '1';
    if (!el.dataset.touched) return '';
    const message = rule();
    showLive(id, message);
    const form = el.closest('form');
    if (form) {
      const banner = $(FORM_BANNERS[form.id]);
      if (banner && !form.querySelector('.field-invalid')) banner.classList.remove('show');
    }
    return message;
  }

  function resetLive(form) {
    form.querySelectorAll('[data-touched]').forEach((n) => delete n.dataset.touched);
    clearErrors(form);
    const banner = $(FORM_BANNERS[form.id]);
    if (banner) banner.classList.remove('show');
  }

  function setupLiveValidation() {
    defineRules();
    Object.keys(LIVE).forEach((id) => {
      const el = $(id);
      if (!el) return;
      const check = () => {
        validateField(id, true);
        (DEPENDS[id] || []).forEach((d) => validateField(d, false));
      };
      const isBox = el.classList.contains('check-list');
      if (isBox) el.addEventListener('change', check);
      else {
        el.addEventListener('input', check);
        el.addEventListener('change', check);
        el.addEventListener('blur', check);
      }
    });
    Object.keys(DEPENDS).filter((id) => !LIVE[id]).forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', () => DEPENDS[id].forEach((d) => validateField(d, false)));
    });
    // switching Stock In <-> Stock Out changes what is valid
    const toggle = $('movementTypeToggle');
    if (toggle) toggle.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      setTimeout(() => { ['movementReason', 'movementQuantity', 'movementNote', 'movementSupplier', 'movementInvoice', 'movementUnitCost'].forEach((i) => validateField(i, false)); }, 0);
    }));

    Object.keys(FORM_BANNERS).forEach((formId) => {
      const form = $(formId);
      if (!form) return;
      form.addEventListener('reset', () => resetLive(form));
      // runs BEFORE the page's own submit handlers (registered later), and blocks them when something is wrong
      form.addEventListener('submit', (e) => {
        const bad = [];
        Object.keys(LIVE).forEach((id) => { if (form.contains($(id)) && validateField(id, true)) bad.push(id); });
        if (!bad.length) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const banner = $(FORM_BANNERS[formId]);
        if (banner) { banner.textContent = 'Please fix the highlighted fields.'; banner.classList.add('show'); }
        const first = $(bad[0]);
        if (first && first.focus && first.tagName !== 'DIV') first.focus();
      }, true);
    });

    // a modal that is opened again starts clean
    ['newProductModalOverlay', 'newSupplierModalOverlay', 'inviteUserModalOverlay', 'editUserModalOverlay'].forEach((oid) => {
      const overlay = $(oid);
      if (!overlay) return;
      new MutationObserver(() => {
        if (overlay.classList.contains('open')) overlay.querySelectorAll('form').forEach((f) => {
          f.querySelectorAll('[data-touched]').forEach((n) => delete n.dataset.touched);
          clearErrors(f);
        });
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* =====================================================
     UNIT DROPDOWN (kg, pcs first, then units used for metals)
  ===================================================== */
  function setUnitValue(unit) {
    const sel = $('npUnit');
    if (!sel) return;
    unit = clean(unit);
    if (unit && ![].some.call(sel.options, (o) => o.value === unit)) {   // an older product with a unit that is not in the list
      const opt = document.createElement('option');
      opt.value = unit; opt.textContent = unit; opt.dataset.legacy = '1';
      sel.appendChild(opt);
    }
    sel.value = unit || '';
  }
  /* Finished goods are counted and sold by the piece, so for them the unit is pcs and cannot be changed (the server refuses anything else too).
     Raw materials and finishing supplies keep the whole list (kg, sheet, roll, liter...). */
  function syncUnitField(product) {
    const sel = $('npUnit'); if (!sel || sel.tagName !== 'SELECT') return;
    let note = $('npUnitNote');
    if (!note) { note = document.createElement('div'); note.id = 'npUnitNote'; note.className = 'field-hint'; sel.parentNode.appendChild(note); }
    if (($('npDept') || {}).value === 'Finished Goods') {
      const was = product && product.unit && product.unit !== 'pcs' ? product.unit : '';
      setUnitValue('pcs'); sel.disabled = true;
      note.textContent = was ? 'This product was saved per "' + was + '". Finished goods are sold by the piece (pcs), so check that the selling price is per piece before saving.' : 'Finished goods are sold by the piece (pcs).';
      note.hidden = false;
    } else { sel.disabled = false; note.textContent = ''; note.hidden = true; }
  }
  function setupUnitSelect() {
    const sel = $('npUnit');
    if (!sel || sel.tagName !== 'SELECT') return;
    const form = sel.form;
    if (form) form.addEventListener('reset', () => setTimeout(() => {
      [].filter.call(sel.options, (o) => o.dataset.legacy).forEach((o) => o.remove());
      sel.value = '';
    }, 0));
  }

  /* =====================================================
     NUMBER BOXES ONLY TAKE NUMBERS (no letters, no e, +, -, no symbols; max 2 decimals)
  ===================================================== */
  function cleanNumberText(text, current, selStart, selEnd) {
    let t = String(text).replace(/[^0-9.]/g, '');
    const before = current.slice(0, selStart), after = current.slice(selEnd);
    let next = before + t + after;
    // keep one dot and at most 2 decimals
    const firstDot = next.indexOf('.');
    if (firstDot >= 0) {
      next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, '');
      next = next.slice(0, firstDot + 1) + next.slice(firstDot + 1, firstDot + 3);
    }
    return next;
  }
  function setupNumberGuard() {
    const isNum = (el) => el && el.tagName === 'INPUT' && el.type === 'number';
    // keyboard: block everything except digits, one dot and control keys
    document.addEventListener('keydown', (e) => {
      if (!isNum(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length > 1) return;                       // Backspace, Tab, arrows, Enter ...
      if (/[0-9]/.test(e.key)) return;
      if (e.key === '.' && e.target.value.indexOf('.') < 0) return;
      e.preventDefault();
    }, true);
    // typed / dropped / IME / mobile keyboards
    document.addEventListener('beforeinput', (e) => {
      if (!isNum(e.target) || !e.data) return;
      if (/[^0-9.]/.test(e.data)) e.preventDefault();
    }, true);
    // paste: keep only the number part
    document.addEventListener('paste', (e) => {
      if (!isNum(e.target)) return;
      e.preventDefault();
      const el = e.target;
      const txt = (e.clipboardData || window.clipboardData).getData('text') || '';
      const cur = el.value;
      let s0 = cur.length, s1 = cur.length;
      try { if (el.selectionStart != null) { s0 = el.selectionStart; s1 = el.selectionEnd; } } catch (x) { /* number inputs may not expose selection */ }
      el.value = cleanNumberText(txt, cur, s0, s1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, true);
    document.addEventListener('drop', (e) => { if (isNum(e.target)) e.preventDefault(); }, true);
    // safety net: anything unreadable is cleared, and a 3rd decimal is cut off
    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!isNum(el)) return;
      if (el.validity && el.validity.badInput) { el.value = ''; return; }
      const m = /^(\d*)\.(\d{3,})$/.exec(el.value);
      if (m) el.value = m[1] + '.' + m[2].slice(0, 2);
    }, true);
    // scrolling over a focused number box must not change it
    document.addEventListener('wheel', (e) => { if (isNum(e.target) && document.activeElement === e.target) e.target.blur(); }, { passive: true, capture: true });
  }

  /* =====================================================
     SHOW THE SIGNED-IN USER (greeting, top bar chip, menu)
  ===================================================== */
  function applyUser() {
    const u = currentUser;
    if (!u || !u.name) return;
    const first = u.name.trim().split(/\s+/)[0];
    const initials = u.name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    const set = (sel, v) => document.querySelectorAll(sel).forEach((n) => { n.textContent = v; });
    set('#welcomeName', 'Welcome back, ' + first);
    set('.user-chip .uname', u.name);
    set('.user-chip .urole', u.roleLabel || '');
    set('.user-chip .avatar, .dropdown-avatar', initials);
    set('.dropdown-name', u.name);
    if (u.email) set('.dropdown-email', u.email);
    set('.brand-text .role', 'Product Co');
    const badge = document.querySelector('.topbar .badge');
    if (badge) badge.textContent = u.role === 'finance' ? 'Finance Admin' : (u.roleLabel || 'Staff');
    reapplyAvatar();
  }

  // shows the photo (or the initials when there is none) in the profile window, top bar chip and menu
  function reapplyAvatar() {
    const name = currentUser && currentUser.name ? currentUser.name : '';
    const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'A';
    document.querySelectorAll('#profileAvatar, .user-chip .avatar, .dropdown-avatar').forEach((n) => {
      if (avatarState.has) {
        n.style.backgroundImage = 'url("/api/auth/avatar?v=' + avatarState.v + '")';
        n.style.backgroundSize = 'cover';
        n.style.backgroundPosition = 'center';
        n.textContent = '';
      } else {
        n.style.backgroundImage = ''; n.style.backgroundSize = ''; n.style.backgroundPosition = '';
        n.textContent = initials;
      }
    });
    const rm = $('profileRemoveBtn');
    if (rm) rm.disabled = !avatarState.has;
  }

  /* =====================================================
     DARK / LIGHT THEME
  ===================================================== */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const light = t === 'light';
    if ($('themeIcon')) $('themeIcon').innerHTML = light ? '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>' : '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    if ($('themeLabel')) $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    const b = $('themeToggle');
    if (b) b.title = light ? 'Switch to dark mode' : 'Switch to light mode';
  }
  function setupTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    const b = $('themeToggle');
    if (!b) return;
    b.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('tripleE.theme', next); } catch (e) { /* storage blocked */ }
    });
  }

  /* =====================================================
     REPORTS  (period picker, stat cards, charts, tables, CSV export, print)
  ===================================================== */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const fromIso = (x) => { const p = x.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const addDays = (x, n) => { const d = fromIso(x); d.setDate(d.getDate() + n); return iso(d); };
  const addMonths = (x, n) => { const d = fromIso(x); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); };
  const niceDate = (x) => { const d = fromIso(x); return MON[d.getMonth()] + ' ' + pad(d.getDate()) + ', ' + d.getFullYear(); };
  const money = (n) => (typeof formatCurrency === 'function' ? formatCurrency(n) : '\u20B1' + Number(n).toFixed(2));
  const num = (n) => (typeof formatNumber === 'function' ? formatNumber(n) : String(n));
  const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };

  const rep = { type: 'daily', anchor: iso(new Date()), from: '', to: '' };
  // the chosen period (and custom dates) are kept in this browser so a reload does not jump back to Daily
  const REP_KEY = 'te_report_period', REP_TYPES = ['daily', 'weekly', 'monthly', 'yearly', 'custom'];
  const saveRepPrefs = () => { try { localStorage.setItem(REP_KEY, JSON.stringify({ type: rep.type, from: rep.from, to: rep.to })); } catch (e) { /* storage blocked: fine */ } };
  function loadRepPrefs() {
    try {
      const v = JSON.parse(localStorage.getItem(REP_KEY) || 'null');
      if (!v || REP_TYPES.indexOf(v.type) < 0) return;
      rep.type = v.type;
      const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
      if (ok(v.from) && ok(v.to)) { rep.from = v.from; rep.to = v.to; }
    } catch (e) { /* ignore a damaged value */ }
  }

  function repRange() {
    const a = fromIso(rep.anchor);
    if (rep.type === 'daily') return { from: rep.anchor, to: rep.anchor, label: niceDate(rep.anchor) };
    if (rep.type === 'weekly') {
      const mon = addDays(rep.anchor, -((a.getDay() + 6) % 7));
      const sun = addDays(mon, 6);
      return { from: mon, to: sun, label: niceDate(mon) + ' \u2013 ' + niceDate(sun) };
    }
    if (rep.type === 'monthly') {
      const first = iso(new Date(a.getFullYear(), a.getMonth(), 1));
      const last = iso(new Date(a.getFullYear(), a.getMonth() + 1, 0));
      return { from: first, to: last, label: MON[a.getMonth()] + ' ' + a.getFullYear() };
    }
    if (rep.type === 'yearly') return { from: a.getFullYear() + '-01-01', to: a.getFullYear() + '-12-31', label: String(a.getFullYear()) };
    const from = rep.from || rep.anchor, to = rep.to || rep.anchor;
    return { from, to, label: niceDate(from) + ' \u2013 ' + niceDate(to), invalid: from > to };
  }

  function repStep(dir) {
    if (rep.type === 'daily') rep.anchor = addDays(rep.anchor, dir);
    else if (rep.type === 'weekly') rep.anchor = addDays(rep.anchor, 7 * dir);
    else if (rep.type === 'monthly') rep.anchor = addMonths(rep.anchor, dir);
    else if (rep.type === 'yearly') rep.anchor = addMonths(rep.anchor, 12 * dir);
  }

  /* The Report Period panel is the ONE date range for the whole Reports page. Other report scripts read it from here
     and listen for 'tripleE:reportrange' (fired whenever the from / to dates change). */
  window.TripleEReportRange = { get: function () { const r = repRange(); return { from: r.from, to: r.to, label: r.label, invalid: !!r.invalid, type: rep.type }; } };
  let lastBroadcast = '';
  function broadcastRange(range) {
    const key = range.from + '|' + range.to + '|' + (range.invalid ? 1 : 0);
    if (key === lastBroadcast) return;
    lastBroadcast = key;
    try { window.dispatchEvent(new CustomEvent('tripleE:reportrange', { detail: window.TripleEReportRange.get() })); } catch (e) { /* old browser: sections keep their last range */ }
  }

  /* Sales that count as real revenue in a period: POS sales that are not voided, and online orders that were
     confirmed (not pending / cancelled) and not refunded. One row per product line. Dates use Manila time. */
  const SALE_TZ = 'Asia/Manila';
  const payLabel = (m) => (m === 'Xendit' ? 'Online payment' : m);   // Xendit is only the gateway behind it; the stored value stays 'Xendit'
  const saleDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: SALE_TZ });
  function repSales(range) {
    if (range.invalid) return [];
    const out = [];
    salesCache.forEach((t) => {
      const day = saleDay(t.createdAt);
      if (day < range.from || day > range.to) return;
      if (t.source === 'POS' ? t.status === 'Voided' : (t.status === 'Pending Confirmation' || t.status === 'Cancelled')) return;
      if (t.refund && t.refund.status === 'approved') return;
      const confirmedBy = (t.history || []).filter((h) => h.to === 'Paid').map((h) => h.by).pop();
      const handler = t.source === 'POS' ? (t.cashier || 'Cashier') : (confirmedBy || 'Online shop');
      (t.items || []).forEach((i) => out.push({
        ref: t.ref, source: t.source, date: day, product: i.name, qty: i.qty, unit: i.unit, price: i.price,
        revenue: i.qty * i.price, profit: i.qty * (i.price - i.cost), customer: t.customer || '', method: t.method || '', handledBy: handler
      }));
    });
    /* Custom work is quoted rather than sold off the shelf, so until it becomes an order the only thing the shop can
       point at is the money received against it — one line per payment, all of them under the same quote reference.
       Once that quotation has become an order and this report prints that order, the order line is the sale and the
       payments stop: printing both would sell the same job twice (§10). */
    const printed = new Set(out.map((r) => r.ref));
    quotesCache.forEach((q) => {
      if (q.convertedOrder && printed.has(q.convertedOrder)) return;
      (q.payments || []).forEach((p) => {
        const day = saleDay(p.at);
        if (day < range.from || day > range.to) return;
        out.push({
          ref: q.id, source: 'Quote', date: day, product: (q.product || 'Custom order') + ' \u2013 quote payment', qty: 1, unit: 'payment', price: +p.amount || 0,
          revenue: +p.amount || 0, profit: null, customer: q.customer || '', method: p.method || '', handledBy: q.receivedBy || q.handledBy || 'Finance'
        });
      });
    });
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.ref < b.ref ? 1 : -1));
  }
  const srcLabel = (src) => (src === 'POS' ? 'POS walk-in' : src === 'Quote' ? 'Custom quote' : 'Online shop');
  const sumProfit = (rows) => rows.reduce((t, r) => t + (r.profit || 0), 0);

  /* ---- cash shifts + collections (same period), from /api/finance/cash-shifts/report ---- */
  const cashRep = { key: '', at: 0, data: null, error: '', pending: null, pendingKey: '' };
  const rsum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
  const mergeRows = (map, rows, fields) => (rows || []).forEach((r) => {
    const m = map.get(r.method) || map.set(r.method, { method: r.method }).get(r.method);
    fields.forEach((f) => { m[f] = (m[f] || 0) + (Number(r[f]) || 0); });
  });
  async function fetchCash(from, to) {            // the server answers up to 92 days at a time, so a long period is asked in pieces
    const shifts = [], pos = new Map(), online = new Map();
    let start = from;
    while (start <= to) {
      let end = addDays(start, 91); if (end > to) end = to;
      const d = await api('/finance/cash-shifts/report?from=' + start + '&to=' + end);
      (d.shifts || []).forEach((x) => shifts.push(x));
      mergeRows(pos, d.payments && d.payments.pos, ['count', 'total', 'voided', 'voidedTotal', 'returned']);
      mergeRows(online, d.payments && d.payments.online, ['count', 'collected', 'awaitingCount', 'awaiting', 'cancelled', 'refunded']);
      start = addDays(end, 1);
    }
    shifts.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    const closed = shifts.filter((x) => x.closedAt);
    return {
      shifts, pos: [...pos.values()], online: [...online.values()],
      totals: {
        shifts: shifts.length, open: shifts.length - closed.length, expectedCash: rsum(shifts, (x) => x.expectedCash), countedCash: rsum(closed, (x) => x.closingCash),
        shortage: rsum(closed, (x) => Math.min(0, x.difference || 0)), overage: rsum(closed, (x) => Math.max(0, x.difference || 0)),
        needsReview: shifts.filter((x) => (x.flags || []).length).length
      }
    };
  }
  const cashKey = (range) => range.from + '|' + range.to;
  const cashFor = (range) => (cashRep.data && cashRep.key === cashKey(range) ? cashRep.data : null);
  const reportsOpen = () => { const r = $('reports'); return !!r && r.classList.contains('active-page'); };
  function ensureCash(range) {
    if (range.invalid) return Promise.resolve();
    const key = cashKey(range);
    if (cashRep.key === key && cashRep.data && Date.now() - cashRep.at < 30000) return Promise.resolve();
    if (cashRep.pending && cashRep.pendingKey === key) return cashRep.pending;
    cashRep.pendingKey = key; cashRep.error = '';
    cashRep.pending = fetchCash(range.from, range.to)
      .then((d) => { cashRep.key = key; cashRep.at = Date.now(); cashRep.data = d; })
      .catch((e) => { if (e.message === 'Not signed in') return; cashRep.key = key; cashRep.at = Date.now(); cashRep.data = null; cashRep.error = e.message || 'Could not load'; })
      .finally(() => { cashRep.pending = null; const cur = repRange(); if (cashKey(cur) === key) renderCashPanel(cur); });
    renderCashPanel(range);
    return cashRep.pending;
  }
  const cashWhen = (t) => (t ? new Date(t).toLocaleString('en-PH', { timeZone: SALE_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '\u2014');
  const varText = (x) => (x.difference == null ? '\u2014' : Math.abs(x.difference) < 0.005 ? 'Balanced' : (x.difference < 0 ? 'Short ' : 'Over ') + money(Math.abs(x.difference)));
  const collectedNet = (d) => rsum(d.pos, (x) => x.total - (x.returned || 0)) + rsum(d.online, (x) => x.collected - (x.refunded || 0));
  function ensureCashPanel() {
    if ($('reportCashPanel')) return true;
    const body = $('reportSalesBody'), host = body && body.closest('.panel');
    if (!host) return false;
    const div = document.createElement('div');
    div.className = 'panel report-detail-panel'; div.id = 'reportCashPanel';
    div.innerHTML = '<div class="panel-title">Cash Drawer Shifts Report</div><div class="panel-sub report-period-sub" id="reportCashSub">Loading\u2026</div><div id="reportCashBody"></div>';
    host.insertAdjacentElement('afterend', div);
    return true;
  }
  function renderCashPanel(range) {
    if (!ensureCashPanel()) return;
    const sub = $('reportCashSub'), box = $('reportCashBody');
    if (range.invalid) { sub.textContent = 'Start date must be on or before the end date'; box.innerHTML = ''; return; }
    const d = cashFor(range);
    if (!d) {
      sub.textContent = cashRep.error ? 'Could not load cash shifts: ' + cashRep.error : range.label + ' \u00B7 loading\u2026';
      box.innerHTML = ''; return;
    }
    const t = d.totals, net = t.shortage + t.overage;
    sub.textContent = range.label + ' \u00B7 ' + t.shifts + ' shift' + (t.shifts === 1 ? '' : 's') + (t.open ? ' (' + t.open + ' still open)' : '') +
      ' \u00B7 cash variance ' + (Math.abs(net) < 0.005 ? 'none' : (net < 0 ? '-' : '+') + money(Math.abs(net))) + ' \u00B7 money received by method is in Sales, Collections & Receivables below';
    const shiftRows = d.shifts.map((x) =>
      '<tr><td>' + esc(x.cashierName || '') + '</td><td class="dim">' + esc(cashWhen(x.openedAt)) + '</td><td class="dim">' + (x.closedAt ? esc(cashWhen(x.closedAt)) : 'Open') + '</td>' +
      '<td>' + esc(money(x.openingCash || 0)) + '</td><td>' + esc(money(x.cashSales || 0)) + '</td><td class="dim">+' + esc(money(x.cashIn || 0)) + ' / -' + esc(money(x.cashOut || 0)) + '</td>' +
      '<td class="dim">' + esc(money(x.cashReturns || 0)) + '</td><td>' + esc(money(x.expectedCash || 0)) + '</td><td>' + (x.closingCash == null ? '\u2014' : esc(money(x.closingCash))) + '</td>' +
      '<td class="' + (x.difference == null ? 'dim' : Math.abs(x.difference) < 0.005 ? 'qty-in' : 'qty-out') + '">' + esc(varText(x)) + '</td></tr>').join('');
    box.innerHTML =
      '<h4 style="margin:4px 0 6px;font-size:14px">Cash drawer shifts</h4><div class="table-wrapper"><table><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Opening cash</th><th>Cash sales</th><th>Added / removed</th><th>Cash refunds</th><th>Expected</th><th>Counted</th><th>Difference</th></tr></thead><tbody>' +
      (shiftRows || '<tr><td colspan="10" class="report-note">No cash shifts in this period.</td></tr>') + '</tbody><tfoot>' +
      (d.shifts.length ? '<tr class="report-foot-row"><td colspan="7">' + t.shifts + ' shift' + (t.shifts === 1 ? '' : 's') + ' \u00B7 ' + t.needsReview + ' need review \u00B7 short ' + esc(money(Math.abs(t.shortage))) + ' \u00B7 over ' + esc(money(t.overage)) + '</td><td>' + esc(money(t.expectedCash)) + '</td><td>' + esc(money(t.countedCash)) + '</td><td>' + (Math.abs(net) < 0.005 ? 'Balanced' : (net < 0 ? 'Short ' : 'Over ') + esc(money(Math.abs(net)))) + '</td></tr>' : '') + '</tfoot></table></div>';
  }

  /* ---- §10 what was sold, what arrived and what is still owed, from /api/finance/payment-report ----
     The three figures the payment spec keeps apart, and the server adds each one up: booked is what the orders raised
     in the period are worth (one line per order, however many payments settle it), collected is the money events the
     payment ledger confirmed, receivables is what is still owed right now. This panel prints them; it works out no
     percentage and sums no amount of its own. The route answers 92 days at a time, so a longer period is asked in
     pieces and the pieces are joined back — by day, which never overlaps.                                        */
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const PILL = { unpaid: ['unpaid', 'Not paid'], partially_paid: ['low', 'Partly paid'], paid: ['in', 'Paid'],
    refunded: ['out', 'Refunded'], partially_refunded: ['watch', 'Partly refunded'] };
  const blankLedger = () => ({ from: '', to: '', ledgerReady: true, truncated: false,
    booked: { count: 0, value: 0, collected: 0, inPeriod: 0, stillOwed: 0, rows: [] },
    collections: { arrived: 0, refunded: 0, net: 0, drawer: 0, outside: 0, byDay: [], byMethod: [], byPurpose: [], byKind: [] },
    receivables: { openOrders: 0, ordersOwed: 0, openQuotes: 0, quotesOwed: 0, allOwed: 0 } });
  function mergeByKey(list, rows, key, fields) {
    const map = new Map(list.map((x) => [x[key], x]));
    (rows || []).forEach((r) => {
      if (!map.has(r[key])) { list.push(r); map.set(r[key], r); return; }
      const m = map.get(r[key]);
      fields.forEach((f) => { m[f] = f === 'count' ? (m[f] || 0) + (r[f] || 0) : r2((m[f] || 0) + (r[f] || 0)); });
    });
    return list;
  }
  function joinLedger(into, d) {
    const b = into.booked, c = into.collections;
    // the route lists 500 orders at a time; a piece that came back full means the period is bigger than the report
    if (d.booked.count >= 500) into.truncated = true;
    b.count += d.booked.count;
    ['value', 'collected', 'inPeriod', 'stillOwed'].forEach((k) => { b[k] = r2(b[k] + d.booked[k]); });
    b.rows = b.rows.concat(d.booked.rows || []);
    ['arrived', 'refunded', 'net', 'drawer', 'outside'].forEach((k) => { c[k] = r2(c[k] + d.collections[k]); });
    c.byDay = c.byDay.concat(d.collections.byDay || []);
    mergeByKey(c.byMethod, d.collections.byMethod, 'method', ['count', 'arrived', 'refunded', 'drawer', 'forOrders', 'forQuotes']);
    mergeByKey(c.byPurpose, d.collections.byPurpose, 'purpose', ['count', 'amount']);
    mergeByKey(c.byKind, d.collections.byKind, 'kind', ['arrived', 'refunded']);
    // the open balances are a snapshot of right now, not a per-day figure, so the newest piece is the one to keep
    if (d.receivables) into.receivables = d.receivables;
    if (!into.from || d.from < into.from) into.from = d.from;
    if (!into.to || d.to > into.to) into.to = d.to;
  }
  const ledgerRep = { key: '', at: 0, data: null, error: '', pending: null, pendingKey: '' };
  async function fetchLedger(from, to) {
    const out = blankLedger();
    let start = from;
    while (start <= to) {
      let end = addDays(start, 89); if (end > to) end = to;
      const d = await api('/finance/payment-report?from=' + start + '&to=' + end);
      if (!d || !d.booked) { out.ledgerReady = false; break; }          // the ledger is not installed: never print zeros for it
      joinLedger(out, d);
      start = addDays(end, 1);
    }
    return out;
  }
  const ledgerKey = (range) => range.from + '|' + range.to;
  const ledgerFor = (range) => (ledgerRep.data && ledgerRep.key === ledgerKey(range) ? ledgerRep.data : null);
  function ensureLedger(range) {
    if (range.invalid) return Promise.resolve();
    const key = ledgerKey(range);
    if (ledgerRep.key === key && ledgerRep.data && Date.now() - ledgerRep.at < 30000) return Promise.resolve();
    if (ledgerRep.pending && ledgerRep.pendingKey === key) return ledgerRep.pending;
    ledgerRep.pendingKey = key; ledgerRep.error = '';
    ledgerRep.pending = fetchLedger(range.from, range.to)
      .then((d) => { ledgerRep.key = key; ledgerRep.at = Date.now(); ledgerRep.data = d; })
      .catch((e) => { if (e.message === 'Not signed in') return; ledgerRep.key = key; ledgerRep.at = Date.now(); ledgerRep.data = null; ledgerRep.error = e.message || 'Could not load'; })
      .finally(() => { ledgerRep.pending = null; const cur = repRange(); if (ledgerKey(cur) === key) renderLedgerPanel(cur); });
    renderLedgerPanel(range);
    return ledgerRep.pending;
  }
  function ensureLedgerPanel() {
    if ($('reportLedgerPanel')) return true;
    const sales = $('reportSalesBody'), anchor = $('reportCashPanel') || (sales && sales.closest('.panel'));
    if (!anchor) return false;
    const div = document.createElement('div');
    div.className = 'panel report-detail-panel'; div.id = 'reportLedgerPanel';
    div.innerHTML = '<div class="panel-title">Sales, Collections &amp; Receivables</div>' +
      '<div class="panel-sub report-period-sub" id="reportLedgerSub">Loading\u2026</div><div id="reportLedgerBody"></div>';
    anchor.insertAdjacentElement('afterend', div);
    return true;
  }
  const termsLabel = (x) => (x.termsKey === 'full' || x.termsKey == null ? 'Full payment'
    : x.termsKey + (x.termsPercent == null ? '' : ' \u00B7 ' + x.termsPercent + '%'));
  function renderLedgerPanel(range) {
    if (!ensureLedgerPanel()) return;
    const sub = $('reportLedgerSub'), box = $('reportLedgerBody');
    if (range.invalid) { sub.textContent = 'Start date must be on or before the end date'; box.innerHTML = ''; return; }
    const d = ledgerFor(range);
    if (!d) {
      sub.textContent = ledgerRep.error ? 'Could not load the payment ledger: ' + ledgerRep.error : range.label + ' \u00B7 loading\u2026';
      box.innerHTML = ''; return;
    }
    if (d.ledgerReady === false) {
      sub.textContent = 'The payment ledger is not in this database yet';
      box.innerHTML = '<div class="report-note">Run <span class="mono">backend/db/020_payment_terms.sql</span> once, then reload. ' +
        'Until it is there, money received against an order or a quotation is not recorded anywhere, so this report would be guessing.</div>';
      return;
    }
    const b = d.booked, c = d.collections, rv = d.receivables;
    const fig = (label, value, note) => '<tr><td>' + esc(label) + '</td><td class="mono">' + esc(money(value)) + '</td><td class="dim">' + esc(note) + '</td></tr>';
    const methods = c.byMethod.map((x) => '<tr><td>' + esc(payLabel(x.method)) + '</td><td>' + num(x.count) + '</td>' +
      '<td>' + esc(money(x.arrived)) + '</td><td class="dim">' + esc(money(x.drawer)) + '</td>' +
      '<td class="dim">' + (x.refunded ? esc(money(x.refunded)) : '\u2014') + '</td>' +
      '<td class="dim">' + esc(money(x.forOrders)) + '</td><td class="dim">' + esc(money(x.forQuotes)) + '</td></tr>').join('');
    const days = c.byDay.slice(-14).reverse().map((x) => '<tr><td class="dim">' + esc(niceDate(x.day)) + '</td>' +
      '<td>' + esc(money(x.arrived)) + '</td><td class="' + (x.refunded ? 'qty-out' : 'dim') + '">' + (x.refunded ? '\u2212' + esc(money(x.refunded)) : '\u2014') + '</td></tr>').join('');
    const open = b.rows.slice().sort((a, x) => x.outstanding - a.outstanding).slice(0, 12).map((x) => {
      const pill = PILL[x.paymentState] || ['unpaid', x.paymentState || 'Not paid'];
      return '<tr><td class="mono">' + esc(x.no) + '</td><td class="dim">' + esc(niceDate(x.day)) + '</td><td class="dim">' + esc(x.customer) + '</td>' +
        '<td class="dim">' + esc(termsLabel(x)) + '</td><td>' + esc(money(x.total)) + '</td><td class="dim">' + esc(money(x.paidAmount)) + '</td>' +
        '<td class="' + (x.outstanding > 0.005 ? 'qty-out' : 'qty-in') + '">' + esc(money(x.outstanding)) + '</td>' +
        '<td><span class="status-pill ' + pill[0] + '">' + esc(pill[1]) + '</span></td></tr>';
    }).join('');
    sub.textContent = range.label + ' \u00B7 booked ' + money(b.value) + ' on ' + b.count + ' order' + (b.count === 1 ? '' : 's') +
      ' \u00B7 received ' + money(c.arrived) + ' \u00B7 still owed on them ' + money(b.stillOwed) +
      ' \u00B7 owed across the shop ' + money(rv.allOwed);
    box.innerHTML =
      '<h4 style="margin:14px 0 6px;font-size:14px">What the period is worth</h4><div class="table-wrapper"><table><thead><tr><th>Figure</th><th>Amount</th><th>What it counts</th></tr></thead><tbody>' +
      fig('Booked \u2014 orders raised in the period', b.value, b.count + ' order line' + (b.count === 1 ? '' : 's') + ', each once at its own total; a payment never adds to this') +
      fig('Received on those orders during the period', b.inPeriod, 'the ledger rows dated in the period against them') +
      fig('Still owed on those orders', b.stillOwed, 'order value less everything the ledger has confirmed on them') +
      fig('Money received in the period, every channel', c.arrived, 'closes on other orders and on quotations that have not become an order yet') +
      fig('Refunded back in the period', c.refunded, 'a payment Finance reversed, taken off what was received') +
      fig('Net received in the period', c.net, 'received less refunded') +
      fig('\u2026of which cash that went into a drawer', c.drawer, 'the only part the till count may use; the rest came in online') +
      fig('Owed across the shop right now', rv.allOwed, rv.openOrders + ' order' + (rv.openOrders === 1 ? '' : 's') + ' and ' + rv.openQuotes +
        ' accepted quotation' + (rv.openQuotes === 1 ? '' : 's') + ' not yet turned into one') +
      '</tbody></table></div>' +
      '<h4 style="margin:18px 0 6px;font-size:14px">Money received, by method</h4><div class="table-wrapper"><table><thead><tr><th>Method</th><th>Payments</th><th>Received</th><th>Cash in a drawer</th><th>Refunded back</th><th>On orders</th><th>On quotations</th></tr></thead><tbody>' +
      (methods || '<tr><td colspan="7" class="report-note">No payment was confirmed on the ledger in this period.</td></tr>') +
      '</tbody><tfoot>' + (methods ? '<tr class="report-foot-row"><td colspan="2">Received ' + esc(money(c.arrived)) + ' \u00B7 refunded back ' + esc(money(c.refunded)) + '</td>' +
        '<td>' + esc(money(c.arrived)) + '</td><td>' + esc(money(c.drawer)) + '</td><td>' + esc(money(c.refunded)) + '</td>' +
        '<td colspan="2"></td></tr>' : '') + '</tfoot></table></div>' +
      '<h4 style="margin:18px 0 6px;font-size:14px">Money received, by day (latest 14)</h4><div class="table-wrapper"><table><thead><tr><th>Day</th><th>Received</th><th>Refunded back</th></tr></thead><tbody>' +
      (days || '<tr><td colspan="3" class="report-note">Nothing came in on the ledger in this period.</td></tr>') + '</tbody></table></div>' +
      '<h4 style="margin:18px 0 6px;font-size:14px">Balances still open on the orders booked here</h4><div class="table-wrapper"><table><thead><tr><th>Order</th><th>Raised</th><th>Customer</th><th>Terms</th><th>Order value</th><th>Received</th><th>Still owed</th><th>Payment</th></tr></thead><tbody>' +
      (open || '<tr><td colspan="8" class="report-note">No order was raised in this period.</td></tr>') + '</tbody><tfoot>' +
      (b.count ? '<tr class="report-foot-row"><td colspan="4">' + b.count + ' order' + (b.count === 1 ? '' : 's') + '</td><td>' + esc(money(b.value)) +
        '</td><td>' + esc(money(b.collected)) + '</td><td>' + esc(money(b.stillOwed)) + '</td><td colspan="2"></td></tr>' : '') +
      '</tfoot></table></div>' +
      (d.truncated ? '<div class="report-note">This period holds more orders than the report lists, so both the list and the amounts above cover the first 500 the server returned.</div>' : '');
  }

  function repMovements(range) {
    if (range.invalid) return [];
    return movementCache.filter((m) => m.date && m.date >= range.from && m.date <= range.to);
  }

  /* ---- charts ---- */
  function drawDonut(inv) {
    const box = $('donutChartContainer'), legend = $('donutLegend');
    if (!box || !legend) return;
    const colors = { 'Raw Materials': '#4a90d9', 'Finished Goods': '#43c47a', 'Finishing Supplies': '#e35b9e' };
    const byDept = {};
    inv.forEach((i) => { byDept[i.department] = (byDept[i.department] || 0) + i.onHand * i.unitCost; });
    const names = Object.keys(byDept).filter((k) => byDept[k] > 0);
    const total = names.reduce((t, k) => t + byDept[k], 0);
    if (!total) {
      box.innerHTML = '<div class="rep-chart-empty">No stock value yet.</div>'; legend.innerHTML = ''; return;
    }
    const R = 70, C = 2 * Math.PI * R;
    let off = 0;
    const segs = names.map((k) => {
      const len = byDept[k] / total * C;
      const seg = '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="' + (colors[k] || '#8fa1b0') + '" stroke-width="30" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 100 100)"/>';
      off += len; return seg;
    }).join('');
    const compact = total >= 1e6 ? '\u20B1' + (total / 1e6).toFixed(2) + 'M' : total >= 1e3 ? '\u20B1' + (total / 1e3).toFixed(1) + 'K' : '\u20B1' + total.toFixed(0);
    box.innerHTML = '<svg viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="Stock value by department">' + segs +
      '<text x="100" y="94" text-anchor="middle" class="donut-center-label">TOTAL</text>' +
      '<text x="100" y="116" text-anchor="middle" class="donut-center-value">' + esc(compact) + '</text></svg>';
    legend.innerHTML = names.map((k) =>
      '<div class="donut-legend-row"><div class="donut-legend-left"><span class="donut-legend-dot" style="background:' + (colors[k] || '#8fa1b0') + '"></span>' +
      '<span class="donut-legend-name">' + esc(k) + '</span><span class="donut-legend-pct">' + (byDept[k] / total * 100).toFixed(1) + '%</span></div>' +
      '<div class="donut-legend-value">' + esc(money(byDept[k])) + '</div></div>').join('');
  }

  function trendBuckets(range) {
    const out = [];
    const days = (a, b) => { const r = []; for (let d = a; d <= b; d = addDays(d, 1)) r.push(d); return r; };
    const monthsBetween = (a, b) => { const r = []; for (let d = a.slice(0, 7) + '-01'; d <= b; d = addMonths(d, 1)) r.push(d.slice(0, 7)); return r; };
    if (rep.type === 'yearly' || (rep.type === 'custom' && days(range.from, range.to).length > 45)) {
      monthsBetween(range.from, range.to).slice(0, 36).forEach((m) => out.push({ key: m, label: MON[Number(m.slice(5)) - 1] + (rep.type === 'custom' ? " '" + m.slice(2, 4) : ''), month: true }));
    } else {
      let list;
      if (rep.type === 'daily') list = days(addDays(range.to, -6), range.to);
      else list = days(range.from, range.to);
      list.forEach((d) => {
        const dt = fromIso(d);
        out.push({ key: d, label: rep.type === 'weekly' ? DOW[dt.getDay()] : (rep.type === 'monthly' ? String(dt.getDate()) : MON[dt.getMonth()] + ' ' + dt.getDate()) });
      });
    }
    return out;
  }

  function drawTrend(range, moves) {
    const box = $('scatterChartContainer');
    if (!box) return;
    if (range.invalid) { box.innerHTML = '<div class="rep-chart-empty">Fix the date range to see the chart.</div>'; return; }
    const buckets = trendBuckets(range);
    const all = rep.type === 'daily' ? movementCache.filter((m) => m.date && m.date >= buckets[0].key && m.date <= range.to) : moves;
    const data = buckets.map((b) => ({ b, in: 0, out: 0 }));
    const idx = {}; data.forEach((d, i) => { idx[d.b.key] = i; });
    all.forEach((m) => {
      const k = buckets[0].month ? m.date.slice(0, 7) : m.date;
      if (idx[k] !== undefined) data[idx[k]][m.type] += 1;   // count entries: quantities are in different units (sheets, kg, pcs) and cannot be added together
    });
    const max = Math.max.apply(null, data.map((d) => Math.max(d.in, d.out)).concat([0]));
    const totIn = data.reduce((t, d) => t + d.in, 0), totOut = data.reduce((t, d) => t + d.out, 0);
    setText('scatterChartSub', 'Stock in vs stock out \u00B7 In ' + num(totIn) + ' entries \u00B7 Out ' + num(totOut) + ' entries');
    if (!max) { box.innerHTML = '<div class="rep-chart-empty">No stock movement in this period.</div>'; return; }
    const W = 560, H = 230, L = 46, Rm = 8, T = 18, B = 28, iw = W - L - Rm, ih = H - T - B;
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / step) * step;
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Stock in versus stock out">';
    for (let g = 0; g <= 4; g++) {
      const y = T + ih - (ih * g / 4), v = top * g / 4;
      svg += '<line class="trend-grid-line" x1="' + L + '" y1="' + y + '" x2="' + (W - Rm) + '" y2="' + y + '"/>' +
        '<text class="trend-axis-label" x="' + (L - 6) + '" y="' + (y + 4) + '" text-anchor="end">' + esc(num(Math.round(v))) + '</text>';
    }
    const slot = iw / data.length, bw = Math.max(2, Math.min(22, slot / 2.6));
    const every = Math.ceil(data.length / 12);
    data.forEach((d, i) => {
      const cx = L + slot * i + slot / 2;
      // a small quantity next to a big one would be a hairline: keep every non-zero bar at least 4 px tall
      const hi = d.in > 0 ? Math.max(4, ih * d.in / top) : 0, ho = d.out > 0 ? Math.max(4, ih * d.out / top) : 0;
      const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n * 10) / 10));
      svg += '<rect class="trend-bar-in" x="' + (cx - bw - 1) + '" y="' + (T + ih - hi) + '" width="' + bw + '" height="' + hi + '" rx="2"><title>' + esc(d.b.label + ': ' + num(d.in) + ' stock in') + '</title></rect>' +
        '<rect class="trend-bar-out" x="' + (cx + 1) + '" y="' + (T + ih - ho) + '" width="' + bw + '" height="' + ho + '" rx="2"><title>' + esc(d.b.label + ': ' + num(d.out) + ' stock out') + '</title></rect>';
      if (data.length <= 10) {
        if (d.in > 0) svg += '<text class="trend-axis-label" x="' + (cx - bw / 2 - 1) + '" y="' + (T + ih - hi - 3) + '" text-anchor="middle" font-size="9">' + esc(short(d.in)) + '</text>';
        if (d.out > 0) svg += '<text class="trend-axis-label" x="' + (cx + bw / 2 + 1) + '" y="' + (T + ih - ho - 3) + '" text-anchor="middle" font-size="9">' + esc(short(d.out)) + '</text>';
      }
      if (i % every === 0) svg += '<text class="trend-axis-label" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.b.label) + '</text>';
    });
    box.innerHTML = svg + '</svg>';
  }

  /* ---- tables ---- */
  function renderReports() {
    if (!$('reports')) return;
    const range = repRange();
    broadcastRange(range);
    const moves = repMovements(range);
    const inv = inventoryCache;
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { catOf[p.sku] = p.category; });

    // period panel
    const pill = $('dateShowingPill');
    if (pill && rep.type !== 'custom') pill.textContent = 'Showing ' + range.label;
    document.querySelectorAll('#reportPeriodToggle .period-btn').forEach((b) => b.classList.toggle('active', b.dataset.period === rep.type));
    const nav = $('dateNavRow'), cust = $('customRangeRow');
    if (nav) nav.style.display = rep.type === 'custom' ? 'none' : 'flex';
    if (cust) cust.style.display = rep.type === 'custom' ? 'flex' : 'none';

    // stat cards
    const stockValue = inv.reduce((t, i) => t + i.onHand * i.unitCost, 0);
    const low = inv.filter((i) => typeof getStockStatus === 'function' && getStockStatus(i) === 'low').length;
    setText('repSkusInReport', num(inv.length));
    setText('repStockValue', money(stockValue));
    setText('repMovementsInPeriod', num(moves.length));
    const sales = repSales(range);
    const saleRevenue = sales.reduce((t, r) => t + r.revenue, 0), saleProfit = sumProfit(sales);
    const saleCount = new Set(sales.map((r) => r.ref)).size;
    setText('repSalesInPeriod', num(saleCount));
    setText('repSalesRevenue', money(saleRevenue));
    setText('repSalesProfit', money(saleProfit));
    { const pe = $('repSalesProfit'); if (pe) pe.classList.toggle('is-loss', saleProfit < 0); }   // loss = red
    setText('repLowStockAlerts', num(low));

    drawDonut(inv);
    drawTrend(range, moves);

    // stock value detail
    setText('stockDetailSub', inv.length + ' SKUs \u00B7 ' + money(stockValue) + ' total \u00B7 live snapshot');
    const sBody = $('stockValueDetailBody'), sFoot = $('stockValueDetailFoot');
    if (sBody) {
      const rows = inv.slice().sort((a, b) => b.onHand * b.unitCost - a.onHand * a.unitCost);
      sBody.innerHTML = rows.length ? rows.map((i) => {
        const isLow = typeof getStockStatus === 'function' && getStockStatus(i) === 'low';
        return '<tr><td class="mono">' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td class="dim">' + esc(catOf[i.sku] || i.department) + '</td>' +
          '<td class="dim' + (isLow ? ' low-cell' : '') + '">' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td>' +
          '<td class="dim">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td class="dim">' + esc(money(i.unitCost)) + '</td>' +
          '<td>' + esc(money(i.onHand * i.unitCost)) + '</td></tr>';
      }).join('') : '<tr><td colspan="7" class="report-note">No products yet.</td></tr>';
      if (sFoot) sFoot.innerHTML = rows.length ? '<tr class="report-foot-row"><td colspan="6">Total stock value</td><td>' + esc(money(stockValue)) + '</td></tr>' : '';
    }

    // movement report
    const inCount = moves.filter((m) => m.type === 'in').length, outCount = moves.length - inCount;
    setText('reportMovementSub', range.invalid ? 'Start date must be on or before the end date' : range.label + ' \u00B7 ' + moves.length + ' movement' + (moves.length === 1 ? '' : 's'));
    const mBody = $('reportMovementBody'), mFoot = $('reportMovementFoot');
    if (mBody) {
      mBody.innerHTML = moves.length ? moves.map((m) => {
        const isIn = m.type === 'in';
        return '<tr><td class="mono">' + esc(m.ref) + '</td><td class="dim">' + esc(niceDate(m.date)) + '</td><td>' + esc(m.product) + '</td>' +
          '<td><span class="status-pill ' + (isIn ? 'in' : 'out') + '">' + (isIn ? 'In' : 'Out') + '</span></td>' +
          '<td class="dim">' + esc(m.reason || '') + '</td>' +
          '<td class="' + (isIn ? 'qty-in' : 'qty-out') + '">' + (isIn ? '+' : '-') + esc(num(m.qty)) + ' ' + esc(m.unit) + '</td>' +
          '<td class="dim">' + esc(m.department) + '</td><td class="dim">' + esc(m.handledBy) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="report-note">' + (range.invalid ? 'Fix the date range above.' : 'No stock movements in this period. Try another date, or use \u201CJump to latest activity\u201D.') + '</td></tr>';
      if (mFoot) mFoot.innerHTML = moves.length ? '<tr class="report-foot-row"><td colspan="8">' + moves.length + ' movements \u00B7 ' + inCount + ' stock in \u00B7 ' + outCount + ' stock out</td></tr>' : '';
    }

    // sales transaction report (POS walk-in + online shop)
    setText('reportSalesSub', range.invalid ? 'Start date must be on or before the end date'
      : range.label + ' \u00B7 ' + saleCount + ' transaction' + (saleCount === 1 ? '' : 's') + ' \u00B7 revenue ' + money(saleRevenue) + ' \u00B7 profit ' + money(saleProfit));
    const slBody = $('reportSalesBody'), slFoot = $('reportSalesFoot');
    if (slBody) {
      slBody.innerHTML = sales.length ? sales.map((r) =>
        '<tr><td class="mono">' + esc(r.ref) + '<div class="dim" style="font-size:12px">' + srcLabel(r.source) + '</div></td>' +
        '<td class="dim">' + esc(niceDate(r.date)) + '</td><td>' + esc(r.product) + '</td>' +
        '<td>' + esc(num(r.qty)) + ' ' + esc(r.unit || '') + '</td><td class="dim">' + esc(money(r.price)) + '</td>' +
        '<td>' + esc(money(r.revenue)) + '</td><td class="' + (r.profit == null ? 'dim' : r.profit < 0 ? 'qty-out' : 'qty-in') + '">' + (r.profit == null ? '\u2014' : esc(money(r.profit))) + '</td>' +
        '<td class="dim">' + esc(r.customer) + '</td><td class="dim">' + esc(payLabel(r.method)) + '</td><td class="dim">' + esc(r.handledBy) + '</td></tr>').join('')
        : '<tr><td colspan="10" class="report-note">' + (range.invalid ? 'Fix the date range above.' : 'No sales in this period. Voided, cancelled, unconfirmed and refunded sales are not counted.') + '</td></tr>';
    }
    if (slFoot) slFoot.innerHTML = sales.length ? '<tr class="report-foot-row"><td colspan="5">' + saleCount + ' transaction' + (saleCount === 1 ? '' : 's') + ' \u00B7 ' + sales.length + ' line' + (sales.length === 1 ? '' : 's') +
      ' \u00B7 product sales and payments on work still only quoted (a quotation that became an order is counted on that order, not again as its payments; delivery fees and profit are not tracked on custom quotes)</td><td>' + esc(money(saleRevenue)) + '</td><td class="' + (saleProfit < 0 ? 'qty-out' : '') + '">' + esc(money(saleProfit)) + '</td><td colspan="3"></td></tr>' : '';

    // cash shifts + collections for the same period (loaded on demand while Reports is open)
    renderCashPanel(range);
    if (reportsOpen()) ensureCash(range);
    renderLedgerPanel(range);
    if (reportsOpen()) ensureLedger(range);
  }

  /* ---- CSV export ---- */
  function csvCell(v, isText) {
    let t = v == null ? '' : String(v);
    if (isText && /^[=+\-@\t\r]/.test(t)) t = "'" + t;        // stop spreadsheet formula injection
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  async function exportReportCsv() {
    const range = repRange();
    if (range.invalid) { toast('Fix the date range before exporting', 'error'); return; }
    await Promise.all([ensureCash(range), ensureLedger(range)]);
    const cash = cashFor(range);
    const ledger = ledgerFor(range);
    const moves = repMovements(range);
    const row = (arr) => arr.map((c) => (c && c.t !== undefined ? csvCell(c.t, true) : csvCell(c, false))).join(',');
    const T = (v) => ({ t: v });
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { catOf[p.sku] = p.category; });
    const lines = [
      row([T('Triple E Metal Products \u2013 Inventory report')]),
      row([T('Period'), T(range.label)]),
      row([T('Generated'), new Date().toLocaleString('en-PH')]),
      '',
      row([T('STOCK VALUE (live snapshot)')]),
      row(['SKU', 'Product', 'Category', 'On hand', 'Unit', 'Reorder level', 'Unit cost', 'Value'])
    ];
    let total = 0;
    inventoryCache.forEach((i) => {
      const v = i.onHand * i.unitCost; total += v;
      lines.push(row([T(i.sku), T(i.name), T(catOf[i.sku] || i.department), i.onHand, T(i.unit), i.reorderLevel, i.unitCost, v.toFixed(2)]));
    });
    lines.push(row(['', '', '', '', '', '', 'Total', total.toFixed(2)]), '', row([T('STOCK MOVEMENTS IN PERIOD')]),
      row(['Ref', 'Date', 'Product', 'Type', 'Reason', 'Quantity', 'Unit', 'Department', 'Handled by']));
    moves.forEach((m) => lines.push(row([T(m.ref), m.date, T(m.product), m.type === 'in' ? 'In' : 'Out', T(m.reason || ''),
      (m.type === 'in' ? '' : '-') + m.qty, T(m.unit), T(m.department), T(m.handledBy)])));
    lines.push('', row([T('SALES TRANSACTIONS IN PERIOD (POS + online + custom quote payments, excludes voided / cancelled / unconfirmed / refunded; a quotation that became an order shown above is counted on that order, not again as its payments)')]),
      row(['Sales ref', 'Source', 'Date', 'Product', 'Quantity', 'Unit', 'Unit price', 'Revenue', 'Profit', 'Customer', 'Payment', 'Handled by']));
    repSales(range).forEach((r) => lines.push(row([T(r.ref), T(srcLabel(r.source)), r.date, T(r.product), r.qty, T(r.unit || ''),
      r.price.toFixed(2), r.revenue.toFixed(2), r.profit == null ? '' : r.profit.toFixed(2), T(r.customer), T(payLabel(r.method)), T(r.handledBy)])));
    if (ledger && ledger.ledgerReady !== false) {
      const b = ledger.booked, c = ledger.collections, rv = ledger.receivables;
      lines.push('', row([T('SALES, COLLECTIONS AND RECEIVABLES (from the payment ledger; an order is counted once at its own value however many payments settle it)')]),
        row(['Figure', 'Amount', 'What it counts']),
        row([T('Booked \u2014 orders raised in the period'), b.value.toFixed(2), T(b.count + ' order lines, each at its own total')]),
        row([T('Received on those orders during the period'), b.inPeriod.toFixed(2), T('ledger payments dated in the period against them')]),
        row([T('Still owed on those orders'), b.stillOwed.toFixed(2), T('order value less everything the ledger confirmed')]),
        row([T('Money received in the period, every channel'), c.arrived.toFixed(2), T('including balances on quotations not yet turned into orders')]),
        row([T('Refunded back in the period'), c.refunded.toFixed(2), T('a payment Finance reversed')]),
        row([T('Net received in the period'), c.net.toFixed(2), T('received less refunded')]),
        row([T('\u2026of which cash that went into a drawer'), c.drawer.toFixed(2), T('the only part the till count may use')]),
        row([T('Owed across the shop right now'), rv.allOwed.toFixed(2), T(rv.openOrders + ' orders and ' + rv.openQuotes + ' accepted quotations not yet converted')]),
        '', row([T('MONEY RECEIVED, BY METHOD')]),
        row(['Method', 'Payments', 'Received', 'Cash in a drawer', 'Refunded back', 'On orders', 'On quotations']));
      c.byMethod.forEach((x) => lines.push(row([T(payLabel(x.method)), x.count, x.arrived.toFixed(2), x.drawer.toFixed(2), x.refunded.toFixed(2), x.forOrders.toFixed(2), x.forQuotes.toFixed(2)])));
      lines.push('', row([T('EVERY ORDER BOOKED IN THE PERIOD')]),
        row(['Order', 'Raised', 'Customer', 'Terms', 'Order value', 'Received so far', 'Still owed', 'Payment state']));
      b.rows.forEach((x) => lines.push(row([T(x.no), x.day, T(x.customer), T(termsLabel(x)), x.total.toFixed(2), x.paidAmount.toFixed(2), x.outstanding.toFixed(2), T(x.paymentState)])));
    } else if (ledger) {
      lines.push('', row([T('SALES, COLLECTIONS AND RECEIVABLES: not available \u2014 the payment ledger is not in this database (run backend/db/020_payment_terms.sql)')]));
    }
    if (cash) {
      lines.push('', row([T('COLLECTIONS BY PAYMENT METHOD')]), row(['Channel', 'Method', 'Paid transactions', 'Collected (net)', 'Returned / refunded', 'Voided or cancelled', 'Awaiting payment']));
      cash.pos.forEach((x) => lines.push(row([T('POS walk-in'), T(payLabel(x.method)), x.count, (x.total - (x.returned || 0)).toFixed(2), (x.returned || 0).toFixed(2), x.voided || 0, ''])));
      cash.online.forEach((x) => lines.push(row([T('Online shop'), T(payLabel(x.method)), x.count, (x.collected - (x.refunded || 0)).toFixed(2), (x.refunded || 0).toFixed(2), x.cancelled || 0, (x.awaiting || 0).toFixed(2)])));
      lines.push(row(['', '', '', collectedNet(cash).toFixed(2), '', '', '']), '', row([T('CASH SHIFTS IN PERIOD')]),
        row(['Shift', 'Cashier', 'Opened', 'Closed', 'Opening cash', 'Cash sales', 'Cash added', 'Cash removed', 'Cash refunds', 'Expected', 'Counted', 'Difference', 'Cashier note']));
      cash.shifts.forEach((x) => lines.push(row([T(x.id), T(x.cashierName || ''), T(cashWhen(x.openedAt)), T(x.closedAt ? cashWhen(x.closedAt) : 'Open'), x.openingCash || 0, x.cashSales || 0, x.cashIn || 0, x.cashOut || 0,
        x.cashReturns || 0, x.expectedCash || 0, x.closingCash == null ? '' : x.closingCash, x.difference == null ? '' : x.difference, T(x.closingNote || '')])));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'triple-e-report-' + range.from + (range.to !== range.from ? '_to_' + range.to : '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Report exported');
  }

  function setupReports() {
    if (!$('reports')) return;
    // re-read sales each time Reports is opened, so orders confirmed or sold a moment ago are included
    document.querySelectorAll('.nav-item[data-page="reports"]').forEach((n) => n.addEventListener('click', () => {
      Promise.all([api('/sales'), api('/finance/quotes').catch(() => null)]).then(([r, q]) => { salesCache = (r && r.sales) || []; if (Array.isArray(q)) quotesCache = q; updateOrderStats(); renderReports(); }).catch((e) => console.warn('[api-bridge] /sales failed: ' + e.message));
    }));
    // sensible defaults for the custom range: the last 7 days
    rep.to = iso(new Date()); rep.from = addDays(rep.to, -6);
    if ($('reportFromDate')) $('reportFromDate').value = rep.from;
    if ($('reportToDate')) $('reportToDate').value = rep.to;
    loadRepPrefs();
    try { reportPeriodType = rep.type; } catch (e) { /* keep script.js's own report panel on the same period */ }
    if ($('reportFromDate')) $('reportFromDate').value = rep.from;
    if ($('reportToDate')) $('reportToDate').value = rep.to;
    try { reportAnchorDate = rep.anchor; } catch (e) { /* ignore */ }

    document.querySelectorAll('#reportPeriodToggle .period-btn').forEach((b) =>
      b.addEventListener('click', () => { rep.type = b.dataset.period; saveRepPrefs(); renderReports(); }));

    const stop = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', (e) => { e.preventDefault(); e.stopImmediatePropagation(); fn(); }, true); };
    stop('datePrevBtn', () => { repStep(-1); renderReports(); });
    stop('dateNextBtn', () => { repStep(1); renderReports(); });
    stop('jumpLatestLink', () => {
      const latest = movementCache.length ? movementCache.map((m) => m.date).filter(Boolean).sort().pop() : null;
      rep.anchor = latest || iso(new Date()); renderReports();
    });
    stop('exportCsvBtn', exportReportCsv);
    stop('printReportBtn', () => {
      toast('Tip: in the print window, switch off \u201CHeaders and footers\u201D for a clean document. Choose \u201CSave as PDF\u201D to keep a copy.');
      ensureCash(repRange()).then(() => setTimeout(() => window.print(), 350));
    });

    const onRange = () => {
      rep.from = $('reportFromDate').value; rep.to = $('reportToDate').value;
      const bad = rep.from && rep.to && rep.from > rep.to;
      showLive('reportToDate', bad ? 'End date must be on or after the start date' : '');
      saveRepPrefs();
      renderReports();
    };
    ['reportFromDate', 'reportToDate'].forEach((id) => { const el = $(id); if (el) { el.addEventListener('change', onRange); el.addEventListener('input', onRange); } });
  }

  /* =====================================================
     BURGER MENU
     - phones / tablets (<= 1024px): opens a slide-in drawer with a dimmed backdrop
     - laptops / desktops: the sidebar is always visible, so the burger is hidden
  ===================================================== */
  const DRAWER_MQ = '(max-width: 1024px)';
  const isDrawer = () => window.matchMedia(DRAWER_MQ).matches;

  function setupBurger() {
    const burger = $('burgerBtn'), side = $('sidebar'), back = $('sidebarBackdrop'), close = $('sidebarClose');
    if (!burger || !side) return;

    const setOpen = (open) => {
      side.classList.toggle('open', open);
      document.body.classList.toggle('nav-open', open);
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (open) { const first = side.querySelector('.nav-item.active') || side.querySelector('.nav-item'); first && first.focus && first.focus({ preventScroll: true }); }
    };
    const sync = () => {                                  // phones / tablets: drawer. laptops / desktops: sidebar always visible, no burger
      document.body.classList.remove('sidebar-collapsed');
      try { localStorage.removeItem('tripleE.sidebarCollapsed'); } catch (e) { /* ignore */ }
      side.classList.remove('open'); document.body.classList.remove('nav-open');
      setOpen(false);
    };

    burger.addEventListener('click', () => {
      if (isDrawer()) setOpen(!side.classList.contains('open'));
    });
    if (back) back.addEventListener('click', () => setOpen(false));
    if (close) close.addEventListener('click', () => { setOpen(false); burger.focus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side.classList.contains('open')) { setOpen(false); burger.focus(); } });
    // choosing a page closes the drawer on phones / tablets
    side.addEventListener('click', (e) => { if (isDrawer() && e.target.closest('.nav-item')) setOpen(false); });
    const mq = window.matchMedia(DRAWER_MQ);
    (mq.addEventListener ? mq.addEventListener('change', sync) : mq.addListener(sync));
    sync();

    // show the current page name next to the burger
    const title = $('topbarTitle');
    const updateTitle = () => {
      const active = side.querySelector('.nav-item.active');
      if (title && active) title.textContent = (typeof window.sidebarLabelOf === 'function') ? window.sidebarLabelOf(active) : active.textContent.replace(/\s+/g, ' ').trim();
    };
    side.querySelectorAll('.nav-item').forEach((n) => new MutationObserver(updateTitle).observe(n, { attributes: true, attributeFilter: ['class'] }));
    updateTitle();
  }

  /* =====================================================
     STOP BROWSER AUTOFILL FROM FILLING SEARCH / FILTER BOXES (e.g. your email in the audit search)
  ===================================================== */
  function setupAutofillGuard() {
    const boxes = Array.from(document.querySelectorAll('input.inv-search, input[type="text"], input[type="email"], input[type="search"], textarea'))
      .filter((el) => !el.closest('.otp-row'));
    boxes.forEach((el) => {
      el.setAttribute('autocomplete', 'off');
      if (!el.name) el.name = 'f_' + (el.id || Math.random().toString(36).slice(2, 8));
      const typed = () => { el.dataset.userTyped = '1'; };
      el.addEventListener('keydown', typed); el.addEventListener('paste', typed); el.addEventListener('drop', typed);
    });
    const filters = Array.from(document.querySelectorAll('input.inv-search'));
    const purge = () => filters.forEach((el) => {
      if (el.value && !el.dataset.userTyped) {            // value the user never typed = autofill
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    [0, 150, 500, 1200, 2500].forEach((ms) => setTimeout(purge, ms));
  }

  /* =====================================================
     FORMAL PRINTED REPORT  (business document: letterhead, numbered sections, sign-off block)
  ===================================================== */
  const PERIOD_NAMES = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: 'Custom range' };

  function buildPrintReport() {
    const range = repRange();
    const moves = repMovements(range);
    const inv = inventoryCache.slice();
    const catOf = {};
    (typeof productCatalogData !== 'undefined' ? productCatalogData : []).forEach((p) => { if (p.category && p.category !== 'Uncategorized') catOf[p.sku] = p.category; });
    const now = new Date();
    const stamp = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) + ', ' +
      now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
    const refNo = 'IR-' + range.from.replace(/-/g, '') + (range.to !== range.from ? '-' + range.to.replace(/-/g, '') : '') + '-' + pad(now.getHours()) + pad(now.getMinutes());
    const who = currentUser && currentUser.name ? currentUser.name : '';
    const whoRole = currentUser && currentUser.roleLabel ? currentUser.roleLabel : '';
    const totalValue = inv.reduce((t, i) => t + i.onHand * i.unitCost, 0);
    const lowItems = inv.filter((i) => typeof getStockStatus === 'function' && getStockStatus(i) === 'low')
      .sort((a, b) => (a.onHand - a.reorderLevel) - (b.onHand - b.reorderLevel));
    const ins = moves.filter((m) => m.type === 'in'), outs = moves.filter((m) => m.type === 'out');
    const sumQty = (arr) => arr.reduce((t, m) => t + (Number(m.qty) || 0), 0);
    const cash = cashFor(range);
    const salesRows = repSales(range);
    const salesRev = salesRows.reduce((t, r) => t + r.revenue, 0), salesProf = sumProfit(salesRows);
    const salesTxn = new Set(salesRows.map((r) => r.ref)).size;
    const bySrc = {}; salesRows.forEach((r) => { const b = bySrc[r.source] || (bySrc[r.source] = { refs: new Set(), rev: 0 }); b.refs.add(r.ref); b.rev += r.revenue; });
    const salesBody = salesRows.map((r) =>
      '<tr><td class="nw">' + esc(r.ref) + '</td><td>' + esc(srcLabel(r.source)) + '</td><td class="nw">' + esc(niceDate(r.date)) + '</td><td>' + esc(r.product) +
      '</td><td class="r">' + esc(num(r.qty)) + (r.unit ? ' ' + esc(r.unit) : '') + '</td><td class="r">' + esc(money(r.revenue)) + '</td><td class="r">' +
      (r.profit == null ? '&mdash;' : esc(money(r.profit))) + '</td><td>' + esc(r.customer) + '</td><td>' + esc(payLabel(r.method)) + '</td></tr>').join('');

    const byDept = {};
    inv.forEach((i) => {
      const d = byDept[i.department] || (byDept[i.department] = { skus: 0, value: 0 });
      d.skus += 1; d.value += i.onHand * i.unitCost;
    });
    const deptRows = DEPARTMENTS.filter((d) => byDept[d]).map((d) =>
      '<tr><td>' + esc(d) + '</td><td class="r">' + byDept[d].skus + '</td><td class="r">' + esc(money(byDept[d].value)) +
      '</td><td class="r">' + (totalValue ? (byDept[d].value / totalValue * 100).toFixed(1) : '0.0') + '%</td></tr>').join('');

    const lowRows = lowItems.map((i) =>
      '<tr><td class="nw">' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td class="r">' + esc(num(i.onHand)) + ' ' + esc(i.unit) +
      '</td><td class="r">' + esc(num(i.reorderLevel)) + ' ' + esc(i.unit) + '</td><td class="r">' + esc(num(Math.max(0, i.reorderLevel - i.onHand))) + ' ' + esc(i.unit) + '</td></tr>').join('');

    const stockRows = inv.slice().sort((a, b) => (a.department + a.name).localeCompare(b.department + b.name)).map((i) =>
      '<tr><td class="nw">' + esc(i.sku) + '</td><td>' + esc(i.name) + '</td><td>' + (catOf[i.sku] ? esc(catOf[i.sku]) : '<span class="pd-dim">' + esc(i.department) + '</span>') +
      '</td><td class="r">' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td><td class="r">' + esc(num(i.reorderLevel)) +
      '</td><td class="r">' + esc(money(i.unitCost)) + '</td><td class="r">' + esc(money(i.onHand * i.unitCost)) + '</td></tr>').join('');

    const moveRows = moves.map((m) =>
      '<tr><td class="nw">' + esc(m.ref) + '</td><td class="nw">' + esc(niceDate(m.date)) + '</td><td>' + esc(m.product) + '</td><td>' + (m.type === 'in' ? 'In' : 'Out') +
      '</td><td>' + esc(m.reason || '') + '</td><td class="r">' + (m.type === 'in' ? '+' : '-') + esc(num(m.qty)) + ' ' + esc(m.unit) +
      '</td><td>' + esc(m.handledBy) + '</td></tr>').join('');

    const kv = (k, v) => '<tr><th scope="row">' + esc(k) + '</th><td class="r">' + v + '</td></tr>';
    const table = (cls, head, body, foot) =>
      '<table class="pd-table ' + cls + '"><thead><tr>' + head.map((h) => '<th' + (h[1] ? ' class="r"' : '') + '>' + esc(h[0]) + '</th>').join('') +
      '</tr></thead><tbody>' + body + '</tbody>' + (foot ? '<tfoot>' + foot + '</tfoot>' : '') + '</table>';
    const empty = (text) => '<p class="pd-empty">' + esc(text) + '</p>';

    return '' +
      '<div class="pd-letterhead"><div class="pd-brand"><div class="pd-mono">TE</div><div>' +
        '<div class="pd-company">TRIPLE E METAL PRODUCTS</div><div class="pd-dept">Finance &amp; Inventory Department</div></div></div>' +
        '<table class="pd-meta"><tr><th>Report No.</th><td>' + esc(refNo) + '</td></tr><tr><th>Date issued</th><td>' + esc(stamp) + '</td></tr>' +
        '<tr><th>Classification</th><td>Confidential</td></tr></table></div>' +
      '<div class="pd-title"><h1>Inventory &amp; Sales Report</h1>' +
        '<p>' + esc(PERIOD_NAMES[rep.type] || 'Report') + ' report &middot; Period covered: <strong>' + esc(range.label) + '</strong></p></div>' +

      '<h2><span>1.</span> Summary</h2>' +
      '<table class="pd-kv">' +
        kv('Active SKUs on record', esc(num(inv.length))) +
        kv('Total stock value (at cost, as of ' + esc(niceDate(iso(now))) + ')', esc(money(totalValue))) +
        kv('Stock movements in period', esc(num(moves.length)) + ' (' + ins.length + ' in / ' + outs.length + ' out)') +
        kv('Quantity received in period', esc(num(sumQty(ins)))) +
        kv('Quantity issued in period', esc(num(sumQty(outs)))) +
        kv('Items at or below reorder level', esc(num(lowItems.length))) +
        kv('Sales transactions in period', esc(num(salesTxn)) + (Object.keys(bySrc).length ? ' (' + Object.keys(bySrc).map((k) => bySrc[k].refs.size + ' ' + srcLabel(k).toLowerCase()).join(' / ') + ')' : '')) +
        kv('Sales revenue in period', esc(money(salesRev))) +
        kv('Sales profit in period', esc(money(salesProf))) +
        (cash ? kv('Net collected (POS + online, after returns and refunds)', esc(money(collectedNet(cash)))) +
          kv('Cash drawer shifts in period', esc(num(cash.totals.shifts)) + (cash.totals.open ? ' (' + cash.totals.open + ' still open)' : '')) +
          kv('Cash variance (counted vs expected)', Math.abs(cash.totals.shortage + cash.totals.overage) < 0.005 ? 'None' : esc(money(Math.abs(cash.totals.shortage + cash.totals.overage))) + (cash.totals.shortage + cash.totals.overage < 0 ? ' short' : ' over')) : '') +
      '</table>' +

      '<h2><span>2.</span> Stock Value by Department</h2>' +
      (deptRows ? table('pd-dept-t', [['Department'], ['SKUs', 1], ['Stock value', 1], ['Share', 1]], deptRows,
        '<tr><td>Total</td><td class="r">' + inv.length + '</td><td class="r">' + esc(money(totalValue)) + '</td><td class="r">100.0%</td></tr>') : empty('No stock on record.')) +

      '<h2><span>3.</span> Items Requiring Reorder</h2>' +
      (lowRows ? table('', [['SKU'], ['Product'], ['On hand', 1], ['Reorder level', 1], ['Shortfall', 1]], lowRows) : empty('No items are at or below their reorder level.')) +

      '<h2><span>4.</span> Stock Value Detail</h2>' +
      (stockRows ? table('pd-small', [['SKU'], ['Product'], ['Category'], ['On hand', 1], ['Reorder', 1], ['Unit cost', 1], ['Value', 1]], stockRows,
        '<tr><td colspan="6">Total stock value</td><td class="r">' + esc(money(totalValue)) + '</td></tr>') : empty('No products on record.')) +

      '<h2><span>5.</span> Stock Movements</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') :
        moveRows ? table('pd-small', [['Reference'], ['Date'], ['Product'], ['Type'], ['Reason'], ['Quantity', 1], ['Handled by']], moveRows,
          '<tr><td colspan="7">' + moves.length + ' movements &middot; ' + ins.length + ' stock in (' + esc(num(sumQty(ins))) + ' units) &middot; ' +
          outs.length + ' stock out (' + esc(num(sumQty(outs))) + ' units)</td></tr>') :
        empty('No stock movements were recorded during this period.')) +

      '<h2><span>6.</span> Sales Transactions</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') :
        salesBody ? table('pd-small', [['Reference'], ['Source'], ['Date'], ['Product'], ['Qty', 1], ['Revenue', 1], ['Profit', 1], ['Customer'], ['Payment']], salesBody,
          '<tr><td colspan="5">' + salesTxn + ' transaction' + (salesTxn === 1 ? '' : 's') + ' &middot; ' + salesRows.length + ' line' + (salesRows.length === 1 ? '' : 's') +
          '</td><td class="r">' + esc(money(salesRev)) + '</td><td class="r">' + esc(money(salesProf)) + '</td><td colspan="2"></td></tr>') +
          '<p class="pd-note">Includes POS, online shop and custom quote payments. Voided, cancelled, unconfirmed and refunded sales are excluded; delivery fees are not included.</p>' :
        empty('No sales transactions were recorded during this period.')) +

      '<h2><span>7.</span> Cash Shifts &amp; Collections</h2>' +
      (range.invalid ? empty('The selected date range is invalid (start date is after the end date).') : !cash ? empty('Cash shift data could not be loaded. Close this preview and print again.') : (
        '<div class="pd-keep"><p class="pd-sub">Collections by payment method</p>' +
        ((cash.pos.length || cash.online.length) ? table('pd-small', [['Channel'], ['Method'], ['Paid', 1], ['Collected (net)', 1], ['Returns / refunds', 1], ['Voided / awaiting / cancelled']],
          cash.pos.map((x) => '<tr><td>POS walk-in</td><td>' + esc(payLabel(x.method)) + '</td><td class="r">' + esc(num(x.count)) + '</td><td class="r">' + esc(money(x.total - (x.returned || 0))) + '</td><td class="r">' + (x.returned ? esc(money(x.returned)) : '&mdash;') + '</td><td>' + (x.voided ? esc(num(x.voided)) + ' voided' : '&mdash;') + '</td></tr>').join('') +
          cash.online.map((x) => '<tr><td>Online shop</td><td>' + esc(payLabel(x.method)) + '</td><td class="r">' + esc(num(x.count)) + '</td><td class="r">' + esc(money(x.collected - (x.refunded || 0))) + '</td><td class="r">' + (x.refunded ? esc(money(x.refunded)) : '&mdash;') + '</td><td>' + ([x.awaitingCount ? esc(num(x.awaitingCount)) + ' awaiting (' + esc(money(x.awaiting)) + ')' : '', x.cancelled ? esc(num(x.cancelled)) + ' cancelled' : ''].filter(Boolean).join(', ') || '&mdash;') + '</td></tr>').join(''),
          '<tr><td colspan="3">Net collected</td><td class="r">' + esc(money(collectedNet(cash))) + '</td><td colspan="2"></td></tr>') : empty('No POS or online payments in this period.')) +
        '</div><div class="pd-keep"><p class="pd-sub">Cash drawer shifts</p>' +
        (cash.shifts.length ? table('pd-small', [['Cashier'], ['Opened'], ['Closed'], ['Opening', 1], ['Cash sales', 1], ['Added / removed', 1], ['Refunds', 1], ['Expected', 1], ['Counted', 1], ['Difference', 1]],
          cash.shifts.map((x) => '<tr><td>' + esc(x.cashierName || '') + '</td><td class="nw">' + esc(cashWhen(x.openedAt)) + '</td><td class="nw">' + (x.closedAt ? esc(cashWhen(x.closedAt)) : 'Open') + '</td><td class="r">' + esc(money(x.openingCash || 0)) + '</td><td class="r">' + esc(money(x.cashSales || 0)) + '</td><td class="r">+' + esc(money(x.cashIn || 0)) + ' / -' + esc(money(x.cashOut || 0)) + '</td><td class="r">' + esc(money(x.cashReturns || 0)) + '</td><td class="r">' + esc(money(x.expectedCash || 0)) + '</td><td class="r">' + (x.closingCash == null ? '&mdash;' : esc(money(x.closingCash))) + '</td><td class="r">' + esc(varText(x)) + '</td></tr>').join(''),
          '<tr><td colspan="7">' + cash.totals.shifts + ' shift' + (cash.totals.shifts === 1 ? '' : 's') + ' &middot; ' + cash.totals.needsReview + ' need review</td><td class="r">' + esc(money(cash.totals.expectedCash)) + '</td><td class="r">' + esc(money(cash.totals.countedCash)) + '</td><td class="r">' + esc(money(Math.abs(cash.totals.shortage + cash.totals.overage))) + '</td></tr>') : empty('No cash shifts were opened during this period.')) + '</div>'
      )) +

      '<div class="pd-sign"><div class="pd-sign-title">Authorisation</div><div class="pd-sign-row">' +
        '<div><div class="pd-line"></div><strong>Prepared by</strong><br>' + esc(who) + (whoRole ? '<br><span>' + esc(whoRole) + '</span>' : '') + '<br><span>Date: ____________</span></div>' +
        '<div><div class="pd-line"></div><strong>Reviewed by</strong><br>&nbsp;<br><span>Date: ____________</span></div>' +
        '<div><div class="pd-line"></div><strong>Approved by</strong><br>&nbsp;<br><span>Date: ____________</span></div>' +
      '</div></div>' +
      '<p class="pd-end">&mdash; End of report &mdash;</p>';
  }

  function mountPrintReport() {
    unmountPrintReport();
    const doc = document.createElement('div');
    doc.id = 'printReport';
    doc.setAttribute('aria-hidden', 'true');
    doc.innerHTML = buildPrintReport();
    document.body.appendChild(doc);
    document.body.classList.add('printing-report');
  }
  function unmountPrintReport() {
    const old = $('printReport'); if (old) old.remove();
    document.body.classList.remove('printing-report');
  }
  const reportPageActive = () => { const r = $('reports'); return !!r && r.classList.contains('active-page'); };

  function setupFormalPrint() {
    window.addEventListener('beforeprint', () => { if (reportPageActive()) { try { mountPrintReport(); } catch (e) { console.warn('[api-bridge] print', e); } } });
    window.addEventListener('afterprint', unmountPrintReport);
  }

  /* =====================================================
     TABLE PAGING  (10 rows per page, with < > arrows)
     - works on every table in the app; tables with 10 rows or fewer show no pager
     - stays on the same page when the data refreshes by itself
     - goes back to page 1 when you search, filter, sort or change the period
  ===================================================== */
  const PAGE_SIZE = 10;
  const ICON_PREV = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const ICON_NEXT = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  function pageList(cur, total) {                          // 1 … 4 5 6 … 12
    const keep = new Set([1, total, cur - 1, cur, cur + 1]);
    if (cur <= 3) { keep.add(2); keep.add(3); keep.add(4); }
    if (cur >= total - 2) { keep.add(total - 1); keep.add(total - 2); keep.add(total - 3); }
    const nums = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const out = [];
    nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) out.push('gap'); out.push(n); });
    return out;
  }

  function setupPagers() {
    const pagers = [];

    document.querySelectorAll('.table-wrapper table').forEach((table) => {
      const body = table.tBodies[0];
      if (!body || table.closest('#printReport')) return;
      const wrap = table.closest('.table-wrapper');
      // this pager owns the table: table-pagination.js must not add a second bar (it skips tables with this mark)
      table.setAttribute('data-bridge-paged', '1');
      const dup = wrap.nextElementSibling;
      if (dup && dup.classList.contains('table-pagination')) {          // one was already added before this ran -> remove it
        dup.remove();
        table._pagerEl = null;
        Array.from(body.rows).forEach((r) => { if (r.style.display === 'none') r.style.display = ''; });
      }
      const bar = document.createElement('div');
      bar.className = 'pager';
      bar.setAttribute('role', 'navigation');
      bar.setAttribute('aria-label', 'Table pages');
      bar.hidden = true;
      wrap.insertAdjacentElement('afterend', bar);
      const st = { body, bar, wrap, page: 1, reset: false, scope: table.closest('.page, .modal-overlay') };
      pagers.push(st);

      const render = () => {
        const rows = Array.from(body.rows);
        const total = rows.length;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        if (st.reset) st.page = 1;
        st.page = Math.min(Math.max(st.page, 1), pages);
        const from = (st.page - 1) * PAGE_SIZE, to = from + PAGE_SIZE;
        rows.forEach((r, i) => r.classList.toggle('pg-hide', pages > 1 && (i < from || i >= to)));
        if (pages <= 1) { bar.hidden = true; bar.innerHTML = ''; return; }

        const nums = pageList(st.page, pages).map((n) => n === 'gap'
          ? '<span class="pager-gap" aria-hidden="true">&hellip;</span>'
          : '<button type="button" class="pager-btn pager-num' + (n === st.page ? ' active' : '') + '" data-page="' + n + '"' +
            (n === st.page ? ' aria-current="page"' : '') + ' aria-label="Page ' + n + '">' + n + '</button>').join('');
        bar.innerHTML =
          '<span class="pager-info">Showing <strong>' + (from + 1) + '&ndash;' + Math.min(to, total) + '</strong> of <strong>' + total + '</strong></span>' +
          '<div class="pager-ctrl">' +
            '<button type="button" class="pager-btn pager-arrow" data-dir="-1" aria-label="Previous page"' + (st.page === 1 ? ' disabled' : '') + '>' + ICON_PREV + '</button>' +
            '<span class="pager-nums">' + nums + '</span>' +
            '<span class="pager-count">Page ' + st.page + ' of ' + pages + '</span>' +
            '<button type="button" class="pager-btn pager-arrow" data-dir="1" aria-label="Next page"' + (st.page === pages ? ' disabled' : '') + '>' + ICON_NEXT + '</button>' +
          '</div>';
        bar.hidden = false;
      };
      st.render = render;

      bar.addEventListener('click', (e) => {
        const btn = e.target.closest('.pager-btn');
        if (!btn || btn.disabled) return;
        st.page = btn.dataset.page ? Number(btn.dataset.page) : st.page + Number(btn.dataset.dir);
        render();
        const keep = btn.dataset.page ? '.pager-num[data-page="' + st.page + '"]' : '.pager-arrow[data-dir="' + btn.dataset.dir + '"]';
        const again = bar.querySelector(keep) || bar.querySelector('.pager-num.active');
        if (again && !again.disabled) again.focus({ preventScroll: true });
      });

      new MutationObserver(render).observe(body, { childList: true });   // the page redraws the rows -> page them again
      render();
    });

    // searching / filtering / sorting inside a page sends its tables back to page 1
    const back = (e) => {
      if (e.target.closest && e.target.closest('.pager')) return;
      const scope = e.target.closest && e.target.closest('.page, .modal-overlay');
      if (!scope) return;
      pagers.forEach((st) => {
        if (st.scope !== scope) return;
        st.reset = true;
        setTimeout(() => { st.reset = false; }, 0);
      });
    };
    ['input', 'change', 'click'].forEach((ev) => document.addEventListener(ev, back, true));
  }

  /* =====================================================
     MY PROFILE  (loads from / saves to the users table)
     Required: Full name, Email, Phone.  Photo: JPG/PNG up to 2 MB.
  ===================================================== */
  function setupProfileForm() {
    const fFirst = $('profileFirst'), fMiddle = $('profileMiddle'), fLast = $('profileLast'), fSuffix = $('profileSuffix');
    const fBirth = $('profileBirth'), fGender = $('profileGender'), fEmail = $('profileEmail'), fPhone = $('profilePhone');
    const saveBtn = $('profileSaveBtn'), cancelBtn = $('profileCancelBtn'), banner = $('profileFormError');
    const overlay = $('accountModalOverlay');
    if (!fFirst || !fLast || !fEmail || !fPhone || !saveBtn) return;

    // same rules as sign-up and the server (PUT /api/auth/profile): names = letters and spaces, Philippine mobile number, 18+
    const NAME_RE = /^\p{L}[\p{L}\p{M} ]*$/u;
    const ids = ['profileFirst', 'profileMiddle', 'profileLast', 'profileBirth', 'profileEmail', 'profilePhone'];
    let saved = null;                 // what the database currently holds
    let loadError = '';               // set when the profile could not be loaded from the server
    let saving = false;
    let emailTaken = null;            // { email, taken, domainMsg, unverified } from the last live check
    let emailTimer = null;
    let savedVals = '';
    const touched = {};

    const values = () => ({
      firstName: clean(fFirst.value), middleName: clean(fMiddle.value), lastName: clean(fLast.value), suffix: fSuffix.value,
      birthdate: fBirth.value, gender: fGender.value,
      email: clean(fEmail.value).toLowerCase(), phone: clean(fPhone.value)
    });

    function mobileProblem(raw) {
      if (/[^\d+\s().-]/.test(raw)) return 'Mobile number can only have digits, +, spaces and dashes';
      let p = raw.replace(/[\s().-]/g, '');
      if (p.indexOf('+63') === 0) p = p.slice(3); else if (p.indexOf('63') === 0) p = p.slice(2); else if (p.indexOf('09') === 0) p = p.slice(1);
      else if (p[0] !== '9') return 'Enter a valid Philippine mobile number, e.g. 0917 123 4567';
      return /^9\d{9}$/.test(p) ? '' : 'Enter a valid Philippine mobile number, e.g. 0917 123 4567 or +63 917 123 4567';
    }
    function adultCutoff() {          // latest birthdate that is still 18 or older today
      const t = new Date(); const y = t.getFullYear() - 18, m = t.getMonth() + 1; let d = t.getDate();
      if (m === 2 && d === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) d = 28;
      return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
    function problems(v) {
      const e = {};
      const nm = (id, val, label, req) => {
        if (!val) { if (req) e[id] = label + ' is required'; return; }
        if (req && val.length < 2) e[id] = label + ' must be at least 2 characters';
        else if (!req && (val.match(/\p{L}/gu) || []).length < 2) e[id] = label + ' must have at least 2 letters (or leave it empty)';
        else if (val.length > 50) e[id] = label + ' must be at most 50 characters';
        else if (!NAME_RE.test(val)) e[id] = label + ' can only have letters and spaces';
      };
      nm('profileFirst', v.firstName, 'First name', true); nm('profileLast', v.lastName, 'Last name', true); nm('profileMiddle', v.middleName, 'Middle name', false);
      const had = saved && saved.birthdate ? saved.birthdate : '';
      if (!v.birthdate) { if (had) e.profileBirth = 'Birthdate is required'; }
      else {
        const t = new Date(), iso = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
        if (v.birthdate > iso) e.profileBirth = 'Birthdate cannot be in the future';
        else if (v.birthdate < '1900-01-01') e.profileBirth = 'Enter a valid birthdate';
        else if (v.birthdate !== had && v.birthdate > adultCutoff()) e.profileBirth = 'You must be at least 18 years old';   // an unchanged older value is never blocked
      }
      if (!v.email) e.profileEmail = 'Email is required';
      else if (v.email.length > 254 || !EMAIL_FORMAT.test(v.email)) e.profileEmail = 'Enter a valid email address';
      else if (emailTaken && emailTaken.email === v.email && emailTaken.taken) e.profileEmail = 'That email is already used by another account';
      else if (emailTaken && emailTaken.email === v.email && emailTaken.domainMsg) e.profileEmail = emailTaken.domainMsg;
      if (!v.phone) e.profilePhone = 'Mobile number is required';
      else { const m = mobileProblem(v.phone); if (m) e.profilePhone = m; }
      return e;
    }
    const changed = (v) => !!saved && JSON.stringify(v) !== savedVals;

    function paint(onlyTouched) {
      const v = values(), e = problems(v);
      ids.forEach((id) => {
        const el = $(id);
        el.classList.remove('field-invalid');
        const grp = el.closest('.form-group');
        grp.querySelectorAll('.field-msg[data-for="' + id + '"]').forEach((n) => n.remove());
        if (e[id] && (!onlyTouched || touched[id])) setError(id, e[id]);
      });
      // the button is never left dead: clicking it explains what is wrong (or retries the load)
      saveBtn.disabled = saving;
      if (!Object.keys(e).length && !loadError && banner) banner.classList.remove('show');
      return e;
    }

    // little grey / green line under a box ("Verified", "Not verified yet ...")
    function note(id, text, ok) {
      const n = $(id); if (!n) return;
      n.textContent = text || ''; n.style.color = ok ? '#5fbf8a' : '';
    }

    function fill(p) {
      saved = p;
      fFirst.value = p.firstName || ''; fMiddle.value = p.middleName || ''; fLast.value = p.lastName || '';
      fSuffix.value = p.suffix || ''; fBirth.value = p.birthdate || ''; fGender.value = p.gender || '';
      fBirth.max = new Date().toISOString().slice(0, 10);
      fEmail.value = p.email || '';
      fPhone.value = p.phone || '';
      note('profileEmailNote', p.pendingEmail ? 'Waiting for you to confirm ' + p.pendingEmail + ' — check that inbox. Your current email still works.'
        : (p.emailVerified ? 'Verified' : 'Not verified yet'), !p.pendingEmail && !!p.emailVerified);
      note('profilePhoneNote', p.phoneVerified ? 'Verified' : 'Not verified yet — we will text you a code the next time you sign in.', !!p.phoneVerified);
      const set = (id, val) => { const el = $(id); if (el) el.value = val || ''; };
      set('profileEmployeeId', p.employeeId); set('profileDepartment', p.department); set('profileJoined', p.joined);
      const badge = $('profileRoleBadge'); if (badge) badge.textContent = p.roleLabel || '';
      avatarState = { has: !!p.hasAvatar, v: avatarState.v || Date.now() };
      reapplyAvatar();
      ids.forEach((id) => { touched[id] = false; });
      emailTaken = null; showEmailStatus('');
      savedVals = JSON.stringify(values());
      paint(true);
    }

    async function loadProfile() {
      try {
        fill(await api('/auth/profile'));
        loadError = '';
        if (banner) banner.classList.remove('show');
      } catch (err) {
        if (err.message === 'Not signed in') return;
        loadError = 'Could not load your profile from the database (' + err.message + '). ' +
          (err.status === 404 ? 'The backend is running an old server.js: replace it and restart with npm start. ' : 'Check the backend window for the error. ') +
          'Click Save Changes to try again.';
        if (banner) { banner.textContent = loadError; banner.classList.add('show'); }
      }
      paint(true);
    }

    // small status line under the email box: "Checking…" / "domain is valid"
    function showEmailStatus(text, color) {
      const grp = fEmail.closest('.form-group');
      let n = grp.querySelector('.profile-email-status');
      if (text == null) {
        const c = emailTaken && emailTaken.email === values().email ? emailTaken : null;
        if (!c || c.taken || c.domainMsg) text = '';
        else if (c.unverified) text = 'Email format is OK (domain could not be checked right now)';
        else text = 'Email domain is valid';
        color = c && !c.unverified ? '#5fbf8a' : '';
      }
      if (!text) { if (n) n.remove(); return; }
      if (!n) { n = document.createElement('div'); n.className = 'field-hint profile-email-status'; grp.appendChild(n); }
      n.textContent = text; n.style.color = color || '';
    }

    // Is this email already used, and does its domain really exist? (checked while typing, after a short pause)
    function checkEmailSoon() {
      clearTimeout(emailTimer);
      const v = values();
      if (!v.email || !EMAIL_FORMAT.test(v.email) || (saved && v.email === saved.email.toLowerCase())) { emailTaken = null; showEmailStatus(''); return; }
      showEmailStatus('Checking email domain…');
      emailTimer = setTimeout(async () => {
        try {
          const r = await api('/auth/check-email?email=' + encodeURIComponent(v.email));
          if (values().email === v.email) {
            emailTaken = { email: v.email, taken: !!r.taken, domainMsg: r.domainOk === false ? (r.message || 'That email domain cannot receive email') : '', unverified: !!r.unverified };
            paint(true);
            showEmailStatus();
          }
        } catch (e) { /* the server re-checks on save */ }
      }, 600);
    }

    // phone box only accepts phone characters
    fPhone.addEventListener('input', () => {
      const next = fPhone.value.replace(/[^\d+\s().-]/g, '');
      if (next !== fPhone.value) fPhone.value = next;
    });
    ids.forEach((id) => {
      const el = $(id);
      el.addEventListener('input', () => { touched[id] = true; if (id === 'profileEmail') checkEmailSoon(); paint(true); });
      el.addEventListener('blur', () => { touched[id] = true; paint(true); });
    });
    [fSuffix, fGender].forEach((el) => el.addEventListener('change', () => paint(true)));
    fEmail.addEventListener('blur', () => { fEmail.value = clean(fEmail.value).toLowerCase(); });

    saveBtn.addEventListener('click', async () => {
      if (saving) return;
      if (!saved) { await loadProfile(); return; }          // never loaded: try again instead of doing nothing
      ids.forEach((id) => { touched[id] = true; });
      const e = paint(false);
      if (Object.keys(e).length) {
        if (banner) { banner.textContent = 'Please fix the highlighted fields.'; banner.classList.add('show'); }
        const first = ids.find((id) => e[id]); if (first) $(first).focus();
        return;
      }
      const v = values();
      if (!changed(v)) { toast('No changes to save'); return; }
      saving = true; saveBtn.disabled = true;
      const label = saveBtn.textContent; saveBtn.textContent = 'Saving…';
      try {
        const p = await api('/auth/profile', { method: 'PUT', body: JSON.stringify(v) });
        fill(p);
        currentUser = Object.assign({}, currentUser, { name: p.name, email: p.email });
        safe(applyUser);
        toast(p.message || 'Profile saved', !!p.message && /could not/i.test(p.message) ? 'error' : undefined);
        if (typeof closeAccountModal === 'function') closeAccountModal();
      } catch (err) {
        if (err.message === 'Not signed in') return;
        const map = { name: 'profileFirst', firstName: 'profileFirst', middleName: 'profileMiddle', lastName: 'profileLast',
          birthdate: 'profileBirth', email: 'profileEmail', phone: 'profilePhone' };
        const fe = mapFields(err.fields, map);
        if (Object.keys(fe).length) showErrors($('profileTabPanel'), banner, fe);
        else { if (banner) { banner.textContent = err.message; banner.classList.add('show'); } }
      } finally {
        saving = false;
        saveBtn.textContent = label;
        paint(true);
      }
    });

    /* ---- profile photo: Upload photo / Remove (saved to the database straight away) ---- */
    const upBtn = $('profileUploadBtn'), rmBtn = $('profileRemoveBtn');
    const MAX_PHOTO = 2 * 1024 * 1024;
    function photoMsg(text) {
      const row = upBtn && upBtn.closest('.profile-photo-row');
      if (!row) return;
      row.querySelectorAll('.profile-photo-msg').forEach((n) => n.remove());
      if (!text) return;
      const m = document.createElement('div');
      m.className = 'field-msg profile-photo-msg';
      m.textContent = text;
      row.appendChild(m);
    }
    if (upBtn) {
      const picker = document.createElement('input');
      picker.type = 'file'; picker.accept = 'image/jpeg,image/png'; picker.hidden = true;
      document.body.appendChild(picker);
      upBtn.addEventListener('click', () => { photoMsg(''); picker.value = ''; picker.click(); });
      picker.addEventListener('change', async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (!/^image\/(jpeg|png)$/.test(f.type)) return photoMsg('Choose a JPG or PNG image');
        if (!f.size) return photoMsg('That file is empty');
        if (f.size > MAX_PHOTO) return photoMsg('Photo must be 2 MB or smaller (yours is ' + (f.size / 1048576).toFixed(1) + ' MB)');
        upBtn.disabled = true; const label = upBtn.textContent; upBtn.textContent = 'Uploading…';
        try {
          const res = await fetch('/api/auth/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': f.type }, body: f });
          if (res.status === 401) { window.location.href = 'Login_Inventory.html'; return; }
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error((j.fields && j.fields.photo) || j.error || (res.status === 404 ? 'The backend is running an old server.js: replace it and restart' : 'Upload failed'));
          avatarState = { has: true, v: Date.now() };
          reapplyAvatar();
          toast('Photo updated');
        } catch (err) { photoMsg(err.message); }
        finally { upBtn.disabled = false; upBtn.textContent = label; }
      });
    }
    if (rmBtn) rmBtn.addEventListener('click', async () => {
      photoMsg('');
      if (!avatarState.has) return photoMsg('You have no photo to remove');
      rmBtn.disabled = true;
      try { await api('/auth/avatar', { method: 'DELETE' }); avatarState = { has: false, v: 0 }; toast('Photo removed'); }
      catch (err) { if (err.message !== 'Not signed in') photoMsg(err.message); }
      reapplyAvatar();
    });

    // Cancel throws away unsaved edits
    if (cancelBtn) cancelBtn.addEventListener('click', () => { if (saved) fill(saved); if (banner) banner.classList.remove('show'); });

    // reload from the database every time the account window opens
    if (overlay) {
      let wasOpen = false;
      new MutationObserver(() => {
        const open = overlay.classList.contains('open');
        if (open && !wasOpen) loadProfile();
        wasOpen = open;
      }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
    loadProfile();
  }

  /* ---------------- start ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    setupAutofillGuard();
    setupPagePersistence();
    setupTheme();
    setupBurger();
    setupReports();
    setupFormalPrint();
    setupNumberGuard();
    setupPagers();
    setupUnitSelect();
    setupLiveValidation();          // must be first so its submit check runs before the others
    setupMovementLog();
    setupMovementForm();
    setupProductModal();
    setupSupplierModal();
    setupStockAlerts();
    setupProfileForm();
    load().catch((err) => console.warn('[api-bridge]', err.message));
    setupLiveRefresh();
    const logout = $('logoutBtn');
    if (logout) logout.addEventListener('click', () => {
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    }, true);
  });
})();
