const test = require('node:test');
const assert = require('node:assert/strict');
const { calcSuggestedStockIn } = require('../../Finance_Inventory/quick-stock.js');

test('Quick Stock - calcSuggestedStockIn handles null/undefined item gracefully', () => {
  assert.equal(calcSuggestedStockIn(null), null);
  assert.equal(calcSuggestedStockIn(undefined), null);
});

test('Quick Stock - calculates standard supplier order batch when stock is healthy ("in good")', () => {
  // Case from user screenshot: Aluminum Alloy Ingot A380 (on hand: 2000 kg, reorder level: 1000 kg)
  const item = {
    sku: 'RM-AL-A380',
    name: 'Aluminum Alloy Ingot A380',
    onHand: 2000,
    reorderLevel: 1000,
    unit: 'kg',
    department: 'Raw Materials'
  };

  const res = calcSuggestedStockIn(item);
  assert.ok(res);
  assert.equal(res.isShortage, false);
  assert.equal(res.qty, 500); // 500 kg standard batch (half of reorder rounded to 50)
  assert.deepEqual(res.lots, [250, 500, 1000]); // 0.5x, 1x, 2x lots
  assert.ok(res.reason.includes('Supplier standard batch'));
  assert.ok(res.reason.includes('500 kg'));
});

test('Quick Stock - calculates shortage deficit replenishment when stock is at or below reorder level', () => {
  const lowItem = {
    sku: 'RM-AL-A380',
    name: 'Aluminum Alloy Ingot A380',
    onHand: 400,
    reorderLevel: 1000,
    unit: 'kg',
    department: 'Raw Materials'
  };

  const res = calcSuggestedStockIn(lowItem);
  assert.ok(res);
  assert.equal(res.isShortage, true);
  assert.equal(res.qty, 600); // 1000 - 400 = 600 kg deficit
  assert.deepEqual(res.lots, [300, 600, 1200]);
  assert.ok(res.reason.includes('Replenish deficit'));
  assert.ok(res.reason.includes('600 kg'));
});

test('Quick Stock - calculates medium item healthy batch', () => {
  const item = {
    sku: 'PART-BOLT-M8',
    name: 'M8 Stainless Steel Hex Bolt',
    onHand: 150,
    reorderLevel: 60,
    unit: 'pcs',
    department: 'Hardware'
  };

  const res = calcSuggestedStockIn(item);
  assert.ok(res);
  assert.equal(res.isShortage, false);
  assert.equal(res.qty, 30); // round(60 * 0.5 / 10) * 10 = 30
  assert.deepEqual(res.lots, [15, 30, 60]);
});

test('Quick Stock - calculates fallback supplier lots when reorderLevel is zero or unconfigured', () => {
  const kgItem = { sku: 'RM-COPPER', onHand: 100, reorderLevel: 0, unit: 'kg' };
  const kgRes = calcSuggestedStockIn(kgItem);
  assert.equal(kgRes.qty, 500);
  assert.deepEqual(kgRes.lots, [250, 500, 1000]);

  const pcsItem = { sku: 'PART-VALVE', onHand: 5, reorderLevel: 0, unit: 'pcs' };
  const pcsRes = calcSuggestedStockIn(pcsItem);
  assert.equal(pcsRes.qty, 50);
  assert.deepEqual(pcsRes.lots, [25, 50, 100]);
});

