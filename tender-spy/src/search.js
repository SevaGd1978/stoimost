/**
 * Разовый поиск: те же источники, что и у опроса, но по переданным фразам
 * и без записи в хранилище. Настройки пользователя (цена, законы) не
 * применяются — ищутся все открытые закупки.
 */
import { defaultSettings } from './store.js';
import { keywordMatches, normalizeKeyword, staleNotice } from './tenders.js';

export const SEARCH_LIMITS = { keywords: 6, keywordLength: 120, cacheMs: 5 * 60_000 };

export function parseSearchKeywords(query) {
  return [...new Set([].concat(query ?? []).flatMap((s) => String(s).split('|')).map((s) => s.trim()).filter(Boolean))];
}

export function searchSettings() {
  return { ...defaultSettings(), onlyOpen: true, laws: { fz44: true, fz223: true, fz615: true }, priceMin: null, priceMax: null };
}

function titleText(title) {
  const t = String(title ?? '');
  return /пенополиуретан/i.test(t) ? `${t} ППУ` : t;
}

/** Все слова фразы есть в названии: ЕИС ищет и по документам, отсюда «ремонт сетей» без ППУ в предмете. */
export function titleMatches(keyword, title) {
  return keywordMatches(keyword, titleText(title));
}

function mergeInto(primary, other) {
  const merged = { ...primary, links: { ...other.links, ...primary.links } };
  merged.customer ||= other.customer;
  merged.price ??= other.price;
  merged.deadlineAt ||= other.deadlineAt;
  merged.region ||= other.region;
  const keys = new Set((primary.matches || []).map((m) => `${m.type}:${m.ref}`));
  merged.matches = [...(primary.matches || []), ...(other.matches || []).filter((m) => !keys.has(`${m.type}:${m.ref}`))];
  return merged;
}

function pickPrimary(a, b) {
  return b.source === 'zakupki' && a.source !== 'zakupki' ? [b, a] : [a, b];
}

function twinKey(t) {
  const title = normalizeKeyword(t.title).replace(/^\S*\d{4,}\S*\s*/, '').replace(/\s*\d{6,8}$/, '');
  return t.price != null ? `${title}|${Math.round(t.price)}` : null;
}

/** Одна карточка на закупку: ЕИС главнее площадок, ссылки и причины объединяются. */
export function mergeFound(tenders, now = Date.now()) {
  const byId = new Map();
  for (const t of tenders) {
    if (t.kind !== 'notice' || t.isOpen === false || staleNotice(t, now)) continue;
    const matches = (t.matches || []).filter((m) => m.type !== 'keyword' || titleMatches(m.ref, t.title));
    if (!matches.length) continue;
    const links = t.links ?? (t.url ? { [t.source || 'zakupki']: t.url } : {});
    const card = { ...t, links: { ...links }, matches };
    const prev = byId.get(t.id);
    byId.set(t.id, prev ? mergeInto(...pickPrimary(prev, card)) : card);
  }
  const byTwin = new Map();
  const result = [];
  for (const t of byId.values()) {
    const key = twinKey(t);
    const twin = key && byTwin.get(key);
    if (!twin) {
      if (key) byTwin.set(key, t);
      result.push(t);
      continue;
    }
    const merged = mergeInto(...pickPrimary(twin, t));
    result[result.indexOf(twin)] = merged;
    byTwin.set(key, merged);
  }
  return result.sort((a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0));
}
