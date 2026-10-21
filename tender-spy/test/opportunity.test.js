import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichTender, scoreTender } from '../src/opportunity.js';

const NOW = Date.parse('2026-10-21T09:00:00Z');

function tender(overrides = {}) {
  return {
    id: 'notice:1',
    kind: 'notice',
    isOpen: true,
    title: 'Поставка трубы предизолированной',
    customer: 'АО «Теплосеть»',
    customerInn: '7810577007',
    price: 2_000_000,
    deadlineAt: '2026-11-05T09:00:00Z',
    publishedAt: '2026-10-20T09:00:00Z',
    url: 'https://zakupki.gov.ru/example',
    documents: { state: 'done' },
    matches: [{ type: 'keyword', ref: 'труба', label: 'труба', strong: true }],
    ...overrides,
  };
}

test('scoreTender высоко оценивает подтверждённую открытую закупку с запасом времени', () => {
  const related = [tender({ id: 'notice:2' }), tender({ id: 'notice:3', kind: 'contract' })];
  const result = scoreTender(tender(), {
    tenders: [tender(), ...related],
    settings: { priceMin: 500_000, priceMax: 5_000_000 },
    now: NOW,
  });

  assert.equal(result.level, 'high');
  assert.ok(result.score >= 80, `score=${result.score}`);
  assert.equal(result.daysLeft, 15);
  assert.equal(result.customerHistory.count, 2);
  assert.match(result.reasons.join(' '), /номенклатурой/);
});

test('scoreTender снижает закрытую закупку со слабым совпадением и без цены', () => {
  const result = scoreTender(
    tender({
      isOpen: false,
      deadlineAt: '2026-10-01T09:00:00Z',
      price: null,
      documents: { state: 'error' },
      matches: [{ type: 'keyword', ref: 'труба', label: 'труба', strong: false }],
    }),
    { tenders: [], settings: {}, now: NOW },
  );

  assert.equal(result.level, 'low');
  assert.ok(result.score < 35, `score=${result.score}`);
  assert.match(result.risks.join(' '), /Подача заявок завершена/);
});

test('enrichTender добавляет чек-лист рассмотрения с состоянием воронки', () => {
  const result = enrichTender(tender(), {
    tenders: [tender()],
    deal: { stage: 'study', ownerId: 'u_1', nextStep: 'Проверить ТЗ', bid: null },
    now: NOW,
  });
  const byId = Object.fromEntries(result.opportunity.checklist.map((item) => [item.id, item]));

  assert.equal(byId.fit.status, 'done');
  assert.equal(byId.documents.status, 'done');
  assert.equal(byId.ownership.status, 'done');
  assert.equal(byId.economics.status, 'warn');
});
