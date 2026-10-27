/* delivery-rates-admin.js — Finance: "Delivery rates" panel on the Online Orders page.
   The delivery fee of an online order is worked out from the delivery address:
   a rate for the province wins, otherwise the rate for the region, otherwise the "All other areas" rate.
   Loaded after sales-orders.js in Finance_Inventory.html. Talks to GET / PUT /api/delivery-rates. */
(function () {
  'use strict';
  const REGIONS = ['NCR - National Capital Region', 'CAR - Cordillera Administrative Region', 'Region I - Ilocos Region',
    'Region II - Cagayan Valley', 'Region III - Central Luzon', 'Region IV-A - CALABARZON', 'MIMAROPA - Region IV-B',
    'Region V - Bicol Region', 'Region VI - Western Visayas', 'NIR - Negros Island Region', 'Region VII - Central Visayas',
    'Region VIII - Eastern Visayas', 'Region IX - Zamboanga Peninsula', 'Region X - Northern Mindanao', 'Region XI - Davao Region',
    'Region XII - SOCCSKSARGEN', 'Region XIII - Caraga', 'BARMM - Bangsamoro Autonomous Region'];
  // Recommended coverage: NCR near, Central Luzon + CALABARZON nearby, everything else not delivered (customers can request a quote or pick up)
  const RECOMMENDED = { 'NCR - National Capital Region': [150, true], 'Region III - Central Luzon': [250, true], 'Region IV-A - CALABARZON': [250, true],
    'CAR - Cordillera Administrative Region': [350, false], 'Region I - Ilocos Region': [350, false], 'Region II - Cagayan Valley': [350, false],
    'MIMAROPA - Region IV-B': [350, false], 'Region V - Bicol Region': [350, false], 'Region VI - Western Visayas': [450, false],
    'NIR - Negros Island Region': [450, false], 'Region VII - Central Visayas': [450, false], 'Region VIII - Eastern Visayas': [450, false],
    'Region IX - Zamboanga Peninsula': [550, false], 'Region X - Northern Mindanao': [550, false], 'Region XI - Davao Region': [550, false],
    'Region XII - SOCCSKSARGEN': [550, false], 'Region XIII - Caraga': [550, false], 'BARMM - Bangsamoro Autonomous Region': [550, false] };

  const DEFAULT_SETTINGS = {
    freeWeightKg: 20,
    perKgFee: 5,
    freeOverAmount: 0,
    packDays: 1,
    transitMetro: 2,
    transitOther: 5,
    rangeDays: 2
  };

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const peso = (n) => '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---------- Panel 1: Regional Delivery Rates ---------- */
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.marginTop = '18px';
  panel.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="panel-title">Automated Regional Delivery Rates &amp; Coverage</div>
        <div class="panel-sub">The delivery engine maps customer shipping addresses to active zone rates automatically. Uncovered areas are guided to counter pickup. Zero manual pricing required.</div>
      </div>
      <div class="inv-filters">
        <button type="button" class="btn-secondary btn-sm" id="drToggleEdit">Configure Parameters</button>
      </div>
    </div>

    <!-- View-only active coverage table (default) -->
    <div class="table-wrapper" id="drViewWrapper">
      <table>
        <thead>
          <tr>
            <th>Zone / Area</th>
            <th>Applies To</th>
            <th>Fulfillment Mode</th>
            <th style="text-align:right">Automated Base Fee</th>
          </tr>
        </thead>
        <tbody id="drViewBody">
          <tr><td colspan="4" class="faint">Loading active delivery coverage&hellip;</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Parameter Configuration (hidden by default) -->
    <div id="drEditWrapper" hidden>
      <div style="padding:10px 16px 4px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn-secondary btn-sm" id="drRecommended" title="NCR, Central Luzon and CALABARZON only; every other region blocked">Use recommended coverage</button>
        <button type="button" class="btn-secondary btn-sm" id="drAddRegion">Add region</button>
        <button type="button" class="btn-secondary btn-sm" id="drAddProvince">Add province</button>
        <button type="button" class="btn-primary btn-sm" id="drSave">Save rates</button>
      </div>
      <div class="table-wrapper">
        <table>
          <thead><tr><th>Applies to</th><th>Place</th><th style="width:110px">We deliver here</th><th style="width:150px">Fee (\u20B1)</th><th style="width:90px"></th></tr></thead>
          <tbody id="drBody"><tr><td colspan="5" class="faint">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
      <div class="faint" id="drMsg" style="padding:10px 16px;min-height:18px"></div>
    </div>`;

  const $ = (id) => panel.querySelector('#' + id);
  let rows = [];     // { scope, name, fee, available }

  function toast(msg, err) {
    const el = document.createElement('div'); el.className = 'app-toast' + (err ? ' error' : '');
    el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 4000);
  }
  async function api(method, body) {
    const r = await fetch('/api/delivery-rates', { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || (d.errors && Object.values(d.errors)[0]) || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }
  const order = (a, b) => {
    const rank = { default: 0, region: 1, province: 2 };
    if (a.scope !== b.scope) return rank[a.scope] - rank[b.scope];
    if (a.scope === 'region') return REGIONS.indexOf(a.name) - REGIONS.indexOf(b.name);
    return a.name.localeCompare(b.name);
  };

  function drawView() {
    const body = $('drViewBody');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="faint">No delivery rates on file.</td></tr>';
      return;
    }
    body.innerHTML = rows.map((r) => {
      const isDelivered = r.available !== false;
      const scopeLabel = r.scope === 'default' ? 'Fallback Rule' : r.scope === 'region' ? 'Regional Zone' : 'Provincial Zone';
      const statusPill = isDelivered
        ? '<span class="status-pill in">Active Delivery</span>'
        : '<span class="status-pill low">Pickup Only</span>';
      const feeText = isDelivered ? '<b>' + peso(r.fee) + '</b>' : '<span class="faint">Excluded (In-store pickup only)</span>';

      return '<tr>'
        + '<td><b>' + esc(r.name) + '</b>' + (r.scope === 'default' ? ' <span class="faint">(used when no region or province rate matches)</span>' : '') + '</td>'
        + '<td><span class="faint">' + esc(scopeLabel) + '</span></td>'
        + '<td>' + statusPill + '</td>'
        + '<td style="text-align:right">' + feeText + '</td>'
        + '</tr>';
    }).join('');
  }

  function draw() {
    drawView();
    $('drBody').innerHTML = rows.map((r, i) => {
      const place = r.scope === 'default'
        ? '<b>All other areas</b> <span class="faint">(used when no region or province rate matches)</span>'
        : r.scope === 'region'
          ? `<select class="inv-select" data-i="${i}" data-f="name">${(REGIONS.includes(r.name) || !r.name ? REGIONS : REGIONS.concat(r.name)).map((n) => `<option ${n === r.name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`
          : `<input class="inv-search" data-i="${i}" data-f="name" value="${esc(r.name)}" placeholder="Province, e.g. Cebu" maxlength="100" autocomplete="off">`;
      return `<tr>
        <td>${r.scope === 'default' ? 'Default' : r.scope === 'region' ? 'Region' : 'Province'}</td>
        <td>${place}</td>
        <td><label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" data-i="${i}" data-f="available" ${r.available === false ? '' : 'checked'}> <span class="faint">${r.available === false ? 'No' : 'Yes'}</span></label></td>
        <td><input class="inv-search" type="text" data-money inputmode="decimal" autocomplete="off" data-i="${i}" data-f="fee" value="${esc(window.MoneyInput ? MoneyInput.fmt(r.fee) : r.fee)}" style="width:120px" ${r.available === false ? 'disabled' : ''}></td>
        <td>${r.scope === 'default' ? '' : `<button type="button" class="btn-secondary btn-sm" data-del="${i}">Remove</button>`}</td></tr>`;
    }).join('');
    if (window.FormAssist) $('drBody').querySelectorAll('[data-f="name"], [data-f="fee"]').forEach((input) => {
      FormAssist.validation.bind(input, (value) => {
        const row = rows[+input.dataset.i];
        if (input.dataset.f === 'name') return row.scope !== 'default' && value.trim().length < 2 ? 'Enter the province name (at least 2 characters).' : '';
        const raw = window.MoneyInput ? MoneyInput.raw(value) : value, fee = Number(raw);
        return row.available !== false && (raw === '' || !Number.isFinite(fee) || fee < 0) ? 'Enter a fee of 0 or more.' : '';
      });
    });
  }

  // Toggle edit/view
  const drToggle = $('drToggleEdit');
  if (drToggle) {
    drToggle.addEventListener('click', () => {
      const v = $('drViewWrapper'), e = $('drEditWrapper');
      if (!v || !e) return;
      const showEdit = e.hidden;
      e.hidden = !showEdit;
      v.hidden = showEdit;
      drToggle.textContent = showEdit ? 'View Active Policies' : 'Configure Parameters';
    });
  }

  panel.addEventListener('input', (e) => {
    const t = e.target; if (t.dataset.i == null) return;
    if (t.dataset.f === 'available') { rows[+t.dataset.i].available = t.checked; draw(); $('drMsg').textContent = ''; return; }
    rows[+t.dataset.i][t.dataset.f] = t.dataset.f === 'fee' ? (window.MoneyInput ? MoneyInput.raw(t.value) : t.value) : t.value;
    $('drMsg').textContent = '';
  });
  panel.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { rows.splice(+del.dataset.del, 1); draw(); }
  });
  $('drRecommended').onclick = () => {
    if (!window.confirm('Set every region to the recommended coverage (deliver to NCR, Central Luzon and CALABARZON only; block all other regions and "All other areas")?\nProvince exceptions you added are kept. Nothing changes until you press Save rates.')) return;
    const keep = rows.filter((r) => r.scope === 'province');
    const def = rows.find((r) => r.scope === 'default') || { scope: 'default', name: 'All other areas', fee: 150 };
    rows = [Object.assign({}, def, { available: false })]
      .concat(REGIONS.map((n) => ({ scope: 'region', name: n, fee: RECOMMENDED[n][0], available: RECOMMENDED[n][1] })), keep).sort(order);
    draw(); $('drMsg').textContent = 'Recommended coverage loaded. Review it, then press Save rates.';
  };
  $('drAddRegion').onclick = () => {
    const free = REGIONS.find((n) => !rows.some((r) => r.scope === 'region' && r.name === n)) || REGIONS[0];
    rows.push({ scope: 'region', name: free, fee: (rows.find((r) => r.scope === 'default') || {}).fee || 0 }); draw();
  };
  $('drAddProvince').onclick = () => { rows.push({ scope: 'province', name: '', fee: (rows.find((r) => r.scope === 'default') || {}).fee || 0 }); draw(); const el = panel.querySelector('tbody tr:last-child input[data-f="name"]'); if (el) el.focus(); };
  $('drSave').onclick = async () => {
    const msg = $('drMsg'); msg.textContent = '';
    for (const r of rows) {
      const fee = Number(r.fee);
      if (r.scope !== 'default' && String(r.name).trim().length < 2) { msg.textContent = 'Enter the province name for every province rate (or remove the row).'; return; }
      if (r.available !== false && (r.fee === '' || !Number.isFinite(fee) || fee < 0)) { msg.textContent = 'Enter a fee of 0 or more for ' + (r.name || 'every row') + '.'; return; }
    }
    const btn = $('drSave'); btn.disabled = true;
    try {
      rows = (await api('PUT', { rates: rows.map((r) => ({ scope: r.scope, name: String(r.name).trim(), fee: Number(r.fee) || 0, available: r.available !== false })) })).sort(order);
      draw(); toast('Delivery rates saved. New orders use them right away.');
    } catch (er) { msg.textContent = er.message; }
    btn.disabled = false;
  };

  api('GET').then((d) => { rows = Array.isArray(d) ? d.sort(order) : []; draw(); })
    .catch((er) => { if (er.status === 403) panel.remove(); else $('drBody').innerHTML = `<tr><td colspan="5" class="faint">${esc(er.message)}</td></tr>`; });


  /* ---------- Panel 2: Weight charge + estimated arrival (delivery-calc.js) ---------- */
  const FIELDS = [
    ['freeWeightKg', 'Free weight allowance (kg)', 'No weight charge up to this weight per order.'],
    ['perKgFee', 'Charge per extra kg (\u20B1)', 'Added for every started kg above the allowance. 0 switches the weight charge off.'],
    ['freeOverAmount', 'Free delivery on orders of (\u20B1)', 'Goods total that earns free delivery. 0 = no free delivery.'],
    ['packDays', 'Packing time (working days)', 'From the order to handing the parcel to the courier.'],
    ['transitMetro', 'Travel time, Metro Manila (working days)', 'Added to the packing time.'],
    ['transitOther', 'Travel time, other areas (working days)', 'Added to the packing time.'],
    ['rangeDays', 'Arrival range (working days)', 'The customer is shown "earliest to latest"; the latest is this many days after the earliest.']
  ];

  let currentSettings = Object.assign({}, DEFAULT_SETTINGS);

  const sp = document.createElement('div');
  sp.className = 'panel'; sp.style.marginTop = '18px';
  sp.innerHTML = `
    <div class="panel-head">
      <div>
        <div class="panel-title">Automated Weight Surcharges &amp; Delivery SLA Policies</div>
        <div class="panel-sub">Weight charges and arrival estimates are computed automatically from item catalog weights and working-day transit calendar. No manual calculation required.</div>
      </div>
      <div class="inv-filters">
        <button type="button" class="btn-secondary btn-sm" id="dsToggleEdit">Configure Parameters</button>
      </div>
    </div>

    <!-- View-only policy cards (default) -->
    <div id="dsViewCards" class="policy-cards-grid"></div>

    <!-- Parameter Configuration (hidden by default) -->
    <div id="dsEditWrapper" hidden>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;padding:14px 16px 8px">
        ${FIELDS.map((x) => '<div><label class="form-label" for="ds_' + x[0] + '">' + esc(x[1]) + '</label><input class="inv-search" style="width:100%" id="ds_' + x[0] + '" inputmode="decimal" autocomplete="off">' +
          '<div class="faint" style="font-size:12px;margin-top:4px">' + esc(x[2]) + '</div></div>').join('')}
      </div>
      <div class="faint" id="dsExample" style="padding:6px 16px 4px"></div>
      <div style="display:flex;gap:12px;align-items:center;padding:10px 16px 14px">
        <button type="button" class="btn-primary btn-sm" id="dsSave">Save settings</button>
        <span class="faint" id="dsMsg"></span>
      </div>
    </div>`;
  function mountPanels() {
    if (panel.isConnected) return true;
    const policies = document.getElementById('payment-terms');
    if (policies && policies.dataset.built !== '1') return false;
    const target = document.getElementById('ptrCodBox') || document.getElementById('ptrPolicyBox') || document.querySelector('#payment-terms .panel') || document.getElementById('payment-terms');
    if (!target) return false;
    if (target.id === 'payment-terms') {
      target.appendChild(panel);
    } else {
      target.insertAdjacentElement('afterend', panel);
    }
    panel.insertAdjacentElement('afterend', sp);
    return true;
  }
  if (!mountPanels()) {
    const timer = setInterval(() => { if (mountPanels()) clearInterval(timer); }, 60);
  }

  const $s = (id) => sp.querySelector('#' + id);

  async function sapi(method, body) {
    const r = await fetch('/api/delivery-settings', { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || (d.errors && Object.values(d.errors)[0]) || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }

  function renderSettingsCards(d) {
    const c = $s('dsViewCards');
    if (!c) return;
    const s = Object.assign({}, DEFAULT_SETTINGS, d || {});
    const freeKg = Number(s.freeWeightKg) || 20;
    const extraFee = Number(s.perKgFee) || 5;
    const freeOver = Number(s.freeOverAmount) || 0;
    const pack = Number(s.packDays) || 1;
    const tMetro = Number(s.transitMetro) || 2;
    const tOther = Number(s.transitOther) || 5;
    const rDays = Number(s.rangeDays) || 2;

    c.innerHTML = `
      <div class="policy-card">
        <div class="policy-card-head">
          <div><div class="policy-card-title">Weight Allowance &amp; Auto-Surcharges</div><div class="faint">Heavy order calculation engine</div></div>
          <span class="status-pill ok">Automated Engine</span>
        </div>
        <div class="policy-card-rule">Orders up to the weight allowance ship with zero surcharge. Heavier orders are charged per extra kilogram automatically from product piece weights.</div>
        <div class="policy-card-metrics">
          <div><div class="policy-metric-label">Free Weight Allowance</div><div class="policy-metric-val">${freeKg} kg per order</div></div>
          <div><div class="policy-metric-label">Surcharge Rate</div><div class="policy-metric-val">${peso(extraFee)} / extra kg</div></div>
          <div><div class="policy-metric-label">Weight Calculation</div><div class="policy-metric-val">Auto-computed from BOM</div></div>
          <div><div class="policy-metric-label">Manual Calculation</div><div class="policy-metric-val">0 manual steps</div></div>
        </div>
      </div>

      <div class="policy-card">
        <div class="policy-card-head">
          <div><div class="policy-card-title">Free Delivery Threshold</div><div class="faint">Customer shipping incentive</div></div>
          <span class="status-pill in">Active Rule</span>
        </div>
        <div class="policy-card-rule">Orders meeting the qualifying amount receive 100% automated delivery fee waiver at checkout without cashier intervention.</div>
        <div class="policy-card-metrics">
          <div><div class="policy-metric-label">Qualifying Amount</div><div class="policy-metric-val">${freeOver > 0 ? peso(freeOver) : 'Special Corporate Orders'}</div></div>
          <div><div class="policy-metric-label">Subsidy Method</div><div class="policy-metric-val">Automated fee waiver</div></div>
          <div><div class="policy-metric-label">Applicable Items</div><div class="policy-metric-val">All catalog products</div></div>
          <div><div class="policy-metric-label">Checkout Behavior</div><div class="policy-metric-val">Applied automatically</div></div>
        </div>
      </div>

      <div class="policy-card">
        <div class="policy-card-head">
          <div><div class="policy-card-title">Fulfillment SLA &amp; Transit Engine</div><div class="faint">Delivery arrival calculation</div></div>
          <span class="status-pill info">Automated SLA</span>
        </div>
        <div class="policy-card-rule">Arrival dates count working days only: Sundays and Philippine statutory holidays are automatically excluded from the calculation.</div>
        <div class="policy-card-metrics">
          <div><div class="policy-metric-label">Warehouse Packing SLA</div><div class="policy-metric-val">${pack} working day</div></div>
          <div><div class="policy-metric-label">Metro Manila Transit</div><div class="policy-metric-val">${tMetro} to ${tMetro + rDays} working days</div></div>
          <div><div class="policy-metric-label">Provincial Transit</div><div class="policy-metric-val">${tOther} to ${tOther + rDays} working days</div></div>
          <div><div class="policy-metric-label">Daily Cut-off Time</div><div class="policy-metric-val">3:00 PM cutoff rule</div></div>
        </div>
      </div>`;
  }

  // Toggle edit/view for settings
  const dsToggle = $s('dsToggleEdit');
  if (dsToggle) {
    dsToggle.addEventListener('click', () => {
      const v = $s('dsViewCards'), e = $s('dsEditWrapper');
      if (!v || !e) return;
      const showEdit = e.hidden;
      e.hidden = !showEdit;
      v.hidden = showEdit;
      dsToggle.textContent = showEdit ? 'View Active Policies' : 'Configure Parameters';
    });
  }

  const readS = () => { const o = {}; FIELDS.forEach((x) => { o[x[0]] = $s('ds_' + x[0]).value.replace(/[,s\u20B1]/g, ''); }); return o; };
  function example() {
    const v = readS(), free = Number(v.freeWeightKg), per = Number(v.perKgFee);
    if (![free, per].every(Number.isFinite) || v.freeWeightKg === '' || v.perKgFee === '') { $s('dsExample').textContent = ''; return; }
    const kg = Math.max(60, Math.ceil(free) + 40), extra = Math.max(0, Math.ceil(kg - free));
    $s('dsExample').innerHTML = per > 0 ? 'Example: a ' + kg + ' kg order pays the area rate + <b>' + extra + ' kg \u00D7 \u20B1' + per.toLocaleString('en-PH') + ' = ' + peso(extra * per) + '</b>.' : 'Weight charge is off: the fee is just the area rate.';
  }
  sp.addEventListener('input', () => { $s('dsMsg').textContent = ''; example(); });
  if (window.FormAssist) FIELDS.forEach(([key]) => {
    const max = { freeWeightKg: 100000, perKgFee: 10000, freeOverAmount: 10000000, packDays: 30, transitMetro: 60, transitOther: 60, rangeDays: 30 }[key];
    const whole = ['packDays', 'transitMetro', 'transitOther', 'rangeDays'].includes(key);
    FormAssist.validation.bind($s('ds_' + key), (value) => {
      const raw = window.MoneyInput ? MoneyInput.raw(value) : value, n = Number(raw);
      return raw === '' || !Number.isFinite(n) || n < 0 || n > max || (whole && !Number.isInteger(n)) || (!whole && Math.round(n * 100) / 100 !== n) ? 'Enter ' + (whole ? 'a whole number' : 'a number') + ' from 0 to ' + max.toLocaleString('en-US') + '.' : '';
    });
  });

  function fillS(d) {
    currentSettings = Object.assign({}, DEFAULT_SETTINGS, d || {});
    FIELDS.forEach((x) => {
      const val = currentSettings[x[0]];
      const el = $s('ds_' + x[0]);
      if (el) el.value = val != null ? val : '';
    });
    FIELDS.forEach(([key]) => { if (window.FormAssist) FormAssist.validation.show($s('ds_' + key), ''); });
    example();
    renderSettingsCards(currentSettings);
  }

  // Initial draw with defaults so cards/fields are NEVER blank
  fillS(DEFAULT_SETTINGS);

  $s('dsSave').onclick = async () => {
    const btn = $s('dsSave'), msg = $s('dsMsg'); msg.textContent = ''; btn.disabled = true;
    try {
      const saved = await sapi('PUT', readS());
      fillS(saved);
      toast('Delivery fee and arrival settings saved. New orders use them right away.');
    } catch (er) { msg.textContent = er.message; }
    btn.disabled = false;
  };

  sapi('GET').then(fillS).catch((er) => {
    if (er.status === 403) sp.remove();
    else $s('dsMsg').textContent = er.message;
  });
})();
