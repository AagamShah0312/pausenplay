'use strict';

/*
 * Pricing belongs on the server.  Keep the current simple rate here so later
 * station rates, offers and time-based rules have one place to be applied.
 */
const BASE_RATE_PAISE_PER_HOUR = 5000;

function getBookingPrice({ seatId, minutes }) {
  if (!seatId || !Number.isInteger(Number(minutes)) || Number(minutes) <= 0) {
    return { error: 'A valid station and duration are required for pricing.' };
  }
  return {
    currency: 'INR',
    amountPaise: (BASE_RATE_PAISE_PER_HOUR * Number(minutes)) / 60
  };
}

module.exports = { BASE_RATE_PAISE_PER_HOUR, getBookingPrice };
