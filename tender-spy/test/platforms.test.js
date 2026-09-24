import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, PLATFORM_IDS } from '../src/sources/platforms/index.js';
import { PlatformsSource, enabledPlatforms, toTender } from '../src/sources/platforms/source.js';
import { CombinedSource } from '../src/sources/combined.js';
import { parseMoney, parseRuDateTime } from '../src/sources/platforms/util.js';
import { Store, defaultSettings } from '../src/store.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'platforms');
const byId = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));
const fixture = (id) => {
  const file = fs.readdirSync(fixtures).find((f) => f.startsWith(`${id}.`));
  return fs.readFileSync(path.join(fixtures, file), 'utf8');
};

test('подключено 10 площадок с уникальными id и фикстурами', () => {
  assert.equal(PLATFORMS.length, 10);
  assert.equal(new Set(PLATFORM_IDS).size, 10);
  for (const p of PLATFORMS) {
    assert.ok(p.name && p.site.startsWith('https://'), p.id);
    assert.ok(['purchase', 'sale'].includes(p.category), p.id);
    assert.ok(fixture(p.id).length > 100, p.id);
  }
  assert.ok(Object.values(defaultSettings().platforms).every(Boolean));
});

test('parseMoney и parseRuDateTime понимают форматы площадок', () => {
  assert.equal(parseMoney('1 259 402.00 RUB'), 1259402);
  assert.equal(parseMoney('689 055,48 ₽'), 689055.48);
  assert.equal(parseMoney('5629183.5 ₽'), 5629183.5);
  assert.equal(parseMoney('977&nbsp;653.20'), 977653.2);
  assert.equal(parseMoney('НМЦ не установлена'), null);
  assert.equal(parseMoney('0'), null);
  assert.equal(parseRuDateTime('30.09.2026 07:00 (+03:00)'), '2026-09-30T04:00:00.000Z');
  assert.equal(parseRuDateTime('24.09.2026 в 14:00'), '2026-09-24T11:00:00.000Z');
  assert.equal(parseRuDateTime('24.09.2026 06:43:48'), '2026-09-24T03:43:48.000Z');
});

const EXPECT = {
  roseltorg: { number: '0328300032826000776', eis: true, price: 689055.48, customer: /ВЛАДИМИРА/, open: true },
  etpets: { number: '0801500001326000012', eis: true, price: 1259402, customer: /БАШКОРТОСТАН/, open: true },
  fabrikant: { number: '305309-1', eis: true, price: 2044270, customer: /ВОЛЖСКИЙ/, open: true },
  tektorg: { number: 'ПИ607046', price: 5629183.5, customer: /РН-ВАНКОР/, open: true },
  b2bcenter: { number: '4613704', customer: /АИМ/ },
  zakazrf: { number: '32616400926', eis: true, price: 13120, customer: /Джалильское/ },
  etprf: { number: 'EX26082100001', price: 414544.53, customer: /КАМЕНСК/ },
  avtodor: { number: 'AVT28082600003', price: 8231711.32, customer: /АВТОДОР/ },
  torgi: { number: '21000021600000000117-3', open: true },
  rad: { number: '68046B1-4001-46-1', price: 977653.2, open: true },
};

for (const [id, exp] of Object.entries(EXPECT)) {
  test(`${byId[id].name}: разбор выдачи`, () => {
    const items = byId[id].parse(fixture(id));
    assert.ok(items.length >= 3, `${id}: ${items.length}`);
    for (const it of items) {
      assert.ok(it.number, `${id}: номер`);
      assert.ok(it.title && it.title.length > 3, `${id}: название`);
      assert.match(it.url, /^https:\/\//, `${id}: ссылка`);
    }
    const it = items.find((x) => x.number === exp.number);
    assert.ok(it, `${id}: нет ${exp.number} среди ${items.map((x) => x.number)}`);
    if (exp.eis) assert.match(it.eisNumber, /^\d{11}$|^\d{19}$/);
    if (exp.price) assert.equal(it.price, exp.price);
    if (exp.customer) assert.match(it.customer, exp.customer);
    if (exp.open) assert.equal(it.isOpen, true);
  });
}

test('ГИС Торги: дубли лотов в выдаче убираются', () => {
  const items = byId.torgi.parse(fixture('torgi'));
  assert.equal(new Set(items.map((i) => i.number)).size, items.length);
});

test('ТЭК-Торг: продажа имущества помечается категорией sale', () => {
  const items = byId.tektorg.parse(fixture('tektorg'));
  assert.equal(items.find((i) => i.number === 'ПИ607046').category, 'sale');
});

test('request(): ключевое слово, «только открытые» и диапазон цены', () => {
  const settings = { onlyOpen: true, priceMin: 100000, priceMax: 5000000 };
  const rq = (id) => byId[id].request({ keyword: 'труба', settings });
  const tek = new URL(rq('tektorg').url);
  assert.equal(tek.searchParams.get('name'), 'труба');
  assert.equal(tek.searchParams.get('status[]'), 'Приём заявок');
  assert.equal(tek.searchParams.get('sumPrice_start'), '100000');
  const rs = new URL(rq('roseltorg').url);
  assert.equal(rs.searchParams.get('query_field'), 'труба');
  assert.equal(rs.searchParams.get('end_price'), '5000000');
  const ets = new URL(rq('etpets').url);
  assert.equal(ets.searchParams.get('lot_status_id[]'), '25');
  assert.equal(ets.searchParams.get('contract_start_price[from]'), '100000');
  const avt = rq('avtodor');
  assert.equal(avt.method, 'POST');
  const data = JSON.parse(avt.body).data[0];
  assert.equal(data.query, 'труба');
  assert.equal(data.start_price_till, 5000000);
  const rf = rq('etprf');
  assert.equal(rf.method, 'POST');
  assert.equal(new URLSearchParams(rf.body).get('Filter.OrderName'), 'труба');
  const all = new URL(byId.roseltorg.request({ keyword: 'труба', settings: { onlyOpen: false } }).url);
  assert.equal(all.searchParams.get('status[]'), null);
});

test('toTender: номер ЕИС даёт общий id с карточкой ЕИС', () => {
  const t = toTender(byId.roseltorg, { number: '0328300032826000776', eisNumber: '0328300032826000776', title: 'Поставка труб', url: 'https://x/1', isOpen: true }, 'труба');
  assert.equal(t.id, 'notice:0328300032826000776');
  assert.equal(t.law, '44');
  assert.deepEqual(t.links, { roseltorg: 'https://x/1' });
  const own = toTender(byId.etprf, { number: 'EX1', title: 'Трубы', url: 'https://y' }, 'труба');
  assert.equal(own.id, 'etprf:EX1');
  assert.equal(own.law, 'other');
});

test('enabledPlatforms учитывает выключенные площадки', () => {
  const ids = enabledPlatforms({ platforms: { rad: false, torgi: false } }).map((p) => p.id);
  assert.equal(ids.length, 8);
  assert.ok(!ids.includes('rad'));
});

function fakeFetch(map) {
  return async (url) => {
    const host = new URL(url).hostname;
    const body = map[host];
    if (body instanceof Error) throw body;
    return { ok: body != null, status: body != null ? 200 : 404, text: async () => body ?? '' };
  };
}

test('PlatformsSource: фильтр по ключевому слову, законам и ошибки по площадкам', async () => {
  const source = new PlatformsSource({
    platforms: [byId.roseltorg, byId.etprf, byId.rad],
    delayMs: 0,
    log: {},
    fetchImpl: fakeFetch({
      'www.roseltorg.ru': fixture('roseltorg'),
      'web.etprf.ru': Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      'lot-online.ru': fixture('rad'),
    }),
  });
  const res = await source.collect({
    nomenclature: [{ keyword: 'труба' }, { keyword: '', okpd2: '24.20' }],
    settings: { laws: { fz44: true, fz223: true } },
  });
  assert.equal(res.queriesRun, 3);
  assert.ok(res.tenders.every((t) => /труб/i.test(t.title)));
  assert.ok(res.tenders.some((t) => t.id === 'notice:0328300032826000776'));
  assert.ok(res.tenders.some((t) => t.source === 'rad' && t.category === 'sale'));
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0].query, /ЭТП РФ · труба/);
  assert.match(res.errors[0].message, /ECONNREFUSED/);

  const no44 = await source.collect({ nomenclature: [{ keyword: 'труба' }], settings: { laws: { fz44: false, fz223: true } } });
  assert.ok(!no44.tenders.some((t) => t.law === '44'));
});

test('PlatformsSource: после двух сетевых сбоев подряд площадка пропускается', async () => {
  let calls = 0;
  const source = new PlatformsSource({
    platforms: [byId.etprf],
    delayMs: 0,
    log: {},
    fetchImpl: async () => {
      calls++;
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
  });
  const res = await source.collect({ nomenclature: ['а', 'б', 'в', 'г'].map((keyword) => ({ keyword })), settings: {} });
  assert.equal(calls, 2);
  assert.match(res.errors.at(-1).message, /пропущено запросов: 2/);
});

test('CombinedSource + Store: извещение из ЕИС и с площадки — одна карточка', async () => {
  const eisCard = {
    id: 'notice:0328300032826000776',
    source: 'zakupki',
    kind: 'notice',
    law: '44',
    number: '0328300032826000776',
    title: 'Поставка труб полимерных',
    price: 689055.48,
    stage: 'Подача заявок',
    isOpen: true,
    url: 'https://zakupki.gov.ru/epz/order/notice/ea20/view/common-info.html?regNumber=0328300032826000776',
    matches: [{ type: 'keyword', ref: 'труба', label: 'труба', strong: true }],
  };
  const combined = new CombinedSource([
    { collect: async () => ({ tenders: [eisCard], errors: [], queriesRun: 1 }) },
    new PlatformsSource({ platforms: [byId.roseltorg], delayMs: 0, log: {}, fetchImpl: fakeFetch({ 'www.roseltorg.ru': fixture('roseltorg') }) }),
    { collect: async () => { throw new Error('упал'); } },
  ]);
  const res = await combined.collect({ nomenclature: [{ keyword: 'труба' }], settings: {} });
  assert.equal(res.queriesRun, 2);
  assert.equal(res.errors.length, 1);

  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-plat-')), 'db.json'));
  const added = res.tenders.filter((t) => store.upsertTender(t));
  const card = store.tenders['notice:0328300032826000776'];
  assert.equal(added.filter((t) => t.id === card.id).length, 1);
  assert.equal(card.source, 'zakupki');
  assert.equal(card.url, eisCard.url);
  assert.equal(card.stage, 'Подача заявок');
  assert.deepEqual(Object.keys(card.links).sort(), ['roseltorg', 'zakupki']);

  card.seen = true;
  for (const t of res.tenders) store.upsertTender(t);
  assert.equal(card.seen, true, 'разные названия этапа у ЕИС и площадки не делают карточку новой');
});

test('Store.updateSettings: включение и выключение площадок', () => {
  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-plat-')), 'db.json'));
  const s = store.updateSettings({ platforms: { rad: false, unknown: true, torgi: 'нет' } });
  assert.equal(s.platforms.rad, false);
  assert.equal(s.platforms.torgi, true);
  assert.ok(!('unknown' in s.platforms));
});
