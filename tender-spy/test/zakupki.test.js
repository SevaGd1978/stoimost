import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRss, parseDescriptionFields, pickField } from '../src/rss.js';
import { buildQueries, mapNoticeItem, mapContractItem, ZakupkiSource } from '../src/sources/zakupki.js';
import { keywordMatches, parseRuNumber, parseRuDate, detectLaw } from '../src/tenders.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');

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

test('buildQueries строит запросы по ролям и настройкам', () => {
  const queries = buildQueries({
    companies: [
      { inn: '6679104561', name: 'Старк', role: 'any' },
      { inn: '7810577007', name: 'Теплосеть', role: 'customer' },
      { inn: '6679037273', name: 'ПЗПТ', role: 'supplier' },
    ],
    nomenclature: [{ keyword: 'труба', okpd2: '24.20.13' }, { keyword: '', okpd2: '25.99' }],
    settings: { onlyOpen: true, laws: { fz44: true, fz223: false, fz615: false }, searchContracts: true },
  });
  const labels = queries.map((q) => q.label);
  assert.equal(queries.length, 6, labels.join('\n'));
  const starkNotice = queries.find((q) => q.kind === 'notices' && q.match.ref === '6679104561');
  assert.ok(starkNotice.url.includes('searchString=6679104561'));
  assert.ok(starkNotice.url.includes('fz44=on'));
  assert.ok(!starkNotice.url.includes('fz223=on'));
  assert.ok(starkNotice.url.includes('af=on') && !starkNotice.url.includes('pc=on'));
  assert.ok(queries.some((q) => q.kind === 'contracts' && q.url.includes('supplierInn=6679037273')));
  assert.ok(!queries.some((q) => q.kind === 'contracts' && q.match.ref === '7810577007'), 'для заказчика контракты не ищем');
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
    nomenclature: [],
    settings: { onlyOpen: true, laws: { fz44: true, fz223: true }, searchContracts: true },
  });
  assert.equal(calls.length, 2);
  assert.equal(res.tenders.length, 2);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].message, /503/);
});

test('утилиты: числа, даты, закон, морфология', () => {
  assert.equal(parseRuNumber('1 234 567,89'), 1234567.89);
  assert.equal(parseRuNumber('98 000 000,00 ₽'), 98000000);
  assert.equal(parseRuNumber(''), null);
  assert.equal(parseRuDate('21.09.2026 09:15').slice(0, 13), '2026-09-21T06');
  assert.equal(detectLaw({ url: '', number: '32615000123' }), '223');
  assert.equal(detectLaw({ url: '', number: '0172200002526000123' }), '44');
  assert.equal(keywordMatches('трубы стальные', 'Поставка труб стальных предизолированных'), true);
  assert.equal(keywordMatches('котельная', 'Поставка труб'), false);
});
