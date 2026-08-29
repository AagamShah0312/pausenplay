#!/usr/bin/env node
/**
 * PausenPlay build check.
 * There is nothing to bundle (plain ES5-ish front-end + a zero-dependency Node
 * server), so the build verifies that every file the app needs is present,
 * that all JavaScript parses, and that the data/config files are valid.
 *
 *   npm run build
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
let checks = 0;

function check(label, fn) {
  checks++;
  try {
    const detail = fn();
    console.log(`  ✓ ${label}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${label}\n      ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\nPausenPlay build\n');

/* ------------------------------ runtime ------------------------------ */
check('Node version >= 18', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert(major >= 18, `found Node ${process.versions.node}`);
  return process.versions.node;
});

/* ------------------------- required files ---------------------------- */
const REQUIRED = [
  'server.js',
  'package.json',
  'lib/paths.js',
  'lib/store.js',
  'lib/auth.js',
  'lib/xlsx.js',
  'public/index.html',
  'public/admin.html',
  'public/css/booking.css',
  'public/css/admin.css',
  'public/js/booking.js',
  'public/js/admin.js',
  'assets/store-layout.svg'
];

check('all required files exist', () => {
  const missing = REQUIRED.filter(f => !fs.existsSync(path.join(ROOT, f)));
  assert(missing.length === 0, 'missing: ' + missing.join(', '));
  return REQUIRED.length + ' files';
});

/* --------------------------- syntax check ---------------------------- */
check('every JavaScript file parses', () => {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
    }
  })(ROOT);
  for (const f of files) {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }
  return files.length + ' files';
});

/* ------------------------------ JSON -------------------------------- */
check('package.json is valid and wired up', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(pkg.main === 'server.js', 'main should be server.js');
  ['start', 'build', 'test'].forEach(s => assert(pkg.scripts && pkg.scripts[s], `missing npm script "${s}"`));
  return `scripts: ${Object.keys(pkg.scripts).join(', ')}`;
});

/* --------------------------- html sanity ----------------------------- */
check('customer page contains the booking section', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ['id="book"', 'id="storeMap"', 'id="bookForm"', 'js/booking.js', 'css/booking.css', 'id="mySession"',
    'id="whenToggle"', 'id="startDate"', 'id="startTime"', 'id="msLabel"']
    .forEach(token => assert(html.includes(token), `missing ${token}`));
  return 'booking section wired';
});

check('admin page contains the console markup', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8');
  ['id="loginForm"', 'id="adminMap"', 'id="activeBody"', 'id="upcomingBody"', 'id="historyBody"',
    'id="exportXlsx"', 'id="credForm"', 'id="layoutEditor"', 'js/admin.js', 'css/admin.css']
    .forEach(token => assert(html.includes(token), `missing ${token}`));
  return 'admin console wired';
});

check('front-end references only files that exist', () => {
  const seen = new Set();
  for (const file of ['public/index.html', 'public/admin.html']) {
    const dir = path.join(ROOT, path.dirname(file));
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      // skip remote urls, in-page anchors, mailto/tel links and server routes (/admin)
      if (/^(https?:|data:|#|mailto:|tel:|\/)/.test(ref)) continue;
      const rel = path.relative(ROOT, path.join(dir, ref)).replace(/\\/g, '/');
      // the server also falls back to the repo root (e.g. "assets/..." served from /assets)
      const alt = path.relative(ROOT, path.join(ROOT, ref)).replace(/\\/g, '/');
      seen.add(fs.existsSync(path.join(ROOT, rel)) ? rel : alt);
    }
  }
  const missing = [...seen].filter(r => !r || !fs.existsSync(path.join(ROOT, r)));
  assert(missing.length === 0, 'missing: ' + missing.join(', '));
  return [...seen].sort().join(', ');
});

/* --------------------------- server boots ---------------------------- */
check('server boots and serves the floor plan', () => {
  const { DATA_DIR, ensureDataDir } = require(path.join(ROOT, 'lib/paths.js'));
  ensureDataDir();
  const store = require(path.join(ROOT, 'lib/store.js'));
  assert(store.state.seats.length > 0, 'state has no stations');
  assert(fs.existsSync(path.join(ROOT, store.state.layout.image)), 'floor-plan image missing: ' + store.state.layout.image);
  const ids = new Set();
  store.state.seats.forEach(s => {
    assert(s.id && !ids.has(s.id), 'duplicate/empty station id: ' + s.id);
    ids.add(s.id);
    ['x', 'y', 'w', 'h'].forEach(k => assert(Number.isFinite(Number(s[k])), `station ${s.id} has a bad ${k}`));
    assert(Number(s.x) >= 0 && Number(s.x) + Number(s.w) <= 100.001, `station ${s.id} is off the map horizontally`);
    assert(Number(s.y) >= 0 && Number(s.y) + Number(s.h) <= 100.001, `station ${s.id} is off the map vertically`);
  });
  return `${store.state.seats.length} stations, image ${store.state.layout.image}`;
});

/* --------------------------- xlsx writer ----------------------------- */
check('xlsx writer produces a readable workbook', () => {
  const xlsx = require(path.join(ROOT, 'lib/xlsx.js'));
  const buf = xlsx.build([{ name: 'Sheet1', rows: [['A', 'B'], ['hello', 42]] }]);
  assert(buf.slice(0, 2).toString() === 'PK', 'not a zip container');
  const csv = xlsx.buildCsv([['Name', 'Minutes'], ['Rahul', 60]]);
  assert(csv.includes('Name,Minutes'), 'csv header missing');
  return buf.length + ' byte workbook';
});

/* --------------------- scheduled booking store --------------------- */
check('store can resolve a wall-clock slot in the store timezone', () => {
  process.env.PAUSENPLAY_DATA_DIR = process.env.PAUSENPLAY_DATA_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'pausenplay-build-'));
  const store = require(path.join(ROOT, 'lib/store.js'));
  const ms = store.zonedTimeToMs('2026-01-15', '18:30', store.TZ);
  assert(Number.isFinite(ms), 'wall clock did not resolve');
  const back = new Intl.DateTimeFormat('en-GB', {
    timeZone: store.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(ms));
  assert(/15\/01\/2026/.test(back) && /18:30/.test(back), 'round trip lost the wall clock: ' + back);
  assert(store.zonedTimeToMs('2026-13-45', '18:30', store.TZ) === null, 'impossible date accepted');
  assert(store.zonedTimeToMs('nope', '18:30', store.TZ) === null, 'garbage date accepted');
  return store.TZ + ' wall clock round trips';
});

console.log('');
if (failures) {
  console.error(`BUILD FAILED — ${failures} of ${checks} checks failed\n`);
  process.exit(1);
}
console.log(`BUILD OK — ${checks} checks passed\n`);
