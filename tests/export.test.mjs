import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, login, readZip } from './helpers.mjs';

describe('excel / csv export', () => {
  let srv, cookie;
  before(async () => {
    srv = await startServer();
    cookie = (await login(srv)).cookie;
    const { body: state } = await srv.json('/api/state');
    await srv.json('/api/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatId: state.seats[0].id, name: 'Export Tester', phone: '9876500000', minutes: 90 })
    });
    const b = (await (await srv.req('/api/state')).json()).seats[0].booking;
    await srv.json('/api/admin/adjust', {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ bookingId: b.id, deltaMinutes: 15 })
    });
  });
  after(async () => { await srv.stop(); });

  test('xlsx is a valid zip with both worksheets', async () => {
    const res = await srv.req('/api/export.xlsx', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /spreadsheetml/);
    assert.match(res.headers.get('content-disposition'), /attachment; filename=".*\.xlsx"/);

    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 1000);
    const entries = readZip(buf);
    const names = entries.map(e => e.name);
    ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].forEach(n =>
        assert.ok(names.includes(n), 'missing zip entry ' + n));

    const sheet1 = entries.find(e => e.name === 'xl/worksheets/sheet1.xml').data;
    assert.ok(sheet1.includes('Customer Name'), 'header row missing');
    assert.ok(sheet1.includes('Export Tester'), 'booking row missing');
    assert.ok(sheet1.includes('9876500000'), 'phone missing');
    assert.ok(sheet1.includes('105'), 'extended duration (90 + 15) missing');
    assert.ok(sheet1.includes('Running'), 'status missing');
    // every part must be well formed xml
    for (const e of entries.filter(x => x.name.endsWith('.xml') || x.name.endsWith('.rels'))) {
      assert.ok(e.data.startsWith('<?xml'), e.name + ' is not xml');
      assert.ok(e.data.trim().endsWith('>'), e.name + ' looks truncated');
      assert.ok(!/&(?!amp;|lt;|gt;|quot;|#)/.test(e.data.replace(/&#\d+;/g, '')), e.name + ' has an unescaped &');
    }
    const workbook = entries.find(e => e.name === 'xl/workbook.xml').data;
    assert.ok(workbook.includes('Bookings'), 'first sheet is not named Bookings');
    assert.ok(workbook.includes('Station summary'), 'summary sheet missing');
    const sheet2 = entries.find(e => e.name === 'xl/worksheets/sheet2.xml').data;
    assert.ok(sheet2.includes('Total Sessions'), 'summary headers missing');
    assert.ok(sheet2.includes('TOTAL'), 'summary totals missing');
  });

  test('worksheet parts list their elements in the order Excel demands', async () => {
    const res = await srv.req('/api/export.xlsx', { headers: { cookie } });
    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    const sheets = entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
    assert.ok(sheets.length >= 2, 'expected both worksheets');

    // ECMA-376 CT_Worksheet sequence (a wrong order makes Excel repair the file)
    const ORDER = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData',
      'sheetCalcPr', 'sheetProtection', 'autoFilter', 'mergeCells'];
    for (const sheet of sheets) {
      const found = [...sheet.data.matchAll(/<([a-zA-Z]+)[\s/>]/g)]
        .map(m => m[1])
        .filter(tag => ORDER.includes(tag) && tag !== 'col');
      const ranks = found.map(tag => ORDER.indexOf(tag));
      const sorted = ranks.slice().sort((a, b) => a - b);
      assert.deepEqual(ranks, sorted, `${sheet.name} elements out of order: ${found.join(' > ')}`);
      assert.ok(sheet.data.includes('<sheetData>'), sheet.name + ' has no sheetData');
      assert.ok(sheet.data.trim().endsWith('</worksheet>'), sheet.name + ' is not closed');
    }
  });

  test('zip entries carry a usable timestamp', async () => {
    const res = await srv.req('/api/export.xlsx', { headers: { cookie } });
    const buf = Buffer.from(await res.arrayBuffer());
    // walk the local file headers and decode every DOS date field
    let p = 0;
    let seen = 0;
    while (buf.readUInt32LE(p) === 0x04034b50) {
      const dosDate = buf.readUInt16LE(p + 12);
      const month = (dosDate >> 5) & 0x0f;
      const day = dosDate & 0x1f;
      const year = 1980 + (dosDate >> 9);
      assert.ok(month >= 1 && month <= 12, `entry ${seen} has an impossible month ${month}`);
      assert.ok(day >= 1 && day <= 31, `entry ${seen} has an impossible day ${day}`);
      assert.ok(year >= 2020 && year <= 2100, `entry ${seen} has a silly year ${year}`);
      const nameLen = buf.readUInt16LE(p + 26);
      const extraLen = buf.readUInt16LE(p + 28);
      const compSize = buf.readUInt32LE(p + 18);
      p += 30 + nameLen + extraLen + compSize;
      seen++;
    }
    assert.ok(seen >= 7, 'expected every part to be checked, saw ' + seen);
  });

  test('the workbook opens as a spreadsheet package', async () => {
    const res = await srv.req('/api/export.xlsx', { headers: { cookie } });
    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    const types = entries.find(e => e.name === '[Content_Types].xml').data;
    assert.match(types, /spreadsheetml\.sheet\.main\+xml/, 'workbook content type missing');
    const rels = entries.find(e => e.name === '_rels/.rels').data;
    assert.match(rels, /officeDocument/, 'root relationship missing');
    const wbRels = entries.find(e => e.name === 'xl/_rels/workbook.xml.rels').data;
    assert.match(wbRels, /styles\.xml/, 'styles relationship missing');
    const styles = entries.find(e => e.name === 'xl/styles.xml').data;
    assert.match(styles, /<cellStyles /, 'no default cell style — Excel complains');
  });

  test('csv export holds the same records', async () => {
    const res = await srv.req('/api/export.csv', { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const text = await res.text();
    const lines = text.trim().split(/\r?\n/);
    assert.ok(lines.length >= 2, 'expected a header plus at least one row');
    assert.ok(lines[0].includes('Customer Name'));
    assert.ok(text.includes('Export Tester'));
    assert.equal((lines[1].match(/,/g) || []).length, (lines[0].match(/,/g) || []).length, 'row/column mismatch');
  });

  test('exports are not available without a session', async () => {
    assert.equal((await srv.req('/api/export.xlsx')).status, 401);
    assert.equal((await srv.req('/api/export.csv')).status, 401);
  });
});
