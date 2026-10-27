// Cash shifts: cashier drawer reconciliation + Finance monitoring.
// Mount from server.js AFTER auth(), wrap(), tx() are defined.
const rules = require('./cash-shift-rules');
module.exports = function mountCashShifts({app,pool,auth,wrap,tx,audit,TZ:tzIn}) {
 const TZ = tzIn || 'Asia/Manila';
 const VARIANCE_ALERT = Number(process.env.CASH_VARIANCE_ALERT || 100);   // |difference| at or above this needs Finance review
 const STALE_HOURS = Number(process.env.CASH_SHIFT_STALE_HOURS || 16);    // an open shift older than this is flagged
 const MAX_MONEY = 10000000;
 const DENOMS = ['1000','500','200','100','50','20','10','5','1','0.25','0.05'];
 const fail = (res, status, error, field) => res.status(status).json(field ? {error, fields:{[field]:error}} : {error});
 // 2-decimal money check that is safe against floating point (1.10*100 is 110.00000000000001 in JS)
 const money = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_MONEY && Math.abs(x*100 - Math.round(x*100)) < 1e-6;
 const r2 = x => Math.round(x*100)/100;
 const peso = n => '₱'+Number(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
 // Cash shift events go into the audit log (Finance > Audit Log, action "Cash shift"). Never let a logging problem block the till.
 const log = (client,user,detail) => audit ? audit(client,user,'Cash shift',detail) : Promise.resolve();

 /* ---------- store hours: 8:00 AM to 5:00 PM (BUSINESS_OPEN / BUSINESS_CLOSE, HH:MM, Philippine time) ----------
    A shift can be opened from SHIFT_EARLY_MINUTES before opening (to count the drawer) until closing time.
    The automation reminds the cashier SHIFT_REMIND_MINUTES before closing, and tells Finance when a shift is still open
    SHIFT_OVERDUE_MINUTES after closing. Sales are not blocked by the clock itself; what blocks them is an open shift that MUST be closed
    (end-of-day window, see SHIFT_FORCE_CLOSE_MINUTES below, or left open from an earlier day). */
 const hm = (v, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '')); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : d; };
 const OPEN_MIN = hm(process.env.BUSINESS_OPEN, 8 * 60), CLOSE_MIN = hm(process.env.BUSINESS_CLOSE, 17 * 60);
 const EARLY = Math.max(0, Number(process.env.SHIFT_EARLY_MINUTES) || 30), REMIND = Math.max(5, Number(process.env.SHIFT_REMIND_MINUTES) || 30);
 const OVERDUE = Math.max(0, Number(process.env.SHIFT_OVERDUE_MINUTES) || 30);
 /* From SHIFT_FORCE_CLOSE_MINUTES (default 15) before closing, an open shift MUST be counted and closed: the cashier's screen opens the
    count-and-close window with no way to dismiss it, and the server refuses sales, cash collection and cash movements on that shift until it
    is closed (so hiding the window in the browser does not help). 0 turns it off. Shifts cannot be opened inside that window when
    ENFORCE_STORE_HOURS=true. Example: close 5:00 PM, 15 minutes -> forced from 4:45 PM. */
 const FORCE = process.env.SHIFT_FORCE_CLOSE_MINUTES === undefined || process.env.SHIFT_FORCE_CLOSE_MINUTES === '' ? 15 : Math.min(Math.max(Number(process.env.SHIFT_FORCE_CLOSE_MINUTES) || 0, 0), 180);
 const label = (m) => { const h = Math.floor(m / 60), mi = m % 60; return ((h + 11) % 12 + 1) + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'); };
 function clock() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const minutes = (+parts.hour % 24) * 60 + +parts.minute, date = parts.year + '-' + parts.month + '-' + parts.day;
  return { minutes, date, state: minutes < OPEN_MIN ? 'before' : minutes < CLOSE_MIN ? 'open' : 'after' };
 }
 const minutesOfDay = (ts) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])); return (+p.hour % 24) * 60 + +p.minute; };
 const hours = () => {
  const c = clock();
  // Allow opening cash shift anytime during testing/development (enforce strict hours only if ENFORCE_STORE_HOURS is set to true).
  // When enforced, no shift can be opened inside the final FORCE minutes either: it would have to be closed straight away.
  const lastOpen = FORCE > 0 ? CLOSE_MIN - FORCE : CLOSE_MIN;
  const canOpen = process.env.ENFORCE_STORE_HOURS === 'true' ? (c.minutes >= OPEN_MIN - EARLY && c.minutes < lastOpen) : true;
  return { open: label(OPEN_MIN), close: label(CLOSE_MIN), openMinutes: OPEN_MIN, closeMinutes: CLOSE_MIN, earlyMinutes: EARLY, remindMinutes: REMIND,
   forceCloseMinutes: FORCE, forceCloseFrom: label(CLOSE_MIN - FORCE),
   firstOpen: label(Math.max(0, OPEN_MIN - EARLY)), nowMinutes: c.minutes, date: c.date, state: c.state,
   canOpenShift: canOpen, minutesToClose: CLOSE_MIN - c.minutes };
 };
 // true when this open shift must be counted and closed now (end-of-day window, or left open from an earlier day)
 const mustClose = (openedAt) => rules.mustCloseShift({ clock: clock(), shift: { openedDay: dayOf(openedAt), openedMinutes: minutesOfDay(openedAt) }, closeMinutes: CLOSE_MIN, forceMinutes: FORCE });
 app.get('/api/pos/business-hours', auth('cashier', 'finance'), wrap(async (req, res) => res.json(hours())));

 /* ---------- schema (self-healing: the movements table was never in a migration) ---------- */
 const ready = (async()=>{
  try {
   await (app.locals.posReturnsReady || Promise.resolve());   // the return tables (pos-shop.js) are read by the shift summary below
   await pool.query(`CREATE TABLE IF NOT EXISTS pos_cash_shifts (
    shift_id BIGSERIAL PRIMARY KEY, cashier_id INT NOT NULL REFERENCES users(user_id), cashier_name TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(), closed_at TIMESTAMPTZ,
    opening_cash NUMERIC(12,2) NOT NULL CHECK (opening_cash >= 0), closing_cash NUMERIC(12,2) CHECK (closing_cash >= 0),
    closing_note TEXT NOT NULL DEFAULT '', CHECK (closed_at IS NULL OR closing_cash IS NOT NULL))`);
   await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift_per_cashier ON pos_cash_shifts(cashier_id) WHERE closed_at IS NULL');
   await pool.query('ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS cash_shift_id BIGINT REFERENCES pos_cash_shifts(shift_id)');
   // online orders paid in cash at handover are counted in the drawer too (pos-shop.js fills these in)
   await pool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_shift_id BIGINT');
   await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'");
   await pool.query('CREATE INDEX IF NOT EXISTS pos_sales_cash_shift_idx ON pos_sales(cash_shift_id)');
   await pool.query(`CREATE TABLE IF NOT EXISTS pos_cash_movements (
    movement_id BIGSERIAL PRIMARY KEY, shift_id BIGINT NOT NULL REFERENCES pos_cash_shifts(shift_id),
    cashier_id INT NOT NULL REFERENCES users(user_id), kind TEXT NOT NULL CHECK (kind IN ('cash_in','cash_out')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
   await pool.query('CREATE INDEX IF NOT EXISTS pos_cash_movements_shift_idx ON pos_cash_movements(shift_id, created_at)');
   await pool.query('ALTER TABLE pos_cash_shifts ADD COLUMN IF NOT EXISTS closing_breakdown JSONB');
   // cash taken out of the drawer for the bank / safe right after counting; the next shift starts with closing cash minus this
   await pool.query('ALTER TABLE pos_cash_shifts ADD COLUMN IF NOT EXISTS closing_deposit NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (closing_deposit >= 0)');
   // one row: a closing difference ABOVE reason_threshold needs a written reason (Finance edits it on the Cash Shifts screen)
   await pool.query(`CREATE TABLE IF NOT EXISTS cash_shift_rules (id INT PRIMARY KEY CHECK (id = 1),
    reason_threshold NUMERIC(12,2) NOT NULL DEFAULT ${rules.DEFAULT_REASON_THRESHOLD} CHECK (reason_threshold >= 0 AND reason_threshold <= 10000),
    updated_by INT REFERENCES users(user_id), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
   await pool.query('INSERT INTO cash_shift_rules (id) VALUES (1) ON CONFLICT DO NOTHING');
   console.log('[cash] cash shift schema ready');
  } catch(err){ console.warn('[cash] could not prepare the cash shift schema:', err.message); }
 })();
 const whenReady = (req,res,next)=>{ ready.then(()=>next(),next); };
 app.use('/api/pos/cash-shifts', whenReady);
 app.use('/api/finance/cash-shifts', whenReady);

 /* ---------- one shift = one summary row (shared by cashier + Finance) ---------- */
 const summarySql = `SELECT s.shift_id AS id, s.cashier_id AS "cashierId", s.cashier_name AS "cashierName",
   s.opened_at AS "openedAt", s.closed_at AS "closedAt",
   s.opening_cash::float8 AS "openingCash", s.closing_cash::float8 AS "closingCash", s.closing_note AS "closingNote",
   s.closing_breakdown AS "closingBreakdown", s.closing_deposit::float8 AS "closingDeposit",
   (cs.cash_sales + oc.order_cash)::float8 AS "cashSales", (cs.cash_tx + oc.order_cash_tx)::int AS "cashTransactions",
   cs.card_sales::float8 AS "cardSales", cs.card_tx AS "cardTransactions", cs.pending_voids AS "pendingVoids",
   mv.cash_in::float8 AS "cashIn", mv.cash_out::float8 AS "cashOut",
   oc.order_cash::float8 AS "orderCash", oc.order_cash_tx AS "orderCashTransactions",
   rt.cash_returns::float8 AS "cashReturns", rt.cash_return_tx AS "cashReturnTransactions", rt.pending_returns AS "pendingReturns",
   (s.opening_cash + cs.cash_sales + oc.order_cash + mv.cash_in - mv.cash_out - rt.cash_returns)::float8 AS "expectedCash",
   CASE WHEN s.closed_at IS NOT NULL THEN ROUND(s.closing_cash - (s.opening_cash + cs.cash_sales + oc.order_cash + mv.cash_in - mv.cash_out - rt.cash_returns), 2)::float8 END AS "difference"
  FROM pos_cash_shifts s
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(p.total) FILTER (WHERE p.method='Cash'),0) AS cash_sales,
                            COUNT(*) FILTER (WHERE p.method='Cash')::int AS cash_tx,
                            COALESCE(SUM(p.total) FILTER (WHERE p.method IN ('Card','Xendit')),0) AS card_sales,
                            COUNT(*) FILTER (WHERE p.method IN ('Card','Xendit'))::int AS card_tx,
                            COUNT(*) FILTER (WHERE p.status='Void Pending')::int AS pending_voids
                       FROM pos_sales p WHERE p.cash_shift_id = s.shift_id AND p.status <> 'Voided') cs ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(o.total),0) AS order_cash, COUNT(*)::int AS order_cash_tx
                       FROM orders o WHERE o.cash_shift_id = s.shift_id AND o.payment_status = 'paid' AND o.status <> 'Cancelled') oc ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(m.amount) FILTER (WHERE m.kind='cash_in'),0) AS cash_in,
                            COALESCE(SUM(m.amount) FILTER (WHERE m.kind='cash_out'),0) AS cash_out
                       FROM pos_cash_movements m WHERE m.shift_id = s.shift_id) mv ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(r.amount) FILTER (WHERE r.status='approved' AND r.refund_method='Cash' AND r.refund_shift_id = s.shift_id),0) AS cash_returns,
                            COUNT(*) FILTER (WHERE r.status='approved' AND r.refund_method='Cash' AND r.refund_shift_id = s.shift_id)::int AS cash_return_tx,
                            COUNT(*) FILTER (WHERE r.status='pending' AND r.refund_method='Cash' AND r.requested_shift_id = s.shift_id)::int AS pending_returns
                       FROM pos_return_requests r WHERE r.refund_shift_id = s.shift_id OR r.requested_shift_id = s.shift_id) rt ON true`;
 const flagged = s => {            // review flags used by the Finance monitor
  const flags = [];
  if (s.difference != null && Math.abs(s.difference) >= VARIANCE_ALERT) flags.push(s.difference < 0 ? 'Large shortage' : 'Large overage');
  if (!s.closedAt && Date.now() - new Date(s.openedAt).getTime() > STALE_HOURS*3600000) flags.push('Open too long');
  if (s.pendingVoids) flags.push(s.pendingVoids + ' void pending');
  if (s.pendingReturns) flags.push(s.pendingReturns + ' return pending');
  return flags;
 };
 const movementsFor = async ids => {
  if (!ids.length) return new Map();
  const r = await pool.query(`SELECT movement_id AS id, shift_id AS "shiftId", kind, amount::float8 AS amount, reason, created_at AS "createdAt"
                               FROM pos_cash_movements WHERE shift_id = ANY($1) ORDER BY created_at`, [ids]);
  const m = new Map(); r.rows.forEach(x => { (m.get(String(x.shiftId)) || m.set(String(x.shiftId), []).get(String(x.shiftId))).push(x); }); return m;
 };

 const getThreshold = async (db) => Number((await (db||pool).query('SELECT reason_threshold::float8 AS t FROM cash_shift_rules WHERE id=1')).rows[0]?.t ?? rules.DEFAULT_REASON_THRESHOLD);
 const dayOf = ts => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ts));
 // an open shift that began on an earlier (Philippine) day: counted and closed before anything else happens
 app.locals.shiftIsStale = (openedAt) => dayOf(openedAt) < clock().date;
 // sales, cash collection and cash movements are refused on a shift that must be closed (pos-shop.js and below)
 app.locals.shiftMustClose = (openedAt) => mustClose(openedAt);
 const MUST_CLOSE_MSG = 'It is time to close your cash shift. Count the drawer and close it first; no more sales or cash entries can be made on this shift.';

 /* ---------- cashier ---------- */
 // One call tells the POS which screen to show after sign-in: open form (pre-filled), store closed, or close yesterday's shift first.
 app.get('/api/pos/cash-shifts/gate',auth('cashier'),wrap(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM (${summarySql}) x WHERE "cashierId"=$1 AND "closedAt" IS NULL LIMIT 1`,[req.user.id]);
  const cur=r.rows[0]||null, h=hours();
  const must=!!cur&&mustClose(cur.openedAt);
  const state=rules.gateState({clock:{state:h.state,date:h.date},canOpenShift:h.canOpenShift,mustClose:must,current:cur&&{id:cur.id,openedDay:dayOf(cur.openedAt)}});
  const out={state,hours:h,reasonThreshold:await getThreshold(),shift:null,suggested:null};
  if(cur){cur.movements=(await movementsFor([cur.id])).get(String(cur.id))||[];cur.hours=h;out.shift=cur;}
  else{
   const p=await pool.query(`SELECT * FROM (${summarySql}) x WHERE "closedAt" IS NOT NULL ORDER BY "closedAt" DESC LIMIT 1`);   // the drawer carries over whoever closed last
   out.suggested=rules.suggestOpening(p.rows[0]);
  }
  res.json(out);
 }));

 app.get('/api/pos/cash-shifts/current',auth('cashier'),wrap(async(req,res)=>{
  const r=await pool.query(`SELECT * FROM (${summarySql}) x WHERE "cashierId"=$1 AND "closedAt" IS NULL LIMIT 1`,[req.user.id]);
  const s=r.rows[0]; if(!s) return res.json(null);
  s.movements=(await movementsFor([s.id])).get(String(s.id))||[];
  s.hours=hours();
  res.json(s);
 }));

 app.post('/api/pos/cash-shifts/open',auth('cashier'),wrap(async(req,res)=>{
  const amount=req.body?.openingCash;
  if(!money(amount))return fail(res,400,'Enter a valid opening cash amount (0 or more, up to 2 decimals).','openingCash');
  const h=hours();
  if(!h.canOpenShift)return fail(res,409,h.state==='after'
    ?'The store is closed for today (open '+h.open+' to '+h.close+'). Shifts can be opened again tomorrow from '+h.firstOpen+'.'
    :h.state==='open'
    ?'It is too close to closing time ('+h.close+') to start a new shift: shifts are closed from '+h.forceCloseFrom+'. You can open your shift again tomorrow from '+h.firstOpen+'.'
    :'Too early: the store opens at '+h.open+'. You can open your shift from '+h.firstOpen+'.');
  const result=await tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
   const old=await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL',[req.user.id]);
   if(old.rowCount)return {error:'You already have an open cash shift.'};
   const prev=(await client.query(`SELECT * FROM (${summarySql}) x WHERE "closedAt" IS NOT NULL ORDER BY "closedAt" DESC LIMIT 1`)).rows[0];
   const sug=rules.suggestOpening(prev);
   const r=await client.query('INSERT INTO pos_cash_shifts(cashier_id,cashier_name,opening_cash) VALUES ($1,$2,$3) RETURNING shift_id',[req.user.id,req.user.name,amount]);
   await log(client,req.user,`Shift #${r.rows[0].shift_id} opened — starting cash ${peso(amount)}`
     +(sug?(Math.abs(amount-sug.amount)<0.005?` (confirmed as carried over from shift #${sug.fromShiftId})`:` — carried over from shift #${sug.fromShiftId} was ${peso(sug.amount)}, cashier entered ${peso(amount)} (${amount<sug.amount?'short ':'over '}${peso(Math.abs(amount-sug.amount))})`):' (no earlier shift to carry over)'));
   return {id:r.rows[0].shift_id};
  });if(result.error)return fail(res,409,result.error);res.status(201).json(result);
 }));

 app.post('/api/pos/cash-shifts/close',auth('cashier'),wrap(async(req,res)=>{
  const amount=req.body?.closingCash, note=req.body?.note ?? '', breakdown=req.body?.breakdown, deposit=req.body?.deposit===undefined||req.body?.deposit===null||req.body?.deposit===''?0:req.body.deposit;
  if(!money(amount))return fail(res,400,'Enter the actual cash counted (0 or more, up to 2 decimals).','closingCash');
  if(typeof note!=='string'||note.length>500)return fail(res,400,'Closing note must be at most 500 characters.','note');
  if(!money(deposit))return fail(res,400,'Enter the deposit as 0 or more, up to 2 decimals.','deposit');
  const dp=rules.depositProblem(deposit,amount); if(dp)return fail(res,400,dp,'deposit');
  let bd=null;
  if(breakdown!==undefined&&breakdown!==null){
   if(typeof breakdown!=='object'||Array.isArray(breakdown))return fail(res,400,'Invalid cash count.','breakdown');
   let sum=0; bd={};
   for(const [k,v] of Object.entries(breakdown)){
    if(!DENOMS.includes(k)||!Number.isInteger(v)||v<0||v>100000)return fail(res,400,'Invalid cash count.','breakdown');
    if(v>0){bd[k]=v;sum+=Number(k)*v;}
   }
   if(Math.abs(sum-amount)>0.004)return fail(res,400,'The counted notes and coins add up to a different amount than you entered.','closingCash');
  }
  const result=await tx(async client=>{
   await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
   const r=await client.query('SELECT shift_id FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE',[req.user.id]);
   if(!r.rowCount)return {error:'No open shift found.'};
   const id=r.rows[0].shift_id;
   const cur=(await client.query(`SELECT * FROM (${summarySql}) x WHERE id=$1`,[id])).rows[0];
   const diff=r2(amount-cur.expectedCash), limit=await getThreshold(client);
   if(rules.reasonRequired(diff,limit)&&note.trim().length<5)return {error:'The count is '+(diff<0?'short':'over')+' by ₱'+Math.abs(diff).toFixed(2)+', more than the ₱'+limit.toFixed(2)+' allowed without a reason. Please write a short explanation (at least 5 characters).',field:'note',status:400};
   await client.query('UPDATE pos_cash_shifts SET closed_at=now(),closing_cash=$2,closing_note=$3,closing_breakdown=$4,closing_deposit=$5 WHERE shift_id=$1',[id,amount,note.trim(),bd?JSON.stringify(bd):null,deposit]);
   const report=await client.query(`SELECT * FROM (${summarySql}) x WHERE id=$1`,[id]);
   const c=report.rows[0];
   await log(client,req.user,`Shift #${id} closed — expected ${peso(c.expectedCash)}, counted ${peso(amount)}, `
     +(diff===0?'balanced':(diff<0?'SHORT ':'OVER ')+peso(Math.abs(diff))+(Math.abs(diff)>=VARIANCE_ALERT?' (flagged for Finance review)':''))
     +(c.cashReturns?` · cash returns ${peso(c.cashReturns)}`:'')+(deposit>0?` · deposit ${peso(deposit)} taken out, ${peso(r2(amount-deposit))} stays for the next shift`:'')+(note.trim()?` · Note: ${note.trim()}`:''));
   c.nextOpening=r2(amount-deposit);
   return c;
  });if(result.error)return fail(res,result.status||409,result.error,result.field);res.json(result);
 }));

 app.post('/api/pos/cash-shifts/movements',auth('cashier'),wrap(async(req,res)=>{
  const {kind,amount,reason}=req.body||{};
  if(!['cash_in','cash_out'].includes(kind))return fail(res,400,'Choose cash added or cash removed.','kind');
  if(!money(amount)||amount<=0)return fail(res,400,'Enter an amount greater than 0 (up to 2 decimals).','amount');
  if(typeof reason!=='string'||reason.trim().length<5||reason.trim().length>300)return fail(res,400,'Write a reason (5–300 characters).','reason');
  const result=await tx(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[73001,req.user.id]);
    const shift=await client.query('SELECT shift_id, opened_at FROM pos_cash_shifts WHERE cashier_id=$1 AND closed_at IS NULL FOR UPDATE',[req.user.id]);
    if(!shift.rowCount)return {error:'Open a cash shift first.'};
    if(mustClose(shift.rows[0].opened_at))return {error:MUST_CLOSE_MSG,status:409};
    const id=shift.rows[0].shift_id;
    if(kind==='cash_out'){   // the drawer cannot go below zero
     const cur=(await client.query(`SELECT "expectedCash" FROM (${summarySql}) x WHERE id=$1`,[id])).rows[0];
     if(amount>cur.expectedCash+0.004)return {error:'Only ₱'+r2(cur.expectedCash).toFixed(2)+' should be in the drawer. You cannot remove more than that.',field:'amount',status:400};
    }
    const dup=await client.query(`SELECT 1 FROM pos_cash_movements WHERE shift_id=$1 AND kind=$2 AND amount=$3 AND reason=$4 AND created_at > now() - interval '15 seconds'`,[id,kind,amount,reason.trim()]);
    if(dup.rowCount)return {error:'That exact movement was just recorded.'};
    const r=await client.query('INSERT INTO pos_cash_movements(shift_id,cashier_id,kind,amount,reason) VALUES($1,$2,$3,$4,$5) RETURNING movement_id',[id,req.user.id,kind,amount,reason.trim()]);
    await log(client,req.user,`Shift #${id}: cash ${kind==='cash_in'?'added':'removed'} ${peso(amount)} — ${reason.trim()}`);
    return {id:r.rows[0].movement_id};
  });
  if(result.error)return fail(res,result.status||409,result.error,result.field);res.status(201).json(result);
 }));

 app.get('/api/pos/cash-shifts/movements',auth('cashier','finance'),wrap(async(req,res)=>{
  const finance=req.user.role==='finance';
  const r=await pool.query(`SELECT m.movement_id AS id,m.shift_id AS "shiftId",m.kind,m.amount::float8 AS amount,m.reason,m.created_at AS "createdAt",s.cashier_name AS "cashierName" FROM pos_cash_movements m JOIN pos_cash_shifts s ON s.shift_id=m.shift_id ${finance?'':'WHERE m.cashier_id=$1'} ORDER BY m.created_at DESC LIMIT 300`,finance?[]:[req.user.id]);
  res.json(r.rows);
 }));

 app.get('/api/pos/cash-shifts/history',auth('cashier','finance'),wrap(async(req,res)=>{
  const finance=req.user.role==='finance';
  const q=finance?`SELECT * FROM (${summarySql}) x ORDER BY "openedAt" DESC LIMIT 200`:`SELECT * FROM (${summarySql}) x WHERE "cashierId"=$1 ORDER BY "openedAt" DESC LIMIT 50`;
  const r=await pool.query(q,finance?[]:[req.user.id]);res.json(r.rows);
 }));

 /* ---------- Finance: the difference above which a closing reason is required ---------- */
 app.get('/api/finance/cash-shifts/rules',auth('finance'),wrap(async(req,res)=>{
  const r=(await pool.query('SELECT reason_threshold::float8 AS "reasonThreshold", updated_at AS "updatedAt", u.full_name AS "updatedBy" FROM cash_shift_rules c LEFT JOIN users u ON u.user_id=c.updated_by WHERE c.id=1')).rows[0];
  res.json(r);
 }));
 app.put('/api/finance/cash-shifts/rules',auth('finance'),wrap(async(req,res)=>{
  const v=req.body?.reasonThreshold;
  if(!money(v)||v>10000)return fail(res,400,'Enter an amount from 0 to 10,000 pesos (up to 2 decimals).','reasonThreshold');
  const out=await tx(async client=>{
   const old=await getThreshold(client);
   await client.query('UPDATE cash_shift_rules SET reason_threshold=$1,updated_by=$2,updated_at=now() WHERE id=1',[v,req.user.id]);
   await log(client,req.user,`Cash shift rule changed: a closing reason is required above ${peso(v)} (was ${peso(old)})`);
   return {reasonThreshold:v};
  });
  res.json(out);
 }));

 /* ---------- Finance monitor: shifts + payment summary (POS and online) for a date range ---------- */
 const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v||'')) && !Number.isNaN(Date.parse(v)) ? v : null;
 app.get('/api/finance/cash-shifts/report',auth('finance'),wrap(async(req,res)=>{
  const from=ymd(req.query.from), to=ymd(req.query.to);
  if(req.query.from&&!from||req.query.to&&!to) return fail(res,400,'Use dates like 2026-10-14.');
  const today=(await pool.query('SELECT (now() AT TIME ZONE $1)::date::text AS d',[TZ])).rows[0].d;
  const f=from||to||today, t=to||from||today;
  if(f>t) return fail(res,400,'The start date must not be after the end date.');
  if((Date.parse(t)-Date.parse(f))/86400000>92) return fail(res,400,'Choose a range of 92 days or less.');
  const shifts=(await pool.query(`SELECT * FROM (${summarySql}) x WHERE ("openedAt" AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date ORDER BY "openedAt" DESC`,[TZ,f,t])).rows;
  const mv=await movementsFor(shifts.map(s=>s.id));
  shifts.forEach(s=>{ s.movements=mv.get(String(s.id))||[]; s.flags=flagged(s); });
  const closed=shifts.filter(s=>s.closedAt);
  const totals={
   shifts:shifts.length, open:shifts.length-closed.length,
   expectedCash:r2(shifts.reduce((n,s)=>n+s.expectedCash,0)),
   countedCash:r2(closed.reduce((n,s)=>n+s.closingCash,0)),
   shortage:r2(closed.reduce((n,s)=>n+Math.min(0,s.difference),0)),
   overage:r2(closed.reduce((n,s)=>n+Math.max(0,s.difference),0)),
   needsReview:shifts.filter(s=>s.flags.length).length
  };
  const pos=(await pool.query(`SELECT method, COUNT(*) FILTER (WHERE status<>'Voided')::int AS count,
      COALESCE(SUM(total) FILTER (WHERE status<>'Voided'),0)::float8 AS total,
      COUNT(*) FILTER (WHERE status='Voided')::int AS voided,
      COALESCE(SUM(total) FILTER (WHERE status='Voided'),0)::float8 AS "voidedTotal",
      COALESCE((SELECT SUM(r.amount) FROM pos_return_requests r JOIN pos_sales s2 ON s2.sale_id=r.sale_id
                 WHERE r.status='approved' AND s2.method=pos_sales.method
                   AND (s2.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date),0)::float8 AS returned
    FROM pos_sales WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY method ORDER BY method`,[TZ,f,t])).rows;
  const online=(await pool.query(`SELECT o.payment_method AS method,
      COUNT(*) FILTER (WHERE o.status NOT IN ('Pending Confirmation','Cancelled'))::int AS count,
      COALESCE(SUM(o.total) FILTER (WHERE o.status NOT IN ('Pending Confirmation','Cancelled')),0)::float8 AS collected,
      COUNT(*) FILTER (WHERE o.status='Pending Confirmation')::int AS "awaitingCount",
      COALESCE(SUM(o.total) FILTER (WHERE o.status='Pending Confirmation'),0)::float8 AS awaiting,
      COUNT(*) FILTER (WHERE o.status='Cancelled')::int AS cancelled,
      COALESCE((SELECT SUM(r.amount) FROM order_refund_requests r JOIN orders o2 ON o2.order_id=r.order_id
                 WHERE r.status='approved' AND o2.payment_method=o.payment_method
                   AND (o2.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date),0)::float8 AS refunded
    FROM orders o WHERE (o.created_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date GROUP BY o.payment_method ORDER BY o.payment_method`,[TZ,f,t])).rows;
  res.json({from:f,to:t,varianceAlert:VARIANCE_ALERT,reasonThreshold:await getThreshold(),totals,shifts,payments:{pos,online}});
 }));
 /* ---------- automation: close-of-day reminders (runs with the other automation jobs every 15 minutes) ---------- */
 async function shiftHours() {
  const nc = app.locals.notifications; if (!nc) return { skipped: 'no notification center' };
  const c = clock(), out = { reminded: 0, overdue: 0 };
  const open = (await pool.query('SELECT shift_id, cashier_id, cashier_name, opened_at FROM pos_cash_shifts WHERE closed_at IS NULL')).rows;
  for (const sh of open) {
   const openedDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(sh.opened_at));
   const pastDay = openedDay < c.date;                                    // left open since an earlier day
   if (!pastDay && c.minutes >= CLOSE_MIN - REMIND && c.minutes < CLOSE_MIN) {
    out.reminded += await nc.notifyUser(sh.cashier_id, { category: 'orders', severity: 'info', title: 'Close your cash shift by ' + label(CLOSE_MIN),
      body: 'The store closes at ' + label(CLOSE_MIN) + '. Count your drawer and close shift #' + sh.shift_id + ' before you leave.',
      link: 'POS_Cashier.html#shift', entityType: 'cash_shift', entityId: String(sh.shift_id), dedupeKey: 'shift-remind:' + sh.shift_id + ':' + c.date }, 'cashier') ? 1 : 0;
   }
   if (pastDay || c.minutes >= CLOSE_MIN + OVERDUE) {
    const key = 'shift-overdue:' + sh.shift_id + ':' + c.date;
    const n = await nc.notifyRole('finance', { category: 'orders', severity: 'warn', title: 'Cash shift still open after closing time',
      body: (sh.cashier_name || 'A cashier') + "'s shift #" + sh.shift_id + ' is still open' + (pastDay ? ' since ' + openedDay : ' after ' + label(CLOSE_MIN)) + '. Ask them to count and close the drawer.',
      link: 'Finance_Inventory.html#reports', entityType: 'cash_shift', entityId: String(sh.shift_id), dedupeKey: key });
    await nc.notifyUser(sh.cashier_id, { category: 'orders', severity: 'warn', title: 'Your cash shift is past closing time',
      body: 'Shift #' + sh.shift_id + ' is still open. Count your drawer and close it now.', link: 'POS_Cashier.html#shift',
      entityType: 'cash_shift', entityId: String(sh.shift_id), dedupeKey: key + ':cashier' }, 'cashier');
    if (n) out.overdue++;
   }
  }
  return out;
 }
 (app.locals.automationJobs = app.locals.automationJobs || []).push({ name: 'shift-hours', run: shiftHours });
};