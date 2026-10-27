/* backend/inventory-automation.js — Automated tracking across three distinct departments:
   Raw Materials, Finishing Supplies, and Finished Goods.

   1. Pre-calculated delivery schedules: automatically updates stock levels for incoming
      Raw Materials and Finishing Supplies on a weekly or monthly basis.
   2. Periodic production volume calculation & execution: automatically calculates and logs
      the production volume of finished metal goods, simultaneously deducting the exact
      quantities of raw materials and finishing supplies consumed during manufacturing
      to maintain accurate, real-time inventory counts across all three departments.
   3. Departmental tracking and real-time monitoring across all three departments.
*/
'use strict';

const DEPARTMENTS = Object.freeze({
  RAW_MATERIALS: 'Raw Materials',
  FINISHING_SUPPLIES: 'Finishing Supplies',
  FINISHED_GOODS: 'Finished Goods'
});

const INCOMING_DEPARTMENTS = Object.freeze([
  DEPARTMENTS.RAW_MATERIALS,
  DEPARTMENTS.FINISHING_SUPPLIES
]);

/* ---------- Pure calculation logic (shared and independently testable) ---------- */
const pure = {
  DEPARTMENTS,
  INCOMING_DEPARTMENTS,

  // Advance a date by weekly (+7 days) or monthly (+1 month)
  advanceScheduleDate(dateStr, frequency, dayOfWeek, dayOfMonth) {
    const base = new Date(dateStr);
    if (isNaN(base.getTime())) {
      throw new Error(`Invalid date format: ${dateStr}`);
    }

    if (frequency === 'weekly') {
      const next = new Date(base);
      next.setDate(next.getDate() + 7);
      if (typeof dayOfWeek === 'number' && dayOfWeek >= 0 && dayOfWeek <= 6) {
        const diff = (dayOfWeek - next.getDay() + 7) % 7;
        next.setDate(next.getDate() + (diff === 0 ? 0 : diff));
      }
      return next.toISOString().slice(0, 10);
    }

    if (frequency === 'monthly') {
      const y = base.getFullYear();
      const m = base.getMonth();
      const targetDay = (typeof dayOfMonth === 'number' && dayOfMonth >= 1 && dayOfMonth <= 31)
        ? dayOfMonth
        : base.getDate();

      // Next month
      let nextM = m + 1;
      let nextY = y;
      if (nextM > 11) {
        nextM = 0;
        nextY += 1;
      }

      // Handle months with fewer days (e.g. Feb)
      const daysInNextMonth = new Date(nextY, nextM + 1, 0).getDate();
      const actualDay = Math.min(targetDay, daysInNextMonth);
      const next = new Date(Date.UTC(nextY, nextM, actualDay));
      return next.toISOString().slice(0, 10);
    }

    throw new Error(`Unsupported frequency: ${frequency}`);
  },

  // Calculate consumption and sufficiency of BOM materials for a given production volume
  calculateBOMRequirements(materialsList, targetVolume) {
    const vol = Number(targetVolume);
    if (!Number.isFinite(vol) || vol <= 0) {
      throw new Error('Target production volume must be a positive number');
    }

    const rawMaterials = [];
    const finishingSupplies = [];
    let totalEstimatedCost = 0;
    let isReady = true;

    for (const m of (materialsList || [])) {
      const perUnit = Number(m.qty_per_unit || m.qtyPerUnit) || 0;
      const consumedQty = Math.round(perUnit * vol * 10000) / 10000;
      const onHand = Number(m.on_hand != null ? m.on_hand : m.onHand) || 0;
      const unitCost = Number(m.unit_cost != null ? m.unit_cost : m.unitCost) || 0;
      const isSufficient = onHand >= consumedQty;
      const shortage = isSufficient ? 0 : Math.round((consumedQty - onHand) * 10000) / 10000;
      const lineCost = Math.round(consumedQty * unitCost * 100) / 100;
      totalEstimatedCost += lineCost;

      if (!isSufficient) {
        isReady = false;
      }

      const item = {
        productId: m.product_id || m.productId,
        sku: m.sku,
        name: m.name,
        department: m.department,
        unit: m.unit,
        qtyPerUnit: perUnit,
        consumedQty,
        onHand,
        unitCost,
        lineCost,
        isSufficient,
        shortage
      };

      if (m.department === DEPARTMENTS.RAW_MATERIALS) {
        rawMaterials.push(item);
      } else if (m.department === DEPARTMENTS.FINISHING_SUPPLIES) {
        finishingSupplies.push(item);
      } else {
        // Fallback categorization if not strictly named
        rawMaterials.push(item);
      }
    }

    const shortages = [...rawMaterials, ...finishingSupplies].filter((m) => !m.isSufficient);

    return {
      volume: vol,
      isReady,
      rawMaterials,
      finishingSupplies,
      shortages,
      totalEstimatedCost: Math.round(totalEstimatedCost * 100) / 100
    };
  },

  // Forecast future delivery events for a schedule within a date window
  forecastScheduleDeliveries(schedule, startDateStr, endDateStr, maxOccurrences = 52) {
    const events = [];
    let curDate = schedule.next_delivery_date || schedule.nextDeliveryDate;
    const end = new Date(endDateStr);
    let count = 0;

    while (curDate && count < maxOccurrences) {
      const d = new Date(curDate);
      if (d > end) break;
      if (d >= new Date(startDateStr)) {
        events.push({
          date: curDate,
          scheduleId: schedule.schedule_id || schedule.scheduleId,
          name: schedule.name,
          department: schedule.department,
          sku: schedule.sku,
          productName: schedule.product_name || schedule.productName,
          quantity: Number(schedule.quantity),
          unit: schedule.unit,
          frequency: schedule.frequency,
          supplierName: schedule.supplier_name || schedule.supplierName
        });
      }
      curDate = pure.advanceScheduleDate(curDate, schedule.frequency, schedule.day_of_week, schedule.day_of_month);
      count++;
    }

    return events;
  }
};

/* ---------- Factory function for server integration ---------- */
module.exports = function createInventoryAutomation({ pool, tx, audit, ValidationError, str, TZ = 'Asia/Manila' }) {
  // Ensure tables and indexes exist
  async function ensure() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS delivery_schedules (
          schedule_id         BIGSERIAL PRIMARY KEY,
          name                TEXT NOT NULL,
          department          TEXT NOT NULL CHECK (department IN ('Raw Materials', 'Finishing Supplies')),
          product_id          INT NOT NULL REFERENCES products(product_id),
          supplier_id         INT REFERENCES suppliers(supplier_id),
          quantity            NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
          frequency           TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
          day_of_week         INT CHECK (day_of_week BETWEEN 0 AND 6),
          day_of_month        INT CHECK (day_of_month BETWEEN 1 AND 31),
          next_delivery_date  DATE NOT NULL,
          last_processed_at   TIMESTAMPTZ,
          is_active           BOOLEAN NOT NULL DEFAULT TRUE,
          auto_receive        BOOLEAN NOT NULL DEFAULT TRUE,
          unit_cost           NUMERIC(14,2),
          note                TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_delivery_sched_due ON delivery_schedules (next_delivery_date, is_active, auto_receive);
        CREATE INDEX IF NOT EXISTS idx_delivery_sched_dept ON delivery_schedules (department, is_active);

        CREATE TABLE IF NOT EXISTS periodic_production_plans (
          plan_id             BIGSERIAL PRIMARY KEY,
          name                TEXT NOT NULL,
          finished_product_id INT NOT NULL REFERENCES products(product_id),
          period              TEXT NOT NULL CHECK (period IN ('weekly', 'monthly')),
          target_volume       NUMERIC(14,2) NOT NULL CHECK (target_volume > 0),
          day_of_week         INT CHECK (day_of_week BETWEEN 0 AND 6),
          day_of_month        INT CHECK (day_of_month BETWEEN 1 AND 31),
          next_run_date       DATE NOT NULL,
          last_run_at         TIMESTAMPTZ,
          is_active           BOOLEAN NOT NULL DEFAULT TRUE,
          auto_execute        BOOLEAN NOT NULL DEFAULT TRUE,
          note                TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_prod_plans_due ON periodic_production_plans (next_run_date, is_active);

        CREATE TABLE IF NOT EXISTS periodic_production_logs (
          log_id                     BIGSERIAL PRIMARY KEY,
          plan_id                    BIGINT REFERENCES periodic_production_plans(plan_id),
          production_id              BIGINT REFERENCES production_records(production_id),
          finished_product_id        INT NOT NULL REFERENCES products(product_id),
          volume_produced            NUMERIC(14,2) NOT NULL,
          period                     TEXT NOT NULL,
          status                     TEXT NOT NULL,
          raw_materials_summary      JSONB,
          finishing_supplies_summary JSONB,
          notes                      TEXT,
          executed_at                TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_prod_logs_time ON periodic_production_logs (executed_at DESC);

        -- everything on the schedule stocks in by itself on its date (no button to click)
        ALTER TABLE periodic_production_plans ALTER COLUMN auto_execute SET DEFAULT TRUE;
        UPDATE periodic_production_plans SET auto_execute = TRUE WHERE NOT auto_execute;
        UPDATE delivery_schedules SET auto_receive = TRUE WHERE NOT auto_receive;
      `);

      // Seed initial demo schedules if empty and demo products exist
      const existing = await pool.query('SELECT COUNT(*)::int AS count FROM delivery_schedules');
      if (existing.rows[0].count === 0) {
        await seedDemoSchedules();
      }

      return true;
    } catch (err) {
      console.warn('[db] inventory automation tables warning:', err.message);
      return false;
    }
  }

  const SYSTEM = { id: null, name: 'System (automatic)', roleLabel: 'System' };
  const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());   // YYYY-MM-DD in the shop's time zone

  const ready = ensure();
  const needReady = async () => {
    if (!(await ready)) throw new Error('Inventory automation tables are not ready');
  };

  async function seedDemoSchedules() {
    try {
      const today = todayLocal();
      const demoSchedules = [
        {
          sku: 'RM-AL-ADC12',
          name: 'Weekly Aluminum Ingot ADC12 Delivery',
          qty: 2000,
          freq: 'weekly',
          dept: DEPARTMENTS.RAW_MATERIALS
        },
        {
          sku: 'RM-AL-A380',
          name: 'Monthly Aluminum Ingot A380 Batch Delivery',
          qty: 1500,
          freq: 'monthly',
          dept: DEPARTMENTS.RAW_MATERIALS
        },
        {
          sku: 'FS-DIE-REL',
          name: 'Weekly Die Release Agent Refill',
          qty: 50,
          freq: 'weekly',
          dept: DEPARTMENTS.FINISHING_SUPPLIES
        },
        {
          sku: 'FS-NI-SALT',
          name: 'Monthly Nickel Plating Salt Restock',
          qty: 40,
          freq: 'monthly',
          dept: DEPARTMENTS.FINISHING_SUPPLIES
        }
      ];

      for (const ds of demoSchedules) {
        const p = await pool.query('SELECT product_id, unit_cost FROM products WHERE sku = $1', [ds.sku]);
        if (p.rowCount) {
          const supp = await pool.query(
            'SELECT supplier_id FROM product_suppliers WHERE product_id = $1 AND is_primary LIMIT 1',
            [p.rows[0].product_id]
          );
          const supplierId = supp.rowCount ? supp.rows[0].supplier_id : null;
          await pool.query(`
            INSERT INTO delivery_schedules (name, department, product_id, supplier_id, quantity, frequency, next_delivery_date, unit_cost, auto_receive)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
          `, [ds.name, ds.dept, p.rows[0].product_id, supplierId, ds.qty, ds.freq, today, p.rows[0].unit_cost]);
        }
      }

      // Demo periodic production plans for Finished Goods
      const demoPlans = [
        {
          sku: 'FG-DC-MOTOR-HSG',
          name: 'Weekly Production: Die-Cast Motor Housing',
          period: 'weekly',
          volume: 100
        },
        {
          sku: 'FG-DC-PUMP-CVR',
          name: 'Monthly Production: Die-Cast Pump Cover',
          period: 'monthly',
          volume: 150
        }
      ];

      for (const dp of demoPlans) {
        const fg = await pool.query('SELECT product_id FROM products WHERE sku = $1 AND department = $2', [dp.sku, DEPARTMENTS.FINISHED_GOODS]);
        if (fg.rowCount) {
          await pool.query(`
            INSERT INTO periodic_production_plans (name, finished_product_id, period, target_volume, next_run_date, auto_execute)
            VALUES ($1, $2, $3, $4, $5, TRUE)
          `, [dp.name, fg.rows[0].product_id, dp.period, dp.volume, today]);
        }
      }
    } catch (err) {
      console.warn('[seed] demo automation schedules skipped:', err.message);
    }
  }

  /* ---------- Departmental Tracking across all 3 departments ---------- */
  async function getDepartmentSummary() {
    await needReady();
    const { rows: stats } = await pool.query(`
      SELECT
        p.department,
        COUNT(p.product_id)::int AS item_count,
        COALESCE(SUM(p.on_hand), 0)::numeric(14,2) AS total_on_hand,
        COALESCE(SUM(p.on_hand * COALESCE(p.unit_cost, 0)), 0)::numeric(14,2) AS total_inventory_value,
        COUNT(CASE WHEN p.on_hand <= p.reorder_level AND p.reorder_level > 0 THEN 1 END)::int AS low_stock_count
      FROM products p
      WHERE NOT p.is_archived
        AND p.department IN ('Raw Materials', 'Finishing Supplies', 'Finished Goods')
      GROUP BY p.department
    `);

    // Fetch delivery schedule metrics for Raw Materials and Finishing Supplies
    const { rows: schedStats } = await pool.query(`
      SELECT
        department,
        COUNT(schedule_id)::int AS active_schedules,
        COALESCE(SUM(CASE WHEN frequency = 'weekly' THEN quantity ELSE 0 END), 0)::numeric(14,2) AS weekly_scheduled_qty,
        COALESCE(SUM(CASE WHEN frequency = 'monthly' THEN quantity ELSE 0 END), 0)::numeric(14,2) AS monthly_scheduled_qty
      FROM delivery_schedules
      WHERE is_active
      GROUP BY department
    `);

    // Fetch periodic production metrics for Finished Goods
    const { rows: prodStats } = await pool.query(`
      SELECT
        COUNT(plan_id)::int AS active_plans,
        COALESCE(SUM(CASE WHEN period = 'weekly' THEN target_volume ELSE 0 END), 0)::numeric(14,2) AS weekly_target_volume,
        COALESCE(SUM(CASE WHEN period = 'monthly' THEN target_volume ELSE 0 END), 0)::numeric(14,2) AS monthly_target_volume
      FROM periodic_production_plans
      WHERE is_active
    `);

    const deptMap = {};
    for (const d of Object.values(DEPARTMENTS)) {
      deptMap[d] = {
        department: d,
        itemCount: 0,
        totalOnHand: 0,
        totalInventoryValue: 0,
        lowStockCount: 0,
        activeSchedules: 0,
        weeklyScheduledQty: 0,
        monthlyScheduledQty: 0,
        activeProductionPlans: 0,
        weeklyTargetVolume: 0,
        monthlyTargetVolume: 0
      };
    }

    for (const s of stats) {
      if (deptMap[s.department]) {
        deptMap[s.department].itemCount = s.item_count;
        deptMap[s.department].totalOnHand = +s.total_on_hand;
        deptMap[s.department].totalInventoryValue = +s.total_inventory_value;
        deptMap[s.department].lowStockCount = s.low_stock_count;
      }
    }

    for (const ss of schedStats) {
      if (deptMap[ss.department]) {
        deptMap[ss.department].activeSchedules = ss.active_schedules;
        deptMap[ss.department].weeklyScheduledQty = +ss.weekly_scheduled_qty;
        deptMap[ss.department].monthlyScheduledQty = +ss.monthly_scheduled_qty;
      }
    }

    if (deptMap[DEPARTMENTS.FINISHED_GOODS] && prodStats.length) {
      deptMap[DEPARTMENTS.FINISHED_GOODS].activeProductionPlans = prodStats[0].active_plans;
      deptMap[DEPARTMENTS.FINISHED_GOODS].weeklyTargetVolume = +prodStats[0].weekly_target_volume;
      deptMap[DEPARTMENTS.FINISHED_GOODS].monthlyTargetVolume = +prodStats[0].monthly_target_volume;
    }

    return {
      asOf: new Date().toISOString(),
      departments: deptMap
    };
  }

  /* ---------- Delivery Schedules Management & Auto-Receive ---------- */
  async function listDeliverySchedules() {
    await needReady();
    const { rows } = await pool.query(`
      SELECT
        ds.schedule_id,
        ds.name,
        ds.department,
        ds.product_id,
        p.sku,
        p.name AS product_name,
        p.unit,
        p.on_hand,
        p.reorder_level,
        ds.supplier_id,
        s.name AS supplier_name,
        ds.quantity,
        ds.frequency,
        ds.day_of_week,
        ds.day_of_month,
        to_char(ds.next_delivery_date, 'YYYY-MM-DD') AS next_delivery_date,
        ds.last_processed_at,
        ds.is_active,
        ds.auto_receive,
        ds.unit_cost,
        ds.note
      FROM delivery_schedules ds
      JOIN products p ON p.product_id = ds.product_id
      LEFT JOIN suppliers s ON s.supplier_id = ds.supplier_id
      ORDER BY ds.is_active DESC, ds.next_delivery_date ASC
    `);

    return rows.map((r) => ({
      scheduleId: r.schedule_id,
      name: r.name,
      department: r.department,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      unit: r.unit,
      onHand: +r.on_hand,
      reorderLevel: +r.reorder_level,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name || 'Primary / Unspecified',
      quantity: +r.quantity,
      frequency: r.frequency,
      dayOfWeek: r.day_of_week,
      dayOfMonth: r.day_of_month,
      nextDeliveryDate: r.next_delivery_date,
      lastProcessedAt: r.last_processed_at,
      isActive: r.is_active,
      autoReceive: r.auto_receive,
      unitCost: r.unit_cost != null ? +r.unit_cost : null,
      note: r.note || ''
    }));
  }

  // Automatically update stock levels for due delivery schedules
  async function processDueDeliveries(asOfDate, user) {
    await needReady();
    const targetDate = asOfDate || todayLocal();

    return await tx(async (client) => {
      const { rows: due } = await client.query(`
        SELECT
          ds.schedule_id,
          ds.name,
          ds.department,
          ds.product_id,
          p.sku,
          p.name AS product_name,
          p.unit,
          p.on_hand,
          ds.supplier_id,
          s.name AS supplier_name,
          ds.quantity,
          ds.frequency,
          ds.day_of_week,
          ds.day_of_month,
          to_char(ds.next_delivery_date, 'YYYY-MM-DD') AS next_delivery_date,
          ds.unit_cost
        FROM delivery_schedules ds
        JOIN products p ON p.product_id = ds.product_id
        LEFT JOIN suppliers s ON s.supplier_id = ds.supplier_id
        WHERE ds.is_active
          AND ds.auto_receive
          AND ds.next_delivery_date <= $1
        ORDER BY ds.schedule_id
        FOR UPDATE OF ds
      `, [targetDate]);

      if (!due.length) {
        return { processedCount: 0, receipts: [] };
      }

      const receipts = [];

      for (const d of due) {
        const qty = +d.quantity;
        const note = `Automated delivery schedule receipt: ${d.name} (${d.frequency})`;

        // 1. Insert into stock_movements (triggers automatic increase of products.on_hand)
        const mv = await client.query(`
          INSERT INTO stock_movements (
            product_id, movement_type, reason, quantity, handled_by, supplier_id, unit_cost, note
          ) VALUES ($1, 'in', 'supplier_receipt', $2, $3, $4, $5, $6)
          RETURNING ref
        `, [
          d.product_id,
          qty,
          user ? user.id : null,
          d.supplier_id || null,
          d.unit_cost || null,
          note
        ]);

        // 2. Fetch updated on_hand
        const updatedProd = await client.query('SELECT on_hand FROM products WHERE product_id = $1', [d.product_id]);
        const newOnHand = updatedProd.rows[0].on_hand;

        // 3. Advance next_delivery_date
        const nextDate = pure.advanceScheduleDate(d.next_delivery_date, d.frequency, d.day_of_week, d.day_of_month);
        await client.query(`
          UPDATE delivery_schedules
          SET last_processed_at = now(),
              next_delivery_date = $2,
              updated_at = now()
          WHERE schedule_id = $1
        `, [d.schedule_id, nextDate]);

        receipts.push({
          scheduleId: d.schedule_id,
          scheduleName: d.name,
          department: d.department,
          sku: d.sku,
          productName: d.product_name,
          quantity: qty,
          unit: d.unit,
          movementRef: mv.rows[0].ref,
          previousOnHand: +d.on_hand,
          newOnHand: +newOnHand,
          nextDeliveryDate: nextDate
        });
      }

      if (audit && user) {
        await audit(
          client,
          user,
          'Scheduled Deliveries Processed',
          `Processed ${receipts.length} incoming deliveries across Raw Materials and Finishing Supplies.`
        );
      }

      return {
        processedCount: receipts.length,
        asOfDate: targetDate,
        receipts
      };
    });
  }

  // Receive an individual delivery schedule on demand
  async function receiveDeliverySchedule(scheduleId, user) {
    await needReady();
    return await tx(async (client) => {
      const { rows } = await client.query(`
        SELECT
          ds.schedule_id,
          ds.name,
          ds.department,
          ds.product_id,
          p.sku,
          p.name AS product_name,
          p.unit,
          p.on_hand,
          ds.supplier_id,
          s.name AS supplier_name,
          ds.quantity,
          ds.frequency,
          ds.day_of_week,
          ds.day_of_month,
          to_char(ds.next_delivery_date, 'YYYY-MM-DD') AS next_delivery_date,
          ds.unit_cost
        FROM delivery_schedules ds
        JOIN products p ON p.product_id = ds.product_id
        LEFT JOIN suppliers s ON s.supplier_id = ds.supplier_id
        WHERE ds.schedule_id = $1
        FOR UPDATE OF ds
      `, [scheduleId]);

      if (!rows.length) throw new Error('Delivery schedule not found');
      const d = rows[0];
      const qty = +d.quantity;
      const note = `Received scheduled delivery: ${d.name} (${d.frequency})`;

      const mv = await client.query(`
        INSERT INTO stock_movements (
          product_id, movement_type, reason, quantity, handled_by, supplier_id, unit_cost, note
        ) VALUES ($1, 'in', 'supplier_receipt', $2, $3, $4, $5, $6)
        RETURNING ref
      `, [
        d.product_id,
        qty,
        user ? user.id : null,
        d.supplier_id || null,
        d.unit_cost || null,
        note
      ]);

      const updatedProd = await client.query('SELECT on_hand FROM products WHERE product_id = $1', [d.product_id]);
      const newOnHand = updatedProd.rows[0].on_hand;

      const nextDate = pure.advanceScheduleDate(d.next_delivery_date, d.frequency, d.day_of_week, d.day_of_month);
      await client.query(`
        UPDATE delivery_schedules
        SET last_processed_at = now(),
            next_delivery_date = $2,
            updated_at = now()
        WHERE schedule_id = $1
      `, [d.schedule_id, nextDate]);

      if (audit && user) {
        await audit(
          client,
          user,
          'Scheduled Delivery Received',
          `${d.name} (${d.sku}): received ${qty} ${d.unit} from ${d.supplier_name || 'supplier'}. New on-hand: ${newOnHand} ${d.unit}.`
        );
      }

      return {
        scheduleId: d.schedule_id,
        scheduleName: d.name,
        department: d.department,
        sku: d.sku,
        productName: d.product_name,
        quantity: qty,
        unit: d.unit,
        movementRef: mv.rows[0].ref,
        previousOnHand: +d.on_hand,
        newOnHand: +newOnHand,
        nextDeliveryDate: nextDate
      };
    });
  }

  /* ---------- Periodic Production Plans Management ---------- */
  async function listProductionPlans() {
    await needReady();
    const { rows } = await pool.query(`
      SELECT
        pp.plan_id,
        pp.name,
        pp.finished_product_id,
        p.sku,
        p.name AS product_name,
        p.unit,
        p.on_hand,
        pp.period,
        pp.target_volume,
        pp.day_of_week,
        pp.day_of_month,
        to_char(pp.next_run_date, 'YYYY-MM-DD') AS next_run_date,
        pp.last_run_at,
        pp.is_active,
        pp.auto_execute,
        pp.note
      FROM periodic_production_plans pp
      JOIN products p ON p.product_id = pp.finished_product_id
      ORDER BY pp.is_active DESC, pp.next_run_date ASC
    `);

    const plansWithReadiness = [];
    for (const r of rows) {
      let readiness = null;
      try {
        readiness = await calculatePlanMaterials(r.finished_product_id, +r.target_volume);
      } catch (err) {
        readiness = { isReady: false, shortages: [{ name: err.message }], rawMaterials: [], finishingSupplies: [], totalEstimatedCost: 0 };
      }
      plansWithReadiness.push({
        planId: r.plan_id,
        name: r.name,
        finishedProductId: r.finished_product_id,
        sku: r.sku,
        productName: r.product_name,
        unit: r.unit,
        onHand: +r.on_hand,
        period: r.period,
        targetVolume: +r.target_volume,
        dayOfWeek: r.day_of_week,
        dayOfMonth: r.day_of_month,
        nextRunDate: r.next_run_date,
        lastRunAt: r.last_run_at,
        isActive: r.is_active,
        autoExecute: r.auto_execute,
        note: r.note || '',
        readiness: {
          isReady: readiness.isReady,
          shortages: readiness.shortages || [],
          rawMaterials: readiness.rawMaterials || [],
          finishingSupplies: readiness.finishingSupplies || [],
          totalEstimatedCost: readiness.totalEstimatedCost || 0
        }
      });
    }
    return plansWithReadiness;
  }

  // Calculate material consumption for a finished good and target volume
  async function calculatePlanMaterials(finishedProductIdOrSku, volume) {
    await needReady();
    const query = typeof finishedProductIdOrSku === 'number'
      ? 'SELECT product_id, sku, name, unit, on_hand, department FROM products WHERE product_id = $1'
      : 'SELECT product_id, sku, name, unit, on_hand, department FROM products WHERE sku = $1';

    const p = await pool.query(query, [finishedProductIdOrSku]);
    if (!p.rowCount) {
      throw new Error(`Finished Good ${finishedProductIdOrSku} not found`);
    }

    const fg = p.rows[0];
    if (fg.department !== DEPARTMENTS.FINISHED_GOODS) {
      throw new Error(`${fg.name} (${fg.sku}) is in department '${fg.department}', not 'Finished Goods'`);
    }

    const { rows: materials } = await pool.query(`
      SELECT
        m.product_id,
        m.sku,
        m.name,
        m.department,
        m.unit,
        m.on_hand,
        m.unit_cost,
        pm.qty_per_unit
      FROM product_materials pm
      JOIN products m ON m.product_id = pm.material_product_id
      WHERE pm.finished_product_id = $1
      ORDER BY m.department, m.name
    `, [fg.product_id]);

    const calc = pure.calculateBOMRequirements(materials, volume);

    return {
      finishedProduct: {
        productId: fg.product_id,
        sku: fg.sku,
        name: fg.name,
        unit: fg.unit,
        onHand: +fg.on_hand
      },
      ...calc
    };
  }

  // Execute a periodic production run: simultaneously deducts Raw Materials & Finishing Supplies, and adds Finished Goods
  async function executeProductionRun(planId, options, user) {
    await needReady();
    const opts = options || {};

    return await tx(async (client) => {
      let plan = null;
      let finishedProductId = null;
      let targetVolume = null;
      let period = 'manual';

      if (planId) {
        const { rows } = await client.query(`
          SELECT pp.*, to_char(pp.next_run_date, 'YYYY-MM-DD') AS next_run_str, p.sku, p.name AS product_name, p.unit, p.department
          FROM periodic_production_plans pp
          JOIN products p ON p.product_id = pp.finished_product_id
          WHERE pp.plan_id = $1
          FOR UPDATE OF pp
        `, [planId]);
        if (!rows.length) throw new Error(`Production plan #${planId} not found`);
        plan = rows[0];
        if (opts.onlyIfDueBy && plan.next_run_str > opts.onlyIfDueBy) { const e = new Error('Plan is not due yet'); e.code = 'NOT_DUE'; throw e; }   // another sweep already ran it
        finishedProductId = plan.finished_product_id;
        targetVolume = opts.volume != null ? Number(opts.volume) : +plan.target_volume;
        period = plan.period;
      } else if (opts.finishedProductId || opts.sku) {
        const q = opts.finishedProductId
          ? 'SELECT product_id, sku, name, unit, department FROM products WHERE product_id = $1'
          : 'SELECT product_id, sku, name, unit, department FROM products WHERE sku = $1';
        const pr = await client.query(q, [opts.finishedProductId || opts.sku]);
        if (!pr.rowCount) throw new Error('Finished product not found');
        finishedProductId = pr.rows[0].product_id;
        targetVolume = Number(opts.volume);
        period = opts.period || 'periodic';
      } else {
        throw new Error('Must provide planId or finishedProductId / sku and volume');
      }

      if (!Number.isFinite(targetVolume) || targetVolume <= 0) {
        throw new Error('Target production volume must be greater than zero');
      }

      // Lock Finished Good row
      const fgRes = await client.query(`
        SELECT product_id, sku, name, unit, department, on_hand, unit_cost
        FROM products
        WHERE product_id = $1
        FOR UPDATE
      `, [finishedProductId]);
      const fg = fgRes.rows[0];

      // Fetch material requirements
      const { rows: reqs } = await client.query(`
        SELECT
          m.product_id,
          m.sku,
          m.name,
          m.department,
          m.unit,
          m.on_hand,
          m.unit_cost,
          pm.qty_per_unit
        FROM product_materials pm
        JOIN products m ON m.product_id = pm.material_product_id
        WHERE pm.finished_product_id = $1
        ORDER BY m.product_id
      `, [fg.product_id]);

      if (!reqs.length) {
        throw new Error(`Finished good ${fg.name} has no material recipe configured`);
      }

      // Lock all required material products
      const matIds = reqs.map((r) => r.product_id);
      const { rows: lockedMats } = await client.query(`
        SELECT product_id, sku, name, department, unit, on_hand, unit_cost
        FROM products
        WHERE product_id = ANY($1)
        ORDER BY product_id
        FOR UPDATE
      `, [matIds]);

      const lockedMap = new Map(lockedMats.map((m) => [m.product_id, m]));
      const matList = reqs.map((r) => {
        const lm = lockedMap.get(r.product_id);
        return {
          ...r,
          on_hand: lm.on_hand,
          unit_cost: lm.unit_cost
        };
      });

      const calc = pure.calculateBOMRequirements(matList, targetVolume);

      // Verify sufficiency: block if any material in Raw Materials or Finishing Supplies is insufficient
      if (!calc.isReady) {
        const shortDetails = calc.shortages.map(
          (s) => `${s.name} (${s.department}): needs ${s.consumedQty} ${s.unit}, only ${s.onHand} on hand (short ${s.shortage})`
        ).join('; ');
        throw new Error(`Production run blocked due to material shortages: ${shortDetails}`);
      }

      // 1. Generate Production Record
      const prodSeq = await client.query("SELECT 'PRD-' || lpad(nextval('production_ref_seq')::text, 5, '0') AS ref");
      const prodRef = prodSeq.rows[0].ref;

      const insProd = await client.query(`
        INSERT INTO production_records (
          ref, finished_product_id, product_sku, product_name, unit, quantity,
          status, note, recorded_by, recorded_by_name
        ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, $9)
        RETURNING production_id
      `, [
        prodRef,
        fg.product_id,
        fg.sku,
        fg.name,
        fg.unit,
        targetVolume,
        opts.note || `Periodic production volume: ${targetVolume} ${fg.unit}`,
        user ? user.id : null,
        user ? user.name : 'System Automation'
      ]);
      const productionId = insProd.rows[0].production_id;

      const deductedRawMaterials = [];
      const deductedFinishingSupplies = [];

      // 2. Deduct consumed materials simultaneously across Raw Materials & Finishing Supplies
      const allDeductions = [...calc.rawMaterials, ...calc.finishingSupplies];
      for (const item of allDeductions) {
        if (item.consumedQty > 0) {
          const mvNote = `Production run ${prodRef} consumed ${item.consumedQty} ${item.unit} of ${item.name} for ${targetVolume} ${fg.unit} ${fg.name}`;
          const mv = await client.query(`
            INSERT INTO stock_movements (
              product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost
            ) VALUES ($1, 'out', 'production_use', $2, $3, 'production', $4, $5, $6)
            RETURNING ref
          `, [
            item.productId,
            item.consumedQty,
            user ? user.id : null,
            productionId,
            mvNote,
            item.unitCost || null
          ]);

          await client.query(`
            INSERT INTO production_items (
              production_id, material_product_id, material_sku, material_name, department,
              unit, qty_per_unit, calculated_qty, actual_qty, movement_ref
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            productionId,
            item.productId,
            item.sku,
            item.name,
            item.department,
            item.unit,
            item.qtyPerUnit,
            item.consumedQty,
            item.consumedQty,
            mv.rows[0].ref
          ]);

          const summaryEntry = {
            sku: item.sku,
            name: item.name,
            department: item.department,
            consumedQty: item.consumedQty,
            unit: item.unit,
            movementRef: mv.rows[0].ref
          };

          if (item.department === DEPARTMENTS.RAW_MATERIALS) {
            deductedRawMaterials.push(summaryEntry);
          } else {
            deductedFinishingSupplies.push(summaryEntry);
          }
        }
      }

      // 3. Add Finished Goods production volume
      const fgNote = `Production run ${prodRef}: ${targetVolume} ${fg.unit} manufactured`;
      const fgMv = await client.query(`
        INSERT INTO stock_movements (
          product_id, movement_type, reason, quantity, handled_by, source_type, source_id, note, unit_cost
        ) VALUES ($1, 'in', 'produced_batch', $2, $3, 'production', $4, $5, $6)
        RETURNING ref
      `, [
        fg.product_id,
        targetVolume,
        user ? user.id : null,
        productionId,
        fgNote,
        fg.unit_cost || null
      ]);

      await client.query(`
        UPDATE production_records
        SET fg_movement_ref = $1
        WHERE production_id = $2
      `, [fgMv.rows[0].ref, productionId]);

      // 4. Log the periodic production execution
      await client.query(`
        INSERT INTO periodic_production_logs (
          plan_id, production_id, finished_product_id, volume_produced, period,
          status, raw_materials_summary, finishing_supplies_summary, notes
        ) VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)
      `, [
        plan ? plan.plan_id : null,
        productionId,
        fg.product_id,
        targetVolume,
        period,
        JSON.stringify(deductedRawMaterials),
        JSON.stringify(deductedFinishingSupplies),
        opts.note || null
      ]);

      // 5. Advance plan schedule if applicable
      let nextRunDate = null;
      if (plan) {
        nextRunDate = pure.advanceScheduleDate(plan.next_run_date, plan.period, plan.day_of_week, plan.day_of_month);
        await client.query(`
          UPDATE periodic_production_plans
          SET last_run_at = now(),
              next_run_date = $2,
              updated_at = now()
        WHERE plan_id = $1
        `, [plan.plan_id, nextRunDate]);
      }

      // 6. Fetch final updated real-time balances for all 3 departments
      const updatedFg = await client.query('SELECT on_hand FROM products WHERE product_id = $1', [fg.product_id]);
      const updatedMats = await client.query(
        'SELECT product_id, sku, name, department, on_hand FROM products WHERE product_id = ANY($1)',
        [matIds]
      );

      if (audit && user) {
        await audit(
          client,
          user,
          'Periodic Production Executed',
          `${prodRef} produced ${targetVolume} ${fg.unit} of ${fg.name}. Consumed ${deductedRawMaterials.length} raw materials and ${deductedFinishingSupplies.length} finishing supplies.`
        );
      }

      return {
        productionId,
        ref: prodRef,
        period,
        targetVolume,
        finishedGood: {
          sku: fg.sku,
          name: fg.name,
          unit: fg.unit,
          previousOnHand: +fg.on_hand,
          newOnHand: +updatedFg.rows[0].on_hand,
          movementRef: fgMv.rows[0].ref
        },
        rawMaterialsDeducted: deductedRawMaterials,
        finishingSuppliesDeducted: deductedFinishingSupplies,
        updatedMaterialStock: updatedMats.rows.map((m) => ({
          sku: m.sku,
          name: m.name,
          department: m.department,
          newOnHand: +m.on_hand
        })),
        nextRunDate
      };
    });
  }

  /* ---------- Automatic stock-in on the scheduled day ----------
     Deliveries (Raw Materials / Finishing Supplies) are received first, then due production runs use that stock to add
     Finished Goods. A production run that is short of materials is skipped and retried on the next sweep. */
  async function processDuePlans(asOfDate, user) {
    await needReady();
    const target = asOfDate || todayLocal();
    const out = { producedCount: 0, runs: [], waiting: [] };
    for (let pass = 0; pass < 10; pass++) {
      const { rows } = await pool.query(
        `SELECT plan_id, name FROM periodic_production_plans
          WHERE is_active AND auto_execute AND next_run_date <= $1 ORDER BY next_run_date, plan_id`, [target]);
      let progressed = false;
      for (const pl of rows) {
        if (out.waiting.some((w) => w.planId === pl.plan_id)) continue;
        try {
          const r = await executeProductionRun(pl.plan_id, { note: `Automatic scheduled production: ${pl.name}`, onlyIfDueBy: target }, user || SYSTEM);
          out.runs.push({ planId: pl.plan_id, name: pl.name, ref: r.ref, quantity: r.targetVolume, unit: r.finishedGood.unit, product: r.finishedGood.name, nextRunDate: r.nextRunDate });
          out.producedCount++; progressed = true;
        } catch (err) {
          if (err.code === 'NOT_DUE') continue;
          out.waiting.push({ planId: pl.plan_id, name: pl.name, reason: err.message });
        }
      }
      if (!progressed) break;
    }
    return out;
  }

  let sweeping = null;
  function runDueAutomation(asOfDate) {
    if (sweeping) return sweeping;                       // two sweeps at once would only repeat the same work
    sweeping = (async () => {
      await needReady();
      const target = asOfDate || todayLocal();
      const deliveries = { processedCount: 0, receipts: [] };
      for (let i = 0; i < 10; i++) {                     // a server that slept for weeks catches up on every missed date
        const r = await processDueDeliveries(target, SYSTEM);
        if (!r.processedCount) break;
        deliveries.processedCount += r.processedCount;
        deliveries.receipts.push(...r.receipts);
      }
      const production = await processDuePlans(target, SYSTEM);
      return { asOfDate: target, deliveries, production };
    })().finally(() => { sweeping = null; });
    return sweeping;
  }

  return {
    pure,
    ready,
    runDueAutomation,
    processDuePlans,
    getDepartmentSummary,
    listDeliverySchedules,
    processDueDeliveries,
    receiveDeliverySchedule,
    listProductionPlans,
    calculatePlanMaterials,
    executeProductionRun
  };
};

module.exports.pure = pure;