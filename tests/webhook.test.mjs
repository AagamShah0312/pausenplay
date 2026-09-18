import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from './helpers.mjs';

const secret = 'webhook_test_secret';
const sign = body => crypto.createHmac('sha256', secret).update(body).digest('hex');
const event = (name, payment) => JSON.stringify({ event: name, payload: { payment: { entity: payment } } });

describe('Razorpay webhook reconciliation', () => {
  let srv, seatIndex = 0;
  before(async () => { srv = await startServer({ webhookSecret: secret }); });
  after(async () => { await srv.stop(); });

  async function pending(orderId, amount = 5000) {
    const { body: state } = await srv.json('/api/state');
    const seat = state.seats[seatIndex++];
    const { res, body } = await srv.json('/api/payment/test-pending', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ razorpayOrderId: orderId, amountPaise: amount, booking: { seatId: seat.id, name: 'Webhook Player', phone: '9876543210', minutes: 60 } })
    });
    assert.equal(res.status, 200, body.error);
    return seat;
  }

  async function post(raw, signature = sign(raw)) {
    const res = await srv.req('/api/payment/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature }, body: raw });
    return { res, body: await res.json() };
  }

  test('valid raw-body signature is accepted and modified bodies are rejected', async () => {
    const raw = event('order.paid', {});
    assert.equal((await post(raw)).res.status, 200);
    assert.equal((await post(raw + ' ', sign(raw))).res.status, 400);
    assert.equal((await post(raw, 'bad')).res.status, 400);
  });

  test('payment.captured creates exactly one booking and duplicate deliveries are safe', async () => {
    const orderId = 'order_webhook_1';
    const seat = await pending(orderId);
    const raw = event('payment.captured', { id: 'pay_webhook_1', order_id: orderId, amount: 5000, currency: 'INR', status: 'captured' });
    assert.equal((await post(raw)).res.status, 200);
    assert.equal((await post(raw)).res.status, 200);
    const { body } = await srv.json('/api/state');
    assert.equal(body.seats.find(s => s.id === seat.id).status, 'busy');
  });

  test('failed, wrong-amount and unsupported events do not create bookings', async () => {
    const failedOrder = 'order_webhook_failed';
    const failedSeat = await pending(failedOrder);
    assert.equal((await post(event('payment.failed', { id: 'pay_failed', order_id: failedOrder }))).res.status, 200);
    const wrongOrder = 'order_webhook_wrong';
    const wrongSeat = await pending(wrongOrder);
    assert.equal((await post(event('payment.captured', { id: 'pay_wrong', order_id: wrongOrder, amount: 1, currency: 'INR', status: 'captured' }))).res.status, 409);
    assert.equal((await post(event('subscription.created', {}))).res.status, 200);
    const { body } = await srv.json('/api/state');
    assert.equal(body.seats.find(s => s.id === failedSeat.id).status, 'free');
    assert.equal(body.seats.find(s => s.id === wrongSeat.id).status, 'free');
  });
});
