/**
 * ГИС Торги (torgi.gov.ru) — продажа и аренда государственного имущества,
 * банкротство, право заключения договоров. Публичный JSON-поиск по лотам.
 * Текстовый поиск площадки нестрогий, лишнее отсекает общий фильтр ключевого слова.
 */
import { parseIsoDate } from './util.js';

const BASE = 'https://torgi.gov.ru';
const OPEN_STATUSES = new Set(['PUBLISHED', 'APPLICATIONS_SUBMISSION']);
const STATUS_NAMES = {
  PUBLISHED: 'Опубликован',
  APPLICATIONS_SUBMISSION: 'Приём заявок',
  DETERMINING_WINNER: 'Определение победителя',
  SUCCEED: 'Состоялся',
  FAILED: 'Не состоялся',
  CANCELED: 'Отменён',
};

export default {
  id: 'torgi',
  name: 'ГИС Торги',
  site: BASE,
  category: 'sale',
  request({ keyword, settings }) {
    const url = new URL('/new/api/public/lotcards/search', BASE);
    url.searchParams.set('text', keyword);
    if (settings.onlyOpen !== false) url.searchParams.set('lotStatus', [...OPEN_STATUSES].join(','));
    url.searchParams.set('size', '50');
    url.searchParams.set('sort', 'firstVersionPublicationDate,desc');
    return { url: url.toString(), headers: { accept: 'application/json' } };
  },
  parse(body) {
    const json = typeof body === 'string' ? JSON.parse(body) : body;
    if (!Array.isArray(json?.content)) throw new Error('в ответе нет списка лотов');
    const seen = new Set();
    return json.content
      .filter((l) => l?.id && !seen.has(l.id) && seen.add(l.id))
      .map((l) => {
        const price = Number(l.priceMin);
        return {
          number: l.lotNumber ? `${l.noticeNumber}-${l.lotNumber}` : String(l.noticeNumber || l.id),
          title: String(l.lotName || l.lotDescription || '').trim(),
          customer: null,
          price: Number.isFinite(price) && price > 0 ? price : null,
          publishedAt: parseIsoDate(l.noticeFirstVersionPublicationDate || l.createDate),
          deadlineAt: parseIsoDate(l.biddEndTime),
          stage: STATUS_NAMES[l.lotStatus] || l.lotStatus || null,
          isOpen: l.lotStatus ? OPEN_STATUSES.has(l.lotStatus) && !l.isStopped && !l.isAnnulled : null,
          method: [l.biddType?.name, l.biddForm?.name].filter(Boolean).join(' · ') || null,
          url: `${BASE}/new/public/lots/lot/${encodeURIComponent(l.id)}`,
        };
      });
  },
};
