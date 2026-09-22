'use strict';

const { collections } = require('./mongodb');

let memoryAuth;

function mongoStorage() {
  return {
    async initialize(defaultAuth) {
      const { auth } = await collections();
      await auth.updateOne(
        { _id: 'singleton' },
        { $setOnInsert: { ...defaultAuth } },
        { upsert: true }
      );
      const record = await auth.findOne({ _id: 'singleton' });
      const { _id, ...value } = record;
      return value;
    },
    async save(value) {
      const { auth } = await collections();
      await auth.updateOne({ _id: 'singleton' }, { $set: { ...value } }, { upsert: true });
    }
  };
}

function memoryStorage() {
  return {
    async initialize(defaultAuth) {
      if (!memoryAuth) memoryAuth = { ...defaultAuth };
      return { ...memoryAuth };
    },
    async save(value) { memoryAuth = { ...value }; }
  };
}

function getAuthStorage(type = process.env.AUTH_STORAGE_TYPE || 'mongodb') {
  if (type === 'mongodb') return mongoStorage();
  if (type === 'memory') return memoryStorage();
  throw new Error(`Unknown auth storage type: ${type}`);
}

module.exports = { getAuthStorage };
