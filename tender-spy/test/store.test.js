import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

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

test('Scheduler.runOnce: фильтрует закрытые при onlyOpen, считает новые, шлёт в Telegram', async () => {
  const store = new Store(tmpFile());
  store.addCompany({ inn: '6679104561', name: 'Старк' });
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

test('Scheduler.runOnce с пустым watchlist возвращает подсказку', async () => {
  const store = new Store(tmpFile());
  const scheduler = new Scheduler({ store, source: { collect: async () => ({ tenders: [], errors: [], queriesRun: 0 }) }, notifier: null, log: {} });
  const run = await scheduler.runOnce();
  scheduler.stop();
  assert.match(run.errors[0].message, /пуст/);
});
