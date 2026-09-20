'use strict';
/**
 * PausenPlay — booking store
 * Zero dependency. Persists to data/*.json so the server can be restarted
 * without losing bookings.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ensureDataDir } = require('./paths');
const { DEFAULT_HOURLY_RATE_RUPEES, validateHourlyRate } = require('./pricing');

ensureDataDir();
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

/* ------------------------------------------------------------------ *
 * Default floor plan — 12 gaming stations across 4 zones.
 * Coordinates are percentages of the layout image, so the same numbers
 * work if you swap assets/store-layout.svg for a photo of the store.
 * ------------------------------------------------------------------ */
function defaultSeats() {
  const seats = [];
  const zones = [
    { key: 'PS5', zone: 'PlayStation 5 Zone', type: 'ps5', xs: [7, 27], ys: [17, 33], w: 17, h: 15 },
    { key: 'PC', zone: 'PC Battlestation', type: 'pc', xs: [57, 77], ys: [17, 33], w: 17, h: 15 },
    { key: 'RACE', zone: 'Racing Arena', type: 'racing', xs: [7, 27], ys: [58], w: 18, h: 26 },
    { key: 'RETRO', zone: "90's Nostalgia Zone", type: 'retro', xs: [58, 77], ys: [58], w: 18, h: 26 }
  ];
  zones.forEach(z => {
    let n = 1;
    z.ys.forEach(y => {
      z.xs.forEach(x => {
        seats.push({
          id: `${z.key}-${String(n).padStart(2, '0')}`,
          label: `${z.key}-${String(n).padStart(2, '0')}`,
          zone: z.zone,
          type: z.type,
          hourlyRate: DEFAULT_HOURLY_RATE_RUPEES,
          x, y, w: z.w, h: z.h
        });
        n++;
      });
    });
  });
  return seats;
}

function defaultState() {
  return {
    storeName: 'PausenPlay',
    layout: {
      image: 'assets/store-layout.svg',
      width: 1000,
      height: 620
    },
    durations: [30, 60, 90, 120, 180],
    defaultDuration: 60,
    /* how far ahead players may reserve a station */
    booking: {
      advanceDays: 30,      // 0 disables advance booking
      minAdvanceMinutes: 0, // optional lead time before a slot starts
      slotStepMinutes: 15   // step used by the time picker
    },
    seats: defaultSeats()
  };
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[store] could not read ${file}: ${err.message}`);
    return fallback;
  }
}

let state = Object.assign(defaultState(), readJSON(STATE_FILE, {}));
// Always keep durations/seats sane
if (!Array.isArray(state.seats) || !state.seats.length) state.seats = defaultSeats();
state.seats.forEach(seat => {
  if (!validateHourlyRate(seat.hourlyRate).hourlyRate) seat.hourlyRate = DEFAULT_HOURLY_RATE_RUPEES;
});
if (!Array.isArray(state.durations) || !state.durations.length) state.durations = [30, 60, 90, 120, 180];
// booking window: fill in anything an older state.json does not have yet
state.booking = Object.assign(defaultState().booking, state.booking || {});

let bookings = readJSON(BOOKINGS_FILE, []);
if (!Array.isArray(bookings)) bookings = [];
let payments = readJSON(PAYMENTS_FILE, []);
if (!Array.isArray(payments)) payments = [];

/* ----------------------- date / time helpers ----------------------- */
const TZ = process.env.TZ_NAME || 'Asia/Kolkata';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** How far the given instant sits from UTC when read in `timeZone`. */
function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms));
  const get = type => Number((parts.find(p => p.type === type) || { value: 0 }).value);
  const hour = get('hour') % 24; // some ICU builds report midnight as "24"
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - ms;
}

/**
 * Wall-clock "2026-08-30" + "18:30" in the store timezone → absolute ms.
 * Returns null when either half is missing or impossible.
 */
function zonedTimeToMs(dateStr, timeStr, timeZone = TZ) {
  const d = DATE_RE.exec(String(dateStr === null || dateStr === undefined ? '' : dateStr).trim());
  const t = TIME_RE.exec(String(timeStr === null || timeStr === undefined ? '' : timeStr).trim());
  if (!d || !t) return null;
  const [, yearStr, monthStr, dayStr] = d;
  const month = Number(monthStr), day = Number(dayStr);
  const hour = Number(t[1]), minute = Number(t[2]), second = t[3] ? Number(t[3]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // treat the wall clock as UTC first, then shift by the real zone offset
  const asUTC = Date.UTC(Number(yearStr), month - 1, day, hour, minute, second);
  const guess = asUTC - zoneOffsetMs(asUTC, timeZone);
  return asUTC - zoneOffsetMs(guess, timeZone); // second pass keeps DST honest
}

/* --------------------------- persistence --------------------------- */
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
      fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
    } catch (err) {
      console.error('[store] write failed:', err.message);
    }
  }, 150);
}

/* ----------------------------- helpers ----------------------------- */
const now = () => Date.now();
const uid = () => crypto.randomBytes(6).toString('hex');

function seatById(id) {
  return state.seats.find(s => s.id === id) || null;
}

function activeBookingFor(seatId) {
  const t = now();
  return bookings.find(b => b.seatId === seatId && b.status === 'active' && b.endAt > t) || null;
}

/**
 * Any live or reserved booking on `seatId` that overlaps [startAt, endAt).
 * Finished / cancelled bookings never block a new one.
 */
function overlappingFor(seatId, startAt, endAt, ignoreId) {
  return bookings.find(b =>
    b.id !== ignoreId &&
    b.seatId === seatId &&
    (b.status === 'active' || b.status === 'scheduled') &&
    b.startAt < endAt &&
    b.endAt > startAt) || null;
}

function publicBooking(b) {
  return {
    id: b.id,
    seatId: b.seatId,
    name: b.name,
    phone: b.phone || '',
    startAt: b.startAt,
    endAt: b.endAt,
    durationMin: b.durationMin,
    status: b.status,
    startedAt: b.startedAt || null,
    endedAt: b.endedAt || null,
    createdAt: b.createdAt,
    createdBy: b.createdBy || 'customer',
    adjustments: b.adjustments || [],
    payment: b.payment ? {
      status: b.payment.status,
      razorpayOrderId: b.payment.razorpayOrderId,
      razorpayPaymentId: b.payment.razorpayPaymentId,
      amountPaise: b.payment.amountPaise,
      currency: b.payment.currency,
      hourlyRate: b.payment.hourlyRate,
      amount: b.payment.amount
    } : null
  };
}

/**
 * Move bookings through their lifecycle so seats flip back to green on their
 * own: reserved slots start when their time comes, running sessions expire.
 */
function sweepExpired() {
  const t = now();
  let changed = false;
  for (const b of bookings) {
    if (b.status === 'scheduled') {
      if (b.endAt <= t) {
        // the whole slot passed while the server was away — mark it missed
        b.status = 'expired';
        b.endedAt = b.endAt;
        changed = true;
      } else if (b.startAt <= t) {
        b.status = 'active';
        b.startedAt = t;
        changed = true;
      }
    } else if (b.status === 'active' && b.endAt <= t) {
      b.status = 'expired';
      b.endedAt = b.endAt;
      changed = true;
    }
  }
  if (changed) {
    save();
    return true;
  }
  return false;
}

/* ------------------------------- API ------------------------------- */

/** Everything the public booking page needs. */
function getPublicState() {
  sweepExpired();
  const t = now();
  const active = bookings.filter(b => b.status === 'active' && b.endAt > t);
  const upcoming = bookings
    .filter(b => b.status === 'scheduled' && b.endAt > t)
    .sort((a, b) => a.startAt - b.startAt);
  const seats = state.seats.map(s => {
    const b = active.find(x => x.seatId === s.id) || null;
    const next = upcoming.find(x => x.seatId === s.id) || null;
    const reserved = upcoming.filter(x => x.seatId === s.id).length;
    return {
      id: s.id,
      label: s.label,
      zone: s.zone,
      type: s.type,
      hourlyRate: Number.isSafeInteger(s.hourlyRate) ? s.hourlyRate : DEFAULT_HOURLY_RATE_RUPEES,
      x: s.x, y: s.y, w: s.w, h: s.h,
      status: b ? 'busy' : 'free',
      booking: b ? {
        id: b.id,
        name: b.name,
        endAt: b.endAt,
        startAt: b.startAt,
        remainingMs: Math.max(0, b.endAt - t)
      } : null,
      /* next reservation on this station (no name — the map stays private) */
      next: next ? { id: next.id, startAt: next.startAt, endAt: next.endAt, durationMin: next.durationMin } : null,
      reservedCount: reserved
    };
  });
  return {
    serverTime: t,
    storeName: state.storeName,
    layout: state.layout,
    durations: state.durations,
    defaultDuration: state.defaultDuration,
    booking: Object.assign({ timezone: TZ }, state.booking),
    seats,
    activeCount: active.length,
    upcomingCount: upcoming.length,
    totalSeats: state.seats.length,
    /* reservations only — enough for the customer page to check a slot */
    upcoming: upcoming.map(b => ({
      id: b.id,
      seatId: b.seatId,
      startAt: b.startAt,
      endAt: b.endAt,
      durationMin: b.durationMin,
      createdBy: b.createdBy || 'customer'
    }))
  };
}

/* a request for "the next couple of minutes" is simply a walk-in */
const IMMEDIATE_WINDOW_MS = 2 * 60000;

/**
 * Validate a booking request and work out when it starts.
 * Returns { error } or { start, scheduled }.
 */
function validateBookingInput({ seatId, name, phone, minutes, startAt, date, time }) {
  const seat = seatById(seatId);
  if (!seat) return { error: 'Please pick a valid station.' };
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) return { error: 'Please enter the player name (at least 2 characters).' };
  if (cleanName.length > 40) return { error: 'Name is too long (40 characters max).' };
  const cleanPhone = String(phone || '').replace(/[^\d]/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 13) return { error: 'Please enter a valid 10 digit phone number.' };
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) return { error: 'Please choose how long you want to play.' };
  if (state.durations.length && !state.durations.includes(mins) && mins > 600) return { error: 'That duration is not allowed.' };

  const t = now();
  let start = t;
  const hasClock = (startAt !== undefined && startAt !== null && startAt !== '') || date || time;
  if (hasClock) {
    if (startAt !== undefined && startAt !== null && startAt !== '') {
      const parsed = Number(startAt);
      if (!Number.isFinite(parsed)) return { error: 'That start time is not valid.' };
      start = parsed;
    } else {
      const parsed = zonedTimeToMs(date, time);
      if (!parsed) return { error: 'Please pick both a date and a start time.' };
      start = parsed;
    }
    if (start - t < -60000) return { error: 'That time has already passed — please pick a slot in the future.' };
  }

  const scheduled = start - t > IMMEDIATE_WINDOW_MS;
  if (!scheduled) start = t;

  if (scheduled) {
    const maxDays = Number(state.booking.advanceDays);
    if (Number.isFinite(maxDays) && maxDays > 0 && start - t > maxDays * 86400000) {
      return { error: `You can book up to ${maxDays} days ahead — please pick a closer slot.` };
    }
    const lead = Number(state.booking.minAdvanceMinutes);
    if (Number.isFinite(lead) && lead > 0 && start - t < lead * 60000) {
      return { error: `Please book at least ${lead} minutes ahead, or choose "Start now".` };
    }
  }

  const clash = overlappingFor(seatId, start, start + mins * 60000);
  if (clash) {
    return {
      error: scheduled
        ? `Station ${seat.label} is already booked at that time. Try another slot or station.`
        : `Station ${seat.label} was just booked by someone else. Pick another one.`
    };
  }
  return { error: null, start, scheduled, seat, cleanName, cleanPhone, minutes: mins };
}

function createBooking({ seatId, name, phone, minutes, startAt, date, time, createdBy = 'customer' }) {
  sweepExpired(); // a session that just ran out must not block the station
  const check = validateBookingInput({ seatId, name, phone, minutes, startAt, date, time });
  if (check.error) return { error: check.error };
  const seat = seatById(seatId);
  const t = now();
  const mins = Number(minutes);
  const booking = {
    id: uid(),
    seatId: seat.id,
    seatLabel: seat.label,
    zone: seat.zone,
    name: check.cleanName,
    phone: check.cleanPhone,
    startAt: check.start,
    endAt: check.start + mins * 60000,
    durationMin: mins,
    status: check.scheduled ? 'scheduled' : 'active',
    startedAt: check.scheduled ? null : t,
    endedAt: null,
    createdAt: t,
    createdBy,
    adjustments: []
  };
  bookings.push(booking);
  save();
  return { booking: publicBooking(booking) };
}

/** Store server-validated booking details until the Razorpay callback arrives. */
function createPendingPayment({ razorpayOrderId, amountPaise, currency = 'INR', hourlyRate, booking }) {
  if (!razorpayOrderId || !Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    return { error: 'Invalid payment order.' };
  }
  if (payments.some(p => p.razorpayOrderId === razorpayOrderId)) return { error: 'Payment order already exists.' };
  const check = validateBookingInput(booking || {});
  if (check.error) return { error: check.error };
  if (!state.durations.includes(check.minutes)) return { error: 'That duration is not available.' };
  const rate = validateHourlyRate(hourlyRate === undefined ? check.seat.hourlyRate : hourlyRate);
  if (rate.error) return rate;
  const record = {
    id: uid(), razorpayOrderId, amountPaise, currency,
    booking: {
      seatId: check.seat.id, name: check.cleanName, phone: check.cleanPhone,
      minutes: check.minutes, startAt: check.start,
      hourlyRate: rate.hourlyRate
    },
    status: 'created', createdAt: now(), bookingId: null, razorpayPaymentId: null
  };
  payments.push(record);
  save();
  return { payment: record };
}

function paymentForOrder(razorpayOrderId) {
  return payments.find(p => p.razorpayOrderId === razorpayOrderId) || null;
}

function markPaymentFailed({ razorpayOrderId, razorpayPaymentId }) {
  const payment = paymentForOrder(razorpayOrderId);
  if (!payment) return { ignored: true };
  if (payment.status === 'completed') return { ignored: true };
  // A Razorpay order can have a failed attempt followed by a successful
  // retry, so this is audit information rather than a terminal order state.
  payment.failedAttempts = payment.failedAttempts || [];
  if (razorpayPaymentId && !payment.failedAttempts.some(x => x.razorpayPaymentId === razorpayPaymentId)) {
    payment.failedAttempts.push({ razorpayPaymentId, at: now() });
  }
  save();
  return { payment };
}

/**
 * Re-check availability and create the booking exactly once after a verified
 * payment. The browser never supplies the booking terms at this stage.
 */
function finalizePaidBooking({ razorpayOrderId, razorpayPaymentId, amountPaise, currency = 'INR' }) {
  const payment = paymentForOrder(razorpayOrderId);
  if (!payment) return { error: 'Payment order was not found.' };
  if (payment.bookingId) {
    if (payment.razorpayPaymentId === razorpayPaymentId) {
      const booking = bookings.find(b => b.id === payment.bookingId);
      return booking ? { booking: publicBooking(booking), duplicate: true } : { error: 'Payment record is incomplete.' };
    }
    return { error: 'This payment order has already been completed.' };
  }
  if (payment.status === 'conflict') return { error: 'This paid order could not be booked because the station is no longer available.' };
  if (payments.some(p => p.razorpayPaymentId === razorpayPaymentId && p.razorpayOrderId !== razorpayOrderId)) {
    return { error: 'This payment has already been used.' };
  }
  if (payment.amountPaise !== amountPaise || payment.currency !== currency) return { error: 'Payment amount does not match this booking.' };

  const result = createBooking({ ...payment.booking, createdBy: 'customer' });
  if (result.error) {
    payment.status = 'conflict';
    payment.razorpayPaymentId = razorpayPaymentId;
    save();
    return { error: result.error };
  }
  const rawBooking = bookings.find(b => b.id === result.booking.id);
  rawBooking.payment = {
    status: 'paid', razorpayOrderId, razorpayPaymentId, amountPaise, currency,
    hourlyRate: payment.booking.hourlyRate,
    amount: amountPaise / 100,
    paidAt: now()
  };
  payment.status = 'completed';
  payment.bookingId = rawBooking.id;
  payment.razorpayPaymentId = razorpayPaymentId;
  save();
  return { booking: publicBooking(rawBooking) };
}

/** Add or remove minutes from a live or reserved session (admin). */
function adjustBooking(id, deltaMinutes, adminLabel = 'admin') {
  const b = bookings.find(x => x.id === id);
  if (!b) return { error: 'Booking not found.' };
  if (b.status !== 'active' && b.status !== 'scheduled') return { error: 'That session is already finished.' };
  const delta = Number(deltaMinutes);
  if (!Number.isFinite(delta) || delta === 0) return { error: 'Invalid time change.' };

  if (b.status === 'scheduled') {
    const nextEnd = b.endAt + delta * 60000;
    if (nextEnd - b.startAt < 5 * 60000) return { error: 'That would make the booking shorter than 5 minutes.' };
    const clash = overlappingFor(b.seatId, b.startAt, nextEnd, b.id);
    if (clash) return { error: 'Another booking on that station overlaps the new end time.' };
    b.endAt = nextEnd;
    b.durationMin = Math.round((b.endAt - b.startAt) / 60000);
    b.adjustments = b.adjustments || [];
    b.adjustments.push({ at: Date.now(), delta, by: adminLabel });
    save();
    return { booking: publicBooking(b) };
  }


  b.endAt = b.endAt + delta * 60000;
  b.adjustments = b.adjustments || [];
  b.adjustments.push({ at: Date.now(), delta, by: adminLabel });

  if (b.endAt <= Date.now()) {
    b.endAt = Date.now();
    b.status = 'ended';
    b.endedAt = Date.now();
    b.durationMin = Math.max(0, Math.round((b.endAt - b.startAt) / 60000));
  } else {
    b.durationMin = Math.round((b.endAt - b.startAt) / 60000);
  }
  save();
  return { booking: publicBooking(b) };
}

/** Stop a running session, or cancel a reservation that has not started. */
function endBooking(id, adminLabel = 'admin') {
  const b = bookings.find(x => x.id === id);
  if (!b) return { error: 'Booking not found.' };
  b.adjustments = b.adjustments || [];
  if (b.status === 'scheduled') {
    b.status = 'cancelled';
    b.endedAt = Date.now();
    b.adjustments.push({ at: b.endedAt, delta: 'cancel', by: adminLabel });
    save();
    return { booking: publicBooking(b) };
  }
  if (b.status !== 'active') return { error: 'That session is already finished.' };
  b.status = 'ended';
  b.endedAt = Date.now();
  b.durationMin = Math.max(0, Math.round((b.endedAt - b.startAt) / 60000));
  b.adjustments.push({ at: Date.now(), delta: 'end', by: adminLabel });
  save();
  return { booking: publicBooking(b) };
}

/** Start a reserved session immediately (walk-in arrived early). */
function startBooking(id, adminLabel = 'admin') {
  const b = bookings.find(x => x.id === id);
  if (!b) return { error: 'Booking not found.' };
  if (b.status !== 'scheduled') return { error: 'That booking has already started.' };
  const t = now();
  const clash = overlappingFor(b.seatId, t, t + (b.durationMin || 30) * 60000, b.id);
  if (clash) {
    const seat = seatById(b.seatId);
    return { error: `Station ${seat ? seat.label : b.seatId} is in use right now — end that session first.` };
  }
  b.startAt = t;
  b.startedAt = t;
  b.endAt = t + (b.durationMin || 30) * 60000;
  b.status = 'active';
  b.adjustments = b.adjustments || [];
  b.adjustments.push({ at: t, delta: 'start', by: adminLabel });
  save();
  return { booking: publicBooking(b) };
}

/** Full history — newest first. `phone` is only included for admins. */
function listBookings({ includeActive = true, limit = 0 } = {}) {
  sweepExpired();
  const list = bookings
    .filter(b => (includeActive ? true : b.status !== 'active'))
    .slice()
    .sort((a, b) => b.startAt - a.startAt);
  return (limit ? list.slice(0, limit) : list).map(publicBooking);
}

/** Reservations that have not started yet, soonest first (admin view). */
function listUpcoming() {
  sweepExpired();
  const t = now();
  return bookings
    .filter(b => b.status === 'scheduled' && b.endAt > t)
    .slice()
    .sort((a, b) => a.startAt - b.startAt)
    .map(b => Object.assign(publicBooking(b), {
      seatLabel: (seatById(b.seatId) || {}).label || b.seatId
    }));
}

/* --------------------------- layout editing ---------------------- */
const SEAT_TYPES = ['ps5', 'pc', 'racing', 'retro', 'other'];
const DEFAULT_ZONES = {
  ps5: 'PlayStation 5 Zone',
  pc: 'PC Battlestation',
  racing: 'Racing Arena',
  retro: "90's Nostalgia Zone",
  other: 'Gaming Zone'
};

function clampPct(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n * 1000) / 1000));
}

function sanitizeSeat(raw, index, usedIds) {
  const id = String(raw && raw.id ? raw.id : '').trim().slice(0, 24) || 'SEAT-' + String(index + 1).padStart(2, '0');
  const uniqueId = (() => {
    let candidate = id.replace(/\s+/g, '-');
    let n = 1;
    while (usedIds.has(candidate)) candidate = id.replace(/\s+/g, '-') + '-' + (++n);
    usedIds.add(candidate);
    return candidate;
  })();
  const type = SEAT_TYPES.includes(raw && raw.type) ? raw.type : 'other';
  const label = String((raw && raw.label) || uniqueId).trim().slice(0, 24) || uniqueId;
  const zone = String((raw && raw.zone) || DEFAULT_ZONES[type] || 'Gaming Zone').trim().slice(0, 40);
  const w = clampPct(raw && raw.w, 12, 2, 100);
  const h = clampPct(raw && raw.h, 14, 2, 100);
  const hourlyRate = validateHourlyRate(raw && raw.hourlyRate).hourlyRate || DEFAULT_HOURLY_RATE_RUPEES;
  return {
    id: uniqueId,
    label,
    zone,
    type,
    hourlyRate,
    x: clampPct(raw && raw.x, 5, 0, 100 - w),
    y: clampPct(raw && raw.y, 5, 0, 100 - h),
    w,
    h
  };
}

function updateStationPricing({ seatId, hourlyRate }) {
  const seat = seatById(seatId);
  if (!seat) return { error: 'Station not found.' };
  const rate = validateHourlyRate(hourlyRate);
  if (rate.error) return rate;
  seat.hourlyRate = rate.hourlyRate;
  save();
  return { seat: Object.assign({}, seat) };
}

/**
 * Replace the station layout (and optionally the floor-plan image).
 * Stations that currently carry a live booking cannot be removed.
 */
function updateLayout({ seats, layout }) {
  if (!Array.isArray(seats) || !seats.length) return { error: 'The floor plan needs at least one station.' };
  if (seats.length > 200) return { error: 'That is too many stations (200 max).' };

  const usedIds = new Set();
  const next = seats.map((s, i) => sanitizeSeat(s, i, usedIds));

  const gone = state.seats.filter(s => !next.some(n => n.id === s.id));
  const blocked = gone.filter(s => activeBookingFor(s.id));
  if (blocked.length) {
    return { error: 'These stations are in use right now, so they cannot be removed: ' + blocked.map(s => s.label).join(', ') };
  }

  state.seats = next;
  if (layout && typeof layout === 'object') {
    const image = String(layout.image || state.layout.image || '').trim();
    if (image) {
      if (!/^[\w.\-/]+$/.test(image) || image.indexOf('..') > -1) {
        return { error: 'That image path is not allowed.' };
      }
      state.layout.image = image.replace(/^\/+/, '');
    }
    const w = Number(layout.width), h = Number(layout.height);
    if (Number.isFinite(w) && w > 0) state.layout.width = Math.round(w);
    if (Number.isFinite(h) && h > 0) state.layout.height = Math.round(h);
  }
  save();
  return { seats: state.seats, layout: state.layout };
}

module.exports = {
  get state() { return state; },
  updateLayout,
  updateStationPricing,
  SEAT_TYPES,
  bookings,
  getPublicState,
  createBooking,
  adjustBooking,
  endBooking,
  startBooking,
  listBookings,
  listUpcoming,
  overlappingFor,
  sweepExpired,
  seatById,
  activeBookingFor,
  zonedTimeToMs,
  save,
  TZ,
  DATA_DIR,
  STATE_FILE,
  BOOKINGS_FILE,
  PAYMENTS_FILE,
  validateBookingInput,
  createPendingPayment,
  paymentForOrder,
  markPaymentFailed,
  finalizePaidBooking
};
