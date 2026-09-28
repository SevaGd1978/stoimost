import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  cdataPropName: '__cdata',
  trimValues: true,
});

function text(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (node.__cdata != null) return String(node.__cdata);
  if (node['#text'] != null) return String(node['#text']);
  return '';
}

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Описание в RSS ЕИС — набор строк вида «<b>Метка:</b> значение<br/>».
 * Превращаем в словарь {метка(lowercase) → значение}.
 */
export function parseDescriptionFields(html) {
  const fields = {};
  for (const rawLine of stripHtml(html).split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key && !(key in fields)) fields[key] = value;
  }
  return fields;
}

/** Ищет значение по фрагменту метки («заказчик», «цена» и т.п.). */
export function pickField(fields, ...needles) {
  for (const needle of needles) {
    const n = needle.toLowerCase();
    for (const [key, value] of Object.entries(fields)) {
      if (key.includes(n)) return value;
    }
  }
  return '';
}

function decodeEntities(value) {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(block, name) {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? decodeEntities(match[1]).trim() : '';
}

/**
 * ЕИС иногда отдаёт RSS, который XML-парсер схлопывает в ноль записей
 * (неэкранированная разметка в описании). Теги item при этом на месте.
 */
export function itemsFromMarkup(xml) {
  const out = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    out.push({
      title: tagText(block, 'title'),
      link: tagText(block, 'link'),
      description: tagText(block, 'description'),
      pubDate: tagText(block, 'pubDate') || tagText(block, 'date'),
      guid: tagText(block, 'guid'),
    });
  }
  return out;
}

function mapParsedItem(it) {
  return {
    title: text(it.title),
    link: text(it.link) || it.link?.['@_href'] || '',
    description: text(it.description) || text(it.summary) || text(it.content),
    pubDate: text(it.pubDate) || text(it.updated) || text(it.published),
    guid: text(it.guid) || text(it.id),
  };
}

/** Возвращает массив {title, link, description, pubDate, guid} из RSS 2.0 / Atom. */
export function parseRss(xml) {
  if (!xml || !String(xml).trim()) return [];
  const raw = String(xml);
  let parsed = [];
  try {
    const doc = parser.parse(raw);
    let items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
    if (!Array.isArray(items)) items = items ? [items] : [];
    parsed = items.filter(Boolean).map(mapParsedItem);
  } catch {
    parsed = [];
  }
  const fromTags = /<item\b/i.test(raw) ? itemsFromMarkup(raw) : [];
  return fromTags.length > parsed.length ? fromTags : parsed;
}
