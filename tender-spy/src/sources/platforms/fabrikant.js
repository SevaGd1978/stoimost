/**
 * Фабрикант (fabrikant.ru), единый поиск закупок. Страница — Next.js с
 * потоковой отрисовкой (RSC): карточки приходят строками
 * self.__next_f.push([1, "…"]), их склеиваем и разбираем регулярками.
 */
import { openByDeadline, parseMoney, parseRuDateTime } from './util.js';

const BASE = 'https://www.fabrikant.ru';
const JSON_STR = '"((?:[^"\\\\]|\\\\.)*)"';

function unescapeJson(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function rscPayload(html) {
  const re = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g;
  let out = '';
  let m;
  while ((m = re.exec(html))) {
    try {
      out += JSON.parse(m[1]);
    } catch {
      /* обрывки служебных чанков пропускаем */
    }
  }
  return out;
}

function labelled(card, label) {
  const re = new RegExp(`"children":"${label}"\\}\\],\\["\\$","div",null,\\{[^{}]*"children":"([^"]+)"\\}`);
  return (card.match(re) || [])[1] || null;
}

export default {
  id: 'fabrikant',
  name: 'Фабрикант',
  site: BASE,
  category: 'purchase',
  request({ keyword }) {
    const url = new URL('/procedure/search/purchases', BASE);
    url.searchParams.set('query', keyword);
    return { url: url.toString() };
  },
  parse(body) {
    const html = String(body);
    if (!html.includes('self.__next_f')) throw new Error('нет данных Next.js — сайт изменил вёрстку');
    let rsc = rscPayload(html);
    const refs = new Map();
    for (const d of rsc.matchAll(/(?:^|\n)([0-9a-f]+):(\[[^\n]*)/g)) refs.set(d[1], d[2]);
    if (refs.size) rsc = rsc.replace(/"\$L([0-9a-f]+)"/g, (m, id) => refs.get(id) ?? m);
    return rsc
      .split(/"data-id":(?=\d+,"children")/)
      .slice(1)
      .map((card) => {
        const num = card.match(/"children":"([^"]+)"\}\],\["\$","span",null,\{[^{}]*"children":\["№ ",(\d+),"(-\d+)?"\]/);
        const link = card.match(new RegExp(`\\{"url":${JSON_STR},"name":${JSON_STR}`));
        if (!link) return null;
        const number = num ? `${num[2]}${num[3] || ''}` : (card.match(/^(\d+)/) || [])[1];
        const oos = (card.match(/"oosNumber":"(\d+)"/) || [])[1] || null;
        const badges = [...card.matchAll(/"data-slot":"badge"[^{}]*"children":"([^"]+)"/g)].map((b) => b[1]);
        const stage = badges.find((b) => /при[её]м|заверш|отмен|рассмотр|подвед|торги/i.test(b)) || null;
        const law = badges.find((b) => /ФЗ/.test(b)) || null;
        const organizer = card.match(new RegExp(`"children":"Организатор"\\}\\],\\["\\$","\\$L[0-9a-z]+",null,\\{"name":${JSON_STR}`));
        const deadlineAt = parseRuDateTime(labelled(card, 'Дата окончания при[её]ма заявок'));
        const price = card.match(/"children":\["([\d\s\u00a0.,]+)","\$L/);
        return {
          number,
          eisNumber: oos,
          title: unescapeJson(link[2]),
          customer: organizer ? unescapeJson(organizer[1]) : null,
          price: price ? parseMoney(price[1]) : null,
          publishedAt: parseRuDateTime(labelled(card, 'Дата публикации')),
          deadlineAt,
          stage,
          isOpen: stage ? /при[её]м заявок/i.test(stage) : openByDeadline(deadlineAt),
          method: num ? num[1] : null,
          law,
          url: unescapeJson(link[1]),
        };
      })
      .filter(Boolean);
  },
};
