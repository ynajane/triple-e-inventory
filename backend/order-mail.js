/* Shop contact / delivery details + the emails sent to online-shop customers about their order.

   Business details are NOT hard-coded: set them in backend/.env (see .env.example) and they appear on the
   shop pages, the Help page and in every email. Anything left empty is simply not shown.

   Emails are sent through mailer.js (Gmail or Mailgun). If no email service is set up, nothing is sent and the
   message is printed in the server console instead. Sending never blocks or breaks an order: a failed email is logged only. */
const mailer = require('./mailer');
const sms = require('./sms');
const { escapeHtml: esc } = mailer;
const { carrierText, trackingText } = require('./order-delivery');   // who is delivering (from the delivery details Finance saved)

const env = (k) => String(process.env[k] || '').trim();
const peso = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function shopInfo() {
  return {
    phone: env('SHOP_PHONE'), email: env('SHOP_EMAIL'), viber: env('SHOP_VIBER'), messenger: env('SHOP_MESSENGER'),
    address: env('SHOP_ADDRESS'), hours: env('SHOP_HOURS'),
    deliveryAreas: env('DELIVERY_AREAS'),
    deliveryLeadTime: env('DELIVERY_LEAD_TIME') || 'We confirm the delivery schedule with you once your payment is confirmed.',
    pickupNote: env('PICKUP_NOTE')
  };
}

// event -> what the customer is told
const EVENTS = {
  placed:           { subject: (o) => `We received your order ${o.order_no}`, head: 'Thank you for your order!',
    msg: (o) => /^Cash/.test(o.payment_method) && +o.advance_amount > 0
      ? `We have your order. To confirm it, pay the ${peso(o.advance_amount)} ${(o.advance_kind === 'shipping_fee' ? (+o.advance_amount - +o.delivery_fee > 0.004 ? (+o.delivery_fee > 0 ? 'delivery fee and down payment' : 'down payment') : 'delivery fee') : 'down payment')} online (My Orders, “Continue Online Payment”). ` +
        `The remaining ${peso(+o.total - +o.advance_amount)} is paid in cash ${o.fulfillment === 'Delivery' ? 'to the rider when it arrives' : 'at our counter when you pick it up'}.` +
        (o.advance_kind === 'deposit' ? ' If the order is not picked up in time, it is cancelled and the down payment is not refunded.' : '')
      : /^Cash/.test(o.payment_method)
      ? `We have your order. Our team will confirm it shortly. You pay in cash when you ${o.fulfillment === 'Delivery' ? 'receive' : 'collect'} it.`
      : 'We have your order. If you have not paid yet, open My Orders and choose “Continue Online Payment”. We start preparing your order once payment is confirmed.' },
  Paid:             { subject: (o) => `Order ${o.order_no} confirmed`, head: 'Your order is confirmed',
    msg: (o, d) => 'Your order is confirmed and your items are reserved. We will start packing it next.'
      + (d && d.balance > 0.004 ? ` We received ${peso(d.paid)}. Balance: ${peso(d.balance)} (${d.condition || 'due before the goods are released'}).` : '') },
  'Fully Paid':     { subject: (o) => `Order ${o.order_no} is fully paid`, head: 'Thank you, your order is fully paid',
    msg: (o, d) => `We received ${peso(d.amount)} for order ${o.order_no}. Nothing more is owed on this order.` },
  'Partially Paid': { subject: (o) => `We received your payment for order ${o.order_no}`, head: 'Your payment was received',
    msg: (o, d) => `Thank you — we recorded ${peso(d.paid)} on order ${o.order_no}. ${peso(d.balance)} is still outstanding: ${d.condition || 'the balance is due before the goods are released'}.` },
  Packed:           { subject: (o) => `Order ${o.order_no} is packed`, head: 'Your order is packed',
    msg: (o) => o.fulfillment === 'Delivery' ? 'Your items are packed and waiting for the delivery run.' : 'Your items are packed. We will let you know as soon as they are ready for pickup.' },
  'Out for Delivery': { subject: (o) => `Order ${o.order_no} is out for delivery`, head: 'Your order is on its way',
    msg: (o) => 'Your order is out for delivery' + (carrierText(o.delivery) ? ' with ' + carrierText(o.delivery) : '') + '.' + (trackingText(o.delivery) ? ' ' + trackingText(o.delivery) + '.' : '')
      + ' Please keep your phone nearby and have someone ready to receive it.' },
  'Ready for Pickup': { subject: (o) => `Order ${o.order_no} is ready for pickup`, head: 'Your order is ready for pickup',
    msg: () => 'Your order is ready. Please bring your order number and a valid ID when you collect it.' },
  Delivered:        { subject: (o) => `Order ${o.order_no} was delivered`, head: 'Your order was delivered',
    msg: (o, d) => `Your order was delivered${o.received_by ? ' (received by ' + o.received_by + ')' : ''}. If something is wrong, you can request a refund from My Orders within ${d.refundDays} days.` },
  'Picked Up':      { subject: (o) => `Order ${o.order_no} was picked up`, head: 'Thank you for picking up your order',
    msg: (o, d) => `Your order was picked up${o.received_by ? ' by ' + o.received_by : ''}. If something is wrong, you can request a refund from My Orders within ${d.refundDays} days.` },
  Cancelled:        { subject: (o) => `Order ${o.order_no} was cancelled`, head: 'Your order was cancelled',
    msg: (o, d) => 'Your order was cancelled' + (d.reason ? ': ' + d.reason : '.') + (+o.forfeited_amount > 0 ? ` Finance retained ${peso(o.forfeited_amount)} of your down payment. Any remaining refundable payment is handled through Finance.` : ' If you already paid online, the refund goes back to your original payment method; our team will contact you about the timing.') },
  cancel_declined:  { subject: (o) => `About your cancellation request for ${o.order_no}`, head: 'Cancellation request declined',
    msg: () => 'We could not cancel this order, so it is still being processed. Please contact us if you have questions.' },
  refund_approved:  { subject: (o) => `Refund approved for order ${o.order_no}`, head: 'Your refund was approved',
    msg: (o, d) => `We approved your refund of ${peso(d.amount)}. ` + (/^Cash/.test(o.payment_method) ? 'Our team will contact you to hand back this amount.' : 'It goes back to your original payment method (' + o.payment_method + ').') + (d.note ? ' Note from our team: ' + d.note : '') },
  refund_declined:  { subject: (o) => `About your refund request for ${o.order_no}`, head: 'Refund request declined',
    msg: (o, d) => 'We could not approve your refund request.' + (d.note ? ' Reason: ' + d.note : '') + ' Please contact us if you would like to discuss it.' }
};

// event -> the short text message (kept plain: no peso sign or curly quotes, so it fits in as few SMS parts as possible)
const SMS_TEXT = {
  placed:           (o) => `Triple E Metal: We received your order ${o.order_no}. We will confirm it shortly.`,
  Paid:             (o, d) => `Triple E Metal: Order ${o.order_no} is confirmed. We will start packing it next.`
    + (d && d.balance > 0.004 ? ` Balance due: PHP ${Number(d.balance).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.` : ''),
  Packed:           (o) => o.fulfillment === 'Delivery'
    ? `Triple E Metal: Order ${o.order_no} is packed and waiting for the delivery run.`
    : `Triple E Metal: Order ${o.order_no} is packed. We will text you when it is ready for pickup.`,
  'Out for Delivery': (o) => `Triple E Metal: Order ${o.order_no} is out for delivery` + (carrierText(o.delivery) ? ' with ' + carrierText(o.delivery) : '') + '.'
    + (trackingText(o.delivery) ? ' ' + trackingText(o.delivery) + '.' : '') + ' Please keep your phone nearby.',
  'Ready for Pickup': (o, d, info) => `Triple E Metal: Order ${o.order_no} is READY FOR PICKUP. Bring your order number and a valid ID.`
    + (info.address ? ` ${info.address}.` : '') + (info.hours ? ` Hours: ${info.hours}.` : ''),
  Delivered:        (o) => `Triple E Metal: Order ${o.order_no} was delivered. Thank you! Questions? Check My Orders.`,
  'Picked Up':      (o) => `Triple E Metal: Order ${o.order_no} was picked up. Thank you!`,
  Cancelled:        (o, d) => `Triple E Metal: Order ${o.order_no} was cancelled${d.reason ? ' (' + d.reason + ')' : ''}. See your email or My Orders for details.`,
  cancel_declined:  (o) => `Triple E Metal: We could not cancel order ${o.order_no}; it is still being processed.`,
  refund_approved:  (o, d) => `Triple E Metal: Your refund of PHP ${Number(d.amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} for order ${o.order_no} was approved.`,
  refund_declined:  (o) => `Triple E Metal: We could not approve the refund for order ${o.order_no}. Please check your email.`
};

// the one text a delivery recipient (someone other than the account owner) receives
const RECIPIENT_SMS = {
  'Out for Delivery': (o) => `Triple E Metal: A delivery for ${o.recipient_name || 'you'} (order ${o.order_no}) is out for delivery` + (carrierText(o.delivery) ? ' with ' + carrierText(o.delivery) : '') + '. Please keep your phone nearby.'
};

// Who gets the text: the ACCOUNT OWNER (their current number from the account, so a changed number works right away;
// the number saved on the order is only a fallback) gets every update. The delivery RECIPIENT, when it is a different
// number, gets only the events listed in RECIPIENT_SMS.
function smsTargets(o, ev) {
  const owner = sms.toE164(o.account_phone) ? o.account_phone : o.phone;
  const list = [];
  if (SMS_TEXT[ev]) list.push({ to: owner, kind: 'owner' });
  if (o.fulfillment === 'Delivery' && RECIPIENT_SMS[ev] && o.phone) {
    const r = sms.toE164(o.phone), w = sms.toE164(owner);
    if (r && r !== w) list.push({ to: o.phone, kind: 'recipient' });
  }
  return list;
}

function build(o, items, ev, extra, info) {
  const base = env('APP_BASE_URL').replace(/\/$/, '');
  const link = base ? base + '/Shop_Customer.html' : '';
  const refundDays = Number(process.env.REFUND_WINDOW_DAYS) || 7;
  const d = Object.assign({ refundDays }, extra || {});
  const def = EVENTS[ev];
  const name = (o.full_name || 'there').split(' ')[0];
  const message = def.msg(o, d);
  const rows = items.map(i => `<tr><td style="padding:6px 0">${esc(+i.qty + ' × ' + i.name)}</td><td style="padding:6px 0;text-align:right">${esc(peso(i.qty * i.price))}</td></tr>`).join('');
  const where = o.fulfillment === 'Delivery' ? (o.address ? 'Deliver to: ' + o.address : '') : ('Pickup' + (info.address ? ' at: ' + info.address : '') + (info.hours ? ' (' + info.hours + ')' : ''));
  const contact = [info.phone && 'Phone: ' + info.phone, info.email && 'Email: ' + info.email, info.viber && 'Viber: ' + info.viber, info.messenger && 'Messenger: ' + info.messenger].filter(Boolean);

  const html = `<!doctype html><html><body style="margin:0;background:#f3f5f8;font-family:Arial,Helvetica,sans-serif;color:#1c2430">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#fff;border-radius:10px;padding:28px;border:1px solid #e1e6ee">
<div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f6fb8;font-weight:bold">Triple E Metal Products</div>
<h1 style="font-size:22px;margin:10px 0 6px">${esc(def.head)}</h1>
<p style="margin:0 0 14px;line-height:1.5">Hi ${esc(name)},<br>${esc(message)}</p>
<div style="background:#f3f5f8;border-radius:8px;padding:12px 14px;margin-bottom:14px"><b>Order ${esc(o.order_no)}</b><br><span style="color:#5a6677;font-size:13px">${esc(o.fulfillment)} · ${esc(o.payment_method)}</span></div>
<table style="width:100%;border-collapse:collapse;font-size:14px;border-bottom:1px solid #e1e6ee">${rows}</table>
<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:8px">
${+o.delivery_fee ? `<tr><td style="padding:3px 0;color:#5a6677">Delivery</td><td style="text-align:right">${esc(peso(o.delivery_fee))}</td></tr>` : ''}
<tr><td style="padding:3px 0"><b>Total</b></td><td style="text-align:right"><b>${esc(peso(o.total))}</b></td></tr></table>
${where ? `<p style="font-size:13px;color:#5a6677;margin:14px 0 0">${esc(where)}</p>` : ''}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:#1f6fb8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-size:14px">View my orders</a></p>` : ''}
</div>
${contact.length ? `<p style="font-size:12.5px;color:#5a6677;line-height:1.6;margin:14px 4px 0"><b>Questions?</b><br>${contact.map(esc).join('<br>')}</p>` : ''}
<p style="font-size:11.5px;color:#8b95a5;margin:14px 4px">You are receiving this because you placed an order at the Triple E Metal Products online shop.</p>
</div></body></html>`;

  const text = [`Hi ${name},`, '', message, '', `Order ${o.order_no} (${o.fulfillment}, ${o.payment_method})`,
    ...items.map(i => `  ${+i.qty} x ${i.name}  ${peso(i.qty * i.price)}`),
    +o.delivery_fee ? `  Delivery  ${peso(o.delivery_fee)}` : '', `  Total  ${peso(o.total)}`, '', where, link && ('View my orders: ' + link),
    contact.length ? '\nQuestions?\n' + contact.join('\n') : '', '\nTriple E Metal Products'].filter(x => x !== '').join('\n');
  return { subject: def.subject(o, d), html, text };
}

module.exports = function makeOrderMail(pool, getNc) {
  // Fire-and-forget: call as  notify(orderNo, 'Packed')  AFTER the database change is committed. Never throws.
  async function notify(orderNo, ev, extra) {
    try {
      if (!EVENTS[ev]) return;
      const { rows } = await pool.query(
        `SELECT o.*, u.email, u.full_name, u.phone AS account_phone FROM orders o JOIN users u ON u.user_id = o.customer_id WHERE o.order_no = $1`, [orderNo]);
      const o = rows[0];
      if (!o) return;
      // delivery details (rider, courier, tracking) are added to the order so the email, text and in-app message can mention them
      if (o.fulfillment === 'Delivery') {
        const dl = await pool.query('SELECT * FROM order_deliveries WHERE order_id = $1', [o.order_id]).catch(() => ({ rows: [] }));
        o.delivery = dl.rows[0] || null;
      }
      const info = shopInfo();
      const d = Object.assign({ refundDays: Number(process.env.REFUND_WINDOW_DAYS) || 7 }, extra || {});
      // email, text and in-app are separate: one failing never stops the others
      await Promise.all([
        (async () => {
          const nc = typeof getNc === 'function' ? getNc() : null;
          if (!nc || !nc.notifyOrder) return;
          try { await nc.notifyOrder(o, ev, extra); }
          catch (err) { console.warn(`[notify] in-app order "${ev}" for ${orderNo}:`, err.message); }
        })(),
        (async () => {
          if (!o.email) return;
          try {
            const { rows: items } = await pool.query('SELECT name, qty, price FROM order_items WHERE order_id = $1 ORDER BY item_id', [o.order_id]);
            const m = build(o, items, ev, extra, info);
            const r = await mailer.sendMail({ to: o.email, subject: m.subject, html: m.html, text: m.text, tag: 'order-' + ev.toLowerCase().replace(/\s+/g, '-') });
            if (!r.sent) console.warn(`[mail] order email "${ev}" for ${orderNo} not sent: ${r.reason}`);
          } catch (err) { console.error(`[mail] order email "${ev}" for ${orderNo} failed:`, err.message); }
        })(),
        (async () => {
          if (!sms.eventEnabled(ev)) return;
          for (const t of smsTargets(o, ev)) {
            try {
              const message = t.kind === 'owner' ? SMS_TEXT[ev](o, d, info) : RECIPIENT_SMS[ev](o, d, info);
              const r = await sms.sendSms({ to: t.to, message });
              if (!r.sent) console.warn(`[sms] order text "${ev}" (${t.kind}) for ${orderNo} not sent: ${r.reason}`);
            } catch (err) { console.error(`[sms] order text "${ev}" (${t.kind}) for ${orderNo} failed:`, err.message); }
          }
        })()
      ]);
    } catch (err) { console.error(`[notify] order notification "${ev}" for ${orderNo} failed:`, err.message); }
  }
  return { notify, shopInfo };
};
module.exports.shopInfo = shopInfo;
