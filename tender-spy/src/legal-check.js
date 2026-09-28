/**
 * Ссылка на бесплатную карточку проверки заказчика.
 * По ИНН открывается карточка Saby (sbis.ru): надёжность, выручка, долги,
 * суды и исполнительные производства без входа. Если ИНН ещё нет — поиск по названию на Чекко.
 */
export function legalCheckUrl(tender = {}) {
  const inn = innOf(tender.customerInn) || innOf(tender.customer);
  if (inn) return `https://sbis.ru/contragents/${inn}`;
  const name = String(tender.customer || '').replace(/\s+/g, ' ').trim();
  if (name) return `https://checko.ru/search?query=${encodeURIComponent(name)}`;
  return '';
}

function innOf(value) {
  const digits = String(value || '').match(/\b(\d{10}|\d{12})\b/);
  return digits ? digits[1] : '';
}
