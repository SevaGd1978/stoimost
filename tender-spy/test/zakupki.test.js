import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRss, parseDescriptionFields, pickField } from '../src/rss.js';
import { buildQueries, mapNoticeItem, mapContractItem, ZakupkiSource } from '../src/sources/zakupki.js';
import { keywordMatches, parseRuNumber, parseRuDate, detectLaw, parsePriceBound, priceInRange } from '../src/tenders.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

test('parseRss достаёт item, если XML-парсер теряет записи', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
<description>поиск <незакрытый фрагмент</description>
<title>Результаты поиска</title>
<item>
  <title>Иной способ №32616404057</title>
  <link>https://zakupki.gov.ru/223/purchase/public/purchase/info/common-info.html?regNumber=32616404057</link>
  <description>&lt;strong&gt;Наименование объекта закупки: &lt;/strong&gt;Труба стальная</description>
</item>
<item>
  <title>Служебный &lt;fragment</title>
  <link>https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0172200002526000123</link>
  <description>нет номера в тексте, номер в ссылке</description>
</item>
</channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.match(items[0].link, /32616404057/);
  assert.match(items[0].description, /Труба стальная/);
  const card = mapNoticeItem(items[0], { kind: 'notices', match: { type: 'keyword', ref: 'труба', label: 'труба' } });
  assert.equal(card.number, '32616404057');
  assert.equal(card.law, '223');
});

test('parseRss читает RSS ЕИС с CDATA', () => {
  const items = parseRss(fixture('notices.rss.xml'));
  assert.equal(items.length, 2);
  assert.match(items[0].title, /0172200002526000123/);
  assert.match(items[0].link, /regNumber=0172200002526000123/);
  const fields = parseDescriptionFields(items[0].description);
  assert.equal(pickField(fields, 'заказчик').includes('ТЕПЛОСЕТЬ'), true);
  assert.equal(pickField(fields, 'этап'), 'Подача заявок');
});

test('mapNoticeItem нормализует извещение 44-ФЗ', () => {
  const [item] = parseRss(fixture('notices.rss.xml'));
  const query = { kind: 'notices', match: { type: 'keyword', ref: 'труба предизолированная', label: 'труба предизолированная' } };
  const t = mapNoticeItem(item, query);
  assert.equal(t.id, 'notice:0172200002526000123');
  assert.equal(t.law, '44');
  assert.equal(t.customerInn, '7810577007');
  assert.equal(t.price, 12345678.9);
  assert.equal(t.isOpen, true);
  assert.equal(t.publishedAt.slice(0, 10), '2026-09-20');
  assert.equal(t.deadlineAt.slice(0, 10), '2026-09-30');
  assert.equal(t.matches[0].strong, true, 'ключевая фраза найдена в предмете с учётом словоформ');
});

test('mapNoticeItem определяет 223-ФЗ и закрытый этап', () => {
  const [, item] = parseRss(fixture('notices.rss.xml'));
  const query = { kind: 'notices', match: { type: 'company', ref: '7830001028', label: 'ГУП ТЭК' } };
  const t = mapNoticeItem(item, query);
  assert.equal(t.law, '223');
  assert.equal(t.isOpen, false);
  assert.equal(t.matches[0].strong, true, 'ИНН найден в тексте карточки');
});

test('mapContractItem вытаскивает поставщика и ИНН', () => {
  const [item] = parseRss(fixture('contracts.rss.xml'));
  const query = { kind: 'contracts', match: { type: 'company', ref: '6679037273', label: 'ПЗПТ', via: 'contract' } };
  const t = mapContractItem(item, query);
  assert.equal(t.kind, 'contract');
  assert.equal(t.supplierInn, '6679037273');
  assert.equal(t.customerInn, '7810577007');
  assert.equal(t.price, 4500000);
  assert.equal(t.stage, 'Исполнение');
});

test('buildQueries строит только запросы по номенклатуре', () => {
  const queries = buildQueries({
    companies: [
      { inn: '6679104561', name: 'Старк', role: 'any' },
      { inn: '6679037273', name: 'ПЗПТ', role: 'supplier' },
    ],
    nomenclature: [{ keyword: 'труба', okpd2: '24.20.13' }, { keyword: '', okpd2: '25.99' }],
    settings: { onlyOpen: true, laws: { fz44: true, fz223: false, fz615: false }, searchContracts: true },
  });
  assert.equal(queries.length, 2);
  assert.ok(queries.every((q) => q.kind === 'notices' && q.match.type !== 'company'));
  assert.ok(!queries.some((q) => q.url.includes('6679104561') || q.url.includes('supplierInn')));
  const pipe = queries.find((q) => q.match.ref === 'труба');
  assert.ok(pipe.url.includes('searchString='));
  assert.ok(pipe.url.includes('fz44=on'));
  assert.ok(!pipe.url.includes('fz223=on'));
  assert.ok(pipe.url.includes('af=on') && !pipe.url.includes('pc=on'));
  const okpd = queries.find((q) => q.match.type === 'okpd2');
  assert.ok(okpd.url.includes('okpd2IdsCodes=25.99'));
});

test('ZakupkiSource.collect работает с подменённым fetch и собирает ошибки', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('contract')) return { ok: false, status: 503 };
    return { ok: true, text: async () => fixture('notices.rss.xml') };
  };
  const src = new ZakupkiSource({ base: 'https://zakupki.gov.ru', userAgent: 'test', delayMs: 0, fetchImpl, log: {} });
  const res = await src.collect({
    companies: [{ inn: '6679104561', name: 'Старк', role: 'any' }],
    nomenclature: [{ keyword: 'труба', okpd2: '' }],
    settings: { onlyOpen: true, laws: { fz44: true, fz223: true }, searchContracts: true },
  });
  assert.equal(calls.length, 1, 'ИНН не порождает отдельных запросов');
  assert.ok(calls[0].includes('searchString='));
  assert.ok(!calls.some((url) => url.includes('6679104561') || url.includes('contract')));
  assert.equal(res.tenders.length, 2);
  assert.equal(res.errors.length, 0);
});

test('утилиты: числа, даты, закон, морфология', () => {
  assert.equal(parseRuNumber('1 234 567,89'), 1234567.89);
  assert.equal(parseRuNumber('98 000 000,00 ₽'), 98000000);
  assert.equal(parseRuNumber(''), null);
  assert.equal(parsePriceBound('1 500 000'), 1500000);
  assert.equal(parsePriceBound(''), null);
  assert.equal(parsePriceBound('нет'), null);
  assert.equal(priceInRange(200, 100, 300), true);
  assert.equal(priceInRange(50, 100, null), false);
  assert.equal(priceInRange(null, null, 100), false);
  assert.equal(priceInRange(null, null, null), true);
  assert.equal(priceInRange(0, 0, 10), true);
  assert.equal(parseRuDate('21.09.2026 09:15').slice(0, 13), '2026-09-21T06');
  assert.equal(detectLaw({ url: '', number: '32615000123' }), '223');
  assert.equal(detectLaw({ url: '', number: '0172200002526000123' }), '44');
  assert.equal(keywordMatches('трубы стальные', 'Поставка труб стальных предизолированных'), true);
  assert.equal(keywordMatches('котельная', 'Поставка труб'), false);
});
