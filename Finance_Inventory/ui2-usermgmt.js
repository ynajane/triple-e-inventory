/* ui2-usermgmt.js — fills the four summary cards on the User Management page.
   Display only: it reads the same lists script.js already loads (userAccountsData,
   pendingInvitesData) and never changes them. */
(function () {
    "use strict";

    function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

    function update() {
        var users = [], invites = [];
        try { if (typeof userAccountsData !== "undefined" && Array.isArray(userAccountsData)) users = userAccountsData.filter(function (u) { return !u.deletedAt; }); } catch (e) {}
        try { if (typeof pendingInvitesData !== "undefined" && Array.isArray(pendingInvitesData)) invites = pendingInvitesData; } catch (e) {}

        var staff = users.filter(function (u) { return u.roleKey !== "customer"; }).length;
        var customers = users.length - staff;
        var active = users.filter(function (u) { return u.status === "active"; }).length;
        var expired = invites.filter(function (i) { return i.status === "expired"; }).length;

        setText("umKpiTotal", String(users.length));
        setText("umKpiTotalFoot", active + " active \u00B7 " + (users.length - active) + " disabled");
        setText("umKpiStaff", String(staff));
        setText("umKpiStaffFoot", "Finance-Admin and cashier accounts");
        setText("umKpiCustomers", String(customers));
        setText("umKpiCustomersFoot", "Online shop sign-ups");
        setText("umKpiPending", String(invites.length));
        setText("umKpiPendingFoot", invites.length
            ? plural(expired, "invite", "invites") + " expired"
            : "No one waiting to sign up");
    }

    function start() {
        update();
        ["accountsTableBody", "pendingInvitesTableBody"].forEach(function (id) {
            var body = document.getElementById(id);
            if (body) new MutationObserver(update).observe(body, { childList: true });
        });
        setTimeout(update, 800);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
