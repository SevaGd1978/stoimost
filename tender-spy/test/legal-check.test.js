import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legalCheckUrl } from '../src/legal-check.js';

test('юридическая проверка: карточка Saby по ИНН заказчика', () => {
  assert.equal(legalCheckUrl({ customerInn: '6315376946', customer: 'ПАО «Т Плюс»' }), 'https://sbis.ru/contragents/6315376946');
  assert.equal(legalCheckUrl({ customerInn: 'ИНН 7810577007' }), 'https://sbis.ru/contragents/7810577007');
  assert.equal(legalCheckUrl({ customer: 'ГУП «ТЭК СПб», ИНН 7830001028' }), 'https://sbis.ru/contragents/7830001028');
  assert.equal(legalCheckUrl({ customerInn: '123', customer: 'ООО Ромашка' }), 'https://checko.ru/search?query=%D0%9E%D0%9E%D0%9E%20%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0');
  assert.equal(legalCheckUrl({}), '');
});
