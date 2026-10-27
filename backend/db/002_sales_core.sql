-- Missing sales baseline for databases initialized with 001_schema.sql.
-- Apply before starting the server. Existing tables/data/defaults are preserved.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS order_no_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1001;
CREATE TABLE IF NOT EXISTS orders (
 order_id SERIAL PRIMARY KEY,
 order_no TEXT NOT NULL UNIQUE DEFAULT ('ORD-' || nextval('order_no_seq')),
 customer_id INT NOT NULL REFERENCES users(user_id),
 fulfillment TEXT NOT NULL CHECK (fulfillment IN ('Delivery','Pickup')),
 status TEXT NOT NULL DEFAULT 'Pending Confirmation', payment_method TEXT NOT NULL,
 address TEXT, phone TEXT,
 subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
 delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
 total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
 stock_deducted BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
 item_id SERIAL PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(order_id),
 product_id INT NOT NULL REFERENCES products(product_id),
 sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
 qty NUMERIC(14,2) NOT NULL CHECK (qty > 0), price NUMERIC(12,2) NOT NULL CHECK (price >= 0)
);
CREATE TABLE IF NOT EXISTS pos_sales (
 sale_id SERIAL PRIMARY KEY,
 receipt_no TEXT NOT NULL UNIQUE DEFAULT ('SI-' || nextval('receipt_seq')),
 cashier_id INT REFERENCES users(user_id), cashier_name TEXT NOT NULL,
 method TEXT NOT NULL CHECK (method IN ('Cash','Card','Xendit')),
 status TEXT NOT NULL DEFAULT 'Completed' CHECK (status IN ('Completed','Void Pending','Voided')),
 total NUMERIC(12,2) NOT NULL CHECK (total >= 0), vat NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (vat >= 0),
 tendered NUMERIC(12,2), change_given NUMERIC(12,2), card_ref TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pos_sale_items (
 item_id SERIAL PRIMARY KEY, sale_id INT NOT NULL REFERENCES pos_sales(sale_id),
 product_id INT NOT NULL REFERENCES products(product_id),
 sku TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL,
 qty NUMERIC(14,2) NOT NULL CHECK (qty > 0), price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
 unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);
CREATE TABLE IF NOT EXISTS void_requests (
 request_id SERIAL PRIMARY KEY, sale_id INT NOT NULL REFERENCES pos_sales(sale_id),
 reason TEXT NOT NULL, requested_by INT REFERENCES users(user_id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
 decided_by INT REFERENCES users(user_id), decided_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMIT;
