/**
 * TLS к ЕИС (zakupki.gov.ru).
 *
 * С 4 июля 2026 сайт отдаёт сертификат, выпущенный удостоверяющим центром
 * Минцифры (Russian Trusted Root CA). Этот корень не входит в набор Mozilla,
 * которым пользуется Node.js, поэтому обычный fetch падает с
 * «fetch failed» / UNABLE_TO_GET_ISSUER_CERT_LOCALLY.
 *
 * Здесь проверка TLS не отключается: к стандартным корням Node добавляются
 * официальные PEM Минцифры, и запрос идёт через https с этим набором CA.
 * NODE_EXTRA_CA_CERTS читается только при старте процесса, поэтому доверие
 * задаётся прямо в агенте — так работает и локальный запуск, и контейнер Amvera.
 */
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs');

const CERT_FILES = ['russian-trusted-root-ca.pem', 'russian-trusted-sub-ca.pem'];

const CAUSE_HINTS = {
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'нет доверия к сертификату ЕИС',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'не удалось проверить сертификат ЕИС',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'сертификат без доверенного корня',
  ERR_TLS_CERT_ALTNAME_INVALID: 'имя в сертификате не совпадает с адресом',
  CERT_HAS_EXPIRED: 'срок сертификата истёк',
  ECONNRESET: 'соединение сброшено',
  ECONNREFUSED: 'соединение отклонено',
  ENOTFOUND: 'адрес ЕИС не найден',
  EAI_AGAIN: 'адрес ЕИС не найден',
  ETIMEDOUT: 'таймаут соединения',
  UND_ERR_CONNECT_TIMEOUT: 'таймаут соединения',
  UND_ERR_HEADERS_TIMEOUT: 'таймаут ответа',
  UND_ERR_BODY_TIMEOUT: 'таймаут ответа',
  EPROTO: 'ошибка протокола TLS',
};

let cachedExtra;

/** PEM дополнительных CA Минцифры (корень и промежуточный). */
export function loadExtraCas() {
  if (cachedExtra) return cachedExtra;
  const pems = [];
  for (const name of CERT_FILES) {
    const file = path.join(certDir, name);
    if (!fs.existsSync(file)) continue;
    const pem = fs.readFileSync(file, 'utf8').trim();
    if (pem.includes('BEGIN CERTIFICATE')) pems.push(pem);
  }
  cachedExtra = pems;
  return pems;
}

/** Человекочитаемые subject дополнительных CA — для журнала старта. */
export function extraCaLabels() {
  return loadExtraCas().map((pem) => {
    try {
      return new X509Certificate(pem).subject.split('\n').find((line) => line.startsWith('CN='))?.slice(3) || 'CA';
    } catch {
      return 'CA';
    }
  });
}

/** Стандартные корни Node плюс сертификаты Минцифры. */
export function trustedCas() {
  return [...tls.rootCertificates, ...loadExtraCas()];
}

/**
 * Резолв только в IPv4. У части площадок объявлен IPv6, с которого облако
 * не соединяется, и запрос зависает. Сигнатуру callback оставляем как у
 * dns.lookup: при options.all === true вторым аргументом приходит массив.
 */
function lookupIpv4(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const wantAll = Boolean(options.all);
  dns.lookup(hostname, { ...options, family: 4, all: wantAll }, (err, address, family) => {
    if (err) {
      callback(err);
      return;
    }
    if (wantAll) callback(null, address);
    else callback(null, address, family);
  });
}

function decodeBody(headers, buf) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) return zlib.gunzipSync(buf);
  if (enc.includes('deflate')) return zlib.inflateSync(buf);
  if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
  return buf;
}

function rawRequest(url, opts, agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: opts.method || 'GET',
        headers: opts.headers,
        agent: u.protocol === 'https:' ? agent : undefined,
        servername: net.isIP(u.hostname) ? undefined : u.hostname,
        lookup: lookupIpv4,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          let body;
          try {
            body = decodeBody(res.headers, Buffer.concat(chunks));
          } catch (err) {
            fail(err);
            return;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            text: async () => body.toString('utf8'),
          });
        });
      },
    );
    const abort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      req.destroy(err);
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener('abort', abort, { once: true });
    }
    req.setTimeout(timeoutMs, () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      req.destroy(err);
    });
    req.on('error', fail);
    req.end();
  });
}

/**
 * fetch-совместимый клиент только для ЕИС: доверяет Минцифры, предпочитает IPv4,
 * сам распаковывает gzip. Редиректы — не больше пяти, только http(s).
 */
export function createEisFetch({ timeoutMs = 25000 } = {}) {
  const agent = new https.Agent({
    ca: trustedCas(),
    keepAlive: true,
    rejectUnauthorized: true,
    maxSockets: 4,
  });
  async function eisFetch(url, opts = {}, redirects = 0) {
    const res = await rawRequest(url, opts, agent, timeoutMs);
    const location = res.headers.location;
    if (location && [301, 302, 303, 307, 308].includes(res.status) && redirects < 5) {
      const next = new URL(location, url);
      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new Error(`редирект на неподдерживаемую схему ${next.protocol}`);
      }
      return eisFetch(next.toString(), opts, redirects + 1);
    }
    return res;
  }
  return eisFetch;
}

/** Сообщение для журнала и тоста: не прячем cause за общим «fetch failed». */
export function describeFetchError(err) {
  if (!err) return 'неизвестная ошибка';
  if (err.name === 'AbortError') return 'таймаут';
  const parts = [];
  const seen = new Set();
  let cur = err;
  let hint = '';
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    if (cur.code) {
      parts.push(String(cur.code));
      hint = hint || CAUSE_HINTS[cur.code] || '';
    }
    const message = cur.message;
    if (message && message !== 'fetch failed' && !parts.includes(message)) parts.push(message);
    cur = cur.cause;
  }
  const text = parts.filter(Boolean).join(': ') || err.message || 'ошибка запроса';
  return hint && !text.includes(hint) ? `${hint}: ${text}` : text;
}
