TRIPLE-E INVENTORY — project with database backend

FOLDERS
  Finance_Inventory/   website (HTML/JS/CSS). Already connected: api-bridge.js is added,
                       and the login form now calls the real /api/auth/login.
  backend/             PostgreSQL schema + Node/Express API (see DATA_PROCESS.md)

QUICK START (local)
  1. Install PostgreSQL and Node.js 20+.
  2. Create the DB and load it:
       sudo -u postgres psql -c "CREATE USER triplee_app WITH PASSWORD 'your-password';"
       sudo -u postgres psql -c "CREATE DATABASE triplee OWNER triplee_app;"
       psql -X -v ON_ERROR_STOP=1 "postgres://triplee_app:your-password@localhost/triplee" -f backend/db/initialize.sql
       This is for an EMPTY database. It creates roles and schema without sample inventory.
       Existing installations: back up first; apply only backend/db/002_sales_core.sql to add missing sales tables.
       Never rerun 001_schema.sql or blindly run every SQL file (some legacy scripts delete/reseed data).
  3. cd backend
       cp .env.example .env     (edit DATABASE_URL and set a long random JWT_SECRET)
       npm install
       npm start
       After startup, apply backend/db/025_security_hardening.sql as the database owner
       to cover runtime-created tables (use psql -X -v ON_ERROR_STOP=1). Then in another terminal:
       npm run create-user -- "Your Name" yourusername you@triplee-metal.com 'YourP@ssw0rd' finance
  4. Open http://localhost:8080/Login_Inventory.html

SIGN-IN: after the password is accepted, the user confirms a one-time code by email or text before a session starts. Keep LOGIN_OTP enabled in production.


ONLINE SHOP EXTRAS (quotes, minimum order, back-in-stock, reviews)
  Code:  backend/shop-extras.js  +  Finance_Inventory/shop-extras-admin.js  (Shop_Customer.html has the customer side)
  Tables are created automatically when the server starts. backend/db/006_shop_extras.sql is the same thing for running by hand.
  .env:  QUOTE_EMAIL (optional) = where a copy of each new quote request is emailed; falls back to SHOP_EMAIL.
         Customer emails (quote received/replied, back in stock) use the same Gmail / Mailgun settings as order emails.
  Finance: menu Sales > Quote Requests and Product Reviews. Set "Minimum order" in Products > Finished Goods > Online shop details.


POS PARTIAL RETURNS (customer brings back some items of a receipt)
  Cashier: POS > Today's Sales > "Return…" on the receipt (or type an older receipt number > "Return items…"). Pick the items and quantities, choose a reason, send.
  Finance: Sales > Sales Transactions > POS Walk-in Sales > "Approve return" / "Reject". When approving, Finance says whether the items are resellable (put back in stock) or not (refund only).
  Cash sales: the refund is charged to the requesting cashier's open Cash Shift and lowers "cash that should be in the drawer". Card / online sales: no drawer cash; Finance refunds the original payment outside the POS.
  A sale that has a return cannot also be voided (return the remaining items instead). Returns are accepted for POS_RETURN_WINDOW_DAYS days after the sale (default 7, set in backend/.env).
  Audit Log: actions "Return" (requested / approved / rejected) and "Cash shift" (opened, closed with expected / counted / difference, cash added / removed).
  Tables are created automatically when the server starts. backend/db/007_pos_returns.sql is the same thing for running by hand.


CUSTOMER REGISTRATION (3 steps) + EMAIL VERIFICATION
  Page:  Finance_Inventory/Login_Inventory.html  (Create an account: Personal > Contact > Security).
  Code:  backend/auth-signup.js (sign-up, verification), backend/server.js (login gate, My Profile), Finance_Inventory/account-menu.js + shop-address.js (My Profile).
  SQL:   backend/db/008_customer_registration.sql (also run automatically when the server starts). Existing accounts are marked verified, nothing is lost.
  Email: new customers get a one-time link (expires in EMAIL_VERIFY_TTL_HOURS, default 24) and cannot sign in until they click it. Uses the same Gmail / Mailgun
         settings as order emails; without them the link is printed in the server console. EMAIL_VERIFICATION=off in backend/.env turns the requirement off.
  Cashier / Finance accounts are NOT created on this page: Finance/Admin invites them (Team > Invitations) and the role comes from the invitation.
  After sign-in:  Finance/Admin -> Finance_Inventory.html   Cashier -> POS_Cashier.html   Customer -> Shop_Customer.html
  Customers finish their profile in the shop: user menu > My Profile (name parts, birthdate, gender, company info) and the Delivery Addresses tab.
  Terms and Privacy text lives in Login_Inventory.html (LEGAL). Have it reviewed, and bump TERMS_VERSION in .env when you change it.


PRODUCTION-BASED INVENTORY DEDUCTION (Finished Goods made in-house use up Raw Materials / Finishing Supplies)
  Code:  backend/production.js  +  Finance_Inventory/production-admin.js + production.css  (small hooks in server.js, api-bridge.js, Finance_Inventory.html)
  Tables are created automatically when the server starts. backend/db/009_production.sql is the same thing for running by hand.
  1. Set up materials:  Finance > Stock In / Out > "Material requirements" (bottom of the page). Pick a Finished Good, add each Raw Material /
     Finishing Supply with the quantity needed for ONE unit, Save. Reused for every production; changing it never changes past records.
  2. Record production: Stock In > Department "Finished Goods" > product > quantity > Stock-In Source "Produced Internally".
     The material table appears: edit "Actual used" if needed, then "Confirm Production". Nothing is deducted before that button.
     Not enough stock = the confirm is blocked and nothing changes. Source "Received from Supplier" / "Inventory Adjustment" work as normal Stock In.
  3. Results: Movement log shows the material Stock-Outs ("Used in production", PRD reference, finished product, user) and the Stock-In;
     "Production history" lists every record with its material details. Reports include these movements automatically.
  Double deduction: every confirm carries a one-time key, so a double click / retry returns the same PRD record instead of deducting again.
  Manual Stock Out "Used in production" still exists for consumption NOT recorded through a production record.


FORM HELPERS (Task 9)
  Code:  Finance_Inventory/form-assist.js (shared by every page) + backend/form-assist.js (routes). Tests: node --no-warnings backend/test/form-assist.test.js
  SQL:   backend/db/023_form_assist.sql (also run automatically when the server starts).
  Product form (new product): SKU suggested as the next free number for department + category (e.g. RM-AL-001), still editable; unit, category and
         storage location start as what that department mostly uses; "Did you mean …?" for a name close to an existing product; the recipe cost of a
         finished good stays read-only (Override needs a reason, as before); the Opening Stock is saved as an "Opening balance" ledger entry.
  Stock In / Out: On hand (and storage location) beside the quantity; a Stock Out larger than what is on hand cannot be saved; the quantity can be
         typed in another unit of the same kind (g / tonne / lb for kg, ft for m) and is converted; a supplier delivery is pre-filled with the last
         supplier and last cost per unit; a cost more than 30% away from the last purchase asks "Is this cost right?" (30% is an assumption, COST_JUMP in api-bridge.js).
  Quote forms (shop + POS walk-in): live price estimate (as before), minimum-order warning for catalog products, delivery fee shown as soon as the
         area is known, a "Know the ZIP code?" box that fills the area, and an autosaved draft in the browser ("Start over" discards it).
  Customer / sign-up / supplier: "Know the ZIP code?" fills Region > Province > City (> Barangay) from backend/data/ph-zip.json; every phone box is
         rewritten as +63 917 123 4567 (landlines +63 2 8123 4567); email typos get "Did you mean …@gmail.com?"; sign-up warns when the mobile number is
         already on an account; the cashier sees "this number / email belongs to …" (accounts, earlier walk-in sales and quotes); suppliers have a lead time.
  Everywhere: errors beside the field while typing, a warning before unsaved changes are lost, Enter moves to the next field (Ctrl+Enter submits).


PAYMENT TERMS AUTOMATION
  Code:  backend/payment-terms.js (autoApproval, recommendKey, attachTerms), backend/shop-extras.js (price route), Finance_Inventory/payment-terms-admin.js,
         Finance_Inventory/quote-desk-ui.js. Tests: node --no-warnings backend/test/payment-terms-auto.test.js
  Finance > Payment Terms: rows save by themselves (no Save button, no typed reason; the audit log records who changed what). Only the % or the peso box
         is shown, whichever the basis is. New "Approve automatically up to" per partial term (empty = Finance approves each one, as before).
  Cashier quotations: the term is pre-selected (ready stock -> Full Payment; made-to-order -> the allowed part-payment with the biggest deposit) and each
         choice says whether it is approved at once or goes to Finance. A part-payment is approved by the system when the term is on and allowed for that
         order type, the total is within the limit, and the customer owes nothing on another order or quotation (account by customer, walk-in by phone).
         Otherwise it goes to Finance with the reason. The term is attached together with the price, so the customer's "quote ready" message carries it.
  Columns added automatically at start: payment_terms.auto_approve_limit, quote_requests.terms_auto_note.

SECURITY AND DATA PROCESS
  Read SECURITY.md and DATA_PROCESS.md before release.
  From backend: npm run test:security; npm run test:data-integrity; npm run test:startup; npm run check:production.
  test:data-integrity needs PostgreSQL tools (pg_config, initdb, pg_ctl, pg_dump, pg_restore, psql), run as a non-root user.
  It creates and removes its own local cluster; it never uses DATABASE_URL.
  The production check reads backend/.env without printing values; run it with the deployment configuration.

  Full fresh-install regression: from backend run `npm run test:startup` (requires the same PostgreSQL tools). It uses a disposable private database and synthetic accounts with OTP enabled.
