import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pausenplay-payment-'));
process.env.PAUSENPLAY_DATA_DIR = dataDir;
const store = require('../lib/store.js');
const { getBookingPrice } = require('../lib/pricing.js');
const { verifyRazorpaySignature, reconcileCapturedPayment } = require('../lib/payment.js');

after(() => { delete process.env.PAUSENPLAY_DATA_DIR; fs.rmSync(dataDir, { recursive: true, force: true }); });

test('centralized pricing calculates the allowed durations in paise', () => {
  [[30, 2500], [60, 5000], [90, 7500], [120, 10000], [180, 15000]].forEach(([minutes, amountPaise]) => {
    assert.equal(getBookingPrice({ seatId: 'PS5-01', minutes }).amountPaise, amountPaise);
  });
  assert.ok(getBookingPrice({ seatId: 'PS5-01', minutes: 0 }).error);
});

test('a frontend amount cannot affect the server price', () => {
  assert.equal(getBookingPrice({ seatId: 'PS5-01', minutes: 60, amount: 1 }).amountPaise, 5000);
});

test('signature verification rejects tampering', () => {
  const keySecret = 'test_secret';
  const good = crypto.createHmac('sha256', keySecret).update('order_1|pay_1').digest('hex');
  assert.equal(verifyRazorpaySignature({ orderId: 'order_1', paymentId: 'pay_1', signature: good, keySecret }), true);
  assert.equal(verifyRazorpaySignature({ orderId: 'order_1', paymentId: 'pay_other', signature: good, keySecret }), false);
  assert.equal(store.bookings.length, 0, 'a rejected signature is never finalized into a booking');
});

test('a verified payment creates one booking and duplicate verification is idempotent', () => {
  const seat = store.state.seats[0];
  const created = store.createPendingPayment({ razorpayOrderId: 'order_payment_test_1', amountPaise: 5000, booking: { seatId: seat.id, name: 'Payment Player', phone: '9876543210', minutes: 60 } });
  assert.ok(created.payment);
  const first = store.finalizePaidBooking({ razorpayOrderId: 'order_payment_test_1', razorpayPaymentId: 'pay_payment_test_1', amountPaise: 5000 });
  assert.ok(first.booking);
  assert.equal(first.booking.payment.razorpayPaymentId, 'pay_payment_test_1');
  const duplicate = store.finalizePaidBooking({ razorpayOrderId: 'order_payment_test_1', razorpayPaymentId: 'pay_payment_test_1', amountPaise: 5000 });
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.bookings.length, 1);
});

test('invalid durations and mismatched payment amounts cannot create a booking', () => {
  const seat = store.state.seats[1];
  const invalid = store.createPendingPayment({ razorpayOrderId: 'order_bad_duration', amountPaise: 3750, booking: { seatId: seat.id, name: 'Bad Duration', phone: '9876543211', minutes: 45 } });
  assert.ok(invalid.error);
  const pending = store.createPendingPayment({ razorpayOrderId: 'order_wrong_amount', amountPaise: 5000, booking: { seatId: seat.id, name: 'Wrong Amount', phone: '9876543212', minutes: 60 } });
  assert.ok(pending.payment);
  const result = store.finalizePaidBooking({ razorpayOrderId: 'order_wrong_amount', razorpayPaymentId: 'pay_wrong_amount', amountPaise: 1 });
  assert.ok(result.error);
  assert.equal(store.bookings.length, 1);
});

test('shared reconciliation makes checkout verification and webhook delivery order-independent', () => {
  const firstSeat = store.state.seats[2];
  store.createPendingPayment({ razorpayOrderId: 'order_checkout_then_hook', amountPaise: 5000, booking: { seatId: firstSeat.id, name: 'Checkout First', phone: '9876543220', minutes: 60 } });
  const payment = { id: 'pay_checkout_then_hook', order_id: 'order_checkout_then_hook', amount: 5000, currency: 'INR', status: 'captured' };
  assert.ok(reconcileCapturedPayment({ store, payment }).booking, 'Checkout path creates booking');
  assert.equal(reconcileCapturedPayment({ store, payment }).duplicate, true, 'later webhook returns same booking');

  const secondSeat = store.state.seats[3];
  store.createPendingPayment({ razorpayOrderId: 'order_hook_then_checkout', amountPaise: 5000, booking: { seatId: secondSeat.id, name: 'Webhook First', phone: '9876543221', minutes: 60 } });
  const laterPayment = { id: 'pay_hook_then_checkout', order_id: 'order_hook_then_checkout', amount: 5000, currency: 'INR', status: 'captured' };
  assert.ok(reconcileCapturedPayment({ store, payment: laterPayment }).booking, 'Webhook path creates booking');
  assert.equal(reconcileCapturedPayment({ store, payment: laterPayment }).duplicate, true, 'later Checkout verification returns same booking');
});
