const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../../Finance_Inventory/POS_Cashier.html'),'utf8');
const section = (start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
function fixture() {
 const elements = new Map();
 const $ = id => { if(!elements.has(id)) elements.set(id,{value:'',textContent:'',innerHTML:'',checked:false,hidden:false,disabled:false}); return elements.get(id); };
 const store = {};
 const context = vm.createContext({ $, document:{querySelectorAll:()=>[],addEventListener:()=>{}}, window:{}, URL,
  console, setInterval:()=>0, encodeURIComponent, localStorage:{setItem:(k,v)=>store[k]=v},
  toast:()=>{}, resetSale:()=>{}, loadTodaySales:async()=>[], renderSales:()=>{}, renderCart:()=>{},
  refreshCatalogue:async()=>{},writeStore:()=>{store.state=vm.runInContext('JSON.stringify({payments,paymentDraft})',context);},
  peso:n=>'₱'+Number(n).toFixed(2), esc:x=>String(x),
  USER:{id:1}, cart:[{sku:'FG',qty:2}], method:'Cash', busy:false, connected:true,refreshingStock:false,
  paymentsReady:true,payments:[],paymentDraft:null,recoveryBusy:false,
  cents:n=>Math.round(Number(n)*100), parseMoney:v=>Number(v)||0, total:()=>100,
  belowMin:()=>null, hasOverride:()=>false, CARD_RE:/^[A-Z0-9-]{4,30}$/, cardCode:()=>$('cardRef').value,
  fulfil:'Pickup', api:async()=>[],
 });
 vm.runInContext("const paymentBlocksSale = () => !paymentsReady || !!paymentDraft || payments.some(p => p.needsCartReview || ['pending','review','unknown'].includes(p.status));",context);
 vm.runInContext(section('function updatePay()','function addToCart('),context);
 return { context,$,store,run:code=>vm.runInContext(code,context) };
}
test('checkout explains missing cash, manual reference and verification; blocks disconnected and pending sales',()=>{
 const f=fixture(); f.run('updatePay()'); assert.match(f.$('payErr').textContent,/cash received/); assert.equal(f.$('complete').disabled,true);
 f.$('tendered').value='100';f.run('updatePay()');assert.equal(f.$('complete').disabled,false);
 f.run("method='Card';updatePay()");assert.match(f.$('payErr').textContent,/reference/);
 f.$('cardRef').value='BANK-1234';f.run('updatePay()');assert.match(f.$('payErr').textContent,/verified receipt/);
 f.$('cardOk').checked=true;f.run('updatePay()');assert.equal(f.$('complete').disabled,false);
 for(const state of ["connected=false","connected=true;refreshingStock=true","refreshingStock=false;paymentsReady=false","paymentsReady=true;payments=[{status:'review'}]"]){
  f.run(state+';updatePay()');assert.equal(f.$('complete').disabled,true);assert.ok(f.$('payErr').textContent.length>10);
 }
});
test('catalogue connection failures propagate without substituting demo inventory',async()=>{
 const f=fixture(); f.context.api=async()=>{throw new TypeError('network disconnected');};
 f.run(section('async function loadProducts()','async function submitSale('));
 await assert.rejects(f.run('loadProducts()'),/network disconnected/);
 assert.doesNotMatch(source,/return DEMO/);
 f.context.fetch=async()=>{throw new TypeError('network disconnected');};
 f.context.AbortSignal=AbortSignal;f.context.connectionState=ok=>{f.context.connected=ok;};f.context.stockStamp=()=>{};
 f.run(section('async function api(','async function loadProducts()'));
 await assert.rejects(f.run('loadProducts()'),/network disconnected/);assert.equal(f.context.connected,false);
});
test('uncertain checkout saves its original request and recovers it before any second collection',async()=>{
 const f=fixture();f.run(section('const cartSignature =','async function completeSale()'));
 let post;f.context.api=async(route,opts)=>{
  if(opts){post=JSON.parse(opts.body);throw new TypeError('response lost');}
  return [{paymentId:'9',requestId:'original-checkout-00001',status:'pending',amount:100}];
 };
 await f.run("beginXendit({requestId:'original-checkout-00001',items:[{sku:'FG',qty:2,price:50}]})");
 assert.deepEqual(post.items,[{sku:'FG',qty:2}]);
 assert.equal(f.run('paymentBlocksSale()'),true);
 assert.equal(JSON.parse(f.store.state).paymentDraft.payload.requestId,'original-checkout-00001');
 assert.match(f.$('paymentRecoveryList').innerHTML,/Waiting for verified payment/);
 let resets=0;f.context.resetSale=()=>resets++;
 f.context.api=async()=>({payment_id:'9',status:'paid',sale_id:'44'});
 await f.run("checkXenditPayment('9')");
 assert.equal(resets,1);assert.equal(f.run('paymentDraft'),null);assert.equal(f.run('paymentBlocksSale()'),false);
 assert.match(f.$('paymentRecoveryList').innerHTML,/Payment verified/);
 await f.run("checkXenditPayment('9')");assert.equal(resets,1,'a remembered paid result must never clear the next cart');
});
test('review and status failures keep checkout blocked; a validation refusal can be corrected',async()=>{
 const f=fixture();f.run(section('const cartSignature =','async function completeSale()'));
 f.context.payments=[{paymentId:'2',status:'pending',requestId:'review-checkout-00001',amount:100}];
 f.context.api=async()=>({status:'review'});await f.run("checkXenditPayment('2')");
 assert.equal(f.run('paymentBlocksSale()'),true);assert.match(f.$('paymentRecoveryList').innerHTML,/Finance review/);
 f.context.api=async()=>{throw new TypeError('offline');};await f.run('recoverPayments()');
 assert.equal(f.run('paymentsReady'),false);assert.equal(f.run('paymentBlocksSale()'),true);
 const g=fixture();g.run(section('const cartSignature =','async function completeSale()'));
 g.context.api=async(route,opts)=>{if(opts){const e=new Error('Invalid address');e.status=400;throw e;}return[];};
 await g.run("beginXendit({requestId:'rejected-checkout-0001',items:[{sku:'FG',qty:2}]})");
 assert.equal(g.run('paymentDraft'),null);assert.equal(g.run('paymentBlocksSale()'),false);
});
test('daily totals separate cash, manually verified payments and online checkout, subtracting refunds and excluding voids',()=>{
 const f=fixture();Object.assign(f.context,{sales:[
  {id:1,method:'Cash',total:100,refunded:25,status:'Completed',items:[],createdAt:0},
  {id:2,method:'Card',total:200,status:'Completed',items:[],createdAt:0},
  {id:3,method:'Xendit',total:300,status:'Completed',items:[],createdAt:0},
  {id:4,method:'Cash',total:999,status:'Voided',items:[],createdAt:0}],canReturn:()=>false});
 f.run(section('function renderSales()','/* ----- invoice as PNG'));f.run('renderSales()');
 assert.equal(f.$('stCash').textContent,'₱75.00');assert.equal(f.$('stManual').textContent,'₱200.00');assert.equal(f.$('stOnline').textContent,'₱300.00');
});

test('a recovered payment for a different basket keeps the cart and asks for acknowledgement',async()=>{
 const f=fixture();f.run(section('const cartSignature =','async function completeSale()'));
 f.context.payments=[{paymentId:'3',status:'pending',items:[{sku:'OTHER',qty:1}]}];
 let resets=0;f.context.resetSale=()=>resets++;
 f.context.api=async()=>({status:'paid'});await f.run("checkXenditPayment('3')");
 assert.equal(resets,0);assert.equal(f.run('paymentBlocksSale()'),true);
 assert.match(f.$('paymentRecoveryList').innerHTML,/Keep current cart/);
});

const orderSource = fs.readFileSync(path.join(__dirname,'../../Finance_Inventory/cashier-orders.js'),'utf8');
const shiftSource = fs.readFileSync(path.join(__dirname,'../../Finance_Inventory/cash-shift-ui.js'),'utf8');
const extract = (text,start,end) => text.slice(text.indexOf(start), text.indexOf(end,text.indexOf(start)));
function orderFixture() {
 const elements = new Map(), listeners = {};
 const $ = id => elements.get(id);
 for (const id of ['coAction','coDetail','coLedger']) elements.set(id,{hidden:true,innerHTML:'',isConnected:true,querySelector:()=>null,addEventListener:()=>{}});
 const context = vm.createContext({ $, document:{activeElement:null,body:{style:{}},contains:()=>false,addEventListener:(name,fn)=>{listeners[name]=fn;}},
  busy:false, failReq:false, chosen:{id:'a'},target:'Packed',payFor:{id:'a'},payDraft:{amount:'10'},opener:null,
  setTimeout:fn=>fn(),encodeURIComponent,detailHtml:o=>o.id,ledgerHtml:l=>l.orderId,request:async()=>({}),
 });
 vm.runInContext(extract(orderSource,'function openModal(el)','/* ---------- details ---------- */'),context);
 vm.runInContext(extract(orderSource,'function openDetail(o)','function ledgerHtml(l)'),context);
 return {context,$,elements,listeners,run:code=>vm.runInContext(code,context)};
}
test('late order ledger success and failure cannot replace another order ledger',async()=>{
 for(const rejectOld of [false,true]) {
  const f=orderFixture();let resolveOld,reject;
  f.context.request=()=>new Promise((resolve,fail)=>{resolveOld=resolve;reject=fail;});
  f.run("openDetail({id:'A'})");const old=f.$('coLedger');old.isConnected=false;
  f.elements.set('coLedger',{isConnected:true,innerHTML:'Loading B'});
  f.context.request=async()=>({orderId:'B'});f.run("openDetail({id:'B'})");
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.$('coLedger').innerHTML,'B');
  if(rejectOld)reject(new Error('A offline'));else resolveOld({orderId:'A'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.$('coLedger').innerHTML,'B');
 }
});
test('order mutations keep the sheet and payment attempt through Escape and block replacement details',()=>{
 for(const flag of ['busy','failReq']) {
  const f=orderFixture();f.$('coAction').hidden=false;f.$('coAction').innerHTML='Saving payment';f.context[flag]=true;
  f.listeners.keydown({key:'Escape'});f.run("openDetail({id:'other'})");
  assert.equal(f.$('coAction').hidden,false);assert.equal(f.$('coAction').innerHTML,'Saving payment');
  assert.equal(f.run('payDraft.amount'),'10');assert.equal(f.$('coDetail').hidden,true);
  f.run('closeAction(true)');assert.equal(f.$('coAction').hidden,true);assert.equal(f.run('payDraft'),null);
 }
});
test('an old shift lookup cannot overwrite the payment sheet opened after it',async()=>{
 const f=orderFixture();Object.assign(f.context,{payReceipt:null,shiftOpen:null,payReq:'',dueOf:o=>o.total,peso:String,esc:String,
  moneyBox:()=>'',termsLine:()=>'',fld:()=>'',ONLINE_PAY:[],syncPayMethod:()=>{},syncShiftWarn:()=>{}});
 f.run(extract(orderSource,'async function openPay(','function syncPayMethod()'));
 let resolveFirst;f.context.request=()=>new Promise(resolve=>{resolveFirst=resolve;});
 f.elements.set('coPayForm',{isConnected:true});const first=f.run("openPay({id:'A',total:10})");
 f.$('coPayForm').isConnected=false;f.elements.set('coPayForm',{isConnected:true});
 f.context.request=async()=>null;await f.run("openPay({id:'B',total:20})");assert.equal(f.run('shiftOpen'),false);
 resolveFirst({id:1});await first;assert.equal(f.run('shiftOpen'),false);assert.equal(f.run('payFor.id'),'B');
});
test('cash denomination counts reject fractions, negative counts, exponents, invalid numbers and excessive totals',()=>{
 const context=vm.createContext({MAX:10000000,fmt:String});
 vm.runInContext(extract(shiftSource,' const DENOMS =',' let current ='),context);
 vm.runInContext(extract(shiftSource,' function readCashCount(inputs)',' /* ---------- dialog helper ---------- */'),context);
 const input=(value,den='1000',badInput=false)=>({value,dataset:{den},validity:{badInput},classList:{toggle:()=>{}},setAttribute:()=>{}});
 for(const raw of ['1.5','-1','1e2','Infinity','100001']) {
  context.inputs=[input(raw)];assert.equal(vm.runInContext('readCashCount(inputs).ok',context),false,raw);
 }
 context.inputs=[input('', '1000',true)];assert.equal(vm.runInContext('readCashCount(inputs).ok',context),false);
 context.inputs=[input('10001')];assert.equal(vm.runInContext('readCashCount(inputs).ok',context),false);
 context.inputs=[input('')];assert.equal(vm.runInContext('readCashCount(inputs).ok',context),false);
 context.inputs=[input('0')];assert.equal(vm.runInContext('readCashCount(inputs).value',context),0);assert.equal(vm.runInContext('readCashCount(inputs).ok',context),true);
 context.inputs=[input('2'),input('3','0.25'),input('1','0.05')];
 assert.equal(vm.runInContext('readCashCount(inputs).value',context),2000.8);
 assert.equal(vm.runInContext('readCashCount(inputs).counts["0.25"]',context),3);
});

test('cashier page memory restores all sidebar screens and never replaces a newly chosen screen after load',()=>{
 const memorySource=fs.readFileSync(path.join(__dirname,'../../Finance_Inventory/page-memory.js'),'utf8');
 for(const screen of ['orders','customers','reviews']) {
  const events={},timers=[],shown=[],storage={};
  const location={pathname:'/POS_Cashier.html',hash:'#shift',search:''};
  const context=vm.createContext({location,console,sessionStorage:{getItem:k=>storage[k],setItem:(k,v)=>{storage[k]=v;}},
   history:{pushState:(_s,_t,url)=>{location.hash=url;},replaceState:(_s,_t,url)=>{location.hash=url;}},
   setTimeout:fn=>timers.push(fn),window:{showPage:id=>shown.push(id),addEventListener:(name,fn)=>{events[name]=fn;}}});
  vm.runInContext(memorySource,context);context.window.showPage(screen);events.load();timers.forEach(fn=>fn());
  assert.equal(shown.at(-1),screen);assert.equal(location.hash,'#'+screen);assert.equal(storage['tripleE.page.pos_cashier.html'],screen);
  shown.length=0;vm.runInContext(memorySource,context);assert.equal(shown.at(-1),screen,'refresh restores '+screen);
 }
});

function salesRequestFixture() {
 const elements=new Map();
 const $=id=>{
  if(!elements.has(id)) { const classes=new Set();elements.set(id,{value:'',disabled:false,textContent:'',innerHTML:'',validity:{badInput:false},
   classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),contains:x=>classes.has(x)},focus:()=>{},addEventListener:()=>{}}); }
  return elements.get(id);
 };
 const input=(id,value)=>Object.assign($('item-'+id),{value,dataset:{item:id}});
 const rows=[input('11','1'),input('12','0')];
 const sales=[{id:'1',receiptNo:'INV-A',method:'Cash',status:'Completed',items:[{itemId:'11',name:'Whole item',unit:'pcs',qty:5,price:10,fractional:false},{itemId:'12',name:'Measured item',unit:'kg',qty:5,price:20,fractional:true}]},
  {id:'2',receiptNo:'INV-B',method:'Card',status:'Completed',items:[]}];
 const context=vm.createContext({ $,sales,voidId:null,salesRequestBusy:false,document:{querySelectorAll:()=>rows},window:{},
  esc:String,peso:n=>Number(n).toFixed(2),leftToReturn:i=>i.qty, lineCents:(p,q)=>Math.round(p*100*q),
  requestReturn:async()=>({}),requestVoid:async()=>({}),loadTodaySales:async()=>null,renderSales:()=>{},toast:()=>{}});
 vm.runInContext(section('function closeModal(id','/* CSP:'),context);
 vm.runInContext(section('let returnSale = null;','$(\'q\').oninput'),context);
 return {$,context,rows,sales,run:code=>vm.runInContext(code,context)};
}
test('return selection rejects every invalid typed line before submitting a valid mixed return',async()=>{
 for(const value of ['-1','1.001','1e2','Infinity','6','1000001']) {
  const f=salesRequestFixture();f.run("openReturn('1')");f.rows[1].value=value;f.$('returnReason').value='damaged';
  let calls=0;f.context.requestReturn=async()=>{calls++;};await f.$('returnSend').onclick();
  assert.equal(calls,0,value);assert.ok(f.$('returnErr').textContent);f.run('updateReturnTotal()');assert.equal(f.$('returnTotal').textContent,'—');
 }
 const f=salesRequestFixture();f.run("openReturn('1')");f.rows[0].value='0.5';
 assert.match(f.run('readReturnSelection().error'),/whole/);
 f.rows[0].value='1';f.rows[1].value='1.25';f.run('updateReturnTotal()');assert.equal(f.$('returnTotal').textContent,'35.00');
 f.rows[1].value='';f.rows[1].validity.badInput=true;assert.match(f.run('readReturnSelection().error'),/quantity/);
});
test('pending return keeps its invoice, blocks repeat sends and dismissal, and stays pending when the list refresh fails',async()=>{
 const f=salesRequestFixture();f.run("openReturn('1')");f.$('returnReason').value='damaged';
 let resolve,calls=0;f.context.requestReturn=async(id,lines)=>{calls++;assert.equal(id,'1');assert.equal(lines[0].qty,1);await new Promise(r=>{resolve=r;});};
 const pending=f.$('returnSend').onclick();assert.equal(f.$('returnSend').disabled,true);
 f.run("closeModal('returnBg');openReturn('2');openVoid('2')");await f.$('returnSend').onclick();
 assert.equal(f.$('returnBg').classList.contains('show'),true);assert.equal(f.run('returnSale.id'),'1');assert.equal(calls,1);
 resolve();await pending;assert.equal(f.sales[0].returnPending,true);assert.equal(f.sales[1].returnPending,undefined);
 assert.equal(f.$('returnBg').classList.contains('show'),false);assert.equal(f.run('salesRequestBusy'),false);
 assert.equal(f.sales[0].status,'Completed','request must not approve, void or refund a sale');
});
test('pending void updates its captured invoice even if the sales list is replaced',async()=>{
 const f=salesRequestFixture();f.run("openVoid('1')");f.$('voidReason').value='duplicate';
 let resolve,calls=0;f.context.requestVoid=async id=>{calls++;assert.equal(id,'1');await new Promise(r=>{resolve=r;});};
 const pending=f.$('voidSend').onclick();f.run("closeModal('voidBg');openVoid('2');openReturn('2')");await f.$('voidSend').onclick();
 assert.equal(calls,1);assert.equal(f.run('voidId'),'1');assert.equal(f.$('voidBg').classList.contains('show'),true);
 f.run("sales=[{id:'2',status:'Completed'}]");resolve();await pending;
 assert.equal(f.run('sales[0].status'),'Completed');assert.equal(f.run('salesRequestBusy'),false);assert.equal(f.$('voidBg').classList.contains('show'),false);
});
test('failed return and void requests preserve fields and allow correction and dismissal',async()=>{
 for(const kind of ['return','void']) {
  const f=salesRequestFixture();f.run(kind==='return'?"openReturn('1')":"openVoid('1')");f.$(kind+'Reason').value='other';f.$(kind+'Details').value='Keep this explanation';
  f.context[kind==='return'?'requestReturn':'requestVoid']=async()=>{throw new Error('Synthetic save refused');};
  await f.$(kind+'Send').onclick();assert.match(f.$(kind+'Err').textContent,/save refused/);
  assert.equal(f.$(kind+'Details').value,'Keep this explanation');assert.equal(f.$(kind+'Send').disabled,false);
  assert.equal(f.sales[0].status,'Completed');assert.equal(f.sales[0].returnPending,undefined);
  f.run(`closeModal('${kind}Bg')`);assert.equal(f.$(kind+'Bg').classList.contains('show'),false);
 }
});
