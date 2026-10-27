/* quote-rules.test.js — the "do the details match?" rules of a quotation request.
     0. only what Triple E makes can be quoted: die-cast aluminum (ADC12 / A380) and forged brass (C37700 / C36000)
     1. a custom item says what KIND it is (die-cast part / forged part / fitting or valve); material, size, thickness, unit and secondary work must fit that kind
     2. the chosen MATERIAL decides which finish / wall thickness are allowed
     3. finished goods (catalog products) are sold by pcs: the quote is in the product's unit, and the product form only accepts pcs
   Runs the real shop-extras.js over HTTP against test/desk-browser-harness.js (in-memory SQL double).   node test/quote-rules.test.js */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const PORT = Number(process.env.HARNESS_PORT || 8911), BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };

async function start() {
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(PORT)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const err = []; child.stderr.on('data', (b) => err.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { if ((await fetch(BASE + '/api/shop/info')).ok) return child; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('harness did not start: ' + err.join(''));
}
async function call(role, method, p, body) {
  await fetch(BASE + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const post = (b) => call('cashier', 'POST', '/api/pos/quotes', Object.assign({ contactName: 'Walk-in Buyer', phone: '0917 123 4567', fulfillment: 'Pickup', flexibleDate: true }, b));
const custom = (over, specs) => Object.assign({ productName: 'Custom die-cast housing', itemType: 'Die-cast part', quantity: 500, quantityUnit: 'pcs',
  specs: Object.assign({ material: 'Aluminum ADC12', size: '100 x 60 x 40 mm', thickness: '2.5 mm', finish: 'Powder Coated', service: 'CNC machining' }, specs || {}) }, over || {});
const forged = (specs, over) => custom(Object.assign({ productName: 'Custom forged part', itemType: 'Forged part' }, over),
  Object.assign({ material: 'Brass C37700', size: '80 x 40 x 25 mm', thickness: 'Not applicable', finish: 'Nickel Plated', service: 'Threading (BSP / NPT)' }, specs));
const fitting = (specs, over) => custom(Object.assign({ productName: 'Brass elbow', itemType: 'Fitting / valve' }, over),
  Object.assign({ material: 'Brass C36000', size: '3/4"', thickness: 'Not applicable', finish: 'Polished', service: 'Threading (BSP / NPT)' }, specs));
const fieldOf = (r) => (r.body && r.body.fields ? Object.keys(r.body.fields)[0] : null);
const msgOf = (r) => (r.body && (r.body.fields ? Object.values(r.body.fields)[0] : r.body.error)) || '';

async function main() {
  const child = await start();
  try {
    console.log('\n1. the form downloads the rules (one table for page and server)');
    const o = (await call('cashier', 'GET', '/api/pos/quote-options')).body;
    ok('three kinds of item are offered: die-cast, forged, fitting / valve', JSON.stringify(o.itemTypes) === '["Die-cast part","Forged part","Fitting / valve"]', o.itemTypes);
    ok('only aluminum and forged brass materials exist (no stainless, steel, copper...)', o.material.every((m) => /^(Aluminum|Brass) |^Not sure/.test(m)) && o.material.length === 5, o.material);
    ok('a die-cast part only offers aluminum', JSON.stringify(Object.keys(o.matrix['Die-cast part'])) === JSON.stringify(['', 'Aluminum ADC12', 'Aluminum A380', 'Not sure (advise me)']), Object.keys(o.matrix['Die-cast part']));
    ok('a forged part and a fitting only offer brass', ['Forged part', 'Fitting / valve'].every((t) => JSON.stringify(Object.keys(o.matrix[t])) === JSON.stringify(['', 'Brass C37700', 'Brass C36000', 'Not sure (advise me)'])));
    ok('a die-cast part offers size ranges, and exact dimensions can be typed', o.matrix['Die-cast part']['Aluminum ADC12'].size.length === 4 && o.itemRules['Die-cast part'].typed === 'part');
    ok('a size range is accepted for a part', (await post(custom({}, { size: o.itemRules['Die-cast part'].sizes[1] }))).status === 201);
    ok('a part size range is not a fitting size', (await post(fitting({ size: o.itemRules['Die-cast part'].sizes[1] }))).status === 400);
    ok('a fitting offers pipe sizes 1/4" to 2" only', JSON.stringify(o.matrix['Fitting / valve']['Brass C37700'].size) === JSON.stringify(['1/4"', '3/8"', '1/2"', '3/4"', '1"', '1-1/4"', '1-1/2"', '2"']), o.matrix['Fitting / valve']['Brass C37700'].size);
    ok('a fitting has no thickness and only fitting-type secondary work', JSON.stringify(o.matrix['Fitting / valve']['Brass C37700'].thickness) === '["Not applicable"]' && JSON.stringify(o.matrix['Fitting / valve']['Brass C37700'].service) === '["None (as is)","Deburring","Drilling / tapping","Threading (BSP / NPT)"]', o.matrix['Fitting / valve']['Brass C37700']);
    ok('aluminum is not offered chrome / nickel plating or brushing', ['Chrome Plated', 'Nickel Plated', 'Satin / Brushed'].every((f) => !o.matrix['Die-cast part']['Aluminum A380'].finish.includes(f)), o.matrix['Die-cast part']['Aluminum A380'].finish);
    ok('brass is not offered powder coating, painting or shot blasting', ['Powder Coated', 'Painted', 'Shot Blasted'].every((f) => !o.matrix['Forged part']['Brass C37700'].finish.includes(f)), o.matrix['Forged part']['Brass C37700'].finish);
    ok('"Not sure (advise me)" keeps every finish of that item type, no more', JSON.stringify(o.matrix['Die-cast part']['Not sure (advise me)'].finish) === JSON.stringify(o.matrix['Die-cast part'][''].finish) && o.matrix['Die-cast part']['Not sure (advise me)'].finish.includes('Powder Coated') && !o.matrix['Die-cast part']['Not sure (advise me)'].finish.includes('Chrome Plated'));
    ok('every item type has a default unit that it also allows, in whole pieces', o.itemTypes.every((t) => o.itemRules[t].units.includes(o.itemRules[t].unit)) && o.decimalUnits.length === 0 && o.units.join() === 'pcs,sets,boxes', o.units);
    ok('a typed wall thickness has a range per material', o.thicknessLimits['Aluminum ADC12'].max === 8 && o.thicknessLimits['Brass C37700'].max === 20 && !!o.thicknessLimits[''], o.thicknessLimits);

    console.log('\n2. a correct custom request is accepted and remembers its item type');
    const good = await post(custom());
    ok('die-cast part / ADC12 / 100 x 60 x 40 mm / 2.5 mm wall / powder coated / CNC machining, 500 pcs', good.status === 201, good.body);
    ok('the quantity is saved with its unit', good.body && good.body.quantity === '500 pcs', good.body && good.body.quantity);
    ok('the details start with the item type', good.body && /^Item type: Die-cast part\nMaterial: Aluminum ADC12/.test(good.body.details) && /Machining \/ secondary work: CNC machining/.test(good.body.details), good.body && good.body.details);
    ok('a round part is typed with a diameter', (await post(custom({}, { size: 'Ø50 mm' }))).status === 201);
    ok('dimensions can be typed in cm or inches too', (await post(custom({}, { size: '12 x 6 cm' }))).status === 201 && (await post(custom({}, { size: '4 x 2 x 1 in' }))).status === 201);
    ok('a typed wall thickness inside the range is accepted', (await post(custom({}, { thickness: '2.2 mm' }))).status === 201);
    ok('wall thickness is optional on a die-cast part', (await post(custom({}, { thickness: 'Not applicable' }))).status === 201);
    ok('a forged brass part with nickel plating and threading', (await post(forged())).status === 201);
    ok('a forged brass part can be chrome plated and sold by the set', (await post(forged({ finish: 'Chrome Plated' }, { quantityUnit: 'sets' }))).status === 201);
    ok('a fitting by the piece', (await post(fitting())).status === 201);
    ok('a fitting by the box, with a typed pipe size', (await post(fitting({ size: '1 inch' }, { quantityUnit: 'boxes' }))).status === 201);
    ok('"Not sure (advise me)" is allowed as the material', (await post(custom({}, { material: 'Not sure (advise me)' }))).status === 201);

    console.log('\n3. the item type has to match the material, size, thickness, unit and secondary work');
    let r = await post(custom({ itemType: undefined }));
    ok('a custom item without an item type is refused', r.status === 400 && fieldOf(r) === 'itemType', r.body);
    r = await post(custom({ itemType: 'Sheet / plate' }));
    ok('a kind of item the shop does not make (sheet / plate) is refused', r.status === 400 && fieldOf(r) === 'itemType', r.body);
    r = await post(custom({}, { material: 'Brass C37700', finish: 'Polished' }));
    ok('brass is not a die-cast material', r.status === 400 && fieldOf(r) === 'material' && /not used for a die-cast part/.test(msgOf(r)) && /Aluminum ADC12/.test(msgOf(r)), r.body);
    r = await post(forged({ material: 'Aluminum A380', finish: 'Polished' }));
    ok('aluminum is not a forging material', r.status === 400 && fieldOf(r) === 'material' && /not used for a forged part/.test(msgOf(r)), r.body);
    r = await post(fitting({ material: 'Aluminum ADC12', finish: 'Raw / Unfinished' }));
    ok('aluminum is not a fitting material', r.status === 400 && fieldOf(r) === 'material', r.body);
    for (const m of ['Stainless Steel 304', 'Carbon Steel', 'Copper', 'Aluminum', 'Brass']) {
      r = await post(custom({}, { material: m }));
      ok('"' + m + '" is not in the list: the grade has to be chosen', r.status === 400 && fieldOf(r) === 'material' && /from the list/.test(msgOf(r)), r.body);
    }
    r = await post(custom({}, { size: '3/4"' }));
    ok('a die-cast part cannot have a pipe size', r.status === 400 && fieldOf(r) === 'size' && /die-cast part/.test(msgOf(r)), r.body);
    r = await post(custom({}, { size: 'Not applicable' }));
    ok('a die-cast part needs its dimensions', r.status === 400 && fieldOf(r) === 'size', r.body);
    r = await post(custom({}, { size: '100 x 60' }));
    ok('typed dimensions need their unit', r.status === 400 && fieldOf(r) === 'size' && /unit/.test(msgOf(r)), r.body);
    r = await post(custom({}, { size: '0 x 60 x 40 mm' }));
    ok('a dimension of zero is refused', r.status === 400 && fieldOf(r) === 'size' && /more than 0/.test(msgOf(r)), r.body);
    r = await post(custom({}, { size: '1200 x 300 x 100 mm' }));
    ok('a part larger than 1,000 mm is sent to staff', r.status === 400 && fieldOf(r) === 'size' && /1000 mm/.test(msgOf(r)), r.body);
    r = await post(fitting({ size: '3 inch' }));
    ok('a fitting larger than 2" is sent to staff', r.status === 400 && fieldOf(r) === 'size' && /up to 2"/.test(msgOf(r)), r.body);
    r = await post(fitting({ size: '4 x 8 ft' }));
    ok('a fitting cannot have a sheet size', r.status === 400 && fieldOf(r) === 'size', r.body);
    r = await post(fitting({ thickness: '2.0 mm' }));
    ok('a fitting has no wall thickness', r.status === 400 && fieldOf(r) === 'thickness', r.body);
    r = await post(fitting({ service: 'CNC machining' }));
    ok('a fitting is not CNC machined online', r.status === 400 && fieldOf(r) === 'service', r.body);
    r = await post(custom({ quantityUnit: 'boxes' }));
    ok('a die-cast part is not quoted by the box', r.status === 400 && fieldOf(r) === 'quantity' && /pcs or sets/.test(msgOf(r)), r.body);
    r = await post(fitting({}, { quantityUnit: 'kg' }));
    ok('a fitting is not quoted by the kilo', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(custom({ quantityUnit: 'sheets' }));
    ok('sheets are no longer a unit', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(custom({ quantity: 19 }));
    ok('the minimum order of a custom item is 20: 19 is refused', r.status === 400 && fieldOf(r) === 'quantity' && /minimum order .* 20 pcs/.test(msgOf(r)), r.body);
    ok('... and 20 is accepted', (await post(custom({ quantity: 20 }))).status === 201);
    r = await post(custom({ quantity: 2.5 }));
    ok('pieces are whole numbers', r.status === 400 && fieldOf(r) === 'quantity' && /whole number/.test(msgOf(r)), r.body);

    console.log('\n4. the material has to match the finish and the wall thickness');
    r = await post(custom({}, { finish: 'Chrome Plated' }));
    ok('aluminum cannot be chrome plated', r.status === 400 && fieldOf(r) === 'finish' && /Aluminum/.test(msgOf(r)), r.body);
    r = await post(custom({}, { finish: 'Satin / Brushed' }));
    ok('die-cast aluminum is not brushed', r.status === 400 && fieldOf(r) === 'finish', r.body);
    r = await post(forged({ finish: 'Powder Coated' }));
    ok('forged brass cannot be powder coated', r.status === 400 && fieldOf(r) === 'finish' && /Brass/.test(msgOf(r)), r.body);
    r = await post(forged({ finish: 'Shot Blasted' }));
    ok('forged brass is not shot blasted', r.status === 400 && fieldOf(r) === 'finish', r.body);
    ok('die-cast aluminum can be shot blasted or chromated', (await post(custom({}, { finish: 'Shot Blasted' }))).status === 201 && (await post(custom({}, { finish: 'Chromate Conversion' }))).status === 201);
    r = await post(custom({}, { thickness: '12.0 mm' }));
    ok('a listed 12 mm wall is not offered for die-cast aluminum', r.status === 400 && fieldOf(r) === 'thickness' && /Aluminum ADC12/.test(msgOf(r)), r.body);
    ok('the same 12 mm wall is fine for forged brass', (await post(forged({ thickness: '12.0 mm' }))).status === 201);
    r = await post(custom({}, { thickness: '9 mm' }));
    ok('a typed wall above the aluminum range is refused with the range', r.status === 400 && fieldOf(r) === 'thickness' && /1 to 8 mm/.test(msgOf(r)), r.body);
    r = await post(custom({}, { thickness: '0.3 mm' }));
    ok('... and so is one below it', r.status === 400 && fieldOf(r) === 'thickness', r.body);
    r = await post(custom({}, { thickness: '2.2' }));
    ok('a typed thickness needs "mm"', r.status === 400 && fieldOf(r) === 'thickness' && /in mm/.test(msgOf(r)), r.body);
    ok('"Not sure (advise me)" material keeps the wider range and any finish of the item type', (await post(custom({}, { material: 'Not sure (advise me)', thickness: '9 mm', finish: 'Painted' }))).status === 201);
    r = await post(custom({}, { material: 'Not sure (advise me)', finish: 'Chrome Plated' }));
    ok('... but never a finish the item type cannot take', r.status === 400 && fieldOf(r) === 'finish', r.body);

    console.log('\n5. finished goods (catalog products) are sold by pcs');
    const cat = (over) => ({ sku: 'BF-ELB-034', quantity: 50, quantityUnit: 'pcs', ...over });
    r = await post(cat());
    ok('a catalog finished good is quoted in pcs', r.status === 201 && r.body.quantity === '50 pcs', r.body);
    ok('a catalog product named "Brass Forged Elbow" is saved with the family material', r.status === 201 && /Material: Brass\n/.test(r.body.details), r.body && r.body.details);
    ok('a catalog product needs no item type', r.status === 201 && !/Item type/.test(r.body.details), r.body && r.body.details);
    r = await post(cat({ quantityUnit: 'kg' }));
    ok('a catalog finished good cannot be quoted in kg', r.status === 400 && fieldOf(r) === 'quantity' && /sold by pcs/.test(msgOf(r)), r.body);
    r = await post(cat({ quantityUnit: 'sheets' }));
    ok('... nor in sheets', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    r = await post(cat({ quantityUnit: undefined }));
    ok('... and the unit cannot be left out', r.status === 400 && fieldOf(r) === 'quantity', r.body);
    ok('a catalog product keeps its own minimum (not the custom-item 20)', (await post(cat({ quantity: 5 }))).status === 201);
    r = await post(cat({ quantity: 2.5 }));
    ok('pieces are whole numbers', r.status === 400 && fieldOf(r) === 'quantity' && /whole number/.test(msgOf(r)), r.body);
    r = await post(cat({ itemType: 'Sheet / plate', specs: { material: 'Aluminum', finish: 'Chrome Plated' } }));
    ok('the product record decides the details: what the browser sent is ignored', r.status === 201 && /Finish: Not specified/.test(r.body.details) && /Machining \/ secondary work: None \(as is\)/.test(r.body.details) && !/Item type/.test(r.body.details), r.body && r.body.details);

    console.log('\n6. the product form only accepts pcs for a finished good (validateProduct in server.js)');
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cut = (from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('cannot find ' + from); return src.slice(a, b); };
    const code = [cut('class ValidationError', 'const DEPARTMENTS'), cut('const DEPARTMENTS', 'const NEEDS_SUPPLIER'), cut('const UNITS', '\n', ), ''].join('\n') +
      cut('const str = ', 'const EMAIL_RE') + cut('function validateProduct', 'function validateSupplier') + '\nthis.validateProduct = validateProduct; this.ValidationError = ValidationError;';
    const sb = {}; vm.runInNewContext(code, sb);
    const prod = (over) => Object.assign({ sku: 'FG-TEST-01', name: 'Test piece', department: 'Finished Goods', category: 'Forged Brass Products', unit: 'pcs', unitCost: 10, listPrice: 20, onHand: 1, location: 'FG-1', reorderAuto: true }, over);
    const tryProduct = (b) => { try { return { v: sb.validateProduct(b, { creating: true }) }; } catch (e) { return { fields: e.fields }; } };
    ok('a finished good in pcs is accepted', !!tryProduct(prod()).v);
    let t = tryProduct(prod({ unit: 'kg' }));
    ok('a finished good in kg is refused', t.fields && /sold by the piece/.test(t.fields.unit), t);
    ok('a finished good in sheet is refused', !!(tryProduct(prod({ unit: 'sheet' })).fields || {}).unit);
    ok('a raw material is still allowed in kg', !!tryProduct(prod({ department: 'Raw Materials', category: 'Aluminum Alloy', unit: 'kg', listPrice: undefined })).v);
    ok('a finished-goods category is refused for a new raw material', !!(tryProduct(prod({ department: 'Raw Materials', unit: 'kg', listPrice: undefined })).fields || {}).category);
    ok('a finishing supply is still allowed in liters', !!tryProduct(prod({ department: 'Finishing Supplies', unit: 'liter', listPrice: undefined })).v);
  } finally { child.kill(); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
