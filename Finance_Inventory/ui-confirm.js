/* ui-confirm.js — the app's own confirm dialog (replaces the browser's grey window.confirm on the Finance pages).
   uiConfirm({ title, message, lines, confirm, danger }) -> Promise<boolean>
     title    bold heading                     message  one plain sentence under it
     lines    optional list of [label, value] rows (e.g. what a production will deduct)
     confirm  text of the main button          danger   true = red button for archive / disable / remove
     reason   optional { label, min, max }: adds a required text box; the promise then resolves to the typed reason (or false)
   Enter confirms, Escape / Cancel / a click outside cancel. Focus returns to the button that opened it. */
(() => {
  'use strict';
  const css = `
.uic-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(4,8,12,.72);backdrop-filter:blur(3px)}
html[data-theme="light"] .uic-overlay{background:rgba(20,35,50,.45)}
.uic-box{width:min(480px,100%);max-height:90vh;overflow:auto;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:12px;padding:22px 24px;box-shadow:0 30px 70px -20px rgba(0,0,0,.6)}
.uic-box h3{margin:0 0 6px;font:600 19px/1.3 "Oswald",sans-serif;letter-spacing:.3px}
.uic-box p{margin:0;color:var(--text-dim);line-height:1.5;font-size:14px}
.uic-lines{margin:14px 0 0;border-top:1px solid var(--border)}
.uic-line{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid var(--border);font-size:14px}
.uic-line span{color:var(--text-dim)}.uic-line b{text-align:right;font-family:"IBM Plex Mono",monospace;font-weight:600}
.uic-reason{display:block;margin-top:14px;font-size:13px;color:var(--text-dim)}
.uic-reason textarea{display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg,var(--card));color:var(--text);font:inherit;resize:vertical}
.uic-reason textarea[aria-invalid="true"]{border-color:#c0392b}
.uic-err{display:block;min-height:16px;margin-top:4px;color:#c0392b;font-size:12.5px}
.uic-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;flex-wrap:wrap}
@media(max-width:480px){.uic-actions button{flex:1}}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.uiConfirm = function uiConfirm(o) {
    o = o || {};
    return new Promise((resolve) => {
      const back = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'uic-overlay';
      wrap.innerHTML = `<div class="uic-box" role="alertdialog" aria-modal="true" aria-labelledby="uicTitle" aria-describedby="uicMsg">
        <h3 id="uicTitle">${esc(o.title || 'Are you sure?')}</h3>${o.message ? `<p id="uicMsg">${esc(o.message)}</p>` : ''}
        ${(o.lines || []).length ? `<div class="uic-lines">${o.lines.map((l) => `<div class="uic-line"><span>${esc(l[0])}</span><b>${esc(l[1])}</b></div>`).join('')}</div>` : ''}
        ${o.reason ? `<label class="uic-reason">${esc(o.reason.label || 'Reason')}<textarea id="uicReason" rows="3" maxlength="${+o.reason.max || 300}" aria-describedby="uicReasonErr"></textarea><span class="uic-err" id="uicReasonErr" role="alert"></span></label>` : ''}
        <div class="uic-actions"><button type="button" class="btn-secondary" data-uic="no">${esc(o.cancel || 'Cancel')}</button>
          <button type="button" class="${o.danger ? 'btn-danger' : 'btn-primary'}" data-uic="yes">${esc(o.confirm || 'Confirm')}</button></div></div>`;
      const done = (ok) => { document.removeEventListener('keydown', key, true); wrap.remove(); if (back && document.contains(back)) back.focus(); resolve(ok); };
      const box = wrap.querySelector('#uicReason');
      const accept = () => {
        if (!box) return done(true);
        const v = box.value.trim().replace(/\s+/g, ' '), min = +o.reason.min || 5;
        if (v.length < min) { wrap.querySelector('#uicReasonErr').textContent = 'Write a reason (at least ' + min + ' characters).'; box.setAttribute('aria-invalid', 'true'); box.focus(); return; }
        done(v);
      };
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } else if (e.key === 'Enter' && e.target.dataset.uic !== 'no' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); accept(); } };
      wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(false); });
      wrap.addEventListener('click', (e) => { const b = e.target.closest('[data-uic]'); if (b) { if (b.dataset.uic === 'yes') accept(); else done(false); } });
      document.addEventListener('keydown', key, true);
      document.body.appendChild(wrap);
      (box || wrap.querySelector('[data-uic="yes"]')).focus();
    });
  };
})();
