/* product-materials.js — "Materials needed" inside the New / Edit product form (Finished Goods only).
   Finance lists the Raw Materials and Finishing Supplies needed to make ONE unit of the finished good, right where the
   product is created. They are saved together with the product (PUT /api/production/requirements/:sku) and are what
   "Produced Internally" uses to deduct materials. The product details window also shows them, and for a raw material /
   finishing supply it shows which finished goods use it.
   Loaded after api-bridge.js (window.TripleEBridge) and script.js (openNewProductModal). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const B = () => window.TripleEBridge;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const fmt = (n) => String(+Number(n).toFixed(4));
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MATERIAL_DEPTS = ['Raw Materials', 'Finishing Supplies'];
  const MAX = 30;
  // units of the same kind convert into each other (same table as backend/recipe-costing.js); anything else is blocked with a message
  const GROUPS = { mass: { mg: 1e-6, g: 1e-3, kg: 1, lb: 0.45359237, tonne: 1000 }, volume: { ml: 1e-3, liter: 1 }, length: { mm: 1e-3, cm: 1e-2, m: 1, ft: 0.3048 } };
  const ALIAS = { l: 'liter', t: 'tonne' };
  const nu = (u) => { const k = String(u == null ? '' : u).trim().toLowerCase(); return ALIAS[k] || k; };
  const groupOf = (u) => Object.keys(GROUPS).find((g) => GROUPS[g][nu(u)] != null) || null;
  const unitsLike = (u) => { const g = groupOf(u); return g ? Object.keys(GROUPS[g]) : [nu(u)]; };
  const conv = (q, from, to) => { const f = nu(from), t = nu(to); if (f === t) return q; const g = groupOf(f); return g && g === groupOf(t) ? q * GROUPS[g][f] / GROUPS[g][t] : null; };
  const q4 = (n) => Math.round(n * 1e4) / 1e4;
  const changed = () => document.dispatchEvent(new CustomEvent('triplee:recipe-changed'));

  // rows: { sku, qty (text as typed), name, department, unit, archived, unitChanged }
  const st = { rows: [], loadedFor: null, loading: false, seq: 0, dirty: false, failed: '' };

  const editingSku = () => (typeof editingProductSku !== 'undefined' && editingProductSku) ? editingProductSku : null;
  const isFG = () => ($('npDept') || {}).value === 'Finished Goods';
  const inv = () => (B() ? B().inventory() : []);
  const material = (sku) => inv().find((i) => i.sku === sku);
  const unitOfFg = () => (($('npUnit') || {}).value || 'pcs');

  /* ---------- show / hide with the department ---------- */
  function sync() {
    const sec = $('npBomSection'); if (!sec) return;
    const on = isFG();
    sec.hidden = !on;
    if (on && !st.rows.length && !st.loading && !editingSku()) { st.rows.push({ sku: '', qty: '' }); }
    if (on) render();
    syncWeight();
  }

  /* ---------- weight per piece: the mass of the materials one piece needs (mass units only), unless set manually ---------- */
  function syncWeight() {
    const w = $('npWeight'), man = $('npWeightManual');
    if (!w || !man || !isFG() || st.loading || st.failed) return;
    let kg = 0, ignored = false;
    st.rows.forEach((r) => {
      const m = material(r.sku), n = Number(r.qty);
      if (!m || !(n > 0)) return;
      const c = conv(n, r.entryUnit || m.unit, 'kg');
      if (c == null) ignored = true; else kg += c;
    });
    kg = Math.round(kg * 1000) / 1000;
    const auto = kg > 0 ? String(kg) : '';
    if (!st.weightInit) {        // first look at this product: an existing weight that differs from the recipe stays as a manual entry
      st.weightInit = true;
      const cur = w.value.trim();
      man.checked = cur !== '' && Math.abs(Number(cur) - kg) > 0.0005;
    }
    w.readOnly = !man.checked;
    if (!man.checked) w.value = auto;
    const hint = $('npWeightHint');
    if (hint) hint.textContent = man.checked
      ? 'Used to work out the delivery fee for heavy orders. Leave blank if not known: the delivery fee is then just the area rate.'
      : 'Automatic: the total weight of the materials needed for 1 piece' + (ignored ? ' (materials not measured by weight are left out)' : '') + '. Used to work out the delivery fee for heavy orders. Tick “Set manually” to enter a different weight.';
  }

  /* ---------- the form was opened (new or edit) ---------- */
  async function onOpen() {
    st.rows = []; st.dirty = false; st.failed = ''; st.loadedFor = null; st.weightInit = false;
    const sku = editingSku(), my = ++st.seq;
    const catalog = typeof productCatalogData !== 'undefined' ? productCatalogData : [];   // script.js global
    const item = sku ? catalog.find((p) => p.sku === sku) : null;
    if (!sku || !item || item.department !== 'Finished Goods') { st.loading = false; sync(); return; }
    st.loading = true; sync(); changed();
    try {
      const r = await B().api('/production/requirements/' + encodeURIComponent(sku));
      if (my !== st.seq) return;
      st.rows = r.materials.map((m) => {
        const row = { sku: m.sku, qty: String(m.qtyPerUnit), name: m.name, department: m.department, unit: m.unit, entryUnit: m.unit, archived: m.archived, unitChanged: m.unitChanged };
        if (m.unitChanged) {      // the item's stock unit changed after the recipe was saved: show the quantity converted, or say it cannot be
          const c = conv(Number(m.qtyPerUnit), m.recipeUnit, m.unit);
          if (c == null || !(q4(c) > 0)) row.unitProblem = 'Unit mismatch: the recipe is in ' + m.recipeUnit + ' but the item is stocked in ' + m.unit + ' and they cannot be converted. Enter the quantity in ' + m.unit + '.';
          else { row.qty = String(q4(c)); row.unitNote = 'Recipe was in ' + fmt(m.qtyPerUnit) + ' ' + m.recipeUnit + ', converted to ' + m.unit + '.'; }
        }
        return row;
      });
      st.loadedFor = sku;
    } catch (err) {
      if (my !== st.seq) return;
      st.failed = err.message;
    } finally {
      if (my === st.seq) { st.loading = false; sync(); changed(); }
    }
  }

  /* ---------- table ---------- */
  function options(row) {
    const list = inv().filter((i) => MATERIAL_DEPTS.indexOf(i.department) >= 0);
    const taken = new Set(st.rows.filter((r) => r !== row).map((r) => r.sku));
    if (row.sku && !list.some((i) => i.sku === row.sku)) list.push({ sku: row.sku, name: row.name || row.sku, department: row.department, unit: row.unit });
    const opt = (i) => '<option value="' + esc(i.sku) + '"' + (i.sku === row.sku ? ' selected' : '') + '>' + esc(i.name) + ' (' + esc(i.sku) + ')</option>';
    return '<option value="">Select a material…</option>' + MATERIAL_DEPTS.map((d) => {
      const g = list.filter((i) => i.department === d && !taken.has(i.sku)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return g.length ? '<optgroup label="' + d + '">' + g.map(opt).join('') + '</optgroup>' : '';
    }).join('');
  }

  // the quantity of a row in the material's own stock unit (what the server stores and costs)
  const stockQty = (r, m) => { const q = Number(r.qty); if (!m || !(q > 0)) return null; const c = conv(q, r.entryUnit || m.unit, m.unit); return c == null ? null : q4(c); };
  function costs() {
    let raw = 0, fin = 0, complete = true;
    const problems = [];
    st.rows.forEach((r) => {
      const m = material(r.sku), q = stockQty(r, m);
      if (!m || !(q > 0)) { if (r.sku || r.qty) complete = false; return; }
      if (r.unitProblem) { complete = false; problems.push(r.unitProblem); return; }
      if (!(Number(m.unitCost) > 0)) { complete = false; problems.push(m.name + ' has no cost yet. Record a delivery with its price first.'); return; }
      const c = Math.round(q * 1e4) * Math.round(Number(m.unitCost) * 100) / 1e6;       // exact, like the server
      if (m.department === 'Raw Materials') raw += c; else fin += c;
    });
    return { raw, fin, total: Math.round((raw + fin) * 100) / 100, complete: complete && st.rows.some((r) => r.sku), problems };
  }

  function autoSuggestBOM(name) {
    if (!name || editingSku()) return;
    const n = name.trim().toLowerCase();
    const inventory = inv();
    const rawMaterials = inventory.filter((i) => i.department === 'Raw Materials');
    const finishing = inventory.filter((i) => i.department === 'Finishing Supplies');
    let suggested = [];

    // Brass detection
    if (/brass|bronze|valve|nipple|fitting/.test(n)) {
      const rm = rawMaterials.find((i) => /brass/i.test(i.name)) || rawMaterials[0];
      const fs1 = finishing.find((i) => /buffing|wheel/i.test(i.name));
      const fs2 = finishing.find((i) => /chromic|acid|plating/i.test(i.name));
      if (rm) suggested.push({ sku: rm.sku, qty: '0.42', name: rm.name, department: rm.department, unit: rm.unit, entryUnit: rm.unit });
      if (fs1) suggested.push({ sku: fs1.sku, qty: '0.008', name: fs1.name, department: fs1.department, unit: fs1.unit, entryUnit: fs1.unit });
      if (fs2) suggested.push({ sku: fs2.sku, qty: '0.001', name: fs2.name, department: fs2.department, unit: fs2.unit, entryUnit: fs2.unit });
    }
    // Aluminum / Ingot detection
    else if (/aluminum|aluminium|housing|casing|motor|die-cast|diecast/.test(n)) {
      const rm = rawMaterials.find((i) => /aluminum|adc12|a380/i.test(i.name)) || rawMaterials[0];
      const fs1 = finishing.find((i) => /release|die/i.test(i.name));
      const fs2 = finishing.find((i) => /carton|box/i.test(i.name));
      if (rm) suggested.push({ sku: rm.sku, qty: '1.25', name: rm.name, department: rm.department, unit: rm.unit, entryUnit: rm.unit });
      if (fs1) suggested.push({ sku: fs1.sku, qty: '0.004', name: fs1.name, department: fs1.department, unit: fs1.unit, entryUnit: fs1.unit });
      if (fs2) suggested.push({ sku: fs2.sku, qty: '1', name: fs2.name, department: fs2.department, unit: fs2.unit, entryUnit: fs2.unit });
    }
    // Steel / sheet / bracket / enclosure
    else if (/steel|sheet|bracket|plate|enclosure|frame/.test(n)) {
      const rm = rawMaterials.find((i) => /steel|iron|sheet/i.test(i.name)) || rawMaterials[0];
      const fs1 = finishing.find((i) => /powder|coat|paint/i.test(i.name));
      const fs2 = finishing.find((i) => /carton|box/i.test(i.name));
      if (rm) suggested.push({ sku: rm.sku, qty: '1.5', name: rm.name, department: rm.department, unit: rm.unit, entryUnit: rm.unit });
      if (fs1) suggested.push({ sku: fs1.sku, qty: '0.02', name: fs1.name, department: fs1.department, unit: fs1.unit, entryUnit: fs1.unit });
      if (fs2) suggested.push({ sku: fs2.sku, qty: '1', name: fs2.name, department: fs2.department, unit: fs2.unit, entryUnit: fs2.unit });
    }
    // General finished good fallback with any keyword
    else if (rawMaterials.length) {
      const rm = rawMaterials[0];
      const fs = finishing[0];
      if (rm) suggested.push({ sku: rm.sku, qty: '1', name: rm.name, department: rm.department, unit: rm.unit, entryUnit: rm.unit });
      if (fs) suggested.push({ sku: fs.sku, qty: '0.05', name: fs.name, department: fs.department, unit: fs.unit, entryUnit: fs.unit });
    }

    if (suggested.length) {
      st.rows = suggested;
      render();
      changed();
      const hint = $('npBomHint');
      if (hint) {
        hint.innerHTML = '<span style="color:#15803d;font-weight:600">Auto-suggested BOM recipe based on product name.</span> Quantities can be adjusted.';
      }
    }
  }

  function render() {
    const box = $('npBomList'); if (!box) return;
    const unit = unitOfFg();
    const hint = $('npBomHint');
    if (hint) hint.textContent = 'The Raw Materials and Finishing Supplies needed to make 1 ' + unit + ' of this product. "Produced Internally" uses this list to deduct the materials automatically.';
    if (st.loading) { box.innerHTML = '<div class="prod-info">Loading the saved materials…</div>'; return; }
    if (st.failed) { box.innerHTML = '<div class="prod-warn">Could not load the saved materials: ' + esc(st.failed) + '. Close the form and open it again.</div>'; return; }
    const hasMats = inv().some((i) => MATERIAL_DEPTS.indexOf(i.department) >= 0);
    const body = st.rows.map((r, i) => {
      const m = material(r.sku), q = stockQty(r, m);
      const unitTxt = m ? m.unit : (r.unit || '—');
      const line = m && q > 0 ? (Number(m.unitCost) > 0 ? peso(q * Number(m.unitCost)) : '<span class="prod-bad">no cost</span>') : '—';
      const opts = m ? unitsLike(m.unit) : [];
      const unitCell = m && opts.length > 1
        ? '<select class="prod-in np-bom-unit" data-bu="' + i + '" aria-label="Unit of line ' + (i + 1) + '">' + opts.map((u) => '<option value="' + esc(u) + '"' + (nu(u) === nu(r.entryUnit || m.unit) ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select>'
        : '<span class="dim">' + esc(unitTxt) + '</span>';
      return '<tr>' +
        '<td><select class="prod-in np-bom-mat" data-bm="' + i + '" aria-label="Material ' + (i + 1) + '">' + options(r) + '</select>' +
          (r.archived ? '<div class="prod-bad np-bom-flag">Archived — remove it or choose another</div>' : '') +
          (r.unitProblem ? '<div class="prod-bad np-bom-flag">' + esc(r.unitProblem) + '</div>' : '') +
          (r.unitNote ? '<div class="dim np-bom-flag">' + esc(r.unitNote) + '</div>' : '') +
          (m && nu(r.entryUnit || m.unit) !== nu(m.unit) && q > 0 ? '<div class="dim np-bom-flag">= ' + esc(fmt(q)) + ' ' + esc(m.unit) + ' (converted)</div>' : '') + '</td>' +
        '<td class="dim">' + esc(m ? (m.department === 'Raw Materials' ? 'Raw material' : 'Finishing supply') : '—') + '</td>' +
        '<td><input type="number" class="prod-in np-bom-qty" data-bq="' + i + '" min="0" step="any" inputmode="decimal" value="' + esc(r.qty) + '" placeholder="e.g. 0.35" aria-label="Quantity per 1 ' + esc(unit) + '"> ' + unitCell + '</td>' +
        '<td class="dim">' + (m ? esc(fmt(m.onHand)) + ' ' + esc(m.unit) : '—') + '</td>' +
        '<td class="dim">' + line + '</td>' +
        '<td><button type="button" class="prod-link" data-bx="' + i + '" aria-label="Remove line ' + (i + 1) + '">Remove</button></td></tr>';
    }).join('');
    const c = costs();
    box.innerHTML = '<div class="prod-scroll"><table class="prod-table np-bom-table"><thead><tr><th>Material</th><th>Type</th><th>Qty per 1 ' + esc(unit) + '</th><th>On hand</th><th>Cost</th><th></th></tr></thead><tbody>' +
      (body || '<tr><td colspan="6" class="dim">No materials yet. Click “+ Add material”.</td></tr>') + '</tbody></table></div>' +
      '<div class="np-bom-foot">' +
        '<button type="button" class="btn-secondary np-bom-add" id="npBomAdd"' + (st.rows.length >= MAX || !hasMats ? ' disabled' : '') + '>+ Add material</button>' +
        '<div class="np-bom-cost">' + (c.problems.length ? '<span class="prod-bad">Cannot price yet: ' + esc(c.problems[0]) + '</span>' : c.total > 0
          ? 'Material cost per 1 ' + esc(unit) + ': <strong>' + peso(c.total) + '</strong> <span class="dim">(raw ' + peso(c.raw) + ' + finishing ' + peso(c.fin) + ') · this becomes the unit cost automatically</span>'
          : '<span class="dim">The material cost appears here once you pick materials and quantities.</span>') + '</div>' +
      '</div>' +
      (hasMats ? '' : '<div class="prod-warn">There are no Raw Materials or Finishing Supplies in the catalog yet. Add them first.</div>');
  }

  // events (delegated, so re-rendering does not lose them)
  function bind() {
    const sec = $('npBomSection'); if (!sec || sec.dataset.bound) return;
    sec.dataset.bound = '1';
    sec.addEventListener('change', (e) => {
      const u = e.target.closest('[data-bu]');
      if (u) { st.rows[+u.dataset.bu].entryUnit = u.value; st.dirty = true; clearMsg(); render(); changed(); return; }
      const s = e.target.closest('[data-bm]'); if (!s) return;
      const r = st.rows[+s.dataset.bm]; const m = material(s.value);
      Object.assign(r, { sku: s.value, name: m ? m.name : '', department: m ? m.department : '', unit: m ? m.unit : '', entryUnit: m ? m.unit : '', archived: false, unitChanged: false, unitProblem: '', unitNote: '' });
      st.dirty = true; clearMsg(); render(); changed();
      const q = document.querySelector('[data-bq="' + s.dataset.bm + '"]'); if (q && !q.value) q.focus();
    });
    sec.addEventListener('input', (e) => {
      const q = e.target.closest('[data-bq]'); if (!q) return;
      const row = st.rows[+q.dataset.bq]; row.qty = q.value; row.unitProblem = ''; st.dirty = true; clearMsg();
      const cell = q.closest('tr').children[4], m = material(row.sku), n = stockQty(row, m);
      if (cell) cell.textContent = m && n > 0 ? (Number(m.unitCost) > 0 ? peso(n * Number(m.unitCost)) : 'no cost') : '—';
      const c = costs(), costBox = sec.querySelector('.np-bom-cost');
      if (costBox && c.total > 0 && !c.problems.length && costBox.querySelector('strong')) costBox.querySelector('strong').textContent = peso(c.total);
      else if (costBox) render();
      changed();
    });
    sec.addEventListener('blur', (e) => { if (e.target.closest('[data-bq]')) render(); }, true);
    sec.addEventListener('click', (e) => {
      const x = e.target.closest('[data-bx]');
      if (x) { st.rows.splice(+x.dataset.bx, 1); st.dirty = true; clearMsg(); render(); changed(); return; }
      if (e.target.closest('#npBomAdd')) {
        st.rows.push({ sku: '', qty: '' }); st.dirty = true; render();
        const sels = sec.querySelectorAll('[data-bm]'); if (sels.length) sels[sels.length - 1].focus();
        return;
      }
    });
  }
  function clearMsg() {
    const box = $('npBomList'); if (!box) return;
    box.classList.remove('field-invalid');
    const g = box.closest('.form-group'); if (g) g.querySelectorAll('.field-msg').forEach((n) => n.remove());
  }

  /* ---------- checks before the product is saved (mirrors the server rules) ---------- */
  function problem() {
    if (!isFG()) return '';
    if (st.loading) return 'Wait for the saved materials to finish loading.';
    if (st.failed) return 'The saved materials could not be loaded. Close the form and open it again.';
    const lines = st.rows.filter((r) => r.sku || String(r.qty).trim() !== '');
    if (!lines.length) return 'Add at least one raw material or finishing supply needed to make this product.';
    if (lines.length > MAX) return 'A product can have at most ' + MAX + ' materials.';
    const seen = new Set();
    for (let i = 0; i < lines.length; i++) {
      const r = lines[i], n = Number(r.qty), label = 'Line ' + (st.rows.indexOf(r) + 1) + ': ';
      if (!r.sku) return label + 'choose the material (or remove the line).';
      if (seen.has(r.sku)) return label + 'each material can only be listed once.';
      seen.add(r.sku);
      const m = material(r.sku);
      if (!m) return label + (r.name || r.sku) + ' is archived or no longer in the catalog. Remove it or choose another.';
      if (MATERIAL_DEPTS.indexOf(m.department) < 0) return label + m.name + ' is not a Raw Material or Finishing Supply.';
      if (String(r.qty).trim() === '' || !Number.isFinite(n) || n <= 0) return label + 'enter how much of ' + m.name + ' one unit needs (more than 0).';
      if (n > 1e6) return label + 'the quantity is too large.';
      if (m.unit && nu(r.entryUnit || m.unit) === nu(m.unit) && Math.abs(n * 1e4 - Math.round(n * 1e4)) > 1e-6) return label + 'use at most 4 decimal places.';
      if (r.unitProblem) return label + r.unitProblem;
      if (stockQty(r, m) == null || !(stockQty(r, m) > 0)) return label + n + ' ' + (r.entryUnit || m.unit) + ' is too small to keep in ' + m.unit + ' (smallest is 0.0001 ' + m.unit + ').';
    }
    return '';
  }

  // called by api-bridge.js after the product itself is saved. Returns the number of materials saved, or 0 if nothing changed.
  async function saveWithProduct(sku) {
    if (!isFG()) return 0;
    const isNew = st.loadedFor !== String(sku).toUpperCase();
    if (!st.dirty && !isNew) return 0;
    const materials = st.rows.filter((r) => r.sku).map((r) => { const m = material(r.sku), o = { sku: r.sku, qtyPerUnit: Number(r.qty) }; if (m && nu(r.entryUnit || m.unit) !== nu(m.unit)) o.unit = r.entryUnit; return o; });
    st.lastResult = await B().api('/production/requirements/' + encodeURIComponent(String(sku).toUpperCase()), { method: 'PUT', body: JSON.stringify({ materials }) });
    st.dirty = false; st.loadedFor = String(sku).toUpperCase();
    document.dispatchEvent(new CustomEvent('triplee:materials-saved', { detail: { sku: st.loadedFor } }));
    return materials.length;
  }

  /* ---------- product details window: what it is made of / what it is used in ---------- */
  async function renderDetails(p) {
    const box = $('pdMaterials'); if (!box || !p) return;
    const fg = p.department === 'Finished Goods';
    if (!fg && MATERIAL_DEPTS.indexOf(p.department) < 0) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="pd-mats"><div class="pd-mats-title">' + (fg ? 'Materials needed' : 'Used to make') + '</div><div class="dim">Loading…</div></div>';
    try {
      let html;
      if (fg) {
        const r = await B().api('/production/requirements/' + encodeURIComponent(p.sku));
        const total = r.materials.reduce((s, m) => s + m.qtyPerUnit * (m.unitCost || 0), 0);
        html = r.materials.length
          ? '<table class="prod-table"><thead><tr><th>Material</th><th>Per 1 ' + esc(r.unit) + '</th><th>On hand</th></tr></thead><tbody>' +
            r.materials.map((m) => '<tr><td>' + esc(m.name) + ' <span class="dim">· ' + esc(m.department === 'Raw Materials' ? 'Raw' : 'Finishing') + '</span></td><td>' + esc(fmt(m.qtyPerUnit)) + ' ' + esc(m.unit) + '</td><td class="dim">' + esc(fmt(m.onHand)) + ' ' + esc(m.unit) + '</td></tr>').join('') +
            '</tbody></table><div class="pd-mats-foot">Material cost per 1 ' + esc(r.unit) + ': <strong>' + peso(total) + '</strong></div>'
          : '<div class="prod-warn">No materials are set yet, so this product cannot be recorded as Produced Internally. Click Edit to add them.</div>';
      } else {
        const r = await B().api('/production/where-used/' + encodeURIComponent(p.sku));
        html = r.usedIn.length
          ? '<ul class="pd-mats-list">' + r.usedIn.map((u) => '<li>' + esc(u.name) + ' <span class="dim">· ' + esc(fmt(u.qtyPerUnit)) + ' ' + esc(r.unit) + ' per ' + esc(u.unit) + (u.archived ? ' · archived' : '') + '</span></li>').join('') + '</ul>'
          : '<div class="dim">Not used by any finished good yet.</div>';
      }
      if (box.isConnected) box.innerHTML = '<div class="pd-mats"><div class="pd-mats-title">' + (fg ? 'Materials needed' : 'Used to make') + '</div>' + html + '</div>';
    } catch (err) {
      if (box.isConnected) box.innerHTML = '<div class="pd-mats"><div class="pd-mats-title">' + (fg ? 'Materials needed' : 'Used to make') + '</div><div class="dim">' + esc(err.message) + '</div></div>';
    }
  }

  /* ---------- start ---------- */
  function init() {
    const overlay = $('newProductModalOverlay'), dept = $('npDept');
    if (!overlay || !dept || !$('npBomSection')) return;
    bind();
    document.addEventListener('triplee:recipe-changed', syncWeight);
    const wm = $('npWeightManual'); if (wm) wm.addEventListener('change', syncWeight);
    dept.addEventListener('change', sync);
    const unit = $('npUnit'); if (unit) unit.addEventListener('change', () => { if (isFG()) render(); });
    let wasOpen = false;
    new MutationObserver(() => {
      const open = overlay.classList.contains('open');
      if (open && !wasOpen) setTimeout(onOpen, 0);       // after script.js has filled the form (department included)
      wasOpen = open;
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  window.TripleEBom = { problem, saveWithProduct, renderDetails, sync,
    cost: () => costs(), hasRecipe: () => st.rows.some((r) => r.sku), dirty: () => st.dirty,
    get lastResult() { return st.lastResult || null; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
