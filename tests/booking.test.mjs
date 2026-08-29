import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login } from './helpers.mjs';

describe('customer booking flow', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  test('floor plan starts with every station free', async () => {
    const { body } = await srv.json('/api/state');
    assert.ok(body.seats.length >= 1, 'expected stations');
    assert.ok(body.seats.every(s => s.status === 'free'));
    assert.equal(body.activeCount, 0);
    assert.ok(body.durations.includes(body.defaultDuration));
    assert.ok(body.serverTime > 0);
    body.seats.forEach(s => {
      ['x', 'y', 'w', 'h'].forEach(k => assert.equal(typeof s[k], 'number', `${s.id} ${k}`));
      assert.ok(s.x >= 0 && s.x + s.w <= 100.01, `${s.id} must sit inside the map`);
      assert.ok(s.y >= 0 && s.y + s.h <= 100.01, `${s.id} must sit inside the map`);
    });
  });

  test('a player can book a free station', async () => {
    const { body: before } = await srv.json('/api/state');
    const seat = before.seats[0];
    const { res, body } = await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: seat.id, name: 'Rahul Shah', phone: '9876543210', minutes: 60 })
    });
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.booking.seatId, seat.id);
    assert.equal(body.booking.durationMin, 60);
    assert.ok(body.booking.endAt - body.booking.startAt === 60 * 60000);

    const { body: after } = await srv.json('/api/state');
    const same = after.seats.find(s => s.id === seat.id);
    assert.equal(same.status, 'busy');
    assert.equal(same.booking.name, 'Rahul Shah');
    assert.ok(same.booking.remainingMs > 59 * 60000);
    assert.equal(after.activeCount, 1);
  });

  test('a booked station cannot be booked again', async () => {
    const { body: state } = await srv.json('/api/state');
    const busy = state.seats.find(s => s.status === 'busy');
    const { res, body } = await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: busy.id, name: 'Second Player', phone: '9876543211', minutes: 30 })
    });
    assert.equal(res.status, 400);
    assert.match(body.error, /booked/i);
  });

  test('bookings are validated', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free');
    const post = payload => srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let r = await post({ seatId: seat.id, name: 'A', phone: '9876543210', minutes: 30 });
    assert.equal(r.res.status, 400);

    r = await post({ seatId: seat.id, name: 'Good Name', phone: '123', minutes: 30 });
    assert.equal(r.res.status, 400);

    r = await post({ seatId: 'NOPE-99', name: 'Good Name', phone: '9876543210', minutes: 30 });
    assert.equal(r.res.status, 400);

    r = await post({ seatId: seat.id, name: 'Good Name', phone: '9876543210', minutes: -5 });
    assert.equal(r.res.status, 400);

    // nothing invalid was stored
    const { body: after } = await srv.json('/api/state');
    assert.equal(after.seats.find(s => s.id === seat.id).status, 'free');
  });

  test('phone numbers are normalised to digits', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free');
    const { body } = await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: seat.id, name: 'Plus Prefix', phone: '+91 98-765 43210', minutes: 30 })
    });
    assert.equal(body.booking.phone, '919876543210');
  });
});

describe('admin control of sessions', () => {
  let srv, cookie;
  before(async () => {
    srv = await startServer();
    cookie = (await login(srv)).cookie;
    const { body: state } = await srv.json('/api/state');
    await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: state.seats[1].id, name: 'Time Keeper', phone: '9000000001', minutes: 60 })
    });
  });
  after(async () => { await srv.stop(); });

  const post = (path, payload) => srv.json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(payload)
  });

  test('admin can extend a running session', async () => {
    const { body: state } = await srv.json('/api/state');
    const b = state.seats.find(s => s.status === 'busy').booking;
    const { body } = await post('/api/admin/adjust', { bookingId: b.id, deltaMinutes: 30 });
    assert.equal(body.ok, true);
    assert.equal(body.booking.durationMin, 90);
    assert.equal(body.booking.adjustments.length, 1);
    assert.equal(body.booking.adjustments[0].delta, 30);
  });

  test('admin can shorten a running session', async () => {
    const { body: state } = await srv.json('/api/state');
    const b = state.seats.find(s => s.status === 'busy').booking;
    const { body } = await post('/api/admin/adjust', { bookingId: b.id, deltaMinutes: -45 });
    assert.equal(body.booking.durationMin, 45);
    assert.equal(body.booking.status, 'active');
  });

  test('cutting more time than is left ends the session', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'busy');
    const { body } = await post('/api/admin/adjust', { bookingId: seat.booking.id, deltaMinutes: -600 });
    assert.equal(body.booking.status, 'ended');
    const { body: after } = await srv.json('/api/state');
    assert.equal(after.seats.find(s => s.id === seat.id).status, 'free', 'station turns green again');
  });

  test('admin can end a session outright', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free');
    await post('/api/admin/book', { seatId: seat.id, name: 'End Me', phone: '9000000002', minutes: 60 });
    const b = (await (await srv.req('/api/state')).json()).seats.find(s => s.id === seat.id).booking;
    const { body } = await post('/api/admin/end', { bookingId: b.id });
    assert.equal(body.booking.status, 'ended');
    const { body: after } = await srv.json('/api/state');
    assert.equal(after.seats.find(s => s.id === seat.id).status, 'free');
  });

  test('admin walk-in bookings are flagged', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'free');
    const { body } = await post('/api/admin/book', { seatId: seat.id, name: 'Walk In', phone: '9000000003', minutes: 45 });
    assert.equal(body.booking.createdBy, 'admin');
  });

  test('history lists every booking with its details', async () => {
    const { body } = await srv.json('/api/admin/history', { headers: { cookie } });
    assert.ok(body.bookings.length >= 2);
    const found = body.bookings.find(b => b.name === 'Walk In');
    assert.ok(found, 'walk-in booking is in the history');
    assert.equal(found.phone, '9000000003');
    assert.ok(found.durationMin >= 45);
    ['active', 'today', 'minutesToday', 'total', 'customers'].forEach(k =>
      assert.equal(typeof body.stats[k], 'number', 'stat ' + k));
  });
});
