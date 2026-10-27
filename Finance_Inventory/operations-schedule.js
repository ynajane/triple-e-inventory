/* operations-schedule.js — Automated tracking and planning board for Finance.
   Displays incoming supplier deliveries for Raw Materials & Finishing Supplies
   and scheduled manufacturing runs for Finished Goods with real-time material readiness.
*/
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 });
  const B = () => window.TripleEBridge;

  const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const niceDate = (ymd) => { const d = new Date(ymd + 'T00:00:00'); return isNaN(d) ? ymd : d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }); };

  let currentTab = 'deliveries';
  let schedules = [];
  let plans = [];
  let busy = false;

  async function api(path, options) {
    const res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    }, options));
    if (res.status === 401) {
      window.location.href = 'Login_Inventory.html';
      throw new Error('Not signed in');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Request failed (' + res.status + ')');
    }
    return data;
  }

  function toast(msg, isError) {
    if (B() && typeof B().toast === 'function') {
      B().toast(msg, isError ? 'error' : undefined);
      return;
    }
    const el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function mountPanel() {
    const dash = $('dashboard');
    if (!dash || $('opsSchedulePanel')) return;

    const panel = document.createElement('div');
    panel.id = 'opsSchedulePanel';
    panel.className = 'panel ops-panel';
    panel.innerHTML = `
      <div class="panel-head">
        <div>
          <div class="panel-title">Operations & Delivery Schedule</div>
          <div class="panel-sub">Everything here stocks in by itself on its scheduled date — nothing to click</div>
        </div>
        <div class="ops-head-actions">
          <div class="ops-tabs" role="tablist">
            <button type="button" class="ops-tab ${currentTab === 'deliveries' ? 'active' : ''}" data-ops-tab="deliveries">
              Incoming Deliveries <span class="ops-tab-count" id="opsDeliveriesCount">0</span>
            </button>
            <button type="button" class="ops-tab ${currentTab === 'plans' ? 'active' : ''}" data-ops-tab="plans">
              Production Planner <span class="ops-tab-count" id="opsPlansCount">0</span>
            </button>
          </div>
          <button type="button" class="btn-secondary ops-btn-refresh" id="opsRefreshBtn" title="Refresh schedule and readiness">Refresh</button>
        </div>
      </div>
      <div id="opsContent" class="ops-content">
        <div class="ops-empty">Loading operations schedule...</div>
      </div>
    `;

    // Insert right before recent movements panel
    const movementsPanel = dash.querySelector('.movements-panel');
    if (movementsPanel) {
      dash.insertBefore(panel, movementsPanel);
    } else {
      dash.appendChild(panel);
    }

    panel.querySelector('.ops-tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ops-tab]');
      if (!btn || btn.dataset.opsTab === currentTab) return;
      currentTab = btn.dataset.opsTab;
      panel.querySelectorAll('.ops-tab').forEach((t) => t.classList.toggle('active', t.dataset.opsTab === currentTab));
      render();
    });

    $('opsRefreshBtn').addEventListener('click', () => {
      load(true);
    });

  }

  // stocks in everything that is due today (deliveries first, then production) and tells the user what happened
  async function runDue() {
    try {
      const r = await api('/api/inventory/automation/run-due', { method: 'POST', body: JSON.stringify({}) });
      const got = (r.deliveries && r.deliveries.processedCount) || 0, made = (r.production && r.production.producedCount) || 0;
      if (got || made) {
        const parts = [];
        if (got) parts.push(got + ' scheduled deliver' + (got === 1 ? 'y' : 'ies') + ' received');
        if (made) parts.push(made + ' production run' + (made === 1 ? '' : 's') + ' completed');
        toast('Automatic stock-in: ' + parts.join(', ') + '.');
        if (B() && typeof B().reload === 'function') await B().reload();
      }
      return r;
    } catch (err) {
      console.warn('[ops-schedule] automatic stock-in failed:', err.message);
      return null;
    }
  }

  async function load(showToast) {
    try {
      await runDue();
      const [sRes, pRes] = await Promise.all([
        api('/api/inventory/automation/delivery-schedules'),
        api('/api/inventory/automation/production-plans')
      ]);
      schedules = Array.isArray(sRes) ? sRes : [];
      plans = Array.isArray(pRes) ? pRes : [];

      const dCount = $('opsDeliveriesCount');
      if (dCount) dCount.textContent = schedules.length;
      const pCount = $('opsPlansCount');
      if (pCount) pCount.textContent = plans.length;

      render();
      if (showToast) toast('Operations schedule updated');
    } catch (err) {
      console.warn('[ops-schedule] load failed:', err.message);
      const box = $('opsContent');
      if (box) box.innerHTML = '<div class="ops-empty">Could not load schedule: ' + esc(err.message) + '</div>';
    }
  }

  function render() {
    const box = $('opsContent');
    if (!box) return;

    if (currentTab === 'deliveries') {
      renderDeliveries(box);
    } else {
      renderPlans(box);
    }
  }

  function renderDeliveries(box) {
    if (!schedules.length) {
      box.innerHTML = '<div class="ops-empty">No supplier delivery schedules configured.</div>';
      return;
    }

    const todayStr = todayLocal();

    let html = `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Expected Date</th>
              <th>Department</th>
              <th>Material</th>
              <th>Quantity</th>
              <th>Supplier</th>
              <th>Frequency</th>
              <th>Stock-in</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const s of schedules) {
      const isDue = s.nextDeliveryDate <= todayStr;
      const badge = isDue
        ? '<span class="ops-badge-due">Due Today</span>'
        : '<span class="ops-badge-sched">Scheduled</span>';
      const auto = isDue
        ? '<span class="ops-auto now">Stocking in now…</span>'
        : '<span class="ops-auto" title="Stock is added automatically on this date">Auto stock-in on ' + esc(niceDate(s.nextDeliveryDate)) + '</span>';

      html += `
        <tr>
          <td>${badge}</td>
          <td><b>${esc(s.nextDeliveryDate)}</b></td>
          <td><span class="dim">${esc(s.department)}</span></td>
          <td><strong>${esc(s.productName)}</strong> <div class="dim mono" style="font-size:11.5px">${esc(s.sku)}</div></td>
          <td><b>${num(s.quantity)} ${esc(s.unit)}</b></td>
          <td>${esc(s.supplierName)}</td>
          <td><span class="dim" style="text-transform:capitalize">${esc(s.frequency)}</span></td>
          <td>${auto}</td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
    box.innerHTML = html;
  }

  function renderPlans(box) {
    if (!plans.length) {
      box.innerHTML = '<div class="ops-empty">No periodic production plans configured.</div>';
      return;
    }

    let html = `
      <div class="ops-table-wrap">
        <table class="ops-table">
          <thead>
            <tr>
              <th>Readiness</th>
              <th>Target Date</th>
              <th>Finished Good</th>
              <th>Planned Volume</th>
              <th>Materials Needed (BOM)</th>
              <th>Period</th>
              <th>Production</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const p of plans) {
      const r = p.readiness || { isReady: false };
      const isReady = r.isReady;

      let readyBadge = '';
      if (isReady) {
        readyBadge = '<span class="ops-badge-ready">Materials Ready</span>';
      } else {
        const shortCount = (r.shortages || []).length;
        const firstShort = (r.shortages && r.shortages[0]) || { name: 'materials missing' };
        readyBadge = `<span class="ops-badge-short" title="${esc(firstShort.name)}">Shortage (${shortCount} item${shortCount === 1 ? '' : 's'})</span>`;
      }

      // Materials chips
      const allMats = [...(r.rawMaterials || []), ...(r.finishingSupplies || [])];
      let matHtml = '<div class="ops-mat-list">';
      if (allMats.length) {
        matHtml += allMats.slice(0, 3).map((m) => {
          const cls = m.isSufficient ? 'ops-mat-chip' : 'ops-mat-chip short';
          return `<span class="${cls}" title="${esc(m.department)}: needs ${num(m.consumedQty)} ${esc(m.unit)}, on hand ${num(m.onHand)}">${esc(m.name)}: <b>${num(m.consumedQty)} ${esc(m.unit)}</b></span>`;
        }).join('');
        if (allMats.length > 3) {
          matHtml += `<span class="dim" style="font-size:11px">+${allMats.length - 3} more</span>`;
        }
      } else {
        matHtml += '<span class="dim">No BOM configured</span>';
      }
      matHtml += '</div>';

      html += `
        <tr>
          <td>${readyBadge}</td>
          <td><b>${esc(p.nextRunDate)}</b></td>
          <td><strong>${esc(p.productName)}</strong> <div class="dim mono" style="font-size:11.5px">${esc(p.sku)}</div></td>
          <td><b>${num(p.targetVolume)} ${esc(p.unit)}</b></td>
          <td>${matHtml}</td>
          <td><span class="dim" style="text-transform:capitalize">${esc(p.period)}</span></td>
          <td>${isReady
              ? '<span class="ops-auto" title="Materials are deducted and Finished Goods are added automatically on this date">Auto-produces on ' + esc(niceDate(p.nextRunDate)) + '</span>'
              : '<span class="ops-auto wait" title="Production runs by itself as soon as the missing materials are stocked in">Waiting for materials</span>'}</td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
    box.innerHTML = html;
  }

  function init() {
    mountPanel();
    load(false);

    // Refresh when navigating to dashboard or when window gains focus
    document.querySelectorAll('[data-page="dashboard"]').forEach((b) => {
      b.addEventListener('click', () => load(false));
    });

    const dashPage = $('dashboard');
    if (dashPage) {
      new MutationObserver(() => {
        if (dashPage.classList.contains('active-page')) load(false);
      }).observe(dashPage, { attributes: true, attributeFilter: ['class'] });
    }

    // the server stocks things in on the day; keep an open dashboard in step
    setInterval(() => { if (!document.hidden) load(false); }, 5 * 60 * 1000);

    window.addEventListener('focus', () => {
      const d = $('dashboard');
      if (d && d.classList.contains('active-page')) load(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.OperationsSchedule = { load, render, mountPanel };
})();