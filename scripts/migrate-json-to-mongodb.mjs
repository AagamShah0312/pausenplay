#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
const { collections, closeMongo } = require('../lib/mongodb.js');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataDir = process.env.PAUSENPLAY_DATA_DIR || path.join(root, 'data');
const read = name => { const file = path.join(dataDir, name); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; };
try {
  const state = read('state.json');
  const bookings = read('bookings.json') || [];
  const payments = read('payments.json') || [];
  const db = await collections();
  if (state) await db.state.updateOne({ _id: 'singleton' }, { $set: { ...state, _id: 'singleton' } }, { upsert: true });
  let migrated = 0;
  for (const booking of bookings) { const r = await db.bookings.updateOne({ id: booking.id }, { $setOnInsert: booking }, { upsert: true }); migrated += r.upsertedCount; }
  let migratedPayments = 0;
  for (const payment of payments) { const r = await db.payments.updateOne({ razorpayOrderId: payment.razorpayOrderId }, { $setOnInsert: payment }, { upsert: true }); migratedPayments += r.upsertedCount; }
  console.log(`Migration complete: ${state ? 'state upserted' : 'no state file'}, ${migrated} bookings inserted, ${migratedPayments} payments inserted.`);
} finally { await closeMongo(); }
