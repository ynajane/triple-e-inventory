'use strict';
/* test/user-management-reload.test.js — Verifies dynamic reload of User Management accounts.
   Run: node --no-warnings --test backend/test/user-management-reload.test.js
*/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

test('User Management - script.js contains reloadUserAccounts and window export', () => {
  const content = fs.readFileSync('Finance_Inventory/script.js', 'utf8');
  assert.ok(content.includes('async function reloadUserAccounts'), 'reloadUserAccounts function is defined');
  assert.ok(content.includes('window.reloadUserAccounts = reloadUserAccounts'), 'exposed on window');
  assert.ok(content.includes('fetch("/api/users"'), 'fetches /api/users endpoint');
});

test('User Management - auto-refresh triggers wired in script.js', () => {
  const content = fs.readFileSync('Finance_Inventory/script.js', 'utf8');
  assert.ok(content.includes('document.querySelectorAll(\'[data-page="usermgmt"]\')'), 'wired to navigation clicks');
  assert.ok(content.includes('new MutationObserver(') && content.includes('active-page'), 'wired to page mutation observer');
  assert.ok(content.includes('window.addEventListener("focus"'), 'wired to window focus');
  assert.ok(content.includes('document.addEventListener("visibilitychange"'), 'wired to tab visibility');
  assert.ok(content.includes('accountRefreshBtn'), 'manual refresh button created');
  assert.ok(content.includes('setInterval(') && content.includes('reloadUserAccounts'), 'periodic auto-polling wired');
});

test('User Management - api-bridge.js exposes reloadUsers helper', () => {
  const content = fs.readFileSync('Finance_Inventory/api-bridge.js', 'utf8');
  assert.ok(content.includes('reloadUsers: () => (typeof window.reloadUserAccounts === "function"'), 'exposed on TripleEBridge');
});

