/* session-guard.js — keeps a page from acting as the wrong person when the account changes in another tab.
   Every tab of this site shares ONE session cookie. If Finance is open in tab 1 and someone signs in as a customer (or another
   user) in tab 2, tab 1 would keep showing the Finance screens while its requests quietly run as the new account.
   This script remembers who the page was opened for and:
     • sends that id with every change request (X-Session-User); the server refuses it (409) if the cookie belongs to someone else
     • re-checks who is signed in when the tab is shown again, on focus, and every 30 seconds
     • when the account changed or was signed out, covers the page with a clear message so nothing more can be done as the wrong person
   Load it first in <head> on every signed-in page. */
(function () {
  'use strict';
  if (window.__sessionGuard) return;
  window.__sessionGuard = true;
  var HOME = { finance: 'Finance_Inventory.html', cashier: 'POS_Cashier.html', customer: 'Shop_Customer.html' };
  var LOGIN = 'Login_Inventory.html';
  var rawFetch = window.fetch.bind(window);
  var me = null, guest = false, shown = false, locked = false, firstDone = null;
  var identified = new Promise(function (resolve) { firstDone = resolve; setTimeout(resolve, 4000); });   // never hold the page up for long

  function isApi(url) {
    try { var u = new URL(typeof url === 'string' ? url : url.url, location.href); return u.origin === location.origin && /^\/api\//.test(u.pathname) && !/^\/api\/auth\//.test(u.pathname); }
    catch (e) { return false; }
  }
  // Strict: once the account has changed, this page can make no more API calls at all. Until we know who the page is for, calls wait.
  window.fetch = function (input, init) {
    if (!isApi(input)) return rawFetch(input, init);
    if (locked) return Promise.reject(new TypeError('This page is locked because the account changed in another tab.'));
    return identified.then(function () {
      if (locked) throw new TypeError('This page is locked because the account changed in another tab.');
      if (me) {
        var headers = new Headers((init && init.headers) || (input && input.headers) || {});
        headers.set('X-Session-User', String(me.id));
        init = Object.assign({}, init, { headers: headers });
      }
      return rawFetch(input, init);
    }).then(function (res) {
      if (res.status === 409) res.clone().json().then(function (b) { if (b && b.code === 'SESSION_CHANGED') check(); }).catch(function () {});
      return res;
    });
  };

  function cover(title, text, buttons) {
    locked = true;
    if (shown) return; shown = true;
    try { document.querySelectorAll('body > *').forEach(function (n) { n.setAttribute('inert', ''); }); } catch (e) {}
    var wrap = document.createElement('div');
    wrap.setAttribute('role', 'alertdialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-label', title);
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(8,14,22,.92);font-family:Inter,system-ui,sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'max-width:440px;width:100%;background:#fff;color:#16202b;border-radius:14px;padding:26px 28px;box-shadow:0 30px 70px -20px rgba(0,0,0,.6)';
    var h = document.createElement('h2'); h.textContent = title; h.style.cssText = 'margin:0 0 8px;font-size:20px';
    var p = document.createElement('p'); p.textContent = text; p.style.cssText = 'margin:0 0 18px;line-height:1.5;color:#3d4b5c';
    var row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px';
    buttons.forEach(function (b, i) {
      var el = document.createElement('button'); el.type = 'button'; el.textContent = b[0];
      el.style.cssText = 'flex:1 1 160px;padding:11px 14px;border-radius:99px;font:600 14px Inter,system-ui,sans-serif;cursor:pointer;border:1px solid #2f6fb3;' + (i === 0 ? 'background:#2f6fb3;color:#fff' : 'background:#fff;color:#2f6fb3');
      el.addEventListener('click', b[1]); row.appendChild(el);
    });
    box.appendChild(h); box.appendChild(p); box.appendChild(row); wrap.appendChild(box);
    document.body.appendChild(wrap);
    wrap.removeAttribute('inert');
    var first = row.querySelector('button'); if (first) first.focus();
    document.documentElement.style.overflow = 'hidden';
  }
  var go = function (url) { return function () { location.href = url; }; };

  function changed(now) {
    var home = HOME[now.role];
    var who = (now.name || 'another account') + (now.roleLabel ? ' (' + now.roleLabel + ')' : '');
    var buttons = [];
    if (home) buttons.push(['Continue as ' + (now.name || 'this account'), go(home)]);
    buttons.push(['Sign in again', go(LOGIN)]);
    cover('Your account changed in another tab',
      'This browser is now signed in as ' + who + '. This page was opened for ' + (me.name || 'a different account') + ', so it has been locked and nothing more will be saved from it.', buttons);
  }

  function check() {
    return rawFetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      if (res.status === 401) {
        if (me) cover('You were signed out', 'This account was signed out in another tab or on another device. Sign in again to continue.', [['Sign in again', go(LOGIN)]]);
        guest = true; firstDone(); return;
      }
      if (!res.ok) { firstDone(); return; }
      return res.json().then(function (now) {
        if (!now || now.id == null) { firstDone(); return; }
        if (!me) {
          if (guest) { location.reload(); return; }       // a visitor page, and someone signed in in another tab: start over as that account
          me = { id: now.id, name: now.name, role: now.role }; firstDone(); return;
        }
        if (String(now.id) !== String(me.id)) changed(now);
      });
    }).catch(function () { firstDone(); /* offline: try again next time */ });
  }

  check();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
  setInterval(check, 30000);
})();
