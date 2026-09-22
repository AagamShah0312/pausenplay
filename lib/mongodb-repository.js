'use strict';

/** MongoDB persistence adapter. MongoDB is the production source of truth. */
const { collections, withTransaction } = require('./mongodb');

async function initialize() { return collections(); }

async function getState(fallback) {
  const { state } = await collections();
  const record = await state.findOne({ _id: 'singleton' });
  if (!record) {
    await state.updateOne({ _id: 'singleton' }, { $setOnInsert: { ...fallback } }, { upsert: true });
    return fallback;
  }
  const { _id, ...value } = record;
  return value;
}

async function getBookings(fallback = []) {
  const { bookings } = await collections();
  const records = await bookings.find({}).toArray();
  return records.length ? records.map(({ _id, ...value }) => value) : fallback;
}

async function getPayments(fallback = []) {
  const { payments } = await collections();
  const records = await payments.find({}).toArray();
  return records.length ? records.map(({ _id, ...value }) => value) : fallback;
}

/** Matches repository.js's aggregate save contract without destructive deletes. */
async function save({ state, bookings = [], payments = [] }) {
  const db = await collections();
  await db.state.updateOne({ _id: 'singleton' }, { $set: { ...state } }, { upsert: true });
  for (const booking of bookings) {
    if (!booking || !booking.id) continue;
    await db.bookings.updateOne({ id: booking.id }, { $set: { ...booking } }, { upsert: true });
  }
  for (const payment of payments) {
    if (!payment || !payment.razorpayOrderId) continue;
    await db.payments.updateOne({ razorpayOrderId: payment.razorpayOrderId }, { $set: { ...payment } }, { upsert: true });
  }
}

/**
 * Atomically reserve a station interval. A transaction updates one lock
 * document per station before checking the overlap, preventing write-skew
 * between concurrent application processes.
 */
async function createBookingIfAvailable(booking) {
  await collections(); // connect and ensure indexes before opening the transaction
  return withTransaction(async ({ bookings, bookingLocks }, session) => {
    await bookingLocks.updateOne(
      { _id: booking.seatId },
      { $inc: { revision: 1 } },
      { upsert: true, session }
    );
    const conflict = await bookings.findOne({
      seatId: booking.seatId,
      status: { $in: ['active', 'scheduled'] },
      startAt: { $lt: booking.endAt },
      endAt: { $gt: booking.startAt }
    }, { session });
    if (conflict) return false;
    await bookings.insertOne({ ...booking }, { session });
    return true;
  });
}

module.exports = { initialize, getState, getBookings, getPayments, save, createBookingIfAvailable };
