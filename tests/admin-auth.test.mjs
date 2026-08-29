import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login } from './helpers.mjs';

describe('admin authentication', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  test('default credentials work', async () => {
    const { res, body, cookie } = await login(srv, 'Admin', 'Admin123');
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.usingDefault, true);
    assert.match(cookie, /^pp_admin=/);
  });

  test('username is case-insensitive, password is not', async () => {
    const lower = await login(srv, 'admin', 'Admin123');
    assert.equal(lower.res.status, 200);
    const wrongCase = await login(srv, 'Admin', 'admin123');
    assert.equal(wrongCase.res.status, 401);
  });

  test('wrong password is rejected', async () => {
    const { res, body } = await login(srv, 'Admin', 'nope');
    assert.equal(res.status, 401);
    assert.match(body.error, /wrong/i);
  });

  test('admin endpoints reject anonymous callers', async () => {
    const paths = ['/api/admin/state', '/api/admin/history', '/api/export.xlsx', '/api/export.csv'];
    for (const p of paths) {
      const res = await srv.req(p);
      assert.equal(res.status, 401, p + ' must require a session');
    }
    for (const p of ['/api/admin/adjust', '/api/admin/end', '/api/admin/book', '/api/admin/layout', '/api/admin/credentials']) {
      const res = await srv.req(p, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      assert.equal(res.status, 401, p + ' must require a session');
    }
  });

  test('a bogus cookie is not accepted', async () => {
    const res = await srv.req('/api/admin/state', { headers: { cookie: 'pp_admin=deadbeef' } });
    assert.equal(res.status, 401);
  });

  test('credentials can be changed and old ones stop working', async () => {
    const first = await login(srv);
    assert.equal(first.res.status, 200);

    // wrong current password is refused
    let { res, body } = await srv.json('/api/admin/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ currentPassword: 'wrong-one', username: 'Manager', password: 'NewPass123', confirmPassword: 'NewPass123' })
    });
    assert.equal(res.status, 400);

    // mismatched confirmation is refused
    ({ res, body } = await srv.json('/api/admin/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ currentPassword: 'Admin123', username: 'Manager', password: 'NewPass123', confirmPassword: 'Different1' })
    }));
    assert.equal(res.status, 400);

    // too short is refused
    ({ res, body } = await srv.json('/api/admin/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ currentPassword: 'Admin123', username: 'Manager', password: 'abc', confirmPassword: 'abc' })
    }));
    assert.equal(res.status, 400);

    // the real change
    ({ res, body } = await srv.json('/api/admin/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: first.cookie },
      body: JSON.stringify({ currentPassword: 'Admin123', username: 'Manager', password: 'NewPass123', confirmPassword: 'NewPass123' })
    }));
    assert.equal(res.status, 200);
    assert.equal(body.username, 'Manager');

    // old session + old password are both dead
    assert.equal((await srv.req('/api/admin/state', { headers: { cookie: first.cookie } })).status, 401);
    assert.equal((await login(srv, 'Admin', 'Admin123')).res.status, 401);

    // new credentials work, and are reported as no longer default
    const fresh = await login(srv, 'Manager', 'NewPass123');
    assert.equal(fresh.res.status, 200);
    assert.equal(fresh.body.usingDefault, false);
    assert.equal(fresh.body.username, 'Manager');
  });

  test('logout clears the session', async () => {
    const { cookie } = await login(srv, 'Manager', 'NewPass123');
    assert.equal((await srv.req('/api/admin/state', { headers: { cookie } })).status, 200);
    await srv.req('/api/admin/logout', { method: 'POST', headers: { cookie } });
    assert.equal((await srv.req('/api/admin/state', { headers: { cookie } })).status, 401);
  });

  test('/api/admin/me reports the signed-in user', async () => {
    const { cookie } = await login(srv, 'Manager', 'NewPass123');
    const { res, body } = await srv.json('/api/admin/me', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal(body.username, 'Manager');
    assert.equal(body.usingDefault, false);
    assert.equal((await srv.req('/api/admin/me')).status, 401);
  });
});
