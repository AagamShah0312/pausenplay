import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Free port to hand to the server. */
export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Boot the real server in a temp data directory so tests never touch the
 * store's live data. Returns a tiny http helper bound to that instance.
 */
export async function startServer({ webhookSecret = 'test_webhook_secret' } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pausenplay-test-'));
  const assetsDir = path.join(dataDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) {
    fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(assetsDir, f));
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      REPOSITORY_TYPE: 'json',
      PAUSENPLAY_TEST_ALLOW_UNPAID_BOOKINGS: '1',
      RAZORPAY_WEBHOOK_SECRET: webhookSecret,
      PAUSENPLAY_DATA_DIR: dataDir,
      PAUSENPLAY_ASSETS_DIR: assetsDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) break;
    } catch (err) {
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 120));
  }

  async function req(pathname, options = {}) {
    return fetch(base + pathname, options);
  }

  async function json(pathname, options = {}) {
    const res = await req(pathname, options);
    return { res, body: await res.json() };
  }

  async function stop() {
    if (!child.killed) child.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 150));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // sanity: the server must actually be up
  const probe = await fetch(`${base}/api/state`).catch(() => null);
  if (!probe || !probe.ok) {
    await stop();
    throw new Error('server did not start.\n' + log);
  }

  return { base, req, json, stop, port, dataDir, log };
}

/** Log in and return the session cookie value. */
export async function login(srv, username = 'Admin', password = 'Admin123') {
  const res = await srv.req('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const setCookie = res.headers.get('set-cookie') || '';
  return { res, body: await res.json(), cookie: setCookie.split(';')[0] };
}

/** Minimal zip reader (validates CRCs) so we can assert on the .xlsx output. */
export function readZip(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip file');
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (crc32(data) !== crc) throw new Error(`crc mismatch for ${name}`);
    entries.push({ name, data: data.toString('utf8') });
  }
  return entries;
}

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })());
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
