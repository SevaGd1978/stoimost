/**
 * Национальная электронная площадка / ЭТП ЕТС (etp-ets.ru), каталог 44-ФЗ.
 * Выдача — HTML-таблица, строки <tr id="rowId-…">, ячейки с классами row-*.
 * lot_status_id[]=25 — «Прием заявок», contract_start_price[from|to] — НМЦК.
 */
import { firstHref, htmlText, parseMoney, parseRuDateTime } from './util.js';

const BASE = 'https://etp-ets.ru';

function cell(row, name) {
  const m = row.match(new RegExp(`<td[^>]*class="row-${name}\\b[^"]*"[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : '';
}

export default {
  id: 'etpets',
  name: 'НЭП (ЭТП ЕТС)',
  site: BASE,
  category: 'purchase',
  request({ keyword, settings }) {
    const url = new URL('/44/catalog/procedure', BASE);
    url.searchParams.set('q', keyword);
    if (settings.onlyOpen !== false) url.searchParams.append('lot_status_id[]', '25');
    if (settings.priceMin != null) url.searchParams.set('contract_start_price[from]', String(Math.floor(settings.priceMin)));
    if (settings.priceMax != null) url.searchParams.set('contract_start_price[to]', String(Math.ceil(settings.priceMax)));
    return { url: url.toString() };
  },
  parse(body) {
    const html = String(body);
    const rows = html.match(/<tr id="rowId-[\s\S]*?<\/tr>/g) || [];
    if (!rows.length && !/<table/i.test(html)) throw new Error('нет таблицы процедур');
    return rows
      .map((row) => {
        const number = htmlText(cell(row, 'procedure_number'));
        if (!number) return null;
        const nameCell = cell(row, 'procedure_name');
        const stage = htmlText(cell(row, 'status')) || null;
        const method = (cell(row, 'type').match(/title="([^"]+)"/) || [])[1] || null;
        return {
          number,
          eisNumber: /^\d{19}$/.test(number) ? number : null,
          title: htmlText(nameCell.replace(/<div class="label-list">[\s\S]*$/, '')),
          customer: htmlText(cell(row, 'customer_name')) || htmlText(cell(row, 'placer_name')) || null,
          price: parseMoney(htmlText(cell(row, 'contract_start_price'))),
          publishedAt: parseRuDateTime(htmlText(cell(row, 'publication_datetime'))),
          deadlineAt: parseRuDateTime(htmlText(cell(row, 'request_end_give_datetime'))),
          stage,
          isOpen: stage ? /при[её]м (заявок|предложений)/i.test(stage) : null,
          method,
          law: '44-ФЗ',
          url: firstHref(nameCell, BASE)?.replace(/\?&?backurl=[^#]*$/, '') ?? null,
        };
      })
      .filter(Boolean);
  },
};
