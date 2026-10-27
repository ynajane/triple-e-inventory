/* invoice-wording.test.js — the customer / cashier / Finance never see the word "receipt" for a sales document: it is an INVOICE.
     1. no standalone "receipt" in any user-visible source text (screens, print windows, errors, audit lines, emails, SMS, README)
        except the documented exceptions below (they mean something else and are reported, not renamed)
     2. the printed PNG / print windows / download file name are labelled Invoice
   Internal names (receiptNo, receipt_no, ?receipt=, receiptBg, supplier_receipt ...) are allowed: a code identifier is not shown to anyone.
   Static scan, no server or database needed.   node test/invoice-wording.test.js */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;
const ok = (label, cond, detail) => { if (cond) { passed++; console.log('  PASS  ' + label); } else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); } };

// Phrases where "receipt" is NOT our sales document. Each one is intentional and listed in the Task 2 report.
const EXCEPTIONS = [
  /signed delivery receipt/i,                       // proof-of-delivery paper the customer signs (order-delivery.js)
  /confirmed receipt/i,                             // "Customer confirmed receipt of the goods" (acknowledgement, not a document)
  /from the app, receipt or statement/i,            // the customer's own payment-app receipt used as a payment reference
  /supplier receipts?/i,                            // goods-received side of stock: report group + CSV column "Last supplier receipt"
  /delivery receipt number/i                        // supplier paperwork (comment text next to the Invoice / delivery no. field)
];
// Code identifiers are never shown: receiptNo, receipt_no, lastReceipt, supplier_receipt, ?receipt=, d.receipt, 'receipt' keys, #receipt ...
const IDENTIFIER = /[A-Za-z0-9_.\-?#$]receipt|receipt[A-Za-z0-9_]|['"`]receipt['"`]|\breceipt\s*:|\breceipt\s*[,}]|\.receipt\b|\?receipt=|\breceipt\)/gi;

function files() {
  const out = [];
  const add = (dir, re, deep) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (deep && !['node_modules', 'test', 'db', 'data'].includes(f.name)) add(p, re, deep); continue; }
    if (re.test(f.name) && !/\.bak$/.test(f.name)) out.push(p);
  } };
  add(path.join(ROOT, 'Finance_Inventory'), /\.(html|js|css)$/, false);
  add(path.join(ROOT, 'backend'), /\.(js|txt|html)$/, true);                  // includes backend/emails
  out.push(path.join(ROOT, 'README_START_HERE.txt'), path.join(ROOT, 'README.txt'));
  return out.filter((f) => fs.existsSync(f));
}

function offenders(file) {
  const bad = [];
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
    let t = line.replace(/(^|\s)\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');   // comments are not shown
    if (/^\s*(\*|--)/.test(t)) return;
    for (const ex of EXCEPTIONS) t = t.replace(new RegExp(ex.source, 'gi'), '');
    t = t.replace(IDENTIFIER, '');
    if (/receipts?\b/i.test(t)) bad.push(path.relative(ROOT, file) + ':' + (i + 1) + '  ' + line.trim().slice(0, 140));
  });
  return bad;
}

console.log('1. no user-visible "receipt" wording');
const all = files().flatMap(offenders);
ok('no standalone "receipt" left in screens, errors, emails, SMS or README', all.length === 0, all.slice(0, 8));

console.log('2. printed invoice, file name and print titles say Invoice');
const pos = fs.readFileSync(path.join(ROOT, 'Finance_Inventory', 'POS_Cashier.html'), 'utf8');
ok('printed / PNG header reads SALES INVOICE', /center\('SALES INVOICE'/.test(pos));
ok('PNG download file name starts with "Invoice-"', /a\.download = 'Invoice-' \+/.test(pos));
ok('POS print window title starts with "Invoice "', /<title>Invoice ' \+/.test(pos));
ok('invoice picture is labelled Invoice for screen readers', /id="receiptImg" alt="Invoice"/.test(pos));
const co = fs.readFileSync(path.join(ROOT, 'Finance_Inventory', 'cashier-orders.js'), 'utf8');
ok('payment invoice print title starts with "Invoice "', /<title>Invoice \$\{/.test(co));
ok('payment invoice heading says sales invoice', /sales invoice/.test(co));
const shop = fs.readFileSync(path.join(ROOT, 'Finance_Inventory', 'Shop_Customer.html'), 'utf8');
ok('customer invoice title and print window say Invoice', /rcpt-title">Order invoice/.test(shop) && /<title>Invoice \$\{esc\(o\.id\)\}/.test(shop));
ok('customer "View invoice" button', /View invoice/.test(shop));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
