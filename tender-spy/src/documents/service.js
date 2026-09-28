import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { findEisTwin } from '../tenders.js';
import { classify, extOf, extractArchive, officeToPdf, tools } from './convert.js';
import {
  documentsUrlFromCard,
  fileNameFromDisposition,
  guessDocumentsUrl,
  isEisUrl,
  parseDocumentLinks,
  printFormUrl,
} from './eis-documents.js';

export const DOC_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 60 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxLeaves: 80,
  archiveDepth: 2,
  maxPagesPerDoc: 300,
  maxPagesSpreadsheet: 60,
  maxTotalPages: 1500,
};

class UserError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const safeId = (id) => String(id).replace(/[^\w.-]+/g, '_');

function safeFileName(name, fallback) {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(-120);
  return clean || fallback;
}

export function eisCardUrl(tender) {
  if (tender.links?.zakupki && isEisUrl(tender.links.zakupki)) return tender.links.zakupki;
  if ((tender.source || 'zakupki') === 'zakupki' && isEisUrl(tender.url)) return tender.url;
  return null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : '');
const fmtPrice = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`);

function coverHtml(tender, docs, notes, startPage) {
  const rows = docs
    .map((d, i) => {
      const page = d.pages ? String(d.startPage + startPage) : '—';
      const status = d.status === 'ok' ? '' : d.note || '';
      return `<tr><td>${i + 1}</td><td>${esc(d.name)}${d.from ? `<br><small>из архива ${esc(d.from)}</small>` : ''}</td><td class="num">${page}</td><td class="num">${d.pages || ''}</td><td><small>${esc(status)}</small></td></tr>`;
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; font-size: 10pt; }
h1 { font-size: 15pt; margin: 0 0 6pt; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #999; padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background: #eee; }
.num { text-align: right; white-space: nowrap; }
.meta td { border: none; padding: 1pt 5pt 1pt 0; }
small { color: #555; }
</style></head><body>
<h1>Документация закупки № ${esc(tender.number)}</h1>
<p><b>${esc(tender.title)}</b></p>
<table class="meta">
<tr><td>Заказчик:</td><td>${esc(tender.customer || '—')}</td></tr>
<tr><td>Начальная цена:</td><td>${esc(fmtPrice(tender.price))}</td></tr>
${tender.deadlineAt ? `<tr><td>Окончание подачи:</td><td>${esc(fmtDate(tender.deadlineAt))}</td></tr>` : ''}
<tr><td>Карточка в ЕИС:</td><td>${esc(eisCardUrl(tender) || tender.url)}</td></tr>
<tr><td>Документы извлечены:</td><td>${esc(new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} (МСК)</td></tr>
</table>
<h2 style="font-size:12pt">Содержание</h2>
<table><tr><th>№</th><th>Документ</th><th>Стр.</th><th>Листов</th><th>Примечание</th></tr>${rows}</table>
${notes.length ? `<p><small>${notes.map(esc).join('<br>')}</small></p>` : ''}
</body></html>`;
}

function addOutline(doc, items) {
  if (!items.length) return;
  const ctx = doc.context;
  const pages = doc.getPages();
  const rootRef = ctx.nextRef();
  const refs = items.map(() => ctx.nextRef());
  items.forEach((it, i) => {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(it.title),
      Parent: rootRef,
      Dest: [pages[it.pageIndex].ref, PDFName.of('Fit')],
    });
    if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
    ctx.assign(refs[i], dict);
  });
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

async function imageToPdf(file, ext, out) {
  const doc = await PDFDocument.create();
  const bytes = fs.readFileSync(file);
  const img = ext === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  // A4, картинка вписана с полями.
  const [w, h] = img.width > img.height ? [842, 595] : [595, 842];
  const scale = Math.min((w - 40) / img.width, (h - 40) / img.height, 1);
  const page = doc.addPage([w, h]);
  page.drawImage(img, { x: (w - img.width * scale) / 2, y: (h - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  fs.writeFileSync(out, await doc.save());
  return out;
}

/**
 * Извлекает документацию закупки из ЕИС и собирает её в один PDF:
 * титульный лист с содержанием, затем все документы (Word/Excel/RTF/HTML через LibreOffice,
 * PDF как есть, архивы распаковываются). Результат хранится рядом с базой.
 */
export class DocumentService {
  constructor({ store, fetchImpl, dataDir, userAgent = 'Mozilla/5.0', delayMs = 400, platformName = (id) => id, limits = {}, log = console, convert = {} }) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.root = path.join(dataDir, 'documents');
    this.userAgent = userAgent;
    this.delayMs = delayMs;
    this.platformName = platformName;
    this.limits = { ...DOC_LIMITS, ...limits };
    this.log = log;
    this.convert = { officeToPdf, extractArchive, tools, ...convert };
    this.jobs = new Map();
    this.listeners = new Set();
    for (const t of Object.values(store.tenders)) {
      if (t.documents?.state === 'running') t.documents = { ...t.documents, state: 'error', error: 'Извлечение прервано перезапуском сервера' };
    }
  }

  onUpdate(fn) {
    this.listeners.add(fn);
  }

  emit(job) {
    for (const fn of this.listeners) fn(this.snapshot(job));
  }

  dirFor(id) {
    return path.join(this.root, safeId(id));
  }

  snapshot(job) {
    const { tender, ...rest } = job;
    return JSON.parse(JSON.stringify(rest));
  }

  get(id) {
    const job = this.jobs.get(id);
    if (job) return this.snapshot(job);
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dirFor(id), 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  pdfFile(id) {
    const file = path.join(this.dirFor(id), 'documents.pdf');
    return fs.existsSync(file) ? file : null;
  }

  originalFile(id, index) {
    const m = this.get(id);
    const o = m?.originals?.find((x) => x.index === Number(index));
    if (!o) return null;
    const file = path.join(this.dirFor(id), 'originals', o.file);
    return fs.existsSync(file) ? { file, name: o.name } : null;
  }

  start(id) {
    const running = this.jobs.get(id);
    if (running?.state === 'running') return this.snapshot(running);
    const tender = this.store.tenders[id];
    if (!tender) throw new UserError('Тендер не найден');
    const job = { tenderId: id, state: 'running', step: 'Ищем документы в ЕИС', startedAt: new Date().toISOString(), files: [], originals: [], notes: [], pages: 0, tender };
    this.jobs.set(id, job);
    this.setTenderInfo(id, { state: 'running', startedAt: job.startedAt });
    this.run(job)
      .catch((err) => {
        job.state = 'error';
        job.error = err instanceof UserError ? err.message : `Не удалось извлечь документы: ${err.message}`;
        if (!(err instanceof UserError)) this.log.warn?.(`[documents] ${id}: ${err.stack || err.message}`);
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.step = null;
        this.writeManifest(job);
        this.setTenderInfo(id, {
          state: job.state,
          at: job.finishedAt,
          pages: job.pages,
          files: job.files.filter((f) => f.pages).length,
          skipped: job.files.filter((f) => !f.pages).length,
          error: job.error,
        });
        this.jobs.delete(id);
        this.emit(job);
      });
    return this.snapshot(job);
  }

  setTenderInfo(id, info) {
    const t = this.store.tenders[id];
    if (!t) return;
    t.documents = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined));
    this.store.scheduleSave();
  }

  writeManifest(job) {
    try {
      fs.mkdirSync(this.dirFor(job.tenderId), { recursive: true });
      fs.writeFileSync(path.join(this.dirFor(job.tenderId), 'manifest.json'), JSON.stringify(this.snapshot(job), null, 2));
    } catch (err) {
      this.log.warn?.(`[documents] manifest: ${err.message}`);
    }
  }

  step(job, text) {
    job.step = text;
    this.emit(job);
  }

  async fetchRes(url, { timeoutMs = 90_000, accept = '*/*' } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': this.userAgent, Accept: accept, 'Accept-Language': 'ru-RU,ru;q=0.9' },
      });
      if (!res.ok) throw new Error(`ЕИС ответил HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('ЕИС не ответил вовремя');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchText(url, opts) {
    const res = await this.fetchRes(url, { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', ...opts });
    return res.text();
  }

  async run(job) {
    const { tender, tenderId } = job;
    const L = this.limits;
    const dir = this.dirFor(tenderId);
    fs.rmSync(dir, { recursive: true, force: true });
    const originalsDir = path.join(dir, 'originals');
    const workDir = path.join(dir, 'work');
    const pdfDir = path.join(workDir, 'pdf');
    fs.mkdirSync(originalsDir, { recursive: true });
    fs.mkdirSync(pdfDir, { recursive: true });

    const twin = eisCardUrl(tender) ? null : findEisTwin(tender, this.store.tenders);
    if (twin) job.notes.push(`Документы взяты из ЕИС: та же закупка опубликована под № ${twin.number}.`);
    const cardUrl = eisCardUrl(tender) || (twin && eisCardUrl(twin));
    if (!cardUrl) {
      const name = this.platformName(tender.source);
      throw new UserError(
        `Документацию на площадке «${name}» выдают только после входа в личный кабинет, а в ЕИС эта закупка не найдена. Откройте закупку по ссылке и скачайте файлы на площадке.`,
      );
    }

    let docsUrl = guessDocumentsUrl(cardUrl);
    let cardHtml = null;
    if (!docsUrl) {
      cardHtml = await this.fetchText(cardUrl, { timeoutMs: 40_000 });
      docsUrl = documentsUrlFromCard(cardHtml, cardUrl);
      if (!docsUrl) throw new UserError('В карточке ЕИС нет вкладки «Документы» — возможно, закупка ещё не опубликована полностью.');
    }
    const docsHtml = await this.fetchText(docsUrl, { timeoutMs: 40_000 });
    const links = parseDocumentLinks(docsHtml, docsUrl);
    if (links.length > L.maxFiles) job.notes.push(`В ЕИС ${links.length} файлов, взяты первые ${L.maxFiles}.`);
    const printUrl = printFormUrl(docsHtml, docsUrl) || (cardHtml && printFormUrl(cardHtml, cardUrl));
    if (!links.length && !printUrl) throw new UserError('К закупке в ЕИС не приложено ни одного файла.');

    const leaves = [];
    if (printUrl) {
      this.step(job, 'Скачиваем печатную форму извещения');
      try {
        const html = await this.fetchText(printUrl, { timeoutMs: 25_000 });
        const file = path.join(workDir, 'print-form.html');
        fs.writeFileSync(file, html);
        leaves.push({ file, name: 'Извещение (печатная форма ЕИС)', forceExt: 'html' });
      } catch (err) {
        job.notes.push(`Печатная форма извещения не загрузилась (${err.message}).`);
      }
    }

    let total = 0;
    const list = links.slice(0, L.maxFiles);
    for (let i = 0; i < list.length; i++) {
      const link = list[i];
      this.step(job, `Скачиваем файл ${i + 1} из ${list.length}: ${link.name}`);
      try {
        const res = await this.fetchRes(link.url, { timeoutMs: 180_000 });
        const buf = res.buffer ? await res.buffer() : Buffer.from(await res.arrayBuffer());
        if (buf.length > L.maxFileBytes) throw new Error(`файл больше ${Math.round(L.maxFileBytes / 1048576)} МБ`);
        total += buf.length;
        if (total > L.maxTotalBytes) throw new Error('превышен общий объём документации');
        const name = link.name && extOf(link.name) ? link.name : fileNameFromDisposition(typeof res.headers?.get === 'function' ? res.headers.get('content-disposition') : res.headers?.['content-disposition']) || link.name;
        const index = job.originals.length + 1;
        const stored = `${String(index).padStart(2, '0')}-${safeFileName(name, `file${index}`)}`;
        const file = path.join(originalsDir, stored);
        fs.writeFileSync(file, buf);
        job.originals.push({ index, name, file: stored, size: buf.length });
        leaves.push({ file, name, original: index });
      } catch (err) {
        job.files.push({ name: link.name, status: 'error', note: `не скачался: ${err.message}` });
      }
      if (i < list.length - 1) await sleep(this.delayMs);
    }

    this.step(job, 'Распаковываем архивы');
    const expanded = await this.expand(leaves, workDir, job);

    const docs = [];
    let totalPages = 0;
    for (let i = 0; i < expanded.length; i++) {
      const leaf = expanded[i];
      const entry = { name: leaf.name, from: leaf.from, original: leaf.original, status: 'ok' };
      const head = fs.readFileSync(leaf.file).subarray(0, 512);
      const type = leaf.forceExt ? { kind: 'office', ext: leaf.forceExt } : classify(leaf.name, head);
      this.step(job, `Переводим в PDF ${i + 1} из ${expanded.length}: ${leaf.name}`);
      try {
        let pdf = null;
        if (type.kind === 'pdf') pdf = leaf.file;
        else if (type.kind === 'office') pdf = await this.convert.officeToPdf(leaf.file, pdfDir, { ext: type.ext });
        else if (type.kind === 'image') pdf = await imageToPdf(leaf.file, type.ext, path.join(pdfDir, `img-${i}.pdf`));
        else if (type.kind === 'signature') Object.assign(entry, { status: 'skipped', note: 'файл электронной подписи' });
        else if (type.kind === 'archive') Object.assign(entry, { status: 'skipped', note: 'вложенный архив слишком глубоко' });
        else Object.assign(entry, { status: 'skipped', note: `формат .${type.ext || '?'} не переводится в PDF` });
        if (pdf) {
          const src = await PDFDocument.load(fs.readFileSync(pdf), { ignoreEncryption: true, updateMetadata: false });
          const count = src.getPageCount();
          const cap = Math.min(type.spreadsheet ? L.maxPagesSpreadsheet : L.maxPagesPerDoc, L.maxTotalPages - totalPages);
          if (cap <= 0) {
            Object.assign(entry, { status: 'skipped', note: `не вошёл: общий PDF уже ${L.maxTotalPages} стр.` });
          } else {
            const take = Math.min(count, cap);
            Object.assign(entry, { pdf, pages: take, totalPages: count });
            if (take < count) Object.assign(entry, { status: 'truncated', note: `в PDF первые ${take} из ${count} стр., полностью — в оригинале` });
            totalPages += take;
          }
        }
      } catch (err) {
        Object.assign(entry, { status: 'error', note: `не удалось перевести в PDF: ${err.message}` });
      }
      docs.push(entry);
    }
    let offset = 0;
    for (const d of docs) {
      if (!d.pages) continue;
      d.startPage = offset + 1;
      offset += d.pages;
    }
    job.files.push(...docs.map(({ pdf, ...rest }) => rest));

    const withPages = docs.filter((d) => d.pages);
    if (!withPages.length) {
      const why = !this.convert.tools().soffice && docs.some((d) => /LibreOffice/.test(d.note || '')) ? ' На сервере не установлен LibreOffice.' : '';
      throw new UserError(`Ни один документ не удалось перевести в PDF.${why}`);
    }

    this.step(job, 'Собираем общий PDF');
    const merged = await PDFDocument.create();
    merged.setTitle(`Документация закупки № ${tender.number}`);
    merged.setSubject(tender.title || '');
    merged.setCreator('Tender Spy');
    const cover = await this.buildCover(tender, job.files, job.notes, pdfDir);
    const outline = [];
    job.coverPages = cover ? cover.getPageCount() : 0;
    if (cover) {
      const pages = await merged.copyPages(cover, cover.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
      outline.push({ title: 'Содержание', pageIndex: 0 });
    }
    for (const d of docs) {
      if (!d.pages) continue;
      const src = await PDFDocument.load(fs.readFileSync(d.pdf), { ignoreEncryption: true, updateMetadata: false });
      const indices = Array.from({ length: d.pages }, (_, k) => k);
      outline.push({ title: d.from ? `${d.name} (${d.from})` : d.name, pageIndex: merged.getPageCount() });
      const pages = await merged.copyPages(src, indices);
      pages.forEach((p) => merged.addPage(p));
    }
    addOutline(merged, outline);
    fs.writeFileSync(path.join(dir, 'documents.pdf'), await merged.save());
    fs.rmSync(workDir, { recursive: true, force: true });
    job.pages = merged.getPageCount();
    job.state = 'done';
  }

  async buildCover(tender, docs, notes, pdfDir) {
    if (!this.convert.tools().soffice) return null;
    try {
      let coverPages = 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        const html = path.join(pdfDir, `cover-${attempt}.html`);
        fs.writeFileSync(html, coverHtml(tender, docs, notes, coverPages));
        const pdf = await this.convert.officeToPdf(html, pdfDir, { ext: 'html' });
        const doc = await PDFDocument.load(fs.readFileSync(pdf));
        if (doc.getPageCount() === coverPages) return doc;
        coverPages = doc.getPageCount();
        if (attempt === 1) return doc;
      }
    } catch (err) {
      this.log.warn?.(`[documents] cover: ${err.message}`);
    }
    return null;
  }

  async expand(leaves, workDir, job, depth = 0) {
    const out = [];
    for (const leaf of leaves) {
      if (out.length >= this.limits.maxLeaves) {
        job.notes.push(`Файлов больше ${this.limits.maxLeaves} — остальные не вошли в PDF.`);
        break;
      }
      const head = fs.readFileSync(leaf.file).subarray(0, 512);
      const type = leaf.forceExt ? { kind: 'office' } : classify(leaf.name, head);
      if (type.kind !== 'archive' || depth >= this.limits.archiveDepth) {
        out.push(leaf);
        continue;
      }
      const target = path.join(workDir, `x${depth}-${out.length}-${Math.random().toString(36).slice(2, 8)}`);
      try {
        const files = await this.convert.extractArchive(leaf.file, target);
        const archiveLabel = leaf.from ? `${leaf.from} / ${leaf.name}` : leaf.name;
        const inner = files.map((file) => ({
          file,
          name: path.relative(target, file).split(path.sep).join(' / '),
          from: archiveLabel,
          original: leaf.original,
        }));
        if (!inner.length) {
          job.files.push({ name: leaf.name, from: leaf.from, status: 'skipped', note: 'пустой архив' });
          continue;
        }
        out.push(...(await this.expand(inner, workDir, job, depth + 1)));
      } catch (err) {
        job.files.push({ name: leaf.name, from: leaf.from, original: leaf.original, status: 'error', note: `архив не распаковался: ${err.message}` });
      }
    }
    return out.slice(0, this.limits.maxLeaves);
  }
}

export { UserError as DocumentsError, findEisTwin };
