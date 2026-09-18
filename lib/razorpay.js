'use strict';

const Razorpay = require('razorpay');

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
const isConfigured = Boolean(keyId && keySecret);
const client = isConfigured ? new Razorpay({ key_id: keyId, key_secret: keySecret }) : null;

module.exports = { client, keyId, keySecret, webhookSecret, isConfigured };
