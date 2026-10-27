'use strict';
// Same optional simulated browser used by quote-fields-ui.test.js.
// JSDOM_DIR=/path/to/test-tools node --test test/inline-validation.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch { ({ JSDOM } = require(path.join(process.env.JSDOM_DIR || '/home/claude/jsd', 'node_modules/jsdom'))); }
const source = fs.readFileSync(path.join(__dirname, '../../Finance_Inventory/form-assist.js'), 'utf8');
function fixture(t) {
  const dom = new JSDOM('<form><input id="value" aria-describedby="hint"><p id="hint">Existing hint</p><p id="serverError"></p></form>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.eval(source);
  const input = dom.window.document.getElementById('value');
  // jsdom does not lay out elements; explicitly model visibility for this unit test.
  input.getClientRects = () => input.hidden ? [] : [{}];
  const fire = (type) => input.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  return { window: dom.window, input, fire, validation: dom.window.FormAssist.validation };
}
test('field feedback appears on edits, retains hints, and clears only after correction', (t) => {
  const { window, input, fire, validation } = fixture(t);
  const check = validation.bind(input, value => value.trim().length < 3 ? 'Use at least 3 characters.' : '');
  assert.equal(check(false), '');
  assert.equal(window.document.querySelector('.fa-error'), null);
  input.value = 'ab'; fire('input');
  const message = window.document.querySelector('.fa-error');
  assert.equal(message.textContent, 'Use at least 3 characters.');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'hint ' + message.id);
  input.value = 'a'; fire('blur');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(window.document.querySelectorAll('.fa-error').length, 1);
  input.value = 'abc'; fire('change');
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.equal(message.textContent, '');
});
test('reset and inactive fields clear feedback; rebinding updates the rule without duplicate listeners', (t) => {
  const { window, input, fire, validation } = fixture(t);
  let calls = 0;
  const check = validation.bind(input, () => 'Required.');
  fire('input');
  input.disabled = true; assert.equal(check(true), '');
  input.disabled = false; input.readOnly = true; assert.equal(check(true), '');
  input.readOnly = false; input.hidden = true; assert.equal(check(true), '');
  input.hidden = false;
  validation.bind(input, () => { calls++; return 'New rule.'; });
  fire('input'); assert.equal(calls, 1);
  assert.equal(window.document.querySelector('.fa-error').textContent, 'New rule.');
  input.form.reset();
  assert.equal(input.getAttribute('aria-invalid'), 'false');
  assert.equal(check(false), '');
});
test('server error slots are reused and direct feedback does not accumulate messages', (t) => {
  const { window, input, fire, validation } = fixture(t);
  const box = window.document.getElementById('serverError');
  validation.bind(input, value => value ? '' : 'Required.', box);
  fire('input');
  assert.equal(box.textContent, 'Required.');
  assert.equal(box.getAttribute('aria-live'), 'polite');
  assert.equal(window.document.querySelector('.fa-error'), null);
  validation.show(input, 'Server refused this value.');
  assert.equal(box.textContent, 'Server refused this value.');
  input.value = 'corrected'; fire('input'); assert.equal(box.textContent, '');
  const other = window.document.createElement('input'); input.after(other);
  validation.show(other, 'First error.'); validation.show(other, 'Second error.');
  assert.equal(window.document.querySelectorAll('.fa-error').length, 1);
  assert.equal(other.nextElementSibling.textContent, 'Second error.');
});
