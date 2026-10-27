/* pricing-admin.js — Finance > Products > "Pricing rules".
   One place for every number the automatic prices use (pricing.js on the server):
     - finished goods markup (selling price = unit cost + markup, default 20%)
     - quote markup, and the ESTIMATES the quick recipe of a made-to-order quote starts from (weights, fill factor, density,
       scrap, finishing supply per kg). They are first guesses, labelled as estimates; the cashier / Finance can still correct
       the recipe lines on each quote. Saving re-prices every finished good on automatic pricing straight away. Loaded after api-bridge.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const B = () => window.TripleEBridge;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // which rate groups are shown, in what order, with what unit
  const GROUPS = [
    ['finishUsePerKg', 'Finishing supply used per kg of the piece', 'unit/kg', 'How much of the finishing supply (powder, plating salt, polishing compound …, in its stock unit) one kg of the piece uses. 0 = the finish uses no stock item.'],
    ['rangeWeightKg', 'Weight of a size range (aluminum)', 'kg', 'Brass weighs more: it is scaled by the densities below.'],
    ['pipeWeightKg', 'Weight of a fitting by pipe size (brass)', 'kg', 'Typed sizes between two of these are worked out in between.'],
    ['density', 'Density', 'g/cm³', 'Used for typed dimensions (length × width × height).']
  ];
  const SINGLES = [
    ['scrapPct', 'Material scrap allowance', '%'], ['fillFactor', 'Fill factor for typed dimensions', '0–1'],
    ['thicknessRefMm', 'Reference wall thickness', 'mm']
  ];
  const EST = ' <em class="pr-est">estimate</em>';
  let data = null;
  let isEditMode = false;

  function ensureModal() {
    let ov = $('pricingOverlay'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'modal-overlay'; ov.id = 'pricingOverlay';
    ov.innerHTML = '<div class="account-modal supplier-modal product-modal pr-modal" role="dialog" aria-modal="true" aria-labelledby="prTitle">' +
      '<button type="button" class="modal-close" id="prClose" aria-label="Close">×</button>' +
      '<div class="supplier-modal-head" style="align-items:center"><div class="supplier-modal-icon"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>' +
      '<div style="flex:1"><div class="modal-eyebrow">Catalog</div><h2 class="modal-title" id="prTitle" style="margin-bottom:0">Automated Pricing Rules</h2></div>' +
      '<button type="button" class="btn-secondary btn-sm" id="prModeToggle" style="margin-right:24px">Edit parameters</button></div>' +
      '<form id="prForm" novalidate><div id="prBody"><p class="dim">Loading…</p></div>' +
      '<p class="form-error" id="prErr"></p><div class="modal-footer"><button type="button" class="btn-secondary" id="prCancel">Close</button>' +
      '<button type="submit" class="btn-primary" id="prSave" style="display:none">Save pricing rules</button></div></form></div>';
    document.body.appendChild(ov);
    const close = () => { ov.classList.remove('open'); if (!document.querySelector('.modal-overlay.open')) { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; } };
    $('prClose').addEventListener('click', close); $('prCancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ov.classList.contains('open')) close(); });
    $('prForm').addEventListener('submit', (e) => { e.preventDefault(); save(close); });
    $('prBody').addEventListener('input', preview);
    if ($('prModeToggle')) $('prModeToggle').addEventListener('click', () => {
      isEditMode = !isEditMode;
      $('prModeToggle').textContent = isEditMode ? 'View guidelines' : 'Edit parameters';
      $('prSave').style.display = isEditMode ? '' : 'none';
      render();
    });
    return ov;
  }
  const field = (name, label, unit, value, step, est) =>
    '<label class="pr-f"><span>' + esc(label) + (est ? EST : '') + '</span><span class="pr-in"><input type="number" min="0" step="' + (step || 'any') + '" inputmode="decimal" name="' + esc(name) + '" value="' + esc(value) + '"><i>' + esc(unit) + '</i></span></label>';

  function render() {
    const r = data.rates, mp = data.materialItems || {};
    if (!isEditMode) {
      const fgM = Number(data.fgMarkupPct) || 20;
      const margin = (fgM / (100 + fgM) * 100).toFixed(1);
      $('prBody').innerHTML =
        '<div style="background:var(--surface-sunken, #f8fafc);border:1px solid var(--border, #e2e8f0);border-radius:8px;padding:16px;margin-bottom:14px">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
            '<div style="font-weight:700;font-size:15px;color:var(--text, #0f172a)">Automated Cost-Plus Engine</div>' +
            '<span style="background:#dcfce7;color:#15803d;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:700">Fully Automated</span>' +
          '</div>' +
          '<p style="margin:0 0 12px;font-size:13px;color:var(--text-dim, #64748b)">All finished goods selling prices are computed mathematically from recipe material costs with zero manual inputting.</p>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
            '<div style="background:rgba(255,255,255,0.7);padding:10px 12px;border-radius:6px;border:1px solid var(--border-subtle, #e2e8f0)">' +
              '<div style="font-size:11.5px;color:var(--text-faint, #64748b);text-transform:uppercase;font-weight:600">Finished Goods Markup</div>' +
              '<div style="font-size:20px;font-weight:700;color:#1e40af;margin-top:2px">' + fgM + '% <span style="font-size:13px;font-weight:400;color:var(--text-dim)">(' + margin + '% margin)</span></div>' +
              '<div style="font-size:12px;color:var(--text-dim);margin-top:3px">Price = Unit Cost × ' + (1 + fgM / 100).toFixed(2) + ' (Example: ₱100 → ₱' + (100 * (1 + fgM / 100)).toFixed(2) + ')</div>' +
            '</div>' +
            '<div style="background:rgba(255,255,255,0.7);padding:10px 12px;border-radius:6px;border:1px solid var(--border-subtle, #e2e8f0)">' +
              '<div style="font-size:11.5px;color:var(--text-faint, #64748b);text-transform:uppercase;font-weight:600">Custom Quotes Markup</div>' +
              '<div style="font-size:20px;font-weight:700;color:#1e40af;margin-top:2px">' + (data.quoteMarkupPct || 25) + '%</div>' +
              '<div style="font-size:12px;color:var(--text-dim);margin-top:3px">Auto-computed by weight, scrap, & material rates</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--text-dim, #64748b);padding:0 4px">' +
          'Prices and quote costs update automatically as supplier purchase costs or recipes change. ' +
          'To adjust corporate markup percentages or base conversion rates, click <b>Edit parameters</b> above.' +
        '</div>';
      return;
    }
    $('prBody').innerHTML =
      '<div class="form-section-label">Finished goods</div>' +
      '<div class="pr-grid">' + field('fgMarkupPct', 'Markup on cost', '%', data.fgMarkupPct, '0.01') + '</div>' +
      '<p class="field-hint" id="prFgHint"></p>' +
      '<div class="form-section-label">Custom made-to-order quotes</div>' +
      '<div class="pr-grid">' + field('quoteMarkupPct', 'Markup on the computed cost', '%', data.quoteMarkupPct, '0.01') +
        SINGLES.map((s) => field('rates.' + s[0], s[1], s[2], r[s[0]], null, true)).join('') + '</div>' +
      '<p class="field-hint">The quick recipe uses the stock item that matches each material, at its current unit cost: ' + Object.keys(mp).map((m) => esc(m) + ' → ' +
        (mp[m] ? esc(mp[m].name) + ' ' + (mp[m].unitCost > 0 ? peso(mp[m].unitCost) + '/' + esc(mp[m].unit) : '<b>no cost yet: cannot price</b>') : '<b>no stock item: cannot price</b>')).join(' · ') + '.</p>' +
      GROUPS.map((g) => '<details class="pr-group"><summary>' + esc(g[1]) + EST + '</summary><p class="field-hint">' + esc(g[3]) + '</p><div class="pr-grid">' +
        Object.keys(r[g[0]] || {}).map((k) => field('rates.' + g[0] + '.' + k, k, g[2], r[g[0]][k])).join('') + '</div></details>').join('') +
      '<p class="field-hint">Quick recipe per piece: raw material = estimated weight × (1 + scrap), finishing supply = weight × its use per kg. ' +
        'Cost = each quantity × the item’s current unit cost (materials only, the same formula as a finished good’s recipe); price = cost × (1 + markup). ' +
        'Fields marked <em class="pr-est">estimate</em> are first guesses: the cashier or Finance can correct the recipe on each quote.' +
        (data.updatedAt ? ' Last changed ' + esc(new Date(data.updatedAt).toLocaleString('en-PH')) + (data.updatedBy ? ' by ' + esc(data.updatedBy) : '') + '.' : '') + '</p>';
    if (window.FormAssist) {
      $('prBody').querySelectorAll('input[name]').forEach((input) => {
        FormAssist.validation.bind(input, (value) => pricingProblem(input.name, value));
      });
    }
    preview();
  }
  function pricingProblem(name, value) {
    const n = Number(value), part = name.split('.')[1];
    const max = !name.startsWith('rates.') ? 500 : part === 'fillFactor' ? 1 : part === 'scrapPct' ? 100 : part === 'finishUsePerKg' ? 10 : 1e7;
    if (value === '' || !Number.isFinite(n)) return 'Enter a number.';
    if (n < 0 || n > max) return 'Enter a number from 0 to ' + max.toLocaleString('en-US') + '.';
    if (['fillFactor', 'thicknessRefMm', 'density'].includes(part) && Math.round(n * 10000) / 10000 <= 0) return 'Enter a number greater than zero.';
    return '';
  }
  function preview() {
    const f = $('prForm'), m = Number(f.elements.fgMarkupPct && f.elements.fgMarkupPct.value), h = $('prFgHint'); if (!h) return;
    h.textContent = Number.isFinite(m) && m >= 0 ? 'Markup is on COST, not on the price. Selling price = unit cost × ' + (1 + m / 100).toFixed(2) + '. Example: cost ₱100.00 → price ' + peso(100 * (1 + m / 100)) +
      ', which is a margin of ' + (m / (100 + m) * 100).toFixed(1) + '%. The unit cost of a finished good comes from its recipe (materials only). Every finished good on automatic pricing is updated when you save.' : 'Enter the markup in percent.';
  }
  async function open() {
    const ov = ensureModal(); ov.classList.add('open'); document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden';
    $('prErr').classList.remove('show'); $('prBody').innerHTML = '<p class="dim">Loading…</p>';
    try { data = await B().api('/pricing'); render(); } catch (e) { $('prBody').innerHTML = '<p class="prod-warn">' + esc(e.message) + '</p>'; }
  }
  async function save(close) {
    const f = $('prForm'), err = $('prErr'), btn = $('prSave');
    const invalid = Array.from(f.querySelectorAll('input[name]')).filter((input) => {
      const message = pricingProblem(input.name, input.value);
      if (window.FormAssist) FormAssist.validation.show(input, message);
      return !!message;
    });
    if (invalid.length) { invalid[0].focus(); return; }
    const body = { fgMarkupPct: f.elements.fgMarkupPct.value, quoteMarkupPct: f.elements.quoteMarkupPct.value, rates: {} };
    [].forEach.call(f.querySelectorAll('input[name^="rates."]'), (i) => {
      const parts = i.name.split('.'); if (parts.length === 2) body.rates[parts[1]] = i.value;
      else { body.rates[parts[1]] = body.rates[parts[1]] || {}; body.rates[parts[1]][parts.slice(2).join('.')] = i.value; }
    });
    btn.disabled = true; err.classList.remove('show');
    try {
      const r = await B().api('/finance/pricing', { method: 'PUT', body: JSON.stringify(body) });
      B().toast('Pricing rules saved' + (r.repriced ? ' · ' + r.repriced + ' finished good price' + (r.repriced === 1 ? '' : 's') + ' recalculated' : '') + '.');
      document.dispatchEvent(new CustomEvent('triplee:pricing-saved', { detail: r }));
      close(); await B().reload();
    } catch (e) {
      const first = e.fields && Object.keys(e.fields)[0];
      err.textContent = first ? e.fields[first] : e.message; err.classList.add('show');
      Object.keys(e.fields || {}).forEach((name) => {
        if (f.elements[name] && window.FormAssist) FormAssist.validation.show(f.elements[name], e.fields[name]);
      });
      if (first && f.elements[first]) f.elements[first].focus();
    } finally { btn.disabled = false; }
  }
  function init() {
    const right = document.querySelector('#products .catalog-toolbar-right'), nb = $('newProductBtn');
    if (!right || !nb || $('pricingRulesBtn')) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.id = 'pricingRulesBtn';
    b.title = 'Markup and the automatic price formula'; b.textContent = 'Pricing rules';
    right.insertBefore(b, nb); b.addEventListener('click', open);
    const st = document.createElement('style');
    st.textContent = '.pr-modal{max-width:760px}.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px 14px;margin:6px 0 4px}' +
      '.pr-f{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--text-dim);min-width:0}.pr-in{display:flex;align-items:center;gap:6px}' +
      '.pr-in input{flex:1 1 auto;min-width:0;background:var(--black);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit}' +
      '.pr-in i{font-style:normal;color:var(--text-faint);white-space:nowrap;font-size:12px}.pr-group{margin:8px 0;border:1px solid var(--border);border-radius:10px;padding:8px 12px}' +
      '.pr-group summary{cursor:pointer;font-weight:650;color:var(--text)}#pricingRulesBtn{white-space:nowrap}' +
      '.pr-est{font-style:normal;font-size:11px;font-weight:650;color:var(--amber);border:1px solid var(--amber);border-radius:99px;padding:0 6px;margin-left:4px;text-transform:uppercase;letter-spacing:.4px}';
    document.head.appendChild(st);
  }
  window.TripleEPricing = { open };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
