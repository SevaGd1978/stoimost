/**
 * Нормализация карточек закупок из разных источников к единой модели
 * и вспомогательные функции матчинга.
 */

export function parseRuNumber(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value)
    .replace(/[^\d,.\-]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(',', '.');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** «21.09.2026», «21.09.2026 14:30» или RFC-дата → ISO-строка (либо null). */
export function parseRuDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (m) {
    // Для дат без времени берём полдень по Москве, чтобы день не «уезжал» при показе в других часовых поясах.
    const [, dd, mm, yyyy, hh = '12', mi = '00'] = m;
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00+03:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function extractRegNumber(text) {
  const m = String(text ?? '').match(/(?:regNumber|reestrNumber|noticeInfoId|№\s*)=?\s*(\d{11,19})/);
  return m ? m[1] : null;
}

export function detectLaw({ url = '', number = '' }) {
  const u = url.toLowerCase();
  if (u.includes('223') || /^3\d{10}$/.test(number)) return '223';
  if (u.includes('615') || u.includes('pprf615')) return '615';
  if (/^\d{19}$/.test(number) || u.includes('/order/notice/')) return '44';
  return 'other';
}

const OPEN_STAGES = ['подача заявок', 'приём заявок', 'прием заявок', 'подача предложений', 'открыт'];

export function isOpenStage(stage) {
  const s = String(stage ?? '').toLowerCase();
  return OPEN_STAGES.some((k) => s.includes(k));
}

export function normalizeKeyword(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s\-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Грубая русская морфология: обрезаем окончания, чтобы «труба» находила «трубы/трубами». */
export function stem(word) {
  const w = normalizeKeyword(word);
  if (w.length <= 4) return w;
  return w.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ах|ях|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ые|ие|ах|ям|ам|ом|ем|ью|ия|ие|а|я|ы|и|у|ю|о|е|ь|й)$/u, '');
}

/** true, если все слова ключевой фразы (по основам) встречаются в тексте. */
export function keywordMatches(keyword, text) {
  const words = normalizeKeyword(keyword).split(' ').filter(Boolean);
  if (!words.length) return false;
  const hay = normalizeKeyword(text);
  return words.every((w) => hay.includes(stem(w)));
}

export function innMentioned(inn, text) {
  return new RegExp(`(^|\\D)${inn}(\\D|$)`).test(String(text ?? ''));
}
