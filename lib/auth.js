'use strict';
/** Admin credentials remain salted scrypt hashes; MongoDB stores them in production. */

const crypto = require('crypto');
const { getAuthStorage } = require('./auth-storage');

const SESSION_HOURS = 12;
const DEFAULT_USERNAME = 'Admin';
const DEFAULT_PASSWORD = 'Admin123';
let storage;
let auth;
let initialized = false;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function createDefault() {
  const { salt, hash } = hashPassword(DEFAULT_PASSWORD);
  return { username: DEFAULT_USERNAME, salt, hash, usingDefault: true, updatedAt: Date.now() };
}

async function initialize() {
  storage = getAuthStorage();
  auth = await storage.initialize(createDefault());
  if (!auth || !auth.username || !auth.salt || !auth.hash) throw new Error('Auth record is invalid.');
  initialized = true;
}

function requireInitialized() {
  if (!initialized) throw new Error('Authentication has not been initialized.');
}

const sessions = new Map();
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function login(username, password) {
  requireInitialized();
  const userOk = String(username || '').trim().toLowerCase() === String(auth.username).toLowerCase();
  let passOk = false;
  try { passOk = timingSafeEqual(crypto.scryptSync(String(password || ''), auth.salt, 64).toString('hex'), auth.hash); } catch (err) { /* invalid input */ }
  if (!userOk || !passOk) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return token;
}

function isValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  sessions.set(token, Date.now() + SESSION_HOURS * 3600 * 1000);
  return true;
}

function logout(token) { sessions.delete(token); }

async function changeCredentials({ currentPassword, username, password, confirmPassword }) {
  requireInitialized();
  const current = crypto.scryptSync(String(currentPassword || ''), auth.salt, 64).toString('hex');
  if (!timingSafeEqual(current, auth.hash)) return { error: 'Current password is incorrect.' };
  const newUser = String(username || '').trim();
  if (newUser.length < 3) return { error: 'Username must be at least 3 characters.' };
  if (newUser.length > 32) return { error: 'Username is too long (32 characters max).' };
  if (String(password || '').length < 6) return { error: 'New password must be at least 6 characters.' };
  if (password !== confirmPassword) return { error: 'New passwords do not match.' };
  const { salt, hash } = hashPassword(password);
  auth = { username: newUser, salt, hash, usingDefault: false, updatedAt: Date.now() };
  await storage.save(auth);
  sessions.clear();
  return { username: auth.username };
}

function info() {
  requireInitialized();
  return { username: auth.username, usingDefault: !!auth.usingDefault, updatedAt: auth.updatedAt || null };
}

module.exports = { initialize, login, isValid, logout, changeCredentials, info, SESSION_HOURS };
