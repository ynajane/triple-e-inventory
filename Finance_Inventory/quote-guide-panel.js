/* quote-guide-panel.js — the guided "send a quote" section for the quote request modal.
   The system fills in the price, the ready date and the valid-until date; the person confirms, or changes something and says why.

   Use it in the modal INSTEAD of the amount / Ready in / Price valid for / Message fields:

     QuoteGuidePanel.mount(document.getElementById('quote-guide-slot'), {
       quoteNo: 'Q-1234',
       getJson: (url) => api(url),                       // your existing GET helper; must return parsed JSON
       send: (body) => api('/api/finance/quotes/' + quoteNo, { method: 'POST', body }),   // your existing POST helper
       onSent: () => { closeModal(); reloadQuotes(); }
     });

   Needs no libraries. Styles use plain classes prefixed qg- (a small <style> is added once). */
(function (global) {
  const css = `.qg label{display:block;font-size:12px;color:#667085;margin:12px 0 4px}.qg input,.qg textarea{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d0d5dd;border-radius:8px;font:inherit}
  .qg .qg-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.qg .qg-hint{font-size:12px;color:#667085;margin-top:4px}.qg .qg-chip{display:inline-block;margin-top:6px;padding:3px 10px;border:1px solid #1e5aa8;color:#1e5aa8;border-radius:999px;font-size:12px;background:#fff;cursor:pointer}
  .qg .qg-checks{margin:10px 0 0;padding:0;list-style:none;font-size:13px}.qg .qg-checks li{padding:2px 0}.qg .qg-ok:before{content:"\\2713  ";color:#12805c}.qg .qg-warn:before{content:"!  ";color:#b54708;font-weight:700}
  .qg .qg-need{border:1px solid #f4c27a;background:#fffaeb;border-radius:8px;padding:10px 12px;margin-top:12px;font-size:13px}.qg .qg-err{color:#b42318;font-size:12px;margin-top:4px}
  .qg .qg-why{border:1px solid #d0d5dd;border-radius:8px;padding:10px 12px;margin-top:14px;font-size:13px}.qg .qg-why h4{margin:0 0 6px;font-size:13px}.qg .qg-why p{margin:6px 0}
  .qg button.qg-send{margin-top:14px;padding:10px 18px;border:0;border-radius:8px;background:#1e5aa8;color:#fff;font-weight:600;letter-spacing:.04em;cursor:pointer}.qg button.qg-send:disabled{opacity:.5;cursor:not-allowed}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nice = (iso) => iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';

  function mount(root, opts) {
    if (!document.getElementById('qg-style')) { const s = document.createElement('style'); s.id = 'qg-style'; s.textContent = css; document.head.appendChild(s); }
    root.classList.add('qg'); root.innerHTML = '<p class="qg-hint">Working out the price and dates…</p>';
    opts.getJson('/api/finance/quotes/' + encodeURIComponent(opts.quoteNo) + '/guide').then(render, (e) => { root.innerHTML = '<p class="qg-err">' + esc(e.message || 'Could not load the guidance') + '</p>'; });

    function render(g) {
      const P = g.price;
      root.innerHTML = `
        <label>Total quoted amount (\u20B1)</label>
        <input id="qg-amount" inputmode="decimal" value="${P.ok ? P.suggested.toFixed(2) : ''}" placeholder="${P.ok ? '' : 'The system could not price this: type it'}">
        <div class="qg-hint">${P.ok ? `System price. Anything from ${peso(P.lowest)} to ${peso(P.highest)} needs no reason.` : 'Type the price, then write why below.'}</div>
        ${P.ok ? '<span class="qg-chip" id="qg-reset">Use the system price</span>' : ''}<div class="qg-err" id="qg-e-amount"></div>
        <div class="qg-row">
          <div><label>Ready by</label><input id="qg-ready" type="date" value="${g.ready.date}" min="${g.ready.min}" max="${g.ready.max}">
            <div class="qg-hint">${g.ready.neededBy ? 'Customer needs it by ' + nice(g.ready.neededBy) : 'No needed-by date given'}</div><div class="qg-err" id="qg-e-ready"></div></div>
          <div><label>Price valid until</label><input id="qg-valid" type="date" value="${g.valid.date}" min="${g.valid.min}" max="${g.valid.max}">
            <div class="qg-hint">Up to ${nice(g.valid.max)}</div><div class="qg-err" id="qg-e-valid"></div></div>
        </div>
        <ul class="qg-checks">${g.checks.map((c) => `<li class="qg-${c.level}">${esc(c.text)}</li>`).join('')}</ul>
        <label>Message to the customer <span style="color:#98a2b3">(written for you, change it if you like)</span></label>
        <textarea id="qg-msg" rows="3">${esc(g.message)}</textarea>
        <div id="qg-need" class="qg-need" hidden></div>
        <div class="qg-why"><h4>Why the system suggests this</h4>${g.why.map((w) => `<p><b>${esc(w.title)}.</b> ${esc(w.text)}</p>`).join('')}</div>
        <div class="qg-err" id="qg-e-top"></div>
        <button class="qg-send" id="qg-send">SEND QUOTE</button>`;
      const $ = (id) => root.querySelector('#' + id);
      let msgEdited = false;
      $('qg-msg').addEventListener('input', () => { msgEdited = true; });

      // what the person has changed from the guidance -> the reason box appears (and the message follows the dates until they edit it)
      function flags() {
        const f = [], amt = Number($('qg-amount').value.replace(/[,\u20B1\s]/g, '')), ready = $('qg-ready').value;
        if (P.ok && amt > 0) {
          if (amt < P.cost - 0.004) f.push(peso(amt) + ' is below the cost of ' + peso(P.cost));
          else if (amt < P.floor - 0.004) f.push(peso(amt) + ' is below the minimum-margin price of ' + peso(P.floor));
          else if (amt < P.lowest - 0.004 || amt > P.highest + 0.004) f.push(peso(amt) + ' is outside ' + peso(P.lowest) + ' to ' + peso(P.highest));
        } else if (!P.ok) f.push('The price was typed by hand');
        if (ready && ready < g.ready.date) f.push('Ready date is earlier than the system can support (' + nice(g.ready.date) + ')');
        if (ready && g.ready.neededBy && ready > g.ready.neededBy) f.push('Ready date is after the customer\u2019s needed-by date');
        return f;
      }
      function refresh() {
        const f = flags(), box = $('qg-need'), had = box.querySelector('textarea') ? box.querySelector('textarea').value : '';
        box.hidden = !f.length;
        box.innerHTML = f.length ? `<b>Please explain the change</b><ul>${f.map((x) => '<li>' + esc(x) + '</li>').join('')}</ul><textarea id="qg-reason" rows="2" placeholder="Why? This is saved in the decision log.">${esc(had)}</textarea>` : '';
        if (!msgEdited) $('qg-msg').value = g.message.replace(nice(g.ready.date), nice($('qg-ready').value || g.ready.date)).replace(nice(g.valid.date), nice($('qg-valid').value || g.valid.date));
      }
      ['qg-amount', 'qg-ready', 'qg-valid'].forEach((id) => $(id).addEventListener('input', refresh));
      if ($('qg-reset')) $('qg-reset').addEventListener('click', () => { $('qg-amount').value = P.suggested.toFixed(2); refresh(); });
      refresh();

      $('qg-send').addEventListener('click', async () => {
        ['amount', 'ready', 'valid', 'top'].forEach((k) => { $('qg-e-' + k).textContent = ''; });
        const btn = $('qg-send'); btn.disabled = true;
        const amt = Number($('qg-amount').value.replace(/[,₱s]/g, ''));
        if (P.ok && amt > 0 && amt < P.floor - 0.004) {
          $('qg-e-amount').textContent = 'Price cannot be lower than the 20% margin floor (' + peso(P.floor) + '). Unit price must maintain at least 20% margin.';
          btn.disabled = false;
          return;
        }
        const reason = $('qg-reason');
        try {
          await opts.send({ status: 'quoted', amount: $('qg-amount').value, readyBy: $('qg-ready').value, validUntil: $('qg-valid').value,
            note: $('qg-msg').value.trim(), overrideReason: reason ? reason.value.trim() : '' });
          opts.onSent && opts.onSent();
        } catch (e) {
          const f = (e && (e.fields || e.errors)) || {};      // adapt to how your helper exposes ValidationError fields
          const map = { amount: 'amount', readyBy: 'ready', validUntil: 'valid' };
          let shown = false;
          Object.keys(map).forEach((k) => { if (f[k]) { $('qg-e-' + map[k]).textContent = f[k]; shown = true; } });
          if (f.overrideReason) { $('qg-e-top').textContent = f.overrideReason; shown = true; }
          if (!shown) $('qg-e-top').textContent = (e && e.message) || 'Could not send the quote';
          btn.disabled = false;
        }
      });
    }
  }
  global.QuoteGuidePanel = { mount };
})(window);
