'use strict';

/*
 * Pricing belongs on the server.  Keep the current simple rate here so later
 * station rates, offers and time-based rules have one place to be applied.
 */
const DEFAULT_HOURLY_RATE_RUPEES = 50;
const MIN_HOURLY_RATE_RUPEES = 1;
const MAX_HOURLY_RATE_RUPEES = 100000;

function validateHourlyRate(hourlyRate) {
  const rate = Number(hourlyRate);
  if (!Number.isSafeInteger(rate) || rate < MIN_HOURLY_RATE_RUPEES || rate > MAX_HOURLY_RATE_RUPEES) {
    return { error: `Hourly price must be a whole number from ₹${MIN_HOURLY_RATE_RUPEES} to ₹${MAX_HOURLY_RATE_RUPEES}.` };
  }
  return { hourlyRate: rate };
}

function getBookingPrice({ seatId, minutes, hourlyRate = DEFAULT_HOURLY_RATE_RUPEES }) {
  if (!seatId || !Number.isInteger(Number(minutes)) || Number(minutes) <= 0) {
    return { error: 'A valid station and duration are required for pricing.' };
  }
  const rate = validateHourlyRate(hourlyRate);
  if (rate.error) return rate;
  const amountPaise = rate.hourlyRate * 100 * Number(minutes) / 60;
  if (!Number.isSafeInteger(amountPaise)) return { error: 'The calculated price is not valid.' };
  return {
    currency: 'INR',
    hourlyRate: rate.hourlyRate,
    amountPaise,
    amountRupees: amountPaise / 100
  };
}

module.exports = { DEFAULT_HOURLY_RATE_RUPEES, MIN_HOURLY_RATE_RUPEES, MAX_HOURLY_RATE_RUPEES, validateHourlyRate, getBookingPrice };
