'use strict';

const crypto = require('crypto');

function verifyRazorpaySignature({ orderId, paymentId, signature, keySecret }) {
  if (![orderId, paymentId, signature, keySecret].every(value => typeof value === 'string' && value)) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  const received = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

function verifyRazorpayWebhookSignature({ rawBody, signature, webhookSecret }) {
  if (!Buffer.isBuffer(rawBody) || !signature || typeof webhookSecret !== 'string' || !webhookSecret) return false;
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const received = Buffer.from(String(signature), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return received.length === expectedBuffer.length && crypto.timingSafeEqual(received, expectedBuffer);
}

/** Shared by Checkout verification and authenticated webhook delivery. */
function reconcileCapturedPayment({ store, payment }) {
  if (!payment || typeof payment !== 'object') return { error: 'Payment details are invalid.' };
  if (typeof payment.id !== 'string' || typeof payment.order_id !== 'string' ||
      !Number.isSafeInteger(payment.amount) || typeof payment.currency !== 'string') {
    return { error: 'Payment details are incomplete.' };
  }
  if (!['authorized', 'captured'].includes(payment.status)) return { error: 'Payment has not been captured.' };
  return store.finalizePaidBooking({
    razorpayOrderId: payment.order_id,
    razorpayPaymentId: payment.id,
    amountPaise: payment.amount,
    currency: payment.currency
  });
}

module.exports = { verifyRazorpaySignature, verifyRazorpayWebhookSignature, reconcileCapturedPayment };
