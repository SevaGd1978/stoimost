import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  documentsUrlFromCard,
  fileNameFromDisposition,
  guessDocumentsUrl,
  parseDocumentLinks,
  printFormUrl,
} from '../src/documents/eis-documents.js';
import { classify } from '../src/documents/convert.js';
import { DocumentService, eisCardUrl } from '../src/documents/service.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/eis-documents/${name}`, import.meta.url), 'utf8');

test('parseDocumentLinks: файлы вкладки «Документы» 44-ФЗ', () => {
  const links = parseDocumentLinks(fixture('44-ea20-0818200000226000145.html'));
  assert.deepEqual(
    links.map((l) => l.name),
    [
      'Обоснование НЦЕтру 5920.xlsx',
      'Проект контракта 5920.docx',
      'Описание объекта закупки 5920.xlsx',
      'Требование к содержанию, составу заявки на участие в закупке и инструкция по ее заполнению.docx',
    ],
  );
  assert.equal(links[1].url, 'https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=01A0C7E35E117E3893D91FC762541FDB');
});

test('parseDocumentLinks: 223-ФЗ — имя из data-tooltip с HTML внутри', () => {
  const links = parseDocumentLinks(fixture('223-32616404967.html'));
  assert.deepEqual(
    links.map((l) => [l.name, l.uid]),
    [
      ['ОЗЦОУ-19 ВФ.zip', '2710B90682BD487E911CEDF4E4BFD00E'],
      ['текст разъяснения.doc', '68B5410EAC4B4A2D8B6FE5E0886084CC'],
    ],
  );
});

test('parseDocumentLinks: недействующая редакция пропускается, дубли склеиваются', () => {
  const html = `
    <div>Редакция</div><div>Недействующая</div>
    <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=OLD1" title="Старое ТЗ.docx">Старое ТЗ.docx</a>
    <div>Редакция</div><div>Действующая</div>
    <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=NEW1" title="ТЗ.docx">ТЗ.docx</a>
    <a href="https://zakupki.gov.ru/44fz/filestore/public/1.0/download/priz/file.html?uid=new1">ТЗ.docx</a>`;
  assert.deepEqual(parseDocumentLinks(html).map((l) => l.name), ['ТЗ.docx']);
});

test('адреса вкладки «Документы» и печатной формы', () => {
  assert.equal(
    guessDocumentsUrl('https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0818200000226000145'),
    'https://zakupki.gov.ru/epz/order/notice/ea20/view/documents.html?regNumber=0818200000226000145',
  );
  assert.equal(guessDocumentsUrl('https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616404967'), null);
  const card = fixture('223-card-tabs.html');
  assert.equal(
    documentsUrlFromCard(card, 'https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616404967'),
    'https://zakupki.gov.ru/epz/order/notice/notice223/documents.html?purchaseNoticeNumber=32616404967&noticeGuid=a9898519-3943-0004-0000-6ab4cd8254c3',
  );
  assert.match(printFormUrl(fixture('44-ea20-0818200000226000145.html'), 'https://zakupki.gov.ru/'), /printForm\/view\.html\?regNumber=0818200000226000145$/);
  assert.match(printFormUrl(card, 'https://zakupki.gov.ru/'), /notice223\/printForm\/view\.html\?purchaseNoticeGuid=[^&]+&purchaseNoticeNumber=32616404967$/);
});

test('fileNameFromDisposition: UTF-8, прочитанный как latin1, и filename*', () => {
  const raw = Buffer.from('Проект контракта.docx', 'utf8').toString('latin1');
  assert.equal(fileNameFromDisposition(`attachment; filename="${raw}"`), 'Проект контракта.docx');
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%D0%A2%D0%97.pdf"), 'ТЗ.pdf');
  assert.equal(fileNameFromDisposition(null), null);
});

test('classify: тип по сигнатуре важнее расширения', () => {
  assert.deepEqual(classify('разъяснение.doc', Buffer.from('<!DOCTYPE html><html>')), { kind: 'office', ext: 'html' });
  assert.equal(classify('скан.docx', Buffer.from('%PDF-1.7')).kind, 'pdf');
  assert.equal(classify('ТЗ.docx', Buffer.from('PK\x03\x04')).kind, 'office');
  assert.equal(classify('Документация', Buffer.from('PK\x03\x04')).kind, 'archive');
  assert.equal(classify('Проект.ZIP', Buffer.from('PK\x03\x04')).kind, 'archive');
  assert.equal(classify('архив.rar', Buffer.from('Rar!\x1a\x07')).ext, 'rar');
  assert.equal(classify('ТЗ.docx.sig', Buffer.from('0\x82')).kind, 'signature');
  assert.deepEqual(classify('Спецификация.XLSX', Buffer.from('PK\x03\x04')), { kind: 'office', ext: 'xlsx', spreadsheet: true });
  assert.equal(classify('чертёж.dwg', Buffer.from('AC1027')).kind, 'unsupported');
});

async function pdfWithPages(n) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-docs-'));
}

async function waitDone(svc, id) {
  for (let i = 0; i < 200 && svc.jobs.has(id); i++) await new Promise((r) => setTimeout(r, 10));
  return svc.get(id);
}

test('DocumentService: 223-ФЗ — карточка → документы → архив → один PDF с содержанием и закладками', async () => {
  const card = 'https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616404967';
  const zipBytes = Buffer.from('PK\x03\x04fake');
  const pdf3 = await pdfWithPages(3);
  const pages = {
    [card]: fixture('223-card-tabs.html'),
    'https://zakupki.gov.ru/epz/order/notice/notice223/documents.html?purchaseNoticeNumber=32616404967&noticeGuid=a9898519-3943-0004-0000-6ab4cd8254c3':
      fixture('223-32616404967.html'),
  };
  const files = { '2710B90682BD487E911CEDF4E4BFD00E': zipBytes, '68B5410EAC4B4A2D8B6FE5E0886084CC': Buffer.from('<html><body>Ответ</body></html>') };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (pages[url]) return { ok: true, status: 200, headers: {}, text: async () => pages[url] };
    const uid = url.match(/uid=(\w+)/)?.[1];
    if (files[uid]) return { ok: true, status: 200, headers: {}, buffer: async () => files[uid] };
    return { ok: false, status: 500, headers: {} };
  };
  const converted = [];
  const convert = {
    tools: () => ({ soffice: 'stub', unar: true, unzip: true }),
    async officeToPdf(file, outDir, { ext }) {
      converted.push(ext);
      const out = path.join(outDir, `conv-${converted.length}.pdf`);
      fs.writeFileSync(out, await pdfWithPages(ext === 'xlsx' ? 10 : 2));
      return out;
    },
    async extractArchive(file, outDir) {
      fs.mkdirSync(path.join(outDir, 'Приложение 1'), { recursive: true });
      const a = path.join(outDir, 'Извещение.docx');
      const b = path.join(outDir, 'Приложение 1', 'ТЗ.pdf');
      const c = path.join(outDir, 'Приложение 1', 'ТЗ.xlsx');
      const d = path.join(outDir, 'Извещение.docx.sig');
      fs.writeFileSync(a, 'PK\x03\x04docx');
      fs.writeFileSync(b, pdf3);
      fs.writeFileSync(c, 'PK\x03\x04xlsx');
      fs.writeFileSync(d, '0\x82sig');
      return [a, b, c, d];
    },
  };
  const tender = { id: 'notice:32616404967', source: 'zakupki', number: '32616404967', title: 'Фасонные изделия в ППУ', customer: 'ПАО «Т Плюс»', price: 5e6, url: card, favorite: true };
  const store = { tenders: { [tender.id]: tender }, saves: 0, scheduleSave() { this.saves++; } };
  const dataDir = tmpDir();
  const svc = new DocumentService({ store, fetchImpl, dataDir, delayMs: 0, convert, limits: { maxPagesSpreadsheet: 4 }, log: { warn() {} } });
  const events = [];
  svc.onUpdate((j) => events.push(j.state));

  const started = svc.start(tender.id);
  assert.equal(started.state, 'running');
  assert.equal(svc.start(tender.id).startedAt, started.startedAt, 'повторный запуск не плодит задачи');
  const m = await waitDone(svc, tender.id);

  assert.equal(m.state, 'done', m.error);
  assert.ok(requested.includes(card), 'для 223-ФЗ адрес вкладки берётся из карточки');
  assert.ok(m.notes.some((n) => /Печатная форма/.test(n)), 'сбой печатной формы — примечание, а не ошибка');
  assert.deepEqual(
    m.files.map((f) => [f.name, f.status, f.pages ?? null]),
    [
      ['Извещение.docx', 'ok', 2],
      ['Приложение 1 / ТЗ.pdf', 'ok', 3],
      ['Приложение 1 / ТЗ.xlsx', 'truncated', 4],
      ['Извещение.docx.sig', 'skipped', null],
      ['текст разъяснения.doc', 'ok', 2],
    ],
  );
  assert.equal(m.files[0].from, 'ОЗЦОУ-19 ВФ.zip');
  assert.match(m.files[2].note, /первые 4 из 10/);
  // Титульный лист вышел на 2 страницы — его пересобирают, чтобы номера страниц в содержании сошлись.
  assert.deepEqual(converted, ['docx', 'xlsx', 'html', 'html', 'html'], 'HTML под видом .doc и титульный лист идут через LibreOffice как HTML');
  assert.deepEqual(m.originals.map((o) => o.name), ['ОЗЦОУ-19 ВФ.zip', 'текст разъяснения.doc']);

  const pdf = await PDFDocument.load(fs.readFileSync(svc.pdfFile(tender.id)));
  assert.equal(pdf.getPageCount(), 2 + 2 + 3 + 4 + 2, 'титульный лист + документы');
  assert.equal(m.pages, 13);
  assert.ok(pdf.catalog.get(PDFName.of('Outlines')), 'в PDF есть закладки по документам');
  assert.equal(fs.existsSync(path.join(svc.dirFor(tender.id), 'work')), false, 'промежуточные файлы удалены');

  assert.deepEqual(tender.documents, { state: 'done', at: m.finishedAt, pages: 13, files: 4, skipped: 1 });
  assert.equal(svc.originalFile(tender.id, 2).name, 'текст разъяснения.doc');
  assert.equal(events.at(-1), 'done');
  const reloaded = new DocumentService({ store, fetchImpl, dataDir, convert });
  assert.equal(reloaded.get(tender.id).state, 'done', 'результат переживает перезапуск');
});

test('DocumentService: закупка только с площадки — понятная ошибка без запросов', async () => {
  const tender = { id: 'b2bcenter:1', source: 'b2bcenter', number: '1', title: 'x', url: 'https://www.b2b-center.ru/market/x/tender-1/' };
  const store = { tenders: { [tender.id]: tender }, scheduleSave() {} };
  let calls = 0;
  const svc = new DocumentService({ store, fetchImpl: async () => calls++, dataDir: tmpDir(), platformName: () => 'B2B-Center', log: { warn() {} } });
  const m = await (svc.start(tender.id), waitDone(svc, tender.id));
  assert.equal(m.state, 'error');
  assert.match(m.error, /«B2B-Center».*личный кабинет/);
  assert.equal(calls, 0);
  assert.equal(tender.documents.state, 'error');
  assert.equal(eisCardUrl({ source: 'b2bcenter', url: 'https://b2b-center.ru/x', links: { zakupki: 'https://zakupki.gov.ru/epz/x' } }), 'https://zakupki.gov.ru/epz/x');
});

test('DocumentService: «running» после перезапуска сервера помечается как прерванное', () => {
  const store = { tenders: { a: { id: 'a', documents: { state: 'running' } } }, scheduleSave() {} };
  new DocumentService({ store, fetchImpl: async () => null, dataDir: tmpDir() });
  assert.equal(store.tenders.a.documents.state, 'error');
});
