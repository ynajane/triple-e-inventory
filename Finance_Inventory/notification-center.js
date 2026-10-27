/* Shared Notification Center (bell, dropdown, history page) for Finance, Cashier, and Customer. */
(function () {
  'use strict';

  var CATS = [
    { id: '', label: 'All' },
    { id: 'inventory', label: 'Inventory' },
    { id: 'production', label: 'Production' },
    { id: 'orders', label: 'Orders' },
    { id: 'payment', label: 'Payments' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'pos', label: 'POS' }
  ];
  var LABELS = { inventory: 'Inventory', production: 'Production', orders: 'Orders', payment: 'Payment', delivery: 'Delivery', pos: 'POS', system: 'System' };
  var PAGE_LIMIT = 40;
  var pollTimer = null;
  var dropOpen = false;
  var pageCat = '';
  var pageUnread = false;
  var pageOffset = 0;
  var pageTotal = 0;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fileOf(href) {
    try { return decodeURIComponent((new URL(href, location.href).pathname.split('/').pop() || '')); }
    catch (e) { return ''; }
  }
  function hashOf(href) {
    try { return (new URL(href, location.href).hash || '').replace(/^#/, ''); }
    catch (e) { return String(href || '').split('#')[1] || ''; }
  }

  async function api(path, opts) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts || {}));
    if (res.status === 401) { location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function go(link) {
    if (!link) return;
    var target = fileOf(link);
    var here = decodeURIComponent((location.pathname.split('/').pop() || ''));
    var hash = hashOf(link);
    if (target && target !== here) { location.href = link; return; }
    if (hash) {
      if (typeof window.navigateToPage === 'function' && document.getElementById(hash)) window.navigateToPage(hash);
      else if (typeof window.showPage === 'function') window.showPage(hash);
      else if (typeof window.show === 'function') window.show(hash);
      else location.hash = hash;
    }
  }

  function itemHtml(n, compact) {
    var cls = 'nc-item' + (n.isRead ? '' : ' unread') + (n.severity === 'critical' ? ' critical' : n.severity === 'warn' ? ' warn' : '');
    var resolved = n.isResolved ? '<span class="nc-tag">Resolved</span>' : '';
    return '<button type="button" class="' + cls + '" data-cat="' + esc(n.category || '') + '" data-nc-id="' + n.id + '" data-nc-link="' + esc(n.link || '') + '">' +
      '<span class="nc-dot"></span><span>' +
      '<span class="nc-meta"><span class="nc-cat">' + esc(LABELS[n.category] || n.category) + '</span>' + resolved +
      '<span class="nc-when">' + esc(n.when || '') + '</span></span>' +
      '<span class="nc-title">' + esc(n.title) + '</span>' +
      (compact ? '' : '<span class="nc-body">' + esc(n.body) + '</span>') +
      '</span></button>';
  }


  /* ------------------------------------------------------------------
     Live alerts: pop-up toasts, sound, and the low-stock alarm.
     - Every new notification pops up as a toast (all roles, customers included) with a soft chime.
     - Finance: while ANY product is at/below its reorder level a banner stays on screen and the alarm
       repeats until stock is received and the count rises above the reorder level. Marking the
       notification as read does NOT stop it; only restocking does. Sound can be muted or snoozed.
     ------------------------------------------------------------------ */
  var ICONS = {
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12"/>',
    ok: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
    truck: '<path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    on: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    off: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m23 9-6 6M17 9l6 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>'
  };
  function svg(name) {
    return '<svg class="nc-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }
  function iconFor(n) {
    if (n.severity === 'critical' || n.severity === 'warn') return 'warn';
    if (n.category === 'inventory' || n.category === 'production') return 'box';
    if (n.category === 'delivery') return 'truck';
    if (n.category === 'orders' || n.category === 'payment') return 'ok';
    return 'bell';
  }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  // ---- sound (Web Audio, no files needed) ----
  var AC = window.AudioContext || window.webkitAudioContext;
  var actx = null;
  try { if (AC) actx = new AC(); } catch (e) { actx = null; }
  function soundOn() { return load('tripleE.nc.sound') !== 'off'; }
  function audioReady() { return !!actx && actx.state === 'running'; }
  function unlock() {
    if (actx && actx.state === 'suspended') actx.resume().then(function () { renderBar(); alarmTick(); }).catch(function () {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, unlock, { passive: true }); });

  function tone(freq, at, dur, type, vol) {
    var t0 = actx.currentTime + at, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  // returns true when the sound really played (false = muted or the browser still blocks audio)
  function play(kind) {
    if (!soundOn() || !actx) return false;
    if (actx.state !== 'running') { renderBar(); return false; }
    if (kind === 'chime') {                                   // new notification: two soft rising notes
      tone(659, 0, 0.45, 'sine', 0.18); tone(880, 0.16, 0.6, 'sine', 0.18);
    } else if (kind === 'alarm') {                            // low stock: three alternating beeps
      for (var i = 0; i < 3; i++) tone(i % 2 ? 660 : 880, i * 0.26, 0.2, 'triangle', 0.3);
    } else if (kind === 'critical') {                         // out of stock: five fast, higher beeps
      for (var j = 0; j < 5; j++) tone(j % 2 ? 740 : 988, j * 0.2, 0.15, 'square', 0.16);
    }
    return true;
  }

  // ---- toasts ----
  var toastHost = null;
  function host() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'nc-toasts';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
    return toastHost;
  }
  function closeToast(el) {
    if (!el || el._closing) return;
    el._closing = true; clearTimeout(el._t);
    el.classList.remove('show');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
  }
  function showToast(n) {
    var h = host();
    while (h.children.length >= 4) closeToast(h.firstChild);
    var sev = n.severity === 'critical' ? ' critical' : n.severity === 'warn' ? ' warn' : '';
    var el = document.createElement('div');
    el.className = 'nc-toast' + sev;
    el.setAttribute('role', n.severity === 'info' ? 'status' : 'alert');
    el.innerHTML = '<span class="nc-t-ico">' + svg(iconFor(n)) + '</span>' +
      '<span class="nc-t-main"><span class="nc-t-cat">' + esc(LABELS[n.category] || n.category || 'Notice') + '</span>' +
      '<span class="nc-t-title">' + esc(n.title) + '</span>' +
      (n.body ? '<span class="nc-t-body">' + esc(n.body) + '</span>' : '') + '</span>' +
      '<button type="button" class="nc-t-x" aria-label="Dismiss">' + svg('x') + '</button>';
    el.addEventListener('click', function (e) {
      if (e.target.closest('.nc-t-x')) { closeToast(el); return; }
      closeToast(el);
      if (n.id) markRead(n.id).then(function () { poll(); });
      go(n.link);
    });
    var life = n.severity === 'critical' ? 16000 : n.severity === 'warn' ? 12000 : 8000;
    var arm = function () { clearTimeout(el._t); el._t = setTimeout(function () { closeToast(el); }, life); };
    el.addEventListener('mouseenter', function () { clearTimeout(el._t); });
    el.addEventListener('mouseleave', arm);
    h.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    arm();
  }

  // ---- sticky low-stock banner + repeating alarm ----
  var active = [];                         // open low-stock alerts (Finance)
  var lastAlarm = 0;
  var bar = null, pill = null;
  // "Hide" folds the banner into a small pill. The alert (and its sound) stays active; a NEW low-stock item opens it again.
  function minIds() { try { return JSON.parse(sessionStorage.getItem('tripleE.nc.barHidden')) || null; } catch (e) { return null; } }
  function pid(a) { return String(a.productId != null && a.productId !== '' ? a.productId : a.id); }
  function isMin() { var h = minIds(); return !!h && active.length > 0 && active.every(function (a) { return h.indexOf(pid(a)) >= 0; }); }
  function setMin(on) {
    try {
      if (on) sessionStorage.setItem('tripleE.nc.barHidden', JSON.stringify(active.map(pid)));
      else sessionStorage.removeItem('tripleE.nc.barHidden');
    } catch (e) { /* storage blocked */ }
    renderBar();
  }
  function snoozeUntil() { return Number(load('tripleE.nc.snooze')) || 0; }
  function snoozed() { return snoozeUntil() > Date.now(); }
  function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

  function ensureBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement('div');
    bar.className = 'nc-alertbar';
    bar.id = 'ncAlertBar';
    bar.setAttribute('role', 'alert');
    bar.hidden = true;
    bar.innerHTML = '<span class="nc-ab-ico">' + svg('warn') + '</span>' +
      '<div class="nc-ab-main"><strong id="ncAbTitle"></strong><span id="ncAbText"></span><span class="nc-ab-hint" id="ncAbHint"></span></div>' +
      '<div class="nc-ab-actions">' +
      '<button type="button" class="nc-ab-btn primary" id="ncAbView">Review stock</button>' +
      '<button type="button" class="nc-ab-btn" id="ncAbSnooze">Snooze 10 min</button>' +
      '<button type="button" class="nc-ab-btn" id="ncAbHide" title="Hide this banner (the alert stays active)">' + svg('down') + 'Hide</button>' +
      '<button type="button" class="nc-ab-btn icon" id="ncAbSound" aria-label="Alert sound"></button></div>';
    document.body.appendChild(bar);
    pill = document.createElement('button');
    pill.type = 'button'; pill.className = 'nc-alertpill'; pill.id = 'ncAlertPill'; pill.hidden = true;
    pill.title = 'Show the low-stock alert';
    pill.addEventListener('click', function () { setMin(false); });
    document.body.appendChild(pill);
    bar.querySelector('#ncAbHide').addEventListener('click', function () { setMin(true); });
    bar.querySelector('#ncAbView').addEventListener('click', function () {
      go((active[0] && active[0].link) || 'Finance_Inventory.html#inventory');
    });
    bar.querySelector('#ncAbSnooze').addEventListener('click', function () {
      if (snoozed()) store('tripleE.nc.snooze', null); else store('tripleE.nc.snooze', String(Date.now() + 10 * 60000));
      lastAlarm = Date.now(); renderBar();
    });
    bar.querySelector('#ncAbSound').addEventListener('click', function () { setSound(!soundOn()); });
    return bar;
  }

  function setSound(on) {
    store('tripleE.nc.sound', on ? 'on' : 'off');
    if (on) { unlock(); setTimeout(function () { play('chime'); }, 60); }
    renderBar(); renderSoundBtn();
  }

  function renderBar() {
    var b = ensureBar();
    var bell = $('ncBell');
    if (bell) bell.classList.toggle('alerting', active.length > 0);
    if (!active.length) { b.hidden = true; if (pill) pill.hidden = true; return; }
    var out = active.filter(function (a) { return a.severity === 'critical'; }).length;
    var names = active.slice(0, 3).map(function (a) { return a.title.replace(/^(Out of stock|Low stock):\s*/i, ''); });
    var min = isMin();
    b.hidden = min;
    if (pill) {
      pill.hidden = !min;
      pill.classList.toggle('critical', out > 0);
      pill.innerHTML = svg('warn') + '<span>' + active.length + (out ? ' low / out of stock' : ' low stock') + '</span>' + svg('up');
    }
    b.classList.toggle('critical', out > 0);
    b.querySelector('#ncAbTitle').textContent = active.length + (active.length === 1 ? ' item needs' : ' items need') +
      ' restocking' + (out ? ' (' + out + ' out of stock)' : '');
    b.querySelector('#ncAbText').textContent = names.join(', ') + (active.length > 3 ? ' +' + (active.length - 3) + ' more' : '');
    var hint = b.querySelector('#ncAbHint');
    if (!soundOn()) hint.textContent = 'Alert sound is off.';
    else if (snoozed()) hint.textContent = 'Sound snoozed until ' + clock(snoozeUntil()) + '.';
    else hint.textContent = '';
    hint.hidden = !hint.textContent;
    b.querySelector('#ncAbSnooze').textContent = snoozed() ? 'Resume sound' : 'Snooze 10 min';
    renderSoundBtn();
    // the full banner is shown once, then folds into the small pill so it does not sit over the page; the bell and the pill keep it visible
    if (min) { clearTimeout(renderBar.fold); renderBar.fold = null; }
    else if (!renderBar.fold) renderBar.fold = setTimeout(function () { renderBar.fold = null; if (active.length && !isMin()) setMin(true); }, 12000);
  }
  function renderSoundBtn() {
    var on = soundOn();
    var tip = on ? 'Sound on (click to mute)' : 'Sound off (click to turn on)';
    var barBtn = document.querySelector('#ncAbSound');
    if (barBtn) { barBtn.innerHTML = svg(on ? 'on' : 'off'); barBtn.title = tip; barBtn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    var dropBtn = $('ncSoundBtn');
    if (dropBtn) {
      dropBtn.innerHTML = svg(on ? 'on' : 'off') + '<span>' + (on ? 'Sound on' : 'Sound off') + '</span>';
      dropBtn.title = tip; dropBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // the alarm repeats while any low-stock alert is open: every 30 s if something is OUT, otherwise every 60 s
  function alarmTick() {
    if (!active.length || !soundOn() || snoozed()) return;
    var critical = active.some(function (a) { return a.severity === 'critical'; });
    if (Date.now() - lastAlarm < (critical ? 30000 : 60000)) return;
    if (play(critical ? 'critical' : 'alarm')) lastAlarm = Date.now();
  }

  // ---- polling + live ping ----
  var uid = null, seen = null, polling = false, again = false, es = null, titleBase = null;
  function seenKey() { return 'tripleE.nc.seen.' + uid; }
  function loadSeen() {
    try { var j = JSON.parse(sessionStorage.getItem(seenKey())); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
  }
  function saveSeen() {
    try {
      var ids = Object.keys(seen);
      if (ids.length > 300) { ids.sort(function (x, y) { return x - y; }).slice(0, ids.length - 300).forEach(function (k) { delete seen[k]; }); }
      sessionStorage.setItem(seenKey(), JSON.stringify(seen));
    } catch (e) { /* storage blocked */ }
  }

  function applyTitle(n) {
    if (titleBase == null) titleBase = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = (n ? '(' + (n > 99 ? '99+' : n) + ') ' : '') + titleBase;
  }

  function handleNew(items) {
    if (!items.length) return;
    var shown = items.slice(-3);
    shown.forEach(function (n) { showToast(n); });
    if (items.length > shown.length) {
      showToast({ category: 'system', severity: 'info', title: (items.length - shown.length) + ' more new notifications',
        body: 'Open the Notification Center to read them.', link: '' });
    }
    var low = items.some(function (n) { return n.category === 'inventory' && /^(Low|Out of) stock/i.test(n.title); });
    var out = items.some(function (n) { return n.severity === 'critical'; });
    if (low) { if (play(out ? 'critical' : 'alarm')) lastAlarm = Date.now(); }
    else play('chime');
    if (dropOpen) loadDrop();
    if ($('ncPageList')) loadPage(true);
    window.dispatchEvent(new CustomEvent('triplee:notify', { detail: { items: items } }));
  }

  // if the combined /poll request ever fails, build the same answer from the two list requests that already work
  async function fallbackPoll() {
    var f = await api('/notifications?unread=1&limit=10');
    var inv = await api('/notifications?category=inventory&limit=50');
    return {
      uid: uid == null ? 'x' : uid, role: f.role, unread: f.unread || 0, items: f.items || [],
      activeLowStock: (inv.items || []).filter(function (i) { return !i.isResolved && /^(Low|Out of) stock/i.test(i.title); })
        .map(function (i) { return { id: i.id, title: i.title, body: i.body, link: i.link, severity: i.severity, productId: i.entityId }; })
    };
  }

  async function poll() {
    if (polling) { again = true; return; }
    polling = true;
    try {
      var d;
      try { d = await api('/notifications/poll'); }
      catch (e) {
        if (e.message === 'Not signed in') throw e;
        console.warn('[notifications] /poll failed (' + e.message + '), using the list requests instead');
        d = await fallbackPoll();
      }
      var items = (d.items || []).slice().sort(function (x, y) { return x.id - y.id; });      // oldest first
      var fresh;
      if (seen == null) {
        uid = d.uid;
        seen = loadSeen();
        var first = seen == null;
        if (first) seen = {};
        fresh = items.filter(function (n) { return !seen[n.id]; });
        // first look in this tab: only what happened in the last 10 minutes pops up; older unread ones wait in the bell
        if (first) fresh = fresh.filter(function (n) { return n.createdAt && Date.now() - Date.parse(n.createdAt) < 600000; });
      } else {
        fresh = items.filter(function (n) { return !seen[n.id]; });
      }
      items.forEach(function (n) { seen[n.id] = 1; });
      saveSeen();
      setCount(d.unread || 0);
      applyTitle(d.unread || 0);
      applyRole(d.role);
      active = d.activeLowStock || [];
      handleNew(fresh);
      renderBar();
      alarmTick();
    } catch (e) { if (e && e.message !== 'Not signed in') console.warn('[notifications]', e.message); }
    finally { polling = false; if (again) { again = false; setTimeout(poll, 150); } }
  }

  function connectLive() {
    if (!window.EventSource) return;
    try {
      es = new EventSource('/api/notifications/stream');
      es.addEventListener('ping', function () { poll(); });
      es.addEventListener('ready', function () { poll(); });
    } catch (e) { es = null; }
  }

  function startEngine() {
    ensureBar();
    var foot = document.querySelector('#ncDrop .nc-drop-foot');
    if (foot && !$('ncSoundBtn')) {
      var b = document.createElement('button');
      b.type = 'button'; b.id = 'ncSoundBtn'; b.className = 'nc-link nc-soundbtn';
      b.addEventListener('click', function () { setSound(!soundOn()); });
      foot.appendChild(b);
    }
    renderSoundBtn();
    connectLive();
    setInterval(alarmTick, 1000);
    poll();
  }

  function setCount(n) {
    var el = $('ncCount');
    if (!el) return;
    setStat(n);
    if (!n) { el.hidden = true; el.textContent = '0'; return; }
    el.hidden = false;
    el.textContent = n > 99 ? '99+' : String(n);
  }

  function applyRole(role) {
    if (!role) return;
    document.querySelectorAll('[data-nc-roles]').forEach(function (chip) {
      var allow = (chip.getAttribute('data-nc-roles') || '').split(',');
      var hide = allow.indexOf(role) < 0;
      chip.hidden = hide;
      chip.style.display = hide ? 'none' : '';
      // if the active filter belongs to a hidden chip, fall back to All
      if (hide && chip.classList.contains('on')) { chip.classList.remove('on'); pageCat = ''; }
    });
  }

  function setStat(n) {
    var v = $('ncStatValue'), foot = $('ncStatFoot');
    if (v) v.textContent = String(n || 0);
    if (foot) foot.textContent = n ? 'Open the Notification Center to review' : 'You are all caught up';
  }

  function refreshCount() { return poll(); }

  async function loadDrop() {
    var list = $('ncDropList');
    if (!list) return;
    list.innerHTML = '<div class="nc-empty">Loading…</div>';
    try {
      var d = await api('/notifications?limit=8');
      setCount(d.unread || 0);
      if (!d.items.length) { list.innerHTML = '<div class="nc-empty">No notifications yet.</div>'; return; }
      list.innerHTML = d.items.map(function (n) { return itemHtml(n, true); }).join('');
    } catch (e) {
      list.innerHTML = '<div class="nc-empty">Could not load notifications.</div>';
    }
  }

  async function loadPage(reset) {
    var host = $('ncPageList');
    if (!host) return;
    if (reset) { pageOffset = 0; host.innerHTML = ''; }
    var q = '?limit=' + PAGE_LIMIT + '&offset=' + pageOffset;
    if (pageCat) q += '&category=' + encodeURIComponent(pageCat);
    if (pageUnread) q += '&unread=1';
    try {
      var d = await api('/notifications' + q);
      pageTotal = d.total || 0;
      setCount(d.unread || 0);
      var sub = $('ncPageSub');
      if (sub) sub.textContent = (d.unread ? d.unread + ' unread · ' : '') + d.total + ' in your history';
      if (!d.items.length && pageOffset === 0) {
        host.innerHTML = '<div class="nc-empty">Nothing in this filter yet.</div>';
      } else {
        host.insertAdjacentHTML('beforeend', d.items.map(function (n) { return itemHtml(n, false); }).join(''));
      }
      pageOffset += d.items.length;
      var more = $('ncMore');
      if (more) more.hidden = d.items.length < PAGE_LIMIT;
      applyRole(d.role);
    } catch (e) {
      if (!pageOffset) host.innerHTML = '<div class="nc-empty">Could not load notifications.</div>';
    }
  }

  async function markRead(id) {
    try { await api('/notifications/' + id + '/read', { method: 'POST', body: '{}' }); }
    catch (e) { /* still follow the link */ }
  }
  async function markAll() {
    await api('/notifications/read-all', { method: 'POST', body: '{}' });
    setCount(0);
    document.querySelectorAll('.nc-item.unread').forEach(function (el) { el.classList.remove('unread'); });
  }

  function setDrop(open) {
    var drop = $('ncDrop'), bell = $('ncBell');
    dropOpen = !!open;
    if (drop) drop.classList.toggle('open', dropOpen);
    if (bell) bell.setAttribute('aria-expanded', dropOpen ? 'true' : 'false');
    if (dropOpen) loadDrop();
  }

  function onItemClick(el) {
    var id = el.getAttribute('data-nc-id');
    var link = el.getAttribute('data-nc-link') || '';
    setDrop(false);
    Promise.resolve(id ? markRead(id) : null).then(function () {
      refreshCount();
      if (el.closest('#ncPageList')) el.classList.remove('unread');
      go(link);
    });
  }

  function bind() {
    var bell = $('ncBell');
    if (!bell) return;
    bell.addEventListener('click', function (e) {
      e.stopPropagation();
      // only one menu at a time: on a phone the account menu and the bell list would sit on top of each other
      var ud = $('userDropdown');
      if (ud && ud.classList.contains('open')) {
        ud.classList.remove('open');
        var chip = $('userChipBtn'); if (chip) chip.setAttribute('aria-expanded', 'false');
      }
      setDrop(!dropOpen);
    });
    // capture phase: the account chip stops its click from bubbling, which used to leave the bell list open behind it
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#ncWrap')) setDrop(false);
      if (!e.target.closest('#userMenuWrap')) {
        var ud = $('userDropdown');
        if (ud) ud.classList.remove('open');
      }
    }, true);
    // rotating the phone / resizing: keep the list inside the screen by simply closing it
    window.addEventListener('orientationchange', function () { setDrop(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setDrop(false);
    });
    document.addEventListener('click', function (e) {
      var item = e.target.closest('[data-nc-id]');
      if (item) { e.preventDefault(); onItemClick(item); }
      if (e.target.closest('#ncViewAll')) {
        e.preventDefault(); setDrop(false);
        go('#' + ($('notifications') ? 'notifications' : ($('page-notifications') ? 'notifications' : 'notifications')));
        if (typeof window.showPage === 'function' && $('page-notifications')) window.showPage('notifications');
        else if (typeof window.show === 'function' && $('notifications')) window.show('notifications');
        else if (typeof window.navigateToPage === 'function' && $('notifications')) window.navigateToPage('notifications');
      }
      if (e.target.closest('#ncMarkAll') || e.target.closest('#ncPageMarkAll')) {
        e.preventDefault();
        markAll().then(function () { loadDrop(); if ($('ncPageList')) loadPage(true); }).catch(function () {});
      }
    });
    var stat = $('ncStatCard');
    if (stat) {
      var openStat = function () { window.NotificationCenter.openPage(); };
      stat.style.cursor = 'pointer';
      stat.addEventListener('click', openStat);
      stat.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openStat(); } });
    }
    document.querySelectorAll('[data-nc-cat]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        pageCat = chip.getAttribute('data-nc-cat') || '';
        document.querySelectorAll('[data-nc-cat]').forEach(function (c) { c.classList.toggle('on', c === chip); });
        loadPage(true);
      });
    });
    var unreadBtn = $('ncUnreadOnly');
    if (unreadBtn) unreadBtn.addEventListener('click', function () {
      pageUnread = !pageUnread;
      unreadBtn.classList.toggle('on', pageUnread);
      unreadBtn.textContent = pageUnread ? 'Unread only' : 'All statuses';
      loadPage(true);
    });
    var more = $('ncMore');
    if (more) more.addEventListener('click', function () { loadPage(false); });

    document.addEventListener('visibilitychange', function () { if (!document.hidden) { poll(); if (dropOpen) loadDrop(); } });
    pollTimer = setInterval(poll, 10000);
    startEngine();
    if ($('ncPageList')) loadPage(true);
    var h = hashOf(location.href);
    if (h && typeof window.navigateToPage !== 'function') setTimeout(function () {
      if (typeof window.showPage === 'function' && $('page-' + h)) window.showPage(h);
      else if (typeof window.show === 'function' && $(h)) window.show(h);
    }, 150);
  }

  window.NotificationCenter = {
    mount: bind,
    refresh: refreshCount,
    openPage: function () {
      if (typeof window.navigateToPage === 'function' && $('notifications')) window.navigateToPage('notifications');
      else if (typeof window.showPage === 'function') window.showPage('notifications');
      else if (typeof window.show === 'function') window.show('notifications');
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();