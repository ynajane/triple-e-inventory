-- Additive policy state. Confirmed money remains exclusively in the payments ledger.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_due_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_hold_from TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance_held_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_disposition TEXT CHECK (deposit_disposition IN ('forfeit','refund'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_decision_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_decided_by INT REFERENCES users(user_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_decided_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS forfeited_amount NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_pending_by INT REFERENCES users(user_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_pending_note TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_pending_balance NUMERIC(14,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_second_by INT REFERENCES users(user_id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_second_note TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS production_override_by INT REFERENCES users(user_id);
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS production_override_name TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS production_override_note TEXT;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS production_override_at TIMESTAMPTZ;
-- Extend only the fulfilment check; leave payment-state constraints intact.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='orders'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) ~ '\mstatus\M'
  LOOP EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c.conname); END LOOP;
  ALTER TABLE orders ADD CONSTRAINT orders_status_flow_check CHECK (status IN
    ('Pending Confirmation','Paid','Packed','Out for Delivery','Ready for Pickup','Delivered','Picked Up','Cancelled','Returned','On Hold'));
END $$;
