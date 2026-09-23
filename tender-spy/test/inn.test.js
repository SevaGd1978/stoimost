import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidInn, normalizeInn } from '../src/inn.js';

test('валидные ИНН юрлиц проходят проверку', () => {
  for (const inn of ['6679104561', '7810577007', '6679037273', '7838129301']) {
    assert.equal(isValidInn(inn), true, inn);
  }
});

test('валидный 12-значный ИНН физлица/ИП', () => {
  assert.equal(isValidInn('370205114072'), true);
});

test('неверная контрольная сумма и длина отклоняются', () => {
  assert.equal(isValidInn('6679104560'), false);
  assert.equal(isValidInn('123456789'), false);
  assert.equal(isValidInn('12345678901'), false);
  assert.equal(isValidInn(''), false);
});

test('normalizeInn убирает всё, кроме цифр', () => {
  assert.equal(normalizeInn(' 6679-104561 '), '6679104561');
});
