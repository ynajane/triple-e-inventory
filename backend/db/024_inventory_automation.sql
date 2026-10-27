-- 024_inventory_automation.sql: Automated tracking across Raw Materials, Finishing Supplies, and Finished Goods.
-- Features:
--   1. Pre-calculated delivery schedules for incoming Raw Materials and Finishing Supplies (weekly / monthly).
--   2. Periodic production volume calculation and automated simultaneous deduction of consumed materials
--      (Raw Materials and Finishing Supplies) when producing Finished Metal Goods.
BEGIN;

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
  auto_execute        BOOLEAN NOT NULL DEFAULT FALSE,
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

COMMIT;

