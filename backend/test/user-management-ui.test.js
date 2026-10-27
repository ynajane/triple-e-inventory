'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch { ({ JSDOM } = require(path.join(process.env.JSDOM_DIR, 'node_modules/jsdom'))); }
const root = path.resolve(__dirname, '../..');
const script = fs.readFileSync(path.join(root,'Finance_Inventory/script.js'),'utf8');
const html = fs.readFileSync(path.join(root,'Finance_Inventory/Finance_Inventory.html'),'utf8');
function section(start,end) { const i=script.indexOf(start); assert.ok(i>=0); return script.slice(i,script.indexOf(end,i)); }
function fixture(t) {
 const dom=new JSDOM(html,{runScripts:'outside-only',url:'http://localhost'}); t.after(()=>dom.window.close());
 const w=dom.window;
 w.escapeHTML=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 w.openEditUserModal=()=>{};
 w.eval('var userAccountsData=[]; var accountView="current"; var accountReloadVersion=0;'+section('function getInitials(', 'function inviteToast('));
 return w;
}
test('Deleted pill, role/status filters and KPI counts do not mix current and deleted accounts',t=>{
 const w=fixture(t),d=w.document;
 w.eval(`userAccountsData.push(
  {id:1,name:'Active Staff',role:'Cashier',roleKey:'cashier',status:'active',lastLogin:'Never'},
  {id:2,name:'Disabled Customer',role:'Customer',roleKey:'customer',status:'disabled',lastLogin:'Never'},
  {id:3,name:'Deleted Staff',role:'Cashier',roleKey:'cashier',status:'disabled',deletedAt:'2026-10-27T00:00:00Z',lastLogin:'Never'}
 ); renderAccountsTable();`);
 const names=()=>d.getElementById('accountsTableBody').textContent;
 assert.match(names(),/Active Staff/); assert.doesNotMatch(names(),/Deleted Staff/);
 assert.equal(d.querySelector('[data-view="current"] .count').textContent,'2');
 assert.equal(d.querySelector('#accountViewToggle [data-view="deleted"] .count').textContent,'1');
 d.getElementById('accountStatusFilter').value='active';
 w.eval('accountView="deleted"; renderAccountsTable();');
 assert.match(names(),/Deleted Staff/); assert.doesNotMatch(names(),/Active Staff/);
 assert.equal(d.getElementById('accountStatusFilter').hidden,true);
 assert.equal(d.querySelector('#accountViewToggle [data-view="deleted"]').getAttribute('aria-pressed'),'true');
 assert.equal(d.querySelector('#accountsTableBody .user-row').dataset.index,'2','row identity stays tied to original account');
 d.getElementById('accountRoleFilter').value='customer'; w.renderAccountsTable();
 assert.match(names(),/No deleted accounts/);
 w.eval(fs.readFileSync(path.join(root,'Finance_Inventory/ui2-usermgmt.js'),'utf8')); d.dispatchEvent(new w.Event('DOMContentLoaded'));
 assert.equal(d.getElementById('umKpiTotal').textContent,'2');
 assert.equal(d.getElementById('umKpiCustomers').textContent,'1');
});
test('overlapping reloads cannot put stale accounts back into the list',async t=>{
 const w=fixture(t); w.inviteToast=()=>{};
 w.eval(section('async function reloadUserAccounts(', 'function initUserManagement('));
 let requests=[]; w.fetch=()=>new Promise(resolve=>requests.push(resolve));
 const first=w.reloadUserAccounts(false), second=w.reloadUserAccounts(false);
 const response=data=>({ok:true,status:200,json:async()=>data});
 requests[2](response([{id:2,name:'Current',roleKey:'customer',status:'active',lastLogin:'Never'}]));
 requests[3](response([{id:3,name:'Deleted',roleKey:'customer',status:'disabled',deletedAt:'2026-10-27',lastLogin:'Never'}]));
 await second;
 requests[0](response([{id:1,name:'Stale',roleKey:'customer',status:'active',lastLogin:'Never'}])); requests[1](response([])); await first;
 assert.equal(w.eval('userAccountsData.length'),2); assert.equal(w.eval('userAccountsData[0].id'),2);
});
test('location choices use only the selected department and preserve unchanged legacy edits',t=>{
 const dom=new JSDOM('<select id="npDept"><option></option><option>Raw Materials</option><option>Finishing Supplies</option><option>Finished Goods</option></select><select id="npLocation"></select><div id="npLocationNewWrap"><input id="npLocationNew"></div>',{runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window,d=w.document;
 w.$=id=>d.getElementById(id); w.clean=v=>String(v||'').trim(); w.esc=w.clean;
 w.productCatalogData=[{department:'Raw Materials',location:'Steel rack'},{department:'Finishing Supplies',location:'Paint cabinet'},{department:'Finished Goods',location:'Dispatch bay'}];
 // Project restriction: inspect only the storage-location block of api-bridge.js via grep.
 const block=execFileSync('rg',['--no-heading','--no-line-number','-A','45','^  const NEW_LOCATION',path.join(root,'Finance_Inventory/api-bridge.js')],{encoding:'utf8'});
 w.eval(block.slice(0,block.indexOf('  // the location to save:')));
 const choices=()=>Array.from(d.getElementById('npLocation').options,o=>o.value);
 for(const [department,location] of [['Raw Materials','Steel rack'],['Finishing Supplies','Paint cabinet'],['Finished Goods','Dispatch bay']]) {
  d.getElementById('npDept').value=department; w.fillLocations('');
  assert.ok(choices().includes(location));
  assert.equal(choices().filter(l=>['Steel rack','Paint cabinet','Dispatch bay'].includes(l)).length,1);
  assert.ok(choices().includes(department+' Storage'));
 }
 w.fillLocations('Legacy room'); assert.equal(d.getElementById('npLocation').value,'Legacy room');
 d.getElementById('npLocationNew').value='stale'; d.getElementById('npDept').value='Raw Materials';w.fillLocations('');
 assert.ok(!choices().includes('Legacy room')); assert.equal(d.getElementById('npLocationNew').value,'');
 d.getElementById('npDept').value='';w.fillLocations('');assert.equal(d.getElementById('npLocation').disabled,true);
});
