/**
 * Правила отбора закупок: минус-слова и уточняющие слова номенклатуры
 * (применяются при опросе и в ленте), а также признаки для фильтров ленты —
 * предмет, тип заказчика, способ закупки, ограничение «только для СМП».
 */
import { keywordMatches, normalizeKeyword, stem } from './tenders.js';

export const DEFAULT_MINUS_WORDS = [
  'запасные части',
  'запчасти',
  'автомобиль',
  'автотранспорт',
  'спецтехника',
  'снегоход',
  'лекарственный препарат',
  'медицинские изделия',
  'трубка',
  'трубок',
  'кладбище',
  'содержание дорог',
  'сувенир',
  'буровой инструмент',
];

/** «а, б\nв» → ['а', 'б', 'в']: без пустых и повторов, не длиннее 80 символов. */
export function parseWordList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const w of raw) {
    const s = String(w ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = s.toLowerCase();
    if (s && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** Первое минус-слово (фраза — все её слова), найденное в названии, или null. */
export function minusHit(title, words = []) {
  return words.find((w) => keywordMatches(w, title)) ?? null;
}

/** Уточняющие слова позиции: в названии должно быть хотя бы одно. Пустой список — без условия. */
export function contextOk(title, context = []) {
  if (!context.length) return true;
  const hay = ` ${normalizeKeyword(`${title} ${/пенополиуретан/i.test(title ?? '') ? 'ппу' : ''}`).replace(/-/g, ' ')}`;
  return context.some((w) =>
    normalizeKeyword(w)
      .split(/[\s-]+/)
      .filter(Boolean)
      .every((part) => hay.includes(` ${stem(part)}`)),
  );
}

function nomenKey(n) {
  return String(n.keyword || n.okpd2 || '').toLowerCase();
}

/** Совпадения карточки, которые относятся к позициям текущей номенклатуры. */
export function currentMatches(t, nomenclature = []) {
  const byKey = new Map(nomenclature.map((n) => [nomenKey(n), n]));
  return (t.matches || []).filter((m) => m.type !== 'company' && byKey.has(String(m.ref).toLowerCase()));
}

/**
 * Почему карточку не брать: 'minus' — есть минус-слово, 'context' — ни одна
 * позиция номенклатуры не подтверждена уточняющими словами. null — брать.
 */
export function rejectReason(t, { nomenclature = [], settings = {} } = {}) {
  if (minusHit(t.title, settings.minusWords || [])) return 'minus';
  const byKey = new Map(nomenclature.map((n) => [nomenKey(n), n]));
  const matched = (t.matches || []).filter((m) => m.type !== 'company').map((m) => byKey.get(String(m.ref).toLowerCase())).filter(Boolean);
  if (matched.length && !matched.some((n) => contextOk(t.title, n.context || []))) return 'context';
  return null;
}

export function lawAllowed(law, laws = {}) {
  if (law === '44') return laws.fz44 !== false;
  if (law === '223') return laws.fz223 !== false;
  if (law === '615') return laws.fz615 !== false;
  return true;
}

/** Закон и НМЦК из настроек. Карточки без цены не отсекаются. */
export function settingsAllow(t, settings = {}) {
  if (!lawAllowed(t.law, settings.laws)) return false;
  if (typeof t.price === 'number' && t.price > 0) {
    if (settings.priceMin != null && t.price < settings.priceMin) return false;
    if (settings.priceMax != null && t.price > settings.priceMax) return false;
  }
  return true;
}

export const SUBJECTS = { supply: 'Поставка', works: 'Работы и услуги' };

const WORKS = /(?<![а-яё])(выполнени|работ|услуг|ремонт|монтаж|демонтаж|обслуживан|прокладк|строительств|реконструкц|проектн|восстановлени|замен[аеуы]|изготовлени|нанесени)/i;
const SUPPLY = /(?<![а-яё])(поставк|приобретени|закупк|купл|покупк)/i;

export function subjectOf(title) {
  const s = String(title ?? '');
  const supply = SUPPLY.exec(s);
  const works = WORKS.exec(s);
  if (supply && (!works || supply.index < works.index)) return 'supply';
  return works ? 'works' : 'supply';
}

export const CUSTOMER_TYPES = {
  heat: 'Теплоснабжение и энергетика',
  municipal: 'Муниципальные, ЖКХ',
  industrial: 'Промышленные предприятия',
  budget: 'Бюджетные учреждения',
  other: 'Прочие',
};

const CUSTOMER_RULES = [
  ['heat', /т плюс|тгк|тепл|энергетик|генерац|котельн|сгк|квадра|мосэнерго|интер рао|грэс|тэц|энерго(?![а-я]*сбыт)/],
  ['municipal', /(^|[^а-я])(муп|мку|мбу|мау|гуп|гкп|мкп)([^а-я]|$)|муниципальн|администрац|водоканал|жкх|коммунальн|жилищн/],
  ['industrial', /(^|[^а-я])(нефт|газпром|газ|завод|комбинат|горно|металлург|химич|рудник|аэс|гэс|росатом|вагон|машиностро|алюмин|русал|сибур|угол|уголь|шахт)/],
  ['budget', /(^|[^а-я])(гбу|гку|гау|фку|фгбу|фгку|фгуп|фгбоу|мбоу|гбоу|гбуз|гауз|кгбу|огбу|бу)([^а-я]|$)|учреждени|министерств|управлени|департамент/],
];

/** Тип заказчика по его названию, а если оно ничего не говорит — по предмету закупки. */
export function customerTypeOf(t) {
  for (const text of [t.customer, t.title]) {
    const s = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
    if (!s) continue;
    const hit = CUSTOMER_RULES.find(([, re]) => re.test(s));
    if (hit) return hit[0];
  }
  return 'other';
}

export function isSmpOnly(t) {
  return /субъект[а-яё]*\s+малого\s+и\s+среднего|(^|[^а-я])(смп|мсп)([^а-я]|$)/i.test(`${t.method || ''} ${t.title || ''}`);
}

export const METHOD_GROUPS = {
  auction: 'Аукцион',
  quotes: 'Запрос котировок / цен',
  proposals: 'Запрос предложений',
  contest: 'Конкурс',
  other: 'Иной способ',
};

export function methodGroupOf(t) {
  const s = `${t.method || ''}`.toLowerCase();
  if (/аукцион/.test(s)) return 'auction';
  if (/котировок|запрос цен|мониторинг цен/.test(s)) return 'quotes';
  if (/предложени/.test(s)) return 'proposals';
  if (/конкурс/.test(s)) return 'contest';
  return 'other';
}
