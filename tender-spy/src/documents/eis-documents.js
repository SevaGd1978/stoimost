// Разбор вкладки «Документы» карточки закупки в ЕИС (44-ФЗ и 223-ФЗ).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', ndash: '–', mdash: '—' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function absolute(href, base) {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return null;
  }
}

export function isEisUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'zakupki.gov.ru';
  } catch {
    return false;
  }
}

/** Адрес вкладки «Документы» без загрузки карточки — работает для 44-ФЗ. */
export function guessDocumentsUrl(cardUrl) {
  if (!isEisUrl(cardUrl)) return null;
  const u = new URL(cardUrl);
  if (!/\/epz\/order\/notice\/[^/]+\/view\/common-info\.html$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/common-info\.html$/, 'documents.html');
  return u.toString();
}

/** Ссылка на вкладку «Документы» из HTML карточки (для 223-ФЗ в ней есть noticeGuid). */
export function documentsUrlFromCard(html, cardUrl) {
  const m = String(html).match(/href="([^"]*\/documents\.html\?[^"]*)"/);
  return m ? absolute(m[1], cardUrl) : null;
}

/** Печатная форма извещения (HTML), если ЕИС её показывает. */
export function printFormUrl(html, pageUrl) {
  const links = [...String(html).matchAll(/href="([^"]*\/printForm\/view(?:ByVersionNumber)?\.html\?[^"]*)"/g)].map((m) => m[1]);
  const best = links.find((h) => /\/printForm\/view\.html/.test(h)) || links[0];
  return best ? absolute(best, pageUrl) : null;
}

function fileNameFromExtension(name) {
  return /\.[a-z0-9]{1,5}$/i.test(name) ? name : null;
}

/**
 * Прикреплённые файлы: [{ uid, url, name }]. Файлы недействующих редакций пропускаются —
 * иначе одна и та же документация попадёт в PDF несколько раз.
 */
export function parseDocumentLinks(html, pageUrl = 'https://zakupki.gov.ru/') {
  const text = String(html);
  const out = [];
  const seen = new Set();
  // Атрибуты могут содержать «>» внутри кавычек (data-tooltip с HTML), поэтому разбираем их с учётом кавычек.
  const re = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/g;
  for (const m of text.matchAll(re)) {
    const [, attrs, inner] = m;
    const hrefMatch = attrs.match(/href="([^"]*\/filestore\/public\/[^"]*?[?&]uid=([0-9A-Za-z-]+)[^"]*)"/);
    if (!hrefMatch) continue;
    const [, href, uid] = hrefMatch;
    const key = uid.toUpperCase();
    if (seen.has(key)) continue;
    const edition = text.lastIndexOf('Редакция', m.index);
    if (edition >= 0 && /Недейств/i.test(stripTags(text.slice(edition, edition + 600)).slice(0, 60))) continue;
    const title = attrs.match(/title="([^"]*)"/)?.[1];
    const tooltip = attrs.match(/data-tooltip='([^']*)'/)?.[1] ?? attrs.match(/data-tooltip="([^"]*)"/)?.[1];
    const candidates = [title, tooltip, inner].map((v) => (v == null ? '' : stripTags(decodeEntities(v))));
    const name = candidates.map(fileNameFromExtension).find(Boolean) || candidates.find(Boolean) || `файл-${key.slice(0, 8)}`;
    const url = absolute(href, pageUrl);
    if (!url) continue;
    seen.add(key);
    out.push({ uid: key, url, name });
  }
  return out;
}

/** Имя файла из Content-Disposition: ЕИС отдаёт UTF-8 без кодирования, Node читает его как latin1. */
export function fileNameFromDisposition(header) {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim());
    } catch {
      /* ниже — обычный filename */
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"/i) || header.match(/filename\s*=\s*([^;]+)/i);
  if (!plain) return null;
  const raw = plain[1].trim();
  const bytes = Buffer.from(raw, 'latin1');
  const utf8 = bytes.toString('utf8');
  return utf8.includes('\uFFFD') ? raw : utf8;
}
