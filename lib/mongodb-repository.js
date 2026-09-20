'use strict';

/** Async counterpart of repository.js. It is not selected by default yet. */
const { collections } = require('./mongodb');

async function initialize() { return collections(); }

async function getState(fallback) {
  const { state } = await collections();
  const record = await state.findOne({ _id: 'singleton' });
  if (!record) return fallback;
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

module.exports = { initialize, getState, getBookings, getPayments, save };
