/**
 * Разбор файла с номенклатурой: CSV/TXT, JSON и Excel (.xlsx).
 * Позиция — ключевые слова и/или код ОКПД2, как в форме «Наблюдение».
 */
import zlib from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

export const OKPD2_RE = /^\d{2}(\.\d{1,3})*$/;
const MAX_POSITIONS = 1000;
const MAX_KEYWORD = 120;

const KEYWORD_HEADERS = new Set([
  'ключевыеслова',
  'ключевоеслово',
  'ключевое',
  'номенклатура',
  'наименование',
  'название',
  'поиск',
  'keyword',
  'keywords',
  'searchstring',
  'фраза',
  'слова',
  'позиция',
  'товар',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'row' || name === 'c' || name === 'si' || name === 'r' || name === 't',
});

export function isOkpd2(value) {
  return OKPD2_RE.test(String(value ?? '').trim());
}

function normHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\s._\-«»"'`]/g, '');
}

function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1251').decode(body);
  }
}

function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 8).join('\n');
  const counts = {
    ';': (sample.match(/;/g) || []).length,
    '\t': (sample.match(/\t/g) || []).length,
    ',': (sample.match(/,/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ';';
}

/** CSV с кавычками. Возвращает непустые строки. */
export function parseDelimited(text, delimiter = sniffDelimiter(text)) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows
    .map((cells) => cells.map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean));
}

function headerMap(row) {
  let keyword = -1;
  let okpd = -1;
  row.forEach((cell, index) => {
    const header = normHeader(cell);
    if (!header) return;
    if (header.includes('окпд') || header.includes('okpd') || header === 'код' || header === 'code') okpd = index;
    else if (KEYWORD_HEADERS.has(header)) keyword = index;
  });
  if (keyword === -1 && okpd === -1) return null;
  if (keyword === -1) keyword = row.findIndex((_, index) => index !== okpd);
  return { keyword, okpd };
}

function pushPosition(items, invalid, { line, keyword, okpd2 }) {
  const kw = String(keyword ?? '').trim();
  const code = String(okpd2 ?? '').trim();
  if (!kw && !code) return;
  if (kw.length > MAX_KEYWORD) {
    invalid.push({ line, reason: `слишком длинная фраза (больше ${MAX_KEYWORD} символов)` });
    return;
  }
  if (code && !isOkpd2(code)) {
    invalid.push({ line, reason: `ОКПД2 «${code}» не похож на код вроде 24.20.13` });
    return;
  }
  items.push({ keyword: kw, okpd2: code });
}

function positionsFromTable(rows) {
  const items = [];
  const invalid = [];
  if (!rows.length) return { items, invalid };
  const map = headerMap(rows[0]);
  const data = map ? rows.slice(1) : rows;
  const lineOffset = map ? 2 : 1;
  data.forEach((cells, index) => {
    const line = index + lineOffset;
    let keyword = '';
    let okpd2 = '';
    if (map) {
      keyword = map.keyword >= 0 ? cells[map.keyword] ?? '' : '';
      okpd2 = map.okpd >= 0 ? cells[map.okpd] ?? '' : '';
    } else if (cells.filter(Boolean).length <= 1) {
      const value = cells.find(Boolean) || '';
      if (isOkpd2(value)) okpd2 = value;
      else keyword = value;
    } else {
      const left = cells[0] ?? '';
      const right = cells[1] ?? '';
      if (isOkpd2(left) && right && !isOkpd2(right)) {
        okpd2 = left;
        keyword = right;
      } else {
        keyword = left;
        okpd2 = right;
      }
    }
    pushPosition(items, invalid, { line, keyword, okpd2 });
  });
  return { items, invalid };
}

function positionsFromJson(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Невалидный JSON');
  }
  const list = Array.isArray(data) ? data : data?.nomenclature || data?.items || data?.positions;
  if (!Array.isArray(list)) {
    throw new Error('JSON должен быть массивом позиций или объектом с полем nomenclature');
  }
  const items = [];
  const invalid = [];
  list.forEach((raw, index) => {
    const line = index + 1;
    if (typeof raw === 'string') {
      if (isOkpd2(raw)) pushPosition(items, invalid, { line, keyword: '', okpd2: raw });
      else pushPosition(items, invalid, { line, keyword: raw, okpd2: '' });
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    const keyword = raw.keyword ?? raw.name ?? raw['ключевые слова'] ?? raw['наименование'] ?? raw['номенклатура'] ?? '';
    const okpd2 = raw.okpd2 ?? raw.okpd ?? raw['ОКПД2'] ?? raw['окпд2'] ?? raw['окпд'] ?? '';
    pushPosition(items, invalid, { line, keyword: String(keyword), okpd2: String(okpd2) });
  });
  return { items, invalid };
}

function unzip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Файл не похож на книгу Excel');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;
    if (localOff + 30 > buf.length) continue;
    const nameLenLocal = buf.readUInt16LE(localOff + 26);
    const extraLenLocal = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + nameLenLocal + extraLenLocal;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    let data = null;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    if (data) files.set(name.replaceAll('\\', '/'), data);
  }
  if (!files.size) throw new Error('Файл не похож на книгу Excel');
  return files;
}

function textNodes(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textNodes).join('');
  if (typeof node === 'object') {
    if (node.t != null) return textNodes(node.t);
    if (node.r != null) return textNodes(node.r);
  }
  return '';
}

function sharedStrings(xml) {
  if (!xml) return [];
  const doc = xmlParser.parse(xml.toString('utf8'));
  const list = doc?.sst?.si ?? [];
  return (Array.isArray(list) ? list : [list]).map((si) => textNodes(si));
}

function columnIndex(ref) {
  const letters = String(ref ?? '').replace(/\d/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

function rowsFromXlsx(buffer) {
  const files = unzip(buffer);
  const sheetName = [...files.keys()]
    .filter((name) => /xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort()[0];
  if (!sheetName) throw new Error('В книге Excel нет листов');
  const strings = sharedStrings(files.get('xl/sharedStrings.xml'));
  const doc = xmlParser.parse(files.get(sheetName).toString('utf8'));
  const rows = doc?.worksheet?.sheetData?.row ?? [];
  return (Array.isArray(rows) ? rows : [rows]).map((row) => {
    const cells = Array.isArray(row.c) ? row.c : row.c ? [row.c] : [];
    const values = [];
    for (const cell of cells) {
      const index = columnIndex(cell['@_r']);
      let value = '';
      if (cell['@_t'] === 's') value = strings[Number(cell.v)] ?? '';
      else if (cell['@_t'] === 'inlineStr') value = textNodes(cell.is);
      else if (cell.v != null) value = String(cell.v);
      values[index] = value.trim();
    }
    return values.map((value) => value ?? '');
  }).filter((cells) => cells.some(Boolean));
}

/**
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {{ items: {keyword: string, okpd2: string}[], invalid: {line: number, reason: string}[] }}
 */
export function parseNomenclatureFile(filename, buffer) {
  const name = String(filename || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  if (ext === '.xls') {
    throw new Error('Формат .xls не поддерживается. Сохраните книгу как .xlsx или CSV');
  }
  let parsed;
  if (ext === '.xlsx') parsed = positionsFromTable(rowsFromXlsx(buffer));
  else {
    const text = decodeText(buffer).trim();
    if (!text) throw new Error('Файл пустой');
    if (ext === '.json' || text.startsWith('{') || text.startsWith('[')) parsed = positionsFromJson(text);
    else parsed = positionsFromTable(parseDelimited(text));
  }
  if (parsed.items.length + parsed.invalid.length > MAX_POSITIONS) {
    throw new Error(`В файле больше ${MAX_POSITIONS} позиций. Разбейте его на части`);
  }
  if (!parsed.items.length && !parsed.invalid.length) {
    throw new Error('В файле нет позиций номенклатуры');
  }
  return parsed;
}
