'use strict';

const { MongoClient } = require('mongodb');

let client;
let connectPromise;

async function connectMongo() {
  if (client) return client.db(process.env.MONGODB_DB_NAME || 'pausenplay');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI must be set before starting PauseNPlay.');
  if (!connectPromise) {
    const next = new MongoClient(process.env.MONGODB_URI);
    connectPromise = next.connect().then(() => { client = next; return client; }).catch(err => {
      connectPromise = null;
      throw new Error('MongoDB connection failed: ' + err.message.replace(process.env.MONGODB_URI, '[redacted]'));
    });
  }
  const connected = await connectPromise;
  return connected.db(process.env.MONGODB_DB_NAME || 'pausenplay');
}

async function collections() {
  const db = await connectMongo();
  const out = { db, state: db.collection('state'), bookings: db.collection('bookings'), payments: db.collection('payments') };
  await Promise.all([
    out.bookings.createIndex({ id: 1 }, { unique: true }),
    out.bookings.createIndex({ seatId: 1 }), out.bookings.createIndex({ status: 1 }),
    out.bookings.createIndex({ startAt: 1 }), out.bookings.createIndex({ endAt: 1 }),
    out.bookings.createIndex({ seatId: 1, status: 1, startAt: 1, endAt: 1 }),
    out.payments.createIndex({ razorpayOrderId: 1 }, { unique: true }),
    out.payments.createIndex({ razorpayPaymentId: 1 }, { unique: true, sparse: true })
  ]);
  return out;
}

/** Run work in a transaction using a per-station lock supplied by callers. */
async function withTransaction(work) {
  const db = await connectMongo();
  const session = client.startSession();
  try {
    return await session.withTransaction(() => work({
      db,
      state: db.collection('state'),
      bookings: db.collection('bookings'),
      payments: db.collection('payments'),
      bookingLocks: db.collection('bookingLocks')
    }, session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
  } finally {
    await session.endSession();
  }
}

async function closeMongo() { if (client) await client.close(); client = null; connectPromise = null; }

module.exports = { connectMongo, collections, withTransaction, closeMongo };
