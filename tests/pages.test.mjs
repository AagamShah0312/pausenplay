import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

describe('pages & static files', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  test('customer site loads and contains the booking section', async () => {
    const res = await srv.req('/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    ['id="book"', 'id="storeMap"', 'id="bookForm"', 'id="playerName"', 'id="playerPhone"',
      'id="durations"', 'id="mySession"', 'js/booking.js', 'css/booking.css', 'js/pixel-cat.js', 'css/pixel-cat.css']
      .forEach(token => assert.ok(html.includes(token), `homepage missing ${token}`));
  });

  test('admin console loads at /admin (and /admin/)', async () => {
    for (const url of ['/admin', '/admin/']) {
      const res = await srv.req(url);
      assert.equal(res.status, 200, url + ' should be 200');
      const html = await res.text();
      ['id="loginForm"', 'id="adminMap"', 'id="activeBody"', 'id="historyBody"',
        'id="exportXlsx"', 'id="credForm"', 'id="layoutEditor"', 'js/pixel-cat.js', 'css/pixel-cat.css']
        .forEach(token => assert.ok(html.includes(token), `admin page missing ${token}`));
    }
  });

  test('css, js and the floor plan are served', async () => {
    const files = {
      '/css/booking.css': /text\/css/,
      '/css/admin.css': /text\/css/,
      '/css/pixel-cat.css': /text\/css/,
      '/js/booking.js': /javascript/,
      '/js/admin.js': /javascript/,
      '/js/pixel-cat.js': /javascript/,
      '/assets/store-layout.svg': /image\/svg/
    };
    for (const [url, type] of Object.entries(files)) {
      const res = await srv.req(url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers.get('content-type'), type, url);
    }
  });

  test('unknown paths return 404 and cannot escape the public folder', async () => {
    assert.equal((await srv.req('/nope-does-not-exist')).status, 404);
    assert.equal((await srv.req('/../server.js')).status, 404);
    assert.equal((await srv.req('/..%2fserver.js')).status, 404);
    const leak = await srv.req('/package.json');
    assert.ok(leak.status === 404 || !(await leak.text()).includes('pausenplay'));
  });
});
