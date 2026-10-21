/**
 * Карточка извещения ЕИС (common-info.html): срок подачи заявок, регион и ИНН
 * заказчика. В RSS этих полей нет, а без них не работают фильтры
 * «осталось дней» и «регион».
 */
import { decodeHtml } from './platforms/util.js';
import { regionFromText } from '../regions.js';

function lines(html) {
  return decodeHtml(
    String(html ?? '')
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, '\n')
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function after(ls, label, span = 3) {
  const i = ls.findIndex((l) => label.test(l));
  return i < 0 ? '' : ls.slice(i, i + 1 + span).join(' ');
}

/** «02.10.2026 08:00 (МСК+1)» → ISO в UTC. Без пояса считаем московским временем. */
export function parseEisDeadline(text) {
  const m = String(text ?? '').match(/(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?(?:\s*\(МСК([+-−]\d{1,2})?\))?/);
  if (!m) return null;
  const [, d, mo, y, h, mi, shift] = m;
  const offset = 3 + (shift ? Number(shift.replace('−', '-')) : 0);
  const hours = h == null ? 23 : Number(h);
  const minutes = mi == null ? 59 : Number(mi);
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hours - offset, minutes)).toISOString();
}

export function parseNoticeCard(html) {
  const ls = lines(html);
  const deadlineAt =
    parseEisDeadline(after(ls, /^Дата и время окончания (срока )?подачи заявок/i)) ||
    parseEisDeadline(after(ls, /^Окончание подачи заявок/i, 1));
  const region =
    regionFromText(after(ls, /^Регион$/i, 1).replace(/^Регион\s*/i, '')) ||
    regionFromText(after(ls, /^Место нахождения$/i, 1).replace(/^Место нахождения\s*/i, '')) ||
    regionFromText(after(ls, /^Почтовый адрес$/i, 1).replace(/^Почтовый адрес\s*/i, ''));
  const inn = after(ls, /^ИНН:?$/i, 1).match(/\b(\d{10}|\d{12})\b/);
  return { deadlineAt, region, customerInn: inn ? inn[1] : null };
}
