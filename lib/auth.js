'use strict';
/**
 * PausenPlay — admin authentication
 * Default credentials: username "Admin", password "Admin123"
 * The password is stored as a salted scrypt hash in data/auth.json and both
 * the username and password can be changed from the admin dashboard.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_HOURS = 12;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_USERNAME = 'Admin';
const DEFAULT_PASSWORD = 'Admin123';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function createDefault() {
  const { salt, hash } = hashPassword(DEFAULT_PASSWORD);
  return {
    username: DEFAULT_USERNAME,
    salt,
    hash,
    usingDefault: true,
    updatedAt: Date.now()
  };
}

let auth = (() => {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      if (parsed && parsed.username && parsed.salt && parsed.hash) return parsed;
    }
  } catch (err) {
    console.error('[auth] could not read auth.json:', err.message);
  }
  const fresh = createDefault();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(fresh, null, 2));
  return fresh;
})();

function persist() {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

/* ----------------------------- sessions ---------------------------- */
const sessions = new Map(); // token -> expiry ms

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function login(username, password) {
  const userOk = String(username || '').trim().toLowerCase() === String(auth.username).toLowerCase();
  const passOk = (() => {
    try {
      const test = crypto.scryptSync(String(password || ''), auth.salt, 64).toString('hex');
      return timingSafeEqual(test, auth.hash);
    } catch (err) {
      return false;
    }
  })();
  if (!userOk || !passOk) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}

function isValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  // sliding expiry
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return true;
}

function logout(token) {
  sessions.delete(token);
}

function changeCredentials({ currentPassword, username, password, confirmPassword }) {
  const current = crypto.scryptSync(String(currentPassword || ''), auth.salt, 64).toString('hex');
  if (!timingSafeEqual(current, auth.hash)) {
    return { error: 'Current password is incorrect.' };
  }
  const newUser = String(username || '').trim();
  if (newUser.length < 3) return { error: 'Username must be at least 3 characters.' };
  if (newUser.length > 32) return { error: 'Username is too long (32 characters max).' };
  if (String(password || '').length < 6) return { error: 'New password must be at least 6 characters.' };
  if (password !== confirmPassword) return { error: 'New passwords do not match.' };

  const { salt, hash } = hashPassword(password);
  auth = { username: newUser, salt, hash, usingDefault: false, updatedAt: Date.now() };
  persist();
  // every existing session is invalidated after a credential change
  sessions.clear();
  return { username: auth.username };
}

function info() {
  return {
    username: auth.username,
    usingDefault: !!auth.usingDefault,
    updatedAt: auth.updatedAt || null
  };
}

module.exports = { login, isValid, logout, changeCredentials, info, SESSION_HOURS };
