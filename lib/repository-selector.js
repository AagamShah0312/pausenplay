'use strict';

/** Future store cutover point. JSON is intentionally the Phase 2 default. */
function getRepository(type = process.env.REPOSITORY_TYPE || 'json') {
  if (type === 'json') return require('./repository');
  if (type === 'mongodb') return require('./mongodb-repository');
  throw new Error(`Unknown repository type: ${type}`);
}

module.exports = { getRepository };
