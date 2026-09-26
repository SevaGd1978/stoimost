/**
 * ЭТП РФ (web.etprf.ru) — реестр коммерческих закупок. Таблица грузится
 * AJAX-запросом движка ORM grid; сортировка по дате размещения, новые первыми.
 */
import { parseOrmTable } from './orm-table.js';

const BASE = 'https://web.etprf.ru';
const PAGE_ID = '5FBADDEA1C0C5627';

export default {
  id: 'etprf',
  name: 'ЭТП РФ',
  site: BASE,
  category: 'purchase',
  request({ keyword }) {
    const url = new URL('/NotificationCR', BASE);
    url.searchParams.set('Filter', '1');
    url.searchParams.set('OrderName', keyword);
    url.searchParams.set('IsPartialView', '1');
    url.searchParams.set('IsTableContentOnlyRequest', '1');
    const form = new URLSearchParams({
      _orm_PageID: PAGE_ID,
      'Filter.OrderName': keyword,
      [`SortColumn${PAGE_ID}`]: 'PublicationDateTime',
      [`SortColumnDesc${PAGE_ID}`]: '1',
      [`PageNumber${PAGE_ID}`]: '1',
      [`PageSize${PAGE_ID}`]: '20',
    });
    return {
      url: url.toString(),
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: form.toString(),
    };
  },
  parse(body) {
    return parseOrmTable(body, BASE);
  },
};
