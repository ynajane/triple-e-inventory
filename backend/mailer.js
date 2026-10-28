/* Email sending + email templates.  Two ways to send (the first one that is set up in backend/.env is used):

   1) Gmail   GMAIL_USER and GMAIL_APP_PASSWORD   (no domain needed; good for getting started)
   2) Mailgun MAILGUN_API_KEY and MAILGUN_DOMAIN   (use this once you have your own domain)
   With neither, nothing is sent: the email is printed in the server console instead.

   Gmail needs:
     GMAIL_USER          your Gmail address, e.g. triplee.metal@gmail.com
     GMAIL_APP_PASSWORD  a 16-character Google "app password" (not your normal Gmail password)
     MAIL_FROM           optional, e.g. Triple E Metal Products <triplee.metal@gmail.com>  (Gmail shows your own address anyway)

   Mailgun needs these in backend/.env (see .env.example):
     MAILGUN_API_KEY   your Mailgun private API key
     MAILGUN_DOMAIN    the sending domain you verified in Mailgun, e.g. mg.triplee-metal.com
     MAILGUN_REGION    us (default) or eu
     MAIL_FROM         e.g. Triple E Metal Products <no-reply@mg.triplee-metal.com>
     APP_BASE_URL      the public address of the website, e.g. https://inventory.triplee-metal.com

   Without MAILGUN_API_KEY / MAILGUN_DOMAIN nothing is sent: the email is printed in the server console instead,
   so the sign-up link can still be tested on a developer computer. */
const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'emails');
const escapeHtml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// {{name}} is HTML-escaped. Same placeholder style as Mailgun templates, so a file can be pasted into Mailgun's editor too.
function renderTemplate(file, vars, { html = true } = {}) {
  const src = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
  return src.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    if (!(key in vars)) return '';
    return html ? escapeHtml(vars[key]) : String(vars[key]);
  });
}

const gmailConfigured = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const mailgunConfigured = () => !!(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN);
const brevoConfigured = () => !!process.env.BREVO_API_KEY;
const isConfigured = () => brevoConfigured() || gmailConfigured() || mailgunConfigured();

/* Brevo over HTTPS (port 443). Use this on a host that blocks outgoing SMTP (Render's free plan does), where the SMTP route
   times out. BREVO_API_KEY = an API key (not the SMTP key) that is allowed to send transactional email.
   MAIL_FROM must be a sender verified in Brevo, e.g. Triple E Metal Products <you@gmail.com>. */
async function sendViaBrevo({ to, subject, html, text }) {
  const raw = String(process.env.MAIL_FROM || '').trim();
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  const sender = m ? { name: m[1].trim() || 'Triple E Metal Products', email: m[2].trim() } : { name: 'Triple E Metal Products', email: raw };
  if (!/^[^@\s]+@[^@\s]+$/.test(sender.email)) return { sent: false, reason: 'MAIL_FROM must be a sender address verified in Brevo' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': String(process.env.BREVO_API_KEY).trim(), 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [].concat(to).map((email) => ({ email: String(email).trim() })), subject, htmlContent: html || undefined, textContent: text || undefined }),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error('[mail] Brevo refused the message (' + res.status + '): ' + detail);
      return { sent: false, reason: res.status === 401 ? 'Brevo API key was rejected' : 'Brevo could not send the email (' + res.status + ')' };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mail] could not reach Brevo:', err.message);
    return { sent: false, reason: 'Could not reach Brevo' };
  } finally { clearTimeout(timer); }
}

let gmailTransport = null;
async function sendViaGmail({ to, subject, html, text }) {
  const user = String(process.env.GMAIL_USER).trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');   // Google shows the app password in groups of 4; spaces are ignored
  const from = process.env.MAIL_FROM || ('Triple E Metal Products <' + user + '>');
  try {
    if (!gmailTransport) {
      const nodemailer = require('nodemailer');
      gmailTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 465,
        secure: (Number(process.env.SMTP_PORT) || 465) === 465,
        auth: { user, pass },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
      });
    }
    await gmailTransport.sendMail({ from, to, subject, html, text });
    return { sent: true };
  } catch (err) {
    console.error('[mail] Gmail could not send the message:', err.code || '', err.message);
    gmailTransport = null;
    if (err.code === 'EAUTH' || /535|Invalid login|Username and Password/i.test(err.message))
      return { sent: false, reason: 'Gmail refused the login. Use a Google app password, not your normal password' };
    if (err.code === 'MODULE_NOT_FOUND') return { sent: false, reason: 'Run "npm install" in the backend folder' };
    return { sent: false, reason: 'Gmail could not send the email' };
  }
}

async function sendMail({ to, subject, html, text, tag }) {
  if (brevoConfigured()) return sendViaBrevo({ to, subject, html, text });
  if (gmailConfigured()) return sendViaGmail({ to, subject, html, text });
  const from = process.env.MAIL_FROM || ('Triple E Metal Products <no-reply@' + (process.env.MAILGUN_DOMAIN || 'localhost') + '>');
  if (!mailgunConfigured()) {
    console.warn('[mail] No email service is set up (GMAIL_USER / GMAIL_APP_PASSWORD or MAILGUN_API_KEY / MAILGUN_DOMAIN missing). Email NOT sent.');
    console.warn('[mail] To: ' + to + '\n[mail] Subject: ' + subject + '\n' + text);
    return { sent: false, reason: 'Email is not set up on the server yet' };
  }
  const base = String(process.env.MAILGUN_REGION || 'us').toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  const body = new URLSearchParams({ from, to, subject, html, text });
  if (tag) body.append('o:tag', tag);
  body.append('o:tracking-clicks', 'no');      // keep the sign-up link exactly as written (Mailgun would otherwise rewrite it)
  body.append('o:tracking-opens', 'no');
  try {
    const res = await fetch(`${base}/v3/${encodeURIComponent(process.env.MAILGUN_DOMAIN)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from('api:' + process.env.MAILGUN_API_KEY).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      console.error('[mail] Mailgun refused the message (' + res.status + '): ' + detail);
      return { sent: false, reason: res.status === 401 ? 'Mailgun API key was rejected' : 'Mailgun could not send the email (' + res.status + ')' };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mail] could not reach Mailgun:', err.message);
    return { sent: false, reason: 'Could not reach Mailgun' };
  }
}

function sendCashierInvite({ to, recipientName, roleLabel, inviterName, signupUrl, expiresHours }) {
  const hours = Number(expiresHours) || 72;
  const expiresIn = hours % 24 === 0 ? (hours / 24) + (hours === 24 ? ' day' : ' days') : hours + ' hours';
  const vars = {
    recipientName: recipientName || 'there', roleLabel, inviterName: inviterName || 'An administrator',
    signupUrl, expiresIn, toEmail: to, year: new Date().getFullYear()
  };
  return sendMail({
    to,
    subject: 'You\'re invited to Triple E Metal Products — set up your ' + roleLabel + ' account',
    html: renderTemplate('cashier-invite.html', vars),
    text: renderTemplate('cashier-invite.txt', vars, { html: false }),
    tag: 'staff-invite'
  });
}

// Customer email verification. `change` = a signed-in customer is moving to a new address (the old one stays active until this link is used).
function sendVerificationEmail({ to, recipientName, verifyUrl, expiresHours, change }) {
  const hours = Number(expiresHours) || 24;
  const expiresIn = hours % 24 === 0 ? (hours / 24) + (hours === 24 ? ' day' : ' days') : hours + ' hours';
  const vars = {
    recipientName: recipientName || 'there', verifyUrl, expiresIn, toEmail: to,
    intro: change ? 'Please confirm this new email address for your Triple E Metal Products account. Your current email keeps working until you do.'
                  : 'Thanks for creating a Triple E Metal Products account. Please confirm your email address to activate it.',
    year: new Date().getFullYear()
  };
  return sendMail({
    to,
    subject: change ? 'Confirm your new email — Triple E Metal Products' : 'Verify your email — Triple E Metal Products',
    html: renderTemplate('verify-email.html', vars),
    text: renderTemplate('verify-email.txt', vars, { html: false }),
    tag: 'email-verification'
  });
}

// Sign-in lockout: the link that unlocks the account. The cooldown starts only when the link is opened (see login-lockout.js).
function sendUnlockEmail({ to, recipientName, unlockUrl, expiresMinutes, cooldownSeconds, attempts }) {
  const mins = Number(expiresMinutes) || 60;
  const expiresIn = mins % 60 === 0 ? (mins / 60) + (mins === 60 ? ' hour' : ' hours') : mins + ' minutes';
  const cs = Number(cooldownSeconds) || 120;
  const cooldown = cs % 60 === 0 ? (cs / 60) + '-minute' : cs + '-second';
  const vars = { recipientName: recipientName || 'there', unlockUrl, expiresIn, cooldown,
    attempts: attempts || 3, toEmail: to, year: new Date().getFullYear() };
  return sendMail({
    to,
    subject: 'Unlock your account \u2014 Triple E Metal Products',
    html: renderTemplate('unlock-account.html', vars),
    text: renderTemplate('unlock-account.txt', vars, { html: false }),
    tag: 'account-unlock'
  });
}

module.exports = { sendMail, sendCashierInvite, sendVerificationEmail, sendUnlockEmail, renderTemplate, isConfigured, escapeHtml };
