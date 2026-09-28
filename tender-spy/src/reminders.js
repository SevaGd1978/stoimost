const DAY = 86_400_000;

/** За сколько дней до окончания подачи напоминать об избранной закупке. */
export const REMIND_DAYS = [3, 1];

export function daysLeft(deadlineAt, now = Date.now()) {
  const t = Date.parse(deadlineAt ?? '');
  return Number.isFinite(t) ? Math.ceil((t - now) / DAY) : null;
}

/**
 * Избранные извещения, по которым пора напомнить: [{ tender, left, threshold }].
 * Каждый порог срабатывает один раз; если опрос пропустил порог «3 дня», сразу приходит «1 день».
 */
export function dueReminders(tenders, now = Date.now()) {
  const out = [];
  for (const t of Object.values(tenders)) {
    if (!t.favorite || t.kind === 'contract' || t.isOpen === false || !t.deadlineAt) continue;
    const ms = Date.parse(t.deadlineAt) - now;
    if (!(ms > 0)) continue;
    const left = Math.ceil(ms / DAY);
    const threshold = [...REMIND_DAYS].sort((a, b) => a - b).find((d) => left <= d);
    if (threshold == null || t.reminded?.[threshold]) continue;
    out.push({ tender: t, left, threshold });
  }
  return out.sort((a, b) => Date.parse(a.tender.deadlineAt) - Date.parse(b.tender.deadlineAt));
}

/** Отмечает порог и все бо́льшие, чтобы после «1 дня» не пришло запоздалое «3 дня». */
export function markReminded(tender, threshold, now = Date.now()) {
  tender.reminded = { ...(tender.reminded ?? {}) };
  for (const d of REMIND_DAYS) if (d >= threshold && !tender.reminded[d]) tender.reminded[d] = new Date(now).toISOString();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней');

export function leftText(left) {
  return left <= 1 ? 'меньше суток' : `${left} ${plural(left)}`;
}

export function formatReminderMessage(items) {
  const lines = items.map(({ tender: t, left }) => {
    const deadline = new Date(t.deadlineAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' });
    return `\n• <a href="${escapeHtml(t.url)}">${escapeHtml(t.title).slice(0, 120)}</a>\n  подача до ${deadline} МСК — осталось ${leftText(left)}${t.comment ? `\n  📝 ${escapeHtml(t.comment).slice(0, 200)}` : ''}`;
  });
  return `⏰ <b>Tender Spy</b>: скоро окончание подачи по избранным — ${items.length}\n${lines.join('')}`;
}
