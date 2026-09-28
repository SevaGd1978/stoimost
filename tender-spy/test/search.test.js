import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFound, parseSearchKeywords, searchSettings, titleMatches } from '../src/search.js';
import { staleNotice } from '../src/tenders.js';

test('parseSearchKeywords: несколько q и разделитель |, без дублей и пустых', () => {
  assert.deepEqual(parseSearchKeywords(['скорлупа ППУ', ' ППУ изоляция труб | скорлупа ППУ', '']), ['скорлупа ППУ', 'ППУ изоляция труб']);
  assert.deepEqual(parseSearchKeywords(undefined), []);
});

test('searchSettings: все законы, только открытые, без цены', () => {
  const s = searchSettings();
  assert.equal(s.onlyOpen, true);
  assert.deepEqual(s.laws, { fz44: true, fz223: true, fz615: true });
  assert.equal(s.priceMin, null);
  assert.equal(s.priceMax, null);
});

test('mergeFound: ЕИС главнее площадки, ссылки объединяются, закрытые отброшены', () => {
  const items = mergeFound([
    { id: 'notice:1', source: 'fabrikant', kind: 'notice', isOpen: true, title: 'Трубы ППУ', customer: 'МУП', url: 'https://f/1', links: { fabrikant: 'https://f/1' }, matches: [{ type: 'keyword', ref: 'ППУ' }] },
    { id: 'notice:1', source: 'zakupki', kind: 'notice', isOpen: true, title: 'Поставка скорлупы ППУ', customer: null, price: 100, url: 'https://z/1', matches: [{ type: 'keyword', ref: 'скорлупа ППУ' }] },
    { id: 'notice:2', source: 'zakupki', kind: 'notice', isOpen: false, title: 'Закрыта', url: 'https://z/2', matches: [] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'zakupki');
  assert.equal(items[0].url, 'https://z/1');
  assert.equal(items[0].customer, 'МУП');
  assert.deepEqual(Object.keys(items[0].links).sort(), ['fabrikant', 'zakupki']);
  assert.equal(items[0].matches.length, 2);
});

const NOW = Date.parse('2026-09-25T12:00:00Z');
const kw = (ref) => [{ type: 'keyword', ref }];

test('staleNotice: без срока подачи старше 90 дней — устарело, срок в прошлом — закрыто', () => {
  assert.equal(staleNotice({ publishedAt: '2014-05-08T09:00:00Z' }, NOW), true);
  assert.equal(staleNotice({ publishedAt: '2026-09-01T09:00:00Z' }, NOW), false);
  assert.equal(staleNotice({ publishedAt: '2014-05-08T09:00:00Z', deadlineAt: '2026-10-01T09:00:00Z' }, NOW), false);
  assert.equal(staleNotice({ deadlineAt: '2026-09-20T09:00:00Z' }, NOW), true);
  assert.equal(staleNotice({}, NOW), false);
});

test('titleMatches: слова фразы в названии, пенополиуретан = ППУ', () => {
  assert.equal(titleMatches('ППУ изоляция труб', 'Поставка стальных труб в ППУ-изоляции'), true);
  assert.equal(titleMatches('ППУ изоляция труб', 'Поставка труб ВГП в пенополиуретановой изоляции'), true);
  assert.equal(titleMatches('скорлупа ППУ', 'Аварийно-восстановительные работы на тепловых сетях'), false);
});

test('mergeFound: отбрасывает устаревшие записи ЕИС и совпадения не по названию', () => {
  const items = mergeFound([
    { id: 'notice:0347300019914000004', source: 'zakupki', kind: 'notice', isOpen: true, publishedAt: '2014-06-02T09:00:00Z', title: 'Поставка труб в ППУ изоляции', matches: kw('ППУ изоляция труб') },
    { id: 'notice:0841600008126000592', source: 'zakupki', kind: 'notice', isOpen: true, publishedAt: '2026-09-11T09:00:00Z', title: 'Ремонт бесхозяйных тепловых сетей', matches: kw('скорлупа ППУ') },
    { id: 'notice:32616406448', source: 'zakupki', kind: 'notice', isOpen: true, publishedAt: '2026-09-24T09:00:00Z', title: 'Поставка скорлупы, отводов ППУ', matches: kw('скорлупа ППУ') },
  ], NOW);
  assert.deepEqual(items.map((t) => t.id), ['notice:32616406448']);
});

test('mergeFound: одна закупка с ЕИС и площадки без номера ЕИС — одна карточка', () => {
  const items = mergeFound([
    { id: 'tektorg:ИР609456', source: 'tektorg', kind: 'notice', isOpen: true, price: 119899308.86, deadlineAt: '2026-10-08T09:00:00Z', publishedAt: '2026-09-21T09:17:02Z', title: '226110_Поставка труб в ППУ изоляции для ГРЭС', url: 'https://t/1', links: { tektorg: 'https://t/1' }, matches: kw('ППУ изоляция труб') },
    { id: 'notice:32616393837', source: 'zakupki', kind: 'notice', isOpen: true, price: 119899308.86, publishedAt: '2026-09-21T09:00:00Z', title: '226110_Поставка труб в ППУ изоляции для ГРЭС', url: 'https://z/1', matches: kw('ППУ изоляция труб') },
  ], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'zakupki');
  assert.equal(items[0].deadlineAt, '2026-10-08T09:00:00Z');
  assert.deepEqual(Object.keys(items[0].links).sort(), ['tektorg', 'zakupki']);
});
