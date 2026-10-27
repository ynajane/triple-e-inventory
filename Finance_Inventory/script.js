function escapeHTML(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


function formatNumber(value) {

    return new Intl.NumberFormat("en-PH").format(value);

}


function formatCurrency(value) {

    return new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
        maximumFractionDigits: 2
    }).format(value);

}


/* =====================================================
   PAGE NAVIGATION
===================================================== */

const pageInformation = {

    dashboard: {
        title: "Dashboard",
        subtitle: "Overview"
    },

    notifications: {
        title: "Notifications",
        subtitle: "Alerts"
    },

    "sales-overview": { title: "Sales Overview", subtitle: "Read-only ledger of every POS sale and online order" },

    orders: {
        title: "Online Orders",
        subtitle: "Monitor shop orders. The cashier processes them"
    },

    sales: {
        title: "POS Sales & Shifts",
        subtitle: "Monitor POS sales and cash shifts. The cashier runs them"
    },

    inventory: {
        title: "Inventory Monitoring",
        subtitle: "Finance Admin Officer Access"
    },

    stockflow: {
        title: "Stock In / Out",
        subtitle: "Movement entry"
    },

    stockcount: {
        title: "Stock Count",
        subtitle: "Physical inventory audit and variance reconciliation"
    },

    products: {
        title: "Products",
        subtitle: "Manage products and inventory information"
    },

    suppliers: {
        title: "Suppliers",
        subtitle: "Manage supplier information"
    },

    dispatch: {
        title: "Dispatch",
        subtitle: "Release finished goods against purchase orders"
    },

    quotes: {
        title: "Quote Approvals",
        subtitle: "Cashier prices waiting for Finance, and every quotation for reference"
    },

    "payment-terms": {
        title: "Policies & Rates",
        subtitle: "Corporate payment terms, cash on delivery thresholds, automated delivery rates, and weight surcharges"
    },

    reviews: {
        title: "Product Reviews",
        subtitle: "Verified customer reviews"
    },

    customers: { title: "Customer Profiles", subtitle: "Registered customer directory" },

    usermgmt: {
        title: "User Management",
        subtitle: "Manage user accounts"
    },

    auditlog: {
        title: "Audit Log",
        subtitle: "System activity record"
    },

    notifications: {
        title: "Notifications",
        subtitle: "System alerts, reorder triggers, and approval notices"
    },

    "sales-hub": {
        title: "Sales",
        subtitle: "Overview, online orders, POS sales, quotes, customers, and policies on one page"
    },

    "sales-overview": {
        title: "Sales Overview",
        subtitle: "Comprehensive transactions, approvals, and performance metrics"
    },

    orders: {
        title: "Online Orders",
        subtitle: "Customer orders, order queue, dispatch, and cancellation decisions"
    },

    sales: {
        title: "POS Counter Sales",
        subtitle: "Store register transactions, cashier shifts, and void/return decisions"
    },

    reports: {
        title: "Reports",
        subtitle: "View reports and analytics"
    }

};


function navigateToPage(pageId) {

    const navItems = document.querySelectorAll(".nav-item");
    const pages = document.querySelectorAll(".page");

    // Sales is ONE page (#sales-hub) that holds six sections, each keeping its old id.
    // Asking for one of those ids (a link, a notification, a dashboard shortcut, a saved #hash)
    // opens the Sales page and scrolls to that section.
    const SALES_SECTIONS = ['sales-overview', 'orders', 'sales', 'quotes', 'payments', 'customers', 'payment-terms'];
    const salesTarget = SALES_SECTIONS.includes(pageId) ? pageId : null;
    if (salesTarget) pageId = 'sales-hub';
    const inSales = pageId === 'sales-hub';

    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageId);
    });

    pages.forEach(page => {
        // the sections inside the Sales page switch on and off together with it
        const insideSales = inSales && page.classList.contains('sales-sec');
        page.classList.toggle(
            "active-page",
            page.id === pageId || insideSales
        );
    });

    if (salesTarget) {
        // after the page is shown (and after api-bridge.js scrolls to the top)
        setTimeout(() => { if (window.TripleESalesHub) window.TripleESalesHub.show(salesTarget); }, 80);
    }

    const information = pageInformation[pageId];

    if (!information) {
        return;
    }

    const pageTitle = document.getElementById("pageTitle");
    const pageSubtitle = document.getElementById("pageSubtitle");

    if (pageTitle) {
        pageTitle.textContent = information.title;
    }

    if (pageSubtitle) {
        pageSubtitle.textContent = information.subtitle;
    }

}


function initNavigation() {

    document.querySelectorAll(".nav-item, .sales-tab").forEach(item => {

        item.addEventListener("click", () => {
            navigateToPage(item.dataset.page);
        });

    });

}


/* =====================================================
   QUICK ACTIONS
===================================================== */

const UI_ICONS = {
    plus: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
    package: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>',
    building: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4M10 10h4M10 14h4M10 18h4"/></svg>',
    cart: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>',
    chart: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    arrow: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>'
};

const quickActionsConfig = [
    {
        icon: "plus",
        title: "Record Stock Movement",
        sub: "Log a stock in or stock out",
        targetPage: "stockflow"
    },
    {
        icon: "package",
        title: "Add New Product",
        sub: "Create a product record",
        targetPage: "products"
    },
    {
        icon: "building",
        title: "Onboard Supplier",
        sub: "Add a new supplier",
        targetPage: "suppliers"
    },
    {
        icon: "cart",
        title: "Record Sales Transaction",
        sub: "Create a new sales transaction",
        targetPage: "sales"
    },
    {
        icon: "chart",
        title: "View reports",
        sub: "Daily, weekly, monthly, yearly, or custom",
        targetPage: "reports"
    }
];


function renderQuickActions() {

    const container =
        document.getElementById("quickActionsList");

    if (!container) {
        return;
    }

    container.innerHTML = quickActionsConfig.map((action, index) => `

        <div
            class="quick-action-item"
            data-index="${index}"
        >

            <div class="quick-action-icon">
                ${UI_ICONS[action.icon] || ""}
            </div>

            <div class="quick-action-body">

                <div class="quick-action-title">
                    ${escapeHTML(action.title)}
                </div>

                <div class="quick-action-sub">
                    ${escapeHTML(action.sub)}
                </div>

            </div>

            <div class="quick-action-arrow">
                ${UI_ICONS.arrow}
            </div>

        </div>

    `).join("");

    container
        .querySelectorAll(".quick-action-item")
        .forEach(item => {

            item.addEventListener("click", () => {

                const action =
                    quickActionsConfig[
                        Number(item.dataset.index)
                    ];

                if (action.targetPage) {
                    navigateToPage(action.targetPage);
                }

            });

        });

}


/* =====================================================
   DASHBOARD UI
   TEMPORARY DISPLAY VALUES ONLY
===================================================== */

const dashboardMockDisplay = {

    totalSkus: 14,
    departments: 4,
    lowStock: 6,
    movements: 6,
    inventoryValue: 0,
    orders: null,
    ordersOpen: 0,
    posSales: 0

};


function renderDashboardStats() {

    const totalSkus =
        document.getElementById("totalSkus");

    const skuFoot =
        document.getElementById("skuFoot");

    const lowStockAlerts =
        document.getElementById("lowStockAlerts");

    const lowStockFoot =
        document.getElementById("lowStockFoot");

    const dashMovements =
        document.getElementById("dashMovements");

    const dashMovementsFoot =
        document.getElementById("dashMovementsFoot");

    const totalOrders=
        document.getElementById("totalOrders");

    const totalOrdersFoot =
        document.getElementById("totalOrdersFoot");


    if (totalSkus) {
        totalSkus.textContent =
            dashboardMockDisplay.totalSkus;
    }

    if (skuFoot) {
        skuFoot.textContent =
            `${dashboardMockDisplay.departments} departments tracked`;
    }

    if (lowStockAlerts) {
        lowStockAlerts.textContent =
            dashboardMockDisplay.lowStock;
    }

    {
        const lowEl = document.getElementById("dashLowStock");
        const lowFootEl = document.getElementById("dashLowStockFoot");
        const lowCard = document.getElementById("dashLowCard");
        const rows = (typeof inventoryMonitoringData !== "undefined" && inventoryMonitoringData.length)
            ? inventoryMonitoringData : [];
        const low = rows.length
            ? rows.filter(i => getStockStatus(i) === "low")
            : null;
        const lowCount = low ? low.length : dashboardMockDisplay.lowStock;
        const outCount = low ? low.filter(i => i.onHand <= 0).length : 0;
        if (lowEl) lowEl.textContent = lowCount;
        if (lowFootEl) {
            lowFootEl.textContent = lowCount
                ? (outCount ? `${outCount} out of stock · needs restock` : "At or below reorder level")
                : "Nothing needs restocking";
        }
        if (lowCard) lowCard.classList.toggle("dash-low-on", lowCount > 0);
    }

    if (lowStockFoot) {
        lowStockFoot.textContent =
            "At or below reorder";
    }

    if (dashMovements) {
        dashMovements.textContent =
            dashboardMockDisplay.movements;
    }

    if (dashMovementsFoot) {
        dashMovementsFoot.textContent =
            "Stock in/out entries";
    }

    if (totalOrders) {
        totalOrders.textContent =
            dashboardMockDisplay.orders === null
                ? "—"
                : dashboardMockDisplay.orders;
    }

    if (totalOrdersFoot) {
        totalOrdersFoot.textContent =
            dashboardMockDisplay.orders === null
                ? "Loading..."
                : `${dashboardMockDisplay.ordersOpen} to process · ${dashboardMockDisplay.posSales} POS sales`;
    }

}


/* =====================================================
   DASHBOARD STOCK HEALTH
   VISUAL MOCK ONLY
===================================================== */

const dashboardHealthMock = [
    {
        name: "Raw Materials",
        healthy: 4,
        total: 7,
        color: "#4a90d9"
    },
    {
        name: "Finished Goods",
        healthy: 2,
        total: 4,
        color: "#43c47a"
    }
];


function buildHealthRingSvg(percent, color) {

    const radius = 34;
    const circumference =
        2 * Math.PI * radius;

    const offset =
        circumference * (1 - percent / 100);

    return `

        <svg
            class="health-ring-svg"
            viewBox="0 0 84 84"
        >

            <circle
                cx="42"
                cy="42"
                r="${radius}"
                fill="none"
                stroke="rgba(255,255,255,0.08)"
                stroke-width="7"
            />

            <circle
                cx="42"
                cy="42"
                r="${radius}"
                fill="none"
                stroke="${color}"
                stroke-width="7"
                stroke-linecap="round"
                stroke-dasharray="${circumference}"
                stroke-dashoffset="${offset}"
                transform="rotate(-90 42 42)"
            />

            <text
                x="42"
                y="47"
                text-anchor="middle"
                class="health-ring-pct"
            >
                ${Math.round(percent)}%
            </text>

        </svg>

    `;

}


function renderStockHealthRings() {

    const container =
        document.getElementById("stockHealthRings");

    if (!container) {
        return;
    }

    container.innerHTML =
        dashboardHealthMock.map(dept => {

            const percent =
                dept.total > 0
                    ? (dept.healthy / dept.total) * 100
                    : 0;

            return `

                <div class="health-ring-card">

                    ${buildHealthRingSvg(
                        percent,
                        dept.color
                    )}

                    <div class="health-ring-name">
                        ${escapeHTML(dept.name)}
                    </div>

                    <div class="health-ring-caption">
                        ${dept.healthy} of ${dept.total} SKUs healthy
                    </div>

                </div>

            `;

        }).join("");

}


/* =====================================================
   DASHBOARD LOW-STOCK TABLE
   DISPLAY MOCK ONLY
===================================================== */

const lowStockMockData = [

    {
        name: 'Brass Forged Elbow 3/4"',
        sku: "BF-ELB-034",
        department: "Finished Goods",
        onHand: 380,
        reorderLevel: 600,
        unit: "pcs"
    },


    {
        name: "Machined Flange 160mm",
        sku: "MC-FLNG-160",
        department: "Finished Goods",
        onHand: 220,
        reorderLevel: 400,
        unit: "pcs"
    },

    {
        name: "Nickel Plating Salt",
        sku: "FS-NIPL-SALT",
        department: "Finishing Supplies",
        onHand: 96,
        reorderLevel: 120,
        unit: "kg"
    }

];


function renderLowStockProducts(products) {

    const tableBody =
        document.getElementById("lowStockTableBody");

    if (!tableBody) {
        return;
    }

    if (!products || products.length === 0) {

        tableBody.innerHTML = `

            <tr>

                <td
                    colspan="6"
                    class="dim"
                >
                    No low stock products.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        products.map(product => `

            <tr>

                <td>
                    ${escapeHTML(product.name)}
                </td>

                <td class="mono">
                    ${escapeHTML(product.sku)}
                </td>

                <td class="dim">
                    ${escapeHTML(product.department)}
                </td>

                <td class="dim">
                    ${formatNumber(product.onHand)}
                    ${escapeHTML(product.unit)}
                </td>

                <td class="dim">
                    ${formatNumber(product.reorderLevel)}
                    ${escapeHTML(product.unit)}
                </td>

                <td>
                    <span class="status-pill low">
                        Low
                    </span>
                </td>

            </tr>

        `).join("");

}


/* =====================================================
   DASHBOARD RECENT MOVEMENTS
   DISPLAY MOCK ONLY
===================================================== */

const recentMovementMockData = [

    {
        ref: "MV-8841",
        product: "Brass Billet C36000",
        type: "in",
        qty: 1800,
        unit: "kg",
        department: "Raw Materials",
        handledBy: "M. Rivera",
        dateTime: "Jul 30, 07:14 AM"
    },

    {
        ref: "MV-8840",
        product: "Zinc Alloy Zamak-3",
        type: "out",
        qty: 420,
        unit: "kg",
        department: "Raw Materials",
        handledBy: "D. Okafor",
        dateTime: "Jul 30, 06:52 AM"
    }

];


function renderRecentMovements(movements) {

    const tableBody =
        document.getElementById(
            "recentMovementsTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!movements || movements.length === 0) {

        tableBody.innerHTML = `

            <tr>

                <td
                    colspan="7"
                    class="dim"
                >
                    No recent stock movements.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        movements.map(movement => {

            const statusClass =
                movement.type === "in"
                    ? "in"
                    : "out";

            const typeLabel =
                movement.type === "in"
                    ? "In"
                    : "Out";

            const sign =
                movement.type === "in"
                    ? "+"
                    : "-";

            return `

                <tr>

                    <td class="mono">
                        ${escapeHTML(movement.ref)}
                    </td>

                    <td>
                        ${escapeHTML(movement.product)}
                    </td>

                    <td>
                        <span
                            class="status-pill ${statusClass}"
                        >
                            ${typeLabel}
                        </span>
                    </td>

                    <td class="dim">
                        ${sign}${formatNumber(movement.qty)}
                        ${escapeHTML(movement.unit)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.department)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.handledBy)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(movement.dateTime)}
                    </td>

                </tr>

            `;

        }).join("");

}


/* =====================================================
   DASHBOARD INIT
===================================================== */

function loadDashboard() {

    renderDashboardStats();

    renderQuickActions();

    renderStockHealthRings();

    renderRecentMovements(
        recentMovementMockData
    );

}


/* =====================================================
   INVENTORY MONITORING
    DISPLAY / FILTER ONLY
===================================================== */

const inventoryMonitoringData = [

    {
        name: 'Brass Forged Elbow 3/4"',
        sku: "BF-ELB-034",
        department: "Finished Goods",
        onHand: 380,
        reorderLevel: 600,
        unit: "pcs",
        unitCost: 5.20,
        location: "FG-1 / Pallet 07"
    },


    {
        name: "Machined Flange 160mm",
        sku: "MC-FLNG-160",
        department: "Finished Goods",
        onHand: 220,
        reorderLevel: 400,
        unit: "pcs",
        unitCost: 24.75,
        location: "FG-2 / Pallet 02"
    },

    {
        name: "Nickel Plating Salt",
        sku: "FS-NIPL-SALT",
        department: "Finishing Supplies",
        onHand: 96,
        reorderLevel: 120,
        unit: "kg",
        unitCost: 41.00,
        location: "CHEM / Cabinet A"
    },

    {
        name: "Zinc Alloy Zamak-3 Ingot",
        sku: "RM-ZAM-3",
        department: "Raw Materials",
        onHand: 1180,
        reorderLevel: 1500,
        unit: "kg",
        unitCost: 3.15,
        location: "RM-A / Rack 04"
    },

    {
        name: "Brass Billet C36000 · 25mm",
        sku: "RM-BRS-C360",
        department: "Raw Materials",
        onHand: 8420,
        reorderLevel: 3000,
        unit: "kg",
        unitCost: 6.42,
        location: "RM-A / Rack 01"
    }

];


function getStockStatus(item) {

    if (item.onHand <= item.reorderLevel) {
        return "low";
    }

    if (item.onHand <= item.reorderLevel * 1.2) {
        return "watch";
    }

    return "ok";

}


function getStockStatusLabel(status) {

    if (status === "low") {
        return "Low";
    }

    if (status === "watch") {
        return "Watch";
    }

    return "OK";

}


/* ---- low-stock priority: most urgent first, highlighted, with a banner on top ---- */
const LOW_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const OK_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>';

function stockRatio(item) {
    return item.reorderLevel > 0 ? item.onHand / item.reorderLevel : (item.onHand <= 0 ? 0 : 99);
}

function sortByStockPriority(items) {
    const rank = { low: 0, watch: 1, ok: 2 };
    return items.slice().sort((a, b) => {
        const ra = rank[getStockStatus(a)], rb = rank[getStockStatus(b)];
        if (ra !== rb) return ra - rb;
        if (ra < 2) return stockRatio(a) - stockRatio(b);          // emptiest first inside Low and Watch
        return String(a.name).localeCompare(String(b.name));
    });
}

function renderInvPriority(items) {
    const box = document.getElementById("invPriority");
    if (!box) return;
    const low = sortByStockPriority(items.filter(i => getStockStatus(i) === "low"));
    const lowCard = document.getElementById("invBelowReorder");
    const card = lowCard ? lowCard.closest(".stat-card") : null;
    if (card) card.classList.toggle("inv-stat-low", low.length > 0);
    setupInvKpiCards();
    if (!items.length) { box.hidden = true; return; }
    box.hidden = false;
    if (!low.length) {
        box.className = "inv-priority is-clear";
        box.innerHTML = '<div class="inv-pri-head"><span class="inv-pri-icon">' + OK_ICON + '</span><div><div class="inv-pri-title">All stock is above its reorder level</div><div class="inv-pri-sub">Nothing needs restocking right now.</div></div></div>';
        return;
    }
    const out = low.filter(i => i.onHand <= 0).length;
    const chips = low.slice(0, 6).map(i => {
        const short = Math.max(i.reorderLevel - i.onHand, 0);
        return '<button type="button" class="inv-chip' + (i.onHand <= 0 ? " is-out" : "") + '" data-sku="' + escapeHTML(i.sku) + '" title="Jump to this product">' +
            '<span class="inv-chip-name">' + escapeHTML(i.name) + '</span>' +
            '<span class="inv-chip-qty">' + (i.onHand <= 0 ? "Out of stock" : formatNumber(i.onHand) + " / " + formatNumber(i.reorderLevel) + " " + escapeHTML(i.unit)) + '</span>' +
            '<span class="inv-chip-short">Need ' + formatNumber(short) + " " + escapeHTML(i.unit) + '</span></button>';
    }).join("");
    box.className = "inv-priority is-alert";
    box.innerHTML = '<div class="inv-pri-head"><span class="inv-pri-icon">' + LOW_ICON + '</span><div class="inv-pri-text"><div class="inv-pri-title">' +
        low.length + ' product' + (low.length === 1 ? '' : 's') + ' need' + (low.length === 1 ? 's' : '') + ' restocking now' +
        (out ? ' <span class="inv-pri-out">' + out + ' out of stock</span>' : '') + '</div><div class="inv-pri-sub">At or below reorder level, most urgent first.</div></div>' +
        '<button type="button" class="btn-secondary inv-pri-btn" data-act="show-low">Show low stock only</button></div>' +
        '<div class="inv-chips">' + chips + (low.length > 6 ? '<span class="inv-more">+' + (low.length - 6) + ' more in the table below</span>' : '') + '</div>';
}

/* KPI cards: each one opens the Stock levels table filtered to what it counts.
   Total SKUs = everything (filters cleared) · Below Reorder = Low · Near Reorder = Watch · Healthy Stock = OK.
   Clicking the active card again goes back to all products. */
const INV_KPI_CARDS = [
    { id: "invTotalSkus", filter: "all", title: "Show every product (clears the filters)" },
    { id: "invBelowReorder", filter: "low", title: "Show only products at or below their reorder level" },
    { id: "invNearReorder", filter: "watch", title: "Show only products close to their reorder level" },
    { id: "invHealthyStock", filter: "ok", title: "Show only products with a healthy stock buffer" }
];
const INV_STATUS_NAMES = { low: "Below reorder", watch: "Near reorder", ok: "Healthy stock" };

function setupInvKpiCards() {
    INV_KPI_CARDS.forEach(k => {
        const v = document.getElementById(k.id);
        const card = v ? v.closest(".stat-card") : null;
        if (!card || card.dataset.invFilter) return;
        card.dataset.invFilter = k.filter;
        card.classList.add("inv-kpi");
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.title = k.title;
    });
    syncInvKpiCards();
}

function syncInvKpiCards() {
    const f = document.getElementById("invStatusFilter"), d = document.getElementById("invDeptFilter"), s = document.getElementById("invSearch");
    const status = f ? f.value : "all";
    const clear = status === "all" && (!d || d.value === "all") && (!s || !s.value.trim());
    document.querySelectorAll("#inventory .stat-card[data-inv-filter]").forEach(card => {
        const on = card.dataset.invFilter === "all" ? clear : card.dataset.invFilter === status;
        card.classList.toggle("is-active", on);
        card.setAttribute("aria-pressed", on ? "true" : "false");
    });
}

function showInvKpi(filter) {
    const f = document.getElementById("invStatusFilter"), d = document.getElementById("invDeptFilter"), s = document.getElementById("invSearch");
    if (filter === "all" || (f && f.value === filter)) {
        if (f) f.value = "all";
        if (filter === "all") { if (d) d.value = "all"; if (s) s.value = ""; }
    } else {
        if (f) f.value = filter;
        if (s) s.value = "";                     // a search would hide part of the list the card counts
    }
    applyInventoryFilters();
    const p = document.getElementById("invPanelSub");
    const panel = p ? p.closest(".panel") : null;
    if (panel) {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
        panel.classList.remove("inv-panel-flash"); void panel.offsetWidth; panel.classList.add("inv-panel-flash");
    }
}

function showLowStockOnly() { showInvKpi("low"); }

function initInvPriorityClicks() {
    const page = document.getElementById("inventory");
    if (!page || page.dataset.priBound) return;
    page.dataset.priBound = "1";
    page.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="show-low"]')) return showLowStockOnly();
        const card = e.target.closest(".stat-card[data-inv-filter]");
        if (card) return showInvKpi(card.dataset.invFilter);
        if (e.target.closest('[data-act="inv-clear"]')) return showInvKpi("all");
        const chip = e.target.closest(".inv-chip");
        if (chip) {
            const f = document.getElementById("invStatusFilter"), s = document.getElementById("invSearch");
            if (f) f.value = "all";
            if (s) s.value = chip.dataset.sku;
            applyInventoryFilters();
            const row = document.querySelector('#stockLevelsTableBody tr[data-sku="' + (window.CSS && CSS.escape ? CSS.escape(chip.dataset.sku) : chip.dataset.sku) + '"]');
            if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.classList.add("inv-flash"); setTimeout(() => row.classList.remove("inv-flash"), 1800); }
        }
    });
    page.addEventListener("keydown", (e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target.matches(".stat-card[data-inv-filter]")) { e.preventDefault(); showInvKpi(e.target.dataset.invFilter); }
    });
}


function renderInventoryMonitoringStats(items) {

    const total =
        items.length;

    const below =
        items.filter(
            item => getStockStatus(item) === "low"
        ).length;

    const near =
        items.filter(
            item => getStockStatus(item) === "watch"
        ).length;

    const healthy =
        items.filter(
            item => getStockStatus(item) === "ok"
        ).length;

    const departmentCount =
        new Set(
            items.map(item => item.department)
        ).size;


    const setText = (id, value) => {

        const element =
            document.getElementById(id);

        if (element) {
            element.textContent = value;
        }

    };


    setText("invTotalSkus", total);

    setText(
        "invTotalSkusFoot",
        `${departmentCount} departments`
    );

    setText("invBelowReorder", below);

    setText(
        "invBelowReorderFoot",
        "Needs restock"
    );

    setText("invNearReorder", near);

    setText(
        "invNearReorderFoot",
        "Watch closely"
    );

    setText("invHealthyStock", healthy);

    setText(
        "invHealthyStockFoot",
        "Sufficient buffer"
    );

    renderInvPriority(items);
    initInvPriorityClicks();

}


function renderStockLevelsTable(items) {

    const tableBody =
        document.getElementById(
            "stockLevelsTableBody"
        );

    if (!tableBody) {
        return;
    }

    if (!items || items.length === 0) {

        tableBody.innerHTML = `

            <tr class="no-results-row">

                <td colspan="8">
                    No products match your filters.
                </td>

            </tr>

        `;

        return;
    }

    tableBody.innerHTML =
        sortByStockPriority(items).map(item => {

            const status =
                getStockStatus(item);

            const shortBy =
                Math.max(item.reorderLevel - item.onHand, 0);

            const fillPercent =
                Math.min(
                    (item.onHand /
                        item.reorderLevel) * 100,
                    100
                );

            return `

                <tr class="inv-row ${status}" data-sku="${escapeHTML(item.sku)}" title="Double-click to record stock in / out">

                    <td>
                        ${escapeHTML(item.name)}
                    </td>

                    <td class="mono">
                        ${escapeHTML(item.sku)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.department)}
                    </td>

                    <td class="stock-level-cell">

                        <div class="stock-level-text">
                            ${formatNumber(item.onHand)}
                            /
                            ${formatNumber(item.reorderLevel)}
                            ${escapeHTML(item.unit)}
                        </div>

                        <div class="stock-bar-track">

                            <div
                                class="stock-bar-fill ${status}"
                                style="width:${fillPercent}%"
                            ></div>

                        </div>

                    </td>

                    <td class="dim">
                        ${formatNumber(item.reorderLevel)}
                        ${escapeHTML(item.unit)}
                    </td>

                    <td class="dim">
                        ${formatCurrency(item.unitCost)}
                    </td>

                    <td class="dim">
                        ${escapeHTML(item.location)}
                    </td>

                    <td>

                        <span class="status-pill ${status}">
                            ${status === "low" ? LOW_ICON : ""}${status === "low" && item.onHand <= 0 ? "Out of stock" : getStockStatusLabel(status)}
                        </span>

                        ${status === "low"
                            ? `<div class="inv-short">Need ${formatNumber(shortBy)} ${escapeHTML(item.unit)} more</div>`
                            : ""}

                    </td>

                </tr>

            `;

        }).join("");

}


function applyInventoryFilters() {

    const searchInput =
        document.getElementById("invSearch");

    const deptFilter =
        document.getElementById("invDeptFilter");

    const statusFilter =
        document.getElementById("invStatusFilter");

    const panelSub =
        document.getElementById("invPanelSub");


    const searchTerm =
        searchInput
            ? searchInput.value
                .trim()
                .toLowerCase()
            : "";

    const department =
        deptFilter
            ? deptFilter.value
            : "all";

    const status =
        statusFilter
            ? statusFilter.value
            : "all";


    const filtered =
        inventoryMonitoringData.filter(item => {

            const matchesSearch =
                !searchTerm ||
                item.name
                    .toLowerCase()
                    .includes(searchTerm) ||
                item.sku
                    .toLowerCase()
                    .includes(searchTerm);

            const matchesDepartment =
                department === "all" ||
                item.department === department;

            const matchesStatus =
                status === "all" ||
                getStockStatus(item) === status;

            return (
                matchesSearch &&
                matchesDepartment &&
                matchesStatus
            );

        });


    if (panelSub) {

        const shown = [];
        if (status !== "all") shown.push(INV_STATUS_NAMES[status] || status);
        if (department !== "all") shown.push(department);
        if (searchTerm) shown.push(`"${searchTerm}"`);
        panelSub.innerHTML =
            `${filtered.length} SKU${
                filtered.length === 1 ? "" : "s"
            }` + (shown.length
                ? ` · Showing: <strong>${escapeHTML(shown.join(" · "))}</strong> <button type="button" class="inv-clear" data-act="inv-clear">Show all</button>`
                : " · Sorted by stock status");

    }

    syncInvKpiCards();

    renderStockLevelsTable(filtered);

}


function initInventoryMonitoring() {

    renderInventoryMonitoringStats(
        inventoryMonitoringData
    );

    applyInventoryFilters();


    const searchInput =
        document.getElementById("invSearch");

    const deptFilter =
        document.getElementById("invDeptFilter");

    const statusFilter =
        document.getElementById("invStatusFilter");


    if (searchInput) {
        searchInput.addEventListener(
            "input",
            applyInventoryFilters
        );
    }

    if (deptFilter) {
        deptFilter.addEventListener(
            "change",
            applyInventoryFilters
        );
    }

    if (statusFilter) {
        statusFilter.addEventListener(
            "change",
            applyInventoryFilters
        );
    }

}


/* =====================================================
   STOCK IN / OUT
===================================================== */

function updateMovementStockSummary() {

    const quantityInput =
        document.getElementById(
            "movementQuantity"
        );

    const currentEl =
        document.getElementById(
            "summaryCurrentStock"
        );

    const afterEl =
        document.getElementById(
            "summaryAfterStock"
        );


    if (currentEl) {
        currentEl.textContent = "—";
    }

    if (afterEl) {
        afterEl.textContent = "—";
    }

}


function initMovementForm() {

    const form =
        document.getElementById(
            "movementForm"
        );

    const quantityInput =
        document.getElementById(
            "movementQuantity"
        );

    const toggleGroup =
        document.getElementById(
            "movementTypeToggle"
        );

    const errorEl =
        document.getElementById(
            "movementFormError"
        );


    if (!form) {
        return;
    }


    if (quantityInput) {

        quantityInput.addEventListener(
            "input",
            updateMovementStockSummary
        );

    }


    if (toggleGroup) {

        toggleGroup
            .querySelectorAll(".seg-btn")
            .forEach(button => {

                button.addEventListener(
                    "click",
                    () => {

                        toggleGroup
                            .querySelectorAll(".seg-btn")
                            .forEach(btn => {
                                btn.classList.remove(
                                    "active"
                                );
                            });

                        button.classList.add(
                            "active"
                        );

                        updateMovementStockSummary();

                    }
                );

            });

    }


    form.addEventListener(
        "submit",
        event => {

            event.preventDefault();

            if (errorEl) {
                errorEl.classList.remove("show");
            }

            const product =
                document.getElementById(
                    "movementProduct"
                );

            const quantity =
                Number(
                    quantityInput
                        ? quantityInput.value
                        : 0
                );


            if (
                !product ||
                !product.value ||
                !quantity ||
                quantity <= 0
            ) {

                if (errorEl) {
                    errorEl.classList.add(
                        "show"
                    );
                }

                return;
            }



            inviteToast(
                "Stock movement form submitted. " +
                "hehe"
            );

        }
    );

}


function initStockInOut() {

    initMovementForm();


    const logSearch =
        document.getElementById("logSearch");

    const logTypeFilter =
        document.getElementById("logTypeFilter");


    if (logSearch) {

        logSearch.addEventListener(
            "input",
            () => {


            }
        );

    }


    if (logTypeFilter) {

        logTypeFilter.addEventListener(
            "change",
            () => {


            }
        );

    }

}


/* =====================================================
   PRODUCTS
   DISPLAY / SEARCH ONLY
===================================================== */

const productCatalogData = [

    {
        sku: "CS-HRC-3.0-1250",
            department: "Raw Materials",
            reorderLevel: 300000,
        name: "Hot Rolled Coil 3.0mm × 1250",
        grade: "S275JR",
        form: "Coil",
        category: "Carbon Steel",
        status: "ok",
        available: 394000,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.72,
        listPrice: 0.94,
        margin: 23.4,
        primarySource: "Rhein Stahl GmbH"
    },

    {
        sku: "SS-316L-SHT-2.0",
            department: "Raw Materials",
            reorderLevel: 60000,
        name: "Stainless Sheet 2.0mm 2B",
        grade: "316L",
        form: "Sheet",
        category: "Stainless Steel",
        status: "low",
        available: 53200,
        unit: "kg",
        costUnit: "kg",
        stdCost: 3.85,
        listPrice: 4.98,
        margin: 22.7,
        primarySource: "Kanto Alloy Works"
    },

    {
        sku: "AL-6061-BAR-40",
            department: "Raw Materials",
            reorderLevel: 80000,
        name: "Aluminium Round Bar 040",
        grade: "6061-T6",
        form: "Bar",
        category: "Aluminium",
        status: "ok",
        available: 115500,
        unit: "kg",
        costUnit: "kg",
        stdCost: 2.41,
        listPrice: 3.24,
        margin: 25.6,
        primarySource: "Northline Metals Ltd."
    },

    {
        sku: "CS-BIL-150SQ",
            department: "Raw Materials",
            reorderLevel: 40000,
        name: "Billet 150mm Square",
        grade: "C45",
        form: "Billet",
        category: "Carbon Steel",
        status: "low",
        available: 32000,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.68,
        listPrice: 0.86,
        margin: 20.9,
        primarySource: "Gulf Billet Trading"
    },

    {
        sku: "CU-C11000-TUB-25",
            department: "Raw Materials",
            reorderLevel: 12000,
        name: "Copper Tube Ø25 × 1.5",
        grade: "C11000",
        form: "Tube",
        category: "Copper Alloy",
        status: "low",
        available: 10550,
        unit: "kg",
        costUnit: "kg",
        stdCost: 8.62,
        listPrice: 11.40,
        margin: 24.4,
        primarySource: "Andes Copper Coop"
    },

    {
        sku: "CS-PLT-12-2000",
            department: "Raw Materials",
            reorderLevel: 500000,
        name: "Structural Plate 12mm × 2000",
        grade: "S355J2",
        form: "Plate",
        category: "Carbon Steel",
        status: "watch",
        available: 563500,
        unit: "kg",
        costUnit: "tonne",
        stdCost: 0.79,
        listPrice: 1.02,
        margin: 22.5,
        primarySource: "Rhein Stahl GmbH"
    },

    {
        sku: "SS-304-COIL-1.5",
            department: "Raw Materials",
            reorderLevel: 70000,
        name: "Stainless Coil 1.5mm",
        grade: "304",
        form: "Coil",
        category: "Stainless Steel",
        status: "low",
        available: 62700,
        unit: "kg",
        costUnit: "kg",
        stdCost: 3.12,
        listPrice: 4.05,
        margin: 23.0,
        primarySource: "Kanto Alloy Works"
    },

    {
        sku: "AL-5052-SHT-3.0",
            department: "Raw Materials",
            reorderLevel: 5000,
        name: "Aluminium Sheet 3.0mm",
        grade: "5052-H32",
        form: "Sheet",
        category: "Aluminium",
        status: "low",
        available: 2200,
        unit: "kg",
        costUnit: "kg",
        stdCost: 2.68,
        listPrice: 3.61,
        margin: 25.8,
        primarySource: "Northline Metals Ltd."
    }

];


let activeCatalogCategory =
    "All categories";

// Products page shows either the active products or the archived ones
let catalogView = "active";
const archivedProductData = [];

const catKey = (c) =>
    String(c || "Uncategorized").trim().replace(/\s+/g, " ").toLowerCase();

function currentCatalogList() {
    return catalogView === "archived"
        ? archivedProductData
        : productCatalogData;
}

// The Products page is filtered by DEPARTMENT only: Raw Materials, Finishing Supplies, Finished Goods (the category stays a column).
const CATALOG_DEPTS = ["Raw Materials", "Finishing Supplies", "Finished Goods"];
function getCatalogCategories() { return ["All categories", ...CATALOG_DEPTS]; }

function renderCategoryPills() {
    const container = document.getElementById("categoryPills");
    if (!container) return;
    const list = currentCatalogList();
    if (activeCatalogCategory !== "All categories" && !CATALOG_DEPTS.includes(activeCatalogCategory)) activeCatalogCategory = "All categories";
    container.innerHTML = "";
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Filter by department");
    getCatalogCategories().forEach(dept => {
        const isAll = dept === "All categories";
        const count = isAll ? list.length : list.filter(item => item.department === dept).length;
        const on = isAll ? activeCatalogCategory === "All categories" : activeCatalogCategory === dept;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill-btn" + (on ? " active" : "");
        button.setAttribute("aria-pressed", String(on));
        button.innerHTML = `${escapeHTML(isAll ? "All" : dept)}<span class="count">${count}</span>`;
        button.addEventListener("click", () => {
            activeCatalogCategory = dept;
            applyCatalogFilters();
        });
        container.appendChild(button);
    });
}

// Products table: one inline icon per department (no emojis), used in the name cell
const PRODUCT_DEPT_ICONS = {
    "Raw Materials": '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>',
    "Finishing Supplies": '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.7s6 6.1 6 10.6a6 6 0 0 1-12 0C6 8.8 12 2.7 12 2.7z"/><path d="M9.5 14a2.6 2.6 0 0 0 2.5 2.4"/></svg>',
    "Finished Goods": '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>'
};
const PRODUCT_DEPT_CLASS = { "Raw Materials": "dept-raw", "Finishing Supplies": "dept-fin", "Finished Goods": "dept-fg" };

function renderProductTable(items) {
    const tableBody = document.getElementById("productTableBody");
    if (!tableBody) return;
    const archivedView = catalogView === "archived";

    if (!items || items.length === 0) {
        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="8" class="pr-empty">
                    ${archivedView
                        ? "No archived products. Archive a product from its details and it will be kept here."
                        : "No products match your search or category."}
                </td>
            </tr>
        `;
        return;
    }

    tableBody.innerHTML = items.map(item => {
        const costLabel = "/" + (item.costUnit || item.unit || "kg");
        const metaLine = [item.grade, item.form].filter(Boolean).join(" · ");
        return `
            <tr class="product-row ${PRODUCT_DEPT_CLASS[item.department] || ""}${archivedView ? " is-archived" : ""}" data-sku="${escapeHTML(item.sku)}" tabindex="0" title="Click to view details, BOM, or edit">
                <td class="pt-name">
                    <div class="pr-name">
                        <span class="pr-ico">${PRODUCT_DEPT_ICONS[item.department] || PRODUCT_DEPT_ICONS["Finished Goods"]}</span>
                        <span class="pr-name-text">
                            <span class="supplier-name">${escapeHTML(item.name)}</span>
                            <span class="supplier-meta mono">${escapeHTML(item.sku)}${metaLine ? " · " + escapeHTML(metaLine) : ""}</span>
                        </span>
                    </div>
                </td>
                <td>
                    <div>${escapeHTML(item.category)}</div>
                    <div class="pr-dept">${escapeHTML(item.department || "\u2014")}</div>
                </td>
                <td class="pt-num${!archivedView && item.status === "low" ? " pr-low" : ""}"><b>${formatNumber(item.available)}</b> <span class="pr-unit">${escapeHTML(item.unit)}</span></td>
                <td class="pt-num dim">₱${item.stdCost.toFixed(2)}<span class="supplier-meta"> ${costLabel}</span></td>
                <td class="pt-num">
                    ${item.department === "Finished Goods"
                        ? (item.listPrice > 0 ? "₱" + item.listPrice.toFixed(2) : `<span class="prod-supplier warn" title="Finished Goods need a selling price">No price</span>`)
                        : `<span title="Not sold: only Finished Goods have a selling price">&mdash;</span>`}
                </td>
                <td>
                    ${item.department === "Finished Goods" && item.listPrice > 0
                        ? `<span class="margin-value pr-margin${item.margin < 0 ? " neg" : ""}">${item.margin.toFixed(1)}%</span>`
                        : `<span class="dim">&mdash;</span>`}
                </td>
                <td class="dim">${renderProductSuppliers(item)}</td>
                <td>
                    ${archivedView
                        ? `<span class="status-pill archived">Archived</span>`
                        : `<span class="status-pill ${item.status}">${getStockStatusLabel(item.status)}</span>`}
                </td>
            </tr>
        `;
    }).join("");
}

// Suppliers shown in the Products table: every supplier linked to the product, primary first.
function renderProductSuppliers(item) {

    const linked =
        Array.isArray(item.suppliers)
            ? item.suppliers
            : [];

    // older / sample records only carry a single supplier name
    if (!linked.length) {

        if (item.primarySource)
            return `<span class="prod-supplier">${escapeHTML(item.primarySource)}</span>`;

        // Raw Materials / Finishing Supplies are bought in, so a missing supplier is flagged.
        // Finished Goods are made by the company itself: no supplier, the source is in-house production.
        return (item.department === "Raw Materials" || item.department === "Finishing Supplies")
            ? `<span class="prod-supplier warn" title="Link a supplier in Supplier Management">No supplier yet</span>`
            : `<span class="prod-supplier inhouse" title="Made by the company, so no supplier is needed">In-house production</span>`;

    }

    const showPrimaryTag = linked.length > 1;

    return `<div class="prod-suppliers">${
        linked.map(s => {

            const archived = s.status === "archived";

            return `<span class="prod-supplier${archived ? " archived" : ""}">`
                + escapeHTML(s.name)
                + (s.primary && showPrimaryTag
                    ? ` <em class="prod-tag">Primary</em>`
                    : "")
                + (archived
                    ? ` <em class="prod-tag muted">Archived</em>`
                    : "")
                + `</span>`;

        }).join("")
    }</div>`;

}

function applyCatalogFilters() {
    const searchInput = document.getElementById("catalogSearch");
    const searchTerm = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const list = currentCatalogList();

    // keep the pills (and a possibly vanished active category) in step with the data
    renderCategoryPills();
    syncCatalogViewToggle();

    const filtered = list.filter(item => {
        const categoryMatch =
            activeCatalogCategory === "All categories" ||
            item.department === activeCatalogCategory;
        const searchMatch =
            !searchTerm ||
            item.name.toLowerCase().includes(searchTerm) ||
            item.sku.toLowerCase().includes(searchTerm) ||
            (item.grade || "").toLowerCase().includes(searchTerm) ||
            (item.category || "").toLowerCase().includes(searchTerm) ||
            (Array.isArray(item.suppliers) && item.suppliers.length
                ? item.suppliers
                : [{ name: item.primarySource || "" }])
                .some(sp => (sp.name || "").toLowerCase().includes(searchTerm));
        return categoryMatch && searchMatch;
    });

    const sub = document.getElementById("productListSub");
    if (sub) {
        sub.textContent =
            `${filtered.length} ${catalogView === "archived" ? "archived " : ""}product${filtered.length === 1 ? "" : "s"}`;
    }
    renderProductTable(filtered);
}

/* ---- Active / Archived switch ---- */
function syncCatalogViewToggle() {
    const box = document.getElementById("prodViewToggle");
    if (!box) return;
    const counts = { active: productCatalogData.length, archived: archivedProductData.length };
    box.querySelectorAll("[data-view]").forEach(b => {
        const on = b.dataset.view === catalogView;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        const c = b.querySelector(".count");
        if (c) c.textContent = counts[b.dataset.view];
    });
    const title = document.querySelector("#products .panel-title");
    if (title) title.textContent = catalogView === "archived" ? "Archived Products" : "Product Catalog";
    const btn = document.getElementById("newProductBtn");
    if (btn) btn.hidden = catalogView === "archived";
}

function initCatalogViewToggle() {
    const box = document.getElementById("prodViewToggle");
    if (!box || box.dataset.bound) return;
    box.dataset.bound = "1";
    box.addEventListener("click", e => {
        const b = e.target.closest("[data-view]");
        if (!b || b.dataset.view === catalogView) return;
        catalogView = b.dataset.view;
        activeCatalogCategory = "All categories";
        applyCatalogFilters();
    });
}

/* ---- Product details: click a row to see everything, then Edit or Archive ---- */
const PD_ICONS = {
    box: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"></path><path d="M3 8v8l9 5 9-5V8"></path><path d="M12 13v8"></path></svg>',
    edit: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>',
    archive: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
    restore: '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
};
let productDetailSku = null;

function findCatalogProduct(sku) {
    if (!sku) return null;
    const target = String(sku).trim().toUpperCase();
    return productCatalogData.find(p => String(p.sku || "").trim().toUpperCase() === target) ||
        archivedProductData.find(p => String(p.sku || "").trim().toUpperCase() === target) || null;
}

function ensureProductDetailModal() {
    let overlay = document.getElementById("productDetailOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "productDetailOverlay";
    overlay.innerHTML = `
        <div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="pdTitle">
            <button type="button" class="modal-close" id="pdClose" aria-label="Close">×</button>
            <div id="pdBody"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeProductDetails(); });
    overlay.querySelector("#pdClose").addEventListener("click", closeProductDetails);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && overlay.classList.contains("open")) closeProductDetails();
    });
    overlay.addEventListener("click", e => {
        const act = e.target.closest("[data-pd]");
        if (!act) return;
        const sku = productDetailSku;
        if (act.dataset.pd === "close") closeProductDetails();
        else if (act.dataset.pd === "edit") { closeProductDetails(); openNewProductModal(sku); }
        else if (act.dataset.pd === "archive") archiveProduct(sku);
        else if (act.dataset.pd === "restore") restoreProduct(sku);
    });
    return overlay;
}

function openProductDetails(sku) {
    const p = findCatalogProduct(sku);
    if (!p) return;
    const overlay = ensureProductDetailModal();
    productDetailSku = sku;
    const archived = !!p.archived || archivedProductData.some(x => x.sku === sku);
    const sells = p.department === "Finished Goods";
    const stockLabel = archived ? "Archived" : getStockStatusLabel(p.status);
    const stockClass = archived ? "archived" : p.status;
    const row = (label, value) =>
        `<div class="pd-row"><dt>${label}</dt><dd>${value}</dd></div>`;
    document.getElementById("pdBody").innerHTML = `
        <div class="supplier-modal-head">
            <div class="supplier-modal-icon">${PD_ICONS.box}</div>
            <div>
                <div class="modal-eyebrow">${escapeHTML(p.category || "Uncategorized")} · ${escapeHTML(p.department || "")}</div>
                <h2 class="modal-title" id="pdTitle" style="margin-bottom:0;">${escapeHTML(p.name)}</h2>
                <div class="pd-sub"><span class="mono">${escapeHTML(p.sku)}</span> <span class="status-pill ${stockClass}">${stockLabel}</span></div>
            </div>
        </div>
        ${archived ? `<div class="pd-note">This product is archived. It is hidden from stock lists, the shop, POS and production. Restore it to use it again.</div>` : ""}
        <dl class="pd-grid">
            ${row("Category", escapeHTML(p.category || "Uncategorized"))}
            ${row("Department", escapeHTML(p.department || "\u2014"))}
            ${row("In stock", `${formatNumber(p.available != null ? p.available : (p.onHand != null ? p.onHand : 0))} ${escapeHTML(p.unit || "")}`)}
            ${row("Reorder level", `${formatNumber(p.reorderLevel ?? 0)} ${escapeHTML(p.unit || "")}${p.reorderAuto ? " (automatic)" : ""}`)}
            ${row("Standard cost", `₱${(Number(p.stdCost != null ? p.stdCost : (p.unitCost != null ? p.unitCost : 0))).toFixed(2)} /${escapeHTML(p.costUnit || p.unit || "")}`)}
            ${row("Selling price", sells ? ((p.listPrice > 0) ? `₱${Number(p.listPrice).toFixed(2)}` : "Not set") : "Not sold")}
            ${row("Margin", sells && p.listPrice > 0 ? `${Number(p.margin != null ? p.margin : 0).toFixed(1)}%` : "\u2014")}
            ${row("Location", escapeHTML(p.location || "\u2014"))}
            ${p.grade || p.form ? row("Grade / form", escapeHTML([p.grade, p.form].filter(Boolean).join(" · "))) : ""}
            ${row("Source", renderProductSuppliers(p))}
        </dl>
        <div id="pdMaterials"></div>
        <div class="modal-actions pd-actions">
            <button type="button" class="btn-secondary" data-pd="close">Close</button>
            ${archived
                ? `<button type="button" class="btn-primary" data-pd="restore">${PD_ICONS.restore} Restore product</button>`
                : `<button type="button" class="btn-secondary pd-archive" data-pd="archive">${PD_ICONS.archive} Archive</button>
                   <button type="button" class="btn-primary" data-pd="edit">${PD_ICONS.edit} Edit</button>`}
        </div>`;
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (window.TripleEBom) window.TripleEBom.renderDetails(p);
}

function closeProductDetails() {
    const overlay = document.getElementById("productDetailOverlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    productDetailSku = null;
    if (!document.querySelector(".modal-overlay.open")) {
        document.body.style.overflow = "";
        document.documentElement.style.overflow = "";
    }
}

async function productAction(path, options, doneMessage) {
    const bridge = window.TripleEBridge;
    if (!bridge) return;
    try {
        await bridge.api(path, options);
        closeProductDetails();
        await bridge.reload();
        bridge.toast(doneMessage);
    } catch (e) {
        bridge.toast(e.message || "Something went wrong", "error");
    }
}

async function archiveProduct(sku) {
    const p = findCatalogProduct(sku);
    if (!p) return;
    const stock = p.available > 0 ? ` It still has ${formatNumber(p.available)} ${p.unit} in stock.` : "";
    if (!(await uiConfirm({ title: `Archive ${p.name}?`, message: `${p.sku} will be hidden from stock lists, the shop, POS and production.${stock} You can restore it from the Archived tab.`, confirm: "Archive", danger: true }))) return;
    productAction("/products/" + encodeURIComponent(sku), { method: "DELETE" }, "Product archived");
}

async function restoreProduct(sku) {
    const p = findCatalogProduct(sku);
    if (!p) return;
    if (!(await uiConfirm({ title: `Restore ${p.name}?`, message: `${p.sku} goes back to the stock lists, the shop, POS and production.`, confirm: "Restore" }))) return;
    productAction("/products/" + encodeURIComponent(sku) + "/restore", { method: "POST" }, "Product restored");
}

function initProductRowClicks() {
    const body = document.getElementById("productTableBody");
    if (!body || body.dataset.bound) return;
    body.dataset.bound = "1";
    body.addEventListener("click", e => {
        if (e.target.closest("button, a")) return;
        const tr = e.target.closest("tr.product-row");
        if (tr) openProductDetails(tr.dataset.sku);
    });
    body.addEventListener("keydown", e => {
        if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.product-row")) {
            e.preventDefault();
            openProductDetails(e.target.dataset.sku);
        }
    });
}

function initProductCatalog() {

    initNewProductModal();
    initCatalogViewToggle();
    initProductRowClicks();

    renderCategoryPills();

    applyCatalogFilters();


    const searchInput =
        document.getElementById(
            "catalogSearch"
        );

    if (searchInput) {

        searchInput.addEventListener(
            "input",
            applyCatalogFilters
        );

    }


    const newProductBtn =
        document.getElementById(
            "newProductBtn"
        );

    if (newProductBtn) {

        newProductBtn.addEventListener(
            "click",
            () => {

                openNewProductModal();

            }
        );

    }

}


/* =====================================================
   NEW PRODUCT MODAL
   fisplay
===================================================== */

let editingProductSku = null;


function openNewProductModal(
    productSku = null
) {

    const overlay =
        document.getElementById("newProductModalOverlay");

    if (!overlay) {
        return;
    }

    editingProductSku =
        productSku || null;

    const title =
        document.getElementById("newProductModalTitle");

    const saveButton =
        document.getElementById("newProductSaveBtn");

    const setValue = (id, value) => {

        const el =
            document.getElementById(id);

        if (el) {
            el.value = value;
        }

    };


    if (editingProductSku) {

        const product =
            productCatalogData.find(
                item => item.sku === editingProductSku
            );

        if (title) {
            title.textContent = "Edit product";
        }

        if (saveButton) {
            saveButton.textContent = "Save Changes";
        }

        if (product) {

            setValue("npSku", product.sku);
            setValue("npName", product.name);
            setValue("npDept", product.department || "Raw Materials");
            setValue("npCategory", product.category);
            setValue("npUnit", product.unit);
            setValue("npUnitCost", product.stdCost);
            if (window.MoneyInput) MoneyInput.set(document.getElementById("npUnitCost"), product.stdCost);
            setValue("npOnHand", product.available);
            setValue("npReorder", product.reorderLevel ?? "");
            setValue("npSource", product.primarySource);

        }

    } else {

        if (title) {
            title.textContent = "New product";
        }

        if (saveButton) {
            saveButton.textContent = "Save Product";
        }

    }

    overlay.classList.add("open");

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    const sku =
        document.getElementById("npSku");

    if (sku) {
        sku.focus();
    }

}


function closeNewProductModal() {

    const overlay =
        document.getElementById("newProductModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("newProductForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("newProductFormError");

    if (error) {
        error.classList.remove("show");
    }

    editingProductSku = null;

}


function initNewProductModal() {

    const overlay =
        document.getElementById("newProductModalOverlay");

    ["newProductCloseBtn", "newProductCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeNewProductModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeNewProductModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeNewProductModal();
        }

    });


    const form =
        document.getElementById("newProductForm");

    const error =
        document.getElementById("newProductFormError");

    if (form) {

        form.addEventListener("submit", event => {

            event.preventDefault();

            const textIds = [
                "npSku",
                "npName",
                "npCategory",
                "npUnit"
            ];

            const numberIds = [
                "npUnitCost",
                "npOnHand",
                "npReorder"
            ];

            const textsValid =
                textIds.every(id => {
                    const el = document.getElementById(id);
                    return el && el.value.trim();
                });

            const numbersValid =
                numberIds.every(id => {
                    const el = document.getElementById(id);
                    return (
                        el &&
                        el.value !== "" &&
                        Number(String(el.value).replace(/,/g, "")) >= 0
                    );
                });

            if (!textsValid || !numbersValid) {

                if (error) {
                    error.classList.add("show");
                }

                return;
            }

            if (error) {
                error.classList.remove("show");
            }
            inviteToast(
                editingProductSku
                    ? "Product changes hehe"
                    : "New product information hehe"
            );

            closeNewProductModal();

        });

    }

}


/* =====================================================
   SUPPLIERS
   temporary info
===================================================== */

const supplierData = [

    {
        id: "andes-copper",
        name: "Andes Copper Coop",
        initials: "AC",
        status: "active",
        location: "Warehouse C",
        contact: "Marisol Tan · +63 917 220 3391",
        supplies: "Brass Billet C36000, Copper Tube"
    },

    {
        id: "northline-metals",
        name: "Northline Metals Ltd.",
        initials: "NM",
        status: "active",
        location: "Warehouse B",
        contact: "R. Guevarra · +63 918 445 2210",
        supplies: "Zinc Alloy Zamak-3, Aluminium ADC-12"
    },

    {
        id: "rhein-stahl",
        name: "Rhein Stahl GmbH",
        initials: "RS",
        status: "active",
        location: "Mill Yard A",
        contact: "orders@rheinstahl.de",
        supplies: "Hot Rolled Coil, Structural Plate"
    },

    {
        id: "kanto-alloy",
        name: "Kanto Alloy Works",
        initials: "KA",
        status: "active",
        location: "Warehouse B",
        contact: "H. Suzuki · +81 3 5555 0192",
        supplies: "Stainless Sheet 2.0mm"
    },

    {
        id: "gulf-billet",
        name: "Gulf Billet Trading",
        initials: "GB",
        status: "active",
        location: "Mill Yard A",
        contact: "A. Al-Farsi · +971 4 220 8890",
        supplies: "Billet 150mm Square"
    },

    {
        id: "metro-chem",
        name: "Metro Chem Supplies",
        initials: "MC",
        status: "archived",
        location: "Storeroom",
        contact: "F. Villanueva · +63 927 110 4482",
        supplies: "Nickel Plating Salt"
    }

];


let activeWarehouseFilter =
    "All warehouses";

let editingSupplierId = null;


function getSupplierStatusLabel(status) {

    return status === "archived"
        ? "Archived"
        : "Active";

}


function getSupplierWarehouses() {

    const warehouses =
        ["All warehouses"];

    supplierData.forEach(
        supplier => {

            if (
                !warehouses.includes(
                    supplier.location
                )
            ) {

                warehouses.push(
                    supplier.location
                );

            }

        }
    );

    return warehouses;

}


/* ---- Supplier pills: All / Raw Materials / Finishing Supplies / Finished Goods / Archived ---- */
const SUPPLIER_PILLS = [
    { key: "all", label: "All" },
    { key: "Raw Materials", label: "Raw Materials" },
    { key: "Finishing Supplies", label: "Finishing Supplies" },
    { key: "Finished Goods", label: "Finished Goods" },
    { key: "archived", label: "Archived" }
];

let activeSupplierPill = "all";

function supplierDepartments(supplier) {
    const set = new Set();
    (supplier.products || []).forEach(p => {
        const item = (typeof productCatalogData !== "undefined" ? productCatalogData : [])
            .find(x => x.sku === p.sku);
        if (item && item.department) set.add(item.department);
    });
    return set;
}

function supplierInPill(supplier, key) {
    const archived = supplier.status === "archived";
    if (key === "archived") return archived;
    if (archived) return false;
    if (key === "all") return true;
    return supplierDepartments(supplier).has(key);
}

function supplierMatchesSearch(supplier, term) {
    if (!term) return true;
    const hay = [
        supplier.name,
        supplier.fullAddress || supplier.location,
        supplier.contact,
        supplier.supplies
    ].map(v => String(v || "").toLowerCase());
    return hay.some(v => v.includes(term));
}

function supplierMatchesLocation(supplier) {
    return activeWarehouseFilter === "All warehouses" ||
        supplier.location === activeWarehouseFilter;
}

function renderWarehousePills() {
    const container = document.getElementById("warehousePills");
    if (!container) return;

    const input = document.getElementById("supplierSearch");
    const term = input ? input.value.trim().toLowerCase() : "";
    const base = supplierData.filter(s => supplierMatchesLocation(s) && supplierMatchesSearch(s, term));

    container.innerHTML = SUPPLIER_PILLS.map(pill => {
        const count = base.filter(s => supplierInPill(s, pill.key)).length;
        return `<button type="button" class="pill-btn${pill.key === activeSupplierPill ? " active" : ""}"
                    data-pill="${escapeHTML(pill.key)}" aria-pressed="${pill.key === activeSupplierPill}">
                    ${escapeHTML(pill.label)}<span class="count">${count}</span>
                </button>`;
    }).join("");

    if (!container.dataset.bound) {
        container.dataset.bound = "1";
        container.addEventListener("click", e => {
            const b = e.target.closest("[data-pill]");
            if (!b) return;
            activeSupplierPill = b.dataset.pill;
            applySupplierFilters();
        });
    }
}

/* the dropdown beside the search box: filter by location */
function renderSupplierLocationSelect() {
    const sel = document.getElementById("supplierLocationFilter");
    if (!sel) return;
    const places = getSupplierWarehouses();
    if (!places.includes(activeWarehouseFilter)) activeWarehouseFilter = "All warehouses";
    sel.innerHTML = places.map(w =>
        `<option value="${escapeHTML(w)}"${w === activeWarehouseFilter ? " selected" : ""}>${w === "All warehouses" ? "All locations" : escapeHTML(w)}</option>`
    ).join("");
}


function renderSupplierTable(items) {

    const tableBody = document.getElementById("supplierTableBody");
    if (!tableBody) return;

    if (!items || items.length === 0) {
        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="5">No suppliers match these filters. Clear the search or pick another status.</td>
            </tr>`;
        return;
    }

    const PIN = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
    const MAX_CHIPS = 2;

    const contactHTML = raw => {
        const text = String(raw || "").trim();
        if (!text) return `<span class="sp-none">No contact</span>`;
        const parts = text.split("·").map(p => p.trim()).filter(Boolean);
        if (parts.length < 2) return `<div class="sp-contact"><span>${escapeHTML(parts[0])}</span></div>`;
        return `<div class="sp-contact"><b>${escapeHTML(parts[0])}</b><span>${escapeHTML(parts.slice(1).join(" · "))}</span></div>`;
    };

    const suppliesHTML = raw => {
        const list = String(raw || "").split(",").map(p => p.trim()).filter(Boolean);
        if (!list.length) return `<span class="sp-none">None linked yet</span>`;
        const shown = list.slice(0, MAX_CHIPS).map(n => `<span class="sp-chip" title="${escapeHTML(n)}">${escapeHTML(n)}</span>`).join("");
        const rest = list.slice(MAX_CHIPS);
        const more = rest.length ? `<span class="sp-chip more" title="${escapeHTML(rest.join(", "))}">+${rest.length}</span>` : "";
        return `<div class="sp-chips">${shown}${more}</div>`;
    };

    tableBody.innerHTML = items.map(supplier => `
        <tr class="supplier-row${supplier.status === "archived" ? " is-archived" : ""}"
            data-supplier-id="${escapeHTML(supplier.id)}" tabindex="0" title="Click to view details">
            <td>
                <div class="supplier-row-name">
                    <div class="supplier-avatar">${escapeHTML(supplier.initials)}</div>
                    <span class="sp-name">${escapeHTML(supplier.name)}</span>
                </div>
            </td>
            <td><div class="sp-loc">${PIN}<span>${escapeHTML(supplier.fullAddress || supplier.location)}</span></div></td>
            <td>${contactHTML(supplier.contact)}</td>
            <td>${suppliesHTML(supplier.supplies)}</td>
            <td><span class="status-pill ${supplier.status}">${getSupplierStatusLabel(supplier.status)}</span></td>
        </tr>
    `).join("");
}


function applySupplierFilters() {

    const searchInput = document.getElementById("supplierSearch");
    const countEl = document.getElementById("supplierCount");
    const term = searchInput ? searchInput.value.trim().toLowerCase() : "";

    renderSupplierLocationSelect();
    renderWarehousePills();

    const filtered = supplierData.filter(s =>
        supplierInPill(s, activeSupplierPill) &&
        supplierMatchesLocation(s) &&
        supplierMatchesSearch(s, term));

    if (countEl) {
        const label = activeSupplierPill === "archived" ? "archived supplier" : "supplier";
        countEl.textContent = `${filtered.length} ${label}${filtered.length === 1 ? "" : "s"}`;
    }

    const title = document.querySelector("#suppliers .panel-title");
    if (title) title.textContent = activeSupplierPill === "archived" ? "Archived Suppliers" : "Supplier List";

    renderSupplierTable(filtered);
}


/* ---- Supplier details: click a row to see everything, then Edit or Archive (same dialog as Products) ---- */
let supplierDetailId = null;

function ensureSupplierDetailModal() {
    let overlay = document.getElementById("supplierDetailOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "supplierDetailOverlay";
    overlay.innerHTML = `
        <div class="account-modal supplier-modal product-modal pd-modal" role="dialog" aria-modal="true" aria-labelledby="sdTitle">
            <button type="button" class="modal-close" id="sdClose" aria-label="Close">×</button>
            <div id="sdBody"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeSupplierDetails(); });
    overlay.querySelector("#sdClose").addEventListener("click", closeSupplierDetails);
    document.addEventListener("keydown", e => {
        if (e.key === "Escape" && overlay.classList.contains("open")) closeSupplierDetails();
    });
    overlay.addEventListener("click", e => {
        const act = e.target.closest("[data-sd]");
        if (!act) return;
        const id = supplierDetailId;
        if (act.dataset.sd === "close") closeSupplierDetails();
        else if (act.dataset.sd === "edit") { closeSupplierDetails(); openNewSupplierModal(id); }
        else if (act.dataset.sd === "archive") setSupplierStatus(id, "archived");
        else if (act.dataset.sd === "restore") setSupplierStatus(id, "active");
    });
    return overlay;
}

function renderSupplierProducts(supplier) {
    const list = supplier.products || [];
    if (!list.length) return supplier.supplies ? escapeHTML(supplier.supplies) : "None linked yet";
    return list.map(p => {
        const item = productCatalogData.find(x => x.sku === p.sku);
        const dept = item && item.department ? ` <span class="dim">· ${escapeHTML(item.department)}</span>` : "";
        return `<div>${escapeHTML(p.name)} <span class="mono dim">${escapeHTML(p.sku)}</span>${p.primary ? " (primary)" : ""}${dept}</div>`;
    }).join("");
}

function openSupplierDetails(id) {
    const s = supplierData.find(x => x.id === id);
    if (!s) return;
    const overlay = ensureSupplierDetailModal();
    supplierDetailId = id;
    const archived = s.status === "archived";
    const row = (label, value) => `<div class="pd-row"><dt>${label}</dt><dd>${value}</dd></div>`;
    const dash = v => v ? escapeHTML(v) : "\u2014";
    document.getElementById("sdBody").innerHTML = `
        <div class="supplier-modal-head">
            <div class="supplier-modal-icon">${PD_ICONS.box}</div>
            <div>
                <div class="modal-eyebrow">Supplier</div>
                <h2 class="modal-title" id="sdTitle" style="margin-bottom:0;">${escapeHTML(s.name)}</h2>
                <div class="pd-sub"><span class="status-pill ${archived ? "archived" : s.status}">${getSupplierStatusLabel(s.status)}</span></div>
            </div>
        </div>
        ${archived ? `<div class="pd-note">This supplier is archived. It is hidden from Stock In and the product supplier lists. Restore it to use it again.</div>` : ""}
        <dl class="pd-grid">
            ${row("Contact person", dash(s.contactPerson))}
            ${row("Phone", dash(s.phone))}
            ${row("Email", dash(s.email))}
            ${row("Location", dash(s.location))}
            ${row("Address", dash(s.fullAddress || s.address))}
            ${row("Supplies", renderSupplierProducts(s))}
        </dl>
        <div class="modal-actions pd-actions">
            <button type="button" class="btn-secondary" data-sd="close">Close</button>
            ${archived
                ? `<button type="button" class="btn-primary" data-sd="restore">${PD_ICONS.restore} Restore supplier</button>`
                : `<button type="button" class="btn-secondary pd-archive" data-sd="archive">${PD_ICONS.archive} Archive</button>
                   <button type="button" class="btn-primary" data-sd="edit">${PD_ICONS.edit} Edit</button>`}
        </div>`;
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
}

function closeSupplierDetails() {
    const overlay = document.getElementById("supplierDetailOverlay");
    if (!overlay) return;
    overlay.classList.remove("open");
    supplierDetailId = null;
    if (!document.querySelector(".modal-overlay.open")) {
        document.body.style.overflow = "";
        document.documentElement.style.overflow = "";
    }
}

async function setSupplierStatus(id, next) {
    const s = supplierData.find(x => x.id === id);
    const bridge = window.TripleEBridge;
    if (!s || !bridge) return;
    if (!(await uiConfirm({ title: (next === "archived" ? "Archive " : "Restore ") + s.name + "?", message: next === "archived" ? "The supplier is hidden from new purchase records. You can restore it later." : "The supplier can be used again.", confirm: next === "archived" ? "Archive" : "Restore", danger: next === "archived" }))) return;
    try {
        await bridge.api("/suppliers/" + encodeURIComponent(id) + "/status",
            { method: "PATCH", body: JSON.stringify({ status: next }) });
        closeSupplierDetails();
        await bridge.reload();
        bridge.toast("Supplier " + (next === "archived" ? "archived" : "restored"));
    } catch (e) {
        bridge.toast(e.message || "Something went wrong", "error");
    }
}

function initSupplierRowClicks() {
    const body = document.getElementById("supplierTableBody");
    if (!body || body.dataset.bound) return;
    body.dataset.bound = "1";
    body.addEventListener("click", e => {
        if (e.target.closest("button, a")) return;
        const tr = e.target.closest("tr.supplier-row");
        if (tr) openSupplierDetails(tr.dataset.supplierId);
    });
    body.addEventListener("keydown", e => {
        if ((e.key === "Enter" || e.key === " ") && e.target.matches("tr.supplier-row")) {
            e.preventDefault();
            openSupplierDetails(e.target.dataset.supplierId);
        }
    });
}


function initSuppliers() {

    applySupplierFilters();
    initSupplierRowClicks();

    const searchInput = document.getElementById("supplierSearch");
    if (searchInput) searchInput.addEventListener("input", applySupplierFilters);

    const locationSelect = document.getElementById("supplierLocationFilter");
    if (locationSelect) {
        locationSelect.addEventListener("change", () => {
            activeWarehouseFilter = locationSelect.value;
            applySupplierFilters();
        });
    }

    const onboardButton = document.getElementById("onboardSupplierBtn");
    if (onboardButton) onboardButton.addEventListener("click", () => openNewSupplierModal());

}


/* =====================================================
   SUPPLIER MODAL
===================================================== */

function openNewSupplierModal(
    supplierId = null
) {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    if (!overlay) {
        return;
    }

    editingSupplierId =
        supplierId || null;


    const title =
        document.getElementById(
            "newSupplierModalTitle"
        );

    const saveButton =
        document.getElementById(
            "newSupplierSaveBtn"
        );


    if (editingSupplierId) {

        const supplier =
            supplierData.find(
                item =>
                    item.id ===
                    editingSupplierId
            );

        if (title) {
            title.textContent =
                "Edit Supplier";
        }

        if (saveButton) {
            saveButton.textContent =
                "Save Changes";
        }


        if (supplier) {

            const name =
                document.getElementById(
                    "newSupplierName"
                );

            const contact =
                document.getElementById(
                    "newSupplierContact"
                );

            const products =
                document.getElementById(
                    "newSupplierProducts"
                );

            const location =
                document.getElementById(
                    "newSupplierLocation"
                );


            if (name) {
                name.value =
                    supplier.name;
            }

            if (contact) {
                contact.value =
                    supplier.contact;
            }

            if (products) {
                products.value =
                    supplier.supplies;
            }

            if (location) {
                location.value =
                    supplier.location;
            }

        }

    } else {

        if (title) {
            title.textContent =
                "New Supplier";
        }

        if (saveButton) {
            saveButton.textContent =
                "Save Supplier";
        }

    }


    overlay.classList.add("open");

    document.body.style.overflow =
        "hidden";

    document.documentElement.style.overflow =
        "hidden";

}


function closeNewSupplierModal() {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow =
        "";

    document.documentElement.style.overflow =
        "";


    const form =
        document.getElementById(
            "newSupplierForm"
        );

    if (form) {
        form.reset();
    }


    const error =
        document.getElementById(
            "newSupplierFormError"
        );

    if (error) {
        error.classList.remove(
            "show"
        );
    }

    editingSupplierId = null;

}


function initNewSupplierModal() {

    const overlay =
        document.getElementById(
            "newSupplierModalOverlay"
        );

    const closeButton =
        document.getElementById(
            "newSupplierCloseBtn"
        );

    const cancelButton =
        document.getElementById(
            "newSupplierCancelBtn"
        );

    const form =
        document.getElementById(
            "newSupplierForm"
        );

    const error =
        document.getElementById(
            "newSupplierFormError"
        );


    if (closeButton) {

        closeButton.addEventListener(
            "click",
            closeNewSupplierModal
        );

    }

    if (cancelButton) {

        cancelButton.addEventListener(
            "click",
            closeNewSupplierModal
        );

    }


    if (overlay) {

        overlay.addEventListener(
            "click",
            event => {

                if (
                    event.target === overlay
                ) {

                    closeNewSupplierModal();

                }

            }
        );

    }


    document.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Escape" &&
                overlay &&
                overlay.classList.contains(
                    "open"
                )
            ) {

                closeNewSupplierModal();

            }

        }
    );


    if (form) {

        form.addEventListener(
            "submit",
            event => {

                event.preventDefault();


                const name =
                    document.getElementById(
                        "newSupplierName"
                    );

                const contact =
                    document.getElementById(
                        "newSupplierContact"
                    );

                const products =
                    document.getElementById(
                        "newSupplierProducts"
                    );

                const location =
                    document.getElementById(
                        "newSupplierLocation"
                    );


                const valid =
                    name &&
                    contact &&
                    products &&
                    location &&
                    name.value.trim() &&
                    contact.value.trim() &&
                    products.value.trim() &&
                    location.value.trim();


                if (!valid) {

                    if (error) {
                        error.classList.add(
                            "show"
                        );
                    }

                    return;

                }


                if (error) {
                    error.classList.remove(
                        "show"
                    );
                }

                inviteToast(
                    editingSupplierId
                        ? "Supplier changes hehe."
                        : "New supplier information hehe"
                );

                closeNewSupplierModal();

            }
        );

    }

}


/* =====================================================
   REPORTS
===================================================== */

let reportPeriodType =
    "daily";

let reportAnchorDate =
    "2026-08-09";

let reportCustomFrom =
    "2026-08-03";

let reportCustomTo =
    "2026-08-09";


const REPORT_DEPARTMENT_COLORS = {

    "Raw Materials": "#4a90d9",

    "Finished Goods": "#43c47a",

    "Finishing Supplies": "#e35b9e"

};


const MONTH_NAMES = [

    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"

];


function parseDateParts(dateString) {

    const [
        year,
        month,
        day
    ] =
        dateString
            .split("-")
            .map(Number);

    return {
        year,
        month,
        day
    };

}


function addDaysToDateString(
    dateString,
    days
) {

    const date =
        new Date(
            `${dateString}T00:00:00Z`
        );

    date.setUTCDate(
        date.getUTCDate() + days
    );

    return date
        .toISOString()
        .split("T")[0];

}


function formatDisplayDate(
    dateString
) {

    const {
        year,
        month,
        day
    } =
        parseDateParts(dateString);

    return `${MONTH_NAMES[month - 1]} ${String(day).padStart(2, "0")}, ${year}`;

}


function renderReportPeriodPanel() {

    const dateNavRow =
        document.getElementById(
            "dateNavRow"
        );

    const customRangeRow =
        document.getElementById(
            "customRangeRow"
        );

    const showingPill =
        document.getElementById(
            "dateShowingPill"
        );


    const isCustom =
        reportPeriodType ===
        "custom";


    if (dateNavRow) {

        dateNavRow.style.display =
            isCustom
                ? "none"
                : "flex";

    }


    if (customRangeRow) {

        customRangeRow.style.display =
            isCustom
                ? "flex"
                : "none";

    }


    if (showingPill && !isCustom) {

        showingPill.textContent =
            `Showing ${formatDisplayDate(
                reportAnchorDate
            )}`;

    }

}


function initReports() {

    renderReportPeriodPanel();


    const periodToggle =
        document.getElementById(
            "reportPeriodToggle"
        );


    if (periodToggle) {

        periodToggle
            .querySelectorAll(
                ".period-btn"
            )
            .forEach(button => {

                button.addEventListener(
                    "click",
                    () => {

                        reportPeriodType =
                            button.dataset.period;

                        periodToggle
                            .querySelectorAll(
                                ".period-btn"
                            )
                            .forEach(btn => {
                                btn.classList.remove(
                                    "active"
                                );
                            });

                        button.classList.add(
                            "active"
                        );

                        renderReportPeriodPanel();

                    }
                );

            });

    }


    const prevButton =
        document.getElementById(
            "datePrevBtn"
        );

    if (prevButton) {

        prevButton.addEventListener(
            "click",
            () => {

                reportAnchorDate =
                    addDaysToDateString(
                        reportAnchorDate,
                        -1
                    );

                renderReportPeriodPanel();

            }
        );

    }


    const nextButton =
        document.getElementById(
            "dateNextBtn"
        );

    if (nextButton) {

        nextButton.addEventListener(
            "click",
            () => {

                reportAnchorDate =
                    addDaysToDateString(
                        reportAnchorDate,
                        1
                    );

                renderReportPeriodPanel();

            }
        );

    }


    const jumpLink =
        document.getElementById(
            "jumpLatestLink"
        );

    if (jumpLink) {

        jumpLink.addEventListener(
            "click",
            event => {

                event.preventDefault();

                reportAnchorDate =
                    "2026-08-09";

                renderReportPeriodPanel();

            }
        );

    }


    const printButton =
        document.getElementById(
            "printReportBtn"
        );

    if (printButton) {

        printButton.addEventListener(
            "click",
            () => {

            }
        );

    }


    const exportButton =
        document.getElementById(
            "exportCsvBtn"
        );

    if (exportButton) {

        exportButton.addEventListener(
            "click",
            () => {

            }
        );

    }

}


/* =====================================================
   USER MENU
===================================================== */

function initUserMenu() {

    const wrap =
        document.getElementById(
            "userMenuWrap"
        );

    const chipButton =
        document.getElementById(
            "userChipBtn"
        );

    const dropdown =
        document.getElementById(
            "userDropdown"
        );


    if (
        !wrap ||
        !chipButton ||
        !dropdown
    ) {
        return;
    }


    chipButton.addEventListener(
        "click",
        event => {

            event.stopPropagation();

            dropdown.classList.toggle(
                "open"
            );

        }
    );


    document.addEventListener(
        "click",
        event => {

            if (
                !wrap.contains(
                    event.target
                )
            ) {

                dropdown.classList.remove(
                    "open"
                );

            }

        }
    );


    document.addEventListener(
        "keydown",
        event => {

            if (event.key === "Escape") {

                dropdown.classList.remove(
                    "open"
                );

            }

        }
    );


    const profileButton =
        document.getElementById(
            "myProfileBtn"
        );

    if (profileButton) {

        profileButton.addEventListener(
            "click",
            () => {

                openAccountModal(
                    "profile"
                );

                dropdown.classList.remove(
                    "open"
                );

            }
        );

    }


    const passwordButton =
        document.getElementById(
            "changePasswordBtn"
        );

    if (passwordButton) {

        passwordButton.addEventListener(
            "click",
            () => {

                openAccountModal(
                    "password"
                );

                dropdown.classList.remove(
                    "open"
                );

            }
        );

    }


    const logoutButton =
        document.getElementById(
            "logoutBtn"
        );

    if (logoutButton) {

        logoutButton.addEventListener(
            "click",
            () => {

                /*
                    Frontend only.

                    The real logout/session
                    invalidation belongs to
                    authentication/backend.

                    For now this only returns
                    to the landing page.
                */

                window.location.href =
                    "LandingPage_Inventory-1.html";

            }
        );

    }

}


/* =====================================================
   ACCOUNT MODAL
===================================================== */

function openAccountModal(
    tab = "profile"
) {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.add("open");

    document.body.style.overflow =
        "hidden";

    document.documentElement.style.overflow =
        "hidden";

    switchAccountTab(tab);

}


function closeAccountModal() {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow =
        "";

    document.documentElement.style.overflow =
        "";

    if (window.passwordFlow) {
        window.passwordFlow.reset();
        updatePasswordChecklist();
    }

}


function switchAccountTab(tab) {

    document
        .querySelectorAll(".modal-tab")
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.tab === tab
            );

        });


    const profilePanel =
        document.getElementById(
            "profileTabPanel"
        );

    const passwordPanel =
        document.getElementById(
            "passwordTabPanel"
        );


    if (profilePanel) {

        profilePanel.classList.toggle(
            "active",
            tab === "profile"
        );

    }


    if (passwordPanel) {

        passwordPanel.classList.toggle(
            "active",
            tab === "password"
        );

    }

}


/* =====================================================
   PASSWORD STRENGTH
===================================================== */

function evaluatePasswordRules(
    password,
    confirmPassword
) {

    return {

        length:
            password.length >= 8,

        upper:
            /[A-Z]/.test(password),

        lower:
            /[a-z]/.test(password),

        number:
            /[0-9]/.test(password),

        special:
            /[!@#$%^&*()_\-+=\[\]{};:'",.<>\/?\\|`~]/
                .test(password),

        match:
            password.length > 0 &&
            password === confirmPassword

    };

}


function updatePasswordChecklist() {

    const passwordInput =
        document.getElementById(
            "newPasswordInput"
        );

    const confirmInput =
        document.getElementById(
            "confirmPasswordInput"
        );

    const strengthFill =
        document.getElementById(
            "strengthFill"
        );

    const strengthLabel =
        document.getElementById(
            "strengthLabel"
        );


    if (!passwordInput) {
        return;
    }


    const password =
        passwordInput.value;

    const confirmation =
        confirmInput
            ? confirmInput.value
            : "";


    const rules =
        evaluatePasswordRules(
            password,
            confirmation
        );


    document
        .querySelectorAll(
            ".checklist-item"
        )
        .forEach(item => {

            item.classList.toggle(
                "met",
                !!rules[item.dataset.rule]
            );

        });


    const strengthRules = [
        "length",
        "upper",
        "lower",
        "number",
        "special"
    ];


    const count =
        strengthRules.filter(
            rule => rules[rule]
        ).length;


    let percentage = 0;
    let label = "—";
    let color = "var(--red)";


    if (password.length > 0) {

        percentage =
            (count /
                strengthRules.length) *
            100;


        if (count <= 2) {

            label = "Weak";
            color = "var(--red)";

        } else if (count === 3) {

            label = "Fair";
            color = "var(--amber)";

        } else if (count === 4) {

            label = "Good";
            color = "var(--blue-bright)";

        } else {

            label = "Strong";
            color = "var(--green)";

        }

    }


    if (strengthFill) {

        strengthFill.style.width =
            `${percentage}%`;

        strengthFill.style.background =
            color;

    }


    if (strengthLabel) {

        strengthLabel.textContent =
            password.length > 0
                ? `Strength: ${label}`
                : "Strength: —";

    }

}


function initAccountModal() {

    const overlay =
        document.getElementById(
            "accountModalOverlay"
        );

    const closeButton =
        document.getElementById(
            "modalCloseBtn"
        );


    if (closeButton) {

        closeButton.addEventListener(
            "click",
            closeAccountModal
        );

    }


    if (overlay) {

        overlay.addEventListener(
            "click",
            event => {

                if (
                    event.target === overlay
                ) {

                    closeAccountModal();

                }

            }
        );

    }


    document.addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Escape" &&
                overlay &&
                overlay.classList.contains(
                    "open"
                )
            ) {

                closeAccountModal();

            }

        }
    );


    document
        .querySelectorAll(".modal-tab")
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    switchAccountTab(
                        button.dataset.tab
                    );

                }
            );

        });


    const newPassword =
        document.getElementById(
            "newPasswordInput"
        );

    const confirmPassword =
        document.getElementById(
            "confirmPasswordInput"
        );


    if (newPassword) {

        newPassword.addEventListener(
            "input",
            updatePasswordChecklist
        );

    }


    if (confirmPassword) {

        confirmPassword.addEventListener(
            "input",
            updatePasswordChecklist
        );

    }


    const profileCancel =
        document.getElementById(
            "profileCancelBtn"
        );

    if (profileCancel) {

        profileCancel.addEventListener(
            "click",
            closeAccountModal
        );

    }


    /* Save Changes for the profile is handled in api-bridge.js (real database save) */


    const passwordCancel =
        document.getElementById(
            "passwordCancelBtn"
        );

    if (passwordCancel) {

        passwordCancel.addEventListener(
            "click",
            closeAccountModal
        );

    }


    /* Change password: the SAME flow for every role (password-change.js).
       current password typed + checked first -> new password -> a code to the email AND a code to the mobile number -> saved */
    const updatePassword =
        document.getElementById("updatePasswordBtn");

    if (updatePassword && window.PasswordChange) {

        const cur = document.getElementById("currentPasswordInput");
        const nw = document.getElementById("newPasswordInput");
        const conf = document.getElementById("confirmPasswordInput");
        const err = document.getElementById("passwordFormError");

        const setError = (el, message) => {
            el.classList.add("field-invalid");
            clearError(el);
            const m = document.createElement("div");
            m.className = "pc-msg";
            m.style.cssText = "font-size:12.5px;color:var(--red,#c0392b);margin-top:5px";
            m.textContent = message;
            el.insertAdjacentElement("afterend", m);
        };
        const clearError = (el) => {
            el.classList.remove("field-invalid");
            const n = el.nextElementSibling;
            if (n && n.classList.contains("pc-msg")) n.remove();
        };

        window.passwordFlow = PasswordChange.create({
            cur, nw, conf,
            saveBtn: updatePassword,
            otpMount: document.getElementById("passwordOtpMount"),
            api: async (path, options) => {
                const res = await fetch("/api" + path, Object.assign({
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" }
                }, options));
                if (res.status === 401) {
                    window.location.href = "Login_Inventory.html";
                    throw new Error("Not signed in");
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { fields: data.fields, status: res.status });
                return data;
            },
            rulesMet: () => Object.values(evaluatePasswordRules(nw.value, conf.value)).every(Boolean),
            setError, clearError,
            banner: (msg) => {
                if (!err) return;
                if (!msg) { err.classList.remove("show"); return; }
                err.textContent = msg;
                err.classList.add("show");
            },
            toast: (msg) => inviteToast(msg),
            onDone: () => { closeAccountModal(); updatePasswordChecklist(); }
        });

    }

    updatePasswordChecklist();

}


/* =====================================================
   DISPATCH
===================================================== */

const dispatchProductsData = [

    {
        sku: "FG-BF-ELB",
        name: 'Brass Forged Elbow 3/4"',
        onHand: 380,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-DC-COVR",
        name: "Die-Cast Gearbox Cover 441",
        onHand: 3080,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-MC-SHFT",
        name: "Machined Drive Shaft 88mm",
        onHand: 1760,
        unit: "pcs",
        qcStatus: "passed"
    },

    {
        sku: "FG-MC-FLNG",
        name: "Machined Flange 160mm",
        onHand: 220,
        unit: "pcs",
        qcStatus: "passed"
    }

];


let selectedDispatchSku =
    "FG-BF-ELB";


function getDispatchStatusLabel(
    status
) {

    if (status === "passed") {
        return "Passed";
    }

    if (status === "rework") {
        return "Rework";
    }

    return "Pending";

}


function renderFinishedGoodList() {

    const container =
        document.getElementById(
            "finishedGoodList"
        );

    if (!container) {
        return;
    }


    container.innerHTML =
        dispatchProductsData
            .map(product => {

                const passed =
                    product.qcStatus ===
                    "passed";

                const selected =
                    product.sku ===
                    selectedDispatchSku;


                return `

                    <div
                        class="finished-good-item
                        ${selected ? "selected" : ""}
                        ${passed ? "" : "disabled"}"
                        data-sku="${escapeHTML(
                            product.sku
                        )}"
                    >

                        <div>

                            <div class="fg-item-name">
                                ${escapeHTML(
                                    product.name
                                )}
                            </div>

                            <div class="fg-item-sku">
                                ${escapeHTML(
                                    product.sku
                                )}
                            </div>

                        </div>

                        <div class="fg-item-right">

                            <span
                                class="fg-status-pill ${product.qcStatus}"
                            >
                                ${getDispatchStatusLabel(
                                    product.qcStatus
                                )}
                            </span>

                            <span class="fg-qty">

                                ${
                                    passed
                                        ? `${formatNumber(
                                            product.onHand
                                        )} ${escapeHTML(
                                            product.unit
                                        )}`
                                        : "not available"
                                }

                            </span>

                        </div>

                    </div>

                `;

            })
            .join("");


    container
        .querySelectorAll(
            ".finished-good-item"
        )
        .forEach(item => {

            if (
                item.classList.contains(
                    "disabled"
                )
            ) {
                return;
            }


            item.addEventListener(
                "click",
                () => {

                    selectedDispatchSku =
                        item.dataset.sku;

                    renderFinishedGoodList();

                }
            );

        });

}


function initDispatch() {

    renderFinishedGoodList();


    const saveButton =
        document.getElementById(
            "saveDispatchBtn"
        );

    const error =
        document.getElementById(
            "dispatchFormError"
        );


    if (saveButton) {

        saveButton.addEventListener(
            "click",
            event => {

                event.preventDefault();

                const qty =
                    document.getElementById(
                        "dispatchQty"
                    );

                const customer =
                    document.getElementById(
                        "dispatchCustomer"
                    );

                const poRef =
                    document.getElementById(
                        "dispatchPoRef"
                    );


                const valid =
                    qty &&
                    Number(qty.value) > 0 &&
                    customer &&
                    customer.value.trim() &&
                    poRef &&
                    poRef.value.trim();


                if (!valid) {

                    if (error) {
                        error.classList.add(
                            "show"
                        );
                    }

                    return;

                }


                if (error) {
                    error.classList.remove(
                        "show"
                    );
                }

                inviteToast(
                    "Dispatch form ha wala"
                );

            }
        );

    }

}


/* =====================================================
   DASHBOARD BUTTONS
===================================================== */

function initDashboardButtons() {

    const recordMovement =
        document.getElementById(
            "recordMovementBtn"
        );

    if (recordMovement) {

        recordMovement.addEventListener(
            "click",
            () => navigateToPage(
                "stockflow"
            )
        );

    }


    const fullInventory =
        document.getElementById(
            "viewFullInventoryBtn"
        );

    if (fullInventory) {

        fullInventory.addEventListener(
            "click",
            () => navigateToPage(
                "inventory"
            )
        );

    }


    document
        .querySelectorAll(".action-btn")
        .forEach(button => {

            button.addEventListener(
                "click",
                () => {

                    const text =
                        button.textContent
                            .trim();


                    if (
                        text.includes(
                            "Record Movement"
                        )
                    ) {

                        navigateToPage(
                            "stockflow"
                        );

                        return;

                    }


                    inviteToast(
                        `${text} is hehe`
                    );

                }
            );

        });

}


/* =====================================================
   USER MANAGEMENT
===================================================== */

const userAccountsData = [

    {
        name: "Meland G. Dilodilo",
        username: "mdilodilo",
        email: "mdilodilo@triplee-metal.com",
        role: "Cashier",
        roleKey: "Cashier",
        status: "active",
        lastLogin: "2026-08-16 08:02 AM"
    },

    {
        name: "Lourdes L. Alanunay",
        username: "lalanunay",
        email: "lalanunay@triplee-metal.com",
        role: "Finance-Admin Officer",
        roleKey: "finance",
        status: "active",
        lastLogin: "2026-08-16 07:14 AM"
    }

];

const pendingInvitesData = [];
let accountView = "current";
let accountReloadVersion = 0;


function getInitials(name) {

    return name
        .split(" ")
        .filter(Boolean)
        .map(part => part[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();

}


/* Milliseconds of the user's last sign-in (0 = never). Uses the exact time from the server, else reads "YYYY-MM-DD hh:mm AM". */
function userLoginTime(user) {
    if (user && typeof user.lastLoginAt === "number") return user.lastLoginAt * 1000;
    const m = String((user && user.lastLogin) || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return 0;
    let h = Number(m[4]) % 12;
    if (/pm/i.test(m[6] || "")) h += 12;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5])).getTime();
}

function renderAccountsTable() {

    const tableBody =
        document.getElementById("accountsTableBody");

    const count =
        document.getElementById("accountCount");

    if (!tableBody) {
        return;
    }

    // Deleted accounts have their own view; ordinary counts and filters use current accounts.
    const viewUsers = userAccountsData.filter(u => !!u.deletedAt === (accountView === "deleted"));
    document.querySelectorAll("#accountViewToggle [data-view]").forEach(button => {
        const selected = button.dataset.view === accountView;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.querySelector(".count").textContent = String(userAccountsData.filter(u => !!u.deletedAt === (button.dataset.view === "deleted")).length);
    });
    const staffCount = viewUsers.filter(u => u.roleKey !== "customer").length;
    const custCount = viewUsers.length - staffCount;
    if (count) count.textContent = `${staffCount} staff \u00B7 ${custCount} customer${custCount === 1 ? "" : "s"}`;

    const roleSel = document.getElementById("accountRoleFilter");
    const roleWanted = roleSel ? roleSel.value : "all";
    // status filter: active accounts, or disabled ones (anything that is not active cannot sign in)
    const statusSel = document.getElementById("accountStatusFilter");
    const statusWanted = statusSel && accountView !== "deleted" ? statusSel.value : "all";
    if (statusSel) statusSel.hidden = accountView === "deleted";
    const isActive = (u) => u.status === "active";
    if (statusSel) {
        const act = viewUsers.filter(isActive).length, dis = viewUsers.length - act;
        statusSel.options[0].textContent = `All statuses (${viewUsers.length})`;
        statusSel.options[1].textContent = `Active accounts (${act})`;
        statusSel.options[2].textContent = `Disabled accounts (${dis})`;
    }
    const visible = userAccountsData
        .map((user, index) => ({ user, index }))
        .filter(x => !!x.user.deletedAt === (accountView === "deleted"))
        .filter(x => roleWanted === "all" || (roleWanted === "staff" ? x.user.roleKey !== "customer" : x.user.roleKey === roleWanted))
        .filter(x => statusWanted === "all" || (statusWanted === "active" ? isActive(x.user) : !isActive(x.user)))
        // latest sign-in on top; accounts that have never signed in go to the bottom (then by name)
        .sort((a, b) => (userLoginTime(b.user) - userLoginTime(a.user)) ||
            String(a.user.name || "").localeCompare(String(b.user.name || "")));

    if (count && (roleWanted !== "all" || statusWanted !== "all")) {
        count.textContent = `${visible.length} of ${viewUsers.length} accounts`;
    }

    if (visible.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="5">${accountView === "deleted" ? "No deleted accounts match this filter." : statusWanted === "disabled" ? "No disabled accounts." : statusWanted === "active" ? "No active accounts match this filter." : "No accounts found."}</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        visible.map(({ user, index }) => `

            <tr class="user-row" data-index="${index}" style="cursor:pointer">

                <td>
                    <div class="user-row-name">
                        <div class="user-row-avatar">
                            ${escapeHTML(getInitials(user.name))}
                            ${user.hasAvatar ? `<img class="user-row-photo" src="/api/users/${encodeURIComponent(user.id)}/avatar" alt="" loading="lazy" decoding="async">` : ""}
                        </div>
                        ${escapeHTML(user.name)}
                    </div>
                </td>

                <td class="dim">
                    ${escapeHTML(user.email || "")}
                </td>

                <td>
                    <span class="role-tag ${user.roleKey === "cashier" ? "cashier" : user.roleKey === "customer" ? "customer" : ""}">
                        ${escapeHTML(user.role)}
                    </span>
                </td>

                <td>
                    <span class="status-pill ${user.status}">
                        ${user.deletedAt ? "Deleted" : user.status === "active" ? "Active" : "Disabled"}
                    </span>
                </td>

                <td class="dim">
                    ${escapeHTML(user.lastLogin)}
                </td>

            </tr>

        `).join("");

    tableBody
        .querySelectorAll("tr.user-row")
        .forEach(row => {
            row.addEventListener("click", () => {
                openEditUserModal(Number(row.dataset.index));
            });
        });

}

function inviteToast(message, isError) {

    const el = document.createElement("div");
    el.className = "app-toast" + (isError ? " error" : "");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);

}


async function inviteApi(path, options) {

    const res = await fetch("/api/invitations" + path, Object.assign({
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" }
    }, options));

    if (res.status === 401) {
        window.location.href = "Login_Inventory.html";
        throw new Error("Not signed in");
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw Object.assign(
            new Error(data.error || "Request failed"),
            { fields: data.fields }
        );
    }

    return data;

}


async function loadPendingInvites() {

    try {
        const rows = await inviteApi("");
        pendingInvitesData.splice(0, pendingInvitesData.length, ...rows);
    } catch (err) {
        console.warn("[invites] could not load:", err.message);
    }

    renderPendingInvites();

}


function renderPendingInvites() {

    const tableBody =
        document.getElementById("pendingInvitesTableBody");

    if (!tableBody) {
        return;
    }

    if (pendingInvitesData.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="6">No pending invitations.</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        pendingInvitesData.map(invite => `

            <tr>
                <td>${escapeHTML(invite.name)}</td>
                <td class="dim">${escapeHTML(invite.email)}</td>
                <td class="dim">${escapeHTML(invite.role)}</td>
                <td class="dim">${escapeHTML(invite.sent)}</td>
                <td>
                    <span class="status-pill ${invite.status === "expired" ? "out" : "watch"}">${invite.status === "expired" ? "Expired" : "Pending"}</span>
                </td>
                <td>
                    <button type="button" class="btn-secondary btn-sm" data-invite-resend="${Number(invite.id)}">
                        Resend
                    </button>
                    <button type="button" class="btn-secondary btn-sm" data-invite-cancel="${Number(invite.id)}">
                        Cancel
                    </button>
                </td>
            </tr>

        `).join("");

}


async function handleInviteAction(event) {

    const resend = event.target.closest("[data-invite-resend]");
    const cancel = event.target.closest("[data-invite-cancel]");
    const button = resend || cancel;

    if (!button) {
        return;
    }

    const id = button.dataset.inviteResend || button.dataset.inviteCancel;
    const invite = pendingInvitesData.find(i => String(i.id) === String(id));

    if (cancel && !(await uiConfirm({ title: "Cancel this invitation?", message: "The link sent to " + (invite ? invite.email : "this person") + " will stop working.", confirm: "Cancel invitation", cancel: "Keep it", danger: true }))) {
        return;
    }

    button.disabled = true;

    try {

        if (resend) {
            const r = await inviteApi("/" + id + "/resend", { method: "POST" });
            inviteToast(r.emailSent ? "A new sign-up link was emailed." : r.message, !r.emailSent);
        } else {
            await inviteApi("/" + id, { method: "DELETE" });
            inviteToast("Invitation cancelled.");
        }

    } catch (err) {
        inviteToast(err.message, true);
    }

    await loadPendingInvites();
    await reloadUserAccounts();

}


function openInviteUserModal() {

    const overlay =
        document.getElementById("inviteUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.add("open");

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

}


function closeInviteUserModal() {

    const overlay =
        document.getElementById("inviteUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("inviteUserForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("inviteUserFormError");

    if (error) {
        error.classList.remove("show");
    }

}


async function reloadUserAccounts(showSpinner) {
    const version = ++accountReloadVersion;
    const tableBody = document.getElementById("accountsTableBody");
    if (showSpinner && tableBody && userAccountsData.length === 0) {
        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="5" class="dim">Loading accounts...</td>
            </tr>
        `;
    }
    try {
        const [res, deletedRes] = await Promise.all([fetch("/api/users", {
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
        }), fetch("/api/users?deleted=1", { credentials: "same-origin", headers: { "Accept": "application/json" } })]);
        if (version !== accountReloadVersion) return;
        if (res.status === 401) return;
        if (!res.ok || !deletedRes.ok) throw new Error("Could not load accounts");
        {
            const [data, deleted] = await Promise.all([res.json(), deletedRes.json()]);
            if (version !== accountReloadVersion) return;
            if (Array.isArray(data) && Array.isArray(deleted)) {
                userAccountsData.splice(0, userAccountsData.length, ...data, ...deleted);
                renderAccountsTable();
            }
        }
    } catch (err) {
        console.warn("[users] could not reload accounts:", err.message);
        inviteToast("Could not refresh accounts. Try Refresh again.", true);
    }
    if (typeof loadPendingInvites === "function") {
        loadPendingInvites().catch(() => {});
    }
}
window.reloadUserAccounts = reloadUserAccounts;

function initUserManagement() {

    renderAccountsTable();
    renderPendingInvites();
    loadPendingInvites();
    reloadUserAccounts(false);
    initEditUserModal();
    document.querySelectorAll("#accountViewToggle [data-view]").forEach(button => {
        button.addEventListener("click", () => {
            accountView = button.dataset.view;
            renderAccountsTable();
        });
    });

    const accountRoleFilter = document.getElementById("accountRoleFilter");
    if (accountRoleFilter) accountRoleFilter.addEventListener("change", renderAccountsTable);
    const accountStatusFilter = document.getElementById("accountStatusFilter");
    if (accountStatusFilter) accountStatusFilter.addEventListener("change", renderAccountsTable);

    const pendingBody =
        document.getElementById("pendingInvitesTableBody");

    if (pendingBody) {
        pendingBody.addEventListener("click", handleInviteAction);
    }


    const inviteButton =
        document.getElementById("inviteUserBtn");

    if (inviteButton) {
        inviteButton.addEventListener(
            "click",
            openInviteUserModal
        );
        const actions = inviteButton.parentElement;
        if (actions && !document.getElementById("accountRefreshBtn")) {
            const refreshBtn = document.createElement("button");
            refreshBtn.type = "button";
            refreshBtn.id = "accountRefreshBtn";
            refreshBtn.className = "btn-secondary";
            refreshBtn.textContent = "Refresh";
            refreshBtn.title = "Reload user and customer accounts list";
            refreshBtn.addEventListener("click", () => {
                const orig = refreshBtn.textContent;
                refreshBtn.disabled = true;
                refreshBtn.textContent = "Refreshing...";
                reloadUserAccounts(true).finally(() => {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = orig;
                });
            });
            actions.insertBefore(refreshBtn, inviteButton.nextSibling);
        }
    }

    document.querySelectorAll('[data-page="usermgmt"]').forEach(b => {
        b.addEventListener("click", () => reloadUserAccounts(false));
    });

    const userPage = document.getElementById("usermgmt");
    if (userPage) {
        let wasActive = userPage.classList.contains("active-page");
        if (wasActive) reloadUserAccounts(false);
        new MutationObserver(() => {
            const on = userPage.classList.contains("active-page");
            if (on && !wasActive) reloadUserAccounts(false);
            wasActive = on;
        }).observe(userPage, { attributes: true, attributeFilter: ["class"] });
    }

    window.addEventListener("focus", () => {
        const up = document.getElementById("usermgmt");
        if (up && up.classList.contains("active-page")) reloadUserAccounts(false);
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            const up = document.getElementById("usermgmt");
            if (up && up.classList.contains("active-page")) reloadUserAccounts(false);
        }
    });

    setInterval(() => {
        const up = document.getElementById("usermgmt");
        if (up && up.classList.contains("active-page") && document.visibilityState === "visible") {
            reloadUserAccounts(false);
        }
    }, 10000);


    const overlay =
        document.getElementById("inviteUserModalOverlay");

    ["inviteUserCloseBtn", "inviteUserCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeInviteUserModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeInviteUserModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeInviteUserModal();
        }

    });


    const form =
        document.getElementById("inviteUserForm");

    const error =
        document.getElementById("inviteUserFormError");

    if (form) {

        form.addEventListener("submit", async event => {

            event.preventDefault();

            const name =
                document.getElementById("inviteName");

            const email =
                document.getElementById("inviteEmail");

            const role =
                document.getElementById("inviteRole");

            if (
                !name.value.trim() ||
                !email.value.trim()
            ) {

                if (error) {
                    error.textContent = "All fields are required.";
                    error.classList.add("show");
                }

                return;
            }

            if (error) {
                error.classList.remove("show");
            }

            const submit = form.querySelector('button[type="submit"]');
            submit.disabled = true;

            try {

                const r = await inviteApi("", {
                    method: "POST",
                    body: JSON.stringify({
                        name: name.value,
                        email: email.value,
                        role: role.value
                    })
                });

                closeInviteUserModal();

                inviteToast(
                    r.emailSent
                        ? "Invitation sent to " + email.value.trim() + "."
                        : r.message,
                    !r.emailSent
                );

                await loadPendingInvites();
                await reloadUserAccounts();

            } catch (err) {

                if (error) {
                    error.textContent = err.message;
                    error.classList.add("show");
                }

            } finally {
                submit.disabled = false;
            }

        });

    }

}


/* =====================================================
   EDIT USER MODAL
===================================================== */

let editingUserId = null;
let editUserMounted = false;
let editUserLoaded = false;


function openEditUserModal(index) {

    const overlay = document.getElementById("editUserModalOverlay");
    const user = userAccountsData[index];
    if (!overlay || !user) return;
    editingUserId = user.id;

    // Finance does not edit personal information: the details are shown read-only, only the role can change
    const isCust = user.roleKey === "customer";
    const canChange = !isCust && !user.isYou && !user.deletedAt;
    const role = document.getElementById("editUserRole");
    const info = document.getElementById("editUserInfo");
    const title = document.getElementById("editUserTitle");
    const saveBtn = document.querySelector("#editUserForm [type=\"submit\"]");
    const err = document.getElementById("editUserFormError");
    if (title) title.textContent = canChange ? "Change role" : "Account details";
    if (saveBtn) { saveBtn.style.display = canChange ? "" : "none"; saveBtn.disabled = true; saveBtn.textContent = "Save role"; }
    if (err) err.classList.remove("show");
    editUserLoaded = false;

    const row = (k, v) => `<div class="eu-row"><dt>${k}</dt><dd>${v ? escapeHTML(v) : '<span class="dim">\u2014</span>'}</dd></div>`;
    if (info) info.innerHTML = '<p class="dim">Loading\u2026</p>';
    fetch("/api/users/" + user.id + "/profile", { credentials: "same-origin" })
        .then(async res => {
            const d = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(d.error || "Could not load this account");
            if (editingUserId !== user.id) return;
            const born = d.birthdate ? new Date(d.birthdate + "T00:00:00").toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric" }) : "";
            if (info) info.innerHTML = '<dl class="eu-grid">' +
                row("Name", d.name) + row("Email", d.email) + row("Mobile", d.phone) +
                row("Status", user.deletedAt ? "Deleted" : d.status === "active" ? "Active" : "Disabled") +
                (user.deletedAt ? row("Deleted", new Date(user.deletedAt).toLocaleString("en-PH")) : "") + row("Birthdate", born) + row("Gender", d.gender) +
                (isCust ? row("Company", d.companyName) + row("Position", d.companyPosition) + row("TIN", d.companyTin) : "") + '</dl>';
            editUserLoaded = true;
            if (saveBtn) saveBtn.disabled = !canChange;
        })
        .catch(e => { if (err) { err.textContent = e.message; err.classList.add("show"); } if (info) info.innerHTML = ""; });

    if (role) {
        // a customer stays a customer; staff can only be Finance-Admin or Cashier; nobody changes their own role
        role.querySelectorAll("option").forEach(o => { o.hidden = o.disabled = isCust ? o.value !== "Customer" : o.value === "Customer"; });
        role.value = isCust ? "Customer" : user.roleKey === "cashier" ? "Cashier" : "Finance-Admin Officer";
        role.disabled = !canChange;
        role.title = isCust ? "A customer account stays a customer" : user.isYou ? "Another Finance-Admin has to change your role" : "";
    }

    let statusBtn = document.getElementById("editUserStatusBtn");
    if (!statusBtn) {
        statusBtn = document.createElement("button");
        statusBtn.type = "button";
        statusBtn.id = "editUserStatusBtn";
        const footer = overlay.querySelector(".modal-footer");
        if (footer) footer.insertBefore(statusBtn, footer.firstChild);
    }
    if (user.isYou || user.deletedAt) {
        statusBtn.style.display = "none";
    } else {
        statusBtn.style.display = "";
        statusBtn.textContent = user.status === "active" ? "Disable account" : "Enable account";
        statusBtn.className = user.status === "active" ? "btn-danger-sm" : "btn-secondary";
        statusBtn.onclick = async () => {
            const next = user.status === "active" ? "disabled" : "active";
            if (!(await uiConfirm({
                title: `${next === "disabled" ? "Disable" : "Re-enable"} ${user.name}?`,
                message: next === "disabled"
                    ? (user.roleKey === "finance"
                        ? "This Finance-Admin is signed out right away and cannot sign in until another Finance-Admin re-enables the account."
                        : "They are signed out right away and cannot sign in until the account is re-enabled.")
                    : "They will be able to sign in again.",
                confirm: next === "disabled" ? "Disable" : "Re-enable",
                danger: next === "disabled"
            }))) return;

            try {
                const res = await fetch("/api/users/" + user.id + "/status", {
                    method: "PATCH",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ status: next })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || "Request failed");
                user.status = next;
                renderAccountsTable();
                inviteToast(`${user.name} ${next === "disabled" ? "disabled" : "re-enabled"}`);
                closeEditUserModal();
            } catch (err) {
                inviteToast(err.message, true);
            }
        };
    }

    let deleteBtn = document.getElementById("editUserDeleteBtn");
    if (!deleteBtn) {
        deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.id = "editUserDeleteBtn";
        overlay.querySelector(".modal-footer").prepend(deleteBtn);
    }
    deleteBtn.hidden = !!user.isYou;
    deleteBtn.disabled = false;
    deleteBtn.className = user.deletedAt ? "btn-secondary" : "btn-danger-sm";
    deleteBtn.textContent = user.deletedAt ? "Restore account" : "Delete account";
    deleteBtn.onclick = async () => {
        const restore = !!user.deletedAt;
        deleteBtn.disabled = true;
        try {
            if (!(await uiConfirm({
                title: `${restore ? "Restore" : "Delete"} ${user.name}?`,
                message: restore
                    ? "The account returns to the accounts list as disabled. Enable it separately to allow sign-in again."
                    : "The account moves to Deleted and all sessions end. Orders, payments and audit history are kept. You can restore the account later.",
                confirm: restore ? "Restore" : "Delete account", danger: !restore
            }))) return;
            const res = await fetch("/api/users/" + user.id + (restore ? "/restore" : ""), {
                method: restore ? "POST" : "DELETE", credentials: "same-origin",
                headers: { "Content-Type": "application/json" }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((data.fields && data.fields.id) || data.error || "Request failed");
            closeEditUserModal();
            await reloadUserAccounts(false);
            inviteToast(user.name + (restore ? " restored as disabled" : " moved to Deleted"));
        } catch (e) { inviteToast(e.message, true); }
        finally { deleteBtn.disabled = false; }
    };

    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
}


function closeEditUserModal() {

    const overlay =
        document.getElementById("editUserModalOverlay");

    if (!overlay) {
        return;
    }

    overlay.classList.remove("open");

    document.body.style.overflow = "";
    document.documentElement.style.overflow = "";

    const form =
        document.getElementById("editUserForm");

    if (form) {
        form.reset();
    }

    const error =
        document.getElementById("editUserFormError");

    if (error) {
        error.classList.remove("show");
    }

    editingUserId = null;

}


function initEditUserModal() {

    const overlay =
        document.getElementById("editUserModalOverlay");

    ["editUserCloseBtn", "editUserCancelBtn"]
        .forEach(id => {

            const button =
                document.getElementById(id);

            if (button) {
                button.addEventListener(
                    "click",
                    closeEditUserModal
                );
            }

        });

    if (overlay) {

        overlay.addEventListener("click", event => {

            if (event.target === overlay) {
                closeEditUserModal();
            }

        });

    }

    document.addEventListener("keydown", event => {

        if (
            event.key === "Escape" &&
            overlay &&
            overlay.classList.contains("open")
        ) {
            closeEditUserModal();
        }

    });


    const form =
        document.getElementById("editUserForm");

    const error =
        document.getElementById("editUserFormError");

    if (form) {

        form.addEventListener("submit", event => {

            event.preventDefault();

            const user = userAccountsData.find(u => u.id === editingUserId);

            if (!user || !editUserLoaded) {
                return;
            }

            const isCust = user.roleKey === "customer";
            if (isCust || user.isYou || user.deletedAt) return;                       // nothing Finance can change here
            if (error) error.classList.remove("show");
            const roleSel = document.getElementById("editUserRole");
            const roleKey = roleSel.value === "Cashier" ? "cashier" : "finance";
            const submitBtn = form.querySelector('[type="submit"]');
            if (roleKey === user.roleKey) { closeEditUserModal(); return; }
            if (submitBtn) submitBtn.disabled = true;
            const body = { roleKey };                               // role only: personal details are never sent

            fetch("/api/users/" + user.id, {
                method: "PATCH",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            })
                .then(async res => {
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { fields: data.fields });
                    user.roleKey = roleKey;
                    user.role = roleKey === "finance" ? "Finance-Admin Officer"
                        : roleKey === "cashier" ? "Sales Staff / Cashier" : "Customer";
                    closeEditUserModal();
                    renderAccountsTable();
                    inviteToast(user.name + " is now " + user.role + ".");
                })
                .catch(err => {
                    if (error) {
                        err.message = (err.fields && (err.fields.role || err.fields.id)) || err.message;
                        error.textContent = err.message;
                        error.classList.add("show");
                    } else {
                        inviteToast(err.message, true);
                    }
                })
                .finally(() => { if (submitBtn) submitBtn.disabled = false; });

        });

    }

}


/* =====================================================
   AUDIT LOG
===================================================== */

const auditLogData = [

    {
        timestamp: "2026-08-16 07:14 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Login",
        detail: "Successful login"
    },

    {
        timestamp: "2026-08-16 07:16 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Stock In — MV-8841, Brass Billet C36000, +1,800 kg"
    },

    {
        timestamp: "2026-08-15 04:40 PM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record edited",
        detail: "Product updated — Machined Drive Shaft 88mm, reorder level changed 450 to 500"
    },

    {
        timestamp: "2026-08-15 09:00 AM",
        user: "Meland G. Dilodilo",
        role: "Cashier",
        action: "Login",
        detail: "Successful login"
    },

    {
        timestamp: "2026-08-14 02:22 PM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Dispatch — PO-2213, Die-Cast Gearbox Cover 441, 140 pcs"
    },

    {
        timestamp: "2026-08-13 11:08 AM",
        user: "Lourdes L. Alanunay",
        role: "Finance-Admin",
        action: "Record added",
        detail: "Stock Out — MV-8836, Die-Cast Mounting Bracket, -540 pcs"
    },

    {
        timestamp: "2026-08-12 05:30 PM",
        user: "Meland G. Dilodilo",
        role: "Cashier",
        action: "Account created",
        detail: "New Finance-Admin account provisioned for L. Alanunay"
    }

];


function getAuditActionClass(action) {

    switch (action) {
        case "Login":                 return "login";
        case "Logout":                return "logout";
        case "Record added":          return "added";
        case "Record edited":         return "edited";
        case "Record deleted":        return "deleted";
        case "Account created":       return "account";
        case "Cash shift":            return "cashshift";
        case "Return":                return "return";
        case "Profile updated":       return "profile";
        case "Production recorded":
        case "Material requirements": return "production";
        case "Quote decision":
        case "Price override approved": return "approval";
        case "Price override refused": return "deleted";
        default:
            return /^cost/i.test(String(action)) ? "cost" : "";
    }

}

/* "2026-08-16 07:14 AM" -> { date: "Aug 16, 2026", time: "07:14 AM" } (falls back to the raw text) */
function splitAuditStamp(stamp) {
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/.exec(String(stamp || "").trim());
    if (!m) return { date: String(stamp || ""), time: "" };
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[2]) - 1] || m[2];
    return { date: mon + " " + Number(m[3]) + ", " + m[1], time: m[4] };
}

function auditInitials(name) {
    const parts = String(name || "?").replace(/[^A-Za-z\s]/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}


function applyAuditFilters() {

    const roleFilter =
        document.getElementById("auditRoleFilter");

    const actionFilter =
        document.getElementById("auditActionFilter");

    const searchInput =
        document.getElementById("auditSearch");

    const countEl =
        document.getElementById("auditCount");

    const tableBody =
        document.getElementById("auditTableBody");

    if (!tableBody) {
        return;
    }

    const role =
        roleFilter ? roleFilter.value : "all";

    const action =
        actionFilter ? actionFilter.value : "all";

    const term =
        searchInput
            ? searchInput.value.trim().toLowerCase()
            : "";


    const filtered =
        auditLogData.filter(entry => {

            const roleMatch =
                role === "all" || String(entry.role || "").toLowerCase().includes(role.toLowerCase());

            const actionMatch =
                action === "all" || entry.action === action;

            const searchMatch =
                !term ||
                String(entry.user || "").toLowerCase().includes(term) ||
                String(entry.action || "").toLowerCase().includes(term) ||
                String(entry.detail || "").toLowerCase().includes(term);

            return roleMatch && actionMatch && searchMatch;

        });


    if (countEl) {
        countEl.textContent =
            `${filtered.length} of ${auditLogData.length} entries`;
    }

    if (filtered.length === 0) {

        tableBody.innerHTML = `
            <tr class="no-results-row">
                <td colspan="5">No log entries match your filters.</td>
            </tr>
        `;

        return;
    }

    tableBody.innerHTML =
        filtered.map(entry => {

            const when = splitAuditStamp(entry.timestamp);
            const roleClass = /cashier/i.test(entry.role) ? "cashier" : /customer/i.test(entry.role) ? "customer" : "";

            return `
            <tr>
                <td class="au-when">
                    <span class="au-date">${escapeHTML(when.date)}</span>
                    <span class="au-time">${escapeHTML(when.time)}</span>
                </td>
                <td>
                    <div class="au-person">
                        <span class="au-avatar" aria-hidden="true">${escapeHTML(auditInitials(entry.user))}</span>
                        <span class="au-name">${escapeHTML(entry.user)}</span>
                    </div>
                </td>
                <td>
                    <span class="role-tag ${roleClass}">${escapeHTML(entry.role)}</span>
                </td>
                <td>
                    <span class="action-tag ${getAuditActionClass(entry.action)}">${escapeHTML(entry.action)}</span>
                </td>
                <td class="audit-detail">${escapeHTML(entry.detail)}</td>
            </tr>`;

        }).join("");

}


function initAuditLog() {

    applyAuditFilters();

    const roleFilter =
        document.getElementById("auditRoleFilter");

    const actionFilter =
        document.getElementById("auditActionFilter");

    const searchInput =
        document.getElementById("auditSearch");

    if (roleFilter) {
        roleFilter.addEventListener("change", applyAuditFilters);
    }

    if (actionFilter) {
        actionFilter.addEventListener("change", applyAuditFilters);
    }

    if (searchInput) {
        searchInput.addEventListener("input", applyAuditFilters);
    }

}


/* =====================================================
   INITIALIZATION
===================================================== */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        function safeInit(
            name,
            callback
        ) {

            try {

                callback();

            } catch (error) {

                console.error(
                    `UI initialization failed: ${name}`,
                    error
                );

            }

        }


        safeInit(
            "navigation",
            initNavigation
        );

        safeInit(
            "dashboard",
            loadDashboard
        );

        safeInit(
            "dashboard buttons",
            initDashboardButtons
        );

        safeInit(
            "inventory monitoring",
            initInventoryMonitoring
        );

        safeInit(
            "stock in/out",
            initStockInOut
        );

        safeInit(
            "products",
            initProductCatalog
        );

        safeInit(
            "suppliers",
            initSuppliers
        );

        safeInit(
            "supplier modal",
            initNewSupplierModal
        );

        safeInit(
            "reports",
            initReports
        );

        safeInit(
            "user menu",
            initUserMenu
        );

        safeInit(
            "account modal",
            initAccountModal
        );

        safeInit(
            "dispatch",
            initDispatch
        );

        safeInit(
            "user management",
            initUserManagement
        );

        safeInit(
            "audit log",
            initAuditLog
        );

    }
);