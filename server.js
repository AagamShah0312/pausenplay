'use strict';

process.loadEnvFile();

/**
 * PausenPlay — booking server
 *
 *   node server.js        →  http://localhost:3000
 *   PORT=8080 node server.js
 *
 * Routes
 *   /                     customer site (with the seat booking form)
 *   /admin                admin dashboard (login: Admin / Admin123)
 *   /api/state            live seat map (public)
 *   /api/book             create a booking (public)
 *   /api/admin/login      start an admin session
 *   /api/admin/*          everything else (session required)
 *   /api/export.xlsx      Excel export (admin)
 *   /api/events           Server-Sent Events stream of live changes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { ASSETS_DIR } = require('./lib/paths');
const store = require('./lib/store');
const auth = require('./lib/auth');
const { getLayoutStorage } = require('./lib/layout-storage');
const xlsx = require('./lib/xlsx');
const razorpay = require('./lib/razorpay');
const { getBookingPrice } = require('./lib/pricing');
const { verifyRazorpaySignature, verifyRazorpayWebhookSignature, reconcileCapturedPayment } = require('./lib/payment');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const layoutStorage = getLayoutStorage();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/* ---------------------------- utilities ---------------------------- */
function sendJSON(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', ch => {
      size += ch.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(ch);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach(part => {
    const [k, ...v] = part.split('=');
    if (!k) return;
    out[k.trim()] = decodeURIComponent(v.join('=').trim());
  });
  return out;
}

const ADMIN_COOKIE = 'pp_admin';
function adminFrom(req, res) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (auth.isValid(token)) return token;
  if (token) {
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
  return null;
}

const fmtDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: true
});
const fmtFileStamp = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function fmt(ms) {
  if (!ms) return '';
  return fmtDate.format(new Date(ms)).replace(',', '');
}

/* ------------------------------- SSE ------------------------------- */
const clients = new Set();
function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  clients.forEach(res => {
    try {
      res.write(data);
    } catch (err) {
      clients.delete(res);
    }
  });
}

async function handleEvents(req, res) {
  const publicState = await store.getPublicState();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(publicState)}\n\n`);
  clients.add(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(keepAlive);
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

/* ------------------------- admin export rows ----------------------- */
const STATUS_LABEL = {
  active: 'Running',
  expired: 'Completed',
  ended: 'Ended by admin',
  scheduled: 'Scheduled',
  cancelled: 'Cancelled'
};
function statusLabel(status) {
  return STATUS_LABEL[status] || status;
}

async function exportRows() {
  const rows = [[
    'Booking ID', 'Station', 'Zone', 'Customer Name', 'Phone',
    'Start', 'End', 'Minutes', 'Status', 'Booked By', 'Time Adjustments', 'Booked At'
  ]];
  (await store.listBookings()).forEach(b => {
    const seat = store.seatById(b.seatId);
    const edits = (b.adjustments || []).filter(a => typeof a.delta === 'number');
    rows.push([
      b.id,
      seat ? seat.label : b.seatId,
      seat ? seat.zone : '',
      b.name,
      b.phone,
      fmt(b.startAt),
      b.endAt ? fmt(b.endAt) : '',
      b.durationMin,
      statusLabel(b.status),
      b.createdBy === 'admin' ? 'Admin (walk-in)' : 'Customer',
      edits.length,
      fmt(b.createdAt)
    ]);
  });
  return rows;
}

async function exportSummaryRows() {
  const all = (await store.listBookings()).filter(b => b.status !== 'cancelled');
  const bySeat = new Map();
  all.forEach(b => {
    const key = b.seatId;
    if (!bySeat.has(key)) bySeat.set(key, { seat: (store.seatById(b.seatId) || {}).label || b.seatId, sessions: 0, minutes: 0 });
    const rec = bySeat.get(key);
    rec.sessions += 1;
    rec.minutes += b.durationMin || 0;
  });
  const rows = [['Station', 'Total Sessions', 'Total Minutes', 'Total Hours']];
  [...bySeat.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([, v]) => rows.push([v.seat, v.sessions, v.minutes, Math.round((v.minutes / 60) * 10) / 10]));
  rows.push([]);
  rows.push(['TOTAL', all.length, all.reduce((s, b) => s + (b.durationMin || 0), 0), Math.round((all.reduce((s, b) => s + (b.durationMin || 0), 0) / 60) * 10) / 10]);
  rows.push(['of which still to come (scheduled)', all.filter(b => b.status === 'scheduled').length, '', '']);
  return rows;
}

/* ------------------------------ routing ---------------------------- */
const routes = {
  /* ---------------- public ---------------- */
  'POST /api/payment/webhook': async (req, res) => {
    if (!razorpay.webhookSecret) return sendJSON(res, 503, { error: 'Webhook processing is not configured.' });
    let rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (err) {
      return sendJSON(res, err.message === 'Payload too large' ? 413 : 400, { error: 'Invalid webhook request.' });
    }
    if (!verifyRazorpayWebhookSignature({
      rawBody,
      signature: req.headers['x-razorpay-signature'],
      webhookSecret: razorpay.webhookSecret
    })) {
      console.warn('Rejected Razorpay webhook with invalid signature.');
      return sendJSON(res, 400, { error: 'Invalid webhook signature.' });
    }
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      return sendJSON(res, 400, { error: 'Invalid webhook payload.' });
    }
    try {
      // payment.captured is authoritative: order.paid can be delivered before
      // or after it, so acknowledging it avoids a second booking trigger.
      if (event.event === 'payment.captured') {
        const result = await reconcileCapturedPayment({ store, payment: event.payload && event.payload.payment && event.payload.payment.entity });
        if (result.error) {
          console.warn('Could not reconcile captured Razorpay payment:', result.error);
          return sendJSON(res, 409, { error: 'Payment could not be reconciled.' });
        }
        if (!result.duplicate) broadcast('state', await store.getPublicState());
      } else if (event.event === 'payment.failed') {
        const payment = event.payload && event.payload.payment && event.payload.payment.entity;
        if (payment && typeof payment.order_id === 'string') await store.markPaymentFailed({ razorpayOrderId: payment.order_id, razorpayPaymentId: payment.id });
      }
      // order.paid and unknown events are intentionally acknowledged. Only a
      // captured payment is allowed to create a booking.
      return sendJSON(res, 200, { ok: true });
    } catch (err) {
      console.error('Razorpay webhook processing failed:', err.message);
      return sendJSON(res, 500, { error: 'Webhook processing failed.' });
    }
  },

  'POST /api/payment/create-order': async (req, res) => {
    if (!razorpay.isConfigured) return sendJSON(res, 503, { error: 'Online payments are not configured yet.' });
    try {
      const body = await readBody(req);
      // Validation and conflict detection happen before a Razorpay order exists.
      const stationIds = Array.isArray(body.stationIds) ? body.stationIds : [body.seatId];
      if (!stationIds.length || stationIds.some(id => typeof id !== 'string') || new Set(stationIds).size !== stationIds.length) {
        return sendJSON(res, 400, { error: 'Please choose one or more unique stations.' });
      }
      const check = store.validateBookingInput({ ...body, seatId: stationIds[0] });
      if (check.error) return sendJSON(res, 400, { error: check.error });
      const stationChecks = stationIds.map(seatId => store.validateBookingInput({ ...body, seatId }));
      const unavailable = stationChecks.find(item => item.error);
      if (unavailable) return sendJSON(res, 400, { error: unavailable.error });
      if (!store.state.durations.includes(check.minutes)) {
        return sendJSON(res, 400, { error: 'That duration is not available.' });
      }
      const prices = stationIds.map(seatId => {
        const seat = store.seatById(seatId);
        return seat && getBookingPrice({ seatId, minutes: check.minutes, hourlyRate: seat.hourlyRate });
      });
      if (prices.some(price => !price || price.error || !Number.isSafeInteger(price.amountPaise))) {
        return sendJSON(res, 400, { error: 'Unable to price one or more selected stations.' });
      }
      const amountPaise = prices.reduce((sum, price) => sum + price.amountPaise, 0);
      const order = await razorpay.client.orders.create({
        amount: amountPaise,
        currency: prices[0].currency,
        receipt: `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      });
      if (!order || !order.id || order.amount !== amountPaise || order.currency !== prices[0].currency) {
        console.error('Razorpay returned an unexpected order for the requested price.');
        return sendJSON(res, 502, { error: 'Unable to create payment order. Please try again.' });
      }
      const pending = await store.createPendingPayment({
        razorpayOrderId: order.id,
        amountPaise, currency: prices[0].currency, hourlyRate: prices[0].hourlyRate,
        booking: { ...body, seatId: stationIds[0], stationIds }
      });
      if (pending.error) {
        console.error('Could not persist Razorpay order:', pending.error);
        return sendJSON(res, 500, { error: 'Unable to prepare payment. Please try again.' });
      }
      sendJSON(res, 200, { ok: true, keyId: razorpay.keyId, order: { id: order.id, amount: amountPaise, currency: prices[0].currency }, prices });
    } catch (err) {
      console.error('Razorpay order creation failed:', err.message);
      sendJSON(res, 502, { error: 'Unable to create payment order. Please try again.' });
    }
  },

  'POST /api/payment/verify': async (req, res) => {
    if (!razorpay.isConfigured) return sendJSON(res, 503, { error: 'Online payments are not configured yet.' });
    try {
      const body = await readBody(req);
      const orderId = String(body.razorpay_order_id || '');
      const paymentId = String(body.razorpay_payment_id || '');
      const signature = String(body.razorpay_signature || '');
      const pending = store.paymentForOrder(orderId);
      if (!pending) return sendJSON(res, 400, { error: 'Payment order was not found.' });
      if (!verifyRazorpaySignature({ orderId, paymentId, signature, keySecret: razorpay.keySecret })) {
        console.warn('Rejected Razorpay signature for order', orderId);
        return sendJSON(res, 400, { error: 'Payment verification failed.' });
      }
      // Fetching Razorpay's records prevents a valid signature for one payment
      // from being used with a different order, currency or amount.
      const [order, payment] = await Promise.all([
        razorpay.client.orders.fetch(orderId),
        razorpay.client.payments.fetch(paymentId)
      ]);
      if (!order || !payment || order.id !== orderId || payment.order_id !== orderId ||
          payment.amount !== pending.amountPaise || order.amount !== pending.amountPaise ||
          payment.currency !== pending.currency || order.currency !== pending.currency ||
          !['authorized', 'captured'].includes(payment.status)) {
        console.warn('Rejected mismatched Razorpay payment for order', orderId);
        return sendJSON(res, 400, { error: 'Payment does not match this booking.' });
      }
      const result = await reconcileCapturedPayment({ store, payment });
      if (result.error) return sendJSON(res, 409, { error: result.error });
      broadcast('state', await store.getPublicState());
      sendJSON(res, 200, { ok: true, booking: result.booking, duplicate: Boolean(result.duplicate) });
    } catch (err) {
      console.error('Razorpay payment verification failed:', err.message);
      sendJSON(res, 502, { error: 'Unable to verify payment. Please contact the lounge if you were charged.' });
    }
  },

  'POST /api/payment/test-pending': async (req, res) => {
    if (process.env.NODE_ENV !== 'test') return sendJSON(res, 404, { error: 'Unknown endpoint' });
    const body = await readBody(req);
    const result = await store.createPendingPayment({
      razorpayOrderId: body.razorpayOrderId,
      amountPaise: body.amountPaise,
      currency: body.currency || 'INR',
      booking: body.booking
    });
    if (result.error) return sendJSON(res, 400, { error: result.error });
    sendJSON(res, 200, { ok: true });
  },
  'GET /api/state': async (req, res) => sendJSON(res, 200, await store.getPublicState()),

  'POST /api/book': async (req, res) => {
    // The legacy endpoint is retained only for the isolated test suite. It is
    // not reachable in normal deployments, so customer bookings require a
    // verified Razorpay payment.
    if (process.env.NODE_ENV === 'test' && process.env.PAUSENPLAY_TEST_ALLOW_UNPAID_BOOKINGS === '1') {
      const body = await readBody(req);
      const result = Array.isArray(body.stationIds)
        ? await store.createBookings({ ...body, createdBy: 'customer' })
        : await store.createBooking({ ...body, createdBy: 'customer' });
      if (result.error) return sendJSON(res, 400, { error: result.error });
      broadcast('state', await store.getPublicState());
      return sendJSON(res, 200, { ok: true, booking: result.booking || result.bookings[0], bookings: result.bookings });
    }
    sendJSON(res, 410, { error: 'Complete payment before creating a customer booking.' });
  },

  /* ---------------- admin auth ---------------- */
  'POST /api/admin/login': async (req, res) => {
    const body = await readBody(req);
    const token = auth.login(body.username, body.password);
    if (!token) return sendJSON(res, 401, { error: 'Wrong username or password.' });
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${token}; Path=/; Max-Age=${auth.SESSION_HOURS * 3600}; HttpOnly; SameSite=Lax`);
    sendJSON(res, 200, { ok: true, username: auth.info().username, usingDefault: auth.info().usingDefault });
  },

  'POST /api/admin/logout': async (req, res) => {
    const token = parseCookies(req)[ADMIN_COOKIE];
    auth.logout(token);
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    sendJSON(res, 200, { ok: true });
  },

  'GET /api/admin/me': async (req, res) => {
    const token = adminFrom(req, res);
    if (!token) return sendJSON(res, 401, { error: 'Not signed in.' });
    sendJSON(res, 200, { ok: true, ...auth.info() });
  },

  'POST /api/admin/credentials': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await auth.changeCredentials(body);
    if (result.error) return sendJSON(res, 400, { error: result.error });
    res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    sendJSON(res, 200, { ok: true, ...result, message: 'Saved. Please sign in again with your new credentials.' });
  },

  /* ---------------- admin data ---------------- */
  'GET /api/admin/state': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const pub = await store.getPublicState();
    sendJSON(res, 200, {
      ...pub,
      bookings: await store.listBookings({ limit: 500 }),
      upcomingBookings: await store.listUpcoming(),
      stats: await buildStats()
    });
  },

  'POST /api/admin/layout': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.updateLayout({ seats: body.seats, layout: body.layout });
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, seats: result.seats, layout: result.layout });
  },

  'POST /api/admin/pricing': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.updateStationPricing({ seatId: body.seatId, hourlyRate: body.hourlyRate });
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, station: result.seat });
  },

  'POST /api/admin/layout-image': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req, 16 * 1024 * 1024);
    const dataUrl = String(body.data || '');
    const match = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return sendJSON(res, 400, { error: 'That file is not a supported image (PNG, JPG, WEBP or SVG).' });

    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) return sendJSON(res, 400, { error: 'Image is larger than 8 MB.' });
    if (buf.length < 32) return sendJSON(res, 400, { error: 'That image looks empty.' });

    const contentType = match[1] === 'jpg' || match[1] === 'jpeg' ? 'image/jpeg' : `image/${match[1]}`;
    let uploaded;
    try {
      uploaded = await layoutStorage.upload({ body: buf, contentType });
    } catch (err) {
      console.error('Layout image upload failed:', err.message);
      return sendJSON(res, 502, { error: 'Unable to store the layout image. Please try again.' });
    }

    const width = Number(body.width) || store.state.layout.width;
    const height = Number(body.height) || store.state.layout.height;
    const result = await store.updateLayout({
      seats: store.state.seats,
      layout: { image: 'api/layout-image', imageFileId: uploaded.fileId, imageContentType: uploaded.contentType, width, height }
    });
    if (result.error) {
      await layoutStorage.remove(uploaded.fileId).catch(() => {});
      return sendJSON(res, 400, { error: result.error });
    }
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, image: result.layout.image, layout: result.layout });
  },

  'GET /api/layout-image': async (req, res) => {
    const layout = store.state.layout || {};
    if (!layout.imageFileId) return sendJSON(res, 404, { error: 'No uploaded layout image is available.' });
    try {
      const image = await layoutStorage.get(layout.imageFileId);
      res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.length, 'Cache-Control': 'no-store' });
      if (image.stream) image.stream.pipe(res); else res.end(image.body);
    } catch (err) {
      console.error('Layout image retrieval failed:', err.message);
      sendJSON(res, 404, { error: 'Layout image is unavailable.' });
    }
  },

  'GET /api/admin/history': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    sendJSON(res, 200, { bookings: await store.listBookings(), stats: await buildStats() });
  },

  'POST /api/admin/book': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.createBooking({
      seatId: body.seatId,
      name: body.name,
      phone: body.phone,
      minutes: body.minutes,
      startAt: body.startAt,
      date: body.date,
      time: body.time,
      createdBy: 'admin'
    });
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, booking: result.booking });
  },

  /** pull a reservation forward — the player is already at the counter */
  'POST /api/admin/start': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.startBooking(body.bookingId, 'admin');
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, booking: result.booking });
  },

  'POST /api/admin/adjust': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.adjustBooking(body.bookingId, body.deltaMinutes, 'admin');
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, booking: result.booking });
  },

  'POST /api/admin/end': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const body = await readBody(req);
    const result = await store.endBooking(body.bookingId, 'admin');
    if (result.error) return sendJSON(res, 400, { error: result.error });
    broadcast('state', await store.getPublicState());
    sendJSON(res, 200, { ok: true, booking: result.booking });
  },

  'GET /api/export.xlsx': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const buf = xlsx.build([
      { name: 'Bookings', rows: await exportRows(), cols: [16, 12, 22, 22, 14, 20, 20, 10, 16, 16, 16, 20], autoFilter: true },
      { name: 'Station summary', rows: await exportSummaryRows(), cols: [34, 16, 16, 14] }
    ]);
    const name = `pausenplay-bookings-${fmtFileStamp.format(new Date()).replace(/[^\d]/g, '').slice(0, 12)}.xlsx`;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  },

  'GET /api/export.csv': async (req, res) => {
    if (!adminFrom(req, res)) return sendJSON(res, 401, { error: 'Not signed in.' });
    const buf = Buffer.from(xlsx.buildCsv(await exportRows()), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': 'attachment; filename="pausenplay-bookings.csv"',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  }
};

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

async function buildStats() {
  const all = await store.listBookings();
  const t = Date.now();
  const today = dayKey.format(new Date());
  const todays = all.filter(b => dayKey.format(new Date(b.startAt)) === today);
  const todayCount = todays.length;
  const minutesToday = todays.reduce((s, b) => s + (b.durationMin || 0), 0);
  return {
    active: all.filter(b => b.status === 'active' && b.endAt > t).length,
    upcoming: all.filter(b => b.status === 'scheduled' && b.endAt > t).length,
    today: todayCount,
    minutesToday,
    total: all.length,
    customers: new Set(all.map(b => b.phone || b.name.toLowerCase())).size
  };
}

/* --------------------------- static files -------------------------- */
function serveFile(res, filePath, { cache = true } = {}) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send404(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': cache ? 'public, max-age=300' : 'no-store'
    });
    res.end(data);
  });
}

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1 style="font-family:sans-serif">404 — not found</h1><p style="font-family:sans-serif"><a href="/">Back to PausenPlay</a></p>');
}

function safeJoin(dir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(dir, clean));
  if (!target.startsWith(dir)) return null;
  return target;
}

/* ------------------------------ server ----------------------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

    /* --- health check --- */
  if (pathname === '/health') {
    return sendJSON(res, 200, {
      status: 'ok',
      service: 'PausenPlay',
      timestamp: new Date().toISOString()
    });
  }

  /* --- SSE --- */
  if (pathname === '/api/events') return await handleEvents(req, res);

  /* --- API --- */
  if (pathname.startsWith('/api/')) {
    const key = `${req.method} ${pathname}`;
    const handler = routes[key];
    if (!handler) return sendJSON(res, 404, { error: 'Unknown endpoint' });
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[api]', key, err.message);
      if (!res.headersSent) sendJSON(res, 500, { error: 'Server error.' });
    }
    return;
  }

  /* --- pages --- */
  if (pathname === '/admin' || pathname === '/admin/') {
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), { cache: false });
  }

  /* --- static: public first, then assets --- */
  let filePath = safeJoin(PUBLIC_DIR, pathname);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return serveFile(res, filePath, { cache: false });
  }
  const assetPath = safeJoin(ASSETS_DIR, pathname.startsWith('/assets/') ? pathname.slice('/assets'.length) : pathname);
  if (assetPath && fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) {
    return serveFile(res, assetPath);
  }
  if (pathname === '' || pathname === '/') {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), { cache: false });
  }
  return send404(res);
});

/* expire finished sessions + push updates to everyone watching */
function startExpirySweep() {
  setInterval(async () => {
    try {
      if (await store.sweepExpired()) broadcast('state', await store.getPublicState());
    } catch (err) {
      console.error('Booking expiry sweep failed:', err.message);
    }
  }, 1000);
}

function imageContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }[ext] || null;
}

/** Migrate a legacy local layout into GridFS once. */
async function ensureGridFsLayout() {
  if (process.env.LAYOUT_STORAGE_TYPE === 'memory' || store.state.layout.imageFileId) return;
  const imagePath = safeJoin(ROOT, store.state.layout.image || '');
  const contentType = imagePath && imageContentType(imagePath);
  if (!imagePath || !contentType || !fs.existsSync(imagePath)) {
    throw new Error('The current layout image cannot be migrated to GridFS.');
  }
  const uploaded = await layoutStorage.upload({ body: fs.readFileSync(imagePath), contentType });
  const result = await store.updateLayout({
    seats: store.state.seats,
    layout: {
      image: 'api/layout-image', imageFileId: uploaded.fileId, imageContentType: uploaded.contentType,
      width: store.state.layout.width, height: store.state.layout.height
    }
  });
  if (result.error) throw new Error(result.error);
}

async function start() {
  try {
    await store.initialize();
    await auth.initialize();
    await ensureGridFsLayout();
  } catch (err) {
    console.error('Store initialization failed:', err.message);
    process.exitCode = 1;
    return;
  }

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  PAUSENPLAY booking server');
    console.log(`  Customer site : http://localhost:${PORT}/`);
    console.log(`  Admin panel   : http://localhost:${PORT}/admin   (Admin / Admin123)`);
    console.log('');
  });
  startExpirySweep();
}

start();
