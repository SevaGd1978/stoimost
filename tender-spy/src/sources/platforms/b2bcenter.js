/**
 * B2B-Center (b2b-center.ru), поиск по рынку. По умолчанию выдача содержит
 * только актуальные процедуры (архив — отдельная вкладка show=archive).
 * Цены в списке нет — её отсекает общий фильтр по известной цене.
 */
import { htmlText, openByDeadline, parseRuDateTime, tableCells, tableRows } from './util.js';

const BASE = 'https://www.b2b-center.ru';

export default {
  id: 'b2bcenter',
  name: 'B2B-Center',
  site: BASE,
  category: 'purchase',
  request({ keyword }) {
    const url = new URL('/market/', BASE);
    url.searchParams.set('f_keyword', keyword);
    url.searchParams.set('searching', '1');
    return { url: url.toString() };
  },
  parse(body) {
    const html = String(body);
    const m = html.match(/<table[^>]*class="[^"]*search-results[^"]*"[^>]*>([\s\S]*?)<\/table>/);
    if (!m) {
      if (/ничего не найдено/i.test(html)) return [];
      throw new Error('нет таблицы результатов');
    }
    return tableRows(m[1])
      .map((row) => {
        const cells = tableCells(row);
        if (cells.length < 4) return null;
        const link = cells[0].html.match(/<a[^>]*href="([^"]+)"[^>]*class="[^"]*search-results-title[^"]*"[^>]*>([\s\S]*?)<\/a>/);
        if (!link) return null;
        const head = htmlText(link[2].replace(/<div class="search-results-title-desc">[\s\S]*$/, ''));
        const number = (head.match(/№\s*(\d+)/) || [])[1];
        if (!number) return null;
        const desc = htmlText((link[2].match(/<div class="search-results-title-desc">([\s\S]*?)<\/div>/) || [])[1] || '');
        const deadlineAt = parseRuDateTime(cells[3].text);
        const url = new URL(link[1].replace(/&amp;/g, '&'), BASE);
        url.hash = '';
        return {
          number,
          title: desc || head,
          customer: cells[1].text || null,
          price: null,
          publishedAt: parseRuDateTime(cells[2].text),
          deadlineAt,
          stage: 'Приём предложений',
          isOpen: openByDeadline(deadlineAt) ?? true,
          method: head.replace(/№\s*\d+.*/, '').trim() || null,
          url: url.toString(),
        };
      })
      .filter(Boolean);
  },
};
