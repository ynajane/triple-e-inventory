/* security-alerts.test.js — evidence for the detective control (OWASP A09). No database or network needed.   node test/security-alerts.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const createAlerts = require('../security-alerts');

function make(env) {
  let t = 1_000_000; const sent = []; const logs = [];
  const alerts = createAlerts({
    mailer: { sendMail: async (m) => { sent.push(m); return { sent: true }; } },
    now: () => t, log: { warn: (m) => logs.push(m) },
    env: { SECURITY_ALERT_EMAIL: 'owner@example.com', ALERT_FAIL_THRESHOLD: '5', ALERT_WINDOW_MIN: '10', ALERT_COOLDOWN_MIN: '30', ...(env || {}) } });
  return { alerts, sent, logs, advance: (ms) => { t += ms; } };
}

test('below the threshold: no alert', async () => {
  const { alerts, sent } = make();
  for (let i = 0; i < 4; i++) await alerts.failedLogin({ ip: '1.1.1.1', email: null });
  assert.equal(sent.length, 0);
});

test('threshold reached from one IP: alert email sent once, repeats are suppressed during the cooldown', async () => {
  const { alerts, sent, logs } = make();
  for (let i = 0; i < 12; i++) await alerts.failedLogin({ ip: '2.2.2.2', email: null });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /security/i);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.match(logs.join('\n'), /SECURITY ALERT/);
});

test('failures older than the window do not count', async () => {
  const { alerts, sent, advance } = make();
  for (let i = 0; i < 4; i++) await alerts.failedLogin({ ip: '3.3.3.3' });
  advance(11 * 60000);
  for (let i = 0; i < 4; i++) await alerts.failedLogin({ ip: '3.3.3.3' });
  assert.equal(sent.length, 0);
});

test('one account being guessed from many IPs is detected', async () => {
  const { alerts, sent } = make();
  for (let i = 0; i < 5; i++) await alerts.failedLogin({ ip: '9.9.9.' + i, email: 'boss@shop.ph' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /boss@shop\.ph/);
});

test('a locked finance (administrator) account alerts immediately; a customer lock-out does not', async () => {
  const { alerts, sent } = make();
  assert.equal(await alerts.lockout({ email: 'c@x.ph', role: 'customer' }), false);
  assert.equal(await alerts.lockout({ email: 'admin@x.ph', role: 'finance' }), true);
  assert.equal(sent.length, 1);
});

test('the alert comes again after the cooldown ends', async () => {
  const { alerts, sent, advance } = make({ ALERT_WINDOW_MIN: '60' });
  for (let i = 0; i < 5; i++) await alerts.failedLogin({ ip: '4.4.4.4' });
  advance(31 * 60000);
  for (let i = 0; i < 5; i++) await alerts.failedLogin({ ip: '4.4.4.4' });
  assert.equal(sent.length, 2);
});

test('without SECURITY_ALERT_EMAIL the alert is still logged and nothing is emailed; a mail failure never throws', async () => {
  const a = make({ SECURITY_ALERT_EMAIL: '' });
  for (let i = 0; i < 5; i++) await a.alerts.failedLogin({ ip: '5.5.5.5' });
  assert.equal(a.sent.length, 0); assert.match(a.logs.join(), /SECURITY ALERT/);
  const failing = createAlerts({ mailer: { sendMail: async () => { throw new Error('smtp down'); } }, log: { warn() {} },
    env: { SECURITY_ALERT_EMAIL: 'o@x.ph', ALERT_FAIL_THRESHOLD: '2' } });
  await failing.failedLogin({ ip: '6.6.6.6' }); await assert.doesNotReject(failing.failedLogin({ ip: '6.6.6.6' }));
});
