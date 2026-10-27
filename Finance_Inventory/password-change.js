/* password-change.js — ONE change-password flow shared by every role (Finance Admin, Cashier, Customer).

   The steps, always in this order:
     1) The person TYPES their current password (the system never fills it in). The server checks it; if it is wrong nothing else happens.
     2) The new password must pass the rules and be typed twice.
     3) Only then the person CHOOSES where the one-time code goes: their EMAIL or their MOBILE NUMBER, and enters it.
     4) Update Password saves it (the server checks the current password and the code again).

   Backend: POST /api/auth/password/check · POST /api/auth/password/otp · PUT /api/auth/password   (backend/password-otp.js, server.js)

   Each page gives it its fields and a few helpers:
     PasswordChange.create({ cur, nw, conf, saveBtn, otpMount, api, rulesMet, setError, clearError, banner, toast, onDone })
   It returns { reset }  — call reset() whenever the password window opens or closes. */
(function () {
  'use strict';

  var CHANNELS = [
    { key: 'email', label: 'Email', noun: 'email' },
    { key: 'sms', label: 'Text message', noun: 'mobile number' }
  ];

  function create(cfg) {
    var stage = 0, info = null, timer = null, sentTo = '';
    var original = 'Continue';

    /* ---- the code section (built here so every page looks and works the same) ---- */
    var box = cfg.otpMount;
    box.style.display = 'none';
    box.innerHTML =
      '<div class="pc-hint" style="font-size:13px;margin:0 0 10px"></div>' +
      '<div class="pc-choices" style="display:flex;flex-direction:column;gap:6px;margin:0 0 10px"></div>' +
      '<div style="display:flex;gap:8px"><input type="text" class="form-input acct-input pc-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="6-digit code" style="flex:1">' +
      '<button type="button" class="btn-secondary pc-send" style="white-space:nowrap;padding:10px 14px;border-radius:6px;cursor:pointer">Send code</button></div>' +
      '<button type="button" class="btn-secondary pc-edit" style="margin-top:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:13px">Edit the passwords</button>';
    var hint = box.querySelector('.pc-hint'), choices = box.querySelector('.pc-choices'),
        code = box.querySelector('.pc-code'), sendBtn = box.querySelector('.pc-send');

    function say(msg, bad) { hint.textContent = msg; hint.style.color = bad ? 'var(--red, #c0392b)' : ''; }
    function channel() { var r = choices.querySelector('input:checked'); return r ? r.value : ''; }

    function lock(on) { [cfg.cur, cfg.nw, cfg.conf].forEach(function (el) { el.readOnly = !!on; }); }
    function cooldown(sec) {
      clearInterval(timer);
      if (!(sec > 0)) { sendBtn.disabled = false; sendBtn.textContent = sentTo ? 'Resend code' : 'Send code'; return; }
      sendBtn.disabled = true; sendBtn.textContent = 'Resend in ' + sec + 's';
      timer = setInterval(function () {
        sec--;
        if (sec <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = 'Resend code'; }
        else sendBtn.textContent = 'Resend in ' + sec + 's';
      }, 1000);
    }
    function backToFields() {                       // stage 0: passwords can be edited again, nothing is pending
      stage = 0; info = null; sentTo = '';
      clearInterval(timer);
      lock(false);
      box.style.display = 'none'; choices.innerHTML = ''; code.value = '';
      cfg.saveBtn.textContent = original; cfg.saveBtn.disabled = false;
    }

    async function send() {
      var ch = channel();
      cfg.clearError(code);
      if (!ch) return say('Choose email or text message first.', true);
      sendBtn.disabled = true;
      try {
        var r = await cfg.api('/auth/password/otp', { method: 'POST', body: JSON.stringify({ channel: ch, currentPassword: cfg.cur.value }) });
        var noun = ch === 'sms' ? 'mobile number' : 'email';
        if (r.sent || r.recent) { sentTo = ch; say(r.recent ? r.message : 'Code sent to your ' + noun + '. It expires in ' + Math.round((r.expiresIn || 600) / 60) + ' minutes.'); }
        else say(r.message || 'The code could not be sent.', true);
        cooldown(r.waitSeconds || 60);
        code.focus();
      } catch (err) {
        if (err.message === 'Not signed in') return;
        if (err.fields && err.fields.currentPassword) { backToFields(); cfg.setError(cfg.cur, err.fields.currentPassword); cfg.cur.focus(); return; }
        say(err.message, true); sendBtn.disabled = false;
      }
    }

    function showCodeStage(res) {                   // stage 1: the current password was right, now ONE code (email or mobile)
      info = res; stage = 1; lock(true); sentTo = '';
      var first = true;
      choices.innerHTML = '';
      CHANNELS.forEach(function (c) {
        var o = res[c.key];
        var lab = document.createElement('label');
        lab.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;' + (o ? 'cursor:pointer' : 'opacity:.5');
        lab.innerHTML = '<input type="radio" name="pcCh" value="' + c.key + '"' + (o ? '' : ' disabled') + (o && first ? ' checked' : '') + '> ' +
          c.label + (o ? ' — ' + o.masked : ' (not available on this account)');
        choices.appendChild(lab);
        if (o) first = false;
      });
      box.style.display = '';
      cfg.saveBtn.textContent = 'Update Password';
      cooldown(0);
      if (first) { say('No verified email or mobile number is on this account, so a code cannot be sent. Ask the Finance/Admin team for help.', true); sendBtn.disabled = true; cfg.saveBtn.disabled = true; return; }
      say('Your current password is correct. Choose where to receive the code, then tap Send code.');
    }

    function fieldErrors(f) {
      var any = false;
      if (f.currentPassword) { cfg.setError(cfg.cur, f.currentPassword); any = true; }
      if (f.newPassword) { cfg.setError(cfg.nw, f.newPassword); any = true; }
      if (f.confirmPassword) { cfg.setError(cfg.conf, f.confirmPassword); any = true; }
      if (f.code) { cfg.setError(code, f.code); any = true; }
      return any;
    }

    async function step1() {
      var cur = cfg.cur.value;
      if (!cur) { cfg.setError(cfg.cur, 'Type your current password'); cfg.banner('Type your current password first.'); cfg.cur.focus(); return; }
      if (!cfg.rulesMet()) { cfg.banner('Check the fields above — passwords must match and meet all requirements.'); return; }
      var btn = cfg.saveBtn, label = btn.textContent;
      btn.disabled = true; btn.textContent = 'Checking…';
      try {
        var res = await cfg.api('/auth/password/check', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: cfg.nw.value, confirmPassword: cfg.conf.value }) });
        if (!res.required) { btn.disabled = false; btn.textContent = label; return finish(); }     // codes switched off on this server
        showCodeStage(res);
      } catch (err) {
        if (err.message === 'Not signed in') return;
        var f = err.fields || {};
        cfg.banner(fieldErrors(f) ? 'Please fix the highlighted fields.' : err.message);
        if (f.currentPassword) cfg.cur.focus();
      } finally { if (stage === 0) { btn.disabled = false; btn.textContent = label; } else if (channel()) btn.disabled = false; }
    }

    async function finish() {
      var body = { currentPassword: cfg.cur.value, newPassword: cfg.nw.value, confirmPassword: cfg.conf.value };
      if (info && info.required) {
        var ch = channel(), v = code.value.trim();
        if (!ch) { cfg.banner('Choose email or text message, then tap Send code.'); return; }
        if (!/^\d{6}$/.test(v)) { cfg.setError(code, 'Enter the 6-digit code we sent you'); cfg.banner('Tap Send code, then enter the 6-digit code here.'); code.focus(); return; }
        body.channel = ch; body.code = v;
      }
      var btn = cfg.saveBtn;
      btn.disabled = true; btn.textContent = 'Updating…';
      try {
        await cfg.api('/auth/password', { method: 'PUT', body: JSON.stringify(body) });
        cfg.toast('Password updated');
        cfg.onDone();
      } catch (err) {
        if (err.message === 'Not signed in') return;
        var f = err.fields || {};
        if (f.currentPassword || f.newPassword || f.confirmPassword) backToFields();      // the passwords have to be fixed first
        cfg.banner(fieldErrors(f) ? 'Please fix the highlighted fields.' : err.message);
      } finally { btn.disabled = false; btn.textContent = stage === 1 ? 'Update Password' : original; }
    }

    cfg.saveBtn.addEventListener('click', function () { cfg.banner(''); [cfg.cur, cfg.nw, cfg.conf, code].forEach(cfg.clearError); return stage === 0 ? step1() : finish(); });
    sendBtn.addEventListener('click', send);
    choices.addEventListener('change', function () { sentTo = ''; code.value = ''; cfg.clearError(code); cooldown(0); say('Tap Send code to get a code on your ' + (channel() === 'sms' ? 'mobile number' : 'email') + '.'); });
    code.addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); cfg.clearError(code); if (!/^\d{6}$/.test(this.value)) cfg.setError(code, 'Enter the 6-digit code we sent you'); });
    function livePassword(input) {
      cfg.clearError(input);
      var value = input.value, message = '';
      if (input === cfg.cur) message = value ? '' : 'Type your current password';
      else if (input === cfg.conf) message = !value ? 'Re-enter your new password' : value === cfg.nw.value ? '' : 'Passwords do not match';
      else message = value.length < 8 ? 'Use at least 8 characters' : !/[A-Z]/.test(value) ? 'Add an uppercase letter' : !/[a-z]/.test(value) ? 'Add a lowercase letter' : !/\d/.test(value) ? 'Add a number' : !/[^A-Za-z0-9]/.test(value) ? 'Add a special character' : '';
      if (message) cfg.setError(input, message);
    }
    [cfg.cur, cfg.nw, cfg.conf].forEach(function (input) {
      ['input', 'blur'].forEach(function (event) { input.addEventListener(event, function () {
        if (input.readOnly) return;
        livePassword(input);
        if (input === cfg.nw && cfg.conf.value) livePassword(cfg.conf);
      }); });
    });
    box.querySelector('.pc-edit').addEventListener('click', function () { backToFields(); cfg.nw.focus(); });

    /* the current password is never pre-filled: random name, no autocomplete, read-only until the person clicks into it */
    cfg.cur.setAttribute('autocomplete', 'off');
    cfg.cur.setAttribute('name', 'typed-current-' + Math.random().toString(36).slice(2, 8));
    cfg.cur.setAttribute('data-lpignore', 'true'); cfg.cur.setAttribute('data-1p-ignore', 'true'); cfg.cur.setAttribute('data-form-type', 'other');
    cfg.cur.addEventListener('focus', function () { if (stage === 0) cfg.cur.readOnly = false; });
    [cfg.nw, cfg.conf].forEach(function (el) { el.setAttribute('autocomplete', 'new-password'); });

    function reset() {
      [cfg.cur, cfg.nw, cfg.conf].forEach(function (el) { el.value = ''; cfg.clearError(el); });
      cfg.clearError(code);
      backToFields();
      cfg.cur.readOnly = true;                      // read-only until clicked, so browsers cannot fill it in
      cfg.banner('');
    }
    reset();
    return { reset: reset };
  }

  window.PasswordChange = { create: create };
})();
