/* Cashier customer directory + product review moderation.
   Click anywhere on a customer row to open the customer's details (same layout Finance uses). Click a review row to see
   the review together with who wrote it. Passwords, hashes and verification tokens are never sent to this screen. */
(function () {
'use strict';
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shown = v => (v == null || String(v).trim() === '' ? 'Not provided' : esc(v));
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || '?';
const isActive = v => String(v || '').toLowerCase() === 'active';
const stars = n => '<span class="cm-stars" aria-label="' + n + ' out of 5">' + '\u2605'.repeat(n) + '<i>' + '\u2605'.repeat(5 - n) + '</i></span>';
const day = ms => (ms ? new Date(ms).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : '');

let people = [], reviewList = [], lastFocus = null, token = 0;
let peopleFilter = 'all', reviewFilter = 'all', peopleLoaded = false, reviewsLoaded = false;
const listStars = n => '<span class="cmx-stars" aria-label="' + n + ' out of 5">' + '\u2605'.repeat(n) + '<i>' + '\u2605'.repeat(5 - n) + '</i></span>';
const busy = (id, on) => { const b = el(id); if (b) b.classList.toggle('spin', !!on); };
const chipBar = (id, list, cur, attr) => { const bar = el(id); if (bar) bar.innerHTML = list.map(([k, label, n]) => '<button type="button" class="cmx-chip' + (cur === k ? ' on' : '') + '" ' + attr + '="' + k + '" aria-pressed="' + (cur === k) + '">' + esc(label) + '<em>' + n + '</em></button>').join(''); };
const stateBox = (box, title, text, error) => { box.hidden = false; box.className = 'cmx-state' + (error ? ' error' : ''); box.innerHTML = '<strong>' + esc(title) + '</strong>' + esc(text || ''); };

async function request(url, opts) {
  const r = await fetch(url, { credentials: 'include', ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || 'Request failed (' + r.status + ')');
  return j;
}

/* ---------- styles (the cashier page does not load the Finance customer styles) ---------- */
function addStyles() {
  if (el('cmStyles')) return;
  const s = document.createElement('style'); s.id = 'cmStyles';
  s.textContent = `
.cm-row{cursor:pointer;transition:background .15s}.cm-row:hover{background:var(--hover)}.cm-row:focus-visible{outline:2px solid var(--blue-bright);outline-offset:-2px}
.cm-pill{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid var(--border)}
.cm-pill.on{color:var(--green);border-color:var(--green)}.cm-pill.off{color:var(--red);border-color:var(--red)}
.cm-stars{color:var(--amber);letter-spacing:1px;white-space:nowrap}.cm-stars i{font-style:normal;color:var(--border)}
#cmModal{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
#cmModal[hidden]{display:none}
#cmModal .cm-back{position:absolute;inset:0;background:rgba(3,10,16,.66)}
#cmModal .cm-card{position:relative;width:min(640px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow)}
#cmModal .cm-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);z-index:1}
#cmModal .cm-head h2{margin:0;font-size:18px}
#cmModal .cm-x{border:0;background:transparent;color:var(--text);font-size:26px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:6px}
#cmModal .cm-x:hover{background:var(--hover)}
#cmModal .cm-body{padding:18px 20px 22px}
#cmModal .cm-top{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:6px}
#cmModal .cm-av{width:48px;height:48px;border-radius:50%;background:var(--inset);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
#cmModal .cm-top strong{display:block;font-size:16px}#cmModal .cm-top span.dim{font-size:13.5px;overflow-wrap:anywhere}
#cmModal .cm-tabs{display:flex;gap:6px;margin:14px 0 4px;border-bottom:1px solid var(--border)}
#cmModal .cm-tab{border:0;background:transparent;color:var(--text-dim);padding:8px 12px;cursor:pointer;font:inherit;border-bottom:2px solid transparent;margin-bottom:-1px}
#cmModal .cm-tab.active{color:var(--text);border-bottom-color:var(--blue-bright);font-weight:600}
#cmModal h3{margin:0 0 12px;font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-weight:500;letter-spacing:1.4px;text-transform:uppercase;color:var(--blue-bright)}
#cmModal .cm-sec{margin-top:14px;padding:16px 18px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
#cmModal .cm-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px}
@media(max-width:520px){#cmModal .cm-grid{grid-template-columns:1fr}}
#cmModal .cm-f{min-width:0}
#cmModal .cm-f span{display:block;font-size:12px;color:var(--text-faint);margin-bottom:3px}
#cmModal .cm-f strong{display:block;font-size:14.5px;line-height:1.35;font-weight:500;overflow-wrap:anywhere}#cmModal .cm-f.is-empty strong{color:var(--text-faint);font-weight:400;font-size:14px}
#cmModal .cm-flag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:12.5px;font-weight:600;border:1px solid currentColor}
#cmModal .cm-flag.yes{color:var(--green,#15803d)}#cmModal .cm-flag.no{color:var(--amber,#b7791f)}
#cmModal .cm-av{width:56px;height:56px;font-size:18px;background:var(--u-chip-bg,var(--inset));color:var(--blue-bright)}
#cmModal .cm-top{padding-bottom:4px;flex-wrap:nowrap}
#cmModal .cm-rev-main{padding:16px 18px;border-radius:12px}
#cmModal .cm-rev-main strong{font-size:16px}
#cmModal .cm-rev-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
#cmModal .cm-quote{margin:12px 0 0;padding:10px 14px;border-left:3px solid var(--blue-bright);background:var(--inset,transparent);border-radius:0 8px 8px 0;font-size:15px;line-height:1.5;overflow-wrap:anywhere}
#cmModal .cm-sec .cm-top{margin:0}
#cmModal .cm-actions{justify-content:flex-end;padding-top:14px;border-top:1px solid var(--border)}
#cmModal .cm-tabs{gap:4px;margin-top:12px}
#cmModal .cm-rev{padding:12px 14px;border:1px solid var(--border);border-radius:10px;margin-top:10px;background:var(--card)}
#cmModal .cm-rev header{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
#cmModal .cm-rev p{margin:8px 0 0;white-space:pre-line;overflow-wrap:anywhere;line-height:1.5}
#cmModal .cm-rev small,#cmModal .cm-note{color:var(--text-dim);font-size:12.5px}
#cmModal .cm-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
#cmModal .cm-err{color:var(--red);font-size:13px;min-height:18px;margin-top:6px}
#cmModal input.cm-reason{display:block;width:100%;margin-top:6px}
.cm-danger{background:transparent;color:var(--red);border:1px solid var(--red);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit}`;
  document.head.appendChild(s);
}
function ensureModal() {
  addStyles();
  if (el('cmModal')) return;
  const m = document.createElement('div'); m.id = 'cmModal'; m.hidden = true;
  m.innerHTML = '<div class="cm-back" data-cm-close></div><div class="cm-card" role="dialog" aria-modal="true" aria-labelledby="cmTitle" tabindex="-1">' +
    '<div class="cm-head"><h2 id="cmTitle"></h2><button type="button" class="cm-x" data-cm-close aria-label="Close">\u00D7</button></div><div class="cm-body" id="cmBody"></div></div>';
  document.body.appendChild(m);
  m.addEventListener('click', e => { if (e.target.closest('[data-cm-close]')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) closeModal(); });
}
function openModal(title) { ensureModal(); lastFocus = document.activeElement; el('cmTitle').textContent = title; el('cmModal').hidden = false; el('cmModal').querySelector('.cm-x').focus(); }
function closeModal() { token++; const m = el('cmModal'); if (m) m.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
const field = (l, v, raw) => '<div class="cm-f' + (!raw && (v == null || String(v).trim() === '') ? ' is-empty' : '') + '"><span>' + esc(l) + '</span><strong>' + (raw || shown(v)) + '</strong></div>';
const section = (t, items) => '<section class="cm-sec"><h3>' + esc(t) + '</h3><div class="cm-grid">' + items.map(i => field(i[0], i[1], i[2])).join('') + '</div></section>';
const flag = (ok, yes, no) => '<span class="cm-flag ' + (ok ? 'yes' : 'no') + '">' + (ok ? yes : no) + '</span>';
const loadReviewList = () => request('/api/finance/reviews');

/* ---------- customers ---------- */
function renderPeople() {
  const q = (el('cmSearch').value || '').toLowerCase().trim();
  const active = people.filter(u => isActive(u.status)).length;
  chipBar('cmChips', [['all', 'All', people.length], ['active', 'Active', active], ['disabled', 'Disabled', people.length - active], ['reviewers', 'Wrote reviews', people.filter(u => u.reviews > 0).length]], peopleFilter, 'data-cm-filter');
  const list = people.filter(u => (peopleFilter === 'all' || (peopleFilter === 'active' ? isActive(u.status) : peopleFilter === 'disabled' ? !isActive(u.status) : u.reviews > 0)) &&
    (!q || (u.name + ' ' + u.email + ' ' + (u.phone || '') + ' ' + (u.username || '')).toLowerCase().includes(q)));
  const pill = u => '<span class="cmx-pill ' + (isActive(u.status) ? 'ok' : 'bad') + '">' + (isActive(u.status) ? 'Active' : 'Disabled') + '</span>';
  el('cmRows').innerHTML = list.map(u => '<tr tabindex="0" aria-label="View details for ' + esc(u.name) + '" data-profile="' + Number(u.id) + '">' +
    '<td><div class="cmx-who"><span class="cmx-av" aria-hidden="true">' + esc(initials(u.name)) + '</span><div><b>' + esc(u.name) + '</b><small>' + esc(u.email) + '</small></div></div></td>' +
    '<td class="cmx-num">' + esc(u.phone || '\u2014') + '</td><td>' + esc(u.joined || '\u2014') + '</td><td>' + (u.lastLogin ? esc(u.lastLogin) : '<span class="cmx-sub">Never</span>') + '</td>' +
    '<td class="is-right cmx-num">' + (u.orders || 0) + '</td><td class="is-right cmx-num">' + (u.reviews || 0) + '</td><td>' + pill(u) + '</td>' +
    '<td class="is-right"><button type="button" class="cmx-btn" data-profile="' + Number(u.id) + '">View</button></td></tr>').join('');
  el('cmCards').innerHTML = list.map(u => '<div class="cmx-card" tabindex="0" role="button" aria-label="View details for ' + esc(u.name) + '" data-profile="' + Number(u.id) + '">' +
    '<div class="cmx-line"><div class="cmx-who"><span class="cmx-av" aria-hidden="true">' + esc(initials(u.name)) + '</span><div><b>' + esc(u.name) + '</b><small>' + esc(u.email) + '</small></div></div>' + pill(u) + '</div>' +
    '<div class="cmx-line cmx-mut"><span>' + esc(u.phone || 'No phone') + '</span><span>' + (u.orders || 0) + ' orders \u00B7 ' + (u.reviews || 0) + ' reviews</span></div></div>').join('');
  const empty = el('cmEmpty'), has = list.length > 0;
  el('cmTableWrap').style.display = has ? '' : 'none'; el('cmCards').style.display = has ? '' : 'none';
  if (!has) stateBox(empty, people.length ? 'No customer matches' : 'No registered customers yet', people.length ? 'Try another name, or clear the filter.' : 'Customers appear here once they sign up in the online shop.');
  else empty.hidden = true;
  el('cmMessage').textContent = has ? 'Showing ' + list.length + ' of ' + people.length + ' customer' + (people.length === 1 ? '' : 's') + '. Click a row for the full profile and their reviews.' : '';
}
async function loadPeople() {
  busy('cmRefresh', true); if (!peopleLoaded) el('cmMessage').textContent = 'Loading customers\u2026';
  try { people = await request('/api/pos/customer-directory'); peopleLoaded = true; renderPeople(); }
  catch (e) { el('cmMessage').textContent = ''; el('cmTableWrap').style.display = 'none'; el('cmCards').style.display = 'none'; stateBox(el('cmEmpty'), 'Could not load customers', e.message, true); }
  finally { busy('cmRefresh', false); }
}
function reviewsHtml(list) {
  if (!list.length) return '<p class="cm-note" style="margin-top:14px">This customer has not reviewed any product yet.</p>';
  const avg = (list.reduce((t, r) => t + r.rating, 0) / list.length).toFixed(1);
  return '<p class="cm-note" style="margin:14px 0 0">' + list.length + ' review' + (list.length === 1 ? '' : 's') + ' \u00B7 average ' + avg + '/5 \u00B7 ' + list.filter(r => r.status === 'hidden').length + ' hidden</p>' +
    list.map(r => '<article class="cm-rev"><header><div><strong>' + esc(r.product) + '</strong><br><small>' + esc(r.sku) + (r.orderNo ? ' \u00B7 Order ' + esc(r.orderNo) : '') + '</small></div>' + stars(r.rating) + '</header><p>' +
      (r.body ? esc(r.body) : '<em>No comment</em>') + '</p><small>' + esc(day(r.createdAt)) + ' \u00B7 ' + (r.status === 'hidden' ? 'Hidden' : 'Visible') + '</small></article>').join('');
}
async function openProfile(id) {
  const base = people.find(x => String(x.id) === String(id)) || {};
  const tok = ++token; openModal(base.name || 'Customer details');
  el('cmBody').innerHTML = '<p class="cm-note">Loading profile\u2026</p>';
  try {
    const d = await request('/api/pos/customers/' + encodeURIComponent(id) + '/profile'); if (tok !== token) return;
    el('cmTitle').textContent = d.name || 'Customer details';
    el('cmBody').innerHTML = '<div class="cm-top"><span class="cm-av" aria-hidden="true">' + esc(initials(d.name)) + '</span><div><strong>' + shown(d.name) + '</strong><span class="dim">' + shown(d.email) + '</span></div>' +
      '<span class="cm-pill ' + (isActive(d.status) ? 'on' : 'off') + '" style="margin-left:auto">' + (isActive(d.status) ? 'Active' : 'Disabled') + '</span></div>' +
      '<div class="cm-tabs" role="tablist"><button type="button" role="tab" class="cm-tab active" data-cm-tab="profile">Profile</button><button type="button" role="tab" class="cm-tab" data-cm-tab="reviews">Reviews <b id="cmRevCount">\u2026</b></button></div>' +
      '<div data-cm-pane="profile">' +
        section('Personal information', [['First name', d.firstName], ['Middle name', d.middleName], ['Last name', d.lastName], ['Suffix', d.suffix], ['Birthdate', d.birthdate], ['Gender', d.gender]]) +
        section('Contact & account', [['Email', d.email], ['Phone', d.phone], ['Username', d.username], ['Email verified', '', flag(d.emailVerified, 'Verified', 'Not verified')], ['Joined', d.joined], ['Last login', d.lastLogin]]) +
        section('Company', [['Company', d.companyName], ['Position', d.companyPosition]]) + '</div>' +
      '<div data-cm-pane="reviews" hidden><p class="cm-note">Loading reviews\u2026</p></div>';
    loadReviewList().then(all => { if (tok !== token) return; const mine = all.filter(r => String(r.userId) === String(id)); el('cmRevCount').textContent = mine.length; el('cmBody').querySelector('[data-cm-pane="reviews"]').innerHTML = reviewsHtml(mine); })
      .catch(e => { if (tok === token) el('cmBody').querySelector('[data-cm-pane="reviews"]').innerHTML = '<p class="cm-err">' + esc(e.message) + '</p>'; });
  } catch (e) { if (tok === token) el('cmBody').innerHTML = '<p class="cm-err">' + esc(e.message) + '</p>'; }
}

/* ---------- product reviews ---------- */
function renderReviewKpis() {
  const box = el('cmReviewKpis'); if (!box) return;
  const vis = reviewList.filter(r => r.status !== 'hidden'), hidden = reviewList.length - vis.length;
  const avg = vis.length ? vis.reduce((t, r) => t + r.rating, 0) / vis.length : 0, low = vis.filter(r => r.rating <= 2).length;
  const mix = [5, 4, 3, 2, 1].map(n => { const c = vis.filter(r => r.rating === n).length; return '<div><span>' + n + '\u2605</span><i><b style="width:' + (vis.length ? Math.round(c * 100 / vis.length) : 0) + '%"></b></i><span>' + c + '</span></div>'; }).join('');
  box.innerHTML = '<div class="cmx-kpi ok"><span>Average rating</span><strong>' + (vis.length ? avg.toFixed(1) : '\u2014') + '</strong><small>' + (vis.length ? listStars(Math.round(avg)) + ' from ' + vis.length + ' visible' : 'No visible reviews yet') + '</small></div>' +
    '<div class="cmx-kpi"><span>Rating mix</span><div class="cmx-mix">' + mix + '</div></div>' +
    '<div class="cmx-kpi' + (low ? ' warn' : '') + '"><span>Needs attention (1\u20132 stars)</span><strong>' + low + '</strong>' + (low ? '<button type="button" data-cm-rfilter="low">Show them</button>' : '<small>Nothing to follow up</small>') + '</div>' +
    '<div class="cmx-kpi"><span>Hidden from the shop</span><strong>' + hidden + '</strong>' + (hidden ? '<button type="button" data-cm-rfilter="hidden">Show them</button>' : '<small>of ' + reviewList.length + ' reviews</small>') + '</div>';
}
function renderReviews() {
  renderReviewKpis();
  const q = (el('cmReviewSearch').value || '').toLowerCase().trim(), rt = el('cmReviewRating').value;
  const vis = reviewList.filter(r => r.status !== 'hidden');
  chipBar('cmReviewChips', [['all', 'All', reviewList.length], ['visible', 'Visible', vis.length], ['low', 'Needs attention', vis.filter(r => r.rating <= 2).length], ['hidden', 'Hidden', reviewList.length - vis.length]], reviewFilter, 'data-cm-rfilter');
  const list = reviewList.filter(r => (reviewFilter === 'all' || (reviewFilter === 'low' ? r.status !== 'hidden' && r.rating <= 2 : r.status === reviewFilter)) &&
    (rt === 'all' || String(r.rating) === rt) && (!q || (r.product + ' ' + r.sku + ' ' + r.customer + ' ' + (r.body || '')).toLowerCase().includes(q)));
  const pill = r => '<span class="cmx-pill ' + (r.status === 'hidden' ? 'bad' : 'ok') + '">' + (r.status === 'hidden' ? 'Hidden' : 'Visible') + '</span>';
  const act = r => '<button type="button" class="cmx-btn' + (r.status === 'hidden' ? '' : ' danger') + '" data-review-act="' + Number(r.id) + '">' + (r.status === 'hidden' ? 'Restore' : 'Hide') + '</button>';
  const text = r => r.body ? '<div class="cmx-text">' + esc(r.body) + '</div>' : '<div class="cmx-text none">No comment, rating only</div>';
  el('cmReviewRows').innerHTML = list.map(r => '<tr tabindex="0" aria-label="View review by ' + esc(r.customer) + '" data-review-row="' + Number(r.id) + '">' +
    '<td><div class="cmx-who"><div><b>' + esc(r.product) + '</b><small>' + esc(r.sku) + (r.orderNo ? ' \u00B7 ' + esc(r.orderNo) : '') + '</small></div></div></td>' +
    '<td>' + listStars(r.rating) + '<small>' + r.rating + '/5</small></td><td>' + text(r) + (r.status === 'hidden' && r.hiddenReason ? '<small class="cmx-sub" style="max-width:42ch">Hidden: ' + esc(r.hiddenReason) + '</small>' : '') + '</td>' +
    '<td><div class="cmx-who"><span class="cmx-av" aria-hidden="true">' + esc(initials(r.customer)) + '</span><div><b>' + esc(r.customer) + '</b></div></div></td>' +
    '<td style="white-space:nowrap">' + esc(day(r.createdAt)) + '</td><td>' + pill(r) + '</td><td class="is-right">' + act(r) + '</td></tr>').join('');
  el('cmReviewCards').innerHTML = list.map(r => '<div class="cmx-card" tabindex="0" role="button" aria-label="View review by ' + esc(r.customer) + '" data-review-row="' + Number(r.id) + '">' +
    '<div class="cmx-line"><b>' + esc(r.product) + '</b>' + pill(r) + '</div><div class="cmx-line">' + listStars(r.rating) + '<span class="cmx-mut">' + esc(r.customer) + ' \u00B7 ' + esc(day(r.createdAt)) + '</span></div>' + text(r) +
    '<div class="cmx-line"><span class="cmx-mut">' + esc(r.sku) + '</span>' + act(r) + '</div></div>').join('');
  const box = el('cmReviews'), has = list.length > 0;
  el('cmReviewTable').style.display = has ? '' : 'none'; el('cmReviewCards').style.display = has ? '' : 'none';
  if (!has) stateBox(box, reviewList.length ? 'No review matches' : 'No reviews yet', reviewList.length ? 'Try another search, rating or filter.' : 'Reviews appear here after customers rate products they received.');
  else box.hidden = true;
  el('cmReviewMessage').textContent = has ? 'Showing ' + list.length + ' of ' + reviewList.length + '. Click a review to see who wrote it.' : '';
}
async function loadReviews() {
  busy('cmReviewRefresh', true); if (!reviewsLoaded) el('cmReviewMessage').textContent = 'Loading reviews\u2026';
  try { reviewList = await loadReviewList(); reviewsLoaded = true; renderReviews(); }
  catch (e) { el('cmReviewMessage').textContent = ''; el('cmReviewTable').style.display = 'none'; el('cmReviewCards').style.display = 'none'; stateBox(el('cmReviews'), 'Could not load reviews', e.message, true); }
  finally { busy('cmReviewRefresh', false); }
}
async function setVisibility(rv, hide, reason, errBox, btn) {
  try { if (btn) btn.disabled = true;
    await request('/api/finance/reviews/' + rv.id + '/visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden: hide, reason: reason || '' }) });
    closeModal(); await loadReviews();
    el('cmReviewMessage').textContent = (hide ? 'Hidden: ' : 'Restored: ') + rv.customer + '\u2019s review of ' + rv.product + (hide ? '. Customers no longer see it.' : '. It shows in the shop again.');
  } catch (e) { if (errBox) errBox.textContent = e.message; if (btn) btn.disabled = false; }
}
async function openReview(id, hideNow) {
  const rv = reviewList.find(x => x.id === Number(id)); if (!rv) return;
  const tok = ++token; openModal('Review details');
  function paint(d, note) {
    if (tok !== token) return; d = d || {};
    const hidden = rv.status === 'hidden';
    el('cmBody').innerHTML = '<div class="cm-rev cm-rev-main" style="margin-top:0"><header><div><strong>' + esc(rv.product) + '</strong><br><small>' + esc(rv.sku) + (rv.orderNo ? ' \u00B7 Order ' + esc(rv.orderNo) : '') + ' \u00B7 ' + esc(day(rv.createdAt)) + '</small></div>' +
        '<div class="cm-rev-side">' + stars(rv.rating) + '<span class="cm-flag ' + (hidden ? 'no' : 'yes') + '">' + (hidden ? 'Hidden' : 'Visible') + '</span></div></header>' +
      '<blockquote class="cm-quote">' + (rv.body ? esc(rv.body) : '<em>No comment</em>') + '</blockquote>' +
      (hidden && rv.hiddenReason ? '<small>Hidden: ' + esc(rv.hiddenReason) + (rv.hiddenBy ? ' (' + esc(rv.hiddenBy) + ')' : '') + '</small>' : '') + '</div>' +
      '<section class="cm-sec"><h3>Customer</h3><div class="cm-top"><span class="cm-av" aria-hidden="true">' + esc(initials(d.name || rv.customer)) + '</span><div><strong>' + shown(d.name || rv.customer) + '</strong><span class="dim">' + shown(d.email || rv.email) + '</span></div></div>' +
      (note ? '<p class="cm-note">' + esc(note) + '</p>' : '<div class="cm-grid" style="margin-top:12px">' + field('Phone', d.phone) + field('Birthdate', d.birthdate) + field('Gender', d.gender) + field('Email verified', '', flag(d.emailVerified, 'Verified', 'Not verified')) + field('Joined', d.joined) + field('Last login', d.lastLogin) + field('Company', d.companyName) + field('Position', d.companyPosition) + '</div>') + '</section>' +
      '<div id="cmHideBox"></div><div class="cm-actions"><button type="button" class="' + (rv.status === 'hidden' ? 'btn-secondary' : 'cm-danger') + '" id="cmAct">' + (rv.status === 'hidden' ? 'Restore review' : 'Hide review') + '</button><button type="button" class="btn-secondary" data-cm-close>Close</button></div>';
    el('cmAct').onclick = () => {
      if (rv.status === 'hidden') return setVisibility(rv, false, '', el('cmHideBox'), el('cmAct'));
      el('cmHideBox').innerHTML = '<h3>Reason for hiding</h3><input id="cmReason" class="cm-reason" maxlength="300" placeholder="e.g. Abusive language (kept in the audit log)"><div class="cm-err" id="cmErr" role="alert"></div>' +
        '<div class="cm-actions" style="margin-top:8px"><button type="button" class="cm-danger" id="cmHideGo">Confirm hide</button></div>';
      if (window.FormAssist) FormAssist.validation.bind(el('cmReason'), (value) => value.trim().length < 3 ? 'Enter a reason (at least 3 characters).' : '', el('cmErr'));
      el('cmReason').focus();
      el('cmHideGo').onclick = () => { const r = el('cmReason').value.trim(); if (r.length < 3) { el('cmErr').textContent = 'Enter a reason (at least 3 characters).'; return; } setVisibility(rv, true, r, el('cmErr'), el('cmHideGo')); };
    };
  }
  paint(null, 'Loading customer details\u2026');
  if (hideNow && rv.status !== 'hidden') el('cmAct').click();
  try { if (!rv.userId) throw Error('Customer details unavailable.'); const d = await request('/api/pos/customers/' + encodeURIComponent(rv.userId) + '/profile');
    const typed = el('cmReason') ? el('cmReason').value : null; paint(d); if (typed !== null && el('cmAct')) { el('cmAct').click(); el('cmReason').value = typed; } }
  catch (e) { paint(null, e.message); if (hideNow && rv.status !== 'hidden' && el('cmAct')) el('cmAct').click(); }
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-cm-tab]');
  if (t) { const box = el('cmBody'); box.querySelectorAll('[data-cm-tab]').forEach(x => x.classList.toggle('active', x === t)); box.querySelectorAll('[data-cm-pane]').forEach(p => p.hidden = p.dataset.cmPane !== t.dataset.cmTab); return; }
  const cf = e.target.closest('[data-cm-filter]'); if (cf) { peopleFilter = cf.dataset.cmFilter; return renderPeople(); }
  const rf = e.target.closest('[data-cm-rfilter]'); if (rf) { reviewFilter = rf.dataset.cmRfilter; return renderReviews(); }
  const ra = e.target.closest('[data-review-act]');
  if (ra) {                                                                  // Hide asks for a reason in the review window; Restore is one click
    const rv = reviewList.find(x => x.id === Number(ra.dataset.reviewAct)); if (!rv) return;
    if (rv.status === 'hidden') { ra.disabled = true; return setVisibility(rv, false, '', null, ra); }
    return openReview(rv.id, true);
  }
  const p = e.target.closest('[data-profile]'); if (p) return openProfile(p.dataset.profile);
  const r = e.target.closest('[data-review-row]'); if (r) openReview(r.dataset.reviewRow);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('#page-customers tr[tabindex], #page-reviews tr[tabindex], .cmx-card')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('DOMContentLoaded', () => {
  addStyles();                                                              // the review / profile window styles, before anything opens
  el('cmSearch')?.addEventListener('input', renderPeople);
  el('cmRefresh')?.addEventListener('click', loadPeople);
  el('cmReviewRefresh')?.addEventListener('click', loadReviews);
  el('cmReviewSearch')?.addEventListener('input', renderReviews);
  el('cmReviewRating')?.addEventListener('change', renderReviews);
});
window.cashierCustomers = { load: loadPeople, reviews: loadReviews };
})();
