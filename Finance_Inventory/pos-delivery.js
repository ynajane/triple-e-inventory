/* pos-delivery.js — Delivery mode for the POS counter (cashier).

   The cashier switches the sale to "Delivery" and fills in the same structured address the online shop uses:
     house / unit / street / block / lot  +  Region > Province > City / Municipality > Barangay  +  ZIP  (+ optional landmark)
   The lists come from the PSGC API through our server (/api/geo/...), the ZIP is suggested from the city / barangay and
   checked against it, and the address is written exactly like the shop writes it:  "line, Brgy. X, City, Province, ZIP".
   The delivery fee is looked up by region / province (/api/pos/delivery-fee) from the same rates Finance manages for the shop.
   The customer's name and mobile number are typed in the "Customer details" boxes of the sale; with Delivery they are required and
   they become the customer record in Finance > Customer Management > Walk-in Customers.
   The server repeats every check; this file only makes mistakes easy to see and fix.

   API:  PosDelivery.init({ api, esc, toast, onChange })      once, with the page's helpers
         PosDelivery.mount(hostElement)                       draws the form (call once)
         PosDelivery.collect()  -> shipTo object, or throws { message } after marking the bad fields
         PosDelivery.fee()      -> delivery fee in pesos (0 until a region / province is chosen)
         PosDelivery.feeState() -> { known, available, rate }
         PosDelivery.reset()    clears the form
*/
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const val = (id) => clean(($(id) || {}).value);
  let cfg = null, mounted = false;
  let regions = [], provinces = [], cities = [], barangays = [];
  const tokens = { prov: 0, city: 0, bgy: 0, zip: 0, fee: 0 };
  let zipState = { ok: null, key: '' };
  let quote = { known: false, available: true, fee: 0, rate: '' };
  const F = ['region', 'province', 'city', 'barangay', 'line', 'zip', 'landmark'];

  const codeOf = (list, name) => { const n = clean(name).toLowerCase(); const m = list.find((x) => x.name.toLowerCase() === n); return m ? m.code : null; };
  const setErr = (f, msg) => { const el = $('pd_' + f), box = $('pdErr_' + f); if (el) { el.classList.toggle('is-bad', !!msg); el.setAttribute('aria-invalid', msg ? 'true' : 'false'); if (box) el.setAttribute('aria-describedby', box.id); } if (box) { box.textContent = msg || ''; box.setAttribute('aria-live', 'polite'); } };
  const zipHint = (t, ok) => { const h = $('pdZipHint'); if (h) { h.textContent = t; h.classList.toggle('tick', !!ok); } };
  const geo = async (path) => { try { return await cfg.api(path); } catch (e) { if (e instanceof TypeError) throw new Error('No connection to the server'); throw e; } };
  // same wording as the shop: "line, Brgy. X, City, Province, ZIP"
  const written = (s) => [s.addressLine, s.barangay && (/^(brgy|barangay)/i.test(s.barangay) ? s.barangay : 'Brgy. ' + s.barangay), s.city, s.province, s.zip].filter(Boolean).join(', ');

  function html() {
    return `<div class="dlv-box" id="pdForm">
      <div class="dlv-grid">
        <div><label for="pd_region">Region</label><select id="pd_region"><option value="">Loading regions…</option></select><div class="err-text" id="pdErr_region"></div></div>
        <div><label for="pd_province">Province</label><select id="pd_province" disabled><option value="">Choose a region first</option></select><div class="err-text" id="pdErr_province"></div></div>
        <div><label for="pd_city">City / Municipality</label><input id="pd_city" list="pd_cityList" autocomplete="off" disabled placeholder="Choose a province first"><datalist id="pd_cityList"></datalist><div class="err-text" id="pdErr_city"></div></div>
        <div><label for="pd_barangay">Barangay</label><input id="pd_barangay" list="pd_bgyList" autocomplete="off" disabled placeholder="Choose a city first"><datalist id="pd_bgyList"></datalist><div class="err-text" id="pdErr_barangay"></div></div>
      </div>
      <label for="pd_line">House / unit no., street, block, lot</label>
      <input id="pd_line" autocomplete="off" maxlength="150" placeholder="e.g. Blk 5 Lot 12 Sampaguita St., Villa Rosa Subd."><div class="err-text" id="pdErr_line"></div>
      <label for="pd_zip">ZIP code</label>
      <input id="pd_zip" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits" disabled>
      <div class="zip-chips" id="pdZipChips"></div><div class="err-text" id="pdErr_zip"></div><div class="dlv-hint" id="pdZipHint">Filled in for you once you choose the barangay.</div>
      <label for="pd_landmark">Landmark / delivery note <span class="faint" style="text-transform:none;letter-spacing:0">(optional)</span></label>
      <input id="pd_landmark" maxlength="120" autocomplete="off" placeholder="e.g. Beside the blue gate, call on arrival"><div class="err-text" id="pdErr_landmark"></div>
      <div class="dlv-preview" id="pdPreview" hidden></div>
      <div class="dlv-fee" id="pdFee" hidden></div>
    </div>`;
  }

  function mount(host) {
    if (!host) return;
    host.innerHTML = html(); mounted = true;
    $('pd_region').onchange = onRegion;
    $('pd_province').onchange = onProvince;
    $('pd_city').addEventListener('change', onCity);
    $('pd_barangay').addEventListener('change', onBarangay);
    $('pd_zip').addEventListener('input', () => {
      const z = $('pd_zip'), d = z.value.replace(/\D/g, '').slice(0, 4); if (d !== z.value) z.value = d;
      zipState = { ok: null, key: '' }; setErr('zip', ''); zipHint(''); markChips(); preview(); if (d.length === 4) checkZip();
    });
    ['line', 'landmark'].forEach((f) => $('pd_' + f).addEventListener('input', () => { setErr(f, ''); preview(); }));
    $('pdZipChips').addEventListener('click', (e) => { const b = e.target.closest('.zip-chip'); if (!b) return; $('pd_zip').value = b.dataset.zip; setErr('zip', ''); preview(); checkZip(); });
    F.forEach((f) => ['input', 'change', 'blur'].forEach((type) => $('pd_' + f).addEventListener(type, () => validate(read(), f))));
    loadRegions();
    // Task 9: typing the ZIP first fills Region > Province > City (> Barangay) from the ZIP list (form-assist.js)
    if (window.FormAssist) window.FormAssist.zipFill({ before: $('pd_region').closest('.dlv-grid'), region: $('pd_region'), province: $('pd_province'),
      city: $('pd_city'), barangay: $('pd_barangay'), zip: $('pd_zip') });
  }

  const setOptions = (sel, rows, placeholder, disabled) => {
    sel.innerHTML = `<option value="">${cfg.esc(placeholder)}</option>` + rows.map((r) => `<option value="${cfg.esc(r.name)}">${cfg.esc(r.name)}</option>`).join('');
    sel.disabled = !!disabled;
  };
  const setList = (id, rows) => { $(id).innerHTML = rows.map((r) => `<option value="${cfg.esc(r.name)}"></option>`).join(''); };
  const setBox = (id, o) => { const el = $(id); el.value = o.value || ''; el.disabled = !!o.disabled; if (o.placeholder !== undefined) el.placeholder = o.placeholder; };

  async function loadRegions() {
    const sel = $('pd_region'); if (!sel) return;
    try { if (!regions.length) regions = await geo('/api/geo/regions'); const keep = sel.value; setOptions(sel, regions, 'Choose a region…'); sel.value = keep; }
    catch (e) { sel.innerHTML = '<option value="">Could not load regions — tap here to try again</option>'; sel.onfocus = () => { sel.onfocus = null; loadRegions(); }; setErr('region', e.message); }
  }
  function resetBelow(level) {
    const order = ['province', 'city', 'barangay'], from = order.indexOf(level);
    if (from <= 0) { provinces = []; setOptions($('pd_province'), [], 'Choose a region first', true); }
    if (from <= 1) { cities = []; setList('pd_cityList', []); setBox('pd_city', { disabled: true, placeholder: 'Choose a province first' }); }
    barangays = []; setList('pd_bgyList', []); setBox('pd_barangay', { disabled: true, placeholder: 'Choose a city first' });
    zipState = { ok: null, key: '' }; tokens.zip++;
    setBox('pd_zip', { disabled: true, placeholder: '4 digits' }); $('pdZipChips').innerHTML = ''; zipHint('Filled in for you once you choose the barangay.'); setErr('zip', '');
    preview();
  }

  async function onRegion() {
    resetBelow('province'); setErr('region', ''); setErr('province', '');
    quoteFee();
    const reg = regions.find((r) => r.name === $('pd_region').value); if (!reg) return;
    const t = ++tokens.prov, psel = $('pd_province');
    setOptions(psel, [], 'Loading provinces…', true);
    try {
      const rows = await geo('/api/geo/regions/' + encodeURIComponent(reg.code) + '/provinces'); if (t !== tokens.prov) return;
      if (rows.length) { provinces = rows; setOptions(psel, rows, 'Choose a province…'); return; }
      provinces = [{ code: 'NCR', name: 'Metro Manila' }];                         // NCR has no provinces
      setOptions(psel, provinces, 'Metro Manila', true); psel.value = 'Metro Manila'; quoteFee();
      await loadCities('/api/geo/regions/' + encodeURIComponent(reg.code) + '/cities');
    } catch (e) { if (t === tokens.prov) { setOptions(psel, [], 'Could not load — choose the region again', true); setErr('province', e.message); } }
  }
  async function onProvince() {
    resetBelow('city'); setErr('province', ''); quoteFee();                        // the fee can differ by province
    const prov = provinces.find((p) => p.name === $('pd_province').value); if (!prov) return;
    await loadCities('/api/geo/provinces/' + encodeURIComponent(prov.code) + '/cities');
  }
  async function loadCities(path) {
    const t = ++tokens.city; setBox('pd_city', { disabled: true, placeholder: 'Loading cities…' });
    try { const rows = await geo(path); if (t !== tokens.city) return; cities = rows; setList('pd_cityList', rows); setBox('pd_city', { disabled: false, placeholder: 'Type to search city / municipality…' }); }
    catch (e) { if (t === tokens.city) { setBox('pd_city', { disabled: true, placeholder: 'Could not load — choose the province again' }); setErr('city', e.message); } }
  }
  async function onCity() {
    resetBelow('barangay'); setErr('city', '');
    const name = val('pd_city'); if (!name) return;
    const city = cities.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!city) { if (cities.length) setErr('city', 'Pick the city / municipality from the list'); return; }
    $('pd_city').value = city.name;
    const t = ++tokens.bgy; setBox('pd_barangay', { disabled: true, placeholder: 'Loading barangays…' });
    try {
      const rows = await geo('/api/geo/cities/' + encodeURIComponent(city.code) + '/barangays'); if (t !== tokens.bgy) return;
      barangays = rows; setList('pd_bgyList', rows); setBox('pd_barangay', { disabled: false, placeholder: rows.length ? 'Type to search barangay…' : 'Type the barangay' });
    } catch (e) { if (t === tokens.bgy) setBox('pd_barangay', { disabled: false, placeholder: 'Type the barangay' }); }   // list unavailable: typed by hand, the server still checks it
    setBox('pd_zip', { value: $('pd_zip').value, disabled: false, placeholder: '4 digits' }); suggestZip(); preview();
  }
  function onBarangay() {
    setErr('barangay', '');
    const name = val('pd_barangay'); if (!name) return;
    const b = barangays.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (b) $('pd_barangay').value = b.name; else if (barangays.length) setErr('barangay', 'Pick the barangay from the list');
    suggestZip(); preview();
  }

  /* ---------------- ZIP ---------------- */
  async function suggestZip() {
    const t = ++tokens.zip, city = val('pd_city'), prov = val('pd_province'); if (!city || !prov) return;
    try {
      const r = await geo(`/api/geo/zip-suggest?city=${encodeURIComponent(city)}&province=${encodeURIComponent(prov)}&barangay=${encodeURIComponent(val('pd_barangay'))}`); if (t !== tokens.zip) return;
      const zips = r.zips || [], z = $('pd_zip');
      $('pdZipChips').innerHTML = zips.length > 1 ? zips.map((x) => `<button type="button" class="zip-chip" data-zip="${cfg.esc(x)}">${cfg.esc(x)}</button>`).join('') : '';
      if (zips.length === 1 && !z.value) { z.value = zips[0]; checkZip(); }
      else if (zips.length > 1) { zipHint(z.value ? '' : 'This city has several ZIP codes — tap the right one.'); if (z.value.length === 4) checkZip(); }
      else if (z.value.length === 4) checkZip();
      markChips(); preview();
    } catch (e) { /* suggestions are optional */ }
  }
  const markChips = () => { const z = val('pd_zip'); document.querySelectorAll('#pdZipChips .zip-chip').forEach((c) => c.classList.toggle('on', c.dataset.zip === z)); };
  async function checkZip() {
    const zip = val('pd_zip'), city = val('pd_city'), province = val('pd_province'), region = val('pd_region'), barangay = val('pd_barangay');
    if (!/^\d{4}$/.test(zip) || !city || !province) return;
    const key = [zip, city, province, barangay].join('|'), t = ++tokens.zip; zipHint('Checking ZIP code…');
    try {
      const r = await geo(`/api/geo/check-zip?zip=${encodeURIComponent(zip)}&city=${encodeURIComponent(city)}&province=${encodeURIComponent(province)}&region=${encodeURIComponent(region)}&barangay=${encodeURIComponent(barangay)}`); if (t !== tokens.zip) return;
      if (r.ok) { zipState = { ok: true, key }; setErr('zip', ''); zipHint('ZIP code matches the city.', true); }
      else if (r.unknown) { zipState = { ok: null, key }; zipHint(''); }
      else { zipState = { ok: false, key }; setErr('zip', r.message || 'ZIP code does not match this city'); zipHint(''); }
    } catch (e) { if (t === tokens.zip) zipHint(''); }
    markChips();
  }

  /* ---------------- fee + preview ---------------- */
  function preview() {
    const box = $('pdPreview'); if (!box) return;
    const s = read(); const any = s.addressLine || s.barangay || s.city;
    box.hidden = !any; if (any) box.innerHTML = '<span class="faint">Will be written as:</span> ' + cfg.esc(written(s)) + (s.landmark ? ' <span class="faint">(Landmark: ' + cfg.esc(s.landmark) + ')</span>' : '');
  }
  // the cart as SKU:qty,SKU:qty - the server adds a weight charge for heavy orders, so the fee depends on what is being sold
  const itemsParam = () => (cfg && cfg.items ? cfg.items().map((i) => i.sku + ':' + i.qty).join(',') : '');
  let lastSig = '';
  async function quoteFee() {
    lastSig = itemsParam();
    const region = val('pd_region'), province = val('pd_province'), t = ++tokens.fee, box = $('pdFee');
    if (!region && !province) { quote = { known: false, available: true, fee: 0, rate: '' }; if (box) box.hidden = true; cfg.onChange && cfg.onChange(); return; }
    try {
      const q = await cfg.api(`/api/pos/delivery-fee?region=${encodeURIComponent(region)}&province=${encodeURIComponent(province)}&items=${encodeURIComponent(lastSig)}`); if (t !== tokens.fee) return;
      quote = { known: true, available: q.available !== false, fee: +q.fee || 0, rate: q.rate || '', eta: q.eta ? q.eta.text : '', weightCharge: +q.weightCharge || 0, weightKg: +q.weightKg || 0 };
    } catch (e) { if (t === tokens.fee) quote = { known: false, available: true, fee: 0, rate: '' }; }
    if (box) {
      box.hidden = !quote.known;
      box.innerHTML = quote.available ? 'Delivery fee for this area: <b>₱' + Number(quote.fee).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</b>' + (quote.weightCharge > 0 ? ' <span class="faint">(includes ₱' + Number(quote.weightCharge).toLocaleString('en-PH', { minimumFractionDigits: 2 }) + ' for ' + quote.weightKg + ' kg)</span>' : '') + (quote.eta ? '<br>Estimated arrival: <b>' + cfg.esc(quote.eta) + '</b>' : '') : '<b>We do not deliver to this area yet.</b> Choose another address or switch the sale to Pickup.';
      box.classList.toggle('bad', !quote.available);
    }
    cfg.onChange && cfg.onChange();
  }

  /* ---------------- read / validate ---------------- */
  function read() {
    return { region: val('pd_region'), province: val('pd_province'), city: val('pd_city'), barangay: val('pd_barangay'), zip: val('pd_zip'), addressLine: val('pd_line'), landmark: val('pd_landmark') };
  }
  function validate(s, only) {
    if (only) setErr(only, ''); else F.forEach((f) => setErr(f, '')); const bad = [];
    const need = (f, ok, msg) => { if ((!only || only === f) && !ok) { setErr(f, msg); bad.push(f); } };
    need('region', !!s.region, 'Choose a region');
    need('province', !!s.province, 'Choose a province');
    need('city', !!s.city && (!cities.length || !!codeOf(cities, s.city)), s.city ? 'Pick the city / municipality from the list' : 'Choose a city / municipality');
    need('barangay', !!s.barangay && (!barangays.length || !!codeOf(barangays, s.barangay)), s.barangay ? 'Pick the barangay from the list' : 'Choose a barangay');
    need('line', s.addressLine.length >= 5 && /\p{L}/u.test(s.addressLine) && /^[\p{L}\p{M}\p{N}\s.,#\/'’&()°-]+$/u.test(s.addressLine), /^[\p{L}\p{M}\p{N}\s.,#\/'’&()°-]+$/u.test(s.addressLine) ? 'Enter the house / unit no. and street, e.g. Blk 5 Lot 12 Sampaguita St.' : "House / unit no. and street can only have letters, numbers, spaces and . , # / - ( ) & '");
    need('zip', /^\d{4}$/.test(s.zip), 'Enter the 4-digit ZIP code');
    if ((!only || only === 'zip') && !bad.includes('zip') && zipState.ok === false && zipState.key === [s.zip, s.city, s.province, s.barangay].join('|')) { setErr('zip', $('pdErr_zip').textContent || 'ZIP code does not match this city'); bad.push('zip'); }
    if (!only && bad.length) { const el = $('pd_' + bad[0]); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); } }
    return !bad.length;
  }
  function collect() {
    if (!mounted) throw { message: 'The delivery form is not ready. Refresh the page.' };
    const s = read(); if (!validate(s)) throw { message: 'Please fix the highlighted delivery address fields.' };
    if (!quote.known) throw { message: 'The delivery fee could not be checked. Check the connection and re-select the region.' };
    if (!quote.available) throw { message: 'We do not deliver to this area yet. Choose another address or switch the sale to Pickup.' };
    return s;
  }
  function reset() {
    if (!mounted) return;
    ['pd_line', 'pd_landmark', 'pd_zip'].forEach((id) => { $(id).value = ''; });
    $('pd_region').value = ''; resetBelow('province'); F.forEach((f) => setErr(f, ''));
    quote = { known: false, available: true, fee: 0, rate: '' }; const b = $('pdFee'); if (b) b.hidden = true; preview();
  }
  // show a server message under the matching field (the page passes er.fields when it has them)
  function showServerErrors(fields) {
    let any = false; const map = { region: 'region', province: 'province', city: 'city', barangay: 'barangay', zip: 'zip', addressLine: 'line', landmark: 'landmark' };
    Object.keys(fields || {}).forEach((k) => { if (map[k]) { setErr(map[k], fields[k]); any = true; } });
    return any;
  }

  const st = document.createElement('style');
  st.textContent = '.dlv-box{margin-top:10px;padding:12px;border:1px solid var(--border,#2a2f3a);border-radius:10px}' +
    '.dlv-box label{display:block;margin:8px 0 4px;font-size:12.5px;font-weight:600;color:var(--text-dim)}' +
    '.dlv-box input,.dlv-box select{width:100%;box-sizing:border-box}' +
    '.dlv-grid{display:grid;grid-template-columns:1fr;gap:0}.dlv-box select{text-overflow:ellipsis}' +   // one column: the counter's side panel is too narrow for two, and it cut the text off
    
    '.dlv-box .is-bad{border-color:var(--red,#e35b5b)!important;box-shadow:0 0 0 3px rgba(227,91,91,.14)}' +
    '.dlv-box .err-text{min-height:0;margin-top:4px;font-size:12.5px;color:var(--red,#e35b5b)}.dlv-box .err-text:empty{display:none}' +
    '.dlv-hint{font-size:12.5px;margin-top:4px;color:var(--text-faint,#8b93a1)}.dlv-hint.tick{color:var(--green,#3fb27f)}' +
    '.zip-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}.zip-chip{padding:4px 10px;border-radius:999px;border:1px solid var(--border,#2a2f3a);background:transparent;color:inherit;cursor:pointer}.zip-chip.on{background:var(--accent,#d4a24c);color:#111}' +
    '.dlv-preview{margin-top:10px;font-size:12.5px;line-height:1.45}.dlv-fee{margin-top:8px;font-size:13.5px}.dlv-fee.bad{color:var(--red,#e35b5b)}';
  document.head.appendChild(st);

  window.PosDelivery = {
    init(o) { cfg = o; }, mount, collect, reset, showServerErrors,
    // the cart changed: ask for the fee again (only when the items really differ, so the page's re-draw cannot loop)
    refresh() { if (!mounted || !cfg || itemsParam() === lastSig) return; if (val('pd_region') || val('pd_province')) quoteFee(); else lastSig = itemsParam(); },
    fee() { return quote.known && quote.available ? quote.fee : 0; },
    feeState() { return { known: quote.known, available: quote.available, rate: quote.rate }; }
  };
})();

/* house / unit field: drop characters an address cannot have (emoji, < > { } ; = etc.) as they are typed */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && ['pd_line'].includes(t.id)) { const c = t.value.replace(/[^\p{L}\p{M}\p{N}\s.,#\/'’&()°-]/gu, ''); if (c !== t.value) t.value = c; }
});
