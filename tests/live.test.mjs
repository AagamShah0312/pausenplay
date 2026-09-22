import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login } from './helpers.mjs';

/** Collect SSE events for a short window. */
function listen(srv, ms, stopWhen) {
  const controller = new AbortController();
  const events = [];
  const done = (async () => {
    const res = await fetch(`${srv.base}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    let buf = '';
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      while (true) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buf += Buffer.from(value).toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) > -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (\S+)/.exec(chunk);
          const data = /data: (.*)/.exec(chunk);
          if (ev && data) {
            events.push({ name: ev[1], data: JSON.parse(data[1]) });
            if (stopWhen && stopWhen(events)) { clearTimeout(timer); controller.abort(); return events; }
          }
        }
      }
    } catch (err) {
      // aborted
    } finally {
      clearTimeout(timer);
    }
    return events;
  })();
  return { events, done, stop: () => controller.abort() };
}

describe('live updates & layout editor', () => {
  let srv, cookie;
  before(async () => {
    srv = await startServer();
    cookie = (await login(srv)).cookie;
  });
  after(async () => { await srv.stop(); });

  test('the stream sends the current floor on connect', async () => {
    const l = listen(srv, 3000, ev => ev.length >= 1);
    const events = await l.done;
    assert.ok(events.length >= 1, 'expected an initial state event');
    assert.equal(events[0].name, 'state');
    assert.ok(Array.isArray(events[0].data.seats));
  });

  test('bookings push an update to everyone watching', async () => {
    const l = listen(srv, 8000, ev => ev.length >= 2);
    await new Promise(r => setTimeout(r, 300));
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats[0];
    await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: seat.id, name: 'Live Listener', phone: '9876511111', minutes: 30 })
    });
    const events = await l.done;
    const pushed = events.slice(1).find(e => (e.data.seats || []).some(s => s.id === seat.id && s.status === 'busy'));
    assert.ok(pushed, 'a live update with the booked station was pushed');
  });

  test('admin time changes push an update too', async () => {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats.find(s => s.status === 'busy');
    const beforeEnd = seat.booking.endAt;
    const l = listen(srv, 10000, events => events.slice(1).some(e =>
      (e.data.seats || []).some(s => s.booking && s.booking.endAt > beforeEnd + 1000)));
    await new Promise(r => setTimeout(r, 400));
    await srv.json('/api/admin/adjust', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ bookingId: seat.booking.id, deltaMinutes: 20 })
    });
    const events = await l.done;
    const pushed = events.slice(1).find(e =>
      (e.data.seats || []).some(s => s.booking && s.booking.endAt > beforeEnd + 1000));
    assert.ok(pushed, 'the extended end time was pushed to listeners');
  });

  test('layout can be edited (move, rename, add, delete)', async () => {
    const { body: state } = await srv.json('/api/state');
    const seats = state.seats.map(s => ({ ...s }));
    seats[0].x = 12.5;
    seats[0].y = 22.5;
    seats[0].label = 'VIP-1';
    seats.push({ id: 'NEW-01', label: 'NEW-01', zone: 'New Zone', type: 'other', x: 40, y: 60, w: 10, h: 12 });

    const { res, body } = await srv.json('/api/admin/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ seats })
    });
    assert.equal(res.status, 200);
    assert.equal(body.seats.length, seats.length);
    const moved = body.seats.find(s => s.id === seats[0].id);
    assert.equal(moved.x, 12.5);
    assert.equal(moved.label, 'VIP-1');
    assert.ok(body.seats.some(s => s.id === 'NEW-01'));

    // persisted for players
    const { body: pub } = await srv.json('/api/state');
    assert.ok(pub.seats.some(s => s.id === 'NEW-01' && s.status === 'free'));

    // the new station is bookable
    const { res: r2 } = await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: 'NEW-01', name: 'First On New', phone: '9876522222', minutes: 30 })
    });
    assert.equal(r2.status, 200);
  });

  test('layout changes are validated', async () => {
    const { body: state } = await srv.json('/api/state');

    // empty layout
    let { res } = await srv.json('/api/admin/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ seats: [] })
    });
    assert.equal(res.status, 400);

    // free the station booked by the previous test so the layout can change
    const { body: live } = await srv.json('/api/state');
    for (const seat of live.seats.filter(s => s.status === 'busy')) {
      await srv.json('/api/admin/end', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ bookingId: seat.booking.id })
      });
    }

    // a station that runs off the map is clamped, not rejected
    ({ res } = await srv.json('/api/admin/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ seats: [{ id: 'EDGE', label: 'EDGE', zone: 'z', type: 'other', x: 95, y: 95, w: 30, h: 30 }] })
    }));
    assert.equal(res.status, 200);
    const { body: after } = await srv.json('/api/state');
    const edge = after.seats[0];
    assert.ok(edge.x + edge.w <= 100.01 && edge.y + edge.h <= 100.01, 'station clamped inside the map');

    // a station that is live right now cannot be deleted by a layout change
    await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: 'EDGE', name: 'Busy Player', phone: '9876533333', minutes: 30 })
    });
    ({ res } = await srv.json('/api/admin/layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ seats: [{ id: 'ONLY-ONE', label: 'ONLY-ONE', zone: 'z', type: 'other', x: 5, y: 5, w: 10, h: 10 }] })
    }));
    assert.equal(res.status, 400);
    const { body: error } = await srv.json('/api/state');
    assert.ok(error.seats.some(s => s.id === 'EDGE'), 'the busy station was kept');
  });

  test('the floor-plan image can be uploaded', async () => {
    // 1x1 red png
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const { res, body } = await srv.json('/api/admin/layout-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'my store plan.png', data: 'data:image/png;base64,' + png, width: 1200, height: 800 })
    });
    assert.equal(res.status, 200);
    assert.equal(body.image, 'api/layout-image');

    // the image is served and used by the public state
    const img = await srv.req('/' + body.image);
    assert.equal(img.status, 200);
    const { body: pub } = await srv.json('/api/state');
    assert.equal(pub.layout.image, body.image);
    assert.equal(pub.layout.width, 1200);

    // junk is rejected
    for (const bad of [
      { name: 'x.png', data: 'not-a-data-url' },
      { name: 'x.png', data: 'data:text/plain;base64,aGVsbG8=' },
      { name: 'x.png', data: 'data:image/png;base64,AA==' }
    ]) {
      const r = await srv.json('/api/admin/layout-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ ...bad, width: 10, height: 10 })
      });
      assert.equal(r.res.status, 400, 'should reject ' + bad.data.slice(0, 24));
    }
  });

  test('a failed image replacement keeps the existing layout reference', async () => {
    const failedSrv = await startServer({ layoutUploadFails: true });
    try {
      const failedCookie = (await login(failedSrv)).cookie;
      const { body: before } = await failedSrv.json('/api/state');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
      const response = await failedSrv.json('/api/admin/layout-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: failedCookie },
        body: JSON.stringify({ data: 'data:image/png;base64,' + png, width: 1200, height: 800 })
      });
      assert.equal(response.res.status, 502);
      const { body: after } = await failedSrv.json('/api/state');
      assert.deepEqual(after.layout, before.layout);
    } finally {
      await failedSrv.stop();
    }
  });
});
