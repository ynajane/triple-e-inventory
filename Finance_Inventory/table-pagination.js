/* table-pagination.js — Universal 10-row pagination engine for Triple-E tables.
   Automatically limits all data tables across Finance, Cashier, and Reports to 10 rows per page,
   providing clean Next/Prev and direct page navigation. */
(() => {
  'use strict';

  const PAGE_SIZE = 10;

  function isEligibleTable(table) {
    if (!table || table.nodeType !== 1) return false;
    if (table.hasAttribute('data-no-paginate')) return false;
    // api-bridge.js already pages this table with its own .pager bar -> do not add a second one
    if (table.hasAttribute('data-bridge-paged')) return false;
    if (table.closest('[data-no-paginate="true"]')) return false;
    if (table.closest('.rcpt-items, #receiptBg, #printInvoice, .customer-modal-content, .sg-carry')) return false;
    if (table.classList.contains('qd-table') || table.classList.contains('rs-table')) return false;
    return true;
  }

  function getDataRows(tbody) {
    if (!tbody) return [];
    return Array.from(tbody.children).filter((tr) => {
      if (tr.tagName !== 'TR') return false;
      if (tr.hasAttribute('data-no-paginate')) return false;
      if (tr.classList.contains('no-results-row') ||
          tr.classList.contains('customer-empty') ||
          tr.classList.contains('report-note') ||
          tr.classList.contains('rs-none') ||
          tr.classList.contains('empty-row')) return false;
      const cells = tr.children;
      if (cells.length === 1 && cells[0].hasAttribute('colspan')) return false;
      return true;
    });
  }

  function getPageNumbers(cur, total) {
    if (total <= 7) {
      const arr = [];
      for (let i = 1; i <= total; i++) arr.push(i);
      return arr;
    }
    if (cur <= 4) {
      return [1, 2, 3, 4, 5, '...', total];
    }
    if (cur >= total - 3) {
      return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    }
    return [1, '...', cur - 1, cur, cur + 1, '...', total];
  }

  function renderPagerUI(pager, cur, totalPages, start, end, totalRows, onGo) {
    pager.innerHTML = '';

    const info = document.createElement('div');
    info.className = 'table-pagination-info';
    info.innerHTML = 'Showing <strong>' + (start + 1) + '</strong> to <strong>' + end + '</strong> of <strong>' + totalRows + '</strong> rows';
    pager.appendChild(info);

    const controls = document.createElement('div');
    controls.className = 'table-pagination-controls';

    const makeBtn = (text, page, disabled, isActive, isNav) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-page-btn' + (isActive ? ' is-active' : '') + (isNav ? ' nav-btn' : '');
      btn.textContent = text;
      if (disabled) btn.disabled = true;
      if (!disabled && !isActive) {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          onGo(page);
        });
      }
      return btn;
    };

    controls.appendChild(makeBtn('« First', 1, cur === 1, false, true));
    controls.appendChild(makeBtn('‹ Prev', cur - 1, cur === 1, false, true));

    const pages = getPageNumbers(cur, totalPages);
    pages.forEach((p) => {
      if (p === '...') {
        const span = document.createElement('span');
        span.className = 'table-page-ellipsis';
        span.textContent = '…';
        controls.appendChild(span);
      } else {
        controls.appendChild(makeBtn(String(p), p, false, p === cur, false));
      }
    });

    controls.appendChild(makeBtn('Next ›', cur + 1, cur === totalPages, false, true));
    controls.appendChild(makeBtn('Last »', totalPages, cur === totalPages, false, true));

    pager.appendChild(controls);
  }

  function paginateTable(table, requestedPage) {
    if (!isEligibleTable(table)) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    if (table._isPaginating) return;
    table._isPaginating = true;

    try {
      const rows = getDataRows(tbody);

      let pager = table._pagerEl;
      if (!pager || !pager.parentNode) {
        const container = table.closest('.table-wrapper') || table.closest('.cmx-tablewrap') || table;
        const next = container.nextElementSibling;
        if (next && next.classList.contains('table-pagination')) {
          pager = next;
        } else {
          pager = document.createElement('div');
          pager.className = 'table-pagination';
          container.parentNode.insertBefore(pager, container.nextSibling);
        }
        table._pagerEl = pager;
      }

      if (rows.length <= PAGE_SIZE) {
        for (let i = 0; i < rows.length; i++) {
          rows[i].style.display = '';
        }
        pager.style.display = 'none';
        table._currentPage = 1;
        table._lastRowCount = rows.length;
        return;
      }

      pager.style.display = 'flex';
      const totalPages = Math.ceil(rows.length / PAGE_SIZE);

      let cur = requestedPage !== undefined ? requestedPage : (table._currentPage || 1);
      if (cur < 1) cur = 1;
      if (cur > totalPages) cur = totalPages;
      table._currentPage = cur;
      table._lastRowCount = rows.length;

      const start = (cur - 1) * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, rows.length);

      for (let i = 0; i < rows.length; i++) {
        rows[i].style.display = (i >= start && i < end) ? '' : 'none';
      }

      renderPagerUI(pager, cur, totalPages, start, end, rows.length, (newPage) => {
        paginateTable(table, newPage);
        const rect = table.getBoundingClientRect();
        if (rect.top < 0) {
          table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    } finally {
      table._isPaginating = false;
    }
  }

  function paginateAll() {
    document.querySelectorAll('table').forEach((t) => {
      if (isEligibleTable(t)) paginateTable(t);
    });
  }

  let scheduled = null;
  function scheduleUpdate(tables) {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => {
      scheduled = null;
      if (tables && tables.size) {
        tables.forEach((t) => paginateTable(t, 1));
      } else {
        paginateAll();
      }
    });
  }

  function initObserver() {
    const observer = new MutationObserver((mutations) => {
      const affected = new Set();
      for (const m of mutations) {
        if (m.type === 'childList') {
          const t = m.target;
          if (t && t.tagName === 'TBODY') {
            const table = t.closest('table');
            if (isEligibleTable(table)) affected.add(table);
          } else if (t && t.querySelector) {
            t.querySelectorAll('table').forEach((tbl) => {
              if (isEligibleTable(tbl)) affected.add(tbl);
            });
          }
        }
      }
      if (affected.size > 0) {
        scheduleUpdate(affected);
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-page], .nav-item, .sales-tab, .pill-btn, [data-view]');
      if (trigger) {
        setTimeout(paginateAll, 60);
        setTimeout(paginateAll, 250);
      }
    });

    // Also wrap showPage if defined
    if (typeof window.showPage === 'function') {
      const origShowPage = window.showPage;
      window.showPage = function (...args) {
        const ret = origShowPage.apply(this, args);
        setTimeout(paginateAll, 80);
        return ret;
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initObserver();
      paginateAll();
    });
  } else {
    initObserver();
    paginateAll();
  }

  window.TablePagination = {
    PAGE_SIZE,
    paginate: paginateTable,
    paginateAll
  };
})();