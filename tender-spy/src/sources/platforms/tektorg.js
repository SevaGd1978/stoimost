/**
 * ТЭК-Торг (tektorg.ru). Страница поиска — Next.js: выдача лежит в JSON
 * <script id="__NEXT_DATA__"> → props.pageProps.initialReduxState.listingProcedures.
 * Параметры взяты из фильтров сайта: name — поиск, status[] — стадия,
 * sumPrice_start/sumPrice_end — цена, sort=datePublished_desc — новые первыми.
 */
import { parseIsoDate, parseMoney } from './util.js';

const BASE = 'https://www.tektorg.ru';
const SALE_SECTIONS = new Set(['sale', 'sale178', 'rosneft_selling', 'arrested_sale', 'sale_arrest']);

export default {
  id: 'tektorg',
  name: 'ТЭК-Торг',
  site: BASE,
  category: 'purchase',
  request({ keyword, settings }) {
    const url = new URL('/procedures', BASE);
    url.searchParams.set('name', keyword);
    url.searchParams.set('sort', 'datePublished_desc');
    if (settings.onlyOpen !== false) url.searchParams.append('status[]', 'Приём заявок');
    if (settings.priceMin != null) url.searchParams.set('sumPrice_start', String(Math.floor(settings.priceMin)));
    if (settings.priceMax != null) url.searchParams.set('sumPrice_end', String(Math.ceil(settings.priceMax)));
    return { url: url.toString() };
  },
  parse(body) {
    const m = String(body).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('нет блока __NEXT_DATA__ — сайт изменил вёрстку');
    const data = JSON.parse(m[1]);
    const list = data?.props?.pageProps?.initialReduxState?.listingProcedures?.data;
    if (!Array.isArray(list)) throw new Error('в __NEXT_DATA__ нет listingProcedures');
    return list.map((p) => {
      const stage = p.statusName || (p.statusLots || [])[0] || '';
      return {
        number: String(p.registryNumber || p.id),
        title: p.title,
        customer: p.organizerName || null,
        customerInn: p.inn || null,
        price: parseMoney(p.sumPrice),
        publishedAt: parseIsoDate(p.dates?.datePublished),
        deadlineAt: parseIsoDate(p.dates?.dateEndRegistration),
        stage,
        isOpen: /при[её]м заявок/i.test(stage),
        method: p.typeName || null,
        url: `${BASE}/${p.sectionAlias || 'procedures'}/procedures/${p.id}`,
        category: SALE_SECTIONS.has(p.sectionAlias) ? 'sale' : 'purchase',
      };
    });
  },
};
