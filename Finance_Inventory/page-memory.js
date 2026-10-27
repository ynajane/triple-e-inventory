/* page-memory.js - stay on the same page after a refresh (Cashier and Customer pages).
   The current page is kept in the address bar (e.g. POS_Cashier.html#sales) and in sessionStorage, so
   refreshing, Back / Forward and copy-pasting the link all land on the page you were on instead of
   jumping back to Point of Sale / Catalog. (Finance_Inventory.html does the same inside api-bridge.js.)
   Load it last, after the page's own script and notification-center.js. */
(function () {
  'use strict';
  var file = decodeURIComponent((location.pathname.split('/').pop() || '')).toLowerCase();
  var CFG = {
    'pos_cashier.html':  { fn: 'showPage', home: 'terminal', ids: ['terminal', 'sales', 'shift', 'orders', 'quotes', 'customers', 'reviews', 'notifications'] },
    'shop_customer.html': { fn: 'show',     home: 'catalog',  ids: ['catalog', 'cart', 'orders', 'quote', 'notifications'] }
  }[file];
  if (!CFG) return;
  var orig = window[CFG.fn];
  if (typeof orig !== 'function') return;

  var KEY = 'tripleE.page.' + file;
  var current = null, restoring = false;
  function ok(id) { return !!id && CFG.ids.indexOf(id) >= 0; }
  // checkout cannot be reopened on its own (it needs the cart), so a refresh there returns to the cart
  function norm(id) { return id === 'checkout' ? 'cart' : id; }
  function read() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } }
  function write(id) { try { sessionStorage.setItem(KEY, id); } catch (e) { /* storage blocked */ } }

  function remember(id) {
    id = norm(id);
    if (!ok(id) || restoring) return;
    current = id;
    write(id);
    if (location.hash !== '#' + id) { try { history.pushState(null, '', '#' + id); } catch (e) { /* ignore */ } }
  }

  window[CFG.fn] = function (id) {
    var r = orig.apply(this, arguments);
    remember(id);
    return r;
  };

  window.addEventListener('popstate', function () {          // browser Back / Forward
    var id = location.hash.slice(1);
    if (!ok(id)) id = CFG.home;
    restoring = true;
    try { orig(id); current = id; write(id); } finally { restoring = false; }
  });

  // the payment return page sends the customer to My Orders by itself
  if (/[?&]payment=/.test(location.search)) return;

  var wanted = [location.hash.slice(1), read()].map(norm).filter(ok)[0] || CFG.home;
  restoring = true;
  try { if (wanted !== CFG.home) orig(wanted); } catch (e) { console.warn('[page-memory]', e.message); }
  finally { restoring = false; }
  current = wanted;
  write(wanted);
  if (location.hash !== '#' + wanted) { try { history.replaceState(null, '', '#' + wanted); } catch (e) { /* ignore */ } }

  // pages that list data (orders, quotes, sales) are drawn again once the first data has arrived
  if (wanted !== CFG.home) window.addEventListener('load', function () {
    setTimeout(function () {
      if (current !== wanted) return;                        // the person has already gone somewhere else
      restoring = true;
      try { orig(wanted); } catch (e) { /* ignore */ } finally { restoring = false; }
    }, 800);
  });
})();