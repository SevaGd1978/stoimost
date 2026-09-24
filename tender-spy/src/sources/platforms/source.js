/**
 * Источник: электронные торговые площадки (ЭТП) помимо ЕИС.
 *
 * По каждой включённой площадке ищем все ключевые слова номенклатуры
 * (позиции только с ОКПД2 пропускаются — площадки ищут по тексту).
 * Площадки опрашиваются параллельно, запросы к одной площадке — по очереди
 * с паузой. Извещения, у которых есть номер ЕИС, получают тот же id, что
 * и карточка из ЕИС, поэтому в ленте не дублируются.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createEisFetch, describeFetchError } from '../../eis-tls.js';
import { detectLaw, keywordMatches } from '../../tenders.js';
import { PLATFORMS } from './index.js';

const NETWORK_ERROR = /таймаут|timeout|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|сертификат|socket|TLS/i;

export function isEisNumber(number) {
  return /^\d{19}$|^\d{11}$/.test(String(number ?? ''));
}

function lawOf(item) {
  const m = String(item.law ?? '').match(/(44|223|615)/);
  if (m) return m[1];
  return item.eisNumber ? detectLaw({ number: item.eisNumber }) : 'other';
}

function lawAllowed(law, laws) {
  if (!laws) return true;
  if (law === '44') return laws.fz44 !== false;
  if (law === '223') return laws.fz223 !== false;
  if (law === '615') return laws.fz615 !== false;
  return true;
}

export function enabledPlatforms(settings = {}, platforms = PLATFORMS) {
  const flags = settings.platforms ?? {};
  return platforms.filter((p) => flags[p.id] !== false);
}

/** Строка выдачи площадки → карточка тендера в формате ленты. */
export function toTender(platform, item, keyword) {
  const eisNumber = item.eisNumber && isEisNumber(item.eisNumber) ? item.eisNumber : null;
  const number = eisNumber || String(item.number);
  const title = item.title || `Процедура № ${number}`;
  return {
    id: eisNumber ? `notice:${eisNumber}` : `${platform.id}:${item.number}`,
    source: platform.id,
    kind: 'notice',
    category: item.category || platform.category,
    law: lawOf(item),
    number,
    platformNumber: eisNumber && item.number !== eisNumber ? String(item.number) : undefined,
    title,
    method: item.method || null,
    customer: item.customer || null,
    customerInn: item.customerInn || null,
    supplier: null,
    supplierInn: null,
    price: item.price ?? null,
    currency: 'RUB',
    publishedAt: item.publishedAt || null,
    updatedAt: item.publishedAt || null,
    deadlineAt: item.deadlineAt || null,
    stage: item.stage || (item.isOpen === false ? 'Приём заявок завершён' : item.isOpen ? 'Приём заявок' : ''),
    isOpen: item.isOpen ?? null,
    region: item.region || null,
    url: item.url,
    links: item.url ? { [platform.id]: item.url } : {},
    matches: [{ type: 'keyword', ref: keyword, label: keyword, strong: true }],
  };
}

export class PlatformsSource {
  constructor({ platforms = PLATFORMS, userAgent, timeoutMs = 25000, delayMs = 1000, fetchImpl, dispatcher, log = console } = {}) {
    this.platforms = platforms;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.delayMs = delayMs;
    this.fetchImpl = fetchImpl ?? (dispatcher ? fetch : createEisFetch({ timeoutMs }));
    this.dispatcher = dispatcher;
    this.log = log;
  }

  async fetchBody(req) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const opts = {
        method: req.method || 'GET',
        signal: ctrl.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          ...(req.headers || {}),
        },
        body: req.body,
      };
      if (this.dispatcher) opts.dispatcher = this.dispatcher;
      const res = await this.fetchImpl(req.url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async search(platform, keyword, settings) {
    const body = await this.fetchBody(platform.request({ keyword, settings }));
    const items = platform.parse(body);
    return items
      .filter((it) => it && it.title && keywordMatches(keyword, it.title))
      .map((it) => toTender(platform, it, keyword))
      .filter((t) => lawAllowed(t.law, settings.laws));
  }

  async collectPlatform(platform, keywords, settings) {
    const tenders = [];
    const errors = [];
    let networkFailures = 0;
    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i];
      const label = `${platform.name} · ${keyword}`;
      try {
        const found = await this.search(platform, keyword, settings);
        networkFailures = 0;
        this.log.info?.(`[${platform.id}] ${keyword}: ${found.length}`);
        tenders.push(...found);
      } catch (err) {
        const message = describeFetchError(err);
        errors.push({ query: label, message });
        this.log.warn?.(`[${platform.id}] ${keyword}: ошибка — ${message}`);
        if (NETWORK_ERROR.test(message) && ++networkFailures >= 2 && i < keywords.length - 1) {
          errors.push({ query: platform.name, message: `площадка недоступна, пропущено запросов: ${keywords.length - i - 1}` });
          break;
        }
      }
      if (i < keywords.length - 1) await sleep(this.delayMs);
    }
    return { tenders, errors, queriesRun: keywords.length };
  }

  async collect({ nomenclature = [], settings = {} }) {
    const keywords = [...new Set(nomenclature.map((n) => String(n.keyword ?? '').trim()).filter(Boolean))];
    const platforms = enabledPlatforms(settings, this.platforms);
    if (!keywords.length || !platforms.length) return { tenders: [], errors: [], queriesRun: 0 };
    const results = await Promise.all(platforms.map((p) => this.collectPlatform(p, keywords, settings)));
    return {
      tenders: results.flatMap((r) => r.tenders),
      errors: results.flatMap((r) => r.errors),
      queriesRun: results.reduce((n, r) => n + r.queriesRun, 0),
    };
  }
}
