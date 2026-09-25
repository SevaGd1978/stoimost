import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFound, parseSearchKeywords, searchSettings } from '../src/search.js';

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
    { id: 'notice:1', source: 'zakupki', kind: 'notice', isOpen: true, title: 'Поставка труб ППУ', customer: null, price: 100, url: 'https://z/1', matches: [{ type: 'keyword', ref: 'скорлупа ППУ' }] },
    { id: 'notice:2', source: 'zakupki', kind: 'notice', isOpen: false, title: 'Закрыта', url: 'https://z/2', matches: [] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'zakupki');
  assert.equal(items[0].url, 'https://z/1');
  assert.equal(items[0].customer, 'МУП');
  assert.deepEqual(Object.keys(items[0].links).sort(), ['fabrikant', 'zakupki']);
  assert.equal(items[0].matches.length, 2);
});
