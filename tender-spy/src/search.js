/**
 * Разовый поиск: те же источники, что и у опроса, но по переданным фразам
 * и без записи в хранилище. Настройки пользователя (цена, законы) не
 * применяются — ищутся все открытые закупки.
 */
import { defaultSettings } from './store.js';

export const SEARCH_LIMITS = { keywords: 6, keywordLength: 120, cacheMs: 5 * 60_000 };

export function parseSearchKeywords(query) {
  return [...new Set([].concat(query ?? []).flatMap((s) => String(s).split('|')).map((s) => s.trim()).filter(Boolean))];
}

export function searchSettings() {
  return { ...defaultSettings(), onlyOpen: true, laws: { fz44: true, fz223: true, fz615: true }, priceMin: null, priceMax: null };
}

/** Одна карточка на закупку: ЕИС главнее площадок, ссылки и причины объединяются. */
export function mergeFound(tenders) {
  const byId = new Map();
  for (const t of tenders) {
    if (t.kind !== 'notice' || t.isOpen === false) continue;
    const links = t.links ?? (t.url ? { [t.source || 'zakupki']: t.url } : {});
    const prev = byId.get(t.id);
    if (!prev) {
      byId.set(t.id, { ...t, links: { ...links }, matches: [...(t.matches || [])] });
      continue;
    }
    const primary = t.source === 'zakupki' && prev.source !== 'zakupki' ? t : prev;
    const other = primary === t ? prev : t;
    const merged = { ...primary, links: { ...prev.links, ...links } };
    merged.customer ||= other.customer;
    merged.price ??= other.price;
    merged.deadlineAt ||= other.deadlineAt;
    merged.region ||= other.region;
    const keys = new Set((primary.matches || []).map((m) => `${m.type}:${m.ref}`));
    merged.matches = [...(primary.matches || []), ...(other.matches || []).filter((m) => !keys.has(`${m.type}:${m.ref}`))];
    byId.set(t.id, merged);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0));
}
