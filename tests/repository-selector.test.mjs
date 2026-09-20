import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('repository selection defaults to the synchronous JSON adapter', () => {
  const { getRepository } = require('../lib/repository-selector.js');
  const repository = getRepository('json');
  ['getState', 'getBookings', 'getPayments', 'save'].forEach(name => assert.equal(typeof repository[name], 'function'));
  assert.throws(() => getRepository('unknown'), /Unknown repository type/);
});

test('MongoDB adapter exposes the same persistence operations asynchronously', () => {
  const repository = require('../lib/mongodb-repository.js');
  ['initialize', 'getState', 'getBookings', 'getPayments', 'save'].forEach(name => assert.equal(typeof repository[name], 'function'));
});
