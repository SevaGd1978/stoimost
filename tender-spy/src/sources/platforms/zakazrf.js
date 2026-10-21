/**
 * АГЗ РТ (etp.zakazrf.ru) — сводный реестр извещений 44-ФЗ и 223-ФЗ.
 * Фильтр передаётся в GET: Filter=1&OrderName=…, новые извещения первыми.
 */
import { parseOrmTable } from './orm-table.js';

const BASE = 'https://etp.zakazrf.ru';

export default {
  id: 'zakazrf',
  name: 'АГЗ РТ',
  site: BASE,
  category: 'purchase',
  request({ keyword }) {
    const url = new URL('/NotificationEx', BASE);
    url.searchParams.set('Filter', '1');
    url.searchParams.set('OrderName', keyword);
    return { url: url.toString() };
  },
  parse(body) {
    return parseOrmTable(body, BASE);
  },
};
