/**
 * Общие помощники для разбора выдачи торговых площадок: HTML-таблицы,
 * карточки, суммы и даты в российском формате.
 */
import { parseRuNumber } from '../../tenders.js';

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', bull: '•' };

export function decodeHtml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

/** Видимый текст фрагмента: без тегов, скриптов и лишних пробелов. */
export function htmlText(html) {
  return decodeHtml(
    String(html ?? '')
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ячейки <td> строки таблицы: [{ html, text }]. */
export function tableCells(rowHtml) {
  const cells = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml))) cells.push({ html: m[1], text: htmlText(m[1]) });
  return cells;
}

/** Строки <tr>…</tr> внутри фрагмента (без заголовков из <th>). */
export function tableRows(html) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/<th\b/i.test(m[1])) continue;
    rows.push(m[0]);
  }
  return rows;
}

/** Первая ссылка фрагмента → абсолютный URL. */
export function firstHref(html, base) {
  const m = String(html ?? '').match(/href\s*=\s*["']([^"']+)["']/i);
  if (!m) return null;
  try {
    return new URL(decodeHtml(m[1]), base).toString();
  } catch {
    return null;
  }
}

/**
 * «1 259 402.00 RUB», «689 055,48 ₽», «5629183.5 ₽» → число.
 * Пробелы — разделители тысяч; точка или запятая перед 1–2 цифрами — копейки.
 */
export function parseMoney(value) {
  const s = decodeHtml(String(value ?? '')).replace(/[\s\u00a0\u202f]/g, '');
  const m = s.match(/\d[\d.,]*/);
  if (!m) return null;
  let num = m[0];
  const frac = num.match(/[.,](\d{1,2})$/);
  if (frac) num = `${num.slice(0, -frac[0].length).replace(/[.,]/g, '')}.${frac[1]}`;
  else num = num.replace(/[.,]/g, '');
  const n = Number.parseFloat(num);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * «24.09.2026 06:43:48», «30.09.2026 07:00 (+03:00)», «24.09.2026 в 14:00»,
 * «23.09.2026» → ISO. Время без пояса считается московским.
 */
export function parseRuDateTime(value) {
  const s = String(value ?? '');
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})(?:\D{1,4}(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '12', mi = '00', ss = '00'] = m;
  const tz = s.match(/\(([+-]\d{2}):?(\d{2})\)/);
  const offset = tz ? `${tz[1]}:${tz[2]}` : '+03:00';
  const d = new Date(`${yyyy}-${mm}-${dd}T${hh.padStart(2, '0')}:${mi}:${ss}${offset}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Открыт ли приём заявок по сроку окончания; без срока — неизвестно (null). */
export function openByDeadline(deadlineAt, now = Date.now()) {
  if (!deadlineAt) return null;
  return Date.parse(deadlineAt) > now;
}

export { parseRuNumber };
