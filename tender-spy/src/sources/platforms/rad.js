/**
 * Российский аукционный дом / Lot-online (lot-online.ru) — продажа имущества.
 * В витрину попадают только лоты, открытые для участия; срока подачи
 * в выдаче нет, поэтому лот считается открытым.
 */
import { decodeHtml, htmlText, parseMoney } from './util.js';

const BASE = 'https://lot-online.ru';
const CATALOG = 'https://catalog.lot-online.ru';
const ITEM_MARK = '<div class="ty-grid-list__item ty-quick-view-button__wrapper">';

export default {
  id: 'rad',
  name: 'РАД (Lot-online)',
  site: BASE,
  category: 'sale',
  request({ keyword }) {
    const url = new URL('/index.php', BASE);
    url.searchParams.set('dispatch', 'products.search');
    url.searchParams.set('q', keyword);
    url.searchParams.set('search_performed', 'Y');
    return { url: url.toString() };
  },
  parse(body) {
    const html = String(body);
    const items = html.split(ITEM_MARK).slice(1);
    if (!items.length && !/ty-no-items|ничего не найдено|products\.search/i.test(html)) {
      throw new Error('нет витрины лотов');
    }
    return items
      .map((item) => {
        const link = item.match(/href="([^"]*product_id=(\d+)[^"]*)"\s+class="product-title"\s+title="([^"]*)"/);
        if (!link) return null;
        const code = htmlText((item.match(/<span class="ty-grid-list__product-code">([\s\S]*?)<\/span>/) || [])[1] || '');
        const price = (item.match(/class="ty-price-num">([^<]+)</) || [])[1];
        return {
          number: code || link[2],
          title: decodeHtml(link[3]).trim(),
          customer: null,
          price: parseMoney(price),
          deadlineAt: null,
          stage: 'Приём заявок',
          isOpen: true,
          method: 'Аукцион / торги по продаже имущества',
          url: `${CATALOG}/index.php?dispatch=products.view&product_id=${link[2]}`,
        };
      })
      .filter(Boolean);
  },
};
