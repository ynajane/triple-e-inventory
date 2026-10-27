-- 023: Task 9 form helpers. The server runs the same statement by itself when it starts (server.js / reorder.js); this file is for running by hand.
-- Days from placing an order with a supplier to delivery. The automatic reorder level of a product uses its main supplier's
-- lead time when it is set (REORDER_LEAD_DAYS from .env otherwise). New suppliers start with REORDER_LEAD_DAYS (7).
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_days INT CHECK (lead_time_days BETWEEN 0 AND 365);
-- New products' starting stock is written to the ledger with reason 'opening_balance' (label "Opening balance").
-- Nothing to change in the table: the reason check constraint was already removed (server.js ensureMovementColumns).
