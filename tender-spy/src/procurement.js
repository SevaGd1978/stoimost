/**
 * Объём закупок заказчика по бесплатным источникам.
 * Опрос по ИНН — разовый, по кнопке: в периодический поиск по номенклатуре ИНН не добавляется.
 * ЕИС отдаёт RSS реестра контрактов (не больше 50 последних записей). Второй источник —
 * карточки этого заказчика, уже лежащие в Tender Spy.
 */
import { parseRss } from './rss.js';
import { innMentioned } from './tenders.js';
import { QUERY_TEMPLATES, buildUrl, mapContractItem } from './sources/zakupki.js';

const RSS_LIMIT = 50;

export function innOf(value) {
  const digits = String(value || '').match(/\b(\d{10}|\d{12})\b/);
  return digits ? digits[1] : '';
}

export function customerOf(tender = {}) {
  const inn = innOf(tender.customerInn) || innOf(tender.customer);
  const name = String(tender.customer || '')
    .replace(/\s*\(?\s*инн\s*\d{10,12}\s*\)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { inn, name };
}

function lawOn(template) {
  const out = {};
  for (const param of Object.values(template.laws)) out[param] = 'on';
  return out;
}

export function contractRssUrl(inn, base = 'https://zakupki.gov.ru') {
  const params = {
    ...QUERY_TEMPLATES.contracts.base,
    ...lawOn(QUERY_TEMPLATES.contracts),
    [QUERY_TEMPLATES.contracts.customerInn]: inn,
  };
  return buildUrl(base, QUERY_TEMPLATES.contracts.path, params);
}

export function contractRegistryUrl(inn, base = 'https://zakupki.gov.ru') {
  const params = {
    morphology: 'on',
    'search-filter': 'Дате размещения',
    pageNumber: '1',
    sortDirection: 'false',
    recordsPerPage: '_50',
    sortBy: 'UPDATE_DATE',
    contractStageList_0: 'on',
    contractStageList_1: 'on',
    contractStageList: '0,1',
    fz44: 'on',
    fz223: 'on',
    [QUERY_TEMPLATES.contracts.customerInn]: inn,
  };
  return buildUrl(base, '/epz/contract/search/results.html', params);
}

function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\bинн\s*\d{10,12}\b/g, '')
    .replace(/[«»"'`()]/g, ' ')
    .replace(/\b(ао|пао|зао|ооо|гуп|муп|гбу|фгуп|мбу|фгбу)\b/g, ' ')
    .replace(/[^a-zа-я0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameCustomer(tender, { inn, name }) {
  const got = customerOf(tender);
  if (inn) return got.inn === inn || innMentioned(inn, tender.customer);
  const a = nameKey(name);
  const b = nameKey(got.name || tender.customer);
  if (!a || !b || a.length < 6) return false;
  return a === b || (a.length >= 8 && b.includes(a)) || (b.length >= 8 && a.includes(b));
}

function yearOf(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return new Date(t + 3 * 3_600_000).getUTCFullYear();
}

export function seriesOf(rows) {
  const byYear = new Map();
  for (const row of rows) {
    const year = yearOf(row.publishedAt);
    if (!year) continue;
    const cur = byYear.get(year) || { year, count: 0, sum: 0 };
    cur.count += 1;
    if (typeof row.price === 'number' && Number.isFinite(row.price)) cur.sum += row.price;
    byYear.set(year, cur);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length >= 2 && years[years.length - 1] - years[0] <= 12) {
    const filled = [];
    for (let y = years[0]; y <= years[years.length - 1]; y++) filled.push(byYear.get(y) || { year: y, count: 0, sum: 0 });
    return filled;
  }
  return years.map((y) => byYear.get(y));
}

function totals(series) {
  return series.reduce((acc, row) => ({ count: acc.count + row.count, sum: acc.sum + row.sum }), { count: 0, sum: 0 });
}

function rowFrom(tender, origin) {
  return {
    number: tender.number || '',
    kind: tender.kind,
    price: tender.price,
    publishedAt: tender.publishedAt,
    title: tender.title || '',
    origin,
  };
}

function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = row.number || `${row.publishedAt}|${row.price}|${row.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/**
 * @param {{ inn?: string, name?: string, tenders?: object[], fetchXml?: Function|null, base?: string, mode?: 'live'|'demo' }} input
 */
export async function collectCustomerVolume({ inn = '', name = '', tenders = [], fetchXml = null, base, mode = 'live' } = {}) {
  const identityInn = innOf(inn) || innOf(name);
  const identityName = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!identityInn && !identityName) {
    const err = new Error('Нужен ИНН или название заказчика');
    err.status = 400;
    throw err;
  }
  const who = { inn: identityInn, name: identityName.replace(/\s*\(?\s*инн\s*\d{10,12}\s*\)?/gi, '').trim() };

  const local = tenders.filter((t) => sameCustomer(t, who));
  const localContracts = local.filter((t) => t.kind === 'contract').map((t) => rowFrom(t, 'local'));
  const localNotices = local.filter((t) => t.kind !== 'contract').map((t) => rowFrom(t, 'local'));

  const sources = [];
  let warning = '';
  let eisContracts = [];
  const registryUrl = identityInn ? contractRegistryUrl(identityInn, base) : '';

  if (!identityInn) {
    sources.push({
      id: 'eis',
      label: 'Реестр контрактов ЕИС',
      count: 0,
      ok: false,
      note: 'Поиск в ЕИС идёт по ИНН. В карточке ИНН ещё нет — на графике только закупки, уже найденные Tender Spy.',
    });
  } else if (mode === 'demo') {
    sources.push({
      id: 'eis',
      label: 'Реестр контрактов ЕИС',
      count: 0,
      ok: false,
      note: 'Демо-режим: запрос к ЕИС не выполняется. Полный реестр можно открыть по ссылке.',
    });
  } else if (!fetchXml) {
    warning = 'Источник ЕИС не настроен';
    sources.push({ id: 'eis', label: 'Реестр контрактов ЕИС', count: 0, ok: false, note: warning });
  } else {
    try {
      const xml = await fetchXml(contractRssUrl(identityInn, base));
      if (!/<(rss|feed|item)\b/i.test(String(xml).slice(0, 4000))) throw new Error('ЕИС вернул не RSS');
      const query = {
        kind: 'contracts',
        match: { type: 'company', ref: identityInn, label: who.name || identityInn, via: 'contract' },
      };
      const mapped = parseRss(xml)
        .map((item) => mapContractItem(item, query))
        .filter(Boolean);
      eisContracts = mapped.filter((t) => sameCustomer(t, who)).map((t) => rowFrom(t, 'eis'));
      const dropped = mapped.length - eisContracts.length;
      sources.push({
        id: 'eis',
        label: 'Реестр контрактов ЕИС',
        count: eisContracts.length,
        ok: true,
        note: dropped > 0 ? 'Часть записей отброшена: в карточке нет ИНН этого заказчика.' : '',
      });
    } catch (err) {
      warning = `Реестр ЕИС не ответил: ${err.message || 'ошибка'}`;
      sources.push({ id: 'eis', label: 'Реестр контрактов ЕИС', count: 0, ok: false, note: warning });
    }
  }

  const overlap = eisContracts.filter((row) => localContracts.some((localRow) => localRow.number && localRow.number === row.number)).length;
  const contracts = dedupe([...eisContracts, ...localContracts]);
  const basis = contracts.length ? 'contracts' : localNotices.length ? 'notices' : 'empty';
  const rows = basis === 'contracts' ? contracts : basis === 'notices' ? localNotices : [];
  const series = seriesOf(rows);

  sources.push({
    id: 'local',
    label: 'Уже найдено в Tender Spy',
    count: basis === 'notices' ? localNotices.length : localContracts.length,
    ok: true,
    note: '',
  });

  const note = [
    identityInn && mode !== 'demo' ? `Бесплатная RSS-выгрузка ЕИС — не больше ${RSS_LIMIT} последних контрактов, это не весь реестр.` : '',
    basis === 'contracts' ? 'Сумма на графике — цены контрактов по году заключения.' : '',
    basis === 'notices' ? 'Контрактов нет. На графике начальные цены извещений, уже найденных по номенклатуре, а не заключённые суммы.' : '',
    basis === 'empty' ? 'По этому заказчику ничего не нашлось.' : '',
    overlap ? 'Одинаковые номера контрактов из ЕИС и из ленты не суммируются дважды.' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const items = rows
    .slice()
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, 12)
    .map(({ title, price, publishedAt, kind }) => ({ title, price: price ?? null, publishedAt: publishedAt || null, kind }));

  return {
    customer: who,
    basis,
    basisLabel: basis === 'contracts' ? 'Сумма контрактов' : basis === 'notices' ? 'НМЦК извещений' : 'Нет данных',
    series,
    total: totals(series),
    items,
    sources,
    registryUrl,
    note,
    warning,
  };
}
