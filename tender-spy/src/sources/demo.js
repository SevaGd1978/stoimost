/**
 * Демо-источник: генерирует правдоподобные карточки под текущий watchlist,
 * не обращаясь в сеть. Нужен, чтобы посмотреть интерфейс и проверить логику
 * там, где ЕИС недоступен (не-российские IP, офлайн).
 */
import { keywordMatches } from '../tenders.js';

const CUSTOMERS = [
  { name: 'АО «Теплосеть Санкт-Петербурга»', inn: '7810577007', region: 'Санкт-Петербург' },
  { name: 'ГУП «ТЭК СПб»', inn: '7830001028', region: 'Санкт-Петербург' },
  { name: 'МУП «Водоканал» г. Екатеринбурга', inn: '6608001915', region: 'Свердловская область' },
  { name: 'ПАО «Т Плюс»', inn: '6315376946', region: 'Самарская область' },
  { name: 'АО «Мосводоканал»', inn: '7701984274', region: 'Москва' },
  { name: 'ООО «Газпром теплоэнерго»', inn: '7811398183', region: 'Ленинградская область' },
  { name: 'ГБУ «Автомобильные дороги»', inn: '7727656790', region: 'Москва' },
];

const METHODS = ['Электронный аукцион', 'Открытый конкурс в электронной форме', 'Запрос котировок в электронной форме', 'Закупка у единственного поставщика'];
const STAGES_OPEN = ['Подача заявок', 'Подача заявок', 'Подача заявок', 'Работа комиссии'];
const SUBJECT_TEMPLATES = [
  'Поставка товара «{kw}» для нужд {short}',
  'Капитальный ремонт тепловой сети (материалы: {kw})',
  'Поставка: {kw} (ОКПД2 {okpd})',
  'Реконструкция участка теплотрассы: {kw}, монтаж, испытания',
  'Закупка по позиции «{kw}» на 2026–2027 гг.',
];

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function pick(r, arr) {
  return arr[Math.floor(r() * arr.length)];
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400_000).toISOString();
}

function daysAhead(n) {
  return new Date(Date.now() + n * 86400_000).toISOString();
}

function regNumber(r, law) {
  const digits = law === '223' ? 11 : 19;
  let s = law === '223' ? '3' : '0';
  while (s.length < digits) s += Math.floor(r() * 10);
  return s;
}

function shortName(name) {
  return name.replace(/^(АО|ООО|ГУП|МУП|ПАО|ГБУ)\s*/, '').replace(/[«»]/g, '');
}

let runCounter = 0;

export class DemoSource {
  constructor({ log = console } = {}) {
    this.log = log;
  }

  makeNotice(r, { subject, customer, law, match, ageDays }) {
    const number = regNumber(r, law);
    const stage = pick(r, STAGES_OPEN);
    const price = Math.round((0.5 + r() * 60) * 1_000_000) / 1;
    const path = law === '223' ? '/epz/order/notice/notice223/view/common-info.html?noticeInfoId=' : '/epz/order/notice/ea20/view/common-info.html?regNumber=';
    return {
      id: `notice:${number}`,
      source: 'demo',
      kind: 'notice',
      law,
      number,
      title: subject,
      method: pick(r, METHODS),
      customer: `${customer.name} (ИНН ${customer.inn})`,
      customerInn: customer.inn,
      supplier: null,
      supplierInn: null,
      price,
      currency: 'RUB',
      publishedAt: daysAgo(ageDays),
      updatedAt: daysAgo(Math.max(0, ageDays - 1)),
      deadlineAt: daysAhead(3 + Math.floor(r() * 14)),
      stage,
      isOpen: stage === 'Подача заявок',
      region: customer.region,
      url: `https://zakupki.gov.ru${path}${number}`,
      matches: [match],
    };
  }

  makeContract(r, { company, subject, customer, law }) {
    const number = regNumber(r, law);
    return {
      id: `contract:${number}`,
      source: 'demo',
      kind: 'contract',
      law,
      number,
      title: subject,
      method: null,
      customer: `${customer.name} (ИНН ${customer.inn})`,
      customerInn: customer.inn,
      supplier: `${company.name} (ИНН ${company.inn})`,
      supplierInn: company.inn,
      price: Math.round((1 + r() * 40) * 1_000_000),
      currency: 'RUB',
      publishedAt: daysAgo(10 + Math.floor(r() * 60)),
      updatedAt: daysAgo(2 + Math.floor(r() * 5)),
      deadlineAt: daysAhead(60 + Math.floor(r() * 300)),
      stage: 'Исполнение',
      isOpen: false,
      region: customer.region,
      url: `https://zakupki.gov.ru/epz/contract/contractCard/common-info.html?reestrNumber=${number}`,
      matches: [{ type: 'company', ref: company.inn, label: company.name, via: 'contract', strong: true }],
    };
  }

  async collect({ nomenclature = [], settings = {} }) {
    runCounter += 1;
    const laws = settings.laws ?? { fz44: true, fz223: true };
    const lawPool = [laws.fz44 !== false && '44', laws.fz223 !== false && '223'].filter(Boolean);
    if (!lawPool.length) lawPool.push('44');
    const keywords = nomenclature.map((n) => n.keyword).filter(Boolean);
    const tenders = [];

    for (const n of nomenclature) {
      const r = rng(hash(`${n.keyword}|${n.okpd2}`));
      const kw = n.keyword || `продукция ОКПД2 ${n.okpd2}`;
      for (let i = 0; i < 4; i++) {
        const customer = pick(r, CUSTOMERS);
        const subject = pick(r, SUBJECT_TEMPLATES).replace('{kw}', kw).replace('{short}', shortName(customer.name)).replace('{okpd}', n.okpd2 || '24.20.13');
        tenders.push(
          this.makeNotice(r, {
            subject,
            customer,
            law: pick(r, lawPool),
            match: {
              type: n.okpd2 && !n.keyword ? 'okpd2' : 'keyword',
              ref: n.keyword || n.okpd2,
              label: n.keyword || `ОКПД2 ${n.okpd2}`,
              okpd2: n.okpd2 || undefined,
              strong: n.keyword ? keywordMatches(n.keyword, subject) : true,
            },
            ageDays: 1 + Math.floor(r() * 25),
          }),
        );
      }
    }

    // Каждый новый опрос подбрасывает одну «свежую» закупку — чтобы было видно, как работают бейджи «новое».
    if (nomenclature.length) {
      const r = rng(hash(`fresh-${runCounter}-${Date.now() >> 16}`));
      const customer = pick(r, CUSTOMERS);
      const kw = keywords.length ? pick(r, keywords) : 'оборудование';
      const src = nomenclature[0];
      tenders.push(
        this.makeNotice(r, {
          subject: `Срочная закупка: ${kw} (опубликовано только что)`,
          customer,
          law: pick(r, lawPool),
          match: { type: 'keyword', ref: src.keyword || src.okpd2, label: src.keyword || `ОКПД2 ${src.okpd2}`, strong: true },
          ageDays: 0,
        }),
      );
    }

    this.log.info?.(`[demo] сгенерировано ${tenders.length} карточек`);
    return { tenders, errors: [], queriesRun: nomenclature.length };
  }
}
