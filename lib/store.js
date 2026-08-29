'use strict';
/**
 * PausenPlay — booking store
 * Zero dependency. Persists to data/*.json so the server can be restarted
 * without losing bookings.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

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
    maxAdvanceMinutes: null, // null = no limit
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
if (!Array.isArray(state.durations) || !state.durations.length) state.durations = [30, 60, 90, 120, 180];

let bookings = readJSON(BOOKINGS_FILE, []);
if (!Array.isArray(bookings)) bookings = [];

/* --------------------------- persistence --------------------------- */
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
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
    endedAt: b.endedAt || null,
    createdAt: b.createdAt,
    createdBy: b.createdBy || 'customer',
    adjustments: b.adjustments || []
  };
}

/** Sweep finished sessions so seats flip back to green automatically. */
function sweepExpired() {
  const t = now();
  let changed = false;
  for (const b of bookings) {
    if (b.status === 'active' && b.endAt <= t) {
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
  const seats = state.seats.map(s => {
    const b = active.find(x => x.seatId === s.id) || null;
    return {
      id: s.id,
      label: s.label,
      zone: s.zone,
      type: s.type,
      x: s.x, y: s.y, w: s.w, h: s.h,
      status: b ? 'busy' : 'free',
      booking: b ? {
        id: b.id,
        name: b.name,
        endAt: b.endAt,
        startAt: b.startAt,
        remainingMs: Math.max(0, b.endAt - t)
      } : null
    };
  });
  return {
    serverTime: t,
    storeName: state.storeName,
    layout: state.layout,
    durations: state.durations,
    defaultDuration: state.defaultDuration,
    seats,
    activeCount: active.length,
    totalSeats: state.seats.length
  };
}

function validateBookingInput({ seatId, name, phone, minutes }) {
  const seat = seatById(seatId);
  if (!seat) return 'Please pick a valid station.';
  const cleanName = String(name || '').trim();
  if (cleanName.length < 2) return 'Please enter the player name (at least 2 characters).';
  if (cleanName.length > 40) return 'Name is too long (40 characters max).';
  const cleanPhone = String(phone || '').replace(/[^\d]/g, '');
  if (cleanPhone.length < 10 || cleanPhone.length > 13) return 'Please enter a valid 10 digit phone number.';
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins <= 0) return 'Please choose how long you want to play.';
  if (state.durations.length && !state.durations.includes(mins) && mins > 600) return 'That duration is not allowed.';
  if (activeBookingFor(seatId)) return `Station ${seat.label} was just booked by someone else. Pick another one.`;
  return null;
}

function createBooking({ seatId, name, phone, minutes, createdBy = 'customer' }) {
  const err = validateBookingInput({ seatId, name, phone, minutes });
  if (err) return { error: err };
  const seat = seatById(seatId);
  const t = now();
  const booking = {
    id: uid(),
    seatId: seat.id,
    seatLabel: seat.label,
    zone: seat.zone,
    name: String(name).trim().slice(0, 40),
    phone: String(phone || '').replace(/[^\d]/g, ''),
    startAt: t,
    endAt: t + Number(minutes) * 60000,
    durationMin: Number(minutes),
    status: 'active',
    endedAt: null,
    createdAt: t,
    createdBy,
    adjustments: []
  };
  bookings.push(booking);
  save();
  return { booking: publicBooking(booking) };
}

/** Add or remove minutes from a live session (admin). */
function adjustBooking(id, deltaMinutes, adminLabel = 'admin') {
  const b = bookings.find(x => x.id === id);
  if (!b) return { error: 'Booking not found.' };
  if (b.status !== 'active') return { error: 'That session is already finished.' };
  const delta = Number(deltaMinutes);
  if (!Number.isFinite(delta) || delta === 0) return { error: 'Invalid time change.' };

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

function endBooking(id, adminLabel = 'admin') {
  const b = bookings.find(x => x.id === id);
  if (!b) return { error: 'Booking not found.' };
  if (b.status !== 'active') return { error: 'That session is already finished.' };
  b.status = 'ended';
  b.endedAt = Date.now();
  b.durationMin = Math.max(0, Math.round((b.endedAt - b.startAt) / 60000));
  b.adjustments = b.adjustments || [];
  b.adjustments.push({ at: Date.now(), delta: 'end', by: adminLabel });
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

module.exports = {
  get state() { return state; },
  bookings,
  getPublicState,
  createBooking,
  adjustBooking,
  endBooking,
  listBookings,
  sweepExpired,
  seatById,
  activeBookingFor,
  save,
  DATA_DIR
};
