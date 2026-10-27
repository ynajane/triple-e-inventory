/* security-alerts.js — detective control: alerts on attack patterns in sign-in activity (OWASP A09 Logging & Monitoring Failures).

   Raises an alert (console warning + email to SECURITY_ALERT_EMAIL) when
     1. one IP address fails to sign in ALERT_FAIL_THRESHOLD times within ALERT_WINDOW_MIN minutes  (brute force / credential stuffing)
     2. one account is failed ALERT_FAIL_THRESHOLD times within the window (targeted guessing)
     3. a finance (administrator) account is locked out
   The same alert is not repeated for ALERT_COOLDOWN_MIN minutes, so a long attack sends one email, not thousands.

   .env (all optional):  SECURITY_ALERT_EMAIL=owner@example.com   ALERT_FAIL_THRESHOLD=10   ALERT_WINDOW_MIN=10   ALERT_COOLDOWN_MIN=30 */
const num = (v, d, lo, hi) => Math.min(Math.max(Number(v) || d, lo), hi);

module.exports = function createAlerts({ mailer, now = Date.now, log = console, env = process.env } = {}) {
  const THRESHOLD = num(env.ALERT_FAIL_THRESHOLD, 10, 2, 1000);
  const WINDOW_MS = num(env.ALERT_WINDOW_MIN, 10, 1, 1440) * 60000;
  const COOLDOWN_MS = num(env.ALERT_COOLDOWN_MIN, 30, 1, 1440) * 60000;
  const fails = new Map();                               // "ip:1.2.3.4" | "acct:x@y.z" -> [timestamps]
  const lastAlert = new Map();                           // alert key -> timestamp

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');

  async function raise(key, subject, detail) {
    const t = now();
    if (lastAlert.has(key) && t - lastAlert.get(key) < COOLDOWN_MS) return false;
    lastAlert.set(key, t);
    log.warn('[SECURITY ALERT] ' + subject + ' — ' + detail);
    const to = String(env.SECURITY_ALERT_EMAIL || '').trim();
    if (to && mailer && mailer.sendMail) {
      const text = subject + '\n\n' + detail + '\n\nTime: ' + new Date(t).toISOString() + '\nReview the audit log in the Finance app.';
      await Promise.resolve(mailer.sendMail({ to, subject: '[TRIPLE-E security] ' + subject, text,
        html: '<p><b>' + esc(subject) + '</b></p><p>' + esc(detail) + '</p><p>Time: ' + new Date(t).toISOString() + '</p>', tag: 'security-alert' }))
        .catch((e) => log.warn('[SECURITY ALERT] email not sent: ' + (e && e.message)));
    }
    return true;
  }

  function count(key) {
    const t = now();
    const list = (fails.get(key) || []).filter((x) => t - x < WINDOW_MS);
    list.push(t); fails.set(key, list);
    if (fails.size > 10000) for (const [k, v] of fails) if (!v.length || t - v[v.length - 1] >= WINDOW_MS) fails.delete(k);
    return list.length;
  }

  /* every failed sign-in (known or unknown account) */
  async function failedLogin({ ip, email }) {
    const mins = Math.round(WINDOW_MS / 60000);
    let raised = false;
    if (ip && count('ip:' + ip) >= THRESHOLD)
      raised = (await raise('ip:' + ip, 'Repeated failed sign-ins from one address', THRESHOLD + '+ failed sign-ins from IP ' + ip + ' within ' + mins + ' minutes.')) || raised;
    if (email && count('acct:' + email) >= THRESHOLD)
      raised = (await raise('acct:' + email, 'Repeated failed sign-ins on one account', THRESHOLD + '+ failed sign-ins for ' + email + ' within ' + mins + ' minutes.')) || raised;
    return raised;
  }

  /* an account was locked; administrators matter most */
  async function lockout({ email, role }) {
    if (role !== 'finance') return false;
    return raise('lock:' + email, 'Administrator account locked', 'The finance account ' + email + ' was locked after repeated wrong passwords.');
  }

  return { failedLogin, lockout, THRESHOLD, WINDOW_MS };
};
