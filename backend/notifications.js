/* In-app Notification Center.
   One row per recipient. Customers only ever receive rows for their own user_id.
   Low-stock uses a partial unique index on (user_id, dedupe_key) while unresolved so the same
   SKU does not spam; restocking resolves the row and the next drop can alert again. */

const { carrierText, trackingText } = require('./order-delivery');   // who is delivering an order (shown in the "out for delivery" message)

module.exports = function ({ app, pool, auth, wrap, TZ }) {
  let schemaReady = null;

  const ensure = () => schemaReady || (schemaReady = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      notification_id BIGSERIAL PRIMARY KEY,
      user_id         INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      role_key        TEXT NOT NULL,
      category        TEXT NOT NULL,
      title           TEXT NOT NULL,
      body            TEXT NOT NULL,
      link            TEXT,
      entity_type     TEXT,
      entity_id       TEXT,
      dedupe_key      TEXT,
      severity        TEXT NOT NULL DEFAULT 'info',
      is_read         BOOLEAN NOT NULL DEFAULT FALSE,
      read_at         TIMESTAMPTZ,
      is_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at     TIMESTAMPTZ,
      meta            JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_time ON notifications (user_id, created_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications (user_id) WHERE NOT is_read`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_open_dedupe
      ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND NOT is_resolved`);
  })().catch((e) => { schemaReady = null; throw e; }));

  // Only show rows that belong to the role the user has NOW (a user whose role changed must not keep seeing the old role's alerts)
  const roleOnly = (req) => " AND role_key = '" + String(req.user.role || '').replace(/[^a-z_]/gi, '') + "'";

  const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* Live push: every open page keeps one Server-Sent-Events connection (GET /api/notifications/stream).
     When a notification is created or a low-stock alert is resolved we send a tiny "ping" to the affected
     users and their page fetches the news at once. Pages also poll every 10 s as a fallback (several Cloud Run
     instances, a dropped connection, a proxy that buffers). */
  const streams = new Map();                       // user_id -> Set of open responses
  function ping(userIds) {
    for (const uid of new Set((userIds || []).map(Number))) {
      const set = streams.get(uid);
      if (!set) continue;
      for (const res of set) { try { res.write('event: ping\ndata: ' + Date.now() + '\n\n'); } catch (e) { /* closed */ } }
    }
  }

  async function roleUserIds(roleKey) {
    const { rows } = await pool.query(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE r.role_key = $1 AND u.status = 'active'`, [roleKey]);
    return rows.map((r) => r.user_id);
  }

  async function insertFor(userIds, n, roleKey) {
    if (!userIds.length) return 0;
    await ensure();
    const title = String(n.title || '').slice(0, 180);
    const body = String(n.body || '').slice(0, 2000);
    if (!title || !body) return 0;
    const category = String(n.category || 'system').slice(0, 40);
    const link = n.link ? String(n.link).slice(0, 300) : null;
    const entityType = n.entityType ? String(n.entityType).slice(0, 40) : null;
    const entityId = n.entityId != null ? String(n.entityId).slice(0, 80) : null;
    const dedupe = n.dedupeKey ? String(n.dedupeKey).slice(0, 160) : null;
    const severity = ['info', 'warn', 'critical'].includes(n.severity) ? n.severity : 'info';
    const meta = n.meta ? JSON.stringify(n.meta) : null;
    let added = 0;
    const addedTo = [];
    for (const uid of userIds) {
      try {
        const r = await pool.query(
          `INSERT INTO notifications
             (user_id, role_key, category, title, body, link, entity_type, entity_id, dedupe_key, severity, meta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (user_id, dedupe_key) WHERE (dedupe_key IS NOT NULL AND NOT is_resolved) DO NOTHING
           RETURNING notification_id`,
          [uid, roleKey, category, title, body, link, entityType, entityId, dedupe, severity, meta]);
        if (r.rowCount) { added++; addedTo.push(uid); }
      } catch (err) {
        console.warn('[notify] insert failed for user ' + uid + ':', err.message);
      }
    }
    if (addedTo.length) ping(addedTo);
    return added;
  }

  async function notifyRole(roleKey, n) {
    try {
      const ids = await roleUserIds(roleKey);
      return await insertFor(ids, n, roleKey);
    } catch (err) {
      console.warn('[notify] role ' + roleKey + ':', err.message);
      return 0;
    }
  }

  async function notifyUser(userId, n, roleKey) {
    try {
      if (!userId) return 0;
      let role = roleKey;
      if (!role) {
        const { rows } = await pool.query(
          `SELECT r.role_key FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1`, [userId]);
        role = rows[0] && rows[0].role_key;
      }
      if (!role) return 0;
      return await insertFor([userId], n, role);
    } catch (err) {
      console.warn('[notify] user ' + userId + ':', err.message);
      return 0;
    }
  }

  // the wording of one low-stock alert (also used to keep an OPEN alert accurate while the count keeps dropping)
  function lowStockSpec(i) {
    const out = +i.on_hand <= 0;
    return {
      category: 'inventory',
      title: out ? 'Out of stock: ' + i.name : 'Low stock: ' + i.name,
      body: (i.department ? i.department + ' \u00B7 ' : '') + i.sku + ' \u2014 ' +
        (out ? 'OUT OF STOCK' : (Number(i.on_hand) + (i.unit ? ' ' + i.unit : '') + ' on hand')) +
        ', reorder at ' + Number(i.reorder_level) + (i.unit ? ' ' + i.unit : '') +
        '. This alert stays active until new stock is received and the count rises above the reorder level.',
      link: 'Finance_Inventory.html#inventory',
      entityType: 'product',
      entityId: String(i.product_id),
      dedupeKey: 'low_stock:' + i.product_id,
      severity: out ? 'critical' : 'warn',
      meta: { sku: i.sku, department: i.department }
    };
  }

  async function notifyLowStock(items) {
    if (!items || !items.length) return 0;
    let n = 0;
    for (const i of items) n += await notifyRole('finance', lowStockSpec(i));
    return n;
  }

  /* Make sure every product that is low RIGHT NOW has an open alert for each Finance user.
     Covers products that were already low before the Notification Center existed, new Finance
     users, and alerts that were missed. Existing open alerts are never duplicated (unique index). */
  async function syncLowStock() {
    try {
      await ensure();
      // 1) a product that was "low" and is now completely OUT gets a fresh critical alert (so it pops up and sounds again)
      await pool.query(
        `UPDATE notifications n SET is_resolved = TRUE, resolved_at = now()
           FROM products p
          WHERE NOT n.is_resolved AND n.dedupe_key = 'low_stock:' || p.product_id
            AND n.severity <> 'critical' AND p.on_hand <= 0 AND NOT p.is_archived AND p.reorder_level > 0`);
      // 2) alerts that are still open keep showing the CURRENT count (e.g. 4 left -> 3 left)
      const still = await pool.query(
        `SELECT DISTINCT p.product_id, p.sku, p.name, p.unit, p.department, p.on_hand, p.reorder_level
           FROM products p JOIN notifications n ON n.dedupe_key = 'low_stock:' || p.product_id AND NOT n.is_resolved
          WHERE NOT p.is_archived AND p.reorder_level > 0 AND p.on_hand <= p.reorder_level`);
      for (const i of still.rows) {
        const sp = lowStockSpec(i);
        await pool.query(
          `UPDATE notifications SET title = $2, body = $3, severity = $4
            WHERE dedupe_key = $1 AND NOT is_resolved AND (title <> $2 OR body <> $3 OR severity <> $4)`,
          [sp.dedupeKey, sp.title, sp.body, sp.severity]);
      }
      const { rows } = await pool.query(
        `SELECT p.product_id, p.sku, p.name, p.unit, p.department, p.on_hand, p.reorder_level
           FROM products p
          WHERE NOT p.is_archived AND p.reorder_level > 0 AND p.on_hand <= p.reorder_level
            AND (SELECT COUNT(*) FROM users u JOIN roles r ON r.role_id = u.role_id
                  WHERE r.role_key = 'finance' AND u.status = 'active')
              > (SELECT COUNT(*) FROM notifications n
                  WHERE n.dedupe_key = 'low_stock:' || p.product_id AND NOT n.is_resolved)`);
      const n = await notifyLowStock(rows);
      // anything that has recovered since must not stay open
      const done = await pool.query(
        `UPDATE notifications n SET is_resolved = TRUE, resolved_at = now()
           FROM products p
          WHERE NOT n.is_resolved AND n.dedupe_key = 'low_stock:' || p.product_id
            AND (p.on_hand > p.reorder_level OR p.reorder_level <= 0 OR p.is_archived)
          RETURNING n.user_id`);
      if (done.rowCount) ping(done.rows.map((r) => r.user_id));     // pages clear their alarm at once
      return n;
    } catch (err) {
      console.warn('[notify] sync low stock:', err.message);
      return 0;
    }
  }

  async function resolveLowStock(productIds) {
    if (!productIds || !productIds.length) return 0;
    try {
      await ensure();
      const keys = productIds.map((id) => 'low_stock:' + id);
      const r = await pool.query(
        `UPDATE notifications SET is_resolved = TRUE, resolved_at = now()
          WHERE NOT is_resolved AND dedupe_key = ANY($1) RETURNING user_id`, [keys]);
      if (r.rowCount) ping(r.rows.map((x) => x.user_id));
      return r.rowCount;
    } catch (err) {
      console.warn('[notify] resolve low stock:', err.message);
      return 0;
    }
  }

  async function notifyProduction(rec) {
    if (!rec || rec.duplicate) return 0;
    const mats = [].concat(rec.rawMaterials || [], rec.finishingSupplies || [])
      .filter((i) => Number(i.actual) > 0)
      .map((i) => i.name + ' \u2212' + Number(i.actual) + ' ' + i.unit);
    return notifyRole('finance', {
      category: 'production',
      title: 'Production stock-in confirmed',
      body: rec.ref + ': Finished Goods stock-in +' + rec.quantity + ' ' + rec.unit + ' of ' + rec.product +
        (mats.length ? '. Deducted: ' + mats.join(', ') : '.') +
        ' Raw Materials and Finishing Supplies were posted as Stock Out (Used in production).',
      link: 'Finance_Inventory.html#stockflow',
      entityType: 'production',
      entityId: rec.ref,
      dedupeKey: 'production:' + rec.ref,
      severity: 'info'
    });
  }

  const round2c = (n) => Math.round((Number(n) || 0) * 100) / 100;
  function orderSpecs(o, ev, extra) {
    const no = o.order_no;
    const amount = extra && extra.amount != null ? peso(extra.amount) : peso(o.total);
    const reason = extra && extra.reason ? String(extra.reason) : '';
    const note = extra && extra.note ? String(extra.note) : '';
    const shop = 'Shop_Customer.html#orders';
    const sales = 'Finance_Inventory.html#orders';
    const map = {
      placed: {
        customer: { category: 'orders', title: 'Order confirmation',
          body: 'We received order ' + no + ' for ' + peso(o.total) + ' (' + o.fulfillment + ', ' + o.payment_method + ').' +
            (/^Cash on /.test(o.payment_method || '') && +o.advance_amount > 0
              ? ' Pay the ' + peso(o.advance_amount) + ' ' + (o.advance_kind === 'shipping_fee' ? (+o.advance_amount - +o.delivery_fee > 0.004 ? (+o.delivery_fee > 0 ? 'delivery fee and down payment' : 'down payment') : 'delivery fee') : 'down payment') + ' online to confirm it; the rest (' +
                peso(+o.total - +o.advance_amount) + ') is paid in cash ' + (o.fulfillment === 'Delivery' ? 'to the rider.' : 'at our counter.')
              : '') },
        finance: { category: 'orders', title: 'New customer order',
          body: no + ' — ' + (o.full_name || 'Customer') + ' placed a ' + o.fulfillment + ' order for ' + peso(o.total) + ' (' + o.payment_method + ').' }
      },
      Paid: {
        customer: { category: 'payment', title: /^Cash on /.test(o.payment_method || '') ? 'Order confirmed' : 'Payment confirmed',
          body: /^Cash on /.test(o.payment_method || '')
            ? 'Order ' + no + ' is confirmed and your items are reserved.' + (extra && extra.paid > 0 ? ' We received your ' + peso(extra.paid) + ' ' + (o.advance_kind === 'shipping_fee' ? (+o.advance_amount - +o.delivery_fee > 0.004 ? (+o.delivery_fee > 0 ? 'delivery fee and down payment' : 'down payment') : 'delivery fee') : 'down payment') + ' online.' : '') +
              ' Please prepare ' + peso(round2c(+o.total - ((extra && extra.paid) || 0))) + ' in cash for when you ' + (o.fulfillment === 'Delivery' ? 'receive it.' : 'pick it up.')
            : extra && extra.balance > 0.004
            ? 'Order ' + no + ' is confirmed. We received your down payment of ' + peso(extra.paid) + '. Balance: ' + peso(extra.balance) + ' (' + (extra.condition || 'due before release') + ').'
            : 'Order ' + no + ' is confirmed. Payment of ' + peso(o.total) + ' is recorded and we will start packing next.' },
        // Finance is told when a payment arrives by itself (online gateway); not when Finance confirmed the order by hand
        finance: extra && extra.by === 'finance' ? null : { category: 'payment', title: 'Order confirmed automatically',
          body: no + ' was paid online and confirmed by itself (' + (extra && extra.balance > 0.004 ? peso(extra.paid) + ' received, ' + peso(extra.balance) + ' balance' : peso(o.total)) + ', ' + o.payment_method + '). Stock is reserved: it is ready to pack.' }
      },
      'Partially Paid': {
        customer: { category: 'payment', title: 'Payment received',
          body: 'We received ' + amount + ' for order ' + no + '.' + (extra && extra.balance > 0.004 ? ' Balance: ' + peso(extra.balance) + '.' : '') }
      },
      'Fully Paid': {
        customer: { category: 'payment', title: 'Order fully paid',
          body: 'We received ' + amount + ' for order ' + no + '. Nothing more is owed.' },
        finance: { category: 'payment', title: 'Balance paid online', body: no + ' — the remaining ' + amount + ' was paid online. The order is fully paid.' }
      },
      Packed: {
        customer: { category: 'delivery', title: 'Order packed',
          body: 'Order ' + no + ' is packed' + (o.fulfillment === 'Delivery' ? ' and waiting for the delivery run.' : '. We will tell you when it is ready for pickup.') }
      },
      'Out for Delivery': {
        customer: { category: 'delivery', title: 'Out for delivery',
          body: 'Order ' + no + ' is out for delivery' + (carrierText(o.delivery) ? ' with ' + carrierText(o.delivery) : '') + '.'
            + (trackingText(o.delivery) ? ' ' + trackingText(o.delivery) + '.' : '') + ' Please keep your phone nearby.' }
      },
      'Ready for Pickup': {
        customer: { category: 'delivery', title: 'Ready for pickup',
          body: 'Order ' + no + ' is ready for pickup. Please bring your order number and a valid ID.' }
      },
      Delivered: {
        customer: { category: 'delivery', title: 'Order delivered',
          body: 'Order ' + no + ' was delivered' + (o.received_by ? ' (received by ' + o.received_by + ')' : '') + '.' }
      },
      'Picked Up': {
        customer: { category: 'delivery', title: 'Order picked up',
          body: 'Order ' + no + ' was picked up' + (o.received_by ? ' by ' + o.received_by : '') + '.' }
      },
      Cancelled: {
        customer: { category: 'orders', title: 'Order cancelled',
          body: 'Order ' + no + ' was cancelled' + (reason ? ': ' + reason : '.') },
        // Finance is only told when the CUSTOMER cancelled (instant cancel); cancellations Finance approves or does itself need no alert
        finance: extra && extra.by === 'customer' ? { category: 'orders', title: 'Customer cancelled an order',
          body: no + ' was cancelled by the customer' + (reason ? ': ' + reason : '.') } : null
      },
      cancel_declined: {
        customer: { category: 'orders', title: 'Cancellation declined',
          body: 'We could not cancel order ' + no + '. It is still being processed.', severity: 'warn' }
      },
      refund_approved: {
        customer: { category: 'payment', title: 'Refund approved',
          body: 'A refund of ' + amount + ' for order ' + no + ' was approved.' + (note ? ' Note: ' + note : '') }
      },
      refund_declined: {
        customer: { category: 'payment', title: 'Refund declined',
          body: 'The refund request for order ' + no + ' was declined.' + (note ? ' Reason: ' + note : ''), severity: 'warn' }
      }
    };
    const spec = map[ev];
    if (!spec) return null;
    const base = { entityType: 'order', entityId: no, dedupeKey: 'ord:' + ev + ':' + no };
    return {
      customer: spec.customer ? Object.assign({ link: shop, severity: spec.customer.severity || 'info' }, base, spec.customer) : null,
      finance: spec.finance ? Object.assign({ link: sales, severity: spec.finance.severity || 'info' }, base, spec.finance, { dedupeKey: 'ordfin:' + ev + ':' + no }) : null
    };
  }

  async function notifyOrder(o, ev, extra) {
    const spec = orderSpecs(o, ev, extra);
    if (!spec) return 0;
    let n = 0;
    if (spec.customer && o.customer_id) n += await notifyUser(o.customer_id, spec.customer, 'customer');
    if (spec.finance) n += await notifyRole('finance', spec.finance);
    return n;
  }

  function shape(r) {
    return {
      id: Number(r.notification_id),
      category: r.category,
      title: r.title,
      body: r.body,
      link: r.link || '',
      entityType: r.entity_type || undefined,
      entityId: r.entity_id || undefined,
      severity: r.severity,
      isRead: r.is_read,
      isResolved: r.is_resolved,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      when: r.when_label,
      meta: r.meta || undefined
    };
  }

  app.get('/api/notifications', auth(), wrap(async (req, res) => {
    await ensure();
    if (req.user.role === 'finance') await syncLowStock();
    const unread = String(req.query.unread || '') === '1';
    const category = String(req.query.category || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), 5000);
    // list query: $1 = user, $2 = time zone, [$3 = category], then limit / offset
    const args = [req.user.id, TZ];
    let where = 'user_id = $1' + roleOnly(req);
    if (unread) where += ' AND NOT is_read';
    // count query uses its own parameters (an unused parameter makes Postgres reject the query)
    const cArgs = [req.user.id];
    let cWhere = 'user_id = $1' + roleOnly(req);
    if (unread) cWhere += ' AND NOT is_read';
    if (category) {
      args.push(category); where += ' AND category = $' + args.length;
      cArgs.push(category); cWhere += ' AND category = $' + cArgs.length;
    }
    args.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT notification_id, category, title, body, link, entity_type, entity_id, severity,
              is_read, is_resolved, created_at, meta,
              to_char(created_at AT TIME ZONE $2::text, 'Mon DD, YYYY HH12:MI AM') AS when_label
         FROM notifications WHERE ` + where + `
         ORDER BY created_at DESC, notification_id DESC
         LIMIT $` + (args.length - 1) + ` OFFSET $` + args.length,
      args);
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE ` + cWhere, cArgs);
    const unreadQ = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read` + roleOnly(req), [req.user.id]);
    const count = { rows: [{ n: total.rows[0].n, unread: unreadQ.rows[0].n }] };
    res.json({
      items: rows.map(shape),
      total: count.rows[0].n,
      unread: count.rows[0].unread,
      role: req.user.role
    });
  }));

  /* One cheap request the pages make every few seconds (and whenever a live ping arrives):
       unread count, the newest id, UNREAD notifications newer than ?after=<id> (they pop up as toasts),
       and - for Finance - every low-stock alert that is still open (read or not), which keeps the alarm going. */
  app.get('/api/notifications/poll', auth(), wrap(async (req, res) => {
    await ensure();
    const finance = req.user.role === 'finance';
    if (finance) await syncLowStock();
    const role = roleOnly(req);
    const latest = await pool.query(
      `SELECT COALESCE(MAX(notification_id), 0)::bigint AS id FROM notifications WHERE user_id = $1` + role, [req.user.id]);
    const unread = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read` + role, [req.user.id]);
    // newest unread notifications (the page remembers which ones it already showed, so only new ones pop up)
    const recent = await pool.query(
      `SELECT notification_id, category, title, body, link, entity_type, entity_id, severity,
              is_read, is_resolved, created_at, meta,
              to_char(created_at AT TIME ZONE $2::text, 'Mon DD, YYYY HH12:MI AM') AS when_label
         FROM notifications WHERE user_id = $1 AND NOT is_read` + role + `
         ORDER BY created_at DESC, notification_id DESC LIMIT 10`, [req.user.id, TZ]);
    const items = recent.rows.map(shape);
    let activeLowStock = [];
    if (finance) {
      const a = await pool.query(
        `SELECT notification_id, title, body, link, severity, entity_id FROM notifications
          WHERE user_id = $1 AND NOT is_resolved AND category = 'inventory' AND dedupe_key LIKE 'low_stock:%'` + role + `
          ORDER BY (severity = 'critical') DESC, notification_id ASC LIMIT 50`, [req.user.id]);
      activeLowStock = a.rows.map((r) => ({
        id: Number(r.notification_id), title: r.title, body: r.body, link: r.link || '',
        severity: r.severity, productId: r.entity_id }));
    }
    res.set('Cache-Control', 'no-store');
    res.json({ uid: req.user.id, role: req.user.role, unread: unread.rows[0].n,
      latestId: Number(latest.rows[0].id), items, activeLowStock });
  }));

  // live push channel (Server-Sent Events): the server only says "something changed", the page then calls /poll
  app.get('/api/notifications/stream', auth(), (req, res) => {
    // Serverless (Vercel) functions cannot hold a stream open (each one would run until the 300 s timeout and keep
    // its database connections). 204 tells the browser's EventSource to stop; the page's 10 s polling takes over.
    if (process.env.VERCEL) return res.status(204).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 5000\nevent: ready\ndata: 1\n\n');
    const uid = Number(req.user.id);
    if (!streams.has(uid)) streams.set(uid, new Set());
    streams.get(uid).add(res);
    const hb = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch (e) { /* closed */ } }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      const set = streams.get(uid);
      if (set) { set.delete(res); if (!set.size) streams.delete(uid); }
    });
  });

  app.get('/api/notifications/unread-count', auth(), wrap(async (req, res) => {
    await ensure();
    if (req.user.role === 'finance') await syncLowStock();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read` + roleOnly(req), [req.user.id]);
    res.json({ unread: rows[0].n, role: req.user.role });
  }));

  app.post('/api/notifications/:id/read', auth(), wrap(async (req, res) => {
    await ensure();
    if (!/^\d{1,18}$/.test(req.params.id)) return res.status(400).json({ error: 'Not found' });
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, now())
        WHERE notification_id = $1 AND user_id = $2 RETURNING notification_id`,
      [req.params.id, req.user.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  }));

  app.post('/api/notifications/read-all', auth(), wrap(async (req, res) => {
    await ensure();
    const r = await pool.query(
      `UPDATE notifications SET is_read = TRUE, read_at = COALESCE(read_at, now())
        WHERE user_id = $1 AND NOT is_read` + roleOnly(req), [req.user.id]);
    res.json({ ok: true, updated: r.rowCount });
  }));

  return { notifyRole, notifyUser, notifyLowStock, resolveLowStock, syncLowStock, notifyProduction, notifyOrder, peso, ensure };
};