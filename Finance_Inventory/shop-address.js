/* shop-address.js — customer delivery address for the online shop checkout.

   What it does
   - Address book: the customer's saved addresses (GET/POST/PUT/DELETE /api/shop/addresses), one default.
   - Address form: house/unit/street/block/lot line + Region -> Province -> City/Municipality -> Barangay -> ZIP.
     The lists come from the PSGC API through our server (/api/geo/...). The ZIP is suggested from the chosen
     city / barangay (/api/geo/zip-suggest) and checked against it (/api/geo/check-zip).
   - ShopAddress.collect() returns what POST /api/shop/orders needs, or throws { message } after marking the bad field.
   The server repeats every check, so this file only makes mistakes easy to see and fix.
*/
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  function zipHint(text, ok){ const h = $('aeZipHint'); if (!h) return; h.textContent = text; h.classList.toggle('tick', !!ok); }
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const MAX_SAVED = 5;
  const F = ['recipient', 'phone', 'region', 'province', 'city', 'barangay', 'zip', 'line', 'landmark'];

  let cfg = null;                       // { api, esc, toast }
  let saved = [];                       // address book
  let selectedId = null;                // chosen saved address (null = the form below is being used)
  let editingId = null;                 // saved address being edited in the form (null = adding a new one)
  let formOpen = false;
  let hostId = 'addrBox';               // where the address book is drawn: the checkout box, or the My Profile tab (embedded)
  let embedded = false;
  const host = () => $(hostId);
  let regions = [], provinces = [], cities = [], barangays = [];
  let tokens = { prov: 0, city: 0, bgy: 0, zip: 0 };
  let zipState = { ok: null, key: '' }; // result of the last ZIP check
  let defaults = { name: '', phone: '' };

  const codeOf = (list, name) => { const n = clean(name).toLowerCase(); const m = list.find((x) => x.name.toLowerCase() === n); return m ? m.code : null; };
  const val = (id) => clean(($(id) || {}).value);
  const setErr = (field, msg) => {
    const el = $('ae_' + field), box = $('aeErr_' + field);
    if (el) { el.classList.toggle('is-bad', !!msg); el.setAttribute('aria-invalid', msg ? 'true' : 'false'); if (box) el.setAttribute('aria-describedby', box.id); }
    if (box) { box.textContent = msg || ''; box.setAttribute('aria-live', 'polite'); }
  };
  const clearErrs = () => F.forEach((f) => setErr(f, ''));
  const fullOf = (a) => [a.addressLine, a.barangay && (/^(brgy|barangay)/i.test(a.barangay) ? a.barangay : 'Brgy. ' + a.barangay), a.city, a.province, a.zip].filter(Boolean).join(', ');

  /* ---------------- rendering ---------------- */
  function cardHtml(a) {
    const e = cfg.esc;
    return `<div class="addr-card ${a.id === selectedId && !formOpen ? 'on' : ''}" data-addr-pick="${a.id}" role="radio" tabindex="0" aria-checked="${a.id === selectedId && !formOpen}">
      <span class="addr-radio" aria-hidden="true"></span>
      <div class="addr-body">
        <div class="addr-top"><b>${e(a.recipient)}</b><span class="chip-pill">${e(a.label)}</span>${a.isDefault ? '<span class="chip-pill ok">Default</span>' : ''}</div>
        <div class="addr-full">${e(a.fullAddress || fullOf(a))}</div>
        ${a.landmark ? `<div class="addr-sub">Landmark: ${e(a.landmark)}</div>` : ''}
        <div class="addr-sub mono">${e(a.phone)}</div>
        <div class="addr-actions">
          <button type="button" class="btn-ghost btn-sm" data-addr-edit="${a.id}">Edit</button>
          ${a.isDefault ? '' : `<button type="button" class="btn-ghost btn-sm" data-addr-default="${a.id}">Make default</button>`}
          <button type="button" class="btn-ghost btn-sm addr-del" data-addr-del="${a.id}">Delete</button>
        </div>
      </div></div>`;
  }

  function formHtml() {
    const adding = editingId == null;
    return `<div class="addr-form" id="addrForm">
      <div class="addr-form-head"><b>${adding ? (saved.length ? 'New delivery address' : 'Where should we deliver?') : 'Edit address'}</b>
        ${saved.length ? '<button type="button" class="btn-ghost btn-sm" data-addr-cancel>Cancel</button>' : ''}</div>
      <div class="field-grid">
        <div><label for="ae_recipient">Recipient name</label><input id="ae_recipient" autocomplete="name" maxlength="50" placeholder="Full name of who receives the order"><div class="err-text" id="aeErr_recipient"></div></div>
        <div><label for="ae_phone">Mobile number</label><input id="ae_phone" inputmode="tel" autocomplete="tel" maxlength="20" placeholder="0917 123 4567"><div class="err-text" id="aeErr_phone"></div></div>
      </div>
      <div class="field-grid">
        <div><label for="ae_region">Region</label><select id="ae_region"><option value="">Loading regions…</option></select><div class="err-text" id="aeErr_region"></div></div>
        <div><label for="ae_province">Province</label><select id="ae_province" disabled><option value="">Choose a region first</option></select><div class="err-text" id="aeErr_province"></div></div>
      </div>
      <div class="field-grid">
        <div><label for="ae_city">City / Municipality</label><input id="ae_city" list="ae_cityList" autocomplete="off" disabled placeholder="Choose a province first"><datalist id="ae_cityList"></datalist><div class="err-text" id="aeErr_city"></div></div>
        <div><label for="ae_barangay">Barangay</label><input id="ae_barangay" list="ae_bgyList" autocomplete="off" disabled placeholder="Choose a city first"><datalist id="ae_bgyList"></datalist><div class="err-text" id="aeErr_barangay"></div></div>
      </div>
      <div class="field-grid">
        <div><label for="ae_line">House / unit no., street, block, lot</label><input id="ae_line" autocomplete="address-line1" maxlength="150" placeholder="e.g. Blk 5 Lot 12 Sampaguita St., Villa Rosa Subd."><div class="err-text" id="aeErr_line"></div></div>
        <div><label for="ae_zip">ZIP code</label><input id="ae_zip" inputmode="numeric" maxlength="4" autocomplete="postal-code" placeholder="4 digits" disabled>
          <div class="zip-chips" id="aeZipChips"></div><div class="err-text" id="aeErr_zip"></div><div class="addr-hint" id="aeZipHint">Filled in for you once you choose the barangay.</div></div>
      </div>
      <label for="ae_landmark">Landmark / delivery note <span class="faint" style="text-transform:none;letter-spacing:0">(optional)</span></label>
      <input id="ae_landmark" maxlength="120" placeholder="e.g. Beside the blue gate, call on arrival"><div class="err-text" id="aeErr_landmark"></div>
      <label>Save as</label>
      <div class="addr-labels" role="radiogroup" aria-label="Address label">
        ${['Home', 'Work', 'Other'].map((l, i) => `<label class="addr-lbl"><input type="radio" name="aeLabel" value="${l}" ${i === 0 ? 'checked' : ''}>${l}</label>`).join('')}
      </div>
      <div class="addr-checks">
        ${adding && !embedded ? `<label class="switch"><input type="checkbox" id="ae_save" ${saved.length < MAX_SAVED ? 'checked' : 'disabled'}> Save to my address book${saved.length >= MAX_SAVED ? ` (full — ${MAX_SAVED} max)` : ''}</label>` : ''}
        <label class="switch"><input type="checkbox" id="ae_default" ${!saved.length ? 'checked' : ''}> Make this my default address</label>
      </div>
      ${adding && !embedded ? '' : `<div class="addr-form-actions"><button type="button" class="btn-primary" ${adding ? 'data-addr-saveadd' : 'data-addr-saveedit'}>${adding ? 'Save address' : 'Save changes'}</button><button type="button" class="btn-secondary" data-addr-cancel>Cancel</button></div><div class="err-text" id="aeFormErr"></div>`}
    </div>`;
  }

  function render() {
    const box = host(); if (!box) return;
    if (!saved.length) formOpen = true;
    box.innerHTML = (saved.length ? `<div class="addr-list" role="radiogroup" aria-label="Saved addresses">${saved.map(cardHtml).join('')}
      <div class="addr-card addr-new ${formOpen && editingId == null ? 'on' : ''}" data-addr-new role="radio" tabindex="0" aria-checked="${formOpen && editingId == null}">
        <span class="addr-radio" aria-hidden="true"></span><div class="addr-body"><b>${embedded ? '+ Add a new address' : '+ Deliver to a different address'}</b><div class="addr-sub">${saved.length >= MAX_SAVED ? 'Your address book is full — it will be used for this order only.' : 'Add a new address'}</div></div></div></div>` : '') +
      (formOpen ? formHtml() : '');
    if (formOpen) { bindForm(); fillForm(editingId == null ? null : saved.find((a) => a.id === editingId)); }
  }

  /* ---------------- form wiring ---------------- */
  function bindForm() {
    $('ae_region').onchange = onRegion;
    $('ae_province').onchange = onProvince;
    $('ae_city').addEventListener('change', onCity);
    $('ae_barangay').addEventListener('change', onBarangay);
    $('ae_zip').addEventListener('input', () => {
      const z = $('ae_zip'); const d = z.value.replace(/\D/g, '').slice(0, 4); if (d !== z.value) z.value = d;
      zipState = { ok: null, key: '' }; setErr('zip', ''); zipHint(''); markChips();
      if (d.length === 4) checkZip();
    });
    $('ae_phone').addEventListener('input', () => { const p = $('ae_phone'); const d = p.value.replace(/[^\d+\s]/g, ''); if (d !== p.value) p.value = d; });
    F.forEach((f) => { const el = $('ae_' + f); if (el) ['input', 'change', 'blur'].forEach((type) => el.addEventListener(type, () => validateForm(read(), f))); });
    loadRegions();
    // Task 9: typing the ZIP first fills Region > Province > City (> Barangay) from the ZIP list (form-assist.js)
    if (window.FormAssist) window.FormAssist.zipFill({ before: $('ae_region').closest('.field-grid'), region: $('ae_region'), province: $('ae_province'),
      city: $('ae_city'), barangay: $('ae_barangay'), zip: $('ae_zip'), api: cfg.api });
  }

  function setOptions(sel, rows, placeholder, { disabled = false } = {}) {
    sel.innerHTML = `<option value="">${cfg.esc(placeholder)}</option>` + rows.map((r) => `<option value="${cfg.esc(r.name)}" data-code="${cfg.esc(r.code)}">${cfg.esc(r.name)}</option>`).join('');
    sel.disabled = disabled;
  }
  const setList = (listId, rows) => { $(listId).innerHTML = rows.map((r) => `<option value="${cfg.esc(r.name)}"></option>`).join(''); };
  const setBox = (id, { value = '', disabled, placeholder }) => { const el = $(id); el.value = value; el.disabled = !!disabled; if (placeholder !== undefined) el.placeholder = placeholder; };
  const geo = async (path) => { try { return await cfg.api(path); } catch (e) { if (e instanceof TypeError) throw new Error('No connection to the server'); throw e; } };

  async function loadRegions() {
    const sel = $('ae_region');
    try {
      if (!regions.length) regions = await geo('/api/geo/regions');
      setOptions(sel, regions, 'Choose a region…');
    } catch (e) { sel.innerHTML = '<option value="">Could not load regions — pick again to retry</option>'; sel.onfocus = () => { sel.onfocus = null; loadRegions(); }; setErr('region', e.message); }
  }
  function resetBelow(level) {              // level: 'province' | 'city' | 'barangay' | 'zip'
    const order = ['province', 'city', 'barangay', 'zip'], from = order.indexOf(level);
    if (from <= 0) { provinces = []; setOptions($('ae_province'), [], 'Choose a region first', { disabled: true }); }
    if (from <= 1) { cities = []; setList('ae_cityList', []); setBox('ae_city', { disabled: true, placeholder: 'Choose a province first' }); }
    if (from <= 2) { barangays = []; setList('ae_bgyList', []); setBox('ae_barangay', { disabled: true, placeholder: 'Choose a city first' }); }
    zipState = { ok: null, key: '' }; tokens.zip++;
    setBox('ae_zip', { disabled: true, placeholder: '4 digits' }); $('aeZipChips').innerHTML = ''; zipHint('Filled in for you once you choose the barangay.'); setErr('zip', '');
  }

  async function onRegion() {
    resetBelow('province'); setErr('region', ''); setErr('province', '');
    cfg && cfg.onChange && cfg.onChange();                                       // the delivery fee depends on the region
    const reg = regions.find((r) => r.name === $('ae_region').value); if (!reg) return;
    const t = ++tokens.prov, psel = $('ae_province');
    setOptions(psel, [], 'Loading provinces…', { disabled: true });
    try {
      const rows = await geo('/api/geo/regions/' + encodeURIComponent(reg.code) + '/provinces');
      if (t !== tokens.prov) return;
      if (rows.length) { provinces = rows; setOptions(psel, rows, 'Choose a province…'); return; }
      provinces = [{ code: 'NCR', name: 'Metro Manila' }];                    // NCR has no provinces
      setOptions(psel, provinces, 'Metro Manila', { disabled: true }); psel.value = 'Metro Manila';
      cfg && cfg.onChange && cfg.onChange();
      await loadCities('/api/geo/regions/' + encodeURIComponent(reg.code) + '/cities');
    } catch (e) { if (t === tokens.prov) { setOptions(psel, [], 'Could not load — choose the region again', { disabled: true }); setErr('province', e.message); } }
  }
  async function onProvince() {
    resetBelow('city'); setErr('province', '');
    cfg && cfg.onChange && cfg.onChange();                                       // the delivery fee can differ by province
    const prov = provinces.find((p) => p.name === $('ae_province').value); if (!prov) return;
    await loadCities('/api/geo/provinces/' + encodeURIComponent(prov.code) + '/cities');
  }
  async function loadCities(path) {
    const t = ++tokens.city;
    setBox('ae_city', { disabled: true, placeholder: 'Loading cities…' });
    try {
      const rows = await geo(path); if (t !== tokens.city) return;
      cities = rows; setList('ae_cityList', rows); setBox('ae_city', { disabled: false, placeholder: 'Type to search city / municipality…' });
    } catch (e) { if (t === tokens.city) { setBox('ae_city', { disabled: true, placeholder: 'Could not load — choose the province again' }); setErr('city', e.message); } }
  }
  async function onCity() {
    resetBelow('barangay'); setErr('city', '');
    const name = val('ae_city'); if (!name) return;
    const city = cities.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!city) { if (cities.length) setErr('city', 'Pick your city / municipality from the list'); return; }
    $('ae_city').value = city.name;
    const t = ++tokens.bgy;
    setBox('ae_barangay', { disabled: true, placeholder: 'Loading barangays…' });
    try {
      const rows = await geo('/api/geo/cities/' + encodeURIComponent(city.code) + '/barangays'); if (t !== tokens.bgy) return;
      barangays = rows; setList('ae_bgyList', rows);
      setBox('ae_barangay', { disabled: false, placeholder: rows.length ? 'Type to search barangay…' : 'Type your barangay' });
    } catch (e) { if (t === tokens.bgy) setBox('ae_barangay', { disabled: false, placeholder: 'Type your barangay' }); }   // list unavailable: typed by hand, the server still checks it
    unlockZip(); suggestZip();
  }
  async function onBarangay() {
    setErr('barangay', '');
    const name = val('ae_barangay'); if (!name) return;
    const b = barangays.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (b) $('ae_barangay').value = b.name; else if (barangays.length) setErr('barangay', 'Pick your barangay from the list');
    suggestZip();
  }
  function unlockZip() { setBox('ae_zip', { value: $('ae_zip').value, disabled: false, placeholder: '4 digits' }); }

  /* ---------------- ZIP ---------------- */
  async function suggestZip() {
    const t = ++tokens.zip, city = val('ae_city'), prov = val('ae_province');
    if (!city || !prov) return;
    try {
      const q = `city=${encodeURIComponent(city)}&province=${encodeURIComponent(prov)}&barangay=${encodeURIComponent(val('ae_barangay'))}`;
      const r = await geo('/api/geo/zip-suggest?' + q); if (t !== tokens.zip) return;
      const zips = r.zips || [], z = $('ae_zip');
      $('aeZipChips').innerHTML = zips.length > 1 ? zips.map((x) => `<button type="button" class="zip-chip" data-zip="${cfg.esc(x)}">${cfg.esc(x)}</button>`).join('') : '';
      if (zips.length === 1 && !z.value) { z.value = zips[0]; checkZip(); }
      else if (zips.length > 1) { zipHint(z.value ? '' : 'This city has several ZIP codes — tap yours.'); if (z.value.length === 4) checkZip(); }
      else if (z.value.length === 4) checkZip();
      markChips();
    } catch (e) { /* suggestions are optional */ }
  }
  function markChips() { const z = val('ae_zip'); document.querySelectorAll('#aeZipChips .zip-chip').forEach((c) => c.classList.toggle('on', c.dataset.zip === z)); }
  async function checkZip() {
    const zip = val('ae_zip'), city = val('ae_city'), province = val('ae_province'), region = val('ae_region'), barangay = val('ae_barangay');
    if (!/^\d{4}$/.test(zip) || !city || !province) return;
    const key = [zip, city, province, barangay].join('|'), t = ++tokens.zip;
    zipHint('Checking ZIP code…');
    try {
      const r = await geo(`/api/geo/check-zip?zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&province=${encodeURIComponent(province)}&region=${encodeURIComponent(region)}&barangay=${encodeURIComponent(barangay)}`);
      if (t !== tokens.zip) return;
      if (r.ok) { zipState = { ok: true, key }; setErr('zip', ''); zipHint('ZIP code matches your city.', true); }
      else if (r.unknown) { zipState = { ok: null, key }; zipHint(''); }          // could not check: the server decides on submit
      else { zipState = { ok: false, key }; setErr('zip', r.message || 'ZIP code does not match this city'); zipHint(''); }
    } catch (e) { if (t === tokens.zip) zipHint(''); }
    markChips();
  }

  /* ---------------- fill / read the form ---------------- */
  async function fillForm(a) {
    $('ae_recipient').value = a ? a.recipient : defaults.name;
    $('ae_phone').value = a ? a.phone : defaults.phone;
    $('ae_line').value = a ? a.addressLine : ''; $('ae_landmark').value = a ? a.landmark : '';
    const lbl = document.querySelector(`input[name="aeLabel"][value="${a ? a.label : 'Home'}"]`); if (lbl) lbl.checked = true;
    if ($('ae_default')) $('ae_default').checked = a ? a.isDefault : !saved.length;
    if (!a) return;
    // walk the cascade so every list is loaded for the saved values
    await loadRegions(); $('ae_region').value = a.region;
    if ($('ae_region').value !== a.region) return;                                    // region name no longer in the list: customer picks again
    await onRegion(); if (provinces.length && provinces[0].code !== 'NCR') { $('ae_province').value = a.province; await onProvince(); }
    $('ae_city').value = a.city; await onCity();
    $('ae_barangay').value = a.barangay; $('ae_zip').value = a.zip; unlockZip(); suggestZip();
  }

  function read() {
    return { recipient: val('ae_recipient'), phone: val('ae_phone').replace(/[\s().-]/g, ''), region: val('ae_region'), province: val('ae_province'), city: val('ae_city'),
      barangay: val('ae_barangay'), zip: val('ae_zip'), addressLine: val('ae_line'), landmark: val('ae_landmark') };
  }
  // client-side check; returns true when every field is fine, otherwise marks them and focuses the first bad one
  function validateForm(s, only) {
    if (only) setErr(only, ''); else F.forEach((f) => setErr(f, '')); const bad = [];
    const need = (f, ok, msg) => { if ((!only || only === f) && !ok) { setErr(f, msg); bad.push(f); } };
    need('recipient', s.recipient.length >= 2 && s.recipient.length <= 50 && /^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(s.recipient), 'Enter the recipient’s full name (2–50 characters: letters, spaces, . \' and -)');
    need('phone', /^(\+63|0)9\d{9}$/.test(s.phone), 'Enter a valid mobile number, e.g. 0917 123 4567');
    need('region', !!s.region, 'Choose a region');
    need('province', !!s.province, 'Choose a province');
    need('city', !!s.city && (!cities.length || !!codeOf(cities, s.city)), s.city ? 'Pick your city / municipality from the list' : 'Choose a city / municipality');
    need('barangay', !!s.barangay && (!barangays.length || !!codeOf(barangays, s.barangay)), s.barangay ? 'Pick your barangay from the list' : 'Choose a barangay');
    need('line', s.addressLine.length >= 5 && /\p{L}/u.test(s.addressLine), 'Enter your house / unit no. and street, e.g. Blk 5 Lot 12 Sampaguita St.');
    need('zip', /^\d{4}$/.test(s.zip), 'Enter the 4-digit ZIP code');
    if ((!only || only === 'zip') && !bad.includes('zip') && zipState.ok === false && zipState.key === [s.zip, s.city, s.province, s.barangay].join('|')) { setErr('zip', $('aeErr_zip').textContent || 'ZIP code does not match this city'); bad.push('zip'); }
    if (!only && bad.length) { const el = $('ae_' + bad[0]); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); } }
    return !bad.length;
  }
  const label = () => (document.querySelector('input[name="aeLabel"]:checked') || {}).value || 'Home';
  const toBody = (s) => ({ recipient: s.recipient, region: s.region, province: s.province, city: s.city, barangay: s.barangay, zip: s.zip, addressLine: s.addressLine, landmark: s.landmark });
  function showServerFields(er) {
    const map = { recipient: 'recipient', phone: 'phone', region: 'region', province: 'province', city: 'city', barangay: 'barangay', zip: 'zip', addressLine: 'line', landmark: 'landmark' };
    let any = false; Object.keys(er.fields || {}).forEach((k) => { if (map[k]) { setErr(map[k], er.fields[k]); any = true; } });
    return any;
  }

  /* ---------------- address book actions ---------------- */
  async function refresh() {
    try { saved = await cfg.api('/api/shop/addresses'); } catch (e) { saved = []; }
    if (!saved.some((a) => a.id === selectedId)) selectedId = (saved.find((a) => a.isDefault) || saved[0] || {}).id || null;
    formOpen = !saved.length; editingId = null;
  }
  async function saveEdit() {
    const s = read(); if (!validateForm(s)) return;
    $('aeFormErr').textContent = '';
    try {
      const body = Object.assign(toBody(s), { phone: s.phone, label: label(), isDefault: $('ae_default').checked });
      await cfg.api('/api/shop/addresses/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
      selectedId = editingId; await refresh(); render(); cfg.toast('Address updated.');
    } catch (er) { if (!showServerFields(er)) $('aeFormErr').textContent = er.message; }
  }
  // My Profile: add a new address to the address book right away (at checkout it is saved together with the order)
  async function saveAdd() {
    const s = read(); if (!validateForm(s)) return;
    $('aeFormErr').textContent = '';
    try {
      const body = Object.assign(toBody(s), { phone: s.phone, label: label(), isDefault: $('ae_default').checked });
      await cfg.api('/api/shop/addresses', { method: 'POST', body: JSON.stringify(body) });
      await refresh(); render(); cfg.toast('Address saved.');
    } catch (er) { if (!showServerFields(er)) $('aeFormErr').textContent = er.message; }
  }
  async function act(d) {
    if (d.addrPick) { selectedId = Number(d.addrPick); formOpen = false; editingId = null; render(); cfg.onChange && cfg.onChange(); }
    else if (d.addrNew !== undefined) { selectedId = null; editingId = null; formOpen = true; render(); cfg.onChange && cfg.onChange(); }
    else if (d.addrEdit) { editingId = Number(d.addrEdit); selectedId = editingId; formOpen = true; render(); }
    else if (d.addrCancel !== undefined) { formOpen = !saved.length; editingId = null; if (!selectedId) selectedId = (saved.find((a) => a.isDefault) || saved[0] || {}).id || null; render(); }
    else if (d.addrSaveedit !== undefined) await saveEdit();
    else if (d.addrSaveadd !== undefined) await saveAdd();
    else if (d.addrDefault) { try { await cfg.api('/api/shop/addresses/' + d.addrDefault + '/default', { method: 'POST' }); await refresh(); render(); } catch (er) { cfg.toast(er.message, true); } }
    else if (d.addrDel) {
      if (!confirm('Delete this saved address?')) return;
      try { await cfg.api('/api/shop/addresses/' + d.addrDel, { method: 'DELETE' }); if (selectedId === Number(d.addrDel)) selectedId = null; await refresh(); render(); cfg.toast('Address deleted.'); cfg.onChange && cfg.onChange(); }
      catch (er) { cfg.toast(er.message, true); }
    } else if (d.zip) { $('ae_zip').value = d.zip; setErr('zip', ''); checkZip(); }
  }

  /* ---------------- public API ---------------- */
  window.ShopAddress = {
    init(options) {
      cfg = options;
      document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-addr-pick],[data-addr-new],[data-addr-edit],[data-addr-cancel],[data-addr-saveedit],[data-addr-saveadd],[data-addr-default],[data-addr-del],.zip-chip');
        if (!el || !host() || !host().contains(el)) return;
        e.preventDefault();
        act(el.matches('.zip-chip') ? { zip: el.dataset.zip } : Object.assign({}, el.dataset));
      });
      document.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.addr-card') && host() && host().contains(e.target)) { e.preventDefault(); e.target.click(); }
      });
    },
    setDefaults(d) { defaults = Object.assign(defaults, d); },
    async open() {                                      // call when the checkout page is shown
      hostId = 'addrBox'; embedded = false;
      const other = $('acctAddrBox'); if (other) other.innerHTML = '';
      await refresh(); render();
    },
    // My Profile > Delivery Addresses: draw the same address book into another box (the checkout box is emptied so ids never clash)
    async openIn(id) {
      hostId = id; embedded = true;
      const co = $('addrBox'); if (co) co.innerHTML = '';
      await refresh(); selectedId = null; render();
    },
    closeEmbedded() { if (embedded) { const b = host(); if (b) b.innerHTML = ''; hostId = 'addrBox'; embedded = false; } },
    // true when the customer picked a saved address
    usingSaved() { return !formOpen && saved.some((a) => a.id === selectedId); },
    phone() { if (this.usingSaved()) return saved.find((a) => a.id === selectedId).phone; return formOpen ? read().phone : ''; },
    // where the order would be delivered: { region, province } of the chosen saved address or of the form (empty strings until chosen)
    place() {
      if (this.usingSaved()) { const a = saved.find((x) => x.id === selectedId); return { region: a.region || '', province: a.province || '' }; }
      return formOpen ? { region: val('ae_region'), province: val('ae_province') } : { region: '', province: '' };
    },
    summary() { const a = saved.find((x) => x.id === selectedId); return a ? { recipient: a.recipient, phone: a.phone, full: a.fullAddress || fullOf(a) } : null; },
    /* Returns { shipTo, phone, saveAddress, addressLabel, makeDefault } for POST /api/shop/orders, or throws { message }. */
    collect() {
      if (this.usingSaved()) {
        const a = saved.find((x) => x.id === selectedId);
        return { phone: a.phone, shipTo: toBody(a), saveAddress: false };
      }
      if (!formOpen) throw { message: 'Choose a delivery address.' };
      if (editingId != null) throw { message: 'Save or cancel your address changes first.' };
      const s = read(); if (!validateForm(s)) throw { message: 'Please fix the highlighted address fields.' };
      const save = !!($('ae_save') && $('ae_save').checked);
      return { phone: s.phone, shipTo: toBody(s), saveAddress: save, addressLabel: label(), makeDefault: save && $('ae_default').checked };
    },
    showServerErrors(er) { return formOpen ? showServerFields(er) : false; },
    async reload() { await refresh(); render(); }
  };
})();
