'use strict';
/* test/inventory-automation.test.js — Tests automated tracking across Raw Materials, Finishing Supplies,
   and Finished Goods, pre-calculated delivery schedules, and periodic production deduction.
   Run: node --no-warnings --test backend/test/inventory-automation.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { pure } = require('../inventory-automation.js');

test('Departments - exactly three distinct departments defined', () => {
  assert.equal(pure.DEPARTMENTS.RAW_MATERIALS, 'Raw Materials');
  assert.equal(pure.DEPARTMENTS.FINISHING_SUPPLIES, 'Finishing Supplies');
  assert.equal(pure.DEPARTMENTS.FINISHED_GOODS, 'Finished Goods');
  assert.deepEqual(pure.INCOMING_DEPARTMENTS, ['Raw Materials', 'Finishing Supplies']);
});

test('Delivery Schedules - advanceScheduleDate calculates weekly intervals correctly', () => {
  // Oct 23, 2026 + 7 days = Oct 30, 2026
  const nextWeekly = pure.advanceScheduleDate('2026-10-23', 'weekly');
  assert.equal(nextWeekly, '2026-10-30');

  // Next week again = Nov 06, 2026
  const nextWeekly2 = pure.advanceScheduleDate(nextWeekly, 'weekly');
  assert.equal(nextWeekly2, '2026-11-06');
});

test('Delivery Schedules - advanceScheduleDate calculates monthly intervals correctly', () => {
  // Oct 15, 2026 -> Nov 15, 2026
  const nextMonthly = pure.advanceScheduleDate('2026-10-15', 'monthly', null, 15);
  assert.equal(nextMonthly, '2026-11-15');

  // Jan 31 -> Feb handles short month
  const febDate = pure.advanceScheduleDate('2026-01-31', 'monthly', null, 31);
  assert.equal(febDate, '2026-02-28');
});

test('Delivery Schedules - forecastScheduleDeliveries projects incoming events', () => {
  const sched = {
    scheduleId: 101,
    name: 'Weekly Ingot Shipment',
    department: 'Raw Materials',
    sku: 'RM-AL-ADC12',
    productName: 'Aluminum Alloy Ingot ADC12',
    quantity: 2000,
    unit: 'kg',
    frequency: 'weekly',
    nextDeliveryDate: '2026-11-02',
    supplierName: 'Apex Metals'
  };

  const events = pure.forecastScheduleDeliveries(sched, '2026-11-01', '2026-11-30');
  assert.equal(events.length, 5); // Nov 2, 9, 16, 23, 30
  assert.equal(events[0].date, '2026-11-02');
  assert.equal(events[0].quantity, 2000);
  assert.equal(events[4].date, '2026-11-30');
});

test('Periodic Production - calculates exact BOM material requirements across departments', () => {
  // Motor Housing recipe
  const recipe = [
    {
      sku: 'RM-AL-ADC12',
      name: 'Aluminum Alloy Ingot ADC12',
      department: 'Raw Materials',
      unit: 'kg',
      qtyPerUnit: 1.25,
      onHand: 5000,
      unitCost: 185
    },
    {
      sku: 'FS-DIE-REL',
      name: 'Die Release Agent',
      department: 'Finishing Supplies',
      unit: 'L',
      qtyPerUnit: 0.004,
      onHand: 100,
      unitCost: 310
    },
    {
      sku: 'FS-PWD-BLK',
      name: 'Powder Coat Black',
      department: 'Finishing Supplies',
      unit: 'kg',
      qtyPerUnit: 0.03,
      onHand: 80,
      unitCost: 350
    }
  ];

  // Target volume: 100 finished motor housings
  const result = pure.calculateBOMRequirements(recipe, 100);
  assert.equal(result.isReady, true);
  assert.equal(result.shortages.length, 0);

  // Raw Materials breakdown
  assert.equal(result.rawMaterials.length, 1);
  assert.equal(result.rawMaterials[0].sku, 'RM-AL-ADC12');
  assert.equal(result.rawMaterials[0].consumedQty, 125); // 1.25 * 100 = 125 kg
  assert.equal(result.rawMaterials[0].isSufficient, true);

  // Finishing Supplies breakdown
  assert.equal(result.finishingSupplies.length, 2);
  const dieRel = result.finishingSupplies.find((m) => m.sku === 'FS-DIE-REL');
  assert.equal(dieRel.consumedQty, 0.4); // 0.004 * 100 = 0.4 L
  assert.equal(dieRel.isSufficient, true);

  const pwd = result.finishingSupplies.find((m) => m.sku === 'FS-PWD-BLK');
  assert.equal(pwd.consumedQty, 3.0); // 0.03 * 100 = 3 kg
  assert.equal(pwd.isSufficient, true);

  // Batch cost calculation: 125 * 185 + 0.4 * 310 + 3 * 350 = 23125 + 124 + 1050 = 24299
  assert.equal(result.totalEstimatedCost, 24299);
});

test('Periodic Production - detects shortages when stock is insufficient', () => {
  const lowRecipe = [
    {
      sku: 'RM-AL-ADC12',
      name: 'Aluminum Alloy Ingot ADC12',
      department: 'Raw Materials',
      unit: 'kg',
      qtyPerUnit: 1.25,
      onHand: 50, // Needs 125, has only 50
      unitCost: 185
    },
    {
      sku: 'FS-DIE-REL',
      name: 'Die Release Agent',
      department: 'Finishing Supplies',
      unit: 'L',
      qtyPerUnit: 0.004,
      onHand: 0.2, // Needs 0.4, has only 0.2
      unitCost: 310
    }
  ];

  const result = pure.calculateBOMRequirements(lowRecipe, 100);
  assert.equal(result.isReady, false);
  assert.equal(result.shortages.length, 2);
  assert.equal(result.shortages[0].sku, 'RM-AL-ADC12');
  assert.equal(result.shortages[0].shortage, 75); // 125 - 50 = 75 kg
  assert.equal(result.shortages[1].sku, 'FS-DIE-REL');
  assert.equal(result.shortages[1].shortage, 0.2); // 0.4 - 0.2 = 0.2 L
});

test('SQLite simulation - automated delivery schedule restock and simultaneous production deduction', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE products (
      product_id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE,
      name TEXT,
      department TEXT,
      unit TEXT,
      on_hand REAL,
      reorder_level REAL,
      unit_cost REAL
    );
    CREATE TABLE product_materials (
      finished_product_id INT,
      material_product_id INT,
      qty_per_unit REAL
    );
    CREATE TABLE stock_movements (
      movement_id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INT,
      movement_type TEXT,
      reason TEXT,
      quantity REAL,
      note TEXT
    );
  `);

  const insProd = db.prepare('INSERT INTO products (sku, name, department, unit, on_hand, reorder_level, unit_cost) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insProd.run('RM-AL-ADC12', 'Aluminum Ingot ADC12', 'Raw Materials', 'kg', 5000, 2000, 185);
  insProd.run('FS-DIE-REL', 'Die Release Agent', 'Finishing Supplies', 'L', 100, 40, 310);
  insProd.run('FS-PWD-BLK', 'Powder Coat Black', 'Finishing Supplies', 'kg', 80, 30, 350);
  insProd.run('FG-DC-MOTOR-HSG', 'Die-Cast Motor Housing', 'Finished Goods', 'pcs', 200, 100, 520);

  const getP = (sku) => db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  const pADC = getP('RM-AL-ADC12');
  const pDie = getP('FS-DIE-REL');
  const pPwd = getP('FS-PWD-BLK');
  const pFG = getP('FG-DC-MOTOR-HSG');

  // Insert BOM
  const insMat = db.prepare('INSERT INTO product_materials (finished_product_id, material_product_id, qty_per_unit) VALUES (?, ?, ?)');
  insMat.run(pFG.product_id, pADC.product_id, 1.25);
  insMat.run(pFG.product_id, pDie.product_id, 0.004);
  insMat.run(pFG.product_id, pPwd.product_id, 0.03);

  // 1. Simulate Scheduled Delivery Reception:
  // Incoming delivery for Raw Materials (+2,000 kg ADC12) and Finishing Supplies (+50 L Die Release)
  const applyMv = (prodId, type, reason, qty, note) => {
    db.prepare('INSERT INTO stock_movements (product_id, movement_type, reason, quantity, note) VALUES (?, ?, ?, ?, ?)').run(prodId, type, reason, qty, note);
    const delta = type === 'in' ? qty : -qty;
    db.prepare('UPDATE products SET on_hand = on_hand + ? WHERE product_id = ?').run(delta, prodId);
  };

  applyMv(pADC.product_id, 'in', 'supplier_receipt', 2000, 'Weekly Delivery Schedule');
  applyMv(pDie.product_id, 'in', 'supplier_receipt', 50, 'Weekly Delivery Schedule');

  assert.equal(getP('RM-AL-ADC12').on_hand, 7000); // 5000 + 2000
  assert.equal(getP('FS-DIE-REL').on_hand, 150);   // 100 + 50

  // 2. Simulate Periodic Production Volume Execution (100 pcs Motor Housing):
  // Simultaneously deducts consumed Raw Materials and Finishing Supplies, and adds Finished Goods
  const volume = 100;
  const consumedADC = 1.25 * volume; // 125 kg
  const consumedDie = 0.004 * volume; // 0.4 L
  const consumedPwd = 0.03 * volume; // 3.0 kg

  applyMv(pADC.product_id, 'out', 'production_use', consumedADC, 'Used in production PRD-0001');
  applyMv(pDie.product_id, 'out', 'production_use', consumedDie, 'Used in production PRD-0001');
  applyMv(pPwd.product_id, 'out', 'production_use', consumedPwd, 'Used in production PRD-0001');
  applyMv(pFG.product_id, 'in', 'produced_batch', volume, 'Manufactured in PRD-0001');

  // Verify real-time inventory counts across all three departments:
  assert.equal(getP('RM-AL-ADC12').on_hand, 6875); // 7000 - 125 = 6875 kg (Raw Materials)
  assert.equal(getP('FS-DIE-REL').on_hand, 149.6); // 150 - 0.4 = 149.6 L (Finishing Supplies)
  assert.equal(getP('FS-PWD-BLK').on_hand, 77.0);  // 80 - 3.0 = 77.0 kg (Finishing Supplies)
  assert.equal(getP('FG-DC-MOTOR-HSG').on_hand, 300); // 200 + 100 = 300 pcs (Finished Goods)
});

