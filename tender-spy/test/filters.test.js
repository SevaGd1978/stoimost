import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MINUS_WORDS,
  contextOk,
  customerTypeOf,
  isSmpOnly,
  methodGroupOf,
  minusHit,
  parseWordList,
  rejectReason,
  settingsAllow,
  subjectOf,
} from '../src/filters.js';
import { regionFromText } from '../src/regions.js';
import { parseEisDeadline, parseNoticeCard } from '../src/sources/eis-card.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

const fixture = (n) => fs.readFileSync(new URL(`./fixtures/eis-cards/${n}.html`, import.meta.url), 'utf8');

test('parseWordList: запятые, точки с запятой и строки, без пустых и повторов', () => {
  assert.deepEqual(parseWordList('запчасти, Трубка;\nзапчасти\n\n лекарственный  препарат '), ['запчасти', 'Трубка', 'лекарственный препарат']);
  assert.deepEqual(parseWordList(['а', ' ', 'а']), ['а']);
});

test('minusHit: слово по основе, фраза — только все слова', () => {
  assert.equal(minusHit('Поставка запасных частей для автомобилей', DEFAULT_MINUS_WORDS), 'запасные части');
  assert.equal(minusHit('Поставка трубок трахеостомических', DEFAULT_MINUS_WORDS), 'трубок');
  assert.equal(minusHit('Работы по содержанию автомобильных дорог', ['содержание дорог']), 'содержание дорог');
  assert.equal(minusHit('Содержание тепловых сетей', ['содержание дорог']), null);
  assert.equal(minusHit('Поставка труб в ППУ изоляции', DEFAULT_MINUS_WORDS), null);
});

test('contextOk: хотя бы одно слово с начала слова, «пенополиуретан» = ППУ', () => {
  const ctx = ['труб', 'скорлуп', 'ппу'];
  assert.equal(contextOk('Поставка скорлупы ППУ 159/40', ctx), true);
  assert.equal(contextOk('Поставка вырезки из говядины, отруб замороженный', ['труб']), false);
  assert.equal(contextOk('Изоляция пенополиуретановая', ['ппу']), true);
  assert.equal(contextOk('Что угодно', []), true);
});

test('rejectReason: минус-слова и уточняющие слова позиции', () => {
  const nomenclature = [{ keyword: 'Ппу', okpd2: '', context: ['труб', 'скорлуп'] }];
  const settings = { minusWords: ['запчасти'] };
  const t = (title) => ({ title, matches: [{ type: 'keyword', ref: 'Ппу' }] });
  assert.equal(rejectReason(t('Поставка труб в ППУ изоляции'), { nomenclature, settings }), null);
  assert.equal(rejectReason(t('Буровой инструмент, втулка нижняя ППУ'), { nomenclature, settings }), 'context');
  assert.equal(rejectReason(t('Запчасти ППУ для труб'), { nomenclature, settings }), 'minus');
  assert.equal(rejectReason({ title: 'Втулка', matches: [{ type: 'keyword', ref: 'удалённая' }] }, { nomenclature, settings }), null);
});

test('settingsAllow: закон и НМЦК, карточки без цены не отсекаются', () => {
  const s = { laws: { fz44: false, fz223: true }, priceMin: 1_000_000, priceMax: 15_000_000 };
  assert.equal(settingsAllow({ law: '44', price: 2_000_000 }, s), false);
  assert.equal(settingsAllow({ law: '223', price: 500_000 }, s), false);
  assert.equal(settingsAllow({ law: '223', price: 20_000_000 }, s), false);
  assert.equal(settingsAllow({ law: '223', price: 2_000_000 }, s), true);
  assert.equal(settingsAllow({ law: 'other', price: null }, s), true);
});

test('subjectOf, customerTypeOf, methodGroupOf, isSmpOnly', () => {
  assert.equal(subjectOf('Поставка труб ППУ'), 'supply');
  assert.equal(subjectOf('Выполнение работ по замене участка трубопровода ГВС'), 'works');
  assert.equal(subjectOf('Приобретение материалов для капитального ремонта тепловой сети'), 'supply');
  assert.equal(customerTypeOf({ customer: 'АО "ШЕКСНА-ТЕПЛОСЕТЬ"' }), 'heat');
  assert.equal(customerTypeOf({ customer: 'ПАО "Т ПЛЮС"' }), 'heat');
  assert.equal(customerTypeOf({ customer: 'МУП "Уфимские инженерные сети"' }), 'municipal');
  assert.equal(customerTypeOf({ customer: 'ГБУЗ "Областная больница"' }), 'budget');
  assert.equal(customerTypeOf({ customer: 'ООО "Магазин"' }), 'other');
  assert.equal(methodGroupOf({ method: 'Электронный аукцион' }), 'auction');
  assert.equal(methodGroupOf({ method: 'Запрос котировок в электронной форме' }), 'quotes');
  assert.equal(methodGroupOf({ method: 'Иной способ' }), 'other');
  assert.equal(isSmpOnly({ method: 'Запрос котировок, участниками которого могут быть только субъекты малого и среднего предпринимательства' }), true);
  assert.equal(isSmpOnly({ method: 'Электронный аукцион' }), false);
});

test('regionFromText: поле «Регион» ЕИС и адрес заказчика', () => {
  assert.equal(regionFromText('Дагестан Респ'), 'Дагестан');
  assert.equal(regionFromText('162560, ВОЛОГОДСКАЯ ОБЛАСТЬ, Р-Н ШЕКСНИНСКИЙ'), 'Вологодская область');
  assert.equal(regionFromText('119435, Г.МОСКВА, УЛ. БОЛЬШАЯ ПИРОГОВСКАЯ'), 'Москва');
  assert.equal(regionFromText('Российская Федерация, 143407, Московская обл, Красногорск г'), 'Московская область');
  assert.equal(regionFromText('346330, Ростовская обл, г Донецк'), 'Ростовская область');
  assert.equal(regionFromText('Томская обл'), 'Томская область');
  assert.equal(regionFromText('Сахалинская обл'), 'Сахалинская область');
  assert.equal(regionFromText('Ямало-Ненецкий АО'), 'Ямало-Ненецкий АО');
  assert.equal(regionFromText(''), null);
});

test('parseEisDeadline: время по Москве и со сдвигом МСК+N', () => {
  assert.equal(parseEisDeadline('02.10.2026 10:00 (МСК)'), '2026-10-02T07:00:00.000Z');
  assert.equal(parseEisDeadline('02.10.2026 08:00 (МСК+1)'), '2026-10-02T04:00:00.000Z');
  assert.equal(parseEisDeadline('нет даты'), null);
});

test('parseNoticeCard: реальные карточки ЕИС 44-ФЗ и 223-ФЗ', () => {
  assert.deepEqual(parseNoticeCard(fixture('0348200081026005908')), { deadlineAt: '2026-10-02T07:00:00.000Z', region: 'Московская область', customerInn: null });
  assert.deepEqual(parseNoticeCard(fixture('0303100001626000070')), { deadlineAt: '2026-10-01T06:25:00.000Z', region: 'Дагестан', customerInn: null });
  assert.deepEqual(parseNoticeCard(fixture('32616406448')), { deadlineAt: '2026-10-02T04:00:00.000Z', region: 'Самарская область', customerInn: '6315701071' });
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-')), 'db.json');
const notice = (id, title, extra = {}) => ({
  id: `notice:${id}`,
  source: 'zakupki',
  kind: 'notice',
  law: '223',
  number: id,
  title,
  price: 2_000_000,
  stage: 'Подача заявок',
  isOpen: true,
  url: `https://zakupki.gov.ru/${id}`,
  matches: [{ type: 'keyword', ref: 'Ппу', label: 'Ппу' }],
  ...extra,
});

test('Scheduler: минус-слова и уточняющие слова отсекаются при опросе, карточки ЕИС дочитываются', async () => {
  const store = new Store(tmpFile());
  store.addNomenclature({ keyword: 'Ппу', context: 'труб, скорлуп' });
  store.updateSettings({ minusWords: 'запчасти' });
  const cards = [];
  const source = {
    collect: async () => ({
      tenders: [notice('1', 'Поставка труб ППУ'), notice('2', 'Запчасти ППУ для труб'), notice('3', 'Втулка ППУ для бурового инструмента')],
      errors: [],
      queriesRun: 1,
    }),
    fetchNoticeCard: async (t) => {
      cards.push(t.number);
      return { deadlineAt: '2099-10-02T07:00:00.000Z', region: 'Вологодская область', customerInn: '3524012697' };
    },
  };
  const scheduler = new Scheduler({ store, source, cardDelayMs: 0, log: { info() {}, warn() {}, error() {} } });
  const run = await scheduler.runOnce();
  assert.equal(run.added, 1);
  assert.equal(run.filtered, 2);
  await scheduler.enrichCards();
  assert.deepEqual(cards, ['1']);
  assert.equal(store.tenders['notice:1'].region, 'Вологодская область');
  assert.equal(store.tenders['notice:1'].deadlineAt, '2099-10-02T07:00:00.000Z');
  assert.equal(store.noticesWithoutCard().length, 0);
  scheduler.stop();
});

test('Store: уточняющие слова позиции сохраняются и уходят в экспорт', () => {
  const store = new Store(tmpFile());
  const { item } = store.addNomenclature({ keyword: 'Ппу' });
  assert.deepEqual(item.context, []);
  store.updateNomenclature(item.id, { context: 'труб, скорлуп' });
  assert.deepEqual(store.exportWatchlist().nomenclature, [{ keyword: 'Ппу', okpd2: '', context: ['труб', 'скорлуп'] }]);
  assert.deepEqual(store.settings.minusWords, DEFAULT_MINUS_WORDS);
});
