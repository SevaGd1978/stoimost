/**
 * Разбор реестров на общем движке «ORM grid» (АГЗ РТ, ЭТП РФ):
 * <table id="TableList…"> с заголовком из <th>, колонки ищем по названию.
 */
import { firstHref, htmlText, openByDeadline, parseMoney, parseRuDateTime, tableCells } from './util.js';

export function parseOrmTable(html, base) {
  const m = String(html).match(/<table[^>]*id="TableList[^"]*"[^>]*>([\s\S]*?)<\/table>/);
  if (!m) throw new Error('нет таблицы реестра');
  const rows = m[1].match(/<tr\b[\s\S]*?<\/tr>/g) || [];
  const headerRow = rows.find((r) => /<th\b/i.test(r));
  if (!headerRow) throw new Error('нет заголовка таблицы реестра');
  const headers = [...headerRow.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((h) => htmlText(h[1]).replace(/\*+$/, '').toLowerCase());
  const col = (...names) => headers.findIndex((h) => names.some((n) => h.startsWith(n)));
  const idx = {
    law: col('фз'),
    number: col('номер'),
    stage: col('состояние', 'статус'),
    method: col('способ', 'тип процедуры'),
    title: col('предмет'),
    price: col('начальная цена'),
    organizer: col('организатор'),
    customer: col('заказчик'),
    published: col('дата размещения'),
    deadline: col('дата и время окончания срока подачи'),
  };
  return rows
    .filter((r) => r !== headerRow && !/<th\b/i.test(r))
    .map((row) => {
      const cells = tableCells(row);
      const get = (i) => (i >= 0 && cells[i] ? cells[i].text : '');
      const number = get(idx.number);
      const title = get(idx.title);
      if (!number || !title) return null;
      const link = (idx.number >= 0 && firstHref(cells[idx.number].html, base)) || firstHref(cells.map((c) => c.html).join(' '), base);
      const deadlineAt = parseRuDateTime(get(idx.deadline));
      const stage = get(idx.stage) || null;
      const byDeadline = openByDeadline(deadlineAt);
      return {
        number,
        eisNumber: /^\d{11}$|^\d{19}$/.test(number) ? number : null,
        title,
        customer: get(idx.customer) || get(idx.organizer) || null,
        price: parseMoney(get(idx.price)),
        publishedAt: parseRuDateTime(get(idx.published)),
        deadlineAt,
        stage: stage || (byDeadline === true ? 'Приём заявок' : null),
        isOpen: stage && /отмен|заверш|итог|рассмотр/i.test(stage) ? false : byDeadline,
        method: get(idx.method) || null,
        law: get(idx.law) || null,
        url: link,
      };
    })
    .filter(Boolean);
}
