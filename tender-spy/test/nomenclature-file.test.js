import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseNomenclatureFile } from '../src/nomenclature-file.js';
import { Store } from '../src/store.js';

test('CSV с заголовком и точкой с запятой', () => {
  const csv = 'Ключевые слова;ОКПД2\nтруба предизолированная;24.20.13\nзадвижка;\n;25.99.29\n"труба, стальная";28.14.11\n';
  const parsed = parseNomenclatureFile('nomen.csv', Buffer.from(csv, 'utf8'));
  assert.equal(parsed.invalid.length, 0);
  assert.deepEqual(
    parsed.items.map((item) => [item.keyword, item.okpd2]),
    [
      ['труба предизолированная', '24.20.13'],
      ['задвижка', ''],
      ['', '25.99.29'],
      ['труба, стальная', '28.14.11'],
    ],
  );
});

test('TXT без заголовка и Windows-1251', () => {
  const line = Buffer.from([0xf2, 0xf0, 0xf3, 0xe1, 0xe0]); // труба
  const buf = Buffer.concat([line, Buffer.from('\n24.20.13\n')]);
  const parsed = parseNomenclatureFile('list.txt', buf);
  assert.equal(parsed.items[0].keyword, 'труба');
  assert.equal(parsed.items[1].okpd2, '24.20.13');
  assert.equal(parsed.items[1].keyword, '');
});

test('некорректный ОКПД2 попадает в отчёт, а не в список', () => {
  const parsed = parseNomenclatureFile('bad.csv', Buffer.from('насос;абв\nкран;28.14\n', 'utf8'));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].keyword, 'кран');
  assert.equal(parsed.invalid.length, 1);
  assert.match(parsed.invalid[0].reason, /ОКПД2/);
});

test('JSON-массив и объект nomenclature', () => {
  const asArray = parseNomenclatureFile('a.json', Buffer.from('["котел","24.20.13"]', 'utf8'));
  assert.equal(asArray.items[0].keyword, 'котел');
  assert.equal(asArray.items[1].okpd2, '24.20.13');
  const asObject = parseNomenclatureFile(
    'b.json',
    Buffer.from(JSON.stringify({ nomenclature: [{ наименование: 'фланец', ОКПД2: '24.20.40' }] }), 'utf8'),
  );
  assert.deepEqual(asObject.items[0], { keyword: 'фланец', okpd2: '24.20.40' });
});

test('Excel xlsx читает первый лист', () => {
  const shared = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="3" uniqueCount="3">
  <si><t>Ключевые слова</t></si>
  <si><t>ОКПД2</t></si>
  <si><t>труба предизолированная</t></si>
</sst>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>24.20.13</t></is></c></row>
  </sheetData>
</worksheet>`;
  const parsed = parseNomenclatureFile('book.xlsx', xlsxZip({ shared, sheet, deflate: true }));
  assert.equal(parsed.invalid.length, 0);
  assert.deepEqual(parsed.items, [{ keyword: 'труба предизолированная', okpd2: '24.20.13' }]);
});

test('старый .xls отклоняется с понятной ошибкой', () => {
  assert.throws(() => parseNomenclatureFile('book.xls', Buffer.from('not-excel')), /xlsx или CSV/);
});

test('импорт файла заменяет только номенклатуру', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nomen-')), 'db.json');
  const store = new Store(file);
  store.addNomenclature({ keyword: 'старая', okpd2: '' });
  store.importCompanies([{ inn: '6679104561', name: 'Старк', role: 'any' }]);
  const result = store.importNomenclature(
    [
      { keyword: 'труба', okpd2: '24.20.13' },
      { keyword: 'труба', okpd2: '24.20.13' },
    ],
    { replace: true },
  );
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(store.nomenclature.length, 1);
  assert.equal(store.nomenclature[0].keyword, 'труба');
  assert.equal(store.companies.length, 1);
});

function xlsxZip({ shared, sheet, deflate }) {
  const files = [
    ['xl/sharedStrings.xml', Buffer.from(shared)],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ];
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, raw] of files) {
    const nameBuf = Buffer.from(name);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}
