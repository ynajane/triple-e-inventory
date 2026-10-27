/* sales-hub.js — Finance > Sales: ONE scrollable page, with a sticky chip bar (same look and behaviour as Reports).
     Overview · Quote Approvals · Online Orders · POS Sales & Shifts · Payments & Balances · Customer Profiles · Policies & Rates
   (the section order on the page matches the chip order: the scroll-spy walks the chips top to bottom)
   Every section is always on the page. The bar only (1) scrolls to a section when a chip is clicked,
   (2) highlights the section you are reading as you scroll, and (3) names that section on the right.
   navigateToPage('orders') / ('quotes') / ... (script.js) call window.TripleESalesHub.show(id) so old links still land
   on the right section. Load after script.js:  <script src="sales-hub.js?v=1"></script> */
(function () {
  'use strict';
  var reduce = function () { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

  var STATUS = {
    'sales-overview': 'Realtime activity',
    'quotes': 'Price review',
    'orders': 'Order queue',
    'sales': 'In-store ledger',
    'payments': 'Money owed & ledger',
    'customers': 'Directory',
    'payment-terms': 'Automated engine'
  };

  function init() {
    var page = document.getElementById('sales-hub'), bar = document.getElementById('salesHubTabs');
    if (!page || !bar) return;
    var buttons = Array.prototype.slice.call(bar.querySelectorAll('.rep-tab'));
    if (!buttons.length) return;
    var status = document.getElementById('shNavStatus');
    var current = buttons[0].dataset.stab, ticking = false;

    // .content has overflow:auto, which would make it (not the window) the scroll box a sticky bar sticks to.
    // While Sales is open let the window scroll instead (same trick as reports-tabs.js, with its own class names).
    var host = page.closest('.content');
    function syncHost() {
      var on = page.classList.contains('active-page');
      if (host) host.classList.toggle('sh-content', on);
      document.documentElement.classList.toggle('sh-scroll', on);
    }

    // the bar sits just under the top bar: measure it so it never hides behind it
    function measure() {
      var tb = document.querySelector('.topbar'), h = tb ? tb.getBoundingClientRect().height : 0;
      var navH = bar.getBoundingClientRect().height || 56;
      page.style.setProperty('--rep-sticky', Math.round(h) + 'px');
      page.style.setProperty('--rep-offset', Math.round(h + navH + 14) + 'px');   // scroll-margin for the sections
    }

    function mark(name) {
      if (name === current) return;
      current = name;
      buttons.forEach(function (b) {
        var on = b.dataset.stab === name;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
        if (on && bar.scrollWidth > bar.clientWidth) { try { b.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) { /* ignore */ } }
      });
      if (status) status.textContent = STATUS[name] || '';
    }

    function spy() {
      ticking = false;
      if (!page.classList.contains('active-page')) return;
      var offset = (parseInt(page.style.getPropertyValue('--rep-offset'), 10) || 130) + 10, found = buttons[0].dataset.stab;
      buttons.forEach(function (b) {
        var el = document.getElementById(b.dataset.target);
        if (el && el.offsetHeight > 0 && el.getBoundingClientRect().top <= offset) found = b.dataset.stab;
      });
      // at the very bottom of the page the last section is the one being read
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) found = buttons[buttons.length - 1].dataset.stab;
      mark(found);
    }
    function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }

    function go(name) {
      var b = buttons.filter(function (x) { return x.dataset.stab === name; })[0]; if (!b) return;
      var el = document.getElementById(b.dataset.target); if (!el) return;
      measure();
      mark(name);
      el.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'start' });
    }

    bar.addEventListener('click', function (e) { var b = e.target.closest('.rep-tab'); if (b) go(b.dataset.stab); });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', function () { measure(); onScroll(); });
    if ('MutationObserver' in window) {
      new MutationObserver(function () {
        syncHost();
        if (page.classList.contains('active-page')) { measure(); onScroll(); }
      }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }

    // the pending-approvals bar (sales-admin.js) shows / hides inside the sticky bar: re-measure so sections never hide behind it
    window.TripleESalesHub = { show: go, current: function () { return current; }, measure: function () { measure(); onScroll(); } };
    if ('ResizeObserver' in window) new ResizeObserver(function () { measure(); }).observe(bar);
    syncHost(); measure(); spy();
    setTimeout(measure, 600);   // after fonts / the first data load
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();