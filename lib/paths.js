'use strict';
/**
 * Shared paths. PAUSENPLAY_DATA_DIR lets tests (or a deployment) keep the live
 * booking data somewhere else — e.g. a persistent disk.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.resolve(process.env.PAUSENPLAY_DATA_DIR || path.join(ROOT, 'data'));
const ASSETS_DIR = path.resolve(process.env.PAUSENPLAY_ASSETS_DIR || path.join(ROOT, 'assets'));

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

module.exports = { ROOT, DATA_DIR, ASSETS_DIR, ensureDataDir };
