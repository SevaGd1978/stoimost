import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, formatReminderMessage, leftText, markReminded } from '../src/reminders.js';
import { Scheduler } from '../src/scheduler.js';

const now = Date.parse('2026-10-01T09:00:00Z');
const inDays = (d) => new Date(now + d * 86_400_000).toISOString();
const fav = (id, deadlineAt, extra = {}) => ({ id, kind: 'notice', favorite: true, isOpen: true, title: `Закупка ${id}`, url: `https://x/${id}`, deadlineAt, ...extra });

test('dueReminders: за 3 дня и за 1 день, по одному разу на порог', () => {
  const tenders = {
    a: fav('a', inDays(2.5)),
    b: fav('b', inDays(0.5)),
    c: fav('c', inDays(10)),
    d: fav('d', inDays(-1)),
    e: fav('e', inDays(2), { favorite: false }),
    f: fav('f', inDays(2), { isOpen: false }),
    g: fav('g', null),
  };
  const due = dueReminders(tenders, now);
  assert.deepEqual(due.map((d) => [d.tender.id, d.threshold]), [['b', 1], ['a', 3]]);
  for (const d of due) markReminded(d.tender, d.threshold, now);
  assert.deepEqual(dueReminders(tenders, now), []);
  assert.ok(tenders.b.reminded[3], 'после «1 дня» запоздалое «3 дня» не придёт');

  // На следующий день «a» подходит к порогу «1 день».
  const later = now + 1.6 * 86_400_000;
  assert.deepEqual(dueReminders(tenders, later).map((d) => [d.tender.id, d.threshold]), [['a', 1]]);
});

test('formatReminderMessage и склонение дней', () => {
  assert.equal(leftText(1), 'меньше суток');
  assert.equal(leftText(2), '2 дня');
  assert.equal(leftText(5), '5 дней');
  assert.equal(leftText(21), '21 день');
  const text = formatReminderMessage([{ tender: fav('a', '2026-10-03T10:00:00Z', { comment: 'КП <готово>' }), left: 2 }]);
  assert.match(text, /скоро окончание подачи по избранным — 1/);
  assert.match(text, /подача до 03\.10\.2026, 13:00 МСК — осталось 2 дня/);
  assert.match(text, /📝 КП &lt;готово&gt;/);
});

test('Scheduler.checkReminders: событие и Telegram, если включён', () => {
  const sent = [];
  const store = { tenders: { a: fav('a', inDays(1)) }, settings: { notifyTelegram: true }, scheduleSave() {} };
  const s = new Scheduler({ store, source: {}, notifier: { enabled: true, send: async (t) => sent.push(t) }, log: { warn() {} } });
  const events = [];
  s.on('reminders', (d) => events.push(d.length));
  assert.equal(s.checkReminders(now).length, 1);
  assert.equal(s.checkReminders(now).length, 0);
  assert.deepEqual(events, [1]);
  assert.equal(sent.length, 1);
});
