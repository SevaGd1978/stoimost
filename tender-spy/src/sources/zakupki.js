/**
 * Источник: ЕИС закупок (zakupki.gov.ru).
 *
 * Официального публичного REST API у ЕИС нет, но у расширенного поиска
 * извещений и реестра контрактов есть RSS-выгрузка — её и используем.
 *
 * Схема опроса: только номенклатура — полнотекстовый поиск извещений
 * по ключевым словам и/или коду ОКПД2. Поиск по ИНН заказчика и поставщика не выполняется.
 *
 * Имена параметров соответствуют формам расширенного поиска ЕИС; если ЕИС
 * переименует поля, править нужно только QUERY_TEMPLATES ниже.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { createEisFetch, describeFetchError } from '../eis-tls.js';
import { parseRss, parseDescriptionFields, pickField, stripHtml } from '../rss.js';
import {
  parseRuNumber,
  parseRuDate,
  extractRegNumber,
  detectLaw,
  isOpenStage,
  keywordMatches,
  innMentioned,
} from '../tenders.js';

export const QUERY_TEMPLATES = {
  notices: {
    path: '/epz/order/extendedsearch/rss.html',
    base: {
      morphology: 'on',
      'search-filter': 'Дате размещения',
      pageNumber: '1',
      sortDirection: 'false',
      recordsPerPage: '_50',
      showLotsInfoHidden: 'false',
      sortBy: 'UPDATE_DATE',
      currencyIdGeneral: '-1',
    },
    stageOpen: { af: 'on' },
    stageAll: { af: 'on', ca: 'on', pc: 'on' },
    laws: { fz44: 'fz44', fz223: 'fz223', fz615: 'ppRf615' },
    searchString: 'searchString',
    okpd2: 'okpd2IdsCodes',
  },
  contracts: {
    path: '/epz/contract/search/rss.html',
    base: {
      morphology: 'on',
      'search-filter': 'Дате размещения',
      pageNumber: '1',
      sortDirection: 'false',
      recordsPerPage: '_50',
      sortBy: 'UPDATE_DATE',
      contractStageList_0: 'on',
      contractStageList_1: 'on',
      contractStageList: '0,1',
    },
    laws: { fz44: 'fz44', fz223: 'fz223' },
    supplierInn: 'supplierInn',
    customerInn: 'customerInn',
  },
};

function lawParams(template, laws) {
  const out = {};
  for (const [key, param] of Object.entries(template.laws)) {
    if (laws?.[key]) out[param] = 'on';
  }
  return out;
}

export function buildUrl(base, path, params) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * Формирует список запросов к ЕИС по watchlist.
 * Каждый запрос знает, ради чего он сделан (match) — это попадёт в карточку.
 */
export function buildQueries({ nomenclature = [], settings = {}, base = 'https://zakupki.gov.ru' }) {
  const laws = settings.laws ?? { fz44: true, fz223: true, fz615: false };
  const stage = settings.onlyOpen === false ? QUERY_TEMPLATES.notices.stageAll : QUERY_TEMPLATES.notices.stageOpen;
  const queries = [];

  for (const n of nomenclature) {
    const params = {
      ...QUERY_TEMPLATES.notices.base,
      ...stage,
      ...lawParams(QUERY_TEMPLATES.notices, laws),
    };
    if (n.keyword) params[QUERY_TEMPLATES.notices.searchString] = n.keyword;
    if (n.okpd2) params[QUERY_TEMPLATES.notices.okpd2] = n.okpd2;
    queries.push({
      kind: 'notices',
      label: `Номенклатура · ${n.keyword || ''}${n.okpd2 ? ` [ОКПД2 ${n.okpd2}]` : ''}`.trim(),
      match: {
        type: n.okpd2 && !n.keyword ? 'okpd2' : 'keyword',
        ref: n.keyword || n.okpd2,
        label: n.keyword || `ОКПД2 ${n.okpd2}`,
        okpd2: n.okpd2 || undefined,
      },
      url: buildUrl(base, QUERY_TEMPLATES.notices.path, params),
    });
  }

  return queries;
}

/** RSS-элемент извещения → карточка тендера. */
export function mapNoticeItem(item, query) {
  const fields = parseDescriptionFields(item.description);
  const number = extractRegNumber(item.link) || extractRegNumber(item.title) || extractRegNumber(item.guid);
  if (!number) return null;
  const title =
    pickField(fields, 'наименование объекта', 'предмет', 'наименование закупки') ||
    stripHtml(item.title).replace(/^№\s*\d+\s*/, '') ||
    `Закупка № ${number}`;
  const customer = pickField(fields, 'заказчик', 'организация, осуществляющая');
  const stage = pickField(fields, 'этап');
  const plain = `${stripHtml(item.title)}\n${stripHtml(item.description)}`;
  const match = { ...query.match };
  match.strong =
    match.type === 'company'
      ? innMentioned(match.ref, plain)
      : match.type === 'keyword'
        ? keywordMatches(match.ref, `${title} ${plain}`)
        : true;
  return {
    id: `notice:${number}`,
    source: 'zakupki',
    kind: 'notice',
    law: detectLaw({ url: item.link, number }),
    number,
    title,
    method: stripHtml(item.title).replace(/^№\s*\d+\s*/, '').trim(),
    customer,
    customerInn: (customer.match(/ИНН\s*(\d{10,12})/) || [])[1] || null,
    supplier: null,
    supplierInn: null,
    price: parseRuNumber(pickField(fields, 'начальная', 'цена')),
    currency: pickField(fields, 'валюта') || 'RUB',
    publishedAt: parseRuDate(pickField(fields, 'размещено', 'дата размещения')) || parseRuDate(item.pubDate),
    updatedAt: parseRuDate(pickField(fields, 'обновлено')) || parseRuDate(item.pubDate),
    deadlineAt: parseRuDate(pickField(fields, 'окончание подачи', 'дата окончания')),
    stage: stage || 'Подача заявок',
    isOpen: stage ? isOpenStage(stage) : true,
    region: pickField(fields, 'регион', 'место поставки') || null,
    url: item.link,
    matches: [match],
  };
}

/** RSS-элемент реестра контрактов → карточка (kind=contract). */
export function mapContractItem(item, query) {
  const fields = parseDescriptionFields(item.description);
  const number = extractRegNumber(item.link) || extractRegNumber(item.title) || extractRegNumber(item.guid);
  if (!number) return null;
  const supplier = pickField(fields, 'поставщик', 'исполнитель', 'подрядчик');
  const customer = pickField(fields, 'заказчик');
  const match = { ...query.match, strong: innMentioned(query.match.ref, `${supplier} ${stripHtml(item.description)}`) };
  return {
    id: `contract:${number}`,
    source: 'zakupki',
    kind: 'contract',
    law: detectLaw({ url: item.link, number }),
    number,
    title:
      pickField(fields, 'предмет', 'наименование объекта', 'объект закупки') ||
      stripHtml(item.title) ||
      `Контракт № ${number}`,
    method: null,
    customer,
    customerInn: (customer.match(/ИНН\s*(\d{10,12})/) || [])[1] || null,
    supplier,
    supplierInn: (supplier.match(/ИНН\s*(\d{10,12})/) || [])[1] || query.match.ref,
    price: parseRuNumber(pickField(fields, 'цена контракта', 'цена', 'сумма')),
    currency: pickField(fields, 'валюта') || 'RUB',
    publishedAt: parseRuDate(pickField(fields, 'дата заключения', 'заключен', 'размещено')) || parseRuDate(item.pubDate),
    updatedAt: parseRuDate(pickField(fields, 'обновлено')) || parseRuDate(item.pubDate),
    deadlineAt: parseRuDate(pickField(fields, 'срок исполнения', 'окончание исполнения')),
    stage: pickField(fields, 'статус', 'этап') || 'Исполнение',
    isOpen: false,
    region: null,
    url: item.link,
    matches: [match],
  };
}

export class ZakupkiSource {
  constructor({ base, userAgent, timeoutMs = 25000, delayMs = 1500, fetchImpl, dispatcher, log = console }) {
    this.base = base;
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.delayMs = delayMs;
    // Прокси-диспетчер умеет только глобальный fetch. Без прокси ходим своим
    // клиентом: он доверяет сертификату Минцифры и не маскирует причину сбоя.
    this.fetchImpl = fetchImpl ?? (dispatcher ? fetch : createEisFetch({ timeoutMs }));
    this.dispatcher = dispatcher;
    this.log = log;
  }

  async fetchXml(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const fetchOpts = {
        signal: ctrl.signal,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
      };
      if (this.dispatcher) {
        fetchOpts.dispatcher = this.dispatcher;
      }
      const res = await this.fetchImpl(url, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async runQuery(query) {
    const xml = await this.fetchXml(query.url);
    const head = String(xml).slice(0, 240).replace(/\s+/g, ' ').trim();
    const looksRss = /<(rss|feed|item)\b/i.test(String(xml).slice(0, 4000));
    if (!looksRss) {
      throw new Error(`ЕИС вернул не RSS (${String(xml).length} байт): ${head.slice(0, 180) || 'пустой ответ'}`);
    }
    const items = parseRss(xml);
    const mapper = query.kind === 'contracts' ? mapContractItem : mapNoticeItem;
    return items.map((it) => mapper(it, query)).filter(Boolean);
  }

  /**
   * Выполняет все запросы последовательно с паузой (ЕИС банит частые обращения).
   * Возвращает { tenders, errors, queriesRun }.
   */
  async collect({ companies, nomenclature, settings }) {
    const queries = buildQueries({ companies, nomenclature, settings, base: this.base });
    const tenders = [];
    const errors = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        const found = await this.runQuery(q);
        this.log.info?.(`[zakupki] ${q.label}: ${found.length}`);
        tenders.push(...found);
      } catch (err) {
        const message = describeFetchError(err);
        errors.push({ query: q.label, message });
        this.log.warn?.(`[zakupki] ${q.label}: ошибка — ${message}`);
      }
      if (i < queries.length - 1) await sleep(this.delayMs);
    }
    return { tenders, errors, queriesRun: queries.length };
  }
}
