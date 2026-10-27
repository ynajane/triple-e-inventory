/* shop-extras-admin.js — Finance Admin screens for the online shop extras:
     Quote Requests   customers ask for a price on bulk orders / custom sizes; Finance replies or closes the request
     Product Reviews  verified-purchase reviews; Finance can hide an inappropriate review (and restore it)
   Needs the two pages (#quotes, #reviews) and the two menu items that Finance_Inventory.html already contains.
   Load it after refund-admin.js:   <script src="shop-extras-admin.js?v=1"></script>
   Server routes (backend/shop-extras.js): GET /api/finance/quotes · POST /api/finance/quotes/:no · GET /api/finance/quote-options · POST /api/finance/quotes/:no/step · POST /api/finance/quotes/:no/payment
                                           GET /api/finance/reviews · POST /api/finance/reviews/:id/visibility
   The server checks every rule again; the checks here only give faster feedback. */
(function () {
  'use strict';

  var TZ = 'Asia/Manila';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var peso = function (n) { return '\u20B1' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var when = function (ms) { return ms ? new Date(ms).toLocaleString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  var day = function (ymd) { return ymd ? new Date(ymd + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
  var stars = function (n) { return '<span style="color:var(--amber);letter-spacing:1px" aria-label="' + n + ' out of 5">' + '\u2605'.repeat(n) + '<span style="opacity:.3">' + '\u2605'.repeat(5 - n) + '</span></span>'; };

  var quotes = [], reviews = [], qopts = null, busy = false, openQuote = null, loadingQ = false, loadingR = false;

  async function api(path, options) {
    var res = await fetch('/api' + path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, options));
    if (res.status === 401) { window.location.href = 'Login_Inventory.html'; throw new Error('Not signed in'); }
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { fields: data.fields });
    return data;
  }
  function toast(message, isError) {
    var el = document.createElement('div');
    el.className = 'app-toast' + (isError ? ' error' : '');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  function addStyles() {
    var css =
      '.sx-badge{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:var(--red);color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}' +
      '.sx-modal{max-width:640px;width:100%;max-height:92vh;overflow-y:auto}' +
      '.sx-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;padding-right:34px}.sx-head h2{margin:0;font-size:22px}' +
      '.sx-info{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;margin:0 0 14px}.sx-info dt{font-size:12.5px;color:var(--text-faint);margin:0}.sx-info dd{margin:2px 0 0;font-size:15px;overflow-wrap:anywhere}' +
      '.sx-box{margin:0 0 14px;padding:11px 13px;border-radius:8px;border:1px solid var(--border);background:rgba(255,255,255,.03);font-size:14.5px;white-space:pre-line;overflow-wrap:anywhere}.sx-box b{display:block;margin-bottom:3px}' +
      '.sx-form label{display:block;font-size:13.5px;font-weight:600;color:var(--text-dim);margin:12px 0 6px}.sx-form .form-input{width:100%;box-sizing:border-box}.sx-form textarea{min-height:90px;resize:vertical}' +
      '.sx-err{display:none;margin-top:10px;padding:9px 12px;border-radius:6px;font-size:13.5px;color:var(--red);background:rgba(227,91,91,.1);border:1px solid rgba(227,91,91,.35)}.sx-err.show{display:block}' +
      '.sx-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}' +
      '.sx-chk{margin:8px 0 0;padding:0;list-style:none;font-size:13px}.sx-chk li{padding:1px 0}.sx-chk .ok:before{content:"\\2713  ";color:var(--green,#12805c)}.sx-chk .warn:before{content:"! ";color:var(--amber);font-weight:700}' +
      '.sx-two{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}.sx-sub{margin:16px 0 4px;font-weight:700;font-size:14px}' +
      '.sx-empty{padding:22px;text-align:center;color:var(--text-faint)}' +
      '.sx-job{white-space:normal}.sx-job>span{display:block;margin:2px 0 8px}.sx-jobtable{width:100%;border-collapse:collapse;font-size:13.5px;margin:6px 0}.sx-jobtable th,.sx-jobtable td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left}.sx-jobtable .r{text-align:right}' +
      '.sx-jobsum{margin-top:6px;font-size:13.5px}.sx-jobline{display:grid;grid-template-columns:1fr 100px 46px auto;gap:8px;align-items:center;margin-top:8px}.sx-jobline small,.sx-jobline .sx-jerr{grid-column:1/-1;margin-top:-4px}' +
      '.sx-jerr{color:var(--red);font-size:12.5px}.sx-jerr:empty{display:none}.sx-jobline.bad .form-input{border-color:var(--red)}.sx-junit{font-size:13px;color:var(--text-dim)}' +
      '.sx-closebox{margin-top:14px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--red) 45%,var(--border));border-radius:10px;background:color-mix(in srgb,var(--red) 6%,transparent)}.sx-closebox .sx-sub{margin-top:0}' +
      '.sx-approve{margin:0 0 14px;padding:14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--amber) 55%,var(--border));background:color-mix(in srgb,var(--amber) 8%,transparent)}' +
      '.sx-approve-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:baseline;margin-bottom:10px}.sx-approve-head span{font-size:12.5px;color:var(--text-faint)}' +
      '.sx-approve-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:10px;margin-bottom:10px}.sx-approve-grid div{padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}' +
      '.sx-approve-grid span,.sx-approve p span{display:block;font-size:11.5px;color:var(--text-faint);margin-bottom:3px}.sx-approve-grid strong{font-size:16px}.sx-approve-grid small{display:block;font-size:12px;color:var(--text-dim);margin-top:2px}' +
      '.sx-approve p{margin:6px 0 0;font-size:14px;overflow-wrap:anywhere}@media(max-width:560px){.sx-approve-grid{grid-template-columns:1fr}}' +
      '.sx-approve p span.faint{display:inline;font-size:12.5px;margin:0}.sx-lastq-row .btn-sm{margin-top:6px;white-space:normal;text-align:left}.sx-lastq{color:var(--text-dim)}' +
      '.sx-text{max-width:340px;overflow-wrap:anywhere;white-space:pre-line}' +
      '.sx-why{max-width:300px;font-size:13px;overflow-wrap:anywhere}.sx-num{white-space:nowrap;font-variant-numeric:tabular-nums}.sx-num small,.sx-why small{display:block;color:var(--text-faint);font-size:12px}' +
      '.sx-bad{color:var(--red)}.sx-okc{color:var(--green)}.sx-batch{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}.sx-batch:empty{display:none}' +
      '.sx-viewbar{display:inline-flex;margin:0 0 10px;border:1px solid var(--border);border-radius:8px;overflow:hidden}.sx-viewbar button{padding:6px 14px;border:0;background:var(--panel);color:var(--text-dim);font:inherit;font-size:13px;cursor:pointer}.sx-viewbar button+button{border-left:1px solid var(--border)}.sx-viewbar button.on{background:var(--blue-bright);color:#fff}' +
      '.sx-board{display:grid;grid-template-columns:repeat(4,minmax(240px,1fr));gap:12px;overflow-x:auto;padding-bottom:6px}.sx-board[hidden]{display:none}.sx-col{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--panel) 60%,transparent)}' +
      '.sx-col header{display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:13px}.sx-col header span{font-size:12px;color:var(--text-dim);font-variant-numeric:tabular-nums}.sx-col-empty{padding:14px 6px;text-align:center;font-size:13px;color:var(--text-faint)}' +
      '.sx-card{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--panel);cursor:pointer;min-width:0}.sx-card:hover{border-color:var(--blue-bright)}.sx-card:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}.sx-card.late{border-left:3px solid var(--red)}' +
      '.sx-card-top{display:flex;justify-content:space-between;gap:8px;font-size:13px}.sx-card-top span{font-variant-numeric:tabular-nums}.sx-card-who{font-size:14px;overflow-wrap:anywhere}.sx-card-what{font-size:12.5px;overflow-wrap:anywhere}' +
      '.sx-card-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.sx-card-tags span{padding:1px 8px;border-radius:99px;font-size:11.5px;border:1px solid var(--border);color:var(--text-dim)}.sx-card-tags .soon{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 55%,var(--border))}.sx-card-tags .bad{color:var(--red);border-color:color-mix(in srgb,var(--red) 55%,var(--border))}.sx-card-tags .ok{color:var(--green)}' +
      '.sx-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0 0 10px}.sx-kpi{display:flex;flex-direction:column;gap:2px;text-align:left;padding:11px 14px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--text);font:inherit;cursor:pointer}' +
      '.sx-kpi span{font-size:12px;color:var(--text-faint)}.sx-kpi strong{font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums}.sx-kpi small{font-size:12px;color:var(--text-dim)}.sx-kpi:hover{border-color:var(--blue-bright)}.sx-kpi:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}' +
      '.sx-kpi.soon strong{color:var(--amber)}.sx-kpi.urgent{border-color:color-mix(in srgb,var(--red) 55%,var(--border))}.sx-kpi.urgent strong{color:var(--red)}.sx-kpi.on{border-color:var(--blue-bright);box-shadow:0 0 0 1px var(--blue-bright) inset}@media(max-width:760px){.sx-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}' +
      '.sx-age{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:99px;font-size:11.5px;border:1px solid var(--border);color:var(--text-dim);white-space:nowrap}.sx-age.soon{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 55%,var(--border))}.sx-age.urgent{color:var(--red);border-color:color-mix(in srgb,var(--red) 55%,var(--border));font-weight:600}' +
      '.sx-approve-head .sx-age{margin:0}.sx-dg-late{font-style:normal;font-size:11.5px;color:var(--red);font-weight:600}tr.sx-latepick td:first-child{box-shadow:inset 3px 0 0 var(--red)}' +
      '.sx-bgroup{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;width:100%;margin:0 0 8px;padding:12px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--amber) 55%,var(--border));background:color-mix(in srgb,var(--amber) 8%,transparent)}.sx-bgroup.blocked{border-color:color-mix(in srgb,var(--red) 45%,var(--border));background:color-mix(in srgb,var(--red) 6%,transparent)}' +
      '.sx-bg-txt{display:flex;flex-direction:column;gap:2px;min-width:0}.sx-bg-txt span{font-size:12.5px;color:var(--text-dim)}.sx-bg-act{display:flex;gap:8px;flex-wrap:wrap}.sx-batch:has(.sx-bgroup){display:block}' +
      '.sx-chip{display:inline-flex;gap:6px;align-items:center;padding:5px 10px;border:1px solid var(--border);border-radius:99px;font-size:12.5px;background:var(--panel)}' +
      '.sx-digest{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}.sx-digest:empty{display:none}' +
      '.sx-dg{display:inline-flex;gap:7px;align-items:center;padding:6px 12px;border:1px solid var(--border);border-radius:99px;font:inherit;font-size:13px;background:var(--panel);color:var(--text);cursor:pointer;transition:background .15s,border-color .15s}' +
      '.sx-dg b{font-variant-numeric:tabular-nums;font-size:14px}.sx-dg:hover{border-color:var(--blue-bright)}.sx-dg:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}' +
      '.sx-dg.urgent{border-color:color-mix(in srgb,var(--red) 55%,var(--border))}.sx-dg.urgent b{color:var(--red)}.sx-dg.soon b{color:var(--amber)}' +
      '.sx-dg.on{background:color-mix(in srgb,var(--blue-bright) 14%,var(--panel));border-color:var(--blue-bright);font-weight:600}' +
      '.sx-depprompt{position:fixed;right:18px;bottom:18px;z-index:1050;display:flex;gap:14px;align-items:center;max-width:min(440px,calc(100vw - 36px));padding:12px 14px;background:var(--panel);border:1px solid var(--blue-bright);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.28)}.sx-depprompt b{display:block;font-size:14px}.sx-depprompt span{display:block;font-size:12.5px;color:var(--text-dim);margin-top:2px}.sx-dp-act{display:flex;gap:6px;flex:none}' +
      '.sx-depnote{margin:2px 0 8px;font-size:13px;color:var(--text-dim)}.sx-depnote b{color:var(--text)}' +
      '.sx-ready{margin:8px 0}.sx-ready:empty{display:none}.sx-rd{font-size:13px;font-weight:600;margin:0 0 4px}.sx-rd.ok{color:var(--green)}.sx-rd.warn{color:var(--amber)}.sx-rd-line{font-size:13px;margin:4px 0;overflow-wrap:anywhere}.sx-rd-line .btn-sm{margin-left:6px}.sx-ready .faint{font-size:12.5px;margin-top:4px}' +
      '.sx-exp{margin-top:4px;font-size:12.5px;color:var(--text-dim)}.sx-exp.soon{color:var(--amber);font-weight:600}.sx-exp.urgent{color:var(--red);font-weight:700}' +
      '.sx-dg-clear{border:0;background:none;color:var(--text-dim);font:inherit;font-size:12.5px;text-decoration:underline;cursor:pointer;padding:4px}.sx-dg-clear:focus-visible{outline:2px solid var(--blue-bright);outline-offset:2px}.sx-dg-ok{font-size:13px;color:var(--green)}' +
      '.sx-log{white-space:normal}.sx-log li{margin:0 0 6px;font-size:13px}.sx-log li small{display:block;color:var(--text-faint)}.sx-rules .sx-two{gap:0 14px}.sx-assume{color:var(--amber);font-size:13px}' +
      '.sx-warnbox{border-color:color-mix(in srgb,var(--amber) 55%,var(--border))}' +
      '.sxr-row{cursor:pointer;transition:background .15s}.sxr-row:hover{background:color-mix(in srgb,var(--text) 5%,transparent)}.sxr-row:focus-visible{outline:2px solid var(--blue-bright);outline-offset:-2px}' +
      '.sxr-who{display:flex;align-items:center;gap:10px;min-width:0}.sxr-av{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#16283b;border:1px solid rgba(74,144,217,.35);color:var(--blue-bright);font:600 13px Oswald,sans-serif}html[data-theme="light"] .sxr-av{background:#dbe6f0;color:var(--blue)}' +
      '.sxr-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.sxr-top{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--text) 4%,var(--panel));margin-bottom:14px}.sxr-top .sxr-av{width:56px;height:56px;font-size:22px}.sxr-top strong{display:block;font-size:18px}.sxr-top span.faint{font-size:14px;overflow-wrap:anywhere}' +
      '.sxr-h{margin:18px 0 10px;font:500 12.5px "IBM Plex Mono",monospace;letter-spacing:1.2px;text-transform:uppercase;color:var(--text-dim);display:flex;align-items:center;gap:12px}.sxr-h:after{content:"";flex:1;height:1px;background:var(--border)}' +
      '.sxr-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.sxr-f{padding:10px 13px;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--text) 3%,var(--panel));overflow-wrap:anywhere}.sxr-f span{display:block;font-size:12.5px;color:var(--text-dim);margin-bottom:3px}.sxr-f strong{font-size:14.5px;font-weight:600}.sxr-f.is-empty strong{font-weight:400;color:var(--text-faint)}' +
      '.sxr-review{padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--text) 3%,var(--panel))}.sxr-review p{margin:10px 0 0;white-space:pre-line;overflow-wrap:anywhere;line-height:1.5}' +
      '#reviews .sxr-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 16px}#reviews .btn-danger,#sxOverlay .btn-danger{background:transparent;color:var(--red);border:1px solid var(--red);font-family:inherit;font-weight:600}#reviews .btn-danger:hover,#sxOverlay .btn-danger:hover{background:color-mix(in srgb,var(--red) 14%,transparent)}#reviews tbody td:nth-child(5){white-space:nowrap}#reviews .sxr-kpi{padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--text) 3%,var(--panel))}#reviews .sxr-kpi span{display:block;font:500 12px "IBM Plex Mono",monospace;letter-spacing:1.1px;text-transform:uppercase;color:var(--text-faint)}#reviews .sxr-kpi strong{display:block;margin-top:6px;font:600 26px Oswald,sans-serif}#reviews .sxr-kpi.good strong{color:var(--green)}#reviews .sxr-kpi.bad strong{color:var(--red)}' +
      '#reviews .sxr-dist{display:flex;flex-direction:column;gap:5px;margin-top:6px}#reviews .sxr-dist div{display:grid;grid-template-columns:22px 1fr 28px;gap:8px;align-items:center;font-size:12.5px;color:var(--text-dim)}#reviews .sxr-bar{height:7px;border-radius:99px;background:color-mix(in srgb,var(--text) 10%,transparent);overflow:hidden}#reviews .sxr-bar i{display:block;height:100%;background:var(--amber);border-radius:99px}' +
      '#reviews table{border-collapse:separate;border-spacing:0;width:100%}#reviews thead th{position:sticky;top:0;z-index:1;background:color-mix(in srgb,var(--text) 5%,var(--panel));font:500 12px "IBM Plex Mono",monospace;letter-spacing:1.1px;text-transform:uppercase;color:var(--text-dim);padding:12px 14px;text-align:left;border-bottom:1px solid var(--border)}#reviews tbody td{padding:13px 14px;border-bottom:1px solid color-mix(in srgb,var(--border) 70%,transparent);vertical-align:middle}#reviews tbody tr:last-child td{border-bottom:0}#reviews .sxr-row:hover td{background:color-mix(in srgb,var(--blue-bright) 7%,transparent)}' +
      '.sxr-more{margin-top:10px;padding:11px 14px;border:1px solid var(--border);border-radius:10px;background:color-mix(in srgb,var(--text) 3%,var(--panel))}.sxr-more header{display:flex;justify-content:space-between;gap:10px;font-size:14px}.sxr-more p{margin:6px 0 0;font-size:13.5px;color:var(--text-dim);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '@media(max-width:560px){.sx-info,.sx-two,.sxr-grid{grid-template-columns:1fr}}';
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  }

  var qPill = function (x) {
    var st = x.status, cls = st === 'quoted' ? (x.expired ? 'out' : 'in') : st === 'new' ? 'low' : (st === 'accepted' || st === 'preparing' || st === 'ready' || st === 'completed') ? 'in' : 'out';
    return '<span class="status-pill ' + cls + '">' + esc(x.expired ? 'Quote expired' : (x.statusLabel || st)) + '</span>';
  };
  /* ---- how long a sent price stays valid: "expires in 3 days", red from tomorrow on, amber inside Finance's reminder window ---- */
  var remindH = 24, escalateH = 48;                                        // "Remind you when a price waits longer than" / "Escalate after" (hours) from the approval rules
  var expiryWarn = 2, rulesLoaded = false;                                 // expiryWarn = "Remind before a quote expires" (days) from the approval rules
  var todayMnl = function () { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); };
  var daysLeft = function (x) { return x.status === 'quoted' && x.validUntil ? Math.round((Date.parse(x.validUntil) - Date.parse(todayMnl())) / 864e5) : null; };
  /* how long a cashier price has waited for Finance, against the reminder and escalation hours the server uses (quote-automation.js approvalReminders) */
  var ageInfo = function (x) {
    if (x.status !== 'pending_approval' || !x.proposedAt) return null;
    var h = Math.max(0, Math.floor((Date.now() - x.proposedAt) / 36e5)), late = h >= escalateH, due = h >= remindH;
    var span = h >= 48 ? Math.floor(h / 24) + ' days' : h < 1 ? 'under 1 h' : h + ' h';
    return { hrs: h, text: 'waiting ' + span + (late ? ' \u00B7 overdue' : ''), tone: late ? 'urgent' : due ? 'soon' : '', late: late, due: due };
  };
  var ageHtml = function (x) { var a = ageInfo(x); return a ? '<span class="sx-age ' + a.tone + '" title="' + esc('Reminder after ' + remindH + ' h, escalated after ' + escalateH + ' h. It is never approved automatically.') + '">' + esc(a.text) + '</span>' : ''; };
  var expiryInfo = function (x) {
    var n = daysLeft(x); if (n == null) return null;
    if (x.expired || n < 0) { var ago = Math.max(1, -n); return { text: 'expired ' + (n < 0 ? ago + ' day' + (ago === 1 ? '' : 's') + ' ago' : 'today'), tone: 'urgent', n: n }; }
    return { text: n === 0 ? 'expires today' : n === 1 ? 'expires tomorrow' : 'expires in ' + n + ' days', tone: n <= 1 ? 'urgent' : n <= expiryWarn ? 'soon' : '', n: n };
  };
  var expiryHtml = function (x) { var e = expiryInfo(x); return e ? '<div class="sx-exp ' + e.tone + '" title="Price valid until ' + esc(day(x.validUntil)) + '">' + esc(e.text) + '</div>' : ''; };
  var months = function (m) { return m + (m === 1 ? ' month' : ' months'); };
  var ini = function (n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?'; };
  var rPill = function (st) { return '<span class="status-pill ' + (st === 'hidden' ? 'out' : 'in') + '">' + (st === 'hidden' ? 'Hidden' : 'Visible') + '</span>'; };

  /* ---------------- page skeletons ---------------- */
  function build() {
    var q = $('quotes'), r = $('reviews');
    if (q) q.innerHTML =
      '<div class="catalog-header"><div><div class="catalog-eyebrow">Sales</div><h1 class="catalog-title">Quote Approvals</h1><p class="faint" style="margin:4px 0 0;max-width:70ch">The cashiers confirm prices at the counter and the system routes them. Only the exceptions wait here: outside the tolerance band, below the minimum margin or cost, over the value limit, not fully costed, short of stock, or with partial-payment terms. Nothing is ever approved automatically.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-secondary btn-sm" id="sxqRules" type="button">Approval rules</button><button class="btn-secondary btn-sm" id="sxqRefresh" type="button">Refresh</button></div></div>' +
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Requests</div><div class="panel-sub" id="sxqSub">Loading\u2026</div></div>' +
      '<div class="inv-filters"><select id="sxqFilter" class="inv-select" aria-label="Show"><option value="approval">Cashier prices to approve</option><option value="open">Needs my action</option><option value="quoted">Waiting for the customer</option><option value="completed">Completed</option><option value="declined">Declined</option><option value="closed">Closed</option><option value="all">All requests</option></select></div></div>' +
      '<div class="sx-kpis" id="sxqKpis" role="group" aria-label="Queue sizes: tap a tile to filter the list"></div>' +
      '<div class="sx-digest" id="sxqDigest" role="group" aria-label="Quote pipeline: tap a step to filter the list"></div>' +
      '<div class="sx-viewbar" id="sxqView" role="group" aria-label="Show the requests as"><button type="button" data-view="table">Table</button><button type="button" data-view="board">Board</button></div>' +
      '<div class="sx-batch" id="sxqBatch"></div>' +
      '<div class="sx-board" id="sxqBoard" hidden></div>' +
      '<div class="table-wrapper" id="sxqTableWrap"><table><thead id="sxqHead"></thead><tbody id="sxqBody"></tbody></table></div></div>' +
      '<div class="panel" style="margin-top:16px"><div class="panel-head"><div><div class="panel-title">Purchase Suggestions &amp; Restock Orders</div><div class="panel-sub" id="sxpSub">Materials and products needing purchase due to low stock or accepted customer quotes.</div></div>' +
      '<div class="inv-filters"><select id="sxpFilter" class="inv-select" aria-label="Filter suggestions"><option value="open">Needs ordering (Open)</option><option value="ordered">Waiting for delivery (Ordered)</option><option value="received">Delivered (Received)</option><option value="all">All items</option></select></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Item</th><th>Source</th><th>Order Qty</th><th>On Hand</th><th>Est. Cost</th><th>Supplier &amp; Lead Time</th><th>Timing / Delivery</th><th>Actions</th></tr></thead><tbody id="sxpBody"></tbody></table></div></div>';
    if (r) r.innerHTML =
      '<div class="catalog-header"><div><div class="catalog-eyebrow">Orders</div><h1 class="catalog-title">Product Reviews</h1>' +
      '</div>' +
      '<button class="btn-secondary btn-sm" id="sxrRefresh" type="button">Refresh</button></div>' +
      '<div class="sxr-kpis" id="sxrKpis"></div>' +
      '<div class="panel"><div class="panel-head"><div><div class="panel-title">Reviews</div><div class="panel-sub" id="sxrSub">Loading\u2026</div></div>' +
      '<div class="inv-filters"><input type="text" id="sxrSearch" class="inv-search" placeholder="Search product, customer or text..." autocomplete="off">' +
      '<select id="sxrRating" class="inv-select" aria-label="Filter by rating"><option value="all">All ratings</option><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option><option value="2">2 stars</option><option value="1">1 star</option></select>' +
      '<select id="sxrFilter" class="inv-select"><option value="all">All reviews</option><option value="visible">Visible</option><option value="hidden">Hidden</option></select></div></div>' +
      '<div class="table-wrapper"><table><thead><tr><th>Product</th><th>Rating</th><th>Customer</th><th>Review</th><th>Date</th><th>Status</th><th></th></tr></thead><tbody id="sxrBody"></tbody></table></div></div>';
    if (q) {
      $('sxqRefresh').addEventListener('click', loadQuotes);
      document.addEventListener('finance-quotes-changed', loadQuotes);
      $('sxqRules').addEventListener('click', openRules);
      $('sxqBatch').addEventListener('click', function (e) {
        var b = e.target.closest('[data-batch]'); if (b) { batchApprove(b.dataset.batch); return; }
        var fo = e.target.closest('[data-bfocus]'); if (fo) { batchFocus = batchFocus === fo.dataset.bfocus ? null : fo.dataset.bfocus; renderQuotes(); }
      });
      $('sxqBody').addEventListener('change', function () { paintBatch(); });
      if ($('sxpFilter')) $('sxpFilter').addEventListener('change', loadSuggestions);
      $('sxpBody').addEventListener('click', function (e) {
        var si = e.target.closest('[data-stockin]');
        if (si) {
          if (typeof window.goStockIn === 'function') {
            window.goStockIn(si.dataset.stockin, si.dataset.qty, si.dataset.sup, si.dataset.cost, si.dataset.orderdate);
          }
          return;
        }
        var b = e.target.closest('[data-sxp]');
        if (b) markSuggestion(Number(b.dataset.sxp), b.dataset.st);
      });
      $('sxqFilter').addEventListener('change', function () { pickedFilter = true; digestKey = null; setView('table'); });
      $('sxqView').addEventListener('click', function (e) { var b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
      $('sxqBoard').addEventListener('click', function (e) { var c = e.target.closest('[data-qcard]'); if (c) openCard(c); });
      $('sxqBoard').addEventListener('keydown', function (e) { if (e.key !== 'Enter' && e.key !== ' ') return; var c = e.target.closest('[data-qcard]'); if (c) { e.preventDefault(); openCard(c); } });
      $('sxqDigest').addEventListener('click', function (e) { var b = e.target.closest('[data-dg]'); if (b) pickDigest(b.dataset.dg); });
      $('sxqKpis').addEventListener('click', function (e) { var b = e.target.closest('[data-kpi]'); if (b) pickDigest(b.dataset.kpi); });
      // the whole row opens the card (like the Sales ledger), not only its button; price approvals use the shared decision dialog
      var openRow = function (id) { var pq = quotes.find(function (q) { return q.id === id; }); if (pq && pq.status === 'pending_approval' && window.SalesDecisions) window.SalesDecisions.open(pq.id); else openQ(id); };
      $('sxqBody').addEventListener('click', function (e) {
        var a = e.target.closest('[data-sxapprove]'); if (a) { quickApprove(a.dataset.sxapprove); return; }
        var b = e.target.closest('[data-sxq]'); if (b) { if (b.dataset.dep) wantDeposit = true; openRow(b.dataset.sxq); return; }
        var tr = e.target.closest('[data-qrow]'); if (tr && !e.target.closest('input, label, a, select')) openRow(tr.dataset.qrow);
      });
      $('sxqBody').addEventListener('keydown', function (e) {
        if ((e.key !== 'Enter' && e.key !== ' ') || e.target.closest('button, input, a, select')) return;
        var tr = e.target.closest('[data-qrow]'); if (tr) { e.preventDefault(); openRow(tr.dataset.qrow); }
      });
    }
    if (r) {
      $('sxrRefresh').addEventListener('click', loadReviews);
      $('sxrFilter').addEventListener('change', renderReviews);
      $('sxrRating').addEventListener('change', renderReviews);
      $('sxrSearch').addEventListener('input', renderReviews);
      $('sxrBody').addEventListener('click', function (e) {
        var b = e.target.closest('[data-sxr]');
        if (b) {
          var rv = reviews.find(function (x) { return x.id === Number(b.dataset.sxr); });
          if (!rv) return;
          if (rv.status === 'hidden') setVisibility(rv, false, ''); else askHide(rv);
          return;
        }
        var tr = e.target.closest('[data-sxrow]'); if (tr) openReview(Number(tr.dataset.sxrow));
      });
      $('sxrBody').addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) { var tr = e.target.closest('[data-sxrow]'); if (tr) { e.preventDefault(); openReview(Number(tr.dataset.sxrow)); } }
      });
    }
  }

  /* ---------------- quotes ---------------- */
  var IN_FLOW = ['accepted', 'preparing', 'ready'];
  var needsAction = function (x) { return x.status === 'new' || x.status === 'pending_approval' || IN_FLOW.indexOf(x.status) >= 0 || (x.status === 'quoted' && !!(x.expired || x.costStale)); };
  var approvalCount = function () { return quotes.filter(function (x) { return x.status === 'pending_approval'; }).length; };
  var pickedFilter = false;                                                // the first load opens on the approvals when some are waiting
  var newCount = function () { return quotes.filter(needsAction).length; };
  /* ---- deposit prompt: when a customer accepts, Finance is told what is due and can record it in one step ---- */
  var wantDeposit = false, depSeen = null, depPending = [], lastPayMethod = '';
  var depWord = function (x) { var t = x.terms || {}; return t.key === 'full' || +t.percent >= 100 ? 'payment' : 'deposit'; };
  var termsLine = function (x) {
    var t = x.terms || {}; if (t.state !== 'approved') return '';
    return (depWord(x) === 'payment' ? 'Full payment' : (t.percent != null ? t.percent + '% down payment' : 'Down payment')) + (t.balance > 0 ? ' \u00B7 balance ' + peso(t.balance) + ' later' : '') + (t.condition ? ' \u00B7 ' + t.condition : '');
  };
  // after the panel is painted: amount pre-filled from the approved terms, the method the cashier used last, focus on the one thing left to do
  function prefillPayment(x) {
    var amt = $('sxPayAmt'), sel = $('sxPayMethod'); if (!amt || !sel) return;
    var dep = x.dueNow > 0;
    if (dep && window.MoneyInput) MoneyInput.set(amt, x.dueNow);
    if (!sel.value && lastPayMethod && Array.prototype.some.call(sel.options, function (o) { return o.value === lastPayMethod; })) sel.value = lastPayMethod;
    if (wantDeposit && dep) { wantDeposit = false; var go = !sel.value ? sel : $('sxPay'); if (go) go.focus(); }
  }
  // quotes that just reached "waiting for deposit" since the last refresh (the first load only records what is already waiting)
  function watchDeposits() {
    var due = quotes.filter(function (x) { return stageOf(x) === 'deposit'; }), fresh = [];
    if (depSeen) due.forEach(function (x) { if (!depSeen[x.id] && !x.payOnline) fresh.push(x); });   // online payers settle through Xendit by themselves
    depSeen = depSeen || {}; due.forEach(function (x) { depSeen[x.id] = 1; });
    if (fresh.length) showDepPrompt(fresh);
  }
  function showDepPrompt(list) {
    list.forEach(function (x) { if (depPending.indexOf(x.id) < 0) depPending.push(x.id); });
    var el = $('sxDepPrompt');
    if (!el) {
      el = document.createElement('div'); el.id = 'sxDepPrompt'; el.className = 'sx-depprompt'; el.setAttribute('role', 'status'); document.body.appendChild(el);
      el.addEventListener('click', function (e) {
        var b = e.target.closest('[data-dp]'); if (!b) return;
        var ids = depPending.slice(); depPending = []; el.remove();
        if (b.dataset.dp === 'x') return;
        if (typeof window.navigateToPage === 'function') window.navigateToPage('quotes');
        if (ids.length === 1) { wantDeposit = true; openQ(ids[0]); } else pickDigest('deposit');
      });
    }
    var qs = depPending.map(function (id) { return quotes.find(function (q) { return q.id === id; }); }).filter(function (q) { return q && stageOf(q) === 'deposit'; });
    if (!qs.length) { depPending = []; el.remove(); return; }
    var one = qs.length === 1 ? qs[0] : null, sum = qs.reduce(function (a, q) { return a + (+q.dueNow || 0); }, 0);
    el.innerHTML = '<div><b>' + (one ? esc(one.id) + ' was accepted' : qs.length + ' quotes were accepted') + '</b><span>' +
      (one ? esc(one.customer || 'Customer') + ' \u00B7 ' + depWord(one) + ' due ' + peso(one.dueNow) : peso(sum) + ' in deposits waiting to be recorded') + '</span></div>' +
      '<div class="sx-dp-act"><button type="button" class="btn-primary btn-sm" data-dp="go">' + (one ? 'Record ' + depWord(one) : 'Review them') + '</button>' +
      '<button type="button" class="btn-secondary btn-sm" data-dp="x" aria-label="Dismiss">\u00D7</button></div>';
  }
  /* ---- pipeline digest bar: where every live quote sits, one tap to filter the list below ---- */
  var digestKey = null;                                                    // null = the dropdown decides; otherwise one pipeline step from STAGES
  var STAGES = [['approve', 'to approve', 'Cashier prices waiting for your approval', 'urgent'],
    ['terms', 'payment terms to approve', 'Payment terms the cashier proposed', 'urgent'],
    ['deposit', 'waiting for deposit', 'Accepted, down payment not recorded yet', 'soon'],
    ['start', 'ready to start', 'Issue the materials or start preparing', 'soon'],
    ['preparing', 'in preparation', 'Being made or prepared', ''],
    ['handover', 'ready to hand over', 'Ready or out for delivery: collect any balance, then hand over', 'soon'],
    ['refresh', 'price to refresh', 'The quote expired or material costs changed', 'soon'],
    ['expiring', 'expiring soon', 'Sent price that lapses within the reminder window: remind the customer', 'soon']];
  // one rule, so the chip counts and the filtered list can never disagree
  function stageOf(x) {
    var t = x.terms || {};
    if (x.status === 'pending_approval') return 'approve';
    if (t.state === 'proposed' && ['new', 'closed', 'declined', 'awaiting_details', 'completed'].indexOf(x.status) < 0 && (x.quotedAmount != null || x.proposedAmount != null)) return 'terms';
    if (x.status === 'accepted') return x.dueNow > 0 ? 'deposit' : 'start';
    if (x.status === 'preparing') return 'preparing';
    if (x.status === 'ready') return 'handover';
    if (x.status === 'quoted' && (x.expired || x.costStale)) return 'refresh';
    if (x.status === 'quoted') { var e = expiryInfo(x); if (e && e.n <= expiryWarn) return 'expiring'; }
    return null;
  }
  /* ---- Board view: every quote that is in fulfilment, one column per step. A card opens the same Manage panel as a table row ---- */
  var viewMode = 'table';
  try { if (window.localStorage && localStorage.getItem('sxqView') === 'board') viewMode = 'board'; } catch (e) { /* the table stays */ }
  function setView(v) {
    viewMode = v === 'board' ? 'board' : 'table';
    try { if (window.localStorage) localStorage.setItem('sxqView', viewMode); } catch (e) { /* only a convenience */ }
    renderQuotes();
  }
  function openCard(c) { var id = c.dataset.qcard; if (c.dataset.dep) wantDeposit = true; openQ(id); }
  var stageAt = function (x) {                                           // when the quote reached the step it is in now
    var e = (x.progress || []).filter(function (p) { return p.status === x.status; }).pop();
    return (e && e.at) || (x.status === 'accepted' && x.respondedAt) || x.updatedAt || null;
  };
  var BOARD_COLS = [['accepted', 'Accepted'], ['preparing', 'Preparing'], ['ready', 'Ready / out for delivery'], ['done', 'Handed over today']];
  function boardCard(x) {
    var st = stageOf(x), t = x.terms || {}, at = stageAt(x), d = at ? Math.floor((Date.now() - at) / 864e5) : null, tags = [], left = x.neededBy ? Math.round((Date.parse(x.neededBy) - Date.parse(todayMnl())) / 864e5) : null;
    if (x.lateForNeededBy && x.status !== 'completed') tags.push(['bad', 'will miss needed-by date']);
    else if (left != null && left <= 3 && x.status !== 'completed') tags.push(['soon', left <= 0 ? 'needed today' : 'needed in ' + left + ' day' + (left === 1 ? '' : 's')]);
    if (st === 'terms') tags.push(['soon', 'payment terms to approve']);
    else if (st === 'deposit') tags.push(['soon', depWord(x) + ' due ' + peso(x.dueNow)]);
    else if (st === 'start') tags.push(['', x.sku ? 'ready to start' : 'issue materials']);
    if (x.status === 'ready') tags.push([x.balance > 0 ? 'soon' : 'ok', x.balance > 0 ? 'collect ' + peso(x.balance) : 'fully paid']);
    else if (x.status === 'preparing' && x.balance > 0 && !(st === 'deposit')) tags.push(['', peso(x.balance) + ' balance']);
    if (d != null && d >= 1 && x.status !== 'completed') tags.push(['', d + ' day' + (d === 1 ? '' : 's') + ' in this step']);
    return '<div class="sx-card' + (x.lateForNeededBy && x.status !== 'completed' ? ' late' : '') + '" role="button" tabindex="0" data-qcard="' + esc(x.id) + '"' + (st === 'deposit' && !x.payOnline ? ' data-dep="1"' : '') + ' aria-label="' + esc('Open ' + x.id) + '">' +
      '<div class="sx-card-top"><b>' + esc(x.id) + '</b><span>' + peso(x.quotedAmount != null ? x.quotedAmount : x.proposedAmount || 0) + '</span></div>' +
      '<div class="sx-card-who">' + esc(x.customer || 'Customer') + (x.source === 'pos' ? ' <span class="faint">\u00B7 Walk-in</span>' : '') + '</div>' +
      '<div class="faint sx-card-what">' + esc(x.product || 'Custom item') + ' \u00D7 ' + esc(x.quantity) + '</div>' +
      (tags.length ? '<div class="sx-card-tags">' + tags.map(function (g) { return '<span class="' + g[0] + '">' + esc(g[1]) + '</span>'; }).join('') + '</div>' : '') + '</div>';
  }
  function paintBoard() {
    var box = $('sxqBoard'); if (!box) return;
    var today = todayMnl(), cols = {};
    BOARD_COLS.forEach(function (c) { cols[c[0]] = []; });
    quotes.forEach(function (x) {
      if (x.status === 'accepted' || x.status === 'preparing' || x.status === 'ready') cols[x.status].push(x);
      else if (x.status === 'completed') { var at = stageAt(x); if (at && new Date(at).toLocaleDateString('en-CA', { timeZone: TZ }) === today) cols.done.push(x); }
    });
    var QGs = function (x) { return window.QuoteGuide ? window.QuoteGuide.next(x).score : 0; };
    box.innerHTML = BOARD_COLS.map(function (c) {
      var list = cols[c[0]].sort(function (a, b) { return (c[0] === 'done' ? 0 : QGs(b) - QGs(a)) || (stageAt(a) || 0) - (stageAt(b) || 0); });   // most urgent first, then longest in the step
      var total = list.reduce(function (a, x) { return a + (+(x.quotedAmount != null ? x.quotedAmount : x.proposedAmount) || 0); }, 0);
      return '<section class="sx-col" aria-label="' + esc(c[1]) + '"><header><b>' + esc(c[1]) + '</b><span>' + list.length + (list.length ? ' \u00B7 ' + peso(total) : '') + '</span></header>' +
        (list.length ? list.map(boardCard).join('') : '<div class="sx-col-empty">Nothing here</div>') + '</section>';
    }).join('');
  }
  function paintView() {
    var board = viewMode === 'board';
    Array.prototype.forEach.call($('sxqView').querySelectorAll('[data-view]'), function (b) { var on = (b.dataset.view === 'board') === board; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('sxqBoard').hidden = !board; $('sxqTableWrap').hidden = board;
    if (board) { $('sxqBatch').innerHTML = ''; paintBoard(); }
    return board;
  }
  /* ---- KPI tiles: the size of each queue, one tap to filter. The tiles reuse the pipeline filter (digestKey), so the list, the chips and the tiles always agree ---- */
  var KPI_KEYS = { fulfil: 1, balance: 1, exp48: 1 };                       // tile filters that are not a single pipeline step; 'approve' is the existing step
  var inFlowQuote = function (x) { return IN_FLOW.indexOf(x.status) >= 0; };
  var collectingBalance = function (x) { return inFlowQuote(x) && x.balance > 0 && stageOf(x) !== 'deposit'; };   // money still to collect that is not the down payment being waited for
  var expiring48 = function (x) { var n = daysLeft(x); return x.status === 'quoted' && !x.expired && n != null && n >= 0 && n <= 2; };
  // one rule for "does this quote belong to the filter that is on"
  function inFilter(x, k) {
    if (k === 'fulfil') return inFlowQuote(x);
    if (k === 'balance') return collectingBalance(x);
    if (k === 'exp48') return expiring48(x);
    return stageOf(x) === k;
  }
  function paintKpis(f) {
    var box = $('sxqKpis'); if (!box) return;
    var sum = function (list, fn) { return list.reduce(function (a, x) { return a + (fn(x) || 0); }, 0); };
    var ap = quotes.filter(function (x) { return x.status === 'pending_approval'; }), fl = quotes.filter(inFlowQuote), bal = quotes.filter(collectingBalance), ex = quotes.filter(expiring48);
    var late = ap.filter(function (x) { return (ageInfo(x) || {}).late; }).length;
    var tiles = [
      ['approve', 'Pending approval', ap.length, ap.length ? peso(sum(ap, cashierPrice)) + (late ? ' \u00B7 ' + late + ' overdue' : '') : 'nothing waiting', late ? 'urgent' : ap.length ? 'soon' : ''],
      ['fulfil', 'In fulfilment', fl.length, fl.length ? fl.filter(function (x) { return x.status === 'accepted'; }).length + ' accepted \u00B7 ' + fl.filter(function (x) { return x.status === 'preparing'; }).length + ' preparing \u00B7 ' + fl.filter(function (x) { return x.status === 'ready'; }).length + ' ready' : 'no jobs running', ''],
      ['balance', 'Collecting balance', bal.length, bal.length ? peso(sum(bal, function (x) { return x.balance; })) + ' still to collect' : 'nothing to collect', bal.length ? 'soon' : ''],
      ['exp48', 'Expiring in 48h', ex.length, ex.length ? peso(sum(ex, function (x) { return x.quotedAmount; })) + ' in sent prices' : 'none about to lapse', ex.length ? 'soon' : '']];
    box.innerHTML = tiles.map(function (t) {
      var on = digestKey ? digestKey === t[0] : (t[0] === 'approve' && f === 'approval');
      return '<button type="button" class="sx-kpi ' + t[4] + (on ? ' on' : '') + '" data-kpi="' + t[0] + '" aria-pressed="' + on + '"><span>' + esc(t[1]) + '</span><strong>' + t[2] + '</strong><small>' + esc(t[3]) + '</small></button>';
    }).join('');
  }
  function paintDigest(f) {
    var box = $('sxqDigest'); if (!box) return;
    var counts = {}; quotes.forEach(function (x) { var k = stageOf(x); if (k) counts[k] = (counts[k] || 0) + 1; });
    var shown = STAGES.filter(function (st) { return counts[st[0]] || digestKey === st[0]; });
    var overdue = quotes.filter(function (x) { return (ageInfo(x) || {}).late; }).length;
    if (!shown.length) { box.innerHTML = '<span class="sx-dg-ok">Nothing in the pipeline needs you right now.</span>'; return; }
    box.innerHTML = shown.map(function (st) {
      var on = digestKey ? digestKey === st[0] : (st[0] === 'approve' && f === 'approval');
      return '<button type="button" class="sx-dg ' + st[3] + (on ? ' on' : '') + '" data-dg="' + st[0] + '" aria-pressed="' + on + '" title="' + esc(st[2]) + '"><b>' + (counts[st[0]] || 0) + '</b> ' + esc(st[1]) + (st[0] === 'approve' && overdue ? ' <i class="sx-dg-late">' + overdue + ' overdue</i>' : '') + '</button>';
    }).join('') + (digestKey ? '<button type="button" class="sx-dg-clear" data-dg="clear">Clear filter</button>' : '');
  }
  function pickDigest(k) {
    var sel = $('sxqFilter'); pickedFilter = true; viewMode = 'table';   // tiles and chips filter the table
    if (k === 'clear' || k === digestKey || (k === 'approve' && !digestKey && sel.value === 'approval')) { digestKey = null; sel.value = 'open'; }   // tapping the active chip lets go of it
    else if (k === 'approve') { digestKey = null; sel.value = 'approval'; }                                                                   // the approvals table keeps its batch tools
    else { digestKey = k; sel.value = 'open'; }
    renderQuotes();
  }
  // the sidebar badge counts only what Finance alone can do: approve a cashier's price (the cashiers answer new requests)
  function renderQuotes() {
    if (!$('sxqBody')) return;
    var f = $('sxqFilter').value, n = newCount();
    var list = quotes.filter(function (x) { return digestKey ? inFilter(x, digestKey) : (f === 'all' || (f === 'open' ? needsAction(x) : f === 'approval' ? x.status === 'pending_approval' : x.status === f)); });
    var QG = function (x) { return window.QuoteGuide ? window.QuoteGuide.next(x) : { score: 0, text: '', tone: 'ok' }; };
    list.sort(function (a, b) { return QG(b).score - QG(a).score || (a.status === 'quoted' && b.status === 'quoted' && a.validUntil && b.validUntil && a.validUntil !== b.validUntil ? (a.validUntil < b.validUntil ? -1 : 1) : 0) || (a.status === 'pending_approval' && b.status === 'pending_approval' ? (a.proposedAt || a.createdAt || 0) - (b.proposedAt || b.createdAt || 0) : 0) || (b.createdAt || 0) - (a.createdAt || 0); });   // quotes that expire first come first   // the most urgent work first
    var guideHtml = function (x) { var g = QG(x); return g.text ? '<div class="sx-guide ' + g.tone + '">\u2192 ' + esc(g.text) + '</div>' : ''; };
    var ap = approvalCount(), opt = $('sxqFilter').querySelector('option[value="approval"]'); if (opt) opt.textContent = 'Cashier prices to approve (' + ap + ')';
    $('sxqSub').textContent = quotes.length ? (ap ? ap + ' cashier price' + (ap === 1 ? '' : 's') + ' waiting for your approval \u00B7 ' : '') + (n ? n + ' need your action (prices to approve, new requests to price, expired quotes to refresh, or accepted quotes to prepare and hand over)' : 'Nothing waiting \u2014 all requests have been answered') + ' \u00B7 ' + quotes.length + ' in total'
      : 'Requests from customers will appear here.';
    var approvals = f === 'approval' && !digestKey;
    paintKpis(f); paintDigest(f);
    if (paintView()) { paintBadge(); return; }                           // the board shows every quote in fulfilment, whatever the filters say
    $('sxqHead').innerHTML = approvals
      ? '<tr><th><span class="sr-only">Pick</span></th><th>Ref</th><th>Customer / item</th><th>Why it needs you</th><th>Cashier vs system price</th><th>Cost \u00B7 margin</th><th>Stock</th><th></th></tr>'
      : '<tr><th>Ref</th><th>Customer</th><th>Item</th><th>Quantity</th><th>Needed by</th><th>Received</th><th>Status</th><th></th></tr>';
    if (batchFocus && !list.some(function (x) { return keyOf(x) === batchFocus; })) batchFocus = null;   // the group was approved or sent back: show everything again
    if (approvals && batchFocus) list = list.filter(function (x) { return keyOf(x) === batchFocus; });
    if (approvals) { $('sxqBody').innerHTML = list.length ? list.map(approvalRow).join('') : '<tr><td colspan="8" class="sx-empty">No prices are waiting for you. The cashiers\u2019 prices that met every rule went straight to the customers.</td></tr>'; paintBatch(); paintBadge(); return; }
    $('sxqBatch').innerHTML = '';
    $('sxqBody').innerHTML = list.length ? list.map(function (x) {
      return '<tr class="sx-click" tabindex="0" data-qrow="' + esc(x.id) + '"><td>' + esc(x.id) + '</td><td>' + esc(x.customer) + (x.source === 'pos' ? ' <span class="faint" style="font-size:12px">\u00B7 Walk-in</span>' : '') + '<div class="faint" style="font-size:12px">' + esc(x.phone) + '</div></td>' +
        '<td>' + esc(x.product || 'Custom item') + (x.sku ? '<div class="faint" style="font-size:12px">' + esc(x.sku) + '</div>' : '') + '</td>' +
        '<td>' + esc(x.quantity) + '</td><td>' + esc(x.neededBy ? day(x.neededBy) : x.neededMonths ? 'within ' + months(x.neededMonths) : '\u2014') + '</td><td>' + esc(when(x.createdAt)) + '</td><td>' + qPill(x) + expiryHtml(x) + guideHtml(x) + (x.status === 'pending_approval' ? '<div class="faint" style="font-size:12px;margin-top:4px">' + peso(x.proposedAmount || 0) + (x.proposedBy ? ' \u00B7 by ' + esc(x.proposedBy) : '') + '</div>' : '') + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="' + (needsAction(x) ? 'btn-primary' : 'btn-secondary') + ' btn-sm" data-sxq="' + esc(x.id) + '"' + (stageOf(x) === 'deposit' ? ' data-dep="1"' : '') + '>' + (x.status === 'pending_approval' ? 'Review price' : x.status === 'new' ? 'Reply' : IN_FLOW.indexOf(x.status) >= 0 ? (stageOf(x) === 'deposit' ? 'Record ' + depWord(x) : 'Manage') : (x.status === 'quoted' && (x.expired || x.costStale) ? 'Refresh price' : 'View')) + '</button></td></tr>';
    }).join('') : '<tr><td colspan="8" class="sx-empty">' + (quotes.length ? 'No requests in this view.' : 'No quote requests yet.') + '</td></tr>';
    paintBadge();
  }
  /* ---- the exceptions queue (Task 5): only prices that failed a rule reach Finance; one tap to approve, or a batch with the same reason ---- */
  var RULE_LABEL = { not_priced: 'Typed by hand (not priced by the system)', under_band: 'Below the system price band', over_band: 'Above the system price band', faster: 'Faster than the system can support', late: 'After the customer\u2019s needed-by date', not_costed: 'Cannot be priced yet', below_cost: 'Below cost', below_margin: 'Below the minimum margin', outside_band: 'Outside the tolerance band',
    over_limit: 'Over the cashier limit', stock_short: 'Not enough stock', partial_terms: 'Partial-payment terms', checks_unavailable: 'Automatic checks unavailable' };
  var keyOf = function (x) { var ck = x.approvalCheck || {}; return (ck.rules || []).slice().sort().join('+') || 'unknown'; };
  var keyLabel = function (k) { return k === 'unknown' ? 'No recorded rule' : k.split('+').map(function (r) { return RULE_LABEL[r] || r; }).join(' + '); };
  var qnum = function (n) { return (+Number(n).toFixed(4)).toLocaleString('en-PH', { maximumFractionDigits: 4 }); };
  /* recurring customer: what this customer was last quoted for the same product (the server adds x.lastQuote to prices waiting for Finance) */
  var signed = function (n) { return (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n) + '%'; };
  var lastQuoteLine = function (lq, withId) {
    if (!lq) return '';
    var at = lq.at ? new Date(lq.at).toLocaleDateString('en-PH', { timeZone: TZ, month: 'short', day: 'numeric' }) : '';
    return 'Last quoted ' + peso(lq.amount) + (at ? ' on ' + at : '') + (withId ? ' (' + lq.id + ')' : '') + ' \u00B7 ' + (lq.sameQuantity ? 'same quantity' : lq.quantity ? lq.quantity : 'other quantity') +
      (lq.costDriftPct != null ? ' \u00B7 cost ' + (lq.costDriftPct === 0 ? 'unchanged' : 'changed ' + signed(lq.costDriftPct)) : '');
  };
  function approvalRow(x) {
    var ck = x.approvalCheck || {}, n = ck.numbers || {}, cash = n.cashierTotal != null ? n.cashierTotal : x.proposedAmount;
    var short = (n.shortfalls || []);
    return '<tr class="sx-click' + ((ageInfo(x) || {}).late ? ' sx-latepick' : '') + '" tabindex="0" data-qrow="' + esc(x.id) + '"><td><input type="checkbox" data-pick="' + esc(x.id) + '" data-key="' + esc(keyOf(x)) + '" aria-label="Pick ' + esc(x.id) + '"></td><td>' + esc(x.id) + '</td>' +
      '<td>' + esc(x.customer) + (x.source === 'pos' ? ' <span class="faint" style="font-size:12px">\u00B7 Walk-in</span>' : '') + '<div class="faint" style="font-size:12px">' + esc(x.product || 'Custom item') + ' \u00B7 ' + esc(x.quantity) + (x.proposedBy ? ' \u00B7 by ' + esc(x.proposedBy) : '') + '</div>' + ageHtml(x) + '</td>' +
      '<td class="sx-why">' + esc((ck.reasons && ck.reasons.length ? ck.reasons : [x.approvalReason || 'Not given']).join('; ')) + '<small>' + esc(keyLabel(keyOf(x))) + '</small></td>' +
      '<td class="sx-num">' + peso(cash || 0) + '<small>' + (n.systemTotal != null ? 'system ' + peso(n.systemTotal) + ' (' + (n.deviationPct > 0 ? '+' : '') + n.deviationPct + '%)' : 'no system price') + '</small>' +
        (x.lastQuote ? '<small class=\"sx-lastq\" title=\"' + esc(lastQuoteLine(x.lastQuote, true)) + '\">last ' + peso(x.lastQuote.amount) + (x.lastQuote.priceDriftPct != null ? ' (' + signed(x.lastQuote.priceDriftPct) + ' now)' : '') + '</small>' : '') + '</td>' +
      '<td class="sx-num">' + (n.costTotal != null ? peso(n.costTotal) + '<small class="' + (n.marginPct < 0 ? 'sx-bad' : '') + '">margin ' + n.marginPct + '%</small>' : '<span class="sx-bad">not costed</span>') + '</td>' +
      '<td class="sx-why">' + (short.length ? short.map(function (s) { return '<span class="sx-bad">' + esc(s.name) + ' short by ' + qnum(s.short) + ' ' + esc(s.unit) + '</span>'; }).join('<br>') : '<span class="sx-okc">OK</span>') + '</td>' +
      '<td style="white-space:nowrap"><button type="button" class="btn-primary btn-sm" data-sxapprove="' + esc(x.id) + '">Approve</button> <button type="button" class="btn-secondary btn-sm" data-sxq="' + esc(x.id) + '">Review / return</button></td></tr>';
  }
  function paintBatch() {
    var box = $('sxqBatch'); if (!box || $('sxqFilter').value !== 'approval') return;
    var waiting = quotes.filter(function (x) { return x.status === 'pending_approval'; }), groups = {};
    waiting.forEach(function (x) { var k = keyOf(x); (groups[k] = groups[k] || []).push(x.id); });
    var picked = Array.prototype.map.call($('sxqBody').querySelectorAll('[data-pick]:checked'), function (c) { return { id: c.dataset.pick, key: c.dataset.key }; });
    var keys = Object.keys(groups).filter(function (k) { return k !== 'unknown' && groups[k].length > 1; });
    var same = picked.length && picked.every(function (p) { return p.key === picked[0].key; });
    keys.sort(function (a, b) { return groups[b].length - groups[a].length; });
    var banners = keys.map(function (k) {
      var ms = waiting.filter(function (x) { return keyOf(x) === k; }), s = batchStats(ms), blocked = bulkBlocked(k), focus = batchFocus === k;
      return '<div class="sx-bgroup' + (blocked.length ? ' blocked' : '') + '"><div class="sx-bg-txt"><b>' + ms.length + ' quotes failed for the same reason: ' + esc(keyLabel(k)) + '</b>' +
        '<span>' + peso(s.total) + ' in total' + (s.minMargin != null ? ' \u00B7 lowest margin ' + s.minMargin + '%' : '') + (s.oldestHrs >= 1 ? ' \u00B7 oldest waiting ' + (s.oldestHrs >= 48 ? Math.floor(s.oldestHrs / 24) + ' days' : s.oldestHrs + ' h') : '') + '</span>' +
        (blocked.length ? '<span class="sx-bad">Not approved in bulk (' + esc(blocked.map(function (r) { return RULE_LABEL[r] || r; }).join(', ').toLowerCase()) + '): open each quote and decide.</span>' : '') + '</div>' +
        '<div class="sx-bg-act"><button type="button" class="btn-secondary btn-sm" data-bfocus="' + esc(k) + '">' + (focus ? 'Show all ' + waiting.length + ' waiting' : 'Review individually') + '</button>' +
        (blocked.length ? '' : '<button type="button" class="btn-primary btn-sm" data-batch="' + esc(k) + '">Approve all ' + ms.length + '</button>') + '</div></div>';
    }).join('');
    box.innerHTML = banners + (picked.length ? (same ? (bulkBlocked(picked[0].key).length ? '<span class="sx-chip sx-bad">Those picked cannot be approved together (' + esc(keyLabel(picked[0].key)) + '): decide on each one</span>'
        : '<button type="button" class="btn-primary btn-sm" data-batch="picked">Approve the ' + picked.length + ' picked (' + esc(keyLabel(picked[0].key)) + ')</button>')
        : '<span class="sx-chip sx-bad">Pick quotes with the same reason to approve them together</span>') : '');
  }
  /* the same reasons the server refuses in a batch (quote-automation.js NO_BULK) */
  var NO_BULK = ['below_cost', 'not_costed', 'stock_short'];
  var bulkBlocked = function (key) { return String(key || '').split('+').filter(function (r) { return NO_BULK.indexOf(r) >= 0; }); };
  var batchFocus = null;                                                  // a reason key: the approvals table shows only that group (\"Review individually\")
  var cashierPrice = function (x) { var n = (x.approvalCheck || {}).numbers || {}; return n.cashierTotal != null ? n.cashierTotal : (x.proposedAmount || 0); };
  function batchStats(list) {
    var total = 0, min = null, oldest = 0;
    list.forEach(function (x) {
      var n = (x.approvalCheck || {}).numbers || {}; total += cashierPrice(x);
      if (n.marginPct != null && (min == null || n.marginPct < min)) min = n.marginPct;
      if (x.proposedAt) oldest = Math.max(oldest, Math.floor((Date.now() - x.proposedAt) / 36e5));
    });
    return { total: total, minMargin: min, oldestHrs: oldest };
  }
  async function batchApprove(which) {
    var nos, key;
    if (which === 'picked') {
      var p = Array.prototype.map.call($('sxqBody').querySelectorAll('[data-pick]:checked'), function (c) { return c; });
      nos = p.map(function (c) { return c.dataset.pick; }); key = p.length ? p[0].dataset.key : '';
    } else { key = which; nos = quotes.filter(function (x) { return x.status === 'pending_approval' && keyOf(x) === key; }).map(function (x) { return x.id; }); }
    if (!nos.length) return;
    if (bulkBlocked(key).length) { toast('Cannot be approved in bulk (' + keyLabel(key) + '): open each quote and decide on it.', true); return; }
    var chosen = nos.map(function (no) { return quotes.find(function (q) { return q.id === no; }); }).filter(Boolean), st = batchStats(chosen);
    var rows = chosen.slice(0, 8).map(function (x) { var n = (x.approvalCheck || {}).numbers || {}; return [x.id + ' \u00B7 ' + (x.customer || 'Customer'), peso(cashierPrice(x)) + (n.marginPct != null ? ' \u00B7 ' + n.marginPct + '%' : '')]; });
    if (chosen.length > 8) rows.push(['+ ' + (chosen.length - 8) + ' more', '']);
    rows.push(['Total', peso(st.total)]); if (st.minMargin != null) rows.push(['Lowest margin', st.minMargin + '%']);
    var okGo = window.uiConfirm ? await window.uiConfirm({ title: 'Approve ' + nos.length + ' price' + (nos.length === 1 ? '' : 's') + '?', message: 'All of them wait for the same reason: ' + keyLabel(key) + '. Each is logged with your name, and the customers are told.',
      lines: rows, confirm: 'Approve ' + nos.length }) : true;
    if (!okGo) return;
    try {
      var r = await api('/finance/quotes/approve-batch', { method: 'POST', body: JSON.stringify({ quotes: nos, reasonKey: key }) });
      toast('Approved ' + r.approved.length + (r.skipped.length ? '; skipped ' + r.skipped.map(function (s) { return s.quote + ' (' + s.why + ')'; }).join(', ') : '') + '.', !!r.skipped.length);
    } catch (e) { toast((e.fields && Object.values(e.fields)[0]) || e.message, true); }
    loadQuotes();
  }
  async function quickApprove(no) {
    var x = quotes.find(function (q) { return q.id === no; }); if (!x) return;
    try { await api('/finance/quotes/' + encodeURIComponent(no) + '/approve-price', { method: 'POST', body: '{}' }); toast('Approved: ' + no + ' is sent to the customer at ' + peso(x.proposedAmount || 0) + '.'); }
    catch (e) { toast((e.fields && Object.values(e.fields)[0]) || e.message, true); }
    loadQuotes();
  }

  /* ---- purchase suggestions from accepted quotes & low-stock alerts ---- */
  var suggestions = [];
  var sxpFilterVal = 'open';
  async function loadSuggestions() {
    if (!$('sxpBody')) return;
    var flt = ($('sxpFilter') && $('sxpFilter').value) || sxpFilterVal || 'open';
    sxpFilterVal = flt;
    try { suggestions = await api('/finance/purchase-suggestions?status=' + encodeURIComponent(flt)); }
    catch (e) { $('sxpSub').textContent = 'Could not load the purchase suggestions: ' + e.message; return; }
    var overdueCount = suggestions.filter(function(s) { return s.status === 'ordered' && s.isOverdue; }).length;
    var subMsg = suggestions.length ? suggestions.length + ' item' + (suggestions.length === 1 ? '' : 's') + ' in this view.' : 'No items in this view.';
    if (overdueCount > 0) subMsg += ' <b style="color:#b91c1c;margin-left:6px">' + overdueCount + ' supplier deliver' + (overdueCount === 1 ? 'y is' : 'ies are') + ' OVERDUE!</b>';
    $('sxpSub').innerHTML = subMsg;
    $('sxpBody').innerHTML = suggestions.length ? suggestions.map(function (s) {
      var srcBadge = s.source === 'low_stock'
        ? '<span style="background:#fee2e2;color:#991b1b;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">Low Stock</span>'
        : (s.quote ? '<span style="background:#e0f2fe;color:#0369a1;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">Quote ' + esc(s.quote) + '</span>'
          : '<span style="background:#f3f4f6;color:#374151;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">' + esc(s.source) + '</span>');
      var supText = s.supplierName
        ? esc(s.supplierName) + '<div class="faint" style="font-size:11.5px">' + (s.leadTimeDays || 7) + ' day lead time</div>'
        : '<span class="faint">\u2014</span>';
      var costText = s.estimatedCost != null
        ? peso(s.estimatedCost)
        : (s.unitCost ? peso(s.quantity * s.unitCost) : '<span class="faint">\u2014</span>');
      var timingText = '';
      if (s.status === 'ordered') {
        var expDateStr = s.expectedArrival ? new Date(s.expectedArrival).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }) : '\u2014';
        if (s.isOverdue) {
          timingText = '<span style="background:#fee2e2;color:#b91c1c;padding:2px 7px;border-radius:4px;font-size:11.5px;font-weight:700">LATE (' + s.daysOverdue + 'd overdue)</span><div class="faint" style="font-size:11px;margin-top:2px">Expected: ' + expDateStr + '</div>';
        } else {
          timingText = '<span style="background:#fef3c7;color:#92400e;padding:2px 7px;border-radius:4px;font-size:11.5px;font-weight:600">Pending Delivery</span><div class="faint" style="font-size:11px;margin-top:2px">Expected: ' + expDateStr + '</div>';
        }
      } else if (s.status === 'received') {
        timingText = '<span style="background:#dcfce7;color:#15803d;padding:2px 7px;border-radius:4px;font-size:11.5px;font-weight:600">Received</span>' + (s.note ? '<div class="faint" style="font-size:11px;margin-top:2px">' + esc(s.note) + '</div>' : '');
      } else {
        timingText = '<span class="faint">' + esc(when(s.createdAt)) + '</span>';
      }
      var actions = '';
      var orderDateAttr = s.decidedAt ? new Date(s.decidedAt).toISOString().slice(0, 10) : (s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : '');
      if (s.status === 'open') {
        actions = '<button type="button" class="btn-primary btn-sm" data-stockin="' + esc(s.sku) + '" data-qty="' + qnum(s.quantity) + '" data-sup="' + (s.supplierId || '') + '" data-cost="' + (s.unitCost || '') + '" data-orderdate="' + orderDateAttr + '" style="margin-right:4px">Stock In</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-sxp="' + s.id + '" data-st="ordered" style="margin-right:4px">Ordered</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-sxp="' + s.id + '" data-st="dismissed" title="Dismiss">\u00D7</button>';
      } else if (s.status === 'ordered') {
        actions = '<button type="button" class="btn-primary btn-sm" data-stockin="' + esc(s.sku) + '" data-qty="' + qnum(s.quantity) + '" data-sup="' + (s.supplierId || '') + '" data-cost="' + (s.unitCost || '') + '" data-orderdate="' + orderDateAttr + '" style="margin-right:4px">Receive</button>' +
          '<button type="button" class="btn-secondary btn-sm" data-sxp="' + s.id + '" data-st="dismissed" title="Dismiss">\u00D7</button>';
      } else {
        actions = '<span class="faint">\u2014</span>';
      }
      return '<tr>' +
        '<td><b>' + esc(s.name) + '</b><div class="faint" style="font-size:12px">' + esc(s.sku) + '</div></td>' +
        '<td>' + srcBadge + '</td>' +
        '<td class="sx-num"><b>' + qnum(s.quantity) + ' ' + esc(s.unit) + '</b></td>' +
        '<td class="sx-num">' + qnum(s.onHand) + ' ' + esc(s.unit) + '</td>' +
        '<td class="sx-num"><b>' + costText + '</b></td>' +
        '<td>' + supText + '</td>' +
        '<td>' + timingText + '</td>' +
        '<td style="white-space:nowrap">' + actions + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="sx-empty">No purchase suggestions in this view.</td></tr>';
  }
  async function markSuggestion(id, st) {
    try { await api('/finance/purchase-suggestions/' + id, { method: 'POST', body: JSON.stringify({ status: st }) }); toast(st === 'ordered' ? 'Marked as ordered.' : 'Dismissed.'); }
    catch (e) { toast(e.message, true); }
    loadSuggestions();
  }

  /* ---- Finance's approval rules (Task 5 settings) ---- */
  var RULE_FIELDS = [['tolerancePct', 'Tolerance band around the system price', '\u00B1 %', 'Within this band (and every other rule) a cashier price goes straight to the customer.'],
    ['minMarginPct', 'Minimum margin', '%', 'Margin on the price. 0% = never below cost. A price under it always comes to you.'],
    ['valueLimit', 'Cashier order-value limit', '\u20B1', 'A quote total above this always comes to you.'],
    ['costMovePct', 'Flag when material cost moved by more than', '%', 'Checked again when the customer accepts.'],
    ['expiryReminderDays', 'Remind before a quote expires', 'days', 'The customer (or, for a walk-in, the cashier) is reminded.'],
    ['approvalRemindHours', 'Remind you when a price waits longer than', 'hours', 'A waiting price is never approved automatically.'],
    ['approvalEscalateHours', 'Escalate when it waits longer than', 'hours', 'Alerts Finance again and tells the cashier.']];
  var rulesOverlay = null;
  async function openRules() {
    if (!rulesOverlay) {
      rulesOverlay = document.createElement('div'); rulesOverlay.className = 'modal-overlay'; rulesOverlay.id = 'sxRulesOverlay';
      rulesOverlay.innerHTML = '<div class="account-modal sx-modal sx-rules" role="dialog" aria-modal="true" aria-labelledby="sxRulesTitle"><button type="button" class="modal-close" id="sxRulesClose" aria-label="Close">\u00D7</button><div id="sxRulesBody"></div></div>';
      document.body.appendChild(rulesOverlay);
      var close = function () { rulesOverlay.classList.remove('open'); };
      rulesOverlay.addEventListener('mousedown', function (e) { if (e.target === rulesOverlay) close(); });
      $('sxRulesClose').addEventListener('click', close);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rulesOverlay.classList.contains('open')) close(); });
    }
    rulesOverlay.classList.add('open'); $('sxRulesBody').innerHTML = '<p class="faint">Loading\u2026</p>';
    var r; try { r = await api('/finance/quote-rules'); } catch (e) { $('sxRulesBody').innerHTML = '<div class="sx-err show">' + esc(e.message) + '</div>'; return; }
    $('sxRulesBody').innerHTML = '<div class="sx-head"><h2 id="sxRulesTitle">Quote approval rules</h2></div>' +
      '<p class="faint" style="margin:0 0 10px">The cashier presses \u201CConfirm price\u201D and the system routes it: fully costed, in stock, inside the band, at or above the minimum margin and under the value limit goes straight to the customer. Anything else comes to you with the reason. Partial-payment terms always come to you.</p>' +
      (r.confirmed ? '<p class="faint" style="margin:0 0 10px">Last saved by ' + esc(r.updatedBy || 'Finance') + (r.updatedAt ? ' \u00B7 ' + esc(when(new Date(r.updatedAt).getTime())) : '') + '.</p>'
        : '<p class="sx-assume"><b>Starting values, not yet confirmed by Finance.</b> The cashier limit of ' + peso(r.valueLimit) + ' and the \u00B1' + r.tolerancePct + '% band are assumptions. Check them and press Save.</p>') +
      '<div class="sx-form"><div class="sx-two">' + RULE_FIELDS.map(function (f) { return '<div><label for="sxR_' + f[0] + '">' + esc(f[1]) + ' <span class="faint" style="font-weight:400">(' + esc(f[2]) + ')</span></label>' +
        '<input class="form-input" id="sxR_' + f[0] + '" inputmode="decimal" value="' + esc(r[f[0]]) + '"><div class="faint" style="font-size:12px;margin-top:3px">' + esc(f[3]) + '</div></div>'; }).join('') + '</div>' +
      '<div class="sx-err" id="sxRulesErr" role="alert"></div><div class="sx-actions"><button type="button" class="btn-primary" id="sxRulesSave">Save rules</button></div></div>';
    $('sxRulesSave').addEventListener('click', async function () {
      var body = {}; RULE_FIELDS.forEach(function (f) { body[f[0]] = $('sxR_' + f[0]).value.trim(); });
      $('sxRulesErr').classList.remove('show'); this.disabled = true;
      try { await api('/finance/quote-rules', { method: 'PUT', body: JSON.stringify(body) }); toast('Approval rules saved. They apply to the next price a cashier confirms.'); rulesOverlay.classList.remove('open'); }
      catch (e) { var k = e.fields && Object.keys(e.fields)[0]; $('sxRulesErr').textContent = k ? e.fields[k] : e.message; $('sxRulesErr').classList.add('show'); if (k && $('sxR_' + k)) $('sxR_' + k).focus(); }
      finally { this.disabled = false; }
    });
  }

  function paintBadge() {
    var nav = document.querySelector('.nav-item[data-page="quotes"]'); if (!nav) return;
    var n = approvalCount(), b = nav.querySelector('.sx-badge');
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'sx-badge'; nav.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n); b.title = n + ' cashier price(s) waiting for your approval';
  }
  async function loadQuotes() {
    if (loadingQ) return; loadingQ = true;
    try {
      if (!qopts) { try { qopts = await api('/finance/quote-options'); } catch (e) { /* the reply form shows a message if this is still missing */ } }
      if (!rulesLoaded) { rulesLoaded = true; try { var rr = await api('/finance/quote-rules'); if (rr && +rr.expiryReminderDays > 0) expiryWarn = +rr.expiryReminderDays; if (rr && +rr.approvalRemindHours > 0) remindH = +rr.approvalRemindHours; if (rr && +rr.approvalEscalateHours > 0) escalateH = +rr.approvalEscalateHours; } catch (e) { /* the default of 2 days stays */ } }
      var d = await api('/finance/quotes'); quotes = Array.isArray(d) ? d : [];
      watchDeposits();
      loadSuggestions();
      if (!pickedFilter && $('sxqFilter')) { pickedFilter = true; $('sxqFilter').value = approvalCount() ? 'approval' : 'open'; }
      if (!(openQuote && busy)) renderQuotes();
      if (openQuote && !busy) paintQuote();
    } catch (e) { if (e.message !== 'Not signed in' && $('sxqSub') && !quotes.length) $('sxqSub').textContent = 'Could not load quote requests: ' + e.message; }
    finally { loadingQ = false; }
  }

  var overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.id = 'sxOverlay';
    overlay.innerHTML = '<div class="account-modal sx-modal" role="dialog" aria-modal="true"><button type="button" class="modal-close" id="sxClose" aria-label="Close">\u00D7</button><div id="sxBody"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !busy) closeModal(); });
    $('sxClose').addEventListener('click', function () { if (!busy) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open') && !busy) closeModal(); });
    return overlay;
  }
  function closeModal() { openQuote = null; if (overlay) overlay.classList.remove('open'); }
  function openQ(id) { openQuote = id; paintQuote(); ensureOverlay().classList.add('open'); }
  var info = function (label, value) { return value ? '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>' : ''; };

  function paintQuote() {
    var x = quotes.find(function (q) { return q.id === openQuote; });
    ensureOverlay();
    if (!x) { closeModal(); return; }
    var o = qopts || { leadTimes: [], validDays: [7] };
    var h = '<div class="sx-head"><h2>Quote \u00B7 ' + esc(x.id) + '</h2>' + qPill(x) + '</div>' +
      '<dl class="sx-info">' + info('Customer', x.customer) + info('Phone', x.phone) + info('Email', x.email) + info('Came from', x.source === 'pos' ? 'Walk-in at the counter (no account \u2014 reply by phone)' : 'Online shop') + info('Item', x.product || 'Custom item') + info('SKU', x.sku) +
      info('Quantity', x.quantity) + info('Needed by', x.neededBy ? day(x.neededBy) : (x.neededMonths ? 'within ' + months(x.neededMonths) : '')) + info('Receive by', x.fulfillment ? x.fulfillment + (x.area ? ' \u00B7 ' + x.area : '') : '') + info('Received', when(x.createdAt)) + '</dl>' +
      '<div class="sx-box"><b>Sizes and details</b>' + esc(x.details) + '</div>';
    var inFlow = IN_FLOW.indexOf(x.status) >= 0;
    var guided = !inFlow && x.status !== 'completed' && x.status !== 'declined';   // the system fills in the price and dates; Finance confirms or explains
    if (['new', 'pending_approval', 'awaiting_details'].indexOf(x.status) < 0) {           // nothing was sent to the customer yet in these
      var title = { quoted: x.expired ? 'Quote sent (expired)' : 'Quote sent', declined: 'Customer declined this quote', closed: 'Closed' + (x.closeReason ? ': ' + x.closeReason : ''), completed: (x.statusLabel || 'Completed') }[x.status] || 'Customer accepted this quote';
      h += '<div class="sx-box"><b>' + esc(title) + (x.quotedAmount != null ? ' \u2014 ' + peso(x.quotedAmount) : '') + '</b>' +
        (x.leadTime ? 'Ready in: ' + esc(x.leadTime) + '\n' : '') + (x.payMethod && x.status !== 'quoted' && x.status !== 'declined' ? 'Payment method: ' + esc(x.payMethod) + (x.payOnline ? ' (the customer pays online; it is recorded automatically when paid)' : x.payLater ? ' (the cashier collects it and records it; you are told when it is recorded)' : '') + '\n' : '') + (x.validUntil && x.status === 'quoted' ? 'Price valid until: ' + esc(day(x.validUntil)) + (expiryInfo(x) ? ' (' + expiryInfo(x).text + ')' : '') + '\n' : '') +
        (x.handledBy ? 'Handled by ' + esc(x.handledBy) + (x.updatedAt ? ' \u00B7 ' + esc(when(x.updatedAt)) : '') + '\n' : '') + (x.replyNote ? esc(x.replyNote) : '') +
        (x.respondedAt && x.status !== 'quoted' ? '\nAnswered: ' + esc(when(x.respondedAt)) + (x.responseNote ? ' \u2014 ' + esc(x.responseNote) : '') : '') + '</div>';
    }
    var qn = parseFloat(String(x.quantity || '').replace(/,/g, '')) || 0, ap = '';
    if (x.status === 'pending_approval') ap = '<div class="sx-approve"><div class="sx-approve-head"><b>Cashier price waiting for your approval</b><span>' + esc(x.proposedBy ? 'from ' + x.proposedBy : 'from the counter') + (x.proposedAt ? ' \u00B7 ' + esc(when(x.proposedAt)) : '') + '</span>' + ageHtml(x) + '</div>' +
      '<div class="sx-approve-grid"><div><span>Proposed total</span><strong>' + peso(x.proposedAmount || 0) + '</strong>' + (qn ? '<small>' + peso((x.proposedAmount || 0) / qn) + ' each \u00D7 ' + esc(x.quantity) + '</small>' : '') + '</div>' +
      (x.suggestedAmount != null ? '<div><span>System price</span><strong>' + peso(x.suggestedAmount) + '</strong><small>' +
        (x.proposedAmount ? (function (d) { return d === 0 ? 'same as the cashier' : 'cashier is ' + Math.abs(d).toFixed(1) + '% ' + (d < 0 ? 'lower' : 'higher'); })(Math.round(((x.proposedAmount - x.suggestedAmount) / x.suggestedAmount) * 1000) / 10) : '') +
        (x.suggestedCost != null ? ' \u00B7 cost ' + peso(x.suggestedCost) : '') + '</small></div>' : '') +
      '<div><span>Ready in</span><strong>' + esc(x.proposedLeadTime || '\u2014') + '</strong></div><div><span>Price valid</span><strong>' + esc(x.proposedValidDays ? x.proposedValidDays + ' days' : '\u2014') + '</strong></div></div>' +
      (x.costStale ? '<p class="sx-stale" style="color:#b32929"><span>Cost changed</span>' + esc(x.costStale) + '</p>' : '') +
      (function (n) { return n.costTotal != null ? '<p><span>Cost and margin</span>Cost ' + peso(n.costTotal) + ' \u00B7 margin ' + n.marginPct + '% on the cashier price' + (n.minMarginPct ? ' (minimum ' + n.minMarginPct + '%)' : '') + '</p>' : '<p class="sx-bad"><span>Cost</span>Not costed: the system could not work out the cost</p>'; })((x.approvalCheck || {}).numbers || {}) +
      (((x.approvalCheck || {}).numbers || {}).shortfalls || []).map(function (s) { return '<p class="sx-bad"><span>Stock</span>' + esc(s.name) + ' short by ' + qnum(s.short) + ' ' + esc(s.unit) + '</p>'; }).join('') +
      (x.lastQuote ? '<p class=\"sx-lastq-row\"><span>Repeat customer</span>' + esc(lastQuoteLine(x.lastQuote, true)) + (x.lastQuote.priceDriftPct != null ? '<br>The cashier\u2019s price is ' + (x.lastQuote.priceDriftPct === 0 ? 'the same per unit as' : Math.abs(x.lastQuote.priceDriftPct) + '% ' + (x.lastQuote.priceDriftPct > 0 ? 'above' : 'below')) + ' the last quote.' : '') +
        (x.lastQuote.times > 1 ? ' <span class=\"faint\">(quoted ' + x.lastQuote.times + ' times before)</span>' : '') +
        (x.lastQuote.adjustedTotal != null ? '<br><button type=\"button\" class=\"btn-secondary btn-sm\" id=\"sxUseLast\" data-amt=\"' + x.lastQuote.adjustedTotal + '\">Use last price moved by the cost change: ' + peso(x.lastQuote.adjustedTotal) + '</button> <span class=\"faint\">fills the amount below; nothing is sent until you press Send my own price</span>' : '') + '</p>' : '') +
      '<p><span>Why it needs you</span>' + esc(x.approvalReason || 'Not given') + '</p>' +
      '<p class="faint">Approve to send this price to the customer, or send it back to the cashier with a note on what to change. You can also type your own price below.</p></div>';
    if (ap) h = h.replace('<dl class="sx-info">', ap + '<dl class="sx-info">');                       // first thing Finance sees
    else if (x.financeNote && x.status === 'new') h += '<div class="sx-box"><b>You sent the cashier\u2019s price back</b>' + esc(x.financeNote) + (x.proposedAmount ? '\nTheir price was ' + peso(x.proposedAmount) + '.' : '') + '</div>';
    var ac = x.acceptCheck;
    if (ac && (ac.flags || []).length) h += '<div class="sx-box sx-warnbox"><b>Checked again when the customer accepted</b>' + esc((ac.reasons || []).join('\n')) + '</div>';
    // a custom item (no catalog product) is made with a job order: its raw materials and finishing supplies are issued here
    if (!x.sku && ['accepted', 'preparing', 'ready', 'completed'].indexOf(x.status) >= 0) h += '<div class="sx-box sx-job" id="sxJob"><b>Job order: materials for this custom item</b><span class="faint">Loading\u2026</span></div>';
    if (inFlow || x.status === 'completed') {
      var steps = (x.progress || []).map(function (e) { return '\u2022 ' + esc(e.label) + ' \u2014 ' + esc(when(e.at)) + (e.note ? ' (' + esc(e.note) + ')' : ''); }).join('\n');
      h += '<div class="sx-box"><b>Progress</b>' + steps + '</div>';
      var pays = (x.payments || []).map(function (p) { return '\u2022 ' + peso(p.amount) + ' \u00B7 ' + esc(p.method) + ' \u2014 ' + esc(when(p.at)) + (p.note ? ' (' + esc(p.note) + ')' : ''); }).join('\n');
      h += '<div class="sx-box"><b>Payment \u2014 paid ' + peso(x.paidAmount || 0) + ' of ' + peso(x.quotedAmount || 0) + (x.balance > 0 ? ' \u00B7 balance ' + peso(x.balance) : ' \u00B7 fully paid') + '</b>' + (pays || 'No payment recorded yet.') + '</div>';
    }
    h += '<div class="sx-form">';
    if (inFlow) {
      if (x.balance > 0) {
        /* Finance does not key payments in. Online money is recorded by Xendit itself; money taken on pickup / delivery is taken (and
           recorded, into the cashier's own drawer) by the cashier. Finance sees it arrive and can nudge whoever has to move it. */
        var ready = x.status === 'ready', later = !x.payOnline;
        h += '<div class="sx-sub">Payment follow-up — ' + peso(x.balance) + ' still to pay</div>' +
          '<p class="sx-depnote"><b>' + esc(x.dueNow > 0 ? (termsLine(x) || 'Approved payment terms') : (x.payOnline ? 'Paid online' : 'Paid at ' + (x.fulfillment === 'Delivery' ? 'delivery' : 'pickup'))) + '</b><br>' +
          (x.payOnline ? 'The customer pays through Xendit and it is recorded automatically the moment it arrives. Nobody types it in.'
            : 'The cashier collects it ' + (x.fulfillment === 'Delivery' ? 'on delivery' : 'at pickup') + ' and records it in the Quote Desk (cash goes into their open drawer). You are told when it is recorded.') +
          (later && !ready ? '<br><span class="faint">Reminders to the cashier start once the order is ready.</span>' : '') + '</p>' +
          '<div class="sx-actions">' +
          (x.payOnline ? '<button type="button" class="btn-secondary" id="sxCheckPay">Check online payment</button>' : '') +
          ((x.payOnline || ready) && x.source !== 'pos' ? '<button type="button" class="btn-secondary" id="sxRemindCust">Remind customer</button>' : '') +
          (ready ? '<button type="button" class="btn-secondary" id="sxRemindCash">Remind cashier to collect</button>' : '') + '</div>' +
          (x.source === 'pos' ? '<p class="faint" style="margin:6px 0 0">Walk-in quote: there is no online account, so the cashier is the one who calls the customer.</p>' : '');
      }
      if (x.next) h += '<p class="faint" style="margin:12px 0 0">Next step: <b>' + esc(x.nextLabel) + '</b>. The cashier does this' + (x.next === 'completed' ? ' once the balance is paid' : '') + '; you are told when it happens.</p>';
    } else if (x.status !== 'completed') {
      h += '<label for="sxAmount">Total quoted amount (\u20B1) <span class="faint" style="font-weight:400">(required to send a quote)</span></label><input type="text" data-money class="form-input" id="sxAmount" inputmode="decimal" autocomplete="off" placeholder="e.g. 164000.00" value="' + (x.quotedAmount != null ? MoneyInput.fmt(x.quotedAmount) : '') + '">' +
        (!guided ? '<div class="sx-two"><div><label for="sxLead">Ready in</label><select id="sxLead" class="form-input"><option value="">Choose</option>' + (o.leadTimes || []).map(function (t) { return '<option value="' + esc(t) + '"' + (x.leadTime === t ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="sxDays">Price valid for</label><select id="sxDays" class="form-input">' + (o.validDays || [7]).map(function (d) { return '<option value="' + d + '"' + (d === 7 ? ' selected' : '') + '>' + d + ' days</option>'; }).join('') + '</select></div></div>' : '<div class="faint" id="sxAmtHint" style="margin-top:4px;font-size:13px">Working out the system price\u2026</div>' +
        '<div class="sx-two"><div><label for="sxReady">Ready by</label><input type="date" class="form-input" id="sxReady"><div class="faint" id="sxReadyHint" style="margin-top:4px;font-size:13px"></div></div>' +
        '<div><label for="sxValid">Price valid until</label><input type="date" class="form-input" id="sxValid"><div class="faint" id="sxValidHint" style="margin-top:4px;font-size:13px"></div></div></div>' +
        '<ul class="sx-chk" id="sxChecks"></ul><div class="sx-box sx-warnbox" id="sxNeed" hidden style="margin-top:12px"></div>');
      if (!qopts && !guided) h += '<div class="sx-err show">Could not load the lead-time choices. Press Refresh and open this request again.</div>';
    }
    sxDraft = x.status === 'pending_approval' && window.QuoteGuide && window.QuoteGuide.returnNote ? window.QuoteGuide.returnNote(x) : '';   // pre-filled send-back note
    if (x.status !== 'completed') h += '<label for="sxNote">' + (x.status === 'pending_approval' ? 'Note to the cashier, or message to the customer' : inFlow ? 'Note' : 'Message to the customer') + ' <span class="faint" style="font-weight:400">(' + (x.status === 'pending_approval' ? (sxDraft ? 'drafted from the rules this price failed: edit it, it is only sent when you press Send back' : 'needed when you send the price back') : 'optional' + (inFlow ? ', used if you cancel this quote' : '')) + ')</span></label><textarea id="sxNote" class="form-input" maxlength="1500" placeholder="' + (inFlow ? 'e.g. Why this quote is being cancelled.' : 'e.g. Price is per full quantity. Delivery fee is extra.') + '">' + esc(x.status === 'pending_approval' ? sxDraft : x.status === 'new' || inFlow ? '' : (x.replyNote || '')) + '</textarea>';
    h += '<div class="sx-err" id="sxErr" role="alert"></div><div class="sx-actions">';
    if (x.status === 'quoted' && !(x.paidAmount > 0)) h += '<button type="button" class="btn-secondary" id="sxRefreshPrice">Refresh price at today\u2019s costs</button>';
    if (x.status === 'pending_approval') h += '<button type="button" class="btn-primary" id="sxApprovePrice">Approve ' + peso(x.proposedAmount || 0) + '</button><button type="button" class="btn-secondary" id="sxReturnPrice">Send back to cashier</button>';
    if (!inFlow && x.status !== 'completed') h += '<button type="button" class="' + (x.status === 'pending_approval' ? 'btn-secondary' : 'btn-primary') + '" id="sxSend">' + (x.status === 'pending_approval' ? 'Send my own price instead' : x.status === 'new' ? 'Send quote' : 'Send updated quote') + '</button>';
    if (x.status !== 'completed') h += '<button type="button" class="btn-secondary" id="sxCloseReq">' + (x.status === 'closed' ? 'Keep closed' : inFlow ? 'Cancel this quote' : 'Close request') + '</button>';
    if (x.status !== 'new' && !inFlow && x.status !== 'completed') h += '<button type="button" class="btn-secondary" id="sxReopen">Reopen</button>';
    h += '</div>';
    if (x.status !== 'completed' && x.status !== 'closed') {
      var reasons = (qopts && qopts.closeReasons) || [];
      h += '<div class="sx-closebox" id="sxCloseBox" hidden><div class="sx-sub">' + (inFlow ? 'Cancel this quote' : 'Close this request') + '</div>' +
        '<label for="sxCloseReason">Reason <span class="faint" style="font-weight:400">(required; the customer is told)</span></label><select id="sxCloseReason" class="form-input"><option value="">Choose the reason</option>' +
        reasons.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.label) + '</option>'; }).join('') + '</select>' +
        '<p class="faint" style="margin:6px 0 0">Add details in the message box above' + (x.paidAmount > 0 ? ' (required: payments were received, say how they are refunded or settled)' : ' (required for "Other reason")') + '.</p>' +
        '<div class="sx-actions"><button type="button" class="btn-danger" id="sxCloseGo">' + (inFlow ? 'Cancel quote' : 'Close request') + '</button><button type="button" class="btn-secondary" id="sxCloseBack">Back</button></div></div>';
    }
    h += '</div>';
    if (guided) h += '<div class="sx-box" id="sxWhy"><b>Why the system suggests this</b><span class="faint">Loading\u2026</span></div>';
    h += '<div class="sx-box sx-log" id="sxLog"><b>Decision log</b><span class="faint">Loading\u2026</span></div>';
    $('sxBody').innerHTML = h;
    var noteCheck;
    if ($('sxNote') && window.FormAssist) noteCheck = FormAssist.validation.bind($('sxNote'), function (value) {
      var note = value.trim();
      if ($('sxCloseBox') && !$('sxCloseBox').hidden) {
        if ($('sxCloseReason')?.value === 'other' && note.length < 10) return 'Explain the reason (at least 10 characters).';
        if (x.paidAmount > 0 && note.length < 5) return 'Write how the payment is refunded or settled (at least 5 characters).';
      }
      return note && note.length < 5 ? 'Write at least 5 characters, or leave the message empty.' : '';
    });
    if (window.FormAssist) {
      if ($('sxAmount')) FormAssist.validation.bind($('sxAmount'), function(value) { return !(MoneyInput.parse(value) > 0) ? 'Enter a quoted amount greater than zero.' : ''; });
      ['sxReady','sxValid','sxLead','sxDays','sxCloseReason'].forEach(function(id) {
        var input = $(id); if (!input) return;
        FormAssist.validation.bind(input, function(value) { return !value ? 'Choose a value.' : FormAssist.validation.nativeProblem(input); });
      });
      if ($('sxCloseReason')) $('sxCloseReason').addEventListener('change', function() {
        if (noteCheck) noteCheck(true);
      });
    }
    prefillPayment(x);
    if ($('sxReady')) loadGuide(x);
    if ($('sxJob')) loadJob(x);
    loadLog(x);
    if ($('sxRefreshPrice')) $('sxRefreshPrice').addEventListener('click', function () { post(x, '/refresh-price', {}, x.id + ' was refreshed at today\u2019s costs.'); });
    if ($('sxUseLast')) $('sxUseLast').addEventListener('click', function () { var a = $('sxAmount'); if (!a) return; if (window.MoneyInput) MoneyInput.set(a, +this.dataset.amt); else a.value = this.dataset.amt; a.focus(); });
    if ($('sxApprovePrice')) $('sxApprovePrice').addEventListener('click', function () { post(x, '/approve-price', {}, 'Approved: ' + x.id + ' is sent to the customer at ' + peso(x.proposedAmount || 0) + '.'); });
    if ($('sxReturnPrice')) $('sxReturnPrice').addEventListener('click', function () {
      var note = $('sxNote').value.trim(); $('sxErr').classList.remove('show');
      if (note.length < 10) { showErr('Write what the cashier should change (at least 10 characters) in the note box, then press Send back.'); $('sxNote').focus(); return; }
      post(x, '/return-price', { note: note }, x.id + ' was sent back to the cashier.');
    });
    if ($('sxSend')) $('sxSend').addEventListener('click', function () { submitQuote(x, 'quoted'); });
    if ($('sxCheckPay')) $('sxCheckPay').addEventListener('click', function () { checkOnline(x); });
    if ($('sxRemindCust')) $('sxRemindCust').addEventListener('click', function () { remind(x, 'customer'); });
    if ($('sxRemindCash')) $('sxRemindCash').addEventListener('click', function () { remind(x, 'cashier'); });
    if ($('sxCloseReq')) $('sxCloseReq').addEventListener('click', function () {        // pick a reason first; nothing is closed until "Close request"
      if (x.status === 'closed') { closeModal(); return; }
      $('sxCloseBox').hidden = false; $('sxCloseReq').closest('.sx-actions').style.display = 'none'; $('sxCloseReason').focus();
    });
    if ($('sxCloseBack')) $('sxCloseBack').addEventListener('click', function () { $('sxCloseBox').hidden = true; $('sxCloseReq').closest('.sx-actions').style.display = ''; });
    if ($('sxCloseGo')) $('sxCloseGo').addEventListener('click', function () { submitQuote(x, 'closed'); });
    if ($('sxReopen')) $('sxReopen').addEventListener('click', function () { submitQuote(x, 'new'); });
  }
  /* ---------------- guided quote form ----------------
     The server works out the price, the ready date and the valid-until date (quote-guide.js). Finance confirms them, or changes
     something and says why; the reason is saved in the decision log. */
  var guideKept = null;
  async function loadGuide(x) {
    var g;
    try { g = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/guide'); }
    catch (e) { if ($('sxAmtHint')) { $('sxAmtHint').textContent = 'Could not load the guidance: ' + e.message; $('sxAmtHint').className = 'sx-err show'; } return; }
    if (!$('sxReady') || openQuote !== x.id) return;
    var k = guideKept && guideKept.id === x.id ? guideKept : null; guideKept = null;
    var P = g.price, amt = $('sxAmount'), note = $('sxNote');
    var setAmt = function (v) { if (window.MoneyInput) MoneyInput.set(amt, v); else amt.value = v; };
    if (k) { if (k.amount) setAmt(Number(String(k.amount).replace(/[,\u20B1\s]/g, ''))); } else if (P.ok) setAmt(P.suggested);
    var rd = $('sxReady'), vd = $('sxValid');
    rd.min = g.ready.min; rd.max = g.ready.max; rd.value = k && k.ready ? k.ready : g.ready.date;
    vd.min = g.valid.min; vd.max = g.valid.max; vd.value = k && k.valid ? k.valid : g.valid.date;
    $('sxReadyHint').textContent = g.ready.neededBy ? 'Customer needs it by ' + day(g.ready.neededBy) : 'The customer gave no needed-by date';
    $('sxValidHint').textContent = 'Up to ' + day(g.valid.max);
    $('sxAmtHint').className = 'faint';
    $('sxAmtHint').innerHTML = P.ok ? 'System price. From ' + peso(P.lowest) + ' to ' + peso(P.highest) + ' goes out without a reason. <button type="button" class="btn-secondary btn-sm" id="sxUseSys">Use the system price</button>'
      : 'The system could not price this yet. Type the price and say why.';
    $('sxChecks').innerHTML = g.checks.map(function (c) { return '<li class="' + (c.level === 'ok' ? 'ok' : 'warn') + '">' + esc(c.text) + '</li>'; }).join('');
    if ($('sxWhy')) $('sxWhy').innerHTML = '<b>Why the system suggests this</b>' + g.why.map(function (w) { return esc(w.title) + ': ' + esc(w.text); }).join('\n');
    var msgFor = function () { return g.messageTemplate.replace('{READY}', day(rd.value || g.ready.date)).replace('{VALID}', day(vd.value || g.valid.date)); };
    var auto = '';
    if (note && !note.value && x.status !== 'pending_approval') { auto = msgFor(); note.value = auto; }   // written for Finance; editing it stops the system changing it
    var shown = '';
    function flags() {
      var f = [], a = Number(String(MoneyInput.raw(amt.value)).replace(/[,\u20B1\s]/g, '')), r = rd.value;
      if (P.ok && a > 0) {
        if (a < P.cost - 0.004) f.push(peso(a) + ' is below the cost of ' + peso(P.cost));
        else if (a < P.floor - 0.004) f.push(peso(a) + ' is below the minimum-margin price of ' + peso(P.floor));
        else if (a < P.lowest - 0.004 || a > P.highest + 0.004) f.push(peso(a) + ' is outside ' + peso(P.lowest) + ' to ' + peso(P.highest));
      } else if (!P.ok) f.push('The price is typed by hand');
      if (r && r < g.ready.date) f.push('The ready date is earlier than the system can support (' + day(g.ready.date) + ')');
      if (r && g.ready.neededBy && r > g.ready.neededBy) f.push('The ready date is after the customer\u2019s needed-by date');
      return f;
    }
    function refresh() {
      var f = flags(), key = f.join('|'), box = $('sxNeed');
      if (key !== shown) {
        var had = $('sxReason') ? $('sxReason').value : (k && k.reason) || ''; shown = key;
        box.hidden = !f.length;
        box.innerHTML = f.length ? '<b>Please explain the change</b>' + f.map(function (t) { return '\u2022 ' + esc(t); }).join('\n') + '<textarea id="sxReason" class="form-input" maxlength="500" rows="2" style="margin-top:8px" placeholder="Why? This is saved in the decision log.">' + esc(had) + '</textarea>' : '';
      }
      if ($('sxReason') && window.FormAssist) FormAssist.validation.bind($('sxReason'), function (value) {
        return value.trim().length < 10 ? 'Please explain the change (at least 10 characters).' : '';
      });
      if (auto && note.value === auto) { auto = msgFor(); note.value = auto; }
    }
    [amt, rd, vd].forEach(function (el) { el.addEventListener('input', refresh); el.addEventListener('change', refresh); });
    if ($('sxUseSys')) $('sxUseSys').addEventListener('click', function () { setAmt(P.suggested); refresh(); });
    refresh();
  }
  var logSeq = 0;
  async function loadLog(x) {
    var my = ++logSeq, rows;
    try { rows = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/decisions'); } catch (e) { if ($('sxLog')) $('sxLog').innerHTML = '<b>Decision log</b><span class="sx-err show">' + esc(e.message) + '</span>'; return; }
    if (my !== logSeq || !$('sxLog')) return;
    $('sxLog').innerHTML = '<b>Decision log</b>' + (rows.length ? '<ul style="margin:6px 0 0;padding-left:18px">' + rows.map(function (d) {
      var n = d.numbers || {}, fig = [n.cashierTotal != null ? 'price ' + peso(n.cashierTotal) : '', n.systemTotal != null ? 'system ' + peso(n.systemTotal) : '', n.costTotal != null ? 'cost ' + peso(n.costTotal) : '', n.marginPct != null ? 'margin ' + n.marginPct + '%' : ''].filter(Boolean).join(' \u00B7 ');
      return '<li><b>' + esc(String(d.action).replace(/_/g, ' ')) + '</b>' + ((d.rules || []).length ? ' \u2014 ' + esc(d.rules.map(function (r) { return RULE_LABEL[r] || r; }).join(', ')) : '') +
        (d.reason ? '<br>' + esc(d.reason) : '') + '<small>' + esc(d.by) + (d.role ? ' (' + esc(d.role) + ')' : '') + ' \u00B7 ' + esc(when(d.at)) + (fig ? ' \u00B7 ' + esc(fig) : '') + '</small></li>';
    }).join('') + '</ul>' : '<span class="faint">No decisions yet.</span>');
  }
  /* ---------------- job order (custom items) ---------------- */
  var jobSeq = 0;
  var newKey = function () { return (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12)); };
  async function loadJob(x) {
    var my = ++jobSeq, box = $('sxJob'); if (!box) return;
    var d;
    try { d = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/job'); }
    catch (e) { if (my === jobSeq && $('sxJob')) $('sxJob').innerHTML = '<b>Job order</b><span class="sx-err show">' + esc(e.message) + '</span>'; return; }
    if (my !== jobSeq || !$('sxJob')) return;
    box = $('sxJob');
    var cost = function (j) { return j.materialCost != null ? peso(j.materialCost) : '\u2014'; };
    if (d.job && d.job.status !== 'draft') {
      var j = d.job, margin = d.quoted ? d.quoted - j.materialCost : null;
      box.innerHTML = '<b>Job order ' + esc(j.ref) + ': materials issued' + (j.status === 'finished' ? ' \u00B7 finished ' + esc(j.finishedAt || '') : '') + '</b><span class="faint">By ' + esc(j.issuedBy) + ' \u00B7 ' + esc(j.issuedAt) + '</span>' +
        '<table class="sx-jobtable"><thead><tr><th>Material</th><th>Department</th><th class="r">Used</th><th class="r">Cost</th></tr></thead><tbody>' +
        j.items.map(function (i) { return '<tr><td>' + esc(i.name) + '<div class="faint">' + esc(i.sku) + ' \u00B7 ' + esc(i.movementRef || '') + '</div></td><td>' + esc(i.department) + '</td><td class="r">' + i.quantity + ' ' + esc(i.unit) + '</td><td class="r">' + (i.unitCost != null ? peso(i.quantity * i.unitCost) : '\u2014') + '</td></tr>'; }).join('') +
        '</tbody></table><div class="sx-jobsum">Material cost <b>' + cost(j) + '</b>' + (margin != null ? ' \u00B7 quoted ' + peso(d.quoted) + ' \u00B7 left for labour and margin <b>' + peso(margin) + '</b>' : '') + '</div>' + (j.note ? '<div class="faint">' + esc(j.note) + '</div>' : '') +
        (d.canFinish ? '<div class="sx-actions"><button type="button" class="btn-primary" id="sxJobFinish">Job finished \u2014 mark ' + (x.fulfillment === 'Delivery' ? 'out for delivery' : 'ready for pickup') + '</button></div>' : '');
      if ($('sxJobFinish')) $('sxJobFinish').addEventListener('click', function () { post(x, '/job/finish', {}, x.id + ': job finished, the customer was told.'); });
      return;
    }
    if (!d.canIssue) {
      if (d.paymentBlocked && d.paymentNeeded) {
        box.innerHTML = '<b>Job order: materials for this custom item</b>' +
          '<div class="sx-callout warn" style="background:#fffbeb;border:1px solid #fef08a;border-left:4px solid #d97706;padding:12px 14px;border-radius:6px;margin:10px 0;font-size:13px;line-height:1.5;">' +
          '<b>Down payment required before production:</b> Customer has paid ' + peso(d.paymentNeeded.paid) + ' of ' + peso(d.quoted) + '. ' +
          'Under Philippine Contract Law (Civil Code Arts. 1482 & 1582), custom-made orders require an initial down payment (' + peso(d.paymentNeeded.required) + ') before raw materials can leave stock. ' +
          'Collect at the counter or wait for online payment confirmation before issuing raw materials.' +
          '</div>' +
          '<span class="faint">Materials are on hold until initial deposit is recorded.</span>';
        return;
      }
      box.innerHTML = '<b>Job order: materials for this custom item</b><span class="faint">' + (x.status === 'accepted'
        ? 'Press \u201CStart preparing\u201D first (the payment terms are checked there). Then issue the raw materials and finishing supplies here: they leave stock, and the quote can be marked ready.'
        : 'No materials were issued for this job.') + '</span>';
      return;
    }
    var opts = function (sel) {
      return '<option value="">Choose a material</option>' + ['Raw Materials', 'Finishing Supplies'].map(function (dep) {
        return '<optgroup label="' + dep + '">' + d.materials.filter(function (m) { return m.department === dep; }).map(function (m) {
          return '<option value="' + esc(m.sku) + '"' + (m.sku === sel ? ' selected' : '') + ' data-unit="' + esc(m.unit) + '" data-onhand="' + m.onHand + '">' + esc(m.name) + ' (' + esc(m.sku) + ') \u00B7 ' + m.onHand + ' ' + esc(m.unit) + ' on hand</option>'; }).join('') + '</optgroup>'; }).join('');
    };
    var line = function (sku, why, qty) {
      var m = d.materials.find(function (z) { return z.sku === sku; });
      return '<div class="sx-jobline"><select class="form-input" data-jsku>' + opts(sku) + '</select><input class="form-input mono" data-jqty inputmode="decimal" autocomplete="off" placeholder="Qty" value="' + esc(qty != null ? qty : '') + '"><span class="sx-junit">' + esc(m ? m.unit : '') + '</span>' +
        '<button type="button" class="btn-secondary btn-sm" data-jdel aria-label="Remove line">\u00D7</button>' + (why ? '<small class="faint">Suggested from the ' + esc(why) + '</small>' : '') + '<span class="sx-jerr" data-jerr></span></div>';
    };
    box.innerHTML = '<b>Job order' + (d.job ? ' ' + esc(d.job.ref) + ' (draft)' : '') + ': issue the materials for this custom item</b>' +
      '<span class="faint">Each line leaves stock as \u201CUsed in production\u201D when you confirm' + (x.status === 'accepted' ? ', and the quote moves to Preparing' : '') + '. ' + (d.job ? 'The quantities come from the quote\u2019s recipe for the whole order; change them to what this job really uses.' : 'The suggestions come from the quote\u2019s material and finish; enter what this job really uses.') + '</span>' +
      '<div class="sx-ready" id="sxReady" role="status" aria-live="polite"></div>' +
      '<div id="sxJobLines">' + (d.suggestions.length ? d.suggestions.map(function (sg) { return line(sg.sku, sg.why, sg.quantity); }).join('') : line('')) + '</div>' +
      '<button type="button" class="btn-secondary btn-sm" id="sxJobAdd" style="margin-top:8px">+ Add material</button>' +
      '<label for="sxJobNote" style="display:block;margin:10px 0 4px;font-weight:600;font-size:13px">Note <span class="faint" style="font-weight:400">(optional)</span></label><input id="sxJobNote" class="form-input" maxlength="300" placeholder="e.g. cut from 2 ingots, extra coat on the flange">' +
      '<div class="sx-err" id="sxJobErr" role="alert"></div><div class="sx-actions"><button type="button" class="btn-primary" id="sxJobGo">' + (x.status === 'accepted' ? 'Issue materials &amp; start preparing' : 'Issue materials') + '</button></div>';
    var linesBox = $('sxJobLines');
    $('sxJobAdd').addEventListener('click', function () { linesBox.insertAdjacentHTML('beforeend', line('')); });
    linesBox.addEventListener('click', function (e) { var b = e.target.closest('[data-jdel]'); if (b) b.closest('.sx-jobline').remove(); });
    linesBox.addEventListener('change', function (e) { if (e.target.matches('[data-jsku]')) { var o = e.target.selectedOptions[0]; e.target.parentNode.querySelector('.sx-junit').textContent = o ? (o.dataset.unit || '') : ''; } });
    // live readiness check: what is in stock against what the lines ask for, before anything is pressed (the server still re-checks under lock)
    var readyBox = $('sxReady');
    function jobLines() {
      return Array.prototype.map.call(linesBox.querySelectorAll('.sx-jobline'), function (ln) {
        var sel = ln.querySelector('[data-jsku]'), q = ln.querySelector('[data-jqty]'), o = sel.selectedOptions[0], v = q.value.replace(/,/g, '').trim();
        return { ln: ln, sku: sel.value, name: o && sel.value ? o.textContent.split(' (')[0] : '', unit: o && o.dataset.unit || '', onHand: o && sel.value ? Number(o.dataset.onhand) : null,
          qty: /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : null };
      }).filter(function (l) { return l.sku; });
    }
    function paintReady() {
      var ls = jobLines(); if (!ls.length) { readyBox.innerHTML = ''; return; }
      var short = [], waiting = 0;
      ls.forEach(function (l, i) { if (l.qty == null) waiting++; else if (l.qty > l.onHand + 1e-9) short.push({ l: l, i: i, by: Math.round((l.qty - l.onHand) * 100) / 100 }); });
      var okN = ls.length - short.length - waiting, h = '';
      if (!short.length && !waiting) h = '<div class="sx-rd ok">\u2705 All ' + ls.length + ' material' + (ls.length === 1 ? ' is' : 's are') + ' in stock</div>';
      else {
        if (short.length) h += '<div class="sx-rd warn">\u26A0\uFE0F ' + short.length + ' of ' + ls.length + ' material' + (ls.length === 1 ? '' : 's') + (short.length === 1 ? ' is' : ' are') + ' short' + (okN ? ' \u00B7 ' + okN + ' available' : '') + '</div>' +
          short.map(function (s) {
            return '<div class="sx-rd-line">' + esc(s.l.name) + ': ' + qnum(s.l.qty) + ' ' + esc(s.l.unit) + ' needed, ' + qnum(s.l.onHand) + ' in stock \u2014 <b>short by ' + qnum(s.by) + ' ' + esc(s.l.unit) + '</b> ' +
              (s.l.onHand > 0 ? '<button type="button" class="btn-secondary btn-sm" data-jfit="' + s.i + '">Use what is in stock (' + qnum(s.l.onHand) + ')</button>' : '<span class="faint">none in stock</span>') + '</div>';
          }).join('') + '<div class="faint">Nothing leaves stock until you confirm. Issue what is available (the note records it), or wait for the restock.</div>';
        if (waiting) h += '<div class="sx-rd">Enter the quantity on ' + waiting + ' line' + (waiting === 1 ? '' : 's') + ' to finish the check.</div>';
      }
      readyBox.innerHTML = h;
    }
    readyBox.addEventListener('click', function (e) {
      var b = e.target.closest('[data-jfit]'); if (!b) return;
      var l = jobLines()[Number(b.dataset.jfit)]; if (!l) return;
      var was = l.qty; l.ln.querySelector('[data-jqty]').value = String(l.onHand);
      var nb = $('sxJobNote'), add = 'Short on ' + l.name + ': issued ' + qnum(l.onHand) + ' ' + l.unit + ' of ' + qnum(was) + ' needed.';
      if (nb && (nb.value + ' ' + add).trim().length <= 300 && nb.value.indexOf('Short on ' + l.name) < 0) nb.value = (nb.value.trim() ? nb.value.trim() + ' ' : '') + add;
      paintReady();
    });
    linesBox.addEventListener('input', paintReady); linesBox.addEventListener('change', paintReady);
    $('sxJobAdd').addEventListener('click', paintReady); linesBox.addEventListener('click', function (e) { if (e.target.closest('[data-jdel]')) paintReady(); });
    paintReady();
    var key = newKey();
    $('sxJobGo').addEventListener('click', async function () {
      var err = $('sxJobErr'); err.classList.remove('show'); var items = [], first = null, seen = {};
      linesBox.querySelectorAll('.sx-jobline').forEach(function (ln) {
        var sel = ln.querySelector('[data-jsku]'), q = ln.querySelector('[data-jqty]'), e2 = ln.querySelector('[data-jerr]'), o = sel.selectedOptions[0], msg = '';
        var v = q.value.replace(/,/g, '').trim();
        if (!sel.value) msg = 'Choose the material';
        else if (seen[sel.value]) msg = 'Already listed above';
        else if (!/^\d{1,8}(\.\d{1,2})?$/.test(v) || !(Number(v) > 0)) msg = 'Enter the quantity used';
        else if (Number(v) > Number(o.dataset.onhand)) msg = 'Only ' + o.dataset.onhand + ' ' + o.dataset.unit + ' on hand';
        e2.textContent = msg; ln.classList.toggle('bad', !!msg);
        if (msg && !first) first = msg ? (sel.value ? q : sel) : null;
        if (sel.value) seen[sel.value] = 1;
        if (!msg) items.push({ sku: sel.value, quantity: v, name: o.textContent.split(' (')[0], unit: o.dataset.unit });
      });
      if (!items.length && !first) { err.textContent = 'Add at least one raw material or finishing supply.'; err.classList.add('show'); return; }
      if (first) { first.focus(); err.textContent = 'Fix the highlighted lines.'; err.classList.add('show'); return; }
      var ok = window.uiConfirm ? await window.uiConfirm({ title: 'Issue these materials for ' + x.id + '?', message: 'They leave stock now as \u201CUsed in production\u201D. This cannot be undone from here.',
        lines: items.map(function (i) { return [i.name, i.quantity + ' ' + i.unit]; }), confirm: 'Issue materials' }) : true;
      if (!ok) return;
      var btn = $('sxJobGo'); btn.disabled = true;
      try {
        var r = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/job', { method: 'POST', body: JSON.stringify({ requestKey: key, note: $('sxJobNote').value.trim(), items: items.map(function (i) { return { sku: i.sku, quantity: i.quantity }; }) }) });
        toast((r.job ? r.job.ref : 'Job order') + ': materials issued for ' + x.id + '.');
        loadJob(x); loadQuotes();
      } catch (e) {
        btn.disabled = false; err.textContent = (e.fields && (e.fields.items || Object.values(e.fields)[0])) || e.message; err.classList.add('show');
      }
    });
  }

  function showErr(msg) { var b = $('sxErr'); if (b) { b.textContent = msg; b.classList.add('show'); } }

  var sxDraft = '';                                                       // the drafted send-back note currently shown (never sent to a customer)
  async function submitQuote(x, status) {
    if (busy) return;
    var note = $('sxNote').value.trim(), amount = $('sxAmount') ? MoneyInput.raw($('sxAmount').value) : '', lead = $('sxLead') ? $('sxLead').value : '', days = $('sxDays') ? $('sxDays').value : '',
      ready = $('sxReady') ? $('sxReady').value : '', valid = $('sxValid') ? $('sxValid').value : '', reason = $('sxReason') ? $('sxReason').value.trim() : '';
    if (note && note === sxDraft) note = '';                              // an untouched cashier-facing draft must never go to the customer as a message
    $('sxErr').classList.remove('show');
    if (note && note.length < 5) { showErr('Write at least 5 characters, or leave the message empty.'); $('sxNote').focus(); return; }
    var closeReason = status === 'closed' && $('sxCloseReason') ? $('sxCloseReason').value : '';
    if (status === 'closed') {
      if (!closeReason) { showErr('Choose why this request is being closed.'); $('sxCloseReason').focus(); return; }
      if (closeReason === 'other' && note.length < 10) { showErr('Explain the reason in the message box (at least 10 characters).'); $('sxNote').focus(); return; }
      if (x.paidAmount > 0 && note.length < 5) { showErr('Payments were received: write how they are refunded or settled in the message box.'); $('sxNote').focus(); return; }
    }
    if (status === 'quoted') {
      if (!amount) { showErr('Enter the quoted amount.'); $('sxAmount').focus(); return; }
      var n = Number(amount.replace(/[,\u20B1\s]/g, ''));
      if (!(n > 0)) { showErr('Enter a valid amount greater than 0.'); $('sxAmount').focus(); return; }
      if ($('sxReady')) {
        if (!ready) { showErr('Pick the date it will be ready.'); $('sxReady').focus(); return; }
        if (!valid) { showErr('Pick the date the price stays valid until.'); $('sxValid').focus(); return; }
        if ($('sxReason') && reason.length < 10) { showErr('Please explain the change (at least 10 characters) in the box under the price and dates.'); $('sxReason').focus(); return; }
      } else if (!lead) { showErr('Choose how long it will take to make or prepare.'); $('sxLead').focus(); return; }
    }
    busy = true; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var body = { status: status, note: note, closeReason: closeReason || undefined };
      if (status === 'quoted') { body.amount = amount; if ($('sxReady')) { body.readyBy = ready; body.validUntil = valid; if (reason) body.overrideReason = reason; } else { body.leadTime = lead; body.validDays = Number(days); } }
      await api('/finance/quotes/' + encodeURIComponent(x.id), { method: 'POST', body: JSON.stringify(body) });
      toast(status === 'quoted' ? 'Quote sent for ' + x.id + '.' : status === 'closed' ? x.id + ' closed.' : x.id + ' reopened.');
      busy = false; closeModal(); await loadQuotes();
    } catch (e) {
      busy = false; if (e.message === 'Not signed in') return;
      guideKept = $('sxReady') ? { id: x.id, amount: amount, ready: ready, valid: valid, reason: reason } : null;   // keep what was typed through the repaint
      await loadQuotes(); if (openQuote) { paintQuote(); $('sxNote').value = note; if (status === 'closed' && $('sxCloseBox')) { $('sxCloseBox').hidden = false; $('sxCloseReason').value = closeReason; if ($('sxCloseReq')) $('sxCloseReq').closest('.sx-actions').style.display = 'none'; } if ($('sxAmount')) $('sxAmount').value = amount; if ($('sxLead')) $('sxLead').value = lead; showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    } finally { busy = false; }
  }

  // Finance does not record payments: it checks the online one and reminds the customer or the cashier
  async function remind(x, to) {
    if (busy) return; busy = true; $('sxErr').classList.remove('show'); overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try { var r = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/remind', { method: 'POST', body: JSON.stringify({ to: to }) }); toast(r.message || 'Done.'); }
    catch (e) { if (e.message !== 'Not signed in') showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    finally { busy = false; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); }
  }
  async function checkOnline(x) {
    if (busy) return; busy = true; $('sxErr').classList.remove('show'); overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var r = await api('/finance/quotes/' + encodeURIComponent(x.id) + '/check-payment', { method: 'POST', body: '{}' });
      toast(r.balance > 0 ? 'Not paid online yet. Balance ' + peso(r.balance) + '.' : 'Paid. The payment is recorded.'); busy = false; await loadQuotes(); if (openQuote) paintQuote();
    } catch (e) { busy = false; if (e.message !== 'Not signed in') showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    finally { busy = false; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); }
  }
  async function post(x, path, body, doneMsg) {
    if (busy) return;
    busy = true; overlay.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      await api('/finance/quotes/' + encodeURIComponent(x.id) + path, { method: 'POST', body: JSON.stringify(body) });
      toast(doneMsg); busy = false; await loadQuotes(); if (openQuote) paintQuote();
    } catch (e) {
      busy = false; if (e.message === 'Not signed in') return;
      await loadQuotes(); if (openQuote) { paintQuote(); showErr((e.fields && Object.values(e.fields)[0]) || e.message); }
    } finally { busy = false; }
  }
  function submitPayment(x) {
    $('sxErr').classList.remove('show');
    var amt = MoneyInput.raw($('sxPayAmt').value), method = $('sxPayMethod').value;
    if (!(Number(amt.replace(/[,\u20B1\s]/g, '')) > 0)) { showErr('Enter the amount received.'); $('sxPayAmt').focus(); return; }
    if (!method) { showErr('Choose how it was paid.'); $('sxPayMethod').focus(); return; }
    lastPayMethod = method;
    post(x, '/payment', { amount: amt, method: method }, 'Payment recorded for ' + x.id + '.');
  }

  /* ---------------- reviews ---------------- */
  function renderReviews() {
    if (!$('sxrBody')) return;
    var f = $('sxrFilter').value, t = $('sxrSearch').value.trim().toLowerCase(), rt = $('sxrRating').value;
    paintReviewKpis();
    var list = reviews.filter(function (r) {
      return (f === 'all' || r.status === f) && (rt === 'all' || String(r.rating) === rt) && (!t || (r.product + ' ' + r.sku + ' ' + r.customer + ' ' + r.body).toLowerCase().indexOf(t) >= 0);
    });
    var hidden = reviews.filter(function (r) { return r.status === 'hidden'; }).length;
    $('sxrSub').textContent = reviews.length ? reviews.length + ' review' + (reviews.length === 1 ? '' : 's') + ' \u00B7 ' + hidden + ' hidden' : 'Reviews will appear here after customers rate products they received.';
    $('sxrBody').innerHTML = list.length ? list.map(function (r) {
      return '<tr class="sxr-row" tabindex="0" role="button" aria-label="View review and customer details for ' + esc(r.customer) + '" data-sxrow="' + r.id + '"><td>' + esc(r.product) + '<div class="faint" style="font-size:12px">' + esc(r.sku) + '</div></td><td>' + stars(r.rating) + '</td>' +
        '<td><div class="sxr-who"><span class="sxr-av" aria-hidden="true">' + esc(ini(r.customer)) + '</span><div>' + esc(r.customer) + (r.orderNo ? '<div class="faint" style="font-size:12px">Order ' + esc(r.orderNo) + '</div>' : '') + '</div></div></td>' +
        '<td class="sx-text">' + (r.body ? '<span class="sxr-clamp">' + esc(r.body) + '</span>' : '<span class="faint">No comment</span>') + (r.status === 'hidden' && r.hiddenReason ? '<div class="faint" style="font-size:12px;margin-top:4px">Hidden: ' + esc(r.hiddenReason) + (r.hiddenBy ? ' (' + esc(r.hiddenBy) + ')' : '') + '</div>' : '') + '</td>' +
        '<td>' + esc(when(r.createdAt)) + '</td><td>' + rPill(r.status) + '</td>' +
        '<td style="white-space:nowrap"><button type="button" class="' + (r.status === 'hidden' ? 'btn-secondary' : 'btn-danger') + ' btn-sm" data-sxr="' + r.id + '">' + (r.status === 'hidden' ? 'Restore' : 'Hide') + '</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="sx-empty">' + (reviews.length ? 'No reviews match.' : 'No reviews yet.') + '</td></tr>';
  }
  function paintReviewKpis() {
    var box = $('sxrKpis'); if (!box) return;
    var vis = reviews.filter(function (r) { return r.status !== 'hidden'; });
    var avg = vis.length ? (vis.reduce(function (t, r) { return t + r.rating; }, 0) / vis.length) : 0;
    var low = vis.filter(function (r) { return r.rating <= 2; }).length, hidden = reviews.length - vis.length;
    var dist = [5, 4, 3, 2, 1].map(function (n) {
      var c = vis.filter(function (r) { return r.rating === n; }).length;
      return '<div><span>' + n + '\u2605</span><span class="sxr-bar"><i style="width:' + (vis.length ? Math.round(c * 100 / vis.length) : 0) + '%"></i></span><span>' + c + '</span></div>';
    }).join('');
    box.innerHTML = '<div class="sxr-kpi"><span>Total reviews</span><strong>' + reviews.length + '</strong></div>' +
      '<div class="sxr-kpi good"><span>Average rating</span><strong>' + (vis.length ? avg.toFixed(1) + ' \u2605' : '\u2014') + '</strong></div>' +
      '<div class="sxr-kpi' + (low ? ' bad' : '') + '"><span>Low (1-2 stars)</span><strong>' + low + '</strong></div>' +
      '<div class="sxr-kpi"><span>Hidden</span><strong>' + hidden + '</strong></div>' +
      '<div class="sxr-kpi"><span>Rating mix (visible)</span><div class="sxr-dist">' + dist + '</div></div>';
  }
  async function loadReviews() {
    if (loadingR) return; loadingR = true;
    try { var d = await api('/finance/reviews'); reviews = Array.isArray(d) ? d : []; renderReviews(); }
    catch (e) { if (e.message !== 'Not signed in' && $('sxrSub') && !reviews.length) $('sxrSub').textContent = 'Could not load reviews: ' + e.message; }
    finally { loadingR = false; }
  }
  var fld = function (l, v) { var e = v == null || String(v).trim() === ''; return '<div class="sxr-f' + (e ? ' is-empty' : '') + '"><span>' + esc(l) + '</span><strong>' + (e ? 'Not provided' : esc(v)) + '</strong></div>'; };
  var reviewToken = 0;
  function otherReviews(rv) {
    var more = reviews.filter(function (x) { return x.userId && x.userId === rv.userId && x.id !== rv.id; });
    if (!more.length) return '';
    return '<div class="sxr-h">More reviews by this customer (' + more.length + ')</div>' + more.slice(0, 5).map(function (x) {
      return '<div class="sxr-more"><header><strong>' + esc(x.product) + '</strong>' + stars(x.rating) + '</header>' + (x.body ? '<p>' + esc(x.body) + '</p>' : '') + '</div>';
    }).join('') + (more.length > 5 ? '<p class="faint" style="font-size:13px;margin:8px 0 0">+ ' + (more.length - 5) + ' more</p>' : '');
  }
  async function openReview(id) {
    var rv = reviews.find(function (x) { return x.id === id; }); if (!rv) return;
    ensureOverlay(); openQuote = null; var tok = ++reviewToken;
    function paint(d, note) {
      d = d || {};
      $('sxBody').innerHTML = '<div class="sx-head"><h2>Review details</h2>' + rPill(rv.status) + '</div>' +
        '<div class="sxr-review"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><strong>' + esc(rv.product) + '</strong>' + stars(rv.rating) + '</div>' +
        '<div class="faint" style="font-size:12.5px;margin-top:2px">' + esc(rv.sku) + (rv.orderNo ? ' \u00B7 Order ' + esc(rv.orderNo) : '') + ' \u00B7 ' + esc(when(rv.createdAt)) + '</div>' +
        '<p>' + (rv.body ? esc(rv.body) : '<span class="faint">No comment</span>') + '</p>' +
        (rv.status === 'hidden' && rv.hiddenReason ? '<div class="faint" style="font-size:13px;margin-top:8px">Hidden: ' + esc(rv.hiddenReason) + (rv.hiddenBy ? ' (' + esc(rv.hiddenBy) + ')' : '') + '</div>' : '') + '</div>' +
        '<div class="sxr-h">Customer</div>' +
        '<div class="sxr-top"><span class="sxr-av" aria-hidden="true">' + esc(ini(d.name || rv.customer)) + '</span><div><strong>' + esc(d.name || rv.customer) + '</strong><span class="faint">' + esc(d.email || rv.email || '') + '</span></div></div>' +
        (note ? '<p class="faint" style="margin:0">' + esc(note) + '</p>' :
          '<div class="sxr-grid">' + fld('Phone', d.phone) + fld('Birthdate', d.birthdate) + fld('Gender', d.gender) + fld('Email Verified', d.emailVerified ? 'Yes' : 'No') +
          fld('Joined', d.joined) + fld('Last Login', d.lastLogin) + fld('Company', d.companyName) + fld('Position', d.companyPosition) + '</div>') +
        otherReviews(rv) +
        '<div class="sx-actions"><button type="button" class="' + (rv.status === 'hidden' ? 'btn-secondary' : 'btn-danger') + '" id="sxrAct">' + (rv.status === 'hidden' ? 'Restore review' : 'Hide review') + '</button><button type="button" class="btn-secondary" id="sxCancel">Close</button></div>';
      $('sxCancel').addEventListener('click', closeModal);
      $('sxrAct').addEventListener('click', function () { if (rv.status === 'hidden') setVisibility(rv, false, ''); else askHide(rv); });
    }
    paint(null, 'Loading customer details\u2026'); overlay.classList.add('open');
    try {
      if (!rv.userId) throw new Error('Customer details unavailable.');
      var res = await fetch('/api/customers/' + encodeURIComponent(rv.userId) + '/profile', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Customer details unavailable (' + res.status + ').');
      var d = await res.json(); if (tok === reviewToken && overlay.classList.contains('open')) paint(d);
    } catch (e) { if (tok === reviewToken && overlay.classList.contains('open')) paint(null, e.message); }
  }
  function askHide(rv) {
    ensureOverlay(); openQuote = null;
    $('sxBody').innerHTML = '<div class="sx-head"><h2>Hide this review?</h2></div>' +
      '<div class="sx-box"><b>' + esc(rv.customer) + ' on ' + esc(rv.product) + ' \u00B7 ' + rv.rating + '/5</b>' + (rv.body ? esc(rv.body) : 'No comment') + '</div>' +
      '<p class="faint" style="margin:0 0 6px">Customers will no longer see it, and it stops counting toward the star rating. You can restore it any time.</p>' +
      '<div class="sx-form"><label for="sxReason">Reason (kept in the audit log)</label><input type="text" class="form-input" id="sxReason" maxlength="300" placeholder="e.g. Abusive language">' +
      '<div class="sx-err" id="sxErr" role="alert"></div><div class="sx-actions"><button type="button" class="btn-danger" id="sxHide">Hide review</button><button type="button" class="btn-secondary" id="sxCancel">Cancel</button></div></div>';
    if (window.FormAssist) FormAssist.validation.bind($('sxReason'), function (value) { return value.trim().length < 3 ? 'Write a short reason (at least 3 characters).' : ''; }, $('sxErr'));
    overlay.classList.add('open'); $('sxReason').focus();
    $('sxCancel').addEventListener('click', closeModal);
    $('sxHide').addEventListener('click', function () {
      var reason = $('sxReason').value.trim();
      if (reason.length < 3) { showErr('Write a short reason (at least 3 characters).'); return; }
      setVisibility(rv, true, reason);
    });
  }
  async function setVisibility(rv, hide, reason) {
    if (busy) return; busy = true;
    try {
      await api('/finance/reviews/' + rv.id + '/visibility', { method: 'POST', body: JSON.stringify({ hidden: hide, reason: reason }) });
      toast(hide ? 'Review hidden.' : 'Review restored.'); busy = false; closeModal(); await loadReviews();
    } catch (e) { busy = false; if (e.message !== 'Not signed in') { if (overlay && overlay.classList.contains('open') && $('sxErr')) showErr(e.message); else toast(e.message, true); } }
    finally { busy = false; }
  }

  /* ---------------- start ---------------- */
  function start() {
    if (!$('quotes') || !$('reviews')) return;
    addStyles(); build(); loadQuotes(); loadReviews();
    [['quotes', loadQuotes], ['reviews', loadReviews]].forEach(function (p) {
      var sec = $(p[0]);
      new MutationObserver(function () { if (sec.classList.contains('active-page')) p[1](); }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    });
    setInterval(function () { if (!document.hidden && !busy && !openQuote) loadQuotes(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && !busy && !openQuote) loadQuotes(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
