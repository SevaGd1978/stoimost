/**
 * Росэлторг (roseltorg.ru), общий поиск по всем секциям площадки.
 * Выдача — HTML-карточки .search-results__item. status[]=0 — «Приём заявок»,
 * start_price / end_price — диапазон НМЦ.
 */
import { decodeHtml, firstHref, htmlText, parseMoney, parseRuDateTime } from './util.js';

const BASE = 'https://www.roseltorg.ru';
const ITEM_MARK = '<div class="search-results__item autoload-post';

function block(html, cls) {
  const re = new RegExp(`<(div|p|time)[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, 'i');
  const m = html.match(re);
  return m ? m[2] : '';
}

export default {
  id: 'roseltorg',
  name: 'Росэлторг',
  site: BASE,
  category: 'purchase',
  request({ keyword, settings }) {
    const url = new URL('/procedures/search', BASE);
    url.searchParams.set('query_field', keyword);
    if (settings.onlyOpen !== false) url.searchParams.append('status[]', '0');
    if (settings.priceMin != null) url.searchParams.set('start_price', String(Math.floor(settings.priceMin)));
    if (settings.priceMax != null) url.searchParams.set('end_price', String(Math.ceil(settings.priceMax)));
    return { url: url.toString() };
  },
  parse(body) {
    const html = String(body);
    if (!html.includes('search-results')) throw new Error('нет блока результатов поиска');
    return html
      .split(ITEM_MARK)
      .slice(1)
      .map((raw) => {
        const item = raw.replace(/<div class="search-results__tags[\s\S]*?(?=<p class="search-results__type|<div class="search-results__data)/g, '');
        const number = (item.match(/data-feature-favorite-lots-procedure-number="([^"]+)"/) || [])[1];
        const lot = (item.match(/data-feature-favorite-lots-lot-number="([^"]+)"/) || [])[1];
        if (!number) return null;
        const subject = block(item, 'search-results__subject');
        const sum = block(item, 'search-results__sum');
        const priceText = (sum.match(/<p class="desktop">([\s\S]*?)<\/p>/) || [])[1] ?? sum;
        const statusText = (item.match(/class="search-results__status\b[^"]*">\s*(?:<div class="search-results__status-dot"><\/div>)?([^<]*)/) || [])[1];
        const stage = htmlText(statusText).replace(/\s*\d+\s*дн\.?$/, '').trim();
        const customerBlock = (item.match(/class="search-results__customer">([\s\S]*?)<\/p>/) || [])[1] || '';
        const customer = htmlText((customerBlock.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
        const section = htmlText((item.match(/class="search-results__section">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
        const inn = (customerBlock.match(/\/companies\/resolve\/(\d{10,12})\//) || decodeHtml(customerBlock).match(/ИНН\s*(\d{10,12})/) || [])[1] || null;
        return {
          number: lot && lot !== '1' ? `${number}-${lot}` : number,
          eisNumber: /^\d{11}$|^\d{19}$/.test(number) ? number : null,
          title: htmlText(subject),
          customer: customer || null,
          customerInn: inn,
          price: parseMoney(htmlText(priceText.replace(/<sub>/g, ',').replace(/<\/sub>/g, ''))),
          deadlineAt: parseRuDateTime(htmlText(block(item, 'search-results__time'))),
          stage: stage || null,
          isOpen: stage ? /при[её]м заявок/i.test(stage) : null,
          method: htmlText((item.match(/<p class="search-results__type">([\s\S]*?)<\/p>/) || [])[1] || '') || null,
          region: htmlText(block(item, 'search-results__region')) || null,
          category: /имуществ|продаж|реализац|приватизац/i.test(section) ? 'sale' : 'purchase',
          url: firstHref(subject, BASE),
        };
      })
      .filter(Boolean);
  },
};
