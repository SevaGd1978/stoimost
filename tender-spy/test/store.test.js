import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { TelegramNotifier } from '../src/notify.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-')), 'db.json');
}

const sample = (id, extra = {}) => ({
  id,
  source: 'test',
  kind: 'notice',
  law: '44',
  number: id.split(':')[1],
  title: 'Поставка труб',
  customer: 'АО Заказчик',
  price: 100,
  stage: 'Подача заявок',
  isOpen: true,
  url: 'https://example.org',
  matches: [{ type: 'keyword', ref: 'труба', label: 'труба' }],
  ...extra,
});

test('Store: добавление предприятий, дедупликация и сохранение на диск', () => {
  const file = tmpFile();
  const store = new Store(file);
  const a = store.addCompany({ inn: '6679104561', name: 'Старк' });
  const b = store.addCompany({ inn: '6679104561', name: 'Дубль' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(store.companies.length, 1);
  store.addNomenclature({ keyword: 'Труба' });
  store.addNomenclature({ keyword: 'труба' });
  assert.equal(store.nomenclature.length, 1);
  store.save();
  const reloaded = new Store(file);
  assert.equal(reloaded.companies[0].name, 'Старк');
  assert.equal(reloaded.nomenclature[0].keyword, 'Труба');
});

test('Store.upsertTender: новый → true, повтор объединяет причины и сбрасывает seen при смене этапа', () => {
  const store = new Store(tmpFile());
  assert.equal(store.upsertTender(sample('notice:1')), true);
  store.patchTender('notice:1', { seen: true });
  assert.equal(
    store.upsertTender(sample('notice:1', { matches: [{ type: 'company', ref: '111', label: 'X' }] })),
    false,
  );
  const t = store.tenders['notice:1'];
  assert.equal(t.matches.length, 2);
  assert.equal(t.seen, true);
  store.upsertTender(sample('notice:1', { stage: 'Работа комиссии' }));
  assert.equal(store.tenders['notice:1'].seen, false, 'смена этапа снова делает карточку «новой»');
});

test('Store.prune удаляет устаревшие, кроме избранных', () => {
  const store = new Store(tmpFile());
  store.upsertTender(sample('notice:old'));
  store.upsertTender(sample('notice:fav'));
  store.tenders['notice:old'].lastSeenAt = new Date(Date.now() - 100 * 86400_000).toISOString();
  store.tenders['notice:fav'].lastSeenAt = new Date(Date.now() - 100 * 86400_000).toISOString();
  store.patchTender('notice:fav', { favorite: true });
  assert.equal(store.prune(90), 1);
  assert.ok(store.tenders['notice:fav']);
});

test('Store.patchTender: избранное помнит дату добавления, заметка обрезается и сохраняется', () => {
  const file = tmpFile();
  const store = new Store(file);
  store.upsertTender(sample('notice:1'));
  store.patchTender('notice:1', { favorite: true, comment: '  уточнить диаметр  ' });
  const t = store.tenders['notice:1'];
  assert.equal(t.favorite, true);
  assert.ok(Date.parse(t.favoritedAt) > 0);
  assert.equal(t.comment, 'уточнить диаметр');
  const first = t.favoritedAt;
  store.patchTender('notice:1', { favorite: true });
  assert.equal(t.favoritedAt, first, 'повторное добавление не сдвигает дату');
  store.patchTender('notice:1', { comment: 'x'.repeat(3000), stage: 'взлом' });
  assert.equal(t.comment.length, 2000);
  assert.equal(t.stage, 'Подача заявок', 'посторонние поля не меняются');
  store.save();
  assert.equal(new Store(file).tenders['notice:1'].favoritedAt, first);
  store.patchTender('notice:1', { favorite: false, comment: '' });
  assert.equal(t.favorite, false);
  assert.equal('favoritedAt' in t, false);
  assert.equal('comment' in t, false);
});

test('Scheduler.runOnce: фильтрует закрытые при onlyOpen, считает новые, шлёт в Telegram', async () => {
  const store = new Store(tmpFile());
  store.addNomenclature({ keyword: 'труба' });
  store.updateSettings({ notifyTelegram: true });
  const source = {
    async collect() {
      return {
        tenders: [sample('notice:a'), sample('notice:b', { isOpen: false, stage: 'Работа комиссии' }), sample('contract:c', { kind: 'contract', isOpen: false })],
        errors: [],
        queriesRun: 2,
      };
    },
  };
  const sent = [];
  const notifier = { enabled: true, async notifyNewTenders(list) { sent.push(list.length); return true; } };
  const scheduler = new Scheduler({ store, source, notifier, log: { error() {}, warn() {} } });
  const run = await scheduler.runOnce({ trigger: 'manual' });
  scheduler.stop();
  assert.equal(run.found, 3);
  assert.equal(run.added, 2, 'закрытое извещение отброшено, контракт остался');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(sent, [2]);
  const again = await scheduler.runOnce({ trigger: 'timer' });
  scheduler.stop();
  assert.equal(again.added, 0);
});

test('Настройка цены сохраняется и отсекает карточки вне диапазона', async () => {
  const file = tmpFile();
  const store = new Store(file);
  store.addNomenclature({ keyword: 'труба' });
  const s = store.updateSettings({ priceMin: '2 000 000', priceMax: '100 000' });
  assert.equal(s.priceMin, 100000, 'границы переставлены');
  assert.equal(s.priceMax, 2000000);
  store.save();
  assert.equal(new Store(file).settings.priceMax, 2000000);

  const source = {
    async collect() {
      return {
        tenders: [
          sample('notice:low', { price: 5000 }),
          sample('notice:mid', { price: 500000 }),
          sample('notice:high', { price: 9000000 }),
          sample('notice:unknown', { price: null }),
        ],
        errors: [],
        queriesRun: 1,
      };
    },
  };
  const scheduler = new Scheduler({ store, source, notifier: null, log: { error() {}, warn() {} } });
  const run = await scheduler.runOnce();
  scheduler.stop();
  assert.equal(run.added, 2);
  assert.ok(store.tenders['notice:mid'] && store.tenders['notice:unknown']);
  assert.ok(!store.tenders['notice:low'] && !store.tenders['notice:high']);

  assert.equal(store.updateSettings({ priceMin: '', priceMax: null }).priceMin, null);
  assert.equal(store.settings.priceMax, null);
});

test('Store: пакетный импорт компаний и номенклатуры, экспорт watchlist', () => {
  const store = new Store(tmpFile());
  const cRes = store.importCompanies([
    { inn: '6679104561', name: 'Старк-СПБ', role: 'customer' },
    { inn: '7707083893', name: 'Сбербанк', role: 'customer' },
    { inn: '6679104561', name: 'Старк дубль' }, // дубль без overwrite
  ]);
  assert.equal(cRes.added, 2);
  assert.equal(cRes.skipped, 1);
  assert.equal(store.companies.length, 2);

  const nRes = store.importNomenclature([
    { keyword: 'Котел газовый', okpd2: '25.21.12' },
    { keyword: 'Трубы стальные', okpd2: '' },
    { keyword: 'котел газовый', okpd2: '25.21.12' }, // дубль
  ]);
  assert.equal(nRes.added, 2);
  assert.equal(nRes.skipped, 1);
  assert.equal(store.nomenclature.length, 2);

  const exported = store.exportWatchlist();
  assert.equal(exported.companies.length, 2);
  assert.equal(exported.nomenclature.length, 2);

  const freshStore = new Store(tmpFile());
  const imp = freshStore.importWatchlist(exported);
  assert.equal(imp.companies.added, 2);
  assert.equal(imp.nomenclature.added, 2);
  assert.equal(freshStore.companies[0].inn, '6679104561');
});

test('TelegramNotifier: testConnection возвращает ошибку, если не настроен', async () => {
  const disabledNotifier = new TelegramNotifier({ token: '', chatId: '' });
  const res = await disabledNotifier.testConnection();
  assert.equal(res.ok, false);
  assert.match(res.error, /не заданы/);

  const mockNotifier = new TelegramNotifier({
    token: 'test-token',
    chatId: '12345',
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  });
  const mockRes = await mockNotifier.testConnection();
  assert.equal(mockRes.ok, true);
});

test('Scheduler.runOnce с пустым watchlist возвращает подсказку', async () => {
  const store = new Store(tmpFile());
  const scheduler = new Scheduler({ store, source: { collect: async () => ({ tenders: [], errors: [], queriesRun: 0 }) }, notifier: null, log: {} });
  const run = await scheduler.runOnce();
  scheduler.stop();
  assert.match(run.errors[0].message, /номенклатур/);
});

test('Store: очистка ленты — просмотренные и закрытые в архив, избранные и новые открытые остаются', () => {
  const store = new Store(tmpFile());
  for (const id of ['notice:1', 'notice:2', 'notice:3', 'notice:4']) store.upsertTender(sample(id));
  store.upsertTender(sample('notice:5', { isOpen: false, stage: 'Работа комиссии' }));
  store.patchTender('notice:1', { seen: true });
  store.patchTender('notice:2', { seen: true, favorite: true });
  store.patchTender('notice:4', { archived: true });
  assert.equal(store.archiveSeenAndClosed(), 2);
  const archived = (id) => store.tenders[id].archived;
  assert.deepEqual(['notice:1', 'notice:2', 'notice:3', 'notice:4', 'notice:5'].map(archived), [true, false, false, true, true]);
  store.upsertTender(sample('notice:1'));
  assert.equal(archived('notice:1'), true);
  assert.equal(store.archiveSeenAndClosed(), 0);
});
