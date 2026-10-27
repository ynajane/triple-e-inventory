/* payment-terms-screen.js — the §9 Finance screen, driven with its real backend payloads.

   The shipped Finance_Inventory/payment-terms-admin.js is run inside a small DOM stand-in against
   test/desk-browser-harness.js, so the JSON the routes actually answer is what gets painted, and the Save / Approve
   buttons post what the shipped server really accepts. It proves the field names line up, every figure shown is the
   ledger's own, and a row error is written into the row instead of a browser dialog.

   It does NOT prove how the page looks or behaves with real CSS in a browser (see README_DEPLOY.md).

     node test/payment-terms-screen.js */
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.HARNESS_PORT || 8903);
const BASE = 'http://127.0.0.1:' + PORT;
const SCREEN = path.join(__dirname, '..', '..', 'Finance_Inventory', 'payment-terms-admin.js');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail !== undefined ? '  →  ' + JSON.stringify(detail) : '')); }
}
const peso = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const settle = () => new Promise((r) => setTimeout(r, 140));

async function startHarness(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'desk-browser-harness.js'), String(PORT)],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, env) });
  const err = [];
  child.stderr.on('data', (b) => err.push(String(b)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/api/shop/info')).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('harness did not start: ' + err.join(''));
}
async function call(role, method, p, body) {
  await fetch(BASE + '/__harness/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) });
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const shopQuote = (over) => Object.assign({ contactName: 'Eva Son', phone: '0921 123 4567', sku: 'ANG-0203', quantity: 4, quantityUnit: 'length',
  fulfillment: 'Pickup', neededBy: '2026-12-15',
  specs: { material: 'Carbon Steel', size: '2 x 2 in', thickness: '3.0 mm', finish: 'Raw / Unfinished', service: 'None (as is)' } }, over || {});

/* ---------------- the DOM stand-in ----------------
   Only what this screen touches: elements fetched by id, one click listener, data-err boxes and toasts. */
function makeDom() {
  const byId = new Map(), toasts = [];
  const element = (id) => ({ id, innerHTML: '', textContent: '', value: '', checked: false, dataset: {}, style: {},
    classList: { contains: () => false, add() {}, remove() {} },
    listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; },
    querySelector: () => null, remove() {} });
  const get = (id) => { if (!byId.has(id)) byId.set(id, element(id)); return byId.get(id); };
  const doc = { readyState: 'complete', hidden: false, body: { appendChild: (e) => toasts.push(e.textContent) },
    getElementById: (id) => (id ? get(id) : null), querySelector: () => null, createElement: () => element('(new)'), addEventListener() {} };
  return { byId, get, toasts, doc, window: { location: { href: '' } },
    MutationObserver: function Observer() { this.observe = () => {}; } };
}
function loadScreen(dom) {
  const sandbox = { document: dom.doc, window: dom.window, console, fetch: (url, opt) => fetch(BASE + url, opt),
    setTimeout, clearTimeout, MutationObserver: dom.MutationObserver };
  vm.runInNewContext(fs.readFileSync(SCREEN, 'utf8'), vm.createContext(sandbox), { filename: 'payment-terms-admin.js' });
  return sandbox;
}

/* a table row as the screen reads it: named inputs on the left, an error box in the last cell */
function fakeRow(fields, data) {
  const err = { textContent: '' };
  return { dataset: data || {}, err,
    querySelector: (sel) => {
      if (sel === '[data-err]') return err;
      const m = /^\[data-f="([a-zA-Z]+)"\]$/.exec(sel);
      if (!m) return null;
      const own = fields[m[1]];
      return { value: own === undefined || own === null ? '' : String(own), checked: !!own };
    },
    closest: () => null };
}
const clickOn = (handle, node) => ({ preventDefault() {}, target: { closest: (sel) => (sel === handle ? { closest: () => node } : null) } });

async function main() {
  const child = await startHarness({ CASHIER_QUOTE_LIMIT_PHP: '60000', HARNESS_QUOTE_BAND_PCT: '1000' });
  try {
    /* ---- stage the money the screen must show, through the shipped routes ---- */
    await call('finance', 'POST', '/api/finance/payment-terms/half',
      { enabled: true, retailAllowed: true, madeToOrderAllowed: true, percent: 50, balanceCondition: 'balance due before the order is released', note: 'Approved by management 2026-10' });

    const qa = await call('customer', 'POST', '/api/shop/quotes', shopQuote({ contactName: 'Nena Cruz' }));
    const noA = qa.body.id;
    await call('cashier', 'POST', '/api/pos/quotes/' + noA + '/price', { amount: '9000', leadTime: '1 to 3 working days', validDays: 7, note: 'Standard' });
    const proposal = await call('cashier', 'POST', '/api/pos/quotes/' + noA + '/terms', { termKey: 'half', condition: 'balance due before pickup' });
    if (proposal.status !== 200) throw new Error('the cashier could not propose the terms: ' + JSON.stringify(proposal.body));

    const qb = await call('customer', 'POST', '/api/shop/quotes', shopQuote({ contactName: 'Iya Son', quantity: 1 }));
    const noB = qb.body.id;
    await call('cashier', 'POST', '/api/pos/quotes/' + noB + '/price', { amount: '1200', leadTime: '1 to 3 working days', validDays: 7, note: 'One length' });
    await call('customer', 'POST', '/api/shop/quotes/' + noB + '/respond', { action: 'accept', payMethod: 'cod' });
    const conv = await call('cashier', 'POST', '/api/pos/quote-desk/' + noB + '/convert', { requestId: 'conv-screen-00000001', recipient: 'Iya Son' });
    const ordNo = conv.body.orderNo;
    await call('cashier', 'POST', '/__harness/shift', { open: true, id: 11 });
    const counter = await call('cashier', 'POST', '/api/pos/orders/' + ordNo + '/payment',
      { amount: '500', method: 'Cash', tendered: '1000', requestId: 'screen-counter-000001' });
    if (counter.status !== 200) throw new Error('the counter payment failed: ' + JSON.stringify(counter.body));

    // what the routes answer is the expected picture; the screen must paint exactly that
    const wantTerms = await call('finance', 'GET', '/api/finance/payment-terms');
    const wantDebt = await call('finance', 'GET', '/api/finance/receivables');
    const wantMoney = await call('finance', 'GET', '/api/finance/payments');

    /* ---- open the screen as Finance ---- */
    const dom = makeDom();
    loadScreen(dom);
    await settle(); await settle(); await settle();

    const P = (n) => dom.get(n + 'Body').innerHTML, S = (n) => dom.get(n + 'Status').innerHTML;
    console.log('\n1. the screen paints what the four ledger routes answered');
    ok('the policy table shows all four terms, with Full Payment locked as the default',
      ['full', 'half', 'down', 'custom'].every((k) => P('ptrPolicy').includes('data-term="' + k + '"')) && /Always available/.test(P('ptrPolicy')),
      (P('ptrPolicy').match(/data-term="(\w+)"/g) || []));
    ok('a term Finance switched on is drawn on, with who switched it on and when',
      /data-term="half"[\s\S]*?data-f="enabled" checked/.test(P('ptrPolicy')) && /On since/.test(P('ptrPolicy')) && /Test Finance/.test(P('ptrPolicy')));
    ok('a term nobody switched on is drawn off and cannot be picked',
      /data-term="down"[\s\S]*?<input type="checkbox" data-f="enabled">/.test(P('ptrPolicy')));
    ok('the Full Payment row is read-only, as the policy must always be available',
      /data-term="full"[\s\S]*?data-f="retailAllowed" checked disabled[\s\S]*?data-f="enabled" checked disabled/.test(P('ptrPolicy')), /data-term="full"[\s\S]{0,700}/.exec(P('ptrPolicy')));
    ok('the header lists the terms customers can be offered today, straight from the policy',
      /4 term\(s\) on file/.test(S('ptrPolicy')) && /offered now: Full Payment[\s\S]*Half Payment/.test(S('ptrPolicy')), S('ptrPolicy'));
    ok('no ledger warning when the database trigger is live',
      wantTerms.body.ledgerReady === true && !/not active in this database/.test(S('ptrPolicy')), wantTerms.body.ledgerReady);

    ok('the waiting list shows the quotation the cashier proposed, with the server\u2019s figures',
      P('ptrProposed').includes(noA) && /50% now/.test(P('ptrProposed')) && /₱4,500\.00/.test(P('ptrProposed'))
      && /balance due before pickup/.test(P('ptrProposed')) && /Nena Cruz/.test(P('ptrProposed')), P('ptrProposed').slice(0, 500));
    ok('an order half-paid at the counter is owed the difference and reads part-paid, not paid',
      P('ptrDebt').includes(ordNo) && P('ptrDebt').includes(peso(1200)) && P('ptrDebt').includes(peso(500))
      && /<b>₱700\.00<\/b>/.test(P('ptrDebt')) && /Partly paid/.test(P('ptrDebt')), P('ptrDebt').slice(0, 700));
    const owedOrder = wantDebt.body.orders.find((x) => x.no === ordNo);
    ok('…and that is the same figure the receivables route returned', owedOrder && owedOrder.outstanding === 700 && owedOrder.paidAmount === 500, owedOrder);
    ok('the receivables header is the server total, row count and all',
      S('ptrDebt').includes(peso(wantDebt.body.totals.allOwed)) && S('ptrDebt').includes('Orders ' + wantDebt.body.totals.openOrders)
      && S('ptrDebt').includes('quotations ' + wantDebt.body.totals.openQuotes), S('ptrDebt'));
    ok('the payment list names the drawer, the person and the money event',
      /drawer #11/.test(P('ptrMoney')) && /Test Cashier/.test(P('ptrMoney')) && P('ptrMoney').includes('+' + peso(500)) && /initial/.test(P('ptrMoney')), P('ptrMoney').slice(0, 500));
    const wt = wantMoney.body.totals;
    ok('cash in the drawer is counted apart from anything paid online',
      S('ptrMoney').includes(peso(wt.collected)) && S('ptrMoney').includes('cash in drawers ' + peso(wt.cashInDrawer))
      && S('ptrMoney').includes('paid online or otherwise ' + peso(wt.onlineAndOther)), S('ptrMoney'));
    ok('nothing painted says undefined, NaN or [object',
      [P('ptrPolicy'), P('ptrProposed'), P('ptrDebt'), P('ptrMoney'), S('ptrPolicy'), S('ptrDebt'), S('ptrMoney')].every((h) => !/undefined|NaN|\[object/.test(h)),
      [P('ptrPolicy'), P('ptrProposed'), P('ptrDebt'), P('ptrMoney')].filter((h) => /undefined|NaN|\[object/.test(h)));
    const onClick = () => dom.get('payment-terms').listeners.click;
    const proposedNow = async () => (await call('finance', 'GET', '/api/finance/quotes')).body.filter((q) => (q.terms || {}).state === 'proposed');

    console.log('\n2. a decision made on the row is the decision the server accepts');
    const shortRow = fakeRow({ note: 'no' }, { quote: noA });
    await onClick()(clickOn('[data-refuse]', shortRow));
    await settle();
    ok('a refusal without a proper note is answered on the row and nothing is sent',
      /at least 5 characters/.test(shortRow.err.textContent) && (await proposedNow()).length === 1 && (await proposedNow())[0].id === noA,
      shortRow.err.textContent);

    const aRow = fakeRow({ note: 'Signed by the manager' }, { quote: noA });
    await onClick()(clickOn('[data-approve]', aRow));
    await settle(); await settle(); await settle();
    const approvedA = (await call('finance', 'GET', '/api/finance/quotes')).body.find((q) => q.id === noA);
    ok('approving sends the proposed key and percentage through the Finance route',
      approvedA && approvedA.terms.state === 'approved' && approvedA.terms.key === 'half' && approvedA.terms.percent === 50
      && approvedA.terms.amount === 4500 && approvedA.terms.balance === 4500 && approvedA.terms.decidedAt > 0, approvedA && approvedA.terms);
    ok('the decision is attributed to the person who made it, on both screens',
      approvedA.terms.decidedBy === 'Test Finance'
      && (await call('cashier', 'GET', '/api/pos/quote-desk/' + noA)).body.terms.decidedBy === 'Test Finance',
      { finance: approvedA.terms.decidedBy });
    ok('…and the row leaves the waiting list when the screen reloads',
      !P('ptrProposed').includes(noA), P('ptrProposed').slice(0, 200));

    // the desk read above was made as the cashier, and a screen left open while the session changes would be sent
    // back to the login page — sign in as Finance again before the next click
    await call('finance', 'GET', '/api/finance/payment-terms');
    const halfRow = fakeRow({ enabled: false, retailAllowed: true, madeToOrderAllowed: true, basis: 'percent', percent: '50', fixedAmount: '',
      balanceCondition: 'balance due before the order is released', note: 'Paused while stock is short' }, { term: 'half' });
    await onClick()(clickOn('[data-save]', halfRow));
    await settle(); await settle();
    const halfNow = (await call('finance', 'GET', '/api/finance/payment-terms')).body.terms.find((t) => t.key === 'half');
    ok('switching a term off is saved, confirmed by the server answer', halfNow && halfNow.enabled === false, halfNow);
    ok('…and the screen repaints from that answer, not from what was typed',
      !/Half Payment/.test(S('ptrPolicy')) && /is no longer offered/.test(dom.toasts.join('|')), { status: S('ptrPolicy'), toasts: dom.toasts });

    console.log('\n3. what the screen refuses to do');
    const badScope = fakeRow({ enabled: true, retailAllowed: false, madeToOrderAllowed: false, basis: 'percent', percent: '50',
      balanceCondition: 'x', note: 'Long enough note' }, { term: 'down' });
    await onClick()(clickOn('[data-save]', badScope));
    await settle();
    const downNow = (await call('finance', 'GET', '/api/finance/payment-terms')).body.terms.find((t) => t.key === 'down');
    ok('a term switched on for no order type is stopped on the row before it reaches the server',
      /Say which orders this term covers/.test(badScope.err.textContent) && downNow.enabled === false, badScope.err.textContent);
    const noWhy = fakeRow({ enabled: true, retailAllowed: true, madeToOrderAllowed: false, basis: 'percent', percent: '30',
      balanceCondition: 'before release', note: '' }, { term: 'down' });
    await onClick()(clickOn('[data-save]', noWhy));
    await settle();
    ok('switching a partial term on without a reason is stopped too, because it must be auditable',
      /audit log/.test(noWhy.err.textContent) && (await call('finance', 'GET', '/api/finance/payment-terms')).body.terms.find((t) => t.key === 'down').enabled === false,
      noWhy.err.textContent);
    const fullRow = fakeRow({ enabled: true, balanceCondition: 'paid in full before release', note: 'The default, always on' }, { term: 'full' });
    await onClick()(clickOn('[data-save]', fullRow));
    await settle();
    const fullNow = (await call('finance', 'GET', '/api/finance/payment-terms')).body.terms.find((t) => t.key === 'full');
    ok('saving the Full Payment row cannot take the default away from any order type',
      fullNow && fullNow.enabled === true && fullNow.percent === 100 && fullNow.retailAllowed === true && fullNow.madeToOrderAllowed === true, fullNow);
    const termRows = await call('cashier', 'GET', '/api/finance/payment-terms');
    ok('none of this is available to anyone but Finance', termRows.status === 403, termRows.status);

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
  } finally {
    child.kill();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
