/**
 * Новости о предстоящих стройках и проектах по ключевым словам номенклатуры.
 * Бесплатный источник — RSS Google Новостей. Обновление запускает кнопка «Опросить сейчас»,
 * не таймер опроса закупок.
 */
import { parseRss, stripHtml } from './rss.js';
import { keywordMatches } from './tenders.js';

const BUILD_TERMS = '(стройка OR строительство OR реконструкция OR "капитальный ремонт" OR "строительный проект")';
const MAX_KEYWORDS = 5;
const MAX_ITEMS = 15;

export function newsKeywords(nomenclature = []) {
  const out = [];
  const seen = new Set();
  for (const item of nomenclature) {
    const raw = typeof item === 'string' ? item : item?.keyword;
    const keyword = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

function searchQuery(keywords) {
  const quoted = keywords.map((keyword) => `"${keyword.replace(/"/g, '')}"`).join(' OR ');
  return `(${quoted}) ${BUILD_TERMS}`;
}

export function newsSearchUrl(keywords) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', searchQuery(keywords));
  url.searchParams.set('hl', 'ru');
  url.searchParams.set('gl', 'RU');
  url.searchParams.set('ceid', 'RU:ru');
  return url.toString();
}

export function newsPageUrl(keywords) {
  const url = new URL('https://news.google.com/search');
  url.searchParams.set('q', searchQuery(keywords));
  url.searchParams.set('hl', 'ru');
  url.searchParams.set('gl', 'RU');
  url.searchParams.set('ceid', 'RU:ru');
  return url.toString();
}

function splitSource(title) {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const idx = raw.lastIndexOf(' - ');
  if (idx > 12 && raw.length - idx <= 60) return { title: raw.slice(0, idx).trim(), source: raw.slice(idx + 3).trim() };
  return { title: raw, source: '' };
}

export function mapNewsItems(xml, keywords) {
  return parseRss(xml)
    .map((item) => {
      const { title, source } = splitSource(stripHtml(item.title));
      const published = Date.parse(item.pubDate || '');
      return {
        title,
        url: item.link || '',
        source: source || 'Google Новости',
        publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
        summary: '',
      };
    })
    .filter((item) => item.title && item.url && keywords.some((keyword) => keywordMatches(keyword, item.title)))
    .slice(0, MAX_ITEMS);
}

export function demoProjectNews(keywords, now = Date.now()) {
  const lines = [
    (keyword) => `Реконструкция теплосети: в проект заложена поставка «${keyword}»`,
    (keyword) => `Строительство котельной на 2026–2027 годы включает «${keyword}»`,
    (keyword) => `Капитальный ремонт участка: подряд ищет «${keyword}»`,
  ];
  return keywords.slice(0, 3).flatMap((keyword, i) =>
    lines.map((line, j) => ({
      title: line(keyword),
      url: '',
      source: 'Демо',
      publishedAt: new Date(now - (i * 3 + j) * 86_400_000).toISOString(),
      summary: `Пример по слову «${keyword}». В демо-режиме внешняя лента новостей не запрашивается.`,
    })),
  );
}

export async function collectProjectNews({ keywords = [], mode = 'live', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const list = newsKeywords(keywords);
  const updatedAt = new Date().toISOString();
  if (!list.length) {
    return {
      updatedAt,
      keywords: [],
      items: [],
      searchUrl: '',
      note: 'В номенклатуре нет ключевых слов. Для новостей о стройках нужен текст позиции, кода ОКПД2 недостаточно.',
      warning: '',
    };
  }
  const searchUrl = newsPageUrl(list);
  if (mode === 'demo') {
    return {
      updatedAt,
      keywords: list,
      items: demoProjectNews(list),
      searchUrl,
      note: 'Демо-режим: это примеры, а не публикации. Запрос к новостям не выполняется.',
      warning: '',
    };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(newsSearchUrl(list), {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TenderSpy/1.0; +https://tender-spy-sevagd1978.amvera.io)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<(rss|feed|item)\b/i.test(String(xml).slice(0, 4000))) throw new Error('Источник новостей вернул не RSS');
    const items = mapNewsItems(xml, list);
    return {
      updatedAt,
      keywords: list,
      items,
      searchUrl,
      note: items.length
        ? 'Бесплатная лента Google Новостей: стройки и проекты, в заголовке которых есть слова номенклатуры. Обновляется кнопкой «Опросить сейчас».'
        : 'По этим словам в ленте строек и проектов ничего не нашлось.',
      warning: '',
    };
  } catch (err) {
    const message = err?.name === 'AbortError' ? 'Источник новостей не ответил вовремя' : err?.message || 'ошибка';
    return {
      updatedAt,
      keywords: list,
      items: [],
      searchUrl,
      note: '',
      warning: `Новости не обновились: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
