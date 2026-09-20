#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
const repository = require('../lib/mongodb-repository.js');
const { closeMongo } = require('../lib/mongodb.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = process.env.PAUSENPLAY_DATA_DIR || path.join(root, 'data');
const read = name => { const file = path.join(dataDir, name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; };
try {
  const state = read('state.json');
  const bookings = read('bookings.json') || [];
  const payments = read('payments.json') || [];
  await repository.initialize();
  const existingBookings = await repository.getBookings([]);
  const existingPayments = await repository.getPayments([]);
  await repository.save({ state: state || {}, bookings, payments });
  const migrated = bookings.filter(b => !existingBookings.some(x => x.id === b.id)).length;
  const migratedPayments = payments.filter(p => !existingPayments.some(x => x.razorpayOrderId === p.razorpayOrderId)).length;
  console.log(`Migration complete: ${state ? 'state upserted' : 'no state file'}, ${migrated} bookings inserted, ${migratedPayments} payments inserted.`);
} finally { await closeMongo(); }
