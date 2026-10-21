import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectProjectNews, mapNewsItems, newsSearchUrl } from '../src/news.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Реконструкция теплотрассы: поставка труб в ППУ изоляции - Neftegaz.RU</title>
    <link>https://news.google.com/rss/articles/pipes</link>
    <pubDate>Mon, 28 Sep 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Котики на стройке нового парка - Город</title>
    <link>https://news.google.com/rss/articles/cats</link>
    <pubDate>Sun, 27 Sep 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test('новости строек: в ленту попадает только заголовок с номенклатурой', () => {
  const url = newsSearchUrl(['труба ППУ']);
  assert.match(url, /news\.google\.com\/rss\/search/);
  assert.match(url, /%D1%82%D1%80%D1%83%D0%B1%D0%B0/);
  assert.match(url, /%D1%81%D1%82%D1%80%D0%BE%D0%B8%D1%82%D0%B5%D0%BB%D1%8C%D1%81%D1%82%D0%B2%D0%BE|%D1%81%D1%82%D1%80%D0%BE%D0%B9%D0%BA%D0%B0/);
  const items = mapNewsItems(rss, ['труба']);
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'Neftegaz.RU');
  assert.match(items[0].title, /труб/);
  assert.equal(items[0].publishedAt.slice(0, 10), '2026-09-28');
});

test('новости строек: демо не ходит в сеть, пустая номенклатура объясняет почему', async () => {
  let called = false;
  const demo = await collectProjectNews({
    keywords: [{ keyword: 'скорлупа' }, { keyword: '', okpd2: '24.20' }],
    mode: 'demo',
    fetchImpl: async () => {
      called = true;
      return rss;
    },
  });
  assert.equal(called, false);
  assert.deepEqual(demo.keywords, ['скорлупа']);
  assert.ok(demo.items.length >= 1);
  assert.match(demo.note, /Демо/);

  const empty = await collectProjectNews({ keywords: [{ okpd2: '24.20' }] });
  assert.equal(empty.items.length, 0);
  assert.match(empty.note, /ОКПД2/);
});

test('новости строек: сбой источника не затирает прошлую ленту при ручном опросе', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-')), 'db.json');
  const store = new Store(file);
  store.addNomenclature({ keyword: 'труба' });
  store.setNews({
    updatedAt: '2026-09-01T00:00:00.000Z',
    keywords: ['труба'],
    items: [{ title: 'Старая стройка труб', url: 'https://news.google.com/old', source: 'РБК', publishedAt: null, summary: '' }],
    searchUrl: '',
    note: '',
    warning: '',
  });
  store.save();
  let calls = 0;
  const scheduler = new Scheduler({
    store,
    source: { async collect() { return { tenders: [], errors: [], queriesRun: 1 }; } },
    notifier: null,
    log: { error() {}, warn() {}, info() {} },
    collectNews: async () => {
      calls += 1;
      return { updatedAt: '2026-09-28T00:00:00.000Z', keywords: ['труба'], items: [], searchUrl: '', note: '', warning: 'HTTP 503' };
    },
  });
  await scheduler.runOnce({ trigger: 'manual' });
  scheduler.stop();
  assert.equal(calls, 1);
  assert.equal(store.news.items[0].title, 'Старая стройка труб');
  assert.match(store.news.warning, /503/);

  await scheduler.runOnce({ trigger: 'timer' });
  scheduler.stop();
  assert.equal(calls, 1, 'таймер новости не обновляет');
});
