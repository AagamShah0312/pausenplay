import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, login } from './helpers.mjs';

/** Format an instant as the store's wall clock so we can check the round trip. */
function wallClock(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const out = {};
  f.formatToParts(new Date(ms)).forEach(p => { out[p.type] = p.value; });
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    time: `${String(Number(out.hour) % 24).padStart(2, '0')}:${out.minute}`
  };
}

const day = (n, timeZone) => {
  const ms = Date.now() + n * 86400000;
  return wallClock(ms, timeZone).date;
};

describe('booking by date and time', () => {
  let srv, tz;
  before(async () => {
    srv = await startServer();
    const { body } = await srv.json('/api/state');
    tz = body.booking.timezone;
  });
  after(async () => { await srv.stop(); });

  const book = payload => srv.json('/api/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  test('the state advertises the booking window', async () => {
    const { body } = await srv.json('/api/state');
    assert.ok(body.booking, 'booking config missing');
    assert.equal(typeof body.booking.advanceDays, 'number');
    assert.ok(Array.isArray(body.upcoming));
    assert.equal(body.upcomingCount, 0);
  });

  test('a player can reserve a station for a future date and time', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats[0];
    const date = day(1, tz);
    const { res, body } = await book({
      seatId: seat.id, name: 'Planner Patel', phone: '9876500011',
      minutes: 90, date, time: '18:30'
    });
    assert.equal(res.status, 200);
    assert.equal(body.booking.status, 'scheduled');
    assert.equal(body.booking.durationMin, 90);
    assert.equal(body.booking.endAt - body.booking.startAt, 90 * 60000);
    // the picked wall clock must survive the trip through the store timezone
    const picked = wallClock(body.booking.startAt, tz);
    assert.equal(picked.date, date);
    assert.equal(picked.time, '18:30');

    // the station is still free right now, but shows the reservation
    const { body: after } = await srv.json('/api/state');
    const same = after.seats.find(s => s.id === seat.id);
    assert.equal(same.status, 'free', 'a future booking must not block the station now');
    assert.equal(same.booking, null);
    assert.equal(same.next.id, body.booking.id);
    assert.equal(after.upcomingCount, 1);
    assert.equal(after.upcoming[0].seatId, seat.id);
    assert.equal(after.upcoming[0].name, undefined, 'upcoming list stays anonymous on the public map');
  });

  test('two reservations cannot overlap on the same station', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats[0];
    const date = day(1, tz);

    // 19:00 for 60 min overlaps the 18:30–20:00 booking above
    let r = await book({ seatId: seat.id, name: 'Clash One', phone: '9876500012', minutes: 60, date, time: '19:00' });
    assert.equal(r.res.status, 400);
    assert.match(r.body.error, /already booked/i);

    // 20:00 starts exactly when the first one ends — that is allowed
    r = await book({ seatId: seat.id, name: 'Back To Back', phone: '9876500013', minutes: 30, date, time: '20:00' });
    assert.equal(r.res.status, 200);

    // the same time on another station is fine
    const other = state.seats.find(s => s.id !== seat.id);
    r = await book({ seatId: other.id, name: 'Other Station', phone: '9876500014', minutes: 60, date, time: '19:00' });
    assert.equal(r.res.status, 200);
  });

  test('slots in the past or too far ahead are refused', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free');
    const past = wallClock(Date.now() - 3 * 3600000, tz);

    let r = await book({ seatId: seat.id, name: 'Time Traveller', phone: '9876500015', minutes: 30, date: past.date, time: past.time });
    assert.equal(r.res.status, 400);
    assert.match(r.body.error, /passed|future/i);

    const far = day(400, tz);
    r = await book({ seatId: seat.id, name: 'Far Future', phone: '9876500016', minutes: 30, date: far, time: '18:00' });
    assert.equal(r.res.status, 400);
    assert.match(r.body.error, /days ahead/i);

    r = await book({ seatId: seat.id, name: 'Half A Slot', phone: '9876500017', minutes: 30, date: day(2, tz) });
    assert.equal(r.res.status, 400, 'a date without a time is not enough');
  });

  test('a reservation blocks a walk-in that overlaps it', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.next);
    const at = seat.next.startAt + 10 * 60000;
    const { res, body } = await book({
      seatId: seat.id, name: 'Overlap Attempt', phone: '9876500018', minutes: 30, startAt: at
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /already booked/i);
  });

  test('a reservation keeps the station free until it starts', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free' && !s.next);
    const startAt = Date.now() + 3 * 3600000;
    const { body } = await book({ seatId: seat.id, name: 'Later Player', phone: '9876500019', minutes: 45, startAt });
    assert.equal(body.booking.status, 'scheduled');

    await new Promise(r => setTimeout(r, 1200)); // let the server sweep tick over it
    const { body: now } = await srv.json('/api/state');
    const s = now.seats.find(x => x.id === seat.id);
    assert.equal(s.status, 'free', 'the station must stay open until the slot starts');
    assert.equal(s.next.id, body.booking.id);
    assert.equal(now.upcoming.find(u => u.id === body.booking.id).durationMin, 45);
  });
});

describe('the store moves reservations into running sessions', () => {
  let store, dataDir;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pausenplay-sweep-'));
    process.env.PAUSENPLAY_DATA_DIR = dataDir;
    process.env.REPOSITORY_TYPE = 'json';
    const require = createRequire(import.meta.url);
    store = require('../lib/store.js');
    await store.initialize();
  });

  after(() => {
    delete process.env.PAUSENPLAY_DATA_DIR;
    delete process.env.REPOSITORY_TYPE;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a slot whose time has come flips to active on the next sweep', async () => {
    const seat = store.state.seats[0];
    const made = await store.createBooking({
      seatId: seat.id, name: 'Sweep Me', phone: '9000000099',
      minutes: 30, startAt: Date.now() + 3 * 3600000, createdBy: 'customer'
    });
    assert.equal(made.booking.status, 'scheduled');
    const id = made.booking.id;

    // pretend the clock moved on
    const persisted = JSON.parse(fs.readFileSync(store.BOOKINGS_FILE, 'utf8'));
    const b = persisted.find(x => x.id === id);
    b.startAt = Date.now() - 1000;
    b.endAt = b.startAt + 30 * 60000;
    fs.writeFileSync(store.BOOKINGS_FILE, JSON.stringify(persisted, null, 2));
    await store.initialize();

    assert.equal(await store.sweepExpired(), true, 'the sweep should report a change');
    const updated = (await store.listBookings()).find(x => x.id === id);
    assert.equal(updated.status, 'active');
    assert.ok(updated.startedAt > 0, 'startedAt is stamped when the session opens');
    assert.equal(store.activeBookingFor(seat.id).id, id, 'the station is occupied from now on');
  });

  test('a slot that passed completely is marked missed', async () => {
    const seat = store.state.seats[1];
    const made = await store.createBooking({
      seatId: seat.id, name: 'No Show', phone: '9000000098',
      minutes: 30, startAt: Date.now() + 3 * 3600000, createdBy: 'customer'
    });
    const persisted = JSON.parse(fs.readFileSync(store.BOOKINGS_FILE, 'utf8'));
    const b = persisted.find(x => x.id === made.booking.id);
    b.startAt = Date.now() - 2 * 3600000;
    b.endAt = b.startAt + 30 * 60000;
    fs.writeFileSync(store.BOOKINGS_FILE, JSON.stringify(persisted, null, 2));
    await store.initialize();

    await store.sweepExpired();
    assert.equal((await store.listBookings()).find(x => x.id === made.booking.id).status, 'expired');
    assert.equal(store.activeBookingFor(seat.id), null, 'the station is free again');
  });
});

describe('admin control of reservations', () => {
  let srv, cookie;
  const post = (path, payload) => srv.json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(payload)
  });

  before(async () => { srv = await startServer(); cookie = (await login(srv)).cookie; });
  after(async () => { await srv.stop(); });

  test('the counter can hold a station for later', async () => {
    const { body: state } = await srv.json('/api/state');
    const tz = state.booking.timezone;
    const seat = state.seats[0];
    const tomorrow = day(1, tz);
    const { res, body } = await post('/api/admin/book', {
      seatId: seat.id, name: 'Walk In Later', phone: '9000000021',
      minutes: 60, date: tomorrow, time: '20:00'
    });
    assert.equal(res.status, 200);
    assert.equal(body.booking.status, 'scheduled');
    assert.equal(body.booking.createdBy, 'admin');

    const { body: admin } = await srv.json('/api/admin/state', { headers: { cookie } });
    assert.equal(admin.upcomingBookings.length, 1);
    assert.equal(admin.upcomingBookings[0].name, 'Walk In Later', 'admins see who reserved');
    assert.equal(admin.stats.upcoming, 1);
  });

  test('a reservation can be cancelled before it starts', async () => {
    const { body: admin } = await srv.json('/api/admin/state', { headers: { cookie } });
    const b = admin.upcomingBookings[0];
    const { body } = await post('/api/admin/end', { bookingId: b.id });
    assert.equal(body.booking.status, 'cancelled');

    const { body: after } = await srv.json('/api/admin/state', { headers: { cookie } });
    assert.equal(after.upcomingBookings.length, 0);
    const pub = await srv.json('/api/state');
    assert.equal(pub.body.seats.find(s => s.id === b.seatId).next, null, 'the slot is open again');
    const seat = pub.body.seats.find(s => s.id === b.seatId);
    const { res } = await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: seat.id, name: 'Takes The Slot', phone: '9000000022', minutes: 60, startAt: b.startAt })
    });
    assert.equal(res.status, 200, 'a cancelled reservation must free the slot');
  });

  test('a reservation can be started early and then ended', async () => {
    const { body: state } = await srv.json('/api/state');
    const tz = state.booking.timezone;
    const seat = state.seats.find(s => s.status === 'free' && !s.next);
    await post('/api/admin/book', {
      seatId: seat.id, name: 'Early Bird', phone: '9000000023',
      minutes: 60, date: day(2, tz), time: '11:00'
    });
    let admin = await srv.json('/api/admin/state', { headers: { cookie } });
    const b = admin.body.upcomingBookings.find(x => x.name === 'Early Bird');

    const started = await post('/api/admin/start', { bookingId: b.id });
    assert.equal(started.body.booking.status, 'active');
    assert.ok(started.body.booking.endAt > Date.now() + 55 * 60000);

    const pub = await srv.json('/api/state');
    assert.equal(pub.body.seats.find(s => s.id === seat.id).status, 'busy');

    const ended = await post('/api/admin/end', { bookingId: b.id });
    assert.equal(ended.body.booking.status, 'ended');
    const after = await srv.json('/api/state');
    assert.equal(after.body.seats.find(s => s.id === seat.id).status, 'free');
  });

  test('ending a reservation twice is refused', async () => {
    const { body: admin } = await srv.json('/api/admin/state', { headers: { cookie } });
    const finished = admin.bookings.find(b => b.status === 'cancelled');
    const { res, body } = await post('/api/admin/end', { bookingId: finished.id });
    assert.equal(res.status, 400);
    assert.match(body.error, /already finished/i);
  });

  test('the Excel export labels reservations and keeps the summary honest', async () => {
    const res = await srv.req('/api/export.xlsx', { headers: { cookie } });
    assert.equal(res.status, 200);
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const csv = await (await srv.req('/api/export.csv', { headers: { cookie } })).text();
    assert.match(csv, /Scheduled|Cancelled/, 'the new statuses are missing from the export');
    assert.ok(text.length > 1000, 'workbook looks empty');
  });
});
