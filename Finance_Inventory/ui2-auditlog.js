/* ui2-auditlog.js — dresses the Audit Log page: summary strip, "latest" chip, role switch,
   action chips, and the timeline details of each row (day label, bold lead of the detail).
   Display only: it reads auditLogData (already loaded by script.js / api-bridge.js) and never
   changes it. Filtering is still done by script.js: the role switch and the chips just set the
   two original <select> boxes (#auditRoleFilter, #auditActionFilter) and fire their "change". */
(function () {
    "use strict";

    var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var ICON_CLEAR = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

    function el(id) { return document.getElementById(id); }
    function setText(id, text) { var n = el(id); if (n && n.textContent !== text) n.textContent = text; }
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    function setClass(node, name, on) { if (node.classList.contains(name) !== on) node.classList.toggle(name, on); }
    function setAttr(node, name, value) { if (node.getAttribute(name) !== value) node.setAttribute(name, value); }

    function data() {
        try { if (typeof auditLogData !== "undefined" && Array.isArray(auditLogData)) return auditLogData; } catch (e) {}
        return [];
    }

    function todayKey() {
        var d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    /* "2026-08-16 07:14 AM" -> milliseconds (NaN when the text is not in that shape) */
    function stampMs(stamp) {
        var m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(stamp || "").trim());
        if (!m) return NaN;
        var h = Number(m[4]);
        if (m[6]) { h = h % 12; if (/pm/i.test(m[6])) h += 12; }
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, Number(m[5])).getTime();
    }

    function prettyStamp(stamp) {
        var m = /^(\d{4})-(\d{2})-(\d{2})\s+(.+)$/.exec(String(stamp || ""));
        return m ? MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + ", " + m[4] : String(stamp || "");
    }

    /* "Aug 16, 2026" -> Today / Yesterday / "Aug 16" / "Aug 16, 2025" */
    function dayLabel(text) {
        var m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/.exec(text);
        var mi = m ? MONTHS.indexOf(m[1]) : -1;
        if (mi < 0) return text;
        var then = new Date(Number(m[3]), mi, Number(m[2]));
        var now = new Date(); now.setHours(0, 0, 0, 0);
        var diff = Math.round((now - then) / 864e5);
        if (diff === 0) return "Today";
        if (diff === 1) return "Yesterday";
        return m[1] + " " + Number(m[2]) + (then.getFullYear() === now.getFullYear() ? "" : ", " + m[3]);
    }

    function kindOf(action) {
        try { if (typeof getAuditActionClass === "function") return getAuditActionClass(action) || ""; } catch (e) {}
        return "";
    }

    /* ---------- the original Action filter: keep it in step with the actions that really exist ---------- */
    var lastActions = "";
    function syncActionFilter(rows) {
        var sel = el("auditActionFilter");
        if (!sel) return;
        var seen = {};
        rows.forEach(function (r) { if (r.action) seen[r.action] = true; });
        var base = ["Login", "Logout", "Record added", "Record edited", "Account created", "Cash shift", "Return"];
        base.forEach(function (a) { seen[a] = true; });
        var list = Object.keys(seen).sort(function (a, b) {
            var ia = base.indexOf(a), ib = base.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            return a.localeCompare(b);
        });
        var key = list.join("|");
        if (key === lastActions) return;
        lastActions = key;
        var keep = sel.value;
        sel.innerHTML = "";
        var all = document.createElement("option");
        all.value = "all"; all.textContent = "All actions";
        sel.appendChild(all);
        list.forEach(function (a) {
            var o = document.createElement("option");
            o.value = a; o.textContent = a;
            sel.appendChild(o);
        });
        sel.value = list.indexOf(keep) !== -1 ? keep : "all";
    }

    /* ---------- role switch + action chips ---------- */
    var tools = null;   // { seg, chips, reset, roleSel, actSel, search, chipKey }

    function fire(node, type) { node.dispatchEvent(new Event(type, { bubbles: true })); }

    function button(cls, text) {
        var b = document.createElement("button");
        b.type = "button"; b.className = cls; b.textContent = text;
        return b;
    }

    function buildTools() {
        var page = el("auditlog");
        var roleSel = el("auditRoleFilter"), actSel = el("auditActionFilter"), search = el("auditSearch");
        var wrapper = page && page.querySelector(".table-wrapper");
        if (!page || !roleSel || !actSel || !wrapper || tools) return;

        var bar = document.createElement("div");
        bar.className = "au-tools";

        var seg = document.createElement("div");
        seg.className = "au-seg"; seg.setAttribute("role", "group"); seg.setAttribute("aria-label", "Filter by role");
        Array.prototype.forEach.call(roleSel.options, function (o) {
            var b = button("au-seg-btn", o.textContent);
            b.dataset.v = o.value;
            seg.appendChild(b);
        });

        var chips = document.createElement("div");
        chips.className = "au-chips"; chips.setAttribute("role", "group"); chips.setAttribute("aria-label", "Filter by action");

        var reset = document.createElement("button");
        reset.type = "button"; reset.className = "au-reset"; reset.hidden = true;
        reset.innerHTML = ICON_CLEAR + "<span>Clear filters</span>";

        bar.appendChild(chips); bar.appendChild(reset);
        wrapper.parentNode.insertBefore(bar, wrapper);
        var filters = page.querySelector(".inv-filters");                  // role switch sits beside the search box
        if (filters) filters.insertBefore(seg, filters.firstChild); else bar.insertBefore(seg, bar.firstChild);

        seg.addEventListener("click", function (e) {
            var b = e.target.closest(".au-seg-btn");
            if (!b || roleSel.value === b.dataset.v) return;
            roleSel.value = b.dataset.v; fire(roleSel, "change");
        });
        chips.addEventListener("click", function (e) {
            var b = e.target.closest(".au-chip");
            if (!b || actSel.value === b.dataset.v) return;
            actSel.value = b.dataset.v; fire(actSel, "change");
        });
        reset.addEventListener("click", function () {
            if (search) search.value = "";
            roleSel.value = "all"; actSel.value = "all";
            fire(search || roleSel, search ? "input" : "change");   // one event is enough: the page reads all three boxes
        });

        [roleSel, actSel].forEach(function (s) { s.setAttribute("tabindex", "-1"); s.setAttribute("aria-hidden", "true"); });
        tools = { seg: seg, chips: chips, reset: reset, roleSel: roleSel, actSel: actSel, search: search, chipKey: "" };
        page.classList.add("au-js");

        [roleSel, actSel].forEach(function (s) { s.addEventListener("change", refreshTools); });
        if (search) search.addEventListener("input", refreshTools);
    }

    function refreshTools() {
        if (!tools) return;
        var rows = data(), cur = tools.actSel.value;

        var counts = {};
        rows.forEach(function (r) { if (r.action) counts[r.action] = (counts[r.action] || 0) + 1; });
        var order = Array.prototype.map.call(tools.actSel.options, function (o) { return o.value; });
        var names = Object.keys(counts).sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
        if (cur !== "all" && !counts[cur]) names.push(cur);          // keep the active chip even if it has no entries

        var key = rows.length + "#" + names.map(function (n) { return n + ":" + (counts[n] || 0); }).join("|");
        if (key !== tools.chipKey) {
            tools.chipKey = key;
            tools.chips.innerHTML = "";
            var all = document.createElement("button");
            all.type = "button"; all.className = "au-chip is-all"; all.dataset.v = "all";
            all.innerHTML = "<span>All</span><span class=\"au-n\">" + rows.length + "</span>";
            tools.chips.appendChild(all);
            names.forEach(function (n) {
                var b = document.createElement("button");
                b.type = "button"; b.className = "au-chip " + kindOf(n); b.dataset.v = n;
                var t = document.createElement("span"); t.textContent = n;
                var c = document.createElement("span"); c.className = "au-n"; c.textContent = String(counts[n] || 0);
                b.appendChild(t); b.appendChild(c);
                tools.chips.appendChild(b);
            });
        }

        Array.prototype.forEach.call(tools.chips.children, function (b) { setAttr(b, "aria-pressed", String(b.dataset.v === cur)); });
        Array.prototype.forEach.call(tools.seg.children, function (b) { setAttr(b, "aria-pressed", String(b.dataset.v === tools.roleSel.value)); });

        var filtered = (tools.search && tools.search.value.trim()) || tools.roleSel.value !== "all" || cur !== "all";
        tools.reset.hidden = !filtered;
    }

    /* ---------- the feed rows ---------- */
    function decorateRows() {
        var body = el("auditTableBody");
        if (!body) return;
        var table = body.closest("table");
        if (table) {
            setAttr(table, "role", "table"); setAttr(body, "role", "rowgroup");
            if (table.tHead) {
                setAttr(table.tHead, "role", "rowgroup");
                Array.prototype.forEach.call(table.tHead.rows, function (r) {
                    setAttr(r, "role", "row");
                    Array.prototype.forEach.call(r.cells, function (c) { setAttr(c, "role", "columnheader"); });
                });
            }
        }

        var total = data().length, prev = null;
        Array.prototype.forEach.call(body.rows, function (tr) {
            setAttr(tr, "role", "row");
            Array.prototype.forEach.call(tr.cells, function (td) { setAttr(td, "role", "cell"); });

            if (tr.classList.contains("no-results-row")) {
                var cell = tr.cells[0];
                var msg = total ? "No log entries match your filters." : "No activity has been recorded yet.";
                if (cell && cell.textContent !== msg) cell.textContent = msg;
                return;
            }

            /* the lead of a detail ("Stock In — MV-8841 …") in bold; the text itself is unchanged */
            var det = tr.querySelector(".audit-detail");
            if (det && !det.dataset.auSplit) {
                det.dataset.auSplit = "1";
                var txt = det.textContent, i = txt.indexOf(" \u2014 ");
                if (i > 0) {
                    det.textContent = "";
                    var lead = document.createElement("strong");
                    lead.textContent = txt.slice(0, i);
                    det.appendChild(lead);
                    det.appendChild(document.createTextNode(txt.slice(i)));
                }
            }

            if (tr.classList.contains("pg-hide")) return;      // other pages of the pager: leave them alone

            /* day label on the first visible row of each day; later rows of that day show the time only */
            var dateEl = tr.querySelector(".au-date");
            if (!dateEl) return;
            if (!dateEl.dataset.orig) dateEl.dataset.orig = dateEl.textContent;
            var orig = dateEl.dataset.orig, label = dayLabel(orig);
            if (dateEl.textContent !== label) { dateEl.textContent = label; dateEl.title = orig; }
            setClass(dateEl, "is-today", label === "Today");
            setClass(tr, "au-same-day", prev === orig);
            setClass(tr, "au-newday", prev !== orig);
            prev = orig;
        });
    }

    /* ---------- summary strip + chip ---------- */
    function update() {
        var rows = data();
        var today = todayKey();

        var todayRows = rows.filter(function (r) { return String(r.timestamp || "").indexOf(today) === 0; });
        var people = {};
        rows.forEach(function (r) { if (r.user) people[r.user] = true; });
        var peopleToday = {};
        todayRows.forEach(function (r) { if (r.user) peopleToday[r.user] = true; });
        var changes = rows.filter(function (r) { return /^Record (added|edited|deleted)$/.test(r.action || ""); });
        var logins = todayRows.filter(function (r) { return r.action === "Login"; }).length;

        /* the newest entry, whatever order the rows arrive in */
        var latest = null, best = -Infinity;
        rows.forEach(function (r) { var t = stampMs(r.timestamp); if (!isNaN(t) && t > best) { best = t; latest = r; } });
        if (!latest && rows.length) latest = rows[0];

        setText("auKpiTotal", String(rows.length));
        setText("auKpiTotalFoot", rows.length ? "All recorded activity" : "No activity recorded yet");
        setText("auKpiToday", String(todayRows.length));
        setText("auKpiTodayFoot", todayRows.length ? plural(logins, "sign-in", "sign-ins") + " today" : "Nothing logged today");
        setText("auKpiPeople", String(Object.keys(people).length));
        setText("auKpiPeopleFoot", plural(Object.keys(peopleToday).length, "person", "people") + " active today");
        setText("auKpiChanges", String(changes.length));
        setText("auKpiChangesFoot", "Records added, edited or deleted");

        setText("auditLatest", latest ? "Latest: " + prettyStamp(latest.timestamp) : "Waiting for activity");
        syncActionFilter(rows);
        buildTools();
        refreshTools();
        decorateRows();
    }

    function start() {
        update();
        var body = el("auditTableBody");
        if (body) {
            new MutationObserver(update).observe(body, { childList: true });                        // the page redrew the rows
            new MutationObserver(decorateRows).observe(body, { attributes: true, attributeFilter: ["class"], subtree: true });   // the pager moved to another page
        }
        setTimeout(update, 800);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();