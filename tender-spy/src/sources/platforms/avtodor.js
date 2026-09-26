/**
 * ЭТП «Автодор-ТП» (tenders.etp-avtodor.ru). Публичный реестр — Ext.Direct:
 * POST index.php?rpctype=direct&module=default, метод Procedure.list,
 * query — поиск, start_price_from / start_price_till — диапазон цены.
 * Стадию площадка отдаёт кодом, поэтому открытость считаем по сроку подачи.
 */
import { openByDeadline, parseIsoDate, parseMoney } from './util.js';

const BASE = 'https://tenders.etp-avtodor.ru';

export default {
  id: 'avtodor',
  name: 'Автодор-ТП',
  site: BASE,
  category: 'purchase',
  request({ keyword, settings }) {
    const data = { sort: 'id', dir: 'DESC', query: keyword, limit: 50, start: 0 };
    if (settings.priceMin != null) data.start_price_from = Math.floor(settings.priceMin);
    if (settings.priceMax != null) data.start_price_till = Math.ceil(settings.priceMax);
    return {
      url: `${BASE}/index.php?rpctype=direct&module=default`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ action: 'Procedure', method: 'list', data: [data], type: 'rpc', tid: 1 }),
    };
  },
  parse(body) {
    const json = typeof body === 'string' ? JSON.parse(body) : body;
    const reply = Array.isArray(json) ? json[0] : json;
    if (reply?.type === 'exception') throw new Error(reply.message || 'ошибка Ext.Direct');
    const list = reply?.result?.procedures;
    if (!Array.isArray(list)) throw new Error('в ответе нет списка процедур');
    return list.map((p) => {
      const lot = (p.lots || [])[0] || {};
      const deadlineAt = parseIsoDate(p.date_end_registration || lot.date_end_registration);
      const isOpen = openByDeadline(deadlineAt);
      return {
        number: String(p.registry_number || p.id),
        title: String(p.title || lot.subject || '').trim(),
        customer: (lot.customers || [])[0] || p.full_name || null,
        price: parseMoney(p.total_price ?? lot.start_price),
        publishedAt: parseIsoDate(p.date_published),
        deadlineAt,
        stage: isOpen === true ? 'Приём заявок' : isOpen === false ? 'Приём заявок завершён' : null,
        isOpen,
        method: null,
        url: `${BASE}/#com/procedure/view/procedure/${p.id}`,
      };
    });
  },
};
