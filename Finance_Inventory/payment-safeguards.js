/* Finance's explicit balance/production decisions. Server enforces role, locks and approvals. */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  async function api(path, body) {
    const r = await fetch('/api' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type':'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json(); if (!r.ok) throw new Error(Object.values(data.fields || {}).join('; ') || data.error || 'Request failed'); return data;
  }
  function dialog(title, fields, submit, options = {}) {
    const d = document.createElement('dialog');
    d.className = 'safeguard-dialog';
    d.style.cssText = 'width:min(560px,95vw);background:var(--panel,#fff);color:var(--text,#16202b);border:1px solid #aaa;border-radius:10px;padding:24px';
    d.innerHTML = '<form novalidate><h2>' + esc(title) + '</h2>' + fields + '<label>Finance note<textarea name="note" required minlength="5" maxlength="300"></textarea></label><p role="alert" style="color:#c0392b"></p><div class="safeguard-actions"><button type="button" class="btn-secondary" data-close>Back</button><button type="submit" class="btn-primary">Save decision</button></div></form>';
    const note = d.querySelector('[name=note]');
    note.required = options.noteRequired !== false;
    note.minLength = note.required ? 5 : 0;
    if (options.setup) options.setup(d);
    document.body.append(d); d.showModal();
    const checks = [...d.querySelectorAll('input, select, textarea')].map(input => ({ input, check: FormAssist.validation.bind(input, value => {
      if (input.name === 'note') return (input.required && value.trim().length < 5) || (value.trim() && value.trim().length < input.minLength) ? 'Write a Finance note (at least 5 characters).' : value.length > 300 ? 'Keep the note within 300 characters.' : '';
      if (input.name === 'date' && value) {
        const date = new Date(value).getTime();
        if (!Number.isFinite(date) || date <= Math.max(Date.now(), new Date(options.dueAt || 0).getTime() || 0)) return 'Choose a future date later than the current due date.';
      }
      return FormAssist.validation.nativeProblem(input);
    }) }));
    d.addEventListener('change', () => checks.forEach(({check}) => check(false)));
    return new Promise((resolve) => {
      d.addEventListener('close', () => { d.remove(); resolve(null); });
      d.querySelector('[data-close]').onclick = () => d.close();
      d.querySelector('form').onsubmit = async (e) => {
        e.preventDefault(); const bad = checks.filter(({check}) => check(true)); if (bad.length) { bad[0].input.focus(); return; }
        const b = Object.fromEntries(new FormData(e.target)); const button = e.submitter || d.querySelector('[type=submit]'); button.disabled = true;
        try { const result = await submit(b); resolve(result); d.close(); }
        catch (err) { d.querySelector('[role=alert]').textContent = err.message; button.disabled = false; }
      };
    });
  }
  window.PaymentSafeguards = {
    async cancel(no, approve) {
      const policy = await api('/finance/orders/' + encodeURIComponent(no) + '/cancellation-policy');
      const partial = policy.madeToOrder && policy.paid > 0;
      return dialog('Cancel ' + no,
        (approve ? '' : '<label>Reason<select name="reasonCode" required><option value="">Choose reason</option><option value="changed_mind">Changed mind</option><option value="balance_unpaid">Balance unpaid after grace period</option><option value="other">Other</option></select></label>') +
        (partial ? '<label data-deposit hidden style="margin:12px 0">Made-to-order down payment<select name="depositDisposition"><option value="">Choose disposition</option><option value="refund">Refund</option><option value="forfeit">Forfeit down payment</option></select><span>Any refundable amount is queued for Finance settlement.</span></label>' : ''),
        (b) => api('/orders/' + encodeURIComponent(no) + (approve ? '/cancel-decision' : '/cancel'), { ...b, approve: !!approve, reason: b.note }), {
          noteRequired: !approve,
          setup(d) {
            if (!partial) return;
            const select = d.querySelector('[name=reasonCode]'), label = d.querySelector('[data-deposit]'), note = d.querySelector('[name=note]');
            const update = () => {
              const needed = ['changed_mind','balance_unpaid'].includes(select ? select.value : policy.requestedReason);
              label.hidden = !needed;
              label.querySelector('select').required = needed;
              label.querySelector('select').disabled = !needed;
              note.required = !approve || needed;
              note.minLength = note.required ? 5 : 0;
            };
            if (select) select.addEventListener('change', update);
            update();
          }
        });
    }
  };
  let loading = false;
  async function render() {
    const page = document.getElementById('payment-terms');
    if (!page || !page.classList.contains('active-page') || loading) return;
    loading = true;
    let box = document.getElementById('balanceSafeguards');
    if (!box) { box = document.createElement('section'); box.id = 'balanceSafeguards'; box.className = 'panel'; page.append(box); }
    try {
      const [data, debt, quotes] = await Promise.all([api('/finance/balance-overdue'), api('/finance/receivables'), api('/finance/quotes')]);
      const orders = debt.orders;
      const head = (title, sub) => '<div class="panel-head"><div><div class="panel-title">' + title + '</div><div class="panel-sub">' + sub + '</div></div></div>';
      const empty = (cols, text) => '<tr><td colspan="' + cols + '" class="faint">' + text + '</td></tr>';
      const overrides = quotes.filter((q) => ['accepted','preparing'].includes(q.status) && !q.convertedOrder);
      box.style.marginBottom = '18px';
      box.innerHTML = head('Balance decisions', 'Overdue grace period: ' + Number(data.graceDays) + ' days. Single Finance credit limit: ₱' + Number(debt.creditLimit).toLocaleString() + '.') +
        '<div class="table-wrapper"><table><thead><tr><th>Order</th><th>Status</th><th>Balance</th><th>Actions</th></tr></thead><tbody>' +
        (orders.length ? orders.map((o, i) => '<tr data-i="' + i + '"><td><b>' + esc(o.no) + '</b></td><td>' + esc(o.status) + '</td><td>₱' + Number(o.outstanding).toLocaleString() + '</td>' +
          '<td><div class="safeguard-actions">' + (o.creditPending ? '<span class="faint">Pending second approval: ' + esc(o.creditPending.note) + '</span><button data-act="approve">Approve as second Finance user</button>' : '<button data-act="extend">Extend due date</button><button data-act="grant">Grant credit exception</button>') +
          '<button data-act="revoke">Revoke credit request / exception</button>' + (o.status === 'On Hold' ? '<button data-act="cancel">Cancel</button>' : '') + '</div></td></tr>').join('') : empty(4, 'No balances need a decision.')) +
        '</tbody></table></div>' +
        '<div class="panel-head" style="margin-top:18px"><div><div class="panel-title">Production payment overrides</div><div class="panel-sub">Let an unpaid accepted quotation go into production. Your name and reason are logged.</div></div></div>' +
        '<div class="table-wrapper"><table><thead><tr><th>Quotation</th><th>Override</th><th>Actions</th></tr></thead><tbody>' +
        (overrides.length ? overrides.map((q) => '<tr><td><b>' + esc(q.id) + '</b></td><td>' + (q.productionOverride ? 'By ' + esc(q.productionOverride.by) + ': ' + esc(q.productionOverride.note) : '<span class="faint">None</span>') + '</td>' +
          '<td><div class="safeguard-actions"><button data-production-override="' + esc(q.id) + '" data-action="' + (q.productionOverride ? 'revoke' : 'grant') + '">' + (q.productionOverride ? 'Revoke override' : 'Record Finance override') + '</button></div></td></tr>').join('') : empty(3, 'No quotations are waiting on a production override.')) +
        '</tbody></table></div>';
      [...box.querySelectorAll('[data-act]')].forEach((button) => {
        const o = orders[Number(button.closest('tr').dataset.i)];
        button.onclick = async () => {
          const action = button.dataset.act;
          if (action === 'cancel') await window.PaymentSafeguards.cancel(o.no, false);
          else await dialog(o.no + ' — ' + action, action === 'extend' ? '<label>New due date<input type="datetime-local" name="date" required></label>' : '<p>Balances above the limit require a second signed-in Finance user. Your account identifies the approver.</p>', (b) => api('/finance/orders/' + encodeURIComponent(o.no) + (action === 'extend' ? '/balance-extension' : '/credit-exception'), action === 'extend' ? { note:b.note, dueAt:new Date(b.date).toISOString() } : { note:b.note, action }), {dueAt:o.dueAt});
          loading = false; render();
        };
      });
      box.querySelectorAll('button').forEach(button => button.classList.add('btn-secondary', 'btn-sm'));
    } catch (err) { box.textContent = err.message; }
    finally { loading = false; }
  }
  document.addEventListener('page:change', render);
  const target = document.getElementById('payment-terms');
  if (target) new MutationObserver(render).observe(target, { attributes: true, attributeFilter: ['class'] });
  setInterval(render, 15000); render();
  // The quote detail already identifies the selected quote; Finance can authorize an unpaid job explicitly.
  document.addEventListener('click', (e) => {
    const button = e.target.closest('[data-production-override]'); if (!button) return;
    dialog('Production override — ' + button.dataset.productionOverride, '<p>Your Finance account name and reason are recorded in the audit log. This permits fabrication and material purchasing before payment.</p>', (b) => api('/finance/quotes/' + encodeURIComponent(button.dataset.productionOverride) + '/production-override', { ...b, action: button.dataset.action || 'grant' }));
  });
})();
