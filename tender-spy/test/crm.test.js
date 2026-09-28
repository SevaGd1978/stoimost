import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { presentDeal } from '../src/crm.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tender-spy-crm-')), 'db.json');
}

const actor = { id: 'u_admin', name: 'Админ' };
const tender = (id, extra = {}) => ({
  id,
  source: extra.source || 'zakupki',
  kind: 'notice',
  law: '44',
  number: id.split(':')[1] || id,
  title: extra.title || 'Поставка труб',
  customer: 'АО Заказчик',
  price: 1_500_000,
  stage: 'Подача заявок',
  isOpen: true,
  url: 'https://example.org/t',
  matches: [{ type: 'keyword', ref: 'труба', label: 'труба' }],
  ...extra,
});

test('воронка: закупка становится избранной, этап и ответственный пишутся в историю', () => {
  const store = new Store(tmpFile());
  store.upsertTender(tender('notice:1'));
  store.createUser({ login: 'admin', name: 'Админ', password: 'password1', role: 'admin' });
  const clerk = store.createUser({ login: 'clerk', name: 'Сотрудник', password: 'password1', role: 'employee' });
  const opened = store.openDeal('notice:1', actor);
  assert.equal(opened.created, true);
  assert.equal(store.tenders['notice:1'].favorite, true);
  assert.equal(store.openDeal('notice:1', actor).created, false);
  assert.equal(Object.keys(store.deals).length, 1);

  const moved = store.updateDeal('notice:1', { stage: 'proposal', ownerId: clerk.id, bid: '2 000 000', nextStep: 'Сверить ТЗ', nextStepAt: '2026-10-05' }, actor);
  assert.equal(moved.stage, 'proposal');
  assert.equal(moved.bid, 2_000_000);
  assert.equal(moved.nextStepAt, '2026-10-05');
  assert.ok(moved.activities.some((a) => a.text === 'Этап: Готовим заявку'));
  assert.ok(moved.activities.some((a) => a.text === 'Ответственный: Сотрудник'));

  store.addDealNote('notice:1', 'Заказчик просит КП до пятницы', actor);
  assert.match(store.deals['notice:1'].activities.at(-1).text, /КП/);
  assert.throws(() => store.addDealNote('notice:1', '  ', actor), /комментарий/);
  assert.throws(() => store.updateDeal('notice:1', { stage: 'nope' }, actor), /этап/);
  assert.throws(() => store.updateDeal('notice:1', { ownerId: 'u_missing' }, actor), /сотрудника/);
  assert.throws(() => store.updateDeal('notice:1', { bid: 'не число' }, actor), /предложения/);

  const view = presentDeal(moved, { tender: store.tenders['notice:1'], owner: clerk });
  assert.equal(view.ownerName, 'Сотрудник');
  assert.equal(view.card.title, 'Поставка труб');
  assert.equal(JSON.stringify(view).includes('password'), false);

  assert.equal(store.removeDeal('notice:1'), true);
  assert.equal(store.deals['notice:1'], undefined);
});

test('воронка переезжает на карточку ЕИС и не даёт удалить открытую сделку при очистке', () => {
  const store = new Store(tmpFile());
  const b2b = tender('b2bcenter:4613943', {
    source: 'b2bcenter',
    law: 'other',
    number: '4613943',
    title: 'Поставка фасонных изделий в ППУ изоляции',
    url: 'https://b2b/4613943',
    links: { b2bcenter: 'https://b2b/4613943' },
  });
  store.upsertTender(b2b);
  store.openDeal(b2b.id, actor);
  store.upsertTender(tender('notice:32616404967', {
    source: 'zakupki',
    law: '223',
    number: '32616404967',
    title: 'Поставка фасонных изделий в ППУ изоляции (4613943)',
  }));
  assert.equal(store.deals[b2b.id], undefined);
  assert.equal(store.deals['notice:32616404967'].stage, 'selected');

  store.upsertTender(tender('notice:old'));
  store.tenders['notice:old'].favorite = false;
  store.tenders['notice:old'].lastSeenAt = '2020-01-01T00:00:00.000Z';
  store.openDeal('notice:old', actor);
  store.tenders['notice:old'].favorite = false;
  store.upsertTender(tender('notice:won'));
  store.tenders['notice:won'].favorite = false;
  store.tenders['notice:won'].lastSeenAt = '2020-01-01T00:00:00.000Z';
  store.openDeal('notice:won', actor);
  store.updateDeal('notice:won', { stage: 'won' }, actor);
  store.tenders['notice:won'].favorite = false;
  const removed = store.prune(30);
  assert.equal(removed, 1);
  assert.ok(store.tenders['notice:old']);
  assert.equal(store.tenders['notice:won'], undefined);
});
