/* sidebar.js — behaviour of the left menu in Finance_Inventory.html (styling is in sidebar.css).
     - Section labels (Main Menu / Inventory / Sales & Transactions / Administration) are always visible
     - "Collapse" shrinks the menu to an icon rail on desktop (html.sb-rail); the choice is remembered
     - in the rail, hovering or focusing an icon shows its name in a small tooltip
   Load it last, after script.js and api-bridge.js:  <script src="sidebar.js?v=3"></script> */
(function () {
  'use strict';

  var RAIL_KEY = 'tripleE.sidebarRail';    // "1" = icon rail (the page head script reads the same key)
  var side = document.getElementById('sidebar');
  if (!side) return;
  var root = document.documentElement;

  function write(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* not remembered, still works */ } }

  /* ---------- icon rail ---------- */
  var rail = document.getElementById('railToggle');
  function paintRail() {
    if (!rail) return;
    var on = root.classList.contains('sb-rail');
    rail.setAttribute('aria-pressed', on ? 'true' : 'false');
    rail.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar');
    var label = rail.querySelector('.rail-toggle-text'); if (label) label.textContent = on ? 'Expand' : 'Collapse';
    hideTip();
  }
  if (rail) {
    rail.addEventListener('click', function () {
      var on = root.classList.toggle('sb-rail');
      write(RAIL_KEY, on ? '1' : '0'); paintRail();
    });
  }

  /* ---------- rail tooltip ---------- */
  var tip = document.createElement('div');
  tip.className = 'sb-tip'; tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  function inRail() { return root.classList.contains('sb-rail') && window.innerWidth >= 1025; }
  function showTip(el) {
    if (!inRail()) return;
    var text = el.getAttribute('data-label') || (el.classList.contains('rail-toggle') ? 'Expand sidebar' : '');
    if (!text) return;
    tip.textContent = text;
    var r = el.getBoundingClientRect();
    tip.style.left = (r.right + 12) + 'px';
    tip.style.top = (r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
    tip.classList.add('show');
  }
  function hideTip() { tip.classList.remove('show'); }
  side.addEventListener('mouseover', function (e) { var t = e.target.closest('.nav-item, .rail-toggle'); if (t) showTip(t); });
  side.addEventListener('mouseout', function (e) { if (e.target.closest('.nav-item, .rail-toggle')) hideTip(); });
  side.addEventListener('focusin', function (e) { var t = e.target.closest('.nav-item, .rail-toggle'); if (t) showTip(t); });
  side.addEventListener('focusout', hideTip);
  side.addEventListener('click', hideTip);
  window.addEventListener('resize', hideTip);

  paintRail();
  // the page starts with animations off so the saved layout does not slide in; switch them on after the first paint
  requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('sb-noanim'); }); });
})();