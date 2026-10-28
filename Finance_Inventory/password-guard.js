/* password-guard.js: keeps a typed password from leaving the screen through the clipboard (OWASP A02/A07).
   Loaded by every page that has a password box (sign in, sign up, reset, change password, the Finance / Cashier / Customer account menus).
   - Copy, cut and drag are blocked on every password box, also while "show password" is on and the box has become plain text.
   - Paste is blocked on the "confirm / re-enter" boxes, so the password has to be typed twice. The first box still accepts paste,
     so a password manager can fill it in.
   It listens on the document, so boxes that a page builds later (pop-ups, the account menu) are covered too. */
(function () {
  var isInput = function (el) { return !!el && el.tagName === 'INPUT'; };
  // a box counts as a password box once it has been a type="password" box (the show/hide eye switches it to type="text")
  var isPassword = function (el) {
    return isInput(el) && (el.type === 'password' || el.dataset.pwBox === '1' || /password/i.test(el.getAttribute('autocomplete') || ''));
  };
  var isConfirm = function (el) {
    return /confirm|re-?enter|repeat|retype|verify/i.test([el.id, el.name, el.placeholder, el.getAttribute('aria-label')].join(' '));
  };
  var mark = function (el) { if (isInput(el) && el.type === 'password') el.dataset.pwBox = '1'; };

  document.addEventListener('focusin', function (e) { mark(e.target); }, true);
  document.addEventListener('pointerdown', function (e) { mark(e.target); }, true);

  ['copy', 'cut', 'dragstart'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var el = isInput(e.target) ? e.target : document.activeElement;
      if (isPassword(el)) e.preventDefault();
    }, true);
  });
  document.addEventListener('paste', function (e) {
    var el = isInput(e.target) ? e.target : document.activeElement;
    if (isPassword(el) && isConfirm(el)) e.preventDefault();
  }, true);
  document.addEventListener('drop', function (e) {
    if (isPassword(e.target) && isConfirm(e.target)) e.preventDefault();
  }, true);
})();
