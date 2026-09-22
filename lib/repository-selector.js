'use strict';

/** MongoDB is authoritative in production; JSON remains an explicit local adapter. */
function getRepository(type = process.env.REPOSITORY_TYPE || 'mongodb') {
  if (type === 'json') return require('./repository');
  if (type === 'mongodb') return require('./mongodb-repository');
  throw new Error(`Unknown repository type: ${type}`);
}

module.exports = { getRepository };
