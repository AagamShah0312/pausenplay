import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const uri = process.env.MONGODB_TEST_URI;
const testDb = `${process.env.MONGODB_TEST_DB_NAME || 'pausenplay_integration'}_${crypto.randomBytes(5).toString('hex')}`;

test('MongoDB initializes fresh state and atomically rejects overlapping bookings', {
  skip: !uri && 'set MONGODB_TEST_URI to run MongoDB integration coverage'
}, async () => {
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB_NAME = testDb;
  const repository = require('../lib/mongodb-repository.js');
  const { closeMongo } = require('../lib/mongodb.js');
  const defaultState = {
    storeName: 'PausenPlay',
    durations: [30, 60, 90, 120, 180],
    defaultDuration: 60,
    booking: { advanceDays: 30, minAdvanceMinutes: 0, slotStepMinutes: 15 },
    layout: { image: 'assets/store-layout.svg', width: 1000, height: 620 },
    seats: [{ id: 'PS5-01', label: 'PS5-01', zone: 'Test', type: 'ps5', hourlyRate: 50, x: 0, y: 0, w: 10, h: 10 }]
  };

  try {
    await repository.initialize();
    const { collections } = require('../lib/mongodb.js');
    const paymentIdIndex = (await (await collections()).payments.listIndexes().toArray()).find(index => index.name === 'razorpayPaymentId_1');
    assert.equal(paymentIdIndex.unique, true);
    assert.deepEqual(paymentIdIndex.partialFilterExpression, { razorpayPaymentId: { $type: 'string' } });
    const state = await repository.getState(defaultState);
    assert.equal(state.seats[0].hourlyRate, 50, 'missing state is initialized from defaults');

    state.seats[0].hourlyRate = 70;
    const startAt = Date.now() + 3600000;
    const booking = {
      id: 'booking-one', seatId: 'PS5-01', seatLabel: 'PS5-01', zone: 'Test',
      name: 'Mongo Player', phone: '9876543210', startAt, endAt: startAt + 90 * 60000,
      durationMin: 90, status: 'scheduled', createdAt: Date.now(), createdBy: 'customer',
      payment: { status: 'paid', razorpayOrderId: 'order-one', razorpayPaymentId: 'pay-one', amountPaise: 10500, currency: 'INR', hourlyRate: 70, amount: 105 }
    };
    const competing = { ...booking, id: 'booking-two', name: 'Second Player' };
    const [first, second] = await Promise.all([
      repository.createBookingIfAvailable(booking),
      repository.createBookingIfAvailable(competing)
    ]);
    assert.deepEqual([first, second].sort(), [false, true], 'exactly one overlapping booking commits');

    const payment = { id: 'payment-one', razorpayOrderId: 'order-one', razorpayPaymentId: 'pay-one', amountPaise: 10500, currency: 'INR', status: 'completed', bookingId: 'booking-one' };
    await repository.save({ state, bookings: [booking], payments: [payment] });
    assert.equal((await repository.getState({})).seats[0].hourlyRate, 70);
    assert.equal((await repository.getBookings([]))[0].payment.amountPaise, 10500);
    assert.equal((await repository.getBookings([]))[0].payment.hourlyRate, 70, 'historical price snapshot persists');
    assert.equal((await repository.getPayments([]))[0].razorpayPaymentId, 'pay-one');

    process.env.AUTH_STORAGE_TYPE = 'mongodb';
    const { getAuthStorage } = require('../lib/auth-storage.js');
    const authStorage = getAuthStorage();
    const authDefault = { username: 'Admin', salt: 'test-salt', hash: 'hashed-password', usingDefault: true, updatedAt: Date.now() };
    assert.deepEqual(await authStorage.initialize(authDefault), authDefault, 'missing auth singleton is initialized');
    await authStorage.save({ ...authDefault, username: 'Manager', hash: 'changed-hash', usingDefault: false });
    const persistedAuth = await authStorage.initialize(authDefault);
    assert.equal(persistedAuth.username, 'Manager');
    assert.equal(persistedAuth.hash, 'changed-hash');
    assert.equal(Object.hasOwn(persistedAuth, 'password'), false, 'plaintext passwords are never persisted');
  } finally {
    await closeMongo();
  }
});
