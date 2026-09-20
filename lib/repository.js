'use strict';

/**
 * Current persistence adapter. Store business rules deliberately depend on
 * this small synchronous interface instead of JSON files directly, so a later
 * MongoDB adapter can implement the same operations without changing callers.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require('./paths');

ensureDataDir();
const files = {
  state: path.join(DATA_DIR, 'state.json'),
  bookings: path.join(DATA_DIR, 'bookings.json'),
  payments: path.join(DATA_DIR, 'payments.json')
};

function read(file, fallback) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  } catch (err) {
    console.error(`[repository] could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

function getState(fallback) { return read(files.state, fallback); }
function getBookings(fallback = []) { return read(files.bookings, fallback); }
function getPayments(fallback = []) { return read(files.payments, fallback); }

function save({ state, bookings, payments }) {
  fs.writeFileSync(files.state, JSON.stringify(state, null, 2));
  fs.writeFileSync(files.bookings, JSON.stringify(bookings, null, 2));
  fs.writeFileSync(files.payments, JSON.stringify(payments, null, 2));
}

module.exports = { getState, getBookings, getPayments, save, DATA_DIR, ...files };
