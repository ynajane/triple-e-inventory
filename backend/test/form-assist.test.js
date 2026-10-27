'use strict';
/* test/form-assist.test.js — Task 9 form helpers: next SKU, ZIP -> address, phone key.  No database needed.
   Run:  node --no-warnings test/form-assist.test.js */
const assert = require('node:assert/strict');
const { categoryCode, initialsCode, nextSkuFrom, zipPlaces, phoneKey } = require('../form-assist');

let passed = 0;
const ok = (name, fn) => { try { fn(); passed++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };

console.log('\n1. Next SKU');
ok('category code follows the SKUs the category already uses', () => assert.equal(categoryCode('Aluminum Alloy', ['RM-AL-ADC12', 'RM-AL-A380'], 'RM'), 'AL'));
ok('the most common code wins', () => assert.equal(categoryCode('Brass / Copper Alloy', ['RM-BRS-C360', 'RM-BRS-C37700', 'RM-CU-1'], 'RM'), 'BRS'));
ok('a new category gets the initials of its words', () => assert.equal(categoryCode('Plating & Chemicals', [], 'FS'), 'PC'));
ok('one-word category: first 3 letters', () => assert.equal(initialsCode('Packaging'), 'PAC'));
ok('"Products" / "Supplies" are not counted as words', () => assert.equal(initialsCode('Forged Brass Products'), 'FB'));
ok('first SKU of a prefix is 001', () => assert.equal(nextSkuFrom('RM-AL', ['RM-AL-ADC12', 'RM-AL-A380']), 'RM-AL-001'));
ok('one more than the highest number', () => assert.equal(nextSkuFrom('FS-PC', ['FS-PC-001', 'FS-PC-007', 'FS-PC-003']), 'FS-PC-008'));
ok('another prefix does not count', () => assert.equal(nextSkuFrom('FG-DC', ['FG-DCX-050', 'FG-BF-010']), 'FG-DC-001'));
ok('case does not matter', () => assert.equal(nextSkuFrom('RM-AL', ['rm-al-004']), 'RM-AL-005'));

console.log('\n2. ZIP -> address (ph-zip.json rows)');
const REGIONS = ['NCR - National Capital Region', 'Region III - Central Luzon', 'Region IV-A - CALABARZON', 'Region VI - Western Visayas', 'Region XI - Davao Region', 'BARMM - Bangsamoro Autonomous Region'];
const ROWS = [
  { zip: '1000', place: 'Manila CPO - Ermita', admin1: 'Metro Manila', admin2: 'Capital District', admin3: '' },
  { zip: '1630', place: 'Bicutan Western', admin1: 'Metro Manila', admin2: 'Southern Manila District', admin3: 'City of Taguig' },
  { zip: '2009', place: 'Angeles City', admin1: 'Central Luzon', admin2: 'Province of Pampanga', admin3: '' },
  { zip: '5800', place: 'Roxas City', admin1: '', admin2: 'Capiz', admin3: '' },
  { zip: '5801', place: 'Panay', admin1: 'Western Visayas', admin2: 'Capiz', admin3: '' },
  { zip: '9600', place: 'Cotabato City', admin1: 'Autonomous Region in Muslim Mindanao', admin2: 'Province of Maguindanao del Norte', admin3: '' }
];
ok('Manila CPO: city Manila, district Ermita, Metro Manila, NCR', () => assert.deepEqual(zipPlaces('1000', ROWS, REGIONS)[0],
  { zip: '1000', region: 'NCR - National Capital Region', province: 'Metro Manila', city: 'Manila', barangay: 'Ermita' }));
ok('NCR row with admin3: city from admin3, barangay from place', () => assert.deepEqual(zipPlaces('1630', ROWS, REGIONS)[0],
  { zip: '1630', region: 'NCR - National Capital Region', province: 'Metro Manila', city: 'City of Taguig', barangay: 'Bicutan Western' }));
ok('"Province of" is dropped', () => assert.equal(zipPlaces('2009', ROWS, REGIONS)[0].province, 'Pampanga'));
ok('Calabarzon-style names map to the region list', () => assert.equal(zipPlaces('2009', ROWS, REGIONS)[0].region, 'Region III - Central Luzon'));
ok('missing region is borrowed from the same province', () => assert.equal(zipPlaces('5800', ROWS, REGIONS)[0].region, 'Region VI - Western Visayas'));
ok('ARMM rows map to BARMM', () => assert.equal(zipPlaces('9600', ROWS, REGIONS)[0].region, 'BARMM - Bangsamoro Autonomous Region'));
ok('PO-box ZIP with no place: nothing', () => assert.deepEqual(zipPlaces('0401', ROWS.concat([{ zip: '0401', place: 'Asian Development Bank', admin1: '', admin2: '', admin3: '' }]), REGIONS), []));
ok('unknown or badly formed ZIP: nothing', () => { assert.deepEqual(zipPlaces('0000', ROWS, REGIONS), []); assert.deepEqual(zipPlaces('12a4', ROWS, REGIONS), []); });

console.log('\n3. Phone key');
ok('0917, +63 917 and 63917 are the same number', () => {
  assert.equal(phoneKey('0917 123 4567'), '9171234567');
  assert.equal(phoneKey('+63 917-123-4567'), '9171234567');
  assert.equal(phoneKey('639171234567'), '9171234567');
});
ok('too short: no key', () => assert.equal(phoneKey('12345'), ''));

console.log('\n' + passed + ' passed' + (process.exitCode ? ' (with failures)' : ''));
