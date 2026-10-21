import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCustomerVolume, contractRssUrl, sameCustomer } from '../src/procurement.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsRss = fs.readFileSync(path.join(here, 'fixtures', 'contracts.rss.xml'), 'utf8');

const other = `
    <item>
      <title>№ 1770000000026000001</title>
      <link>https://zakupki.gov.ru/epz/contract/contractCard/common-info.html?reestrNumber=1770000000026000001</link>
      <description><![CDATA[<b>Предмет контракта:</b> Канцтовары<br/><b>Заказчик:</b> ООО "Чужой" (ИНН 7707083893)<br/><b>Цена контракта:</b> 99 000,00<br/><b>Дата заключения контракта:</b> 01.03.2024<br/>]]></description>
      <pubDate>Sun, 01 Mar 2024 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const mixedRss = contractsRss.replace('</channel>', other);

const localContract = {
  id: 'contract:local1',
  kind: 'contract',
  number: '2781057700726000099',
  customer: 'АО "ТЕПЛОСЕТЬ САНКТ-ПЕТЕРБУРГА" (ИНН 7810577007)',
  customerInn: '7810577007',
  price: 1_000_000,
  publishedAt: '2024-06-15T09:00:00.000Z',
  title: 'Локальный контракт',
};

test('объём закупок: RSS ЕИС по ИНН, чужой заказчик отбрасывается, локальный контракт добавляется', async () => {
  const url = contractRssUrl('7810577007');
  assert.match(url, /\/epz\/contract\/search\/rss\.html/);
  assert.match(url, /customerInn=7810577007/);
  assert.match(url, /fz44=on/);
  assert.doesNotMatch(url, /supplierInn/);

  let asked = '';
  const report = await collectCustomerVolume({
    inn: '7810577007',
    name: 'АО "ТЕПЛОСЕТЬ САНКТ-ПЕТЕРБУРГА"',
    tenders: [localContract, { ...localContract, number: '2781057700726000045', price: 9_999_999, title: 'дубль ЕИС' }],
    fetchXml: async (got) => {
      asked = got;
      return mixedRss;
    },
  });

  assert.equal(asked, url);
  assert.equal(report.basis, 'contracts');
  assert.equal(report.customer.inn, '7810577007');
  assert.deepEqual(
    report.series.map((row) => [row.year, row.count, row.sum]),
    [
      [2024, 1, 1_000_000],
      [2025, 0, 0],
      [2026, 1, 4_500_000],
    ],
  );
  assert.equal(report.total.sum, 5_500_000);
  assert.equal(report.total.count, 2);
  assert.equal(report.sources.find((s) => s.id === 'eis').count, 1);
  assert.match(report.note, /50/);
  assert.match(report.note, /не суммируются дважды/);
  assert.match(report.registryUrl, /customerInn=7810577007/);
  assert.equal(report.items[0].price, 4_500_000);
});

test('объём закупок: без контрактов график строится по НМЦК извещений', async () => {
  const report = await collectCustomerVolume({
    inn: '7810577007',
    tenders: [
      {
        kind: 'notice',
        number: '0326200000126000001',
        customerInn: '7810577007',
        customer: 'Теплосеть',
        price: 200_000,
        publishedAt: '2025-01-10T09:00:00.000Z',
        title: 'Извещение',
      },
      {
        kind: 'notice',
        number: '1',
        customerInn: '7707083893',
        customer: 'Чужой',
        price: 50,
        publishedAt: '2025-01-10T09:00:00.000Z',
        title: 'Не этот',
      },
    ],
    fetchXml: async () => '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>',
  });
  assert.equal(report.basis, 'notices');
  assert.equal(report.total.sum, 200_000);
  assert.equal(report.total.count, 1);
  assert.match(report.note, /начальные цены/);
});

test('объём закупок: сбой ЕИС не прячет уже найденные контракты', async () => {
  const report = await collectCustomerVolume({
    inn: '7810577007',
    tenders: [localContract],
    fetchXml: async () => {
      throw new Error('HTTP 503');
    },
  });
  assert.equal(report.total.sum, 1_000_000);
  assert.match(report.warning, /HTTP 503/);
  assert.equal(report.sources.find((s) => s.id === 'eis').ok, false);
});

test('объём закупок: демо не ходит в сеть, без ИНН ищет по названию в ленте', async () => {
  let called = false;
  const demo = await collectCustomerVolume({
    inn: '7810577007',
    tenders: [localContract],
    mode: 'demo',
    fetchXml: async () => {
      called = true;
      return contractsRss;
    },
  });
  assert.equal(called, false);
  assert.equal(demo.total.sum, 1_000_000);
  assert.match(demo.sources.find((s) => s.id === 'eis').note, /Демо-режим/);
  assert.match(demo.registryUrl, /7810577007/);

  const byName = await collectCustomerVolume({
    name: 'ПАО «Т Плюс»',
    tenders: [
      { kind: 'notice', number: '9', customer: 'ПАО «Т Плюс»', price: 10, publishedAt: '2026-02-02T09:00:00.000Z', title: 'наш' },
      { kind: 'notice', number: '8', customer: 'АО «Теплосеть Санкт-Петербурга»', price: 99, publishedAt: '2026-02-02T09:00:00.000Z', title: 'чужой' },
    ],
    fetchXml: async () => {
      called = true;
      return '';
    },
  });
  assert.equal(called, false);
  assert.equal(byName.customer.inn, '');
  assert.equal(byName.total.count, 1);
  assert.equal(byName.total.sum, 10);
  assert.equal(sameCustomer({ customer: 'ООО Ромашка' }, { name: 'ПАО «Т Плюс»' }), false);
});

test('объём закупок: пустой запрос отклоняется', async () => {
  await assert.rejects(() => collectCustomerVolume({}), /Нужен ИНН или название/);
});
