/* quote-desk-ui.js — the Cashier Quotation Desk screen (POS_Cashier.html > Quotations).
   Talks to GET /api/pos/quote-desk (search, filters, sorting, pagination and facet counts are done by the server),
   to GET/POST /api/pos/quote-desk/:no[...] for one quotation, its reference files and the order conversion, and reuses
   the existing /api/pos/quotes/:no/clarifications | /price | /respond routes for the life-cycle itself.
   Expects the page globals: $, api, esc, peso, toast, PRODUCTS, prod, showPage, QuoteFields. */
(function () {
  'use strict';

  const PAGE_SIZES = [10, 20, 50, 100];
  const FILTERS = [['all', 'All requests'], ['open', 'Needs my action'], ['approval', 'With Finance'], ['quoted', 'Quote ready'], ['active', 'Accepted'], ['done', 'Closed']];
  const SOURCES = [['all', 'Online + walk-in'], ['shop', 'Online only'], ['pos', 'Walk-in only']];
  const CLARIFY = [['dimensions', 'Size / dimensions'], ['thickness', 'Thickness'], ['material', 'Material / grade'], ['finish', 'Surface finish'], ['quantity', 'Quantity / unit'], ['other', 'Other detail']];

  const S = { rows: [], total: 0, pageCount: 1, page: 1, pageSize: 10, counts: {}, sort: 'created', dir: 'desc', filter: 'open', source: 'all', q: '', busy: false, error: '', detail: null, openPrice: false, openTerms: false, view: 'requests' };
  const desk = (p) => '/api/pos/quote-desk' + p;
  const el = (id) => document.getElementById(id);
  const day = (v) => (!v ? '—' : new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }));
  const shortDay = (v) => (!v ? '—' : new Date(v).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }));
  const money = (v) => (v == null || !Number.isFinite(Number(v)) ? null : peso(Number(v)));
  const neededText = (r) => (r.neededBy ? shortDay(r.neededBy) : r.flexibleDate ? 'Flexible' : r.neededMonths ? 'Within ' + r.neededMonths + ' mo' : 'Not set');
  const pillClass = (r) => (r.expired || ['declined', 'closed'].includes(r.status) ? 'bad' : ['new', 'awaiting_details', 'pending_approval'].includes(r.status) ? 'warn' : 'ok');
  const qtyParts = (text) => { const m = /^([\d,.]+)\s+(.+)$/.exec(String(text || '').trim()); if (!m) return null; const n = Number(m[1].replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? { qty: n, unit: m[2] } : null; };
  const requestId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 32) : 'qd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 14));
  const fieldErr = (e) => (e && e.fields ? Object.values(e.fields)[0] : e && e.message) || 'Something went wrong. Try again.';
  function liveDeskField(input) {
    if (!window.FormAssist || !input.matches?.('input, select, textarea')) return;
    const value = input.value.trim(), n = Number(value.replace(/,/g, '')), form = input.form;
    let message = null;
    if (input.name === 'unit' && form?.id === 'qdPriceForm') {
      message = !/^\d+(?:\.\d{1,2})?$/.test(value) || n <= 0 ? 'Enter the unit price in pesos, up to two decimals.' : '';
      const q = qtyParts(S.detail?.quantity), margin = rulesNow()?.minMarginPct || 20;
      const floor = S.draft?.costTotal > 0 ? Math.round(S.draft.costTotal / (1 - margin / 100) * 100) / 100 : 0;
      if (!message && q && Math.round(n * q.qty * 100) / 100 < floor - 0.004) message = 'Price cannot be below the ' + margin + '% margin floor (' + peso(floor) + ' total).';
    }
    if (input.matches('[data-rqty]')) message = /^\d+(?:\.\d+)?$/.test(value.replace(/,/g, '')) && n > 0 ? '' : 'Enter a quantity per piece greater than zero.';
    if (form?.id === 'qdCollectForm' && input.name === 'amount') message = !/^\d+(?:\.\d{1,2})?$/.test(value) || n <= 0 ? 'Enter an amount greater than zero, up to two decimals.' : n > Number(S.detail?.balance) + 0.004 ? 'The balance is only ' + money(S.detail.balance) + '.' : '';
    if (form?.id === 'qdCollectForm' && input.name === 'reference') message = form.elements.method.value !== 'Cash' && value.length < 4 ? 'Enter the reference (at least 4 characters).' : '';
    if (input.matches('[data-jsku]')) {
      const m = S.job?.materials?.find(x => x.sku === input.dataset.jsku);
      message = value && (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value.replace(/,/g, '')) || n < 0) ? 'Use a quantity of 0 or more, with at most 2 decimals.' : m && n > Number(m.onHand) ? 'Only ' + m.onHand + ' ' + m.unit + ' in stock.' : '';
    }
    if (input.matches('[data-recv]')) message = value.length < 2 || value.length > 80 ? 'Enter the recipient’s name (2–80 characters).' : '';
    if (message !== null) FormAssist.validation.show(input, message);
    return message;
  }
  async function call(path, opts) {
    try { return await api(path, opts); }
    catch (e) {                                          // api() throws a plain Error; keep the server's per-field message
      const body = e && e.fields ? e : null;
      throw Object.assign(new Error(body ? Object.values(body.fields)[0] : e.message), { fields: body && body.fields });
    }
  }

  /* ================= 1. the two views ================= */
  function showView(which) {
    S.view = which === 'walkin' ? 'walkin' : 'requests';
    el('qdRequestsView').hidden = S.view !== 'requests';
    el('qdWalkinView').hidden = S.view !== 'walkin';
    el('qdTabRequests').setAttribute('aria-selected', String(S.view === 'requests'));
    el('qdTabWalkin').setAttribute('aria-selected', String(S.view === 'walkin'));
    if (S.view === 'walkin') ensureFields(); else loadDesk();
  }

  /* ================= 2. the request queue ================= */
  function listUrl() {
    const p = ['sort=' + encodeURIComponent(S.sort), 'dir=' + encodeURIComponent(S.dir), 'status=' + encodeURIComponent(S.filter),
      'source=' + encodeURIComponent(S.source), 'page=' + S.page, 'pageSize=' + S.pageSize];
    if (S.q.trim()) p.push('q=' + encodeURIComponent(S.q.trim()));
    return desk('?' + p.join('&'));
  }
  async function loadDesk() {
    if (S.busy) return;
    S.busy = true; S.error = '';
    renderList();
    try {
      const r = await call(listUrl());
      S.rows = r.rows || []; S.total = r.total || 0; S.pageCount = r.pageCount || 1; S.page = r.page || 1; S.pageSize = r.pageSize || 20;
      S.counts = r.counts || {}; S.sort = r.sort; S.dir = r.dir; S.filter = r.filter; S.source = r.source;
      const ready = S.counts.quoted || 0;
      el('navQuoteCount').textContent = ready; el('navQuoteCount').hidden = !ready;
      el('navQuoteCount').title = ready + ' quote(s) ready to tell the customer';
      el('pqRequestCount').textContent = (S.counts.open || 0) + (S.counts.approval || 0);
    } catch (e) {
      S.rows = []; S.error = e instanceof TypeError ? 'No connection to the server. Check your network and try again.' : fieldErr(e);
    }
    S.busy = false;
    renderList(); renderPager();
  }
  function tableHeads() {
    const cols = [['ref', 'Reference', 'reference'], ['customer', 'Customer', 'customer'], ['product', 'Product', 'product'],
      ['qty', 'Quantity', null], ['needed', 'Needed by', 'needed'], ['amount', 'Quoted amount', 'amount'],
      ['requested', 'Requested', 'created'], ['status', 'Status', 'status'], ['source', 'Source', null], ['act', '', null]];
    return '<tr>' + cols.map(([k, label, sort]) => {
      const on = sort && S.sort === sort;
      return '<th' + (sort ? ' data-sort="' + sort + '"' : '') + (on ? ' aria-sort="' + (S.dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + ' scope="col">' +
        label + (sort ? '<span class="qd-arrow">' + (on ? (S.dir === 'asc' ? '▲' : '▼') : '↕') + '</span>' : '') + '</th>';
    }).join('') + '</tr>';
  }
  function rowCells(r) {
    const amt = money(r.amount);
    return '<td><span class="qd-ref">' + esc(r.id) + '</span></td>' +
      '<td><div class="qd-who"><b>' + esc(r.customer || '—') + '</b><small>' + esc(r.phone || '') + (r.company ? ' · ' + esc(r.company) : '') + '</small></div></td>' +
      '<td><div class="qd-what"><b>' + esc(r.product || 'Custom item') + '</b><small>' + (r.sku ? esc(r.sku) + ' · catalog' : 'custom specification') + '</small></div></td>' +
      '<td class="qd-num">' + esc(r.quantity || '—') + '</td>' +
      '<td>' + neededText(r) + '</td>' +
      '<td class="qd-num">' + (amt || (r.proposedAmount != null ? 'proposed ' + money(r.proposedAmount) : '—')) + '</td>' +
      '<td>' + day(r.requestDate) + '</td>' +
      '<td><span class="qd-pill ' + pillClass(r) + '">' + esc(r.statusLabel || r.status) + '</span>' + (r.financeNote && r.status === 'new' ? '<small class="qd-back">Sent back by Finance</small>' : '') + '</td>' +
      '<td><span class="qd-src ' + (r.source === 'pos' ? 'pos' : '') + '">' + (r.source === 'pos' ? 'Walk-in' : 'Online') + '</span></td>' +
      '<td class="is-right"><button type="button" class="qd-open" data-open="' + esc(r.id) + '">Open</button></td>';
  }
  function cardRow(r) {
    const amt = money(r.amount);
    return '<div class="qd-qcard" data-open="' + esc(r.id) + '" tabindex="0" role="button" aria-label="Open quotation ' + esc(r.id) + '">' +
      '<div class="qd-line"><span class="qd-ref">' + esc(r.id) + '</span><span class="qd-pill ' + pillClass(r) + '">' + esc(r.statusLabel || r.status) + '</span></div>' +
      '<div class="qd-who"><b>' + esc(r.customer || '—') + '</b><small>' + esc(r.phone || '') + '</small></div>' +
      '<div class="qd-what"><b>' + esc(r.product || 'Custom item') + '</b><small>' + esc(r.quantity || '') + ' · needed ' + neededText(r) + '</small></div>' +
      '<div class="qd-line"><span class="qd-mut">' + (r.source === 'pos' ? 'Walk-in' : 'Online') + ' · ' + day(r.requestDate) + '</span>' +
      '<span class="qd-num">' + (amt || (r.proposedAmount != null ? 'proposed ' + money(r.proposedAmount) : '—')) + '</span></div></div>';
  }
  function renderList() {
    const bar = el('qdChips');
    if (bar) bar.innerHTML = FILTERS.map(([k, label]) => '<button type="button" class="qd-chip' + (S.filter === k ? ' on' : '') + '" data-filter="' + k + '" aria-pressed="' + (S.filter === k) + '">' +
      label + '<em>' + (S.counts[k] != null ? S.counts[k] : 0) + '</em></button>').join('');
    const head = el('qdHead'); if (head) head.innerHTML = tableHeads();
    const body = el('qdBody'), cards = el('qdCards');
    if (S.busy) { if (body) body.innerHTML = ''; if (cards) cards.innerHTML = ''; el('qdState').hidden = false; el('qdState').className = 'qd-state';
      el('qdState').innerHTML = '<div class="qd-skeleton"></div><div class="qd-skeleton" style="margin-top:10px"></div><div class="qd-skeleton" style="margin-top:10px"></div><p style="margin:14px 0 0">Loading quotations…</p>'; el('qdTablewrap').style.display = 'none'; return; }
    if (S.error) { el('qdState').hidden = false; el('qdState').className = 'qd-state error';
      el('qdState').innerHTML = '<strong>Could not load the quotation list.</strong><p>' + esc(S.error) + '</p><button type="button" class="btn-secondary qd-retry" data-retry>Try again</button>';
      el('qdTablewrap').style.display = 'none'; if (cards) cards.innerHTML = ''; return; }
    el('qdState').hidden = true;
    if (!S.rows.length) { el('qdTablewrap').style.display = 'none'; if (cards) cards.innerHTML = '';
      el('qdState').hidden = false; el('qdState').className = 'qd-state'; el('qdState').textContent = 'No quotation matches this search or filter.'; return; }
    el('qdTablewrap').style.display = '';
    if (body) body.innerHTML = S.rows.map((r) => '<tr data-open="' + esc(r.id) + '" tabindex="0">' + rowCells(r) + '</tr>').join('');
    if (cards) cards.innerHTML = S.rows.map(cardRow).join('');
    el('qdNote').textContent = 'Showing page ' + S.page + ' of ' + S.pageCount + ' · ' + S.total + ' quotation' + (S.total === 1 ? '' : 's') + ' in this filter';
  }
  function renderPager() {
    const box = el('qdPager'); if (!box) return;
    box.innerHTML = '<span>' + (S.total ? 'Quotations are newest first unless you sort another column.' : '') + '</span>' +
      '<span class="qd-pager-btns"><button type="button" class="btn-secondary btn-sm" data-page="prev"' + (S.page <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span style="align-self:center">Page ' + S.page + ' / ' + S.pageCount + '</span>' +
      '<button type="button" class="btn-secondary btn-sm" data-page="next"' + (S.page >= S.pageCount ? ' disabled' : '') + '>Next</button></span>';
  }

  /* ================= 3. one quotation in a drawer ================= */
  async function openDetail(no) {
    el('qdScrim').hidden = false; el('qdDrawer').hidden = false;
    void el('qdDrawer').offsetWidth;                                       // flush layout so the slide starts off-screen; rAF never fires in a background tab
    el('qdScrim').classList.add('open'); el('qdDrawer').classList.add('open');
    el('qdDrawerTitle').textContent = no; el('qdDrawerSub').textContent = 'Loading…';
    el('qdDrawerBody').innerHTML = '<div class="qd-skeleton"></div><div class="qd-skeleton" style="margin-top:12px"></div><div class="qd-skeleton" style="margin-top:12px"></div>';
    el('qdDrawerFoot').innerHTML = '';
    document.body.style.overflow = 'hidden';
    try { S.detail = await call(desk('/' + encodeURIComponent(no))); S.openPrice = false; S.openTerms = false; renderDetail(); }
    catch (e) { S.detail = null; el('qdDrawerBody').innerHTML = '<div class="qd-callout bad">Could not open this quotation: ' + esc(fieldErr(e)) + '</div>'; }
  }
  function closeDetail() {
    S.detail = null;
    el('qdScrim').classList.remove('open'); el('qdDrawer').classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => { el('qdScrim').hidden = true; el('qdDrawer').hidden = true; }, 240);
  }
  const kv = (pairs) => '<dl class="qd-kv">' + pairs.filter((p) => p[1] !== null && p[1] !== undefined && p[1] !== '').map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
  const sec = (title, inner) => '<section class="qd-sec"><h4>' + esc(title) + '</h4>' + inner + '</section>';

  const row = (label, value) => [label, value];
  const noteBox = (text) => '<div class="qd-note-box">' + esc(text) + '</div>';

  function renderDetail() {
    const d = S.detail; if (!d) return;
    el('qdDrawerSub').textContent = (d.statusLabel || d.status) + ' · ' + (d.source === 'pos' ? 'Walk-in at the counter' : 'Online request');
    const sp = d.specs || {};
    const payWhere = d.payMethod || (d.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at pickup');
    const parts = [
      sec('Customer', kv([
        row('Name', '<b>' + esc(d.customer || '—') + '</b>'),
        row('Mobile', esc(d.phone || '—')),
        row('Email', esc(d.contactEmail || d.email || 'not given')),
        row('Company', esc(d.company || '—')),
        row('Requested by', esc(d.createdBy || (d.source === 'pos' ? 'this counter' : 'the customer'))),
        row('Online account', d.customerId ? 'yes — only the customer can answer here' : 'no, a walk-in request at this counter')])),

      sec('What they need', kv([
        row('Item', '<b>' + esc(d.product || 'Custom item') + '</b>' + (d.sku ? ' <span class="dim">· catalog ' + esc(d.sku) + '</span>' : ' <span class="dim">· custom specification</span>')),
        row('Quantity', esc(d.quantity || '—')),
        row('Item type', esc(sp.itemType || (d.sku ? 'Ready-made catalog product (sold by ' + ((d.quantity || '').split(' ').slice(1).join(' ') || 'pcs') + ')' : '—'))),
        row('Material', esc(sp.material || '—')),
        row('Size', esc(sp.size || '—')),
        row('Thickness', esc(sp.thickness || '—')),
        row('Finish', esc(sp.finish || '—')),
        row('Machining / secondary work', esc(sp.service || '—')),
        row('Needed by', neededText(d)),
        row('Customer notes', d.details ? noteBox(d.details) : '') ])),

      sec('How they want it', kv([
        row('Fulfilment', esc(d.fulfillment || '—')),
        row('Delivery area', esc(d.area || '—')),
        row('Where they pay', esc(payWhere)) ])),

      sec('Price', kv([
        d.costStale ? row('Cost changed', '<span class="qd-pill warn">Check the price</span> ' + esc(d.costStale)) : '',
        row('Quoted amount', money(d.amount) || '—'),
        row('Paid so far', money(d.paidAmount) || '₱0.00'),
        row('Balance', d.balance != null ? money(d.balance) : '—'),
        row('Estimated availability', esc(d.leadTime || '—')),
        row('Estimated ready date', d.estimatedReady ? '<b>' + esc(day(d.estimatedReady)) + '</b> <span class="dim">· ' + (d.readyFromAcceptance ? 'counted from the day the customer accepted' : 'if the customer accepts today') + '</span>' + (d.lateForNeededBy ? ' <span class="qd-pill warn">later than the date they need it</span>' : '') : '—'),
        row('Price valid until', d.validUntil ? day(d.validUntil) + (d.expired ? ' <span class="qd-pill bad">expired</span>' : '') : '—'),
        row('Finance approval', d.status === 'pending_approval'
            ? '<span class="qd-pill warn">Waiting for Finance</span> ' + (d.proposedAmount != null ? 'your price ' + money(d.proposedAmount) + ' · ' : '') + esc(d.approvalReason || '')
          : d.financeNote && d.status === 'new' ? '<span class="qd-pill bad">Sent back by Finance</span> ' + esc(d.financeNote) + (d.proposedAmount != null ? ' <span class="dim">· your price was ' + money(d.proposedAmount) + '</span>' : '')
          : d.approvalReason && d.amount != null ? '<span class="qd-pill ok">Approved by Finance</span> ' + esc(d.approvalReason)
          : 'not needed'),
        row('Closed because', d.status === 'closed' && d.closeReason ? '<span class="qd-pill bad">Closed by Finance</span> ' + esc(d.closeReason) : ''),
        row('Note to customer', d.replyNote ? noteBox(d.replyNote) : ''),
        row('Customer answer', d.responseNote ? noteBox(d.responseNote) : '') ])),

      sec('Payment terms on this quotation', termsSectionHtml(d)),
      collectHtml(d),
      sec('History', timelineHtml(d)),
      d.orderNo ? sec('Converted', '<div class="qd-callout ok">This quotation became order <b>' + esc(d.orderNo) + '</b>. A quotation is not a reservation: stock leaves inventory only at the sale or order-confirm step.</div>') : '',
      productionHtml(d),
      sec('Pricing', priceFormHtml(d))
    ];
    el('qdDrawerBody').innerHTML = parts.filter(Boolean).join('');
    el('qdDrawerFoot').innerHTML = footHtml(d);
    // fill the term lists from the policy once the markup exists — the amounts must come from the server
    const q = qtyParts(d.quantity);
    if (S.openPrice) {
      const form = el('qdPriceForm'), unit = form && form.querySelector('[name=unit]');
      const total = unit && unit.value && q ? Number(unit.value) * q.qty : (d.proposedAmount != null ? d.proposedAmount : d.amount);
      loadTermOptions(form, total, (d.terms || {}).key);
      if (form && unit && unit.value && q) { const t = form.querySelector('[data-total]'); if (t) t.textContent = peso(total); syncRoute(form, total); }
      if (form && form.elements.leadTime && form.elements.leadTime.value) updateReady(form);
      loadSystemPrice(d, form);
    }
    if (S.openTerms) loadTermOptions(el('qdTermsForm'), d.amount != null ? d.amount : d.proposedAmount, (d.terms || {}).key);
    if (el('qdDrawerBody').querySelector('[data-job]')) loadJob(d);
  }
  function timelineHtml(d) {
    const items = (d.clarifications || []).map((c) => '<div class="qd-tl-item ' + (c.status === 'answered' ? 'done' : 'wait') + '">' +
      '<b>Clarification ' + (c.status === 'answered' ? 'answered' : 'waiting for the customer') + '</b><time>' + day(c.createdAt) + '</time>' +
      '<p>' + esc((c.fields || []).join(', ')) + ' — ' + esc(c.message) + '</p>' +
      (c.response ? '<p><b>Customer replied:</b> ' + esc(c.response) + '</p>' : '') +
      (c.submittedSpecs ? '<p><b>New details:</b> ' + esc(Object.entries(c.submittedSpecs).map(([k, v]) => k + ': ' + v).join(' · ')) + '</p>' : '') +
      '</div>');
    (d.progress || []).forEach((p) => items.push('<div class="qd-tl-item done"><b>' + esc(p.label || p.status) + '</b><time>' + day(p.at) + '</time>' + (p.note ? '<p>' + esc(p.note) + '</p>' : '') + '</div>'));
    (d.notes || []).slice(0, 8).forEach((n) => items.push('<div class="qd-tl-item"><b>' + esc(n.action) + '</b><time>' + day(n.at) + ' · ' + esc(n.by || '') + '</time><p>' + esc(n.detail) + '</p></div>'));
    return items.length ? '<div class="qd-tl">' + items.join('') + '</div>' : '<p class="qd-mut dim" style="margin:0">Nothing has happened on this request yet.</p>';
  }
  /* ---- Task 4: the quick recipe and the system price. Every sum is done by the server (quote-automation.js):
     cost per piece = materials x their current cost, suggested price = cost x (1 + markup), margin, stock needed vs on hand.
     The suggested price per piece pre-fills the unit price and follows every change until the cashier types their own. ---- */
  const num4 = (n) => (+Number(n).toFixed(4)).toLocaleString('en-PH', { maximumFractionDigits: 4 });
  let draftSeq = 0, draftTimer = null;
  const linesFrom = (e) => (Array.isArray(e && e.lines) && !e.catalog ? e.lines.map((l) => ({ sku: l.sku, qtyPerPiece: l.recipeQty, unit: l.recipeUnit })) : null);
  async function loadSystemPrice(d, form) {
    const box = form && form.querySelector('[data-sys]'); if (!box) return;
    let e;
    try { e = await call('/api/pricing/quote/' + encodeURIComponent(d.id)); } catch (err) { box.innerHTML = '<p class="q-hint">The system price could not be worked out: ' + esc(fieldErr(err)) + '</p>'; return; }
    if (!box.isConnected) return;
    S.rules = e.approvalRules || (window.PQ_OPTIONS || {}).approvalRules || null;
    S.recipeMode = 'saved'; S.lines = linesFrom(e); S.recipeEditedBy = e.editedBy || null; S.recipeAuto = e.auto !== false;
    if (!e.catalog && !e.missing && !S.mats) { try { S.mats = await call('/api/pricing/materials'); } catch (_) { S.mats = []; } }
    if (!box.isConnected) return;
    box.innerHTML = '<div data-sum></div>' + (e.catalog || e.missing ? '' : '<div data-recipe></div>');
    renderRecipe(form); showDraft(form, e);
  }
  function showDraft(form, e) {
    S.draft = e;
    const sum = form.querySelector('[data-sum]'); if (!sum) return;
    sum.innerHTML = draftSummaryHtml(e);
    fillUnit(form);
    const unit = form.querySelector('[name=unit]'), q = qtyParts(S.detail && S.detail.quantity);
    syncRoute(form, unit && q && /^\d+(\.\d{1,2})?$/.test(unit.value.trim()) ? Number(unit.value) * q.qty : 0);
  }
  function draftSummaryHtml(e) {
    if (e.missing) return '<p class="q-hint">No system price yet: the request does not give the ' + esc(e.missing.join(', ')) + '.</p>';
    const rows = (e.lines || []).map((l) => '<tr><td>' + esc(l.name || l.sku) + (l.estimate ? ' <span class="dim">estimate</span>' : '') + '</td>' +
      '<td class="qd-num">' + (l.qtyPerPiece != null ? num4(l.qtyPerPiece) + ' ' + esc(l.unit) : '\u2014') + '</td>' +
      '<td class="qd-num">' + (l.needed != null ? num4(l.needed) + ' ' + esc(l.unit) : '\u2014') + '</td>' +
      '<td class="qd-num">' + num4(l.onHand || 0) + '</td>' +
      '<td>' + (l.short > 0 ? '<span class="qd-pill bad">short by ' + num4(l.short) + ' ' + esc(l.unit) + '</span>' : l.needed != null ? '<span class="qd-pill ok">in stock</span>' : '\u2014') + '</td>' +
      '<td class="qd-num">' + (l.costPerPiece != null ? peso(l.costPerPiece) : '<span class="qd-pill bad">no cost</span>') + '</td></tr>').join('');
    const table = rows ? '<div class="qd-sys-tablewrap"><table class="qd-sys-table"><thead><tr><th>Material</th><th class="qd-num">Per piece</th><th class="qd-num">For ' + esc(e.quantity) + '</th><th class="qd-num">On hand</th><th>Stock</th><th class="qd-num">Cost / pc</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '';
    if (!e.ok) return '<div class="qd-sys-head"><span>System price</span><strong>Cannot price yet</strong></div>' +
      '<div class="qd-callout bad">' + esc((e.problems || []).map((p) => p.message).join(' ')) + '</div>' + table;
    return '<div class="qd-sys-head"><span>Suggested price <span class="dim">(cost \u00D7 ' + (1 + e.markupPct / 100).toFixed(2) + ')</span></span><strong>' + peso(e.total) + '</strong></div>' + table +
      kv([['Cost per piece', peso(e.costPerPiece)], ['Total cost', peso(e.costTotal)], ['Suggested per piece', '<b>' + peso(e.pricePerPiece) + '</b>'], ['Margin', esc(e.marginPct) + '%'],
        ['Stock check', (e.shortfalls || []).length ? '<span class="qd-pill bad">short</span> ' + esc(e.shortfalls.map((s) => s.name + ' short by ' + num4(s.short) + ' ' + s.unit).join('; ')) : '<span class="qd-pill ok">covers the quantity</span>']]) +
      ((e.notes || []).length ? '<p class="q-hint">' + esc(e.notes.join(' ')) + '</p>' : '') +
      (e.catalog ? '' : '<p class="q-hint">Materials only, at today\u2019s costs. The weight per piece (' + esc(e.weightKg) + ' kg) is an estimate; correct the lines below if you know better.</p>') +
      '<button type="button" class="btn-secondary btn-sm" data-use-sys>Use the suggested price</button>';
  }
  function matOptions(sku) {
    const m = S.mats || [];
    return '<option value="">Choose a material\u2026</option>' + ['Raw Materials', 'Finishing Supplies'].map((dep) => '<optgroup label="' + dep + '">' +
      m.filter((x) => x.department === dep).map((x) => '<option value="' + esc(x.sku) + '"' + (x.sku === sku ? ' selected' : '') + '>' + esc(x.name) + ' (' + esc(x.sku) + ')' + (x.unitCost == null ? ' \u00B7 no cost' : '') + '</option>').join('') + '</optgroup>').join('');
  }
  function renderRecipe(form) {
    const box = form && form.querySelector('[data-recipe]'); if (!box) return;
    const lines = S.lines || [], editable = ['new', 'pending_approval'].includes((S.detail || {}).status);
    const units = (sku) => ((S.mats || []).find((x) => x.sku === sku) || {}).units || [];
    box.innerHTML = '<div class="qd-recipe"><div class="qd-recipe-head"><b>Quick recipe, per piece</b><span class="dim">' +
      (S.recipeMode === 'edited' ? 'changed by you \u2014 saved when you confirm the price' : S.recipeMode === 'auto' ? 'back to the automatic guess \u2014 saved when you confirm' :
        S.recipeAuto ? 'automatic first guess (estimate)' : 'adjusted on this quote' + (S.recipeEditedBy ? ' by ' + esc(S.recipeEditedBy) : '')) + '</span></div>' +
      lines.map((l, i) => '<div class="qd-rline" data-i="' + i + '"><select data-rsku aria-label="Material"' + (editable ? '' : ' disabled') + '>' + matOptions(l.sku) + '</select>' +
        '<input data-rqty inputmode="decimal" aria-label="Quantity per piece" value="' + esc(l.qtyPerPiece == null ? '' : l.qtyPerPiece) + '"' + (editable ? '' : ' disabled') + '>' +
        '<select data-runit aria-label="Unit"' + (editable ? '' : ' disabled') + '>' + (units(l.sku).length ? units(l.sku) : [l.unit || '']).map((u) => '<option' + (String(u).toLowerCase() === String(l.unit || '').toLowerCase() ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select>' +
        (editable ? '<button type="button" class="btn-secondary btn-sm" data-rdel aria-label="Remove this material">\u00D7</button>' : '') + '</div>').join('') +
      (editable ? '<div class="qd-recipe-actions"><button type="button" class="btn-secondary btn-sm" data-radd>+ Add material</button>' +
        (S.recipeMode === 'edited' || !S.recipeAuto ? '<button type="button" class="btn-secondary btn-sm" data-rauto>Back to the automatic guess</button>' : '') + '</div>' : '') + '</div>';
  }
  function readRecipe(form) {
    S.lines = Array.from(form.querySelectorAll('.qd-rline')).map((r) => ({ sku: r.querySelector('[data-rsku]').value, qtyPerPiece: r.querySelector('[data-rqty]').value.replace(/,/g, '').trim(), unit: r.querySelector('[data-runit]').value }));
  }
  const validLines = () => (S.lines || []).filter((l) => l.sku && /^\d+(\.\d+)?$/.test(String(l.qtyPerPiece)) && Number(l.qtyPerPiece) > 0);
  function recalcDraft(form) {
    clearTimeout(draftTimer);
    const sum = form.querySelector('[data-sum]'); if (sum) sum.style.opacity = '.55';
    draftTimer = setTimeout(async () => {
      const d = S.detail; if (!d) return;
      const sp = d.specs || {}, my = ++draftSeq;
      try {
        const e = await call('/api/pricing/quote-estimate', { method: 'POST', body: JSON.stringify({ itemType: sp.itemType, specs: sp, quantity: d.quantity, productSku: d.sku || undefined,
          lines: S.recipeMode === 'auto' && !S.lines ? undefined : validLines() }) });
        if (my !== draftSeq || !form.isConnected) return;
        if (!S.lines) { S.lines = linesFrom(e) || []; renderRecipe(form); }
        showDraft(form, e);
      } catch (err) { if (my === draftSeq && sum && sum.isConnected) sum.innerHTML = '<div class="qd-callout bad">' + esc(fieldErr(err)) + '</div>'; }
      if (sum && sum.isConnected) sum.style.opacity = '';
    }, 300);
  }
  // the suggested price stays in the unit price box until the cashier types their own (data-auto="1" while untouched)
  function fillUnit(form) {
    const u = form.querySelector('[name=unit]'); if (!u || u.dataset.auto !== '1') return;
    u.value = S.draft && S.draft.ok ? Number(S.draft.pricePerPiece).toFixed(2) : '';
    S.fillingUnit = true; u.dispatchEvent(new Event('input', { bubbles: true })); S.fillingUnit = false;
  }
  function matchLeadTimeForNeededBy(neededBy) {
    if (!neededBy) return '';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    if (neededBy < today) return '';
    let cur = new Date(today + 'T00:00:00Z'), target = new Date(neededBy + 'T00:00:00Z');
    let workdays = 0;
    while (cur < target) {
      cur = new Date(cur.getTime() + 86400000);
      const w = cur.getUTCDay();
      if (w !== 0 && w !== 6) workdays++;
    }
    const o = window.PQ_OPTIONS || {};
    const map = o.leadWorkdays || { '1 to 3 working days': 3, '1 week': 5, '2 weeks': 10, '3 weeks': 15, '1 month': 22, '2 months': 44, '3 months': 66, '4 to 6 months': 132 };
    const entries = Object.entries(map).sort((a, b) => a[1] - b[1]);
    let best = '';
    for (const [k, days] of entries) {
      if (days <= workdays) best = k;
    }
    return best || (entries[0] ? entries[0][0] : '');
  }

  function priceFormHtml(d) {
    const can = ['new', 'pending_approval', 'awaiting_details'].includes(d.status);
    if (!can) return d.status === 'awaiting_details' ? '<div class="qd-callout warn">Waiting for the customer to send the missing details. Pricing opens as soon as they reply.</div>' : '';
    if (!S.openPrice) return ['new', 'pending_approval'].includes(d.status)
      ? '<button type="button" class="btn-secondary" data-act="price">' + (d.status === 'pending_approval' ? 'Edit and resubmit the price' : 'Prepare a price') + '</button>'
      : '<p class="q-hint">Pricing is only possible while the request is pending cashier review or waiting for Finance; ' + esc(d.statusLabel || d.status) + ' requests are handled from the buttons below.</p>';
    const o = window.PQ_OPTIONS || {}, q = qtyParts(d.quantity) || {};
    const back = d.financeNote && d.status === 'new' ? '<div class="qd-callout warn">Finance sent your price back: <b>' + esc(d.financeNote) + '</b>. Change the price and send it again.</div>' : '';
    const unit = d.proposedAmount != null && q.qty ? (d.proposedAmount / q.qty).toFixed(2) : '';
    const autoLead = d.leadTime || (d.neededBy ? matchLeadTimeForNeededBy(d.neededBy) : '');
    return back + '<form class="qd-price" id="qdPriceForm" novalidate>' +
      '<div class="qd-sys wide" data-sys><p class="q-hint">Working out the materials and the suggested price\u2026</p></div>' +
      '<label>Unit price (PHP) <span class="dim" data-unit-note>' + (unit ? 'your earlier price' : 'filled in with the suggested price') + '</span><input name="unit" type="number" step="0.01" min="0" placeholder="0.00" value="' + esc(unit) + '"' + (unit ? '' : ' data-auto="1"') + ' required></label>' +
      '<label>Quantity<input value="' + esc(d.quantity || '—') + '" disabled></label>' +
      '<div class="qd-calc"><span>Calculated total for the customer' + (q.qty ? ' <span class="dim">(' + q.qty + ' × unit price)</span>' : '') + '</span><strong data-total>—</strong></div>' +
      '<div class="qd-callout wide" data-route role="status" hidden></div>' +
      '<label>Estimated availability' + (d.neededBy ? ' <span class="dim">(Customer requested: ' + esc(day(d.neededBy)) + ')</span>' : '') +
      '<select name="leadTime" required><option value="">Select…</option>' + (o.leadTimes || []).map((x) => '<option value="' + esc(x) + '"' + (x === autoLead ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></label>' +
      '<div class="qd-calc" data-ready hidden role="status"><span>Estimated ready date <span class="dim">(working days, if accepted today)</span></span><strong data-ready-date>—</strong></div>' +
      '<div class="qd-callout warn wide" data-ready-late hidden>That is later than the date the customer needs it' + (d.neededBy ? ' (' + esc(shortDay(d.neededBy)) + ')' : '') + '. Choose a shorter time, or say in your remarks when you can deliver.</div>' +
      '<label>Quotation validity<select name="validDays" required>' + (o.validDays || []).map((x) => '<option value="' + esc(x) + '"' + (x === 7 ? ' selected' : '') + '>' + esc(x) + ' days</option>').join('') + '</select></label>' +
      '<fieldset class="qd-terms"><legend>Payment terms</legend>' +
      '<div class="qd-term-list" data-terms-opts><p class="q-hint">Reading the payment policy…</p></div>' +
      '<small class="q-hint">Only the terms Finance switched on for this kind of item appear. Choosing one never takes money now; it says what the customer pays now and what stays outstanding.</small></fieldset>' +
      '<label class="wide">Remarks for the customer<textarea name="note" maxlength="1500" rows="2" placeholder="What is included, any assumption you made, how to reach you"></textarea></label>' +
      '<div class="err-text wide" data-price-err role="alert"></div>' +
      '<div class="wide" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-secondary" data-act="cancelprice">Cancel</button>' +
      '<button type="submit" class="btn-primary">Confirm price</button></div></form>' +
      '<p class="q-hint">You never choose where the price goes: the system checks it against Finance\u2019s rules (' + esc(rulesHint()) + ') and either sends it to the customer or to Finance, with the reason.</p>';
  }
  /* ---- payment terms. The policy table, the allowed scope per item type and every peso figure come from the
     backend; this screen only renders what GET /api/pos/payment-terms returns for the total being quoted. ---- */
  const TERM_NAME = { full: 'Full Payment', half: 'Half Payment', down: 'Down Payment', custom: 'Custom partial payment' };
  const TERMS_STATE = { none: ['No terms attached yet', 'warn'], proposed: ['Proposed — waiting for Finance', 'warn'],
    approved: ['Approved', 'ok'], rejected: ['Refused — full payment', 'bad'] };
  let termSeq = 0, termTimer = null;

  function termOptionHtml(o, current) {
    const on = o.key === (current || 'full');
    return '<label class="qd-term' + (Number(o.percent) < 100 ? ' partial' : '') + '">' +
      '<input type="radio" name="term" value="' + esc(o.key) + '"' + (on ? ' checked' : '') + '>' +
      '<span class="qd-term-name">' + esc(o.label || TERM_NAME[o.key] || o.key) + '</span>' +
      '<span class="qd-term-calc">Pay now <b>' + (money(o.dueNow) || '—') + '</b> · balance <b>' + (money(o.balance) || '₱0.00') + '</b>' +
      (o.balanceCondition ? ' <em>— ' + esc(o.balanceCondition) + '</em>' : '') + '</span>' +
      // automation: the suggested term, and whether the system signs it by itself at this total (Finance's limit)
      '<span class="qd-term-by">' + (o.recommended ? '<b>Suggested</b> · ' : '') +
      (o.key === 'full' ? 'no approval needed' : o.autoApproved ? 'approved automatically (within Finance’s limit)' : 'goes to Finance to approve') + '</span></label>';
  }

  async function loadTermOptions(root, total, current) {
    const box = root && root.querySelector('[data-terms-opts]'); if (!box) return;
    const seq = ++termSeq, d = S.detail;
    if (!(Number(total) > 0)) { box.innerHTML = '<p class="q-hint">Enter the quoted total first — which terms are allowed depends on the amount.</p>'; return; }
    box.innerHTML = '<p class="q-hint">Reading the payment policy…</p>';
    try {
      const r = await call('/api/pos/payment-terms?total=' + encodeURIComponent(Number(total).toFixed(2)) +
        '&madeToOrder=' + (d && d.madeToOrder ? 'true' : 'false'));
      if (seq !== termSeq || !box.isConnected) return;
      const opts = ((r && r.options) || []).map((o) => Object.assign(o, { recommended: o.key === r.recommended }));
      S.termOpts = opts;
      // keep what the cashier already picked; otherwise the saved term; otherwise the system's suggestion
      const picked = box.querySelector('input[name=term]:checked');
      const pick = (picked && picked.value) || current || r.recommended || 'full';
      box.innerHTML = opts.length ? opts.map((o) => termOptionHtml(o, pick)).join('')
        : '<p class="q-hint">Only Full Payment is allowed for this item.</p>';
      syncTermFields(root);
    } catch (e) { if (seq === termSeq && box.isConnected) box.innerHTML = '<p class="q-hint qd-bad">The payment policy could not be read: ' + esc(fieldErr(e)) + '</p>'; }
  }

  // when the balance is paid: a step the release gate enforces, worded for this quotation's pickup / delivery
  const balanceDue = (d) => [[d.fulfillment === 'Delivery' ? 'balance due before delivery' : 'balance due before pickup', d.fulfillment === 'Delivery' ? 'Before delivery' : 'Before pickup'],
    ['balance due before production starts', 'Before production starts']];
  // the balance fields only matter for a part-payment
  function syncTermFields(root) {
    if (!root) return; const pick = root.querySelector('input[name=term]:checked'), partial = !!pick && pick.value !== 'full';
    root.querySelectorAll('[data-cond]').forEach((x) => { x.hidden = !partial; });
  }
  function termsSectionHtml(d) {
    const t = d.terms, state = (t && t.state) || 'none', lab = TERMS_STATE[state] || TERMS_STATE.none;
    const settled = Number(d.paidAmount) > 0;
    const canSet = !d.converted && !settled && ['new', 'awaiting_details', 'pending_approval', 'quoted'].includes(d.status);
    if (S.openTerms) {
      const total = d.amount != null ? d.amount : d.proposedAmount;
      if (!(Number(total) > 0)) return '<div class="qd-callout">Set the price first — the payment options depend on the quoted total.</div>' +
        '<button type="button" class="btn-secondary" data-act="cancelterms">Close</button>';
      const cur = (t && t.condition) || '';
      return '<form class="qd-price qd-terms-form" id="qdTermsForm" novalidate>' +
        '<div class="qd-term-list" data-terms-opts><p class="q-hint">Reading the payment policy…</p></div>' +
        '<label class="wide" data-cond hidden>Balance due<select name="condition">' + balanceDue(d).map((c) =>
          '<option value="' + esc(c[0]) + '"' + (c[0] === cur ? ' selected' : '') + '>' + esc(c[1]) + '</option>').join('') + '</select></label>' +
        '<label class="wide" data-cond hidden>Note for Finance <span class="q-optional">(optional)</span><textarea name="note" rows="2" maxlength="300" placeholder="Why a part-payment for this job"></textarea></label>' +
        '<div class="err-text wide" data-terms-err role="alert"></div>' +
        '<div class="wide" style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-secondary" data-act="cancelterms">Cancel</button>' +
        '<button type="submit" class="btn-primary">Save terms</button></div></form>' +
        '<p class="q-hint">A part-payment within Finance’s automatic limit is approved at once; anything else goes to Finance first.</p>';
    }
    return kv([
      row('Payment term', t ? '<b>' + esc(TERM_NAME[t.key] || t.key) + '</b>' + (t.percent != null ? ' — ' + t.percent + '%' : '') : '<b>Full Payment</b> — everything before release'),
      row('Initial payment', t && t.amount != null ? money(t.amount) : money(d.amount) || '—'),
      row('Remaining balance', t && t.balance != null ? money(t.balance) : '₱0.00'),
      row('Balance due', t && t.condition ? esc(t.condition) : 'nothing further to pay'),
      row('Estimated availability', esc((t && t.availability) || d.leadTime || '—')),
      row('Approval', '<span class="qd-pill ' + lab[1] + '">' + lab[0] + '</span>' +
        (t && t.decidedAt ? ' <span class="dim">' + esc(t.decidedBy || 'Finance') + ' · ' + day(t.decidedAt) + '</span>' : '')),
      row('Customer reviewed', t && t.seenAt ? day(t.seenAt) : 'not yet'),
      row('Confirmed payments', (money(d.paidAmount) || '₱0.00') + ' <span class="dim">· ' + esc(d.paymentState || 'unpaid') +
        (Number(d.balance) > 0 ? ', outstanding ' + money(d.balance) : '') + '</span>')
    ]) + (settled ? '<div class="qd-callout">Money is already recorded against this quotation, so its terms are fixed. Collect the rest at the counter or with the payment link.</div>'
      : canSet ? '<button type="button" class="btn-secondary" data-act="terms">' + (t && state !== 'none' ? 'Change the payment terms' : 'Choose the payment terms') + '</button>' : '');
  }

  async function saveTerms(form) {
    const d = S.detail; if (!d) return;
    const err = form.querySelector('[data-terms-err]'), f = new FormData(form);
    const key = f.get('term'), condition = key === 'full' ? '' : String(f.get('condition') || '').trim(), note = key === 'full' ? '' : String(f.get('note') || '').trim();
    err.textContent = '';
    if (!key) { err.textContent = 'Choose a payment term from the list.'; return; }
    const o = (S.termOpts || []).find((x) => x.key === key) || {};
    const go = await pqConfirm({ title: 'Attach these payment terms to the quotation?',
      description: key === 'full' ? 'Full Payment: the customer settles everything before the goods are released.'
        : o.autoApproved ? 'Within Finance’s automatic limit: approved at once, unless the customer still owes money on another order (then Finance decides).'
        : 'This is sent to Finance as a proposal. The customer is not shown partial terms until Finance signs them.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Total quoted', money(d.amount) || '—'],
        ['Term', o.label || TERM_NAME[key] || key], ['Pay now', money(o.dueNow) || '—'], ['Balance', money(o.balance) || '₱0.00'],
        ['Balance due', condition || o.balanceCondition || 'before release']],
      acknowledgment: 'These amounts are what the customer and I agreed.', confirmLabel: 'Save terms' });
    if (!go) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/terms', { method: 'POST', body: JSON.stringify({ termKey: key, condition: condition || undefined, note: note || undefined }) });
      toast(r.terms && r.terms.state === 'proposed' ? 'Sent to Finance to approve the terms: ' + ((r.auto && r.auto.reasons || []).join('; ') || 'needs a signature') + '.'
        : r.terms && r.terms.auto ? 'Payment terms approved automatically.' : 'Payment terms saved for this quotation.');
      S.openTerms = false; await openDetail(d.id); loadDesk();
    } catch (e) { err.textContent = fieldErr(e); btn.disabled = false; }
  }

  function footHtml(d) {
    const b = [];
    if (['new', 'awaiting_details'].includes(d.status) && d.customerId) b.push('<button type="button" class="btn-secondary" data-act="clarify">Request missing details</button>');
    if (d.status === 'quoted' && d.source === 'pos' && !d.expired) b.push('<button type="button" class="btn-primary" data-act="accept">Customer accepted</button><button type="button" class="btn-secondary" data-act="decline">Customer declined</button>');
    if (d.status === 'quoted' && !(Number(d.paidAmount) > 0)) b.push('<button type="button" class="' + (d.expired || d.costStale ? 'btn-primary' : 'btn-secondary') + '" data-act="refresh">Refresh price at today\u2019s costs</button>');
    if (d.status === 'quoted' && d.expired) b.push('<button type="button" class="btn-secondary" data-act="renew">Ask Finance for a new price</button>');
    if (d.status === 'quoted' && d.source !== 'pos') b.push('<button type="button" class="btn-secondary" data-act="renew">Ask Finance to re-issue</button>');
    if (d.status === 'accepted') b.push('<button type="button" class="btn-primary" data-act="convert">' + (d.source === 'pos' ? 'Hand over to the counter' : 'Convert into an order') + '</button>');
    if (d.converted) b.push('<span class="qd-callout ok" style="flex:1 1 220px">Already converted to ' + esc(d.orderNo || 'an order') + '.</span>');
    if (d.amount != null || ['quoted', 'accepted', 'preparing', 'ready', 'completed'].includes(d.status)) {
      b.push('<button type="button" class="btn-secondary" data-act="print-invoice">Print quotation invoice</button>');
    }
    b.push('<button type="button" class="btn-secondary" data-act="close">Close</button>');
    return b.join('');
  }

  function printQuoteInvoiceCashier(d) {
    if (!d) return;
    const w = window.open('', '_blank');
    if (!w) { toast('Please allow pop-ups to print the quotation invoice.', true); return; }
    const sp = d.specs || {};
    const specsHtml = [
      sp.material ? 'Material: ' + esc(sp.material) : '',
      sp.size ? 'Dimensions: ' + esc(sp.size) : '',
      sp.thickness ? 'Thickness: ' + esc(sp.thickness) : '',
      sp.finish ? 'Finish: ' + esc(sp.finish) : '',
      sp.service ? 'Secondary work: ' + esc(sp.service) : ''
    ].filter(Boolean).join(' | ');
    const when = day(d.requestDate || d.createdAt);
    const ready = d.estimatedReady ? day(d.estimatedReady) : (d.leadTime || 'Upon confirmation');
    const valid = d.validUntil ? day(d.validUntil) : '7 days from quote';
    const amount = Number(d.amount) || Number(d.proposedAmount) || 0;
    const paid = Number(d.paidAmount) || 0;
    const balance = d.balance != null ? Number(d.balance) : Math.max(0, amount - paid);
    const term = d.terms ? (TERM_NAME[d.terms.key] || d.terms.key) : 'Full Payment';
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Quotation Invoice ${esc(d.id)}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; padding: 30px; margin: 0; background: #fff; }
        .sheet { max-width: 680px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 28px; }
        .header { display: flex; justify-content: space-between; border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
        .brand { font-size: 20px; font-weight: 700; color: #0f172a; }
        .sub { font-size: 12px; color: #64748b; margin-top: 4px; }
        .title-box { text-align: right; }
        .inv-title { font-size: 18px; font-weight: 700; color: #1e40af; text-transform: uppercase; letter-spacing: 0.5px; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; background: #e0f2fe; color: #0369a1; margin-top: 4px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; font-size: 13px; }
        .grid div span { color: #64748b; display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        .grid div strong { color: #0f172a; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; }
        th { background: #f8fafc; border-bottom: 1px solid #cbd5e1; padding: 10px; text-align: left; font-size: 12px; color: #475467; }
        td { border-bottom: 1px solid #f1f5f9; padding: 12px 10px; }
        .r { text-align: right; }
        .totals { margin-left: auto; width: 280px; font-size: 13px; margin-bottom: 24px; }
        .totals-row { display: flex; justify-content: space-between; padding: 4px 0; }
        .totals-row.grand { font-size: 15px; font-weight: 700; border-top: 1px solid #cbd5e1; padding-top: 8px; margin-top: 4px; color: #0f172a; }
        .footer { font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 12px; text-align: center; }
        @media print { body { padding: 0; } .sheet { border: none; padding: 0; } }
      </style></head><body>
      <div class="sheet">
        <div class="header">
          <div>
            <div class="brand">Triple E Metal Products</div>
            <div class="sub">Official Pro-Forma Quotation Invoice</div>
          </div>
          <div class="title-box">
            <div class="inv-title">Quotation Invoice</div>
            <div class="badge">${esc(d.statusLabel || d.status)}</div>
          </div>
        </div>
        <div class="grid">
          <div><span>Quote Reference</span><strong>${esc(d.id)}</strong></div>
          <div><span>Date Quoted</span><strong>${esc(when)}</strong></div>
          <div><span>Customer</span><strong>${esc(d.customer || '—')}</strong><br><small>${esc(d.phone || '')}</small></div>
          <div><span>Fulfillment</span><strong>${esc(d.fulfillment || 'Pickup')}</strong></div>
          <div><span>Estimated Ready / Availability</span><strong>${esc(ready)}</strong>${d.neededBy ? '<br><small>Customer needed date: ' + esc(day(d.neededBy)) + '</small>' : ''}</div>
          <div><span>Price Valid Until</span><strong>${esc(valid)}</strong></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Item / Specification</th>
              <th class="r">Quantity</th>
              <th class="r">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>${esc(d.product || 'Custom Fabricated Item')}</strong>
                ${specsHtml ? '<div style="font-size:12px;color:#64748b;margin-top:4px;">' + specsHtml + '</div>' : ''}
              </td>
              <td class="r">${esc(d.quantity || '1')}</td>
              <td class="r"><strong>${peso(amount)}</strong></td>
            </tr>
          </tbody>
        </table>
        <div class="totals">
          <div class="totals-row"><span>Total Quoted Amount</span><strong>${peso(amount)}</strong></div>
          <div class="totals-row"><span>Payment Term</span><span>${esc(term)}</span></div>
          ${paid > 0 ? `<div class="totals-row"><span>Amount Paid</span><span>${peso(paid)}</span></div>` : ''}
          <div class="totals-row grand"><span>Remaining Balance</span><span>${peso(balance)}</span></div>
        </div>
        <div class="footer">
          This is an official Pro-Forma Quotation Invoice issued by Triple E Metal Products. Terms and lead times are subject to formal confirmation upon order acceptance.
        </div>
      </div>
      <script>setTimeout(function(){ window.focus(); window.print(); }, 400);</script>
      </body></html>`);
    w.document.close();
  }

  /* ================= 4. actions ================= */
  function pqConfirm(opts) {
    return new Promise((resolve) => {
      const overlay = el('pqConfirmOverlay'), yes = el('pqConfirmSubmit'), ack = el('pqConfirmAcknowledged'), prior = document.activeElement;
      el('pqConfirmTitle').textContent = opts.title;
      el('pqConfirmDesc').textContent = opts.description;
      el('pqConfirmSummary').replaceChildren();
      (opts.rows || []).forEach(([label, value]) => {
        const row = document.createElement('div'); row.className = 'pq-review-row';
        const l = document.createElement('span'); l.textContent = label;
        const v = document.createElement('strong'); v.textContent = String(value == null ? '—' : value);
        row.append(l, v); el('pqConfirmSummary').append(row);
      });
      el('pqConfirmAckLabel').textContent = opts.acknowledgment;
      el('pqConfirmError').textContent = ''; ack.checked = false; yes.disabled = true; yes.textContent = opts.confirmLabel || 'Confirm';
      overlay.hidden = false; document.body.style.overflow = 'hidden'; el('pqConfirmCancel').focus();
      const cleanup = (result) => { overlay.hidden = true; document.body.style.overflow = S.detail ? 'hidden' : '';
        ack.removeEventListener('change', onChange); yes.removeEventListener('click', onYes); el('pqConfirmCancel').removeEventListener('click', onCancel);
        el('pqConfirmClose').removeEventListener('click', onCancel); overlay.removeEventListener('click', onBackdrop); document.removeEventListener('keydown', onKey);
        if (prior && prior.focus) prior.focus(); resolve(result); };
      const onChange = () => { yes.disabled = !ack.checked; };
      const onYes = () => { if (ack.checked) cleanup(true); };
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === overlay) onCancel(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } if (e.key === 'Tab') {
        const list = Array.from(overlay.querySelectorAll('button,input')).filter((x) => !x.disabled); if (!list.length) return;
        const first = list[0], last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } };
      ack.addEventListener('change', onChange); yes.addEventListener('click', onYes); el('pqConfirmCancel').addEventListener('click', onCancel);
      el('pqConfirmClose').addEventListener('click', onCancel); overlay.addEventListener('click', onBackdrop); document.addEventListener('keydown', onKey);
    });
  }

  async function doClarify() {
    const d = S.detail; if (!d) return;
    const overlay = el('qdClarifyOverlay');
    el('qdClarifySubtitle').textContent = d.id + ' · ' + (d.customer || 'customer') + ' · ' + (d.product || 'custom item');
    el('qdClarifyForm').reset(); el('qdClarifyError').textContent = '';
    el('qdClarifyDue').min = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    // what the request says NOW for each detail, so the cashier asks only for what is really missing (those are ticked for them)
    const sp = d.specs || {}, cur = { dimensions: sp.size, thickness: sp.thickness, material: sp.material, finish: sp.finish, quantity: d.quantity };
    const missing = (v) => !v || /^(not specified|not sure)/i.test(String(v));
    const grid = overlay.querySelector('.qd-modal-grid');
    grid.innerHTML = (sp.itemType || d.product ? '<p class="qd-cl-item">' + esc(d.product || 'Custom item') + (sp.itemType ? ' · ' + esc(sp.itemType) : '') + '</p>' : '') +
      CLARIFY.map(([k, label]) => { const v = cur[k], gap = k !== 'other' && missing(v);
        return '<label class="qd-cl' + (gap ? ' gap' : '') + '"><input type="checkbox" name="fields" value="' + k + '"' + (gap ? ' checked' : '') + '>' +
          '<span><b>' + esc(label) + '</b><small>' + (k === 'other' ? 'Anything not listed above' : 'Now: ' + esc(v || 'not given')) + '</small></span>' + (gap ? '<em>missing</em>' : '') + '</label>'; }).join('');
    // a starting message from what is ticked; the cashier can rewrite it (it is only filled while untouched)
    const msg = el('qdClarifyMessage'); msg.dataset.auto = '1';
    const suggest = () => {
      if (msg.dataset.auto !== '1') return;
      const picked = Array.from(grid.querySelectorAll('[name=fields]:checked')).map((x) => x.value);
      if (!picked.length) { msg.value = ''; return; }
      const words = picked.map((k) => k === 'other' ? 'any other detail we should know' : ({ dimensions: 'the exact size (length x width x height, with the unit)', thickness: 'the wall thickness in mm', material: 'the material or grade', finish: 'the surface finish', quantity: 'the quantity' })[k] + (cur[k] && !missing(cur[k]) ? ' (you wrote: ' + cur[k] + ')' : ''));
      msg.value = 'Hi ' + (d.customer || '').split(' ')[0] + ', to price your ' + (d.product || 'custom item') + ' we need ' + (words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words[0]) + '. Please reply with the exact values in your account.';
    };
    grid.onchange = suggest; msg.oninput = () => { msg.dataset.auto = ''; };
    suggest();
    overlay.hidden = false; overlay.classList.add('open'); msg.focus();
    el('qdClarifyForm').onsubmit = async (e) => {
      e.preventDefault();
      const fields = Array.from(overlay.querySelectorAll('[name=fields]:checked')).map((x) => x.value);
      const message = el('qdClarifyMessage').value.trim(), responseDue = el('qdClarifyDue').value, err = el('qdClarifyError');
      err.textContent = '';
      if (!fields.length || message.length < 15 || message.length > 1000) { err.textContent = 'Tick at least one detail and explain what you need in 15–1000 characters.'; return; }
      const go = await pqConfirm({ title: 'Send this clarification request?', description: 'The quotation moves to “Awaiting Customer Details”, the customer is notified, and your original notes stay untouched.',
        rows: [['Quotation', d.id], ['Customer', d.customer], ['Details asked for', fields.map((f) => (CLARIFY.find((c) => c[0] === f) || [f, f])[1]).join(', ')], ['Message', message], ['Suggested reply by', responseDue || 'no date set']],
        acknowledgment: 'I checked that these details really are missing before pricing.', confirmLabel: 'Confirm & send' });
      if (!go) return;
      const btn = el('qdClarifySubmit'); btn.disabled = true;
      try { await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/clarifications', { method: 'POST', body: JSON.stringify({ fields, message, responseDue: responseDue || null }) });
        closeClarify(); toast('Clarification sent. The customer can now reply in their account.'); await openDetail(d.id); loadDesk(); }
      catch (ex) { err.textContent = fieldErr(ex); }
      finally { btn.disabled = false; }
    };
  }
  function closeClarify() { const o = el('qdClarifyOverlay'); o.classList.remove('open'); o.hidden = true; }

  async function doRespond(action) {
    const d = S.detail; if (!d) return;
    const names = { accept: 'Record that the customer accepted', decline: 'Record that the customer declined', renew: 'Ask Finance for a new price' };
    const go = await pqConfirm({ title: names[action] + '?',
      description: action === 'accept' ? 'Only record acceptance after the walk-in customer said yes out loud. This does not take payment and does not reserve stock.'
        : 'Confirm the response before it is written to the quotation.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Item', d.product], ['Quantity', d.quantity], ['Quoted amount', money(d.amount) || '—'], ['Step', names[action]]],
      acknowledgment: action === 'accept' ? 'The customer explicitly accepted this quotation.' : 'I verified this response with the customer or with Finance.',
      confirmLabel: 'Confirm response' });
    if (!go) return;
    try { await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/respond', { method: 'POST', body: JSON.stringify({ action }) });
      toast(action === 'accept' ? 'Acceptance recorded. Ring it up at the counter or convert it to an order — payment is not collected yet.' : action === 'decline' ? 'Decline recorded.' : 'Finance asked for a new price.');
      await openDetail(d.id); loadDesk(); }
    catch (e) { toast(fieldErr(e), true); }
  }

  async function doConvert() {
    const d = S.detail; if (!d) return;
    const walkIn = d.source === 'pos' || !d.customerId;
    const paid = Number(d.paidAmount) || 0, owing = Number(d.balance) || 0;
    const go = await pqConfirm({ title: walkIn ? 'Hand this accepted quotation to the counter?' : 'Convert this accepted quotation into an order?',
      description: walkIn ? 'The item goes into the Point of Sale cart at the quoted unit price. The customer still pays there, and stock leaves inventory only when the sale is completed.'
        : 'One order will be created for the accepted quantity and price. Payments already recorded on the quotation move onto it, so the customer never pays twice.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Item', (d.product || 'Custom item') + (d.sku ? ' (' + d.sku + ')' : '')], ['Quantity', d.quantity], ['Total', money(d.amount) || '—'],
        ['Payment term', d.terms ? (TERM_NAME[d.terms.key] || d.terms.key) + (d.terms.percent != null ? ' — ' + d.terms.percent + '%' : '') : 'Full Payment'],
        ['Already paid', money(paid) || '₱0.00'], ['Still outstanding', money(owing) || '₱0.00']],
      acknowledgment: 'The accepted price and quantity above are exactly what the customer agreed to.',
      confirmLabel: walkIn ? 'Hand over' : 'Create the order' });
    if (!go) return;
    try {
      const r = await call(desk('/' + encodeURIComponent(d.id) + '/convert'), { method: 'POST', body: JSON.stringify({ requestId: requestId() }) });
      if (r.kind === 'pos') {
        window.QUOTE_HANDOVER = d.id;
        toast('Added to the sale: ' + r.qty + ' ' + r.unit + ' of ' + r.name + ' at ' + peso(r.unitPrice) + '.');
        closeDetail(); showPage('terminal'); addToCart(r.sku);
        const line = cart.find((x) => x.sku === r.sku); if (line) { line.qty = Math.min(r.qty, line.qty > r.qty ? line.qty : r.qty); renderCart(); }
      } else {
        toast(r.duplicate ? 'This quotation was already converted — order ' + r.orderNo + '.' : 'Order ' + r.orderNo + ' created. It is unpaid until the normal payment step.');
        await openDetail(d.id); loadDesk();
      }
    } catch (e) { toast(fieldErr(e), true); }
  }

  // live "estimated ready date" under the lead-time select: working days from today (Philippine time), never a weekend
  function updateReady(form) {
    const d = S.detail, o = window.PQ_OPTIONS || {}, box = form.querySelector('[data-ready]'), out = form.querySelector('[data-ready-date]'), late = form.querySelector('[data-ready-late]');
    if (!box || !d) return;
    const n = (o.leadWorkdays || {})[form.elements.leadTime.value];
    if (!n) { box.hidden = true; late.hidden = true; return; }
    let x = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) + 'T00:00:00Z'), left = n;
    while (left > 0) { x = new Date(x.getTime() + 86400000); const w = x.getUTCDay(); if (w !== 0 && w !== 6) left--; }
    const iso = x.toISOString().slice(0, 10);
    out.textContent = day(iso) + (d.neededBy && iso <= d.neededBy ? ' (Target ready: on or before requested date ' + day(d.neededBy) + ')' : '');
    box.hidden = false; late.hidden = !(d.neededBy && iso > d.neededBy);
  }

  /* Where a confirmed price goes is decided by the SERVER (quote-automation.js routeQuote) from Finance's approval rules.
     This preview runs the same rules on the same numbers so the cashier knows before confirming; the server decides again. */
  const rulesNow = () => S.rules || (window.PQ_OPTIONS || {}).approvalRules || null;
  function rulesHint() {
    const R = rulesNow(); if (!R) return 'the approval rules could not be read, so Finance checks it';
    return '\u00B1' + R.tolerancePct + '% of the system price, margin at least ' + R.minMarginPct + '%, up to ' + peso(R.valueLimit) + ', fully costed and in stock';
  }
  function previewRoute(form, total) {
    const R = rulesNow(), e = S.draft, why = [];
    if (!R) return ['the approval rules could not be read'];
    if (!e || !e.ok) why.push(e && e.missing ? 'the request does not give the ' + e.missing.join(', ') : 'it cannot be priced yet (' + ((e && e.problems) || []).map((p) => p.message).join(' ').replace(/\.$/, '') + ')');
    else {
      const margin = total > 0 ? (total - e.costTotal) / total * 100 : -Infinity, dev = e.total > 0 ? (total - e.total) / e.total * 100 : 0;
      if (total < e.costTotal - 0.004) why.push(peso(total) + ' is below the cost of ' + peso(e.costTotal));
      else if (margin < R.minMarginPct) why.push('the margin of ' + margin.toFixed(1) + '% is below the minimum of ' + R.minMarginPct + '%');
      if (Math.abs(dev) > R.tolerancePct + 1e-9) why.push(Math.abs(dev).toFixed(1) + '% ' + (dev < 0 ? 'below' : 'above') + ' the system price of ' + peso(e.total) + ' (allowed \u00B1' + R.tolerancePct + '%)');
      if ((e.shortfalls || []).length) why.push('stock is short (' + e.shortfalls.map((s) => s.name + ' by ' + num4(s.short) + ' ' + s.unit).join('; ') + ')');
    }
    if (!(R.valueLimit > 0)) why.push('no order-value limit is set');
    else if (total > R.valueLimit) why.push(peso(total) + ' is over the cashier limit of ' + peso(R.valueLimit));
    const term = form && form.querySelector('input[name=term]:checked');
    // a part-payment within Finance's automatic limit is signed by the system (the server also checks the customer owes nothing elsewhere)
    const termOpt = term && (S.termOpts || []).find((x) => x.key === term.value);
    if (term && term.value !== 'full' && !(termOpt && termOpt.autoApproved)) why.push('partial-payment terms over Finance’s automatic limit are approved by Finance');
    return why;
  }
  function syncRoute(form, total) {
    const box = form && form.querySelector('[data-route]'); if (!box) return;
    if (!(total > 0)) { box.hidden = true; box.textContent = ''; return; }
    const why = previewRoute(form, total);
    box.hidden = false;
    box.className = 'qd-callout wide ' + (why.length ? 'warn' : 'ok');
    box.textContent = why.length ? 'Goes to Finance automatically: ' + why.join('; ') + '. Nothing else to do; you are told when they answer.'
      : 'Within Finance\u2019s rules: the customer gets this price as soon as you confirm.';
  }

  async function submitPrice(form) {
    const d = S.detail; if (!d) return;
    const err = form.querySelector('[data-price-err]'), f = new FormData(form);
    const q = qtyParts(d.quantity);
    const unit = String(f.get('unit') || '').trim();
    err.textContent = '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(unit) || Number(unit) <= 0) { err.textContent = 'Enter the unit price in pesos, up to two decimals.'; return; }
    if (!q) { err.textContent = 'The quoted quantity could not be read. Fix it with Finance before pricing.'; return; }
    const total = Math.round(Number(unit) * q.qty * 100) / 100;
    const minMargin = (rulesNow() && rulesNow().minMarginPct) || 20;
    if (S.draft && S.draft.costTotal > 0) {
      const minFloor = Math.round((S.draft.costTotal / (1 - minMargin / 100)) * 100) / 100;
      if (total < minFloor - 0.004) {
        err.textContent = 'Price cannot be below the ' + minMargin + '% margin floor (' + peso(minFloor) + ' total, ' + peso(minFloor / q.qty) + '/pc). Please adjust the unit price.';
        return;
      }
    }
    const leadTime = f.get('leadTime'), validDays = Number(f.get('validDays')), note = String(f.get('note') || '').trim();
    if (!leadTime || !validDays) { err.textContent = 'Choose the preparation time and how long the price is valid.'; return; }
    if (S.recipeMode === 'edited' && validLines().length !== (S.lines || []).length) { err.textContent = 'Finish or remove the incomplete recipe line (material and a quantity above 0).'; return; }
    const why = previewRoute(form, total), toFinance = why.length > 0;
    const termKey = f.get('term') || 'full';
    const termOpt = (S.termOpts || []).find((x) => x.key === termKey) || {};
    const dueNow = termOpt.dueNow != null ? money(termOpt.dueNow) : peso(total);
    const balance = termOpt.balance != null ? money(termOpt.balance) : '₱0.00';
    const go = await pqConfirm({ title: 'Review the quotation price',
      description: toFinance ? 'This goes to Finance for approval before the customer is told anything.' : 'The customer is told this price as soon as it is saved.',
      rows: [['Quotation', d.id], ['Customer', d.customer + ' · ' + (d.phone || '')], ['Item', (d.product || 'Custom item') + ' · ' + d.quantity],
        ['Unit price', peso(Number(unit))], ['Calculated total', peso(total)], ['Ready in', leadTime], ['Price valid', validDays + ' days'],
        ['Payment term', (termOpt.label || TERM_NAME[termKey] || termKey) + ' — pay ' + dueNow + ' now, balance ' + balance],
        ['Where they pay', d.payMethod || (d.fulfillment === 'Delivery' ? 'Cash on delivery' : 'Pay at pickup')],
        ['Suggested price', S.draft && S.draft.ok ? peso(S.draft.total) + ' (cost ' + peso(S.draft.costTotal) + ')' : 'cannot price yet'],
        ['Where it goes', toFinance ? 'Finance, automatically \u2014 ' + why.join('; ') : 'Straight to the customer'], ['Remarks', note || 'none']],
      acknowledgment: 'I checked the specifications, the quantity and the arithmetic before confirming this price.', confirmLabel: 'Confirm price' });
    if (!go) return;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const recipe = d.sku ? undefined : S.recipeMode === 'edited' ? validLines() : S.recipeMode === 'auto' ? null : undefined;
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/price', { method: 'POST', body: JSON.stringify({ amount: total.toFixed(2), leadTime, validDays, note, termKey, recipe }) });
      // The terms are attached to the price the customer is shown, so they go on straight after it exists.
      // the server attaches the term together with the price; only an older server needs the separate call
      let termsState = r.quote && r.quote.terms && r.quote.terms.key === termKey ? r.quote.terms.state : null;
      if (!termsState && termKey !== ((d.terms || {}).key || 'full')) {
        try { const t = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/terms', { method: 'POST', body: JSON.stringify({ termKey }) }); termsState = t.terms && t.terms.state; }
        catch (te) { err.textContent = 'The price was saved, but the payment terms were not: ' + fieldErr(te); S.openPrice = false; await openDetail(d.id); loadDesk(); return; }
      }
      const dec = r.decision || {};
      toast(r.status === 'pending_approval' ? 'Sent to Finance automatically: ' + ((dec.reasons || []).join('; ') || 'needs approval') + '.'
        : termsState === 'proposed' ? 'Price sent. The partial payment terms now go to Finance for a signature.'
        : termsState === 'approved' && termKey !== 'full' ? 'Within the rules: the customer has the price, and the part-payment was approved automatically.'
        : 'Within the rules: the customer has the price now.');
      S.openPrice = false; await openDetail(d.id); loadDesk();
    } catch (e) { err.textContent = fieldErr(e); btn.disabled = false; }
  }

  async function doRefresh() {
    const d = S.detail; if (!d) return;
    const go = await pqConfirm({ title: 'Refresh this quote at today\u2019s costs?',
      description: 'The system works the price out again from today\u2019s material costs and checks it against Finance\u2019s rules. Within the rules the customer gets the new price and a new validity date; otherwise it goes to Finance.',
      rows: [['Quotation', d.id], ['Customer', d.customer], ['Price now', money(d.amount) || '\u2014'], ['Valid until', d.validUntil ? day(d.validUntil) + (d.expired ? ' (expired)' : '') : '\u2014']],
      acknowledgment: 'I will tell the customer if the price changes.', confirmLabel: 'Refresh price' });
    if (!go) return;
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/refresh-price', { method: 'POST', body: '{}' });
      toast(r.status === 'quoted' ? 'Refreshed: ' + peso(r.before) + ' \u2192 ' + peso(r.amount) + ', valid again.' : 'The new price ' + peso(r.amount) + ' went to Finance: ' + ((r.decision || {}).reasons || []).join('; '));
      await openDetail(d.id); loadDesk();
    } catch (e) { toast(fieldErr(e), true); }
  }

  /* ---- collecting the money (the cashier records it; Finance only follows up) ----
     Online (Xendit) payments are recorded by themselves: the cashier can press "Check online payment" to look now. Anything paid at the
     counter, on pickup or on delivery is recorded here; cash goes into this cashier's own open Cash Shift (the server refuses it without one). */
  const PAY_METHODS = ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Credit / debit card'];
  function collectDue(d) {
    const bal = Number(d.balance) || 0, t = d.terms;
    if (t && t.state === 'approved' && t.key !== 'full' && Number(t.amount) > 0 && d.status === 'accepted') return Math.min(bal, Math.max(0, Math.round((Number(t.amount) - (Number(d.paidAmount) || 0)) * 100) / 100)) || bal;
    return bal;
  }
  function collectHtml(d) {
    if (!['accepted', 'preparing', 'ready'].includes(d.status) || !(Number(d.balance) > 0)) return '';
    const online = d.payMethod === 'Xendit', where = d.fulfillment === 'Delivery' ? 'on delivery' : 'at pickup', due = collectDue(d);
    const intro = online
      ? '<div class="qd-callout">The customer chose to pay online. It is recorded automatically when it arrives. Only take money here if they pay you at the counter instead — the online link is closed first so they cannot pay twice.</div>'
      : '<div class="qd-callout">Collect <b>' + money(due) + '</b> ' + (d.status === 'ready' ? where : 'when the customer pays') + ', then record it here. You are the one who records it; Finance is told.</div>';
    return sec('Collect payment', intro +
      '<form id="qdCollectForm" class="qd-form" novalidate><label>Amount received (₱)<input name="amount" inputmode="decimal" autocomplete="off" value="' + esc(String(due)) + '"></label>' +
      '<label>Paid by<select name="method">' + PAY_METHODS.map((m) => '<option' + (m === 'Cash' ? ' selected' : '') + '>' + esc(m) + '</option>').join('') + '</select></label>' +
      '<label data-refrow hidden>Reference <span class="q-optional">(from the app, receipt or statement)</span><input name="reference" maxlength="60" autocomplete="off"></label>' +
      '<div class="qd-err" id="qdCollectErr" role="alert"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn-primary" data-act="collect">Record payment</button>' +
      (online ? '<button type="button" class="btn-secondary" data-act="checkpay">Check online payment</button>' : '') + '</div></form>');
  }
  async function doCollect() {
    const d = S.detail, form = el('qdCollectForm'); if (!d || !form) return;
    const err = el('qdCollectErr'); err.textContent = '';
    const amount = form.elements.amount.value.replace(/[,₱\s]/g, ''), method = form.elements.method.value, reference = form.elements.reference.value.trim();
    if (!(Number(amount) > 0)) { err.textContent = 'Enter the amount received.'; return; }
    if (Number(amount) > Number(d.balance) + 0.004) { err.textContent = 'The balance is only ' + money(d.balance) + '.'; return; }
    if (method !== 'Cash' && reference.length < 4) { err.textContent = 'Enter the reference (at least 4 characters).'; form.elements.reference.focus(); return; }
    const go = await pqConfirm({ title: 'Record this payment for ' + d.id + '?', description: method === 'Cash' ? 'The cash goes into your open Cash Shift.' : 'Recorded as received by ' + method + '.',
      rows: [['Amount', money(Number(amount))], ['Paid by', method]].concat(reference ? [['Reference', reference]] : []).concat([['Balance after', money(Math.max(0, Number(d.balance) - Number(amount)))]]),
      acknowledgment: 'I have received this money.', confirmLabel: 'Record payment' });
    if (!go) return;
    S.collectKey = S.collectKey || requestId();
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/payment', { method: 'POST', body: JSON.stringify({ amount, method, reference, requestId: S.collectKey }) });
      S.collectKey = null;
      toast(r.balance > 0 ? 'Payment recorded. Balance ' + money(r.balance) + '.' : 'Payment recorded. Fully paid.');
      await openDetail(d.id); loadDesk();
    } catch (e) { err.textContent = fieldErr(e); }
  }
  async function doCheckPay() {
    const d = S.detail; if (!d) return;
    try {
      const r = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/check-payment', { method: 'POST', body: '{}' });
      toast(r.balance > 0 ? 'Not paid online yet. Balance ' + money(r.balance) + '.' : 'Paid online. It is recorded.');
      await openDetail(d.id); loadDesk();
    } catch (e) { toast(fieldErr(e), true); }
  }

  /* ---- after acceptance: the job order of a custom item (cashier / production staff can run every step) ---- */
  function productionHtml(d) {
    if (!['accepted', 'preparing', 'ready'].includes(d.status) || d.sku) return '';
    return sec('Production', '<div data-job><p class="q-hint">Reading the job order\u2026</p></div>');
  }
  let jobSeq = 0;
  async function loadJob(d) {
    const my = ++jobSeq; let j;
    try { j = await call('/api/pos/quotes/' + encodeURIComponent(d.id) + '/job'); } catch (e) { const b0 = el('qdDrawerBody').querySelector('[data-job]'); if (b0) b0.innerHTML = '<div class="qd-callout bad">' + esc(fieldErr(e)) + '</div>'; return; }
    const box = el('qdDrawerBody').querySelector('[data-job]'); if (my !== jobSeq || !box || !S.detail || S.detail.id !== d.id) return;
    S.job = j; S.jobKey = S.jobKey || requestId();
    const name = (sku) => ((j.materials || []).find((m) => m.sku === sku) || { name: sku });
    let h = '';
    if (j.job && j.job.status !== 'draft') {
      h += '<p><b>' + esc(j.job.ref) + '</b> \u00B7 materials issued by ' + esc(j.job.issuedBy) + ' \u00B7 ' + esc(j.job.issuedAt) + (j.job.status === 'finished' ? ' \u00B7 <span class="qd-pill ok">finished ' + esc(j.job.finishedAt || '') + '</span>' : '') + '</p>' +
        kv(j.job.items.map((i) => [i.name, num4(i.quantity) + ' ' + esc(i.unit)]).concat([['Material cost', peso(j.job.materialCost)]]));
      if (j.canFinish) h += '<button type="button" class="btn-primary" data-act="jobfinish">Job finished \u2014 mark ' + (d.fulfillment === 'Delivery' ? 'out for delivery' : 'ready for pickup') + '</button>';
    } else if (j.paymentBlocked && j.paymentNeeded) {
      h += '<div class="qd-callout warn"><b>Down payment required before production:</b> Customer has paid ' + peso(j.paymentNeeded.paid) + ' of ' + peso(j.quoted) + '. Under Philippine Contract Law (Civil Code Arts. 1482 & 1582), custom-made orders require an initial down payment (' + peso(j.paymentNeeded.required) + ') before materials can leave stock. Collect at the counter or wait for online payment confirmation.</div>';
    } else if (j.canIssue) {
      h += '<p class="q-hint">' + (j.job ? '<b>' + esc(j.job.ref) + '</b> draft, made when the customer accepted. ' : '') + 'Issuing takes these materials out of stock and moves the quote to Preparing (the customer is told).</p>' +
        (j.suggestions || []).map((s) => { const m = name(s.sku); return '<div class="qd-rline qd-jline"><span>' + esc(m.name) + ' <span class="dim">' + esc(m.onHand != null ? num4(m.onHand) + ' ' + m.unit + ' on hand' : '') + '</span></span>' +
          '<input data-jsku="' + esc(s.sku) + '" inputmode="decimal" aria-label="Quantity to issue" value="' + esc(s.quantity != null ? s.quantity : '') + '"><span>' + esc(m.unit || '') + '</span></div>' +
          (m.onHand != null && s.quantity > m.onHand ? '<div class="qd-callout warn">' + esc(m.name) + ' is short by ' + num4(s.quantity - m.onHand) + ' ' + esc(m.unit) + ' (a purchase suggestion was sent to Finance).</div>' : ''); }).join('') +
        '<button type="button" class="btn-primary" data-act="jobissue">Issue materials &amp; start preparing</button>';
    } else h += '<p class="q-hint">Nothing to do here right now.</p>';
    if (d.status === 'ready') h += '<label class="wide" style="display:block;margin-top:10px">' + (d.fulfillment === 'Delivery' ? 'Received by' : 'Picked up by') + '<input data-recv maxlength="80" autocomplete="off"></label>' +
      '<button type="button" class="btn-primary" data-act="complete">Mark ' + (d.fulfillment === 'Delivery' ? 'delivered' : 'picked up') + '</button>' +
      (Number(d.balance) > 0 ? '<p class="q-hint">The balance of ' + money(d.balance) + ' must be paid first.</p>' : '');
    box.innerHTML = h;
  }
  async function jobAction(act) {
    const d = S.detail; if (!d) return;
    const no = encodeURIComponent(d.id), box = el('qdDrawerBody').querySelector('[data-job]');
    try {
      if (act === 'jobissue') {
        const invalid = Array.from(box.querySelectorAll('[data-jsku]')).find(i => liveDeskField(i));
        if (invalid) { invalid.focus(); return; }
        const items = Array.from(box.querySelectorAll('[data-jsku]')).map((i) => ({ sku: i.dataset.jsku, quantity: i.value.replace(/,/g, '').trim() })).filter((i) => Number(i.quantity) > 0);
        if (!items.length) { toast('Enter how much of each material the job uses.', true); return; }
        const go = await pqConfirm({ title: 'Issue these materials for ' + d.id + '?', description: 'They leave stock now as \u201CUsed in production\u201D and the quote moves to Preparing.',
          rows: items.map((i) => [((S.job.materials || []).find((m) => m.sku === i.sku) || { name: i.sku }).name, i.quantity]), acknowledgment: 'These are the quantities the job really uses.', confirmLabel: 'Issue materials' });
        if (!go) return;
        await call('/api/pos/quotes/' + no + '/job', { method: 'POST', body: JSON.stringify({ requestKey: S.jobKey, items }) });
        S.jobKey = null; toast('Materials issued. The quote is now Preparing and the customer was told.');
      } else if (act === 'jobfinish') {
        await call('/api/pos/quotes/' + no + '/job/finish', { method: 'POST', body: '{}' });
        toast('Job finished. The customer was told it is ' + (d.fulfillment === 'Delivery' ? 'out for delivery.' : 'ready for pickup.'));
      } else if (act === 'complete') {
        const recipient = box.querySelector('[data-recv]');
        if (recipient && liveDeskField(recipient)) { recipient.focus(); return; }
        const recv = (box.querySelector('[data-recv]') || {}).value || '';
        await call('/api/pos/quotes/' + no + '/step', { method: 'POST', body: JSON.stringify({ status: 'completed', receivedBy: recv.trim() }) });
        toast(d.id + ' is complete.');
      }
      await openDetail(d.id); loadDesk();
    } catch (e) { toast(fieldErr(e), true); }
  }

  /* ================= 5. walk-in quotation form ================= */
  const PQ_IDS = { productName: 'pqItem', contactName: 'pqName', phone: 'pqPhone', email: 'pqEmail', company: 'pqCompany', region: 'pqRegion', province: 'pqProvince', city: 'pqCity', barangay: 'pqBrgy', street: 'pqStreet' };
  const PQ_PHONE_RE = /^(\+63|0)9\d{9}$/, PQ_NAME_RE = /^[\p{L}][\p{L}\p{M}\s.,'’-]*$/u, PQ_MAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
  let pqMounted = false;
  const pqFulfil = () => (document.querySelector('input[name="pqFulfil"]:checked') || {}).value || 'Pickup';
  const isFlexible = () => el('pqFlexible').checked;
  const pqNeededEl = () => el('pqNeeded');                                    // built by QuoteFields.mount(), so it can be missing while options fail to load
  const pqNeededVal = () => { const x = pqNeededEl(); return x ? x.value : ''; };
  function pqErr(f, msg) { const b = el('pqE_' + f); if (b) b.textContent = msg || ''; if (PQ_IDS[f]) el(PQ_IDS[f]).classList.toggle('is-bad', !!msg); return !msg; }
  const PQ_CHECK = {
    contactName: () => { const v = el('pqName').value.trim(); return v.length >= 2 && PQ_NAME_RE.test(v) ? '' : 'Enter the customer’s name (letters only).'; },
    phone: () => { const v = el('pqPhone').value.replace(/[\s().-]/g, ''); return !v ? 'Enter a mobile number so we can reach the customer.' : PQ_PHONE_RE.test(v) ? '' : 'Enter a valid mobile number, e.g. 0917 123 4567.'; },
    email: () => { const v = el('pqEmail').value.trim(); return !v || (v.length <= 120 && PQ_MAIL_RE.test(v)) ? '' : 'Enter a valid email address, or leave it empty.'; },
    company: () => (el('pqCompany').value.trim().length <= 80 ? '' : 'Keep the company name within 80 characters.'),
    productName: () => el('pqProduct').value || el('pqItem').value.trim().length >= 3 ? '' : 'Tell us what they need (at least 3 characters).',
    neededBy: () => (pqNeededVal() || isFlexible() ? '' : 'Choose the date they need it, or tick that the date is flexible.'),
    region: () => (pqFulfil() === 'Delivery' && !el('pqRegion').value ? 'Choose the region.' : ''),
    province: () => (pqFulfil() !== 'Delivery' ? '' : !el('pqProvince').value ? 'Choose the province.' : pqNoCover),
    city: () => { if (pqFulfil() !== 'Delivery') return ''; const v = pqClean(el('pqCity').value); return !v ? 'Choose the city or municipality.' : PQG.cities.length && !pqCode(PQG.cities, v) ? 'Pick the city / municipality from the list.' : ''; },
    barangay: () => { if (pqFulfil() !== 'Delivery') return ''; const v = pqClean(el('pqBrgy').value); return !v ? 'Choose the barangay.' : PQG.barangays.length && !pqCode(PQG.barangays, v) ? 'Pick the barangay from the list.' : ''; },
    street: () => { const v = el('pqStreet').value.trim(); return pqFulfil() === 'Delivery' && v && v.length < 5 ? 'Enter the house no. and street, or leave it empty.' : ''; }
  };
  const pqField = (f) => pqErr(f, PQ_CHECK[f]());
  // same coverage as a POS delivery sale (Finance > Delivery rates): the cashier sees it before the request is logged
  let pqNoCover = '';
  async function pqCheckCover() {
    pqNoCover = ''; pqFeeNote(''); const region = el('pqRegion').value, province = el('pqProvince').value;
    if (!region || !province) return;
    try { const q = await api('/api/pos/delivery-fee?region=' + encodeURIComponent(region) + '&province=' + encodeURIComponent(province));
      if (q && q.available === false) pqNoCover = 'We do not deliver to ' + province + ' yet. Choose another area or switch to Pickup.';
      pqFeeNote(q && q.available !== false ? 'Delivery fee to ' + esc(province) + ': <b>' + peso(q.fee) + '</b> (' + esc(q.rate || 'standard rate') + ')' : ''); } catch (_) { /* the server checks again on save */ }
    if (pqFulfil() === 'Delivery') pqField('province');
  }

  /* ---- Task 9 (form-assist.js): delivery fee, minimum order, known customer by phone / email, ZIP -> area, draft, Enter to move on ---- */
  const FA = window.FormAssist;
  let pqDraft = null;
  function pqFeeNote(html) {
    let n = el('pqFeeNote');
    if (!n) { n = document.createElement('div'); n.id = 'pqFeeNote'; n.className = 'fa-note ok'; n.setAttribute('role', 'status'); el('pqArea').appendChild(n); }
    n.innerHTML = html || ''; n.hidden = !html;
  }
  function pqMinWarn() {
    const qty = el('pqQty'), p = prod(el('pqProduct').value); if (!FA || !qty) return;
    const n = Number(qty.value), m = p ? Math.min(Number(p.minOrder) || 0, p.available > 0 ? p.available : Infinity) : 0;
    FA.note(qty, p && n > 0 && n < m ? 'Minimum order for ' + esc(p.name) + ' is <b>' + m + ' ' + esc(p.unit) + '</b>.' : '', 'warn', 'min');
  }
  // the person may already be known: a registered account, an earlier walk-in sale or walk-in quote with the same phone / email
  let matchSeq = 0;
  async function pqMatch(input) {
    if (!FA) return;
    const phone = el('pqPhone').value.replace(/[\s().-]/g, ''), email = el('pqEmail').value.trim(), my = ++matchSeq;
    if (!PQ_PHONE_RE.test(phone) && !PQ_MAIL_RE.test(email)) { FA.note(input, ''); return; }
    let r; try { r = await api('/api/customers/match?phone=' + encodeURIComponent(phone) + '&email=' + encodeURIComponent(email)); } catch (_) { return; }
    if (my !== matchSeq) return;
    const m = (r.matches || [])[0];
    ['pqPhone', 'pqEmail'].forEach((id) => FA.note(el(id), '', '', 'match'));
    if (!m) return;
    const kind = m.kind === 'account' ? 'has an online account' : 'bought from us before (' + m.kind + (m.last ? ', ' + m.last : '') + ')';
    const n = FA.note(el(m.by === 'email' ? 'pqEmail' : 'pqPhone'), 'This ' + (m.by === 'email' ? 'email' : 'number') + ' belongs to <b>' + esc(m.name) + '</b>, who ' + esc(kind) +
      '. <button type="button" class="fa-link">Use their details</button>', 'info', 'match');
    n.querySelector('button').onclick = () => {
      if (m.name) FA.setValue(el('pqName'), m.name);
      if (m.email && !el('pqEmail').value.trim()) FA.setValue(el('pqEmail'), m.email);
      if (m.phone && !el('pqPhone').value.trim()) FA.setValue(el('pqPhone'), FA.phone.format(m.phone) || m.phone);
      FA.note(n.closest('.q-field').querySelector('input'), '', '', 'match');
    };
  }

  const PQG = { regions: [], provinces: [], cities: [], barangays: [], city: '', tok: { prov: 0, city: 0, bgy: 0 } };
  const pqClean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  const pqCode = (list, name) => { const n = pqClean(name).toLowerCase(); const m = list.find((x) => x.name.toLowerCase() === n); return m ? m.code : null; };
  const pqGeo = async (path) => { try { return await api(path); } catch (e) { if (e instanceof TypeError) throw new Error('No connection to the server'); throw e; } };
  function pqOptions(sel, rows, placeholder, disabled) { sel.innerHTML = '<option value="">' + esc(placeholder) + '</option>' + rows.map((r) => '<option value="' + esc(r.name) + '">' + esc(r.name) + '</option>').join(''); sel.disabled = !!disabled; }
  const pqListOpts = (id, rows) => { el(id).innerHTML = rows.map((r) => '<option value="' + esc(r.name) + '"></option>').join(''); };
  const pqBox = (id, placeholder, disabled) => { const x = el(id); x.value = ''; x.disabled = !!disabled; x.placeholder = placeholder; };
  function pqReset(from) {
    const i = ['province', 'city', 'barangay'].indexOf(from);
    if (i <= 0) { PQG.provinces = []; pqOptions(el('pqProvince'), [], 'Choose a region first', true); }
    if (i <= 1) { PQG.cities = []; pqListOpts('pqCityList', []); pqBox('pqCity', 'Choose a province first', true); }
    PQG.barangays = []; PQG.city = ''; pqListOpts('pqBgyList', []); pqBox('pqBrgy', 'Choose a city first', true);
  }
  async function pqLoadRegions() {
    const sel = el('pqRegion');
    try { if (!PQG.regions.length) PQG.regions = await pqGeo('/api/geo/regions'); const keep = sel.value; pqOptions(sel, PQG.regions, 'Choose a region…'); sel.value = keep; }
    catch (e) { sel.innerHTML = '<option value="">Could not load regions — focus to try again</option>'; sel.onfocus = () => { sel.onfocus = null; pqLoadRegions(); }; pqErr('region', e.message); }
  }
  async function pqOnRegion() {
    pqReset('province'); pqNoCover = ''; ['region', 'province', 'city', 'barangay'].forEach((f) => pqErr(f, ''));
    const reg = PQG.regions.find((r) => r.name === el('pqRegion').value); if (!reg) return;
    const t = ++PQG.tok.prov, psel = el('pqProvince');
    pqOptions(psel, [], 'Loading provinces…', true);
    try {
      const rows = await pqGeo('/api/geo/regions/' + encodeURIComponent(reg.code) + '/provinces'); if (t !== PQG.tok.prov) return;
      if (rows.length) { PQG.provinces = rows; pqOptions(psel, rows, 'Choose a province…'); return; }
      PQG.provinces = [{ code: 'NCR', name: 'Metro Manila' }];
      pqOptions(psel, PQG.provinces, 'Metro Manila', true); psel.value = 'Metro Manila'; pqCheckCover();
      await pqLoadCities('/api/geo/regions/' + encodeURIComponent(reg.code) + '/cities');
    } catch (e) { if (t === PQG.tok.prov) { pqOptions(psel, [], 'Could not load — choose the region again', true); pqErr('province', e.message); } }
  }
  async function pqOnProvince() {
    pqReset('city'); ['province', 'city', 'barangay'].forEach((f) => pqErr(f, ''));
    const prov = PQG.provinces.find((p) => p.name === el('pqProvince').value); if (!prov) return;
    pqCheckCover();
    await pqLoadCities('/api/geo/provinces/' + encodeURIComponent(prov.code) + '/cities');
  }
  async function pqLoadCities(path) {
    const t = ++PQG.tok.city; pqBox('pqCity', 'Loading cities…', true);
    try { const rows = await pqGeo(path); if (t !== PQG.tok.city) return; PQG.cities = rows; pqListOpts('pqCityList', rows); pqBox('pqCity', 'Type to search city / municipality…', false); }
    catch (e) { if (t === PQG.tok.city) { pqBox('pqCity', 'Could not load — choose the province again', true); pqErr('city', e.message); } }
  }
  async function pqOnCity() {
    const name = pqClean(el('pqCity').value);
    if (name && name.toLowerCase() === PQG.city.toLowerCase()) return;
    pqReset('barangay'); pqErr('city', ''); pqErr('barangay', ''); if (!name) return;
    const city = PQG.cities.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!city) { if (PQG.cities.length) pqErr('city', 'Pick the city / municipality from the list.'); return; }
    el('pqCity').value = city.name; PQG.city = city.name;
    const t = ++PQG.tok.bgy; pqBox('pqBrgy', 'Loading barangays…', true);
    try { const rows = await pqGeo('/api/geo/cities/' + encodeURIComponent(city.code) + '/barangays'); if (t !== PQG.tok.bgy) return; PQG.barangays = rows; pqListOpts('pqBgyList', rows); pqBox('pqBrgy', rows.length ? 'Type to search barangay…' : 'Type the barangay', false); }
    catch (e) { if (t === PQG.tok.bgy) pqBox('pqBrgy', 'Type the barangay', false); }
  }
  function pqOnBarangay() {
    pqErr('barangay', ''); const name = pqClean(el('pqBrgy').value); if (!name) return;
    const b = PQG.barangays.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (b) el('pqBrgy').value = b.name; else if (PQG.barangays.length) pqErr('barangay', 'Pick the barangay from the list.');
  }
  function pqResetArea() { el('pqRegion').value = ''; pqReset('province'); ['region', 'province', 'city', 'barangay', 'street'].forEach((f) => pqErr(f, '')); }

  function renderPosQuoteForm() {
    const sel = el('pqProduct'); if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">Other / custom item…</option>' + PRODUCTS.map((p) => '<option value="' + esc(p.sku) + '">' + esc(p.name) + (p.spec ? ' — ' + esc(p.spec) : '') + ' (' + esc(p.sku) + ')</option>').join('');
    if (keep && prod(keep)) sel.value = keep;
    ensureFields(); pqProductChanged();
  }
  async function ensureFields() {
    if (pqMounted || !el('pqFields')) return;
    let o;
    try { o = await api('/api/pos/quote-options'); window.PQ_OPTIONS = o; }
    catch (e) { el('pqFields').innerHTML = '<div class="qd-load-error" role="alert"><strong>The product specifications could not be loaded.</strong><p>' +
      esc(e instanceof TypeError ? 'No connection to the server.' : e.message || 'The server refused the request.') + '</p><button type="button" class="btn-secondary" id="pqRetryOptions">Try again</button></div>';
      el('pqRetryOptions').onclick = () => { el('pqFields').innerHTML = '<p class="dim">Loading the form…</p>'; ensureFields(); }; return; }
    if (pqMounted) return;
    QuoteFields.mount(el('pqFields'), { prefix: 'pq', options: o, flexible: isFlexible, estimate: 'staff', productSku: () => el('pqProduct').value || '' });
    pqMounted = true;
    if (FA && !pqDraft) {
      pqDraft = FA.draft('posQuote', el('pqForm'), ['pqProduct', 'pqItem', 'pqS_itemType', 'pqS_material', 'pqS_size', 'pqS_thickness', 'pqS_finish', 'pqS_service',
        'pqQty', 'pqUnit', 'pqNeeded', 'pqNotes', 'pqName', 'pqPhone', 'pqEmail', 'pqCompany', 'pqStreet'],
        { ignoreDefault: (id) => id === 'pqUnit', banner: el('qdFormSections'), onDiscard: () => { el('pqForm').reset(); el('pqProduct').value = ''; QuoteFields.reset('pq'); pqProductChanged(); } });
      setTimeout(() => pqDraft.restore().then(pqMinWarn), 0);
    }
    // the date stays next to Quantity, exactly where the online form has it; the counter-only "No fixed date" switch sits under it
    const dateField = el('pqNeeded') && el('pqNeeded').closest('.q-field'), flex = el('pqFlexible') && el('pqFlexible').closest('label');
    if (dateField && flex) { dateField.appendChild(flex); const holder = el('pqFlexHolder'); if (holder) holder.remove(); }
    pqProductChanged(); buildReview();
  }
  function pqProductChanged() {
    const p = prod(el('pqProduct').value);
    el('pqNameWrap').hidden = !!p; if (p) pqErr('productName', '');
    if (pqMounted) { QuoteFields.autofill('pq', p ? p.specs : null); if (p) QuoteFields.setUnit('pq', p.unit); QuoteFields.estimate('pq'); }
  }
  function collectForm() {
    const f = pqFulfil(), r = pqMounted ? QuoteFields.read('pq') : {};
    const b = { contactName: el('pqName').value.trim(), phone: el('pqPhone').value.replace(/[\s().-]/g, ''),
      contactEmail: el('pqEmail').value.trim() || undefined, company: el('pqCompany').value.trim() || undefined,
      sku: el('pqProduct').value || undefined, productName: el('pqItem').value.trim() || undefined, fulfillment: f,
      neededBy: pqNeededVal() || undefined, flexibleDate: isFlexible() };
    Object.assign(b, r);
    if (f === 'Delivery') Object.assign(b, { region: el('pqRegion').value, province: el('pqProvince').value, city: pqClean(el('pqCity').value), barangay: pqClean(el('pqBrgy').value), street: el('pqStreet').value.trim() || undefined });
    return b;
  }
  function buildReview() {
    const box = el('qdReview'); if (!box) return;
    const d = collectForm(), sp = d.specs || {}, p = prod(d.sku);
    // the same rows, order and labels as the customer's review in the online shop; optional details left empty are not listed
    const spec = (v) => v || 'Not specified';
    const rows = [['Product', p ? p.name + ' (' + p.sku + ')' : d.productName], ['Item type', p ? '' : d.itemType || sp.itemType],
      ['Material', spec(sp.material)], ['Size', spec(sp.size)], ['Thickness', spec(sp.thickness)], ['Finish', spec(sp.finish)], ['Machining / secondary work', spec(sp.service)],
      ['Quantity', [d.quantity, d.quantityUnit].filter(Boolean).join(' ')], ['Needed by', d.neededBy ? day(d.neededBy) : d.flexibleDate ? 'No fixed date' : ''],
      ['Extra notes', d.notes || sp.notes], ['Receive by', d.fulfillment],
      ['Delivery area', d.fulfillment === 'Delivery' ? [d.street, d.barangay, d.city, d.province, d.region].filter(Boolean).join(', ') : ''],
      ['Contact name', d.contactName], ['Mobile number', d.phone], ['Email', d.contactEmail], ['Company', d.company]].filter(([, v]) => v);
    box.innerHTML = '<div class="qd-review"><h3>Review quotation request</h3><p>Please double-check the specifications and contact details with the customer.</p>' +
      rows.map(([k, v]) => '<div class="qd-review-row"><span>' + esc(k) + '</span><strong>' + esc(String(v)) + '</strong></div>').join('') +
      '<p class="qd-review-note">This is only a request for pricing and availability. No stock is reserved and no payment is taken.</p>' +
      '<div class="qd-review-actions"><button type="button" class="btn-secondary" data-act="edit">Edit details</button><button type="button" class="btn-primary" id="qdConfirmSave">Confirm &amp; save</button></div></div>';
  }
  function showFormStep() { const box = el('qdReview'); box.innerHTML = ''; box.hidden = true; el('qdFormSections').hidden = false; el('pqProduct').focus(); }
  let saving = false;
  async function saveWalkIn() {
    if (saving) return;                                             // a double click must never make two requests
    const err = el('pqErr'); err.textContent = '';
    const f = pqFulfil();
    const fields = ['contactName', 'phone', 'email', 'company', 'productName', 'neededBy'].concat(f === 'Delivery' ? ['region', 'province', 'city', 'barangay', 'street'] : []);
    let first = null;
    fields.forEach((k) => { if (!pqField(k) && !first) first = PQ_IDS[k] || (k === 'neededBy' ? 'pqNeeded' : null); });
    if (pqMounted) { const qf = QuoteFields.validate('pq'); if (!qf.ok && !first) first = qf.focus; }
    if (first) { err.textContent = 'Please fix the highlighted fields.'; const x = el(first); x.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (x.focus) x.focus({ preventScroll: true }); return; }
    buildReview();
    el('qdFormSections').hidden = true;
    el('qdReview').hidden = false;
    el('qdReview').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  async function commitWalkIn() {
    if (saving) return;
    saving = true;
    const btn = el('qdConfirmSave'); if (btn) btn.disabled = true;
    const err = el('pqErr'), body = collectForm();
    try {
      const r = await call('/api/pos/quotes', { method: 'POST', body: JSON.stringify(body) });
      const no = r && r.id;
      toast('Saved as ' + (no || 'a new request') + '. Nothing is priced, paid or reserved yet.');
      ['pqName', 'pqPhone', 'pqEmail', 'pqCompany', 'pqItem', 'pqCity', 'pqBrgy', 'pqStreet'].forEach((id) => { el(id).value = ''; el(id).classList.remove('is-bad'); });
      pqResetArea(); Object.keys(PQ_IDS).forEach((k) => pqErr(k, '')); el('pqProduct').value = '';
      if (pqMounted) QuoteFields.reset('pq');
      pqProductChanged(); el('pqFlexible').checked = false; const nd = pqNeededEl(); if (nd) nd.disabled = false;
      if (pqDraft) pqDraft.clear(); if (FA) { FA.markClean(el('pqForm')); ['pqPhone', 'pqEmail'].forEach((id) => FA.note(el(id), '', '', 'match')); pqFeeNote(''); }
      document.querySelector('input[name="pqFulfil"][value="Pickup"]').checked = true; el('pqArea').hidden = true;
      showFormStep(); loadDesk();
      if (no) openDetail(no);                        // straight to the request, where the price is prepared
    } catch (e) {
      if (!QuoteFields.showServerError('pq', e.fields)) err.textContent = fieldErr(e); else err.textContent = 'Please fix the highlighted fields.';
      showFormStep();
    } finally { saving = false; if (btn) btn.disabled = false; }
  }

  /* ================= 6. wiring ================= */
  function wire() {
    el('qdTabRequests').addEventListener('click', () => showView('requests'));
    el('qdTabWalkin').addEventListener('click', () => showView('walkin'));
    let timer;
    el('qdSearch').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(timer); S.page = 1; timer = setTimeout(loadDesk, 350); });
    el('qdSource').innerHTML = SOURCES.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('');
    el('qdSize').innerHTML = PAGE_SIZES.map((n) => '<option value="' + n + '"' + (n === 10 ? ' selected' : '') + '>' + n + ' rows</option>').join('');
    el('qdSource').addEventListener('change', (e) => { S.source = e.target.value; S.page = 1; loadDesk(); });
    el('qdSize').addEventListener('change', (e) => { S.pageSize = Number(e.target.value); S.page = 1; loadDesk(); });
    el('qdRefresh').addEventListener('click', loadDesk);
    // the chip bar sits in the toolbar, outside #qdDesk, so it needs its own listener
    el('qdChips').addEventListener('click', (e) => { const chip = e.target.closest('[data-filter]'); if (chip && chip.dataset.filter !== S.filter) { S.filter = chip.dataset.filter; S.page = 1; loadDesk(); } });
    el('qdDesk').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]'); if (th) { const k = th.dataset.sort; if (S.sort === k) S.dir = S.dir === 'asc' ? 'desc' : 'asc'; else { S.sort = k; S.dir = 'desc'; } S.page = 1; loadDesk(); return; }
      const pg = e.target.closest('[data-page]'); if (pg) { S.page = Math.min(S.pageCount, Math.max(1, S.page + (pg.dataset.page === 'next' ? 1 : -1))); loadDesk(); return; }
      if (e.target.closest('[data-retry]')) { loadDesk(); return; }
      const row = e.target.closest('[data-open]'); if (row) openDetail(row.dataset.open);
    });
    el('qdDesk').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.open) { e.preventDefault(); openDetail(e.target.dataset.open); } });

    el('qdScrim').addEventListener('click', closeDetail);
    el('qdDrawerClose').addEventListener('click', closeDetail);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.detail) { if (!el('qdClarifyOverlay').hidden) closeClarify(); else closeDetail(); } });
    el('qdDrawerBody').addEventListener('input', (e) => {
      liveDeskField(e.target);
      if (e.target.matches('[data-rqty]')) { readRecipe(e.target.form); S.recipeMode = 'edited'; recalcDraft(e.target.form); return; }
      if (e.target.name === 'unit') { if (!S.fillingUnit) { e.target.dataset.auto = ''; const n = e.target.form.querySelector('[data-unit-note]'); if (n) n.textContent = 'your price'; }
        const d = S.detail, q = qtyParts(d.quantity), out = e.target.form.querySelector('[data-total]');
        const okNum = /^\d+(\.\d{1,2})?$/.test(e.target.value.trim());
        if (out) out.textContent = q && okNum ? peso(Number(e.target.value) * q.qty) : '—';
        syncRoute(e.target.form, q && okNum ? Number(e.target.value) * q.qty : 0);
        clearTimeout(termTimer);
        termTimer = setTimeout(() => loadTermOptions(e.target.form, q && okNum ? Number(e.target.value) * q.qty : 0, (d.terms || {}).key), 350); }
    });
    el('qdDrawerBody').addEventListener('change', (e) => {
      liveDeskField(e.target);
      if (e.target.name === 'leadTime') updateReady(e.target.form);
      if (e.target.name === 'term') { syncTermFields(e.target.form); if (e.target.form.id === 'qdPriceForm') { const u = e.target.form.elements.unit, q = qtyParts(S.detail.quantity); syncRoute(e.target.form, u && q ? Number(u.value) * q.qty : 0); } }
      if (e.target.matches('[data-rsku], [data-runit]')) {
        if (e.target.matches('[data-rsku]')) { readRecipe(e.target.form); const m = (S.mats || []).find((x) => x.sku === e.target.value); const i = +e.target.closest('.qd-rline').dataset.i; if (m && S.lines[i]) S.lines[i].unit = m.unit; renderRecipe(e.target.form); }
        else readRecipe(e.target.form);
        S.recipeMode = 'edited'; recalcDraft(el('qdPriceForm'));
      }
    });
    el('qdDrawerBody').addEventListener('submit', (e) => {
      if (e.target.id === 'qdPriceForm') { e.preventDefault(); submitPrice(e.target); }
      if (e.target.id === 'qdTermsForm') { e.preventDefault(); saveTerms(e.target); }
    });
    el('qdDrawerFoot').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'close') closeDetail();
      else if (act === 'clarify') doClarify();
      else if (act === 'convert') doConvert();
      else if (['accept', 'decline', 'renew'].includes(act)) doRespond(act);
      else if (act === 'refresh') doRefresh();
      else if (act === 'print-invoice') printQuoteInvoiceCashier(S.detail);
    });
    el('qdDrawerBody').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'price') { S.openPrice = true; renderDetail(); }
      if (b.dataset.act === 'cancelprice') { S.openPrice = false; renderDetail(); }
      if (b.dataset.act === 'terms') { S.openTerms = true; renderDetail(); }
      if (b.dataset.act === 'cancelterms') { S.openTerms = false; renderDetail(); }
      if (['jobissue', 'jobfinish', 'complete'].includes(b.dataset.act)) jobAction(b.dataset.act);
      if (b.dataset.act === 'collect') doCollect();
      if (b.dataset.act === 'checkpay') doCheckPay();
    });
    el('qdDrawerBody').addEventListener('change', (e) => {      // a reference is only asked for when the money did not come as cash
      const f = e.target.closest('#qdCollectForm'); if (!f || e.target.name !== 'method') return;
      f.querySelector('[data-refrow]').hidden = e.target.value === 'Cash';
      liveDeskField(f.elements.reference);
    });
    el('qdDrawerBody').addEventListener('focusout', e => liveDeskField(e.target));
    el('qdDrawerBody').addEventListener('click', (e) => {
      const form = el('qdPriceForm'); if (!form || !form.contains(e.target)) return;
      if (e.target.closest('[data-use-sys]')) { const u = form.elements.unit; u.dataset.auto = '1'; const n = form.querySelector('[data-unit-note]'); if (n) n.textContent = 'filled in with the suggested price'; fillUnit(form); u.focus(); }
      if (e.target.closest('[data-radd]')) { readRecipe(form); S.lines.push({ sku: '', qtyPerPiece: '', unit: '' }); renderRecipe(form); const all = form.querySelectorAll('.qd-rline [data-rsku]'); if (all.length) all[all.length - 1].focus(); }
      if (e.target.closest('[data-rdel]')) { readRecipe(form); S.lines.splice(+e.target.closest('.qd-rline').dataset.i, 1); S.recipeMode = 'edited'; renderRecipe(form); recalcDraft(form); }
      if (e.target.closest('[data-rauto]')) { S.recipeMode = 'auto'; S.lines = null; S.recipeAuto = true; recalcDraft(form); }
    });

    el('pqClarifyCancel').addEventListener('click', closeClarify);
    el('qdClarifyOverlay').addEventListener('click', (e) => { if (e.target === el('qdClarifyOverlay')) closeClarify(); });

    el('pqProduct').addEventListener('change', pqProductChanged);
    document.querySelectorAll('input[name="pqFulfil"]').forEach((r) => r.addEventListener('change', () => {
      el('pqArea').hidden = pqFulfil() !== 'Delivery';
      ['region', 'province', 'city', 'barangay', 'street'].forEach((f) => pqErr(f, ''));
      if (pqFulfil() === 'Delivery' && !PQG.regions.length) pqLoadRegions();
    }));
    el('pqRegion').addEventListener('change', pqOnRegion);
    el('pqProvince').addEventListener('change', pqOnProvince);
    el('pqCity').addEventListener('change', pqOnCity);
    el('pqBrgy').addEventListener('change', pqOnBarangay);
    el('pqFlexible').addEventListener('change', () => { const x = pqNeededEl(); if (!x) return; x.disabled = isFlexible(); if (isFlexible()) x.value = ''; pqField('neededBy'); });
    Object.keys(PQ_IDS).forEach((f) => { const x = el(PQ_IDS[f]); x.addEventListener('blur', () => pqField(f)); x.addEventListener('input', () => { pqField(f); el('pqErr').textContent = ''; }); });
    el('pqPhone').addEventListener('input', () => { const p = el('pqPhone'), d = p.value.replace(/[^\d+\s]/g, ''); if (d !== p.value) p.value = d; });
    el('pqForm').addEventListener('submit', (e) => { e.preventDefault(); saveWalkIn(); });
    if (FA) {
      el('pqForm').addEventListener('input', (e) => { if (e.target.id === 'pqQty') pqMinWarn(); });
      el('pqProduct').addEventListener('change', pqMinWarn);
      ['pqPhone', 'pqEmail'].forEach((id) => el(id).addEventListener('blur', () => setTimeout(() => pqMatch(el(id)), 0)));   // after the phone is put in its one format
      FA.zipFill({ before: el('pqRegion').closest('.q-grid'), region: el('pqRegion'), province: el('pqProvince'), city: el('pqCity'), barangay: el('pqBrgy'), api: (u) => api(u) });
      FA.keyboard(el('pqForm'));
      FA.guard(el('pqForm'));
    }
    el('qdReview').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="edit"]')) showFormStep();
      if (e.target.closest('#qdConfirmSave')) commitWalkIn();
    });
  }

  /* page glue: showPage('quotes') and the start-up poll both call these */
  window.renderPosQuoteForm = renderPosQuoteForm;
  window.loadPosQuotes = function () { if (el('qdDesk')) loadDesk(); };
  window.initQuoteDesk = function () { if (window.__qdWired) return; window.__qdWired = true; wire(); renderPosQuoteForm(); loadDesk(); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.initQuoteDesk);
  else window.initQuoteDesk();
})();
