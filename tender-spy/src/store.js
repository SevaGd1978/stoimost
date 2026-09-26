import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parsePriceBound, staleNotice } from './tenders.js';
import { PLATFORM_IDS } from './sources/platforms/index.js';
import { DEFAULT_MINUS_WORDS, parseWordList } from './filters.js';
import { regionFromText } from './regions.js';

const DB_VERSION = 1;
const REMOVED_SALE_SOURCES = new Set(['torgi', 'rad']);

export function defaultPlatforms() {
  return Object.fromEntries(PLATFORM_IDS.map((id) => [id, true]));
}

export function defaultSettings() {
  return {
    pollIntervalMin: 30,
    onlyOpen: true,
    laws: { fz44: true, fz223: true, fz615: false },
    searchContracts: true,
    notifyTelegram: false,
    /** Диапазон НМЦК для запросов к ЕИС, ₽. null — без границы. */
    priceMin: null,
    priceMax: null,
    /** Какие площадки опрашивать помимо ЕИС: { [id]: boolean }. */
    platforms: defaultPlatforms(),
    /** Закупки, в названии которых есть такое слово (фраза — все её слова), не попадают в ленту. */
    minusWords: [...DEFAULT_MINUS_WORDS],
  };
}

function emptyDb() {
  return {
    version: DB_VERSION,
    watchlist: { companies: [], nomenclature: [] },
    tenders: {},
    runs: [],
    settings: defaultSettings(),
  };
}

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

/**
 * Простое файловое хранилище: весь state в одном JSON, запись атомарная
 * (через временный файл), чтобы обрыв процесса не портил базу.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.db = emptyDb();
    this._saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.db = { ...emptyDb(), ...parsed };
      this.db.settings = { ...defaultSettings(), ...(parsed.settings || {}) };
      const saved = parsed.settings?.platforms || {};
      this.db.settings.platforms = Object.fromEntries(PLATFORM_IDS.map((id) => [id, saved[id] !== false]));
      this.dropPropertySales();
      this.closeStaleNotices();
      for (const t of Object.values(this.db.tenders)) {
        const fromTitle = (t.cardAt || !t.region) && regionFromText(t.title);
        if (fromTitle) t.region = fromTitle;
      }
      this.db.watchlist = {
        companies: parsed.watchlist?.companies ?? [],
        nomenclature: parsed.watchlist?.nomenclature ?? [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] не удалось прочитать ${this.file}: ${err.message}. Стартуем с пустой базой.`);
      }
      this.db = emptyDb();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Отложенная запись: много мелких правок подряд — один сброс на диск. */
  scheduleSave(delayMs = 300) {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        this.save();
      } catch (err) {
        console.error('[store] ошибка записи:', err.message);
      }
    }, delayMs);
    this._saveTimer.unref?.();
  }

  // ---- watchlist -------------------------------------------------------

  get companies() {
    return this.db.watchlist.companies;
  }

  get nomenclature() {
    return this.db.watchlist.nomenclature;
  }

  addCompany({ inn, name, role = 'any', note = '' }) {
    const exists = this.companies.find((c) => c.inn === inn);
    if (exists) return { company: exists, created: false };
    const company = {
      id: newId('c_'),
      inn,
      name: name?.trim() || `ИНН ${inn}`,
      role,
      note: note?.trim() || '',
      createdAt: new Date().toISOString(),
    };
    this.companies.push(company);
    this.scheduleSave();
    return { company, created: true };
  }

  /**
   * Пакетный импорт компаний.
   * items: массив объектов { inn, name?, role?, note? }
   * options: { overwriteExisting: boolean }
   */
  importCompanies(items = [], { overwriteExisting = false } = {}) {
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const item of items) {
      const inn = String(item.inn || '').trim();
      if (!inn) {
        errors.push({ item, error: 'ИНН не указан' });
        continue;
      }
      const existing = this.companies.find((c) => c.inn === inn);
      if (existing) {
        if (overwriteExisting) {
          if (item.name?.trim()) existing.name = item.name.trim();
          if (['any', 'customer', 'supplier'].includes(item.role)) existing.role = item.role;
          if (typeof item.note === 'string') existing.note = item.note.trim();
          updated++;
        } else {
          skipped++;
        }
      } else {
        const company = {
          id: newId('c_'),
          inn,
          name: item.name?.trim() || `ИНН ${inn}`,
          role: ['any', 'customer', 'supplier'].includes(item.role) ? item.role : 'any',
          note: item.note?.trim() || '',
          createdAt: new Date().toISOString(),
        };
        this.companies.push(company);
        added++;
      }
    }
    if (added || updated) this.scheduleSave();
    return { added, updated, skipped, errors, total: this.companies.length };
  }

  updateCompany(id, patch) {
    const company = this.companies.find((c) => c.id === id);
    if (!company) return null;
    Object.assign(company, patch);
    this.scheduleSave();
    return company;
  }

  removeCompany(id) {
    const before = this.companies.length;
    this.db.watchlist.companies = this.companies.filter((c) => c.id !== id);
    this.scheduleSave();
    return this.companies.length !== before;
  }

  addNomenclature({ keyword, okpd2 = '', context = [] }) {
    const kw = keyword.trim();
    const code = okpd2.trim();
    const exists = this.nomenclature.find(
      (n) => n.keyword.toLowerCase() === kw.toLowerCase() && n.okpd2 === code,
    );
    if (exists) return { item: exists, created: false };
    const item = { id: newId('n_'), keyword: kw, okpd2: code, context: parseWordList(context), createdAt: new Date().toISOString() };
    this.nomenclature.push(item);
    this.scheduleSave();
    return { item, created: true };
  }

  /**
   * Пакетный импорт номенклатуры.
   * items: массив { keyword, okpd2 }
   * replace: очистить текущую номенклатуру перед добавлением.
   */
  importNomenclature(items = [], { replace = false } = {}) {
    if (replace) this.db.watchlist.nomenclature = [];
    let added = 0;
    let skipped = 0;
    for (const item of items) {
      const kw = String(item.keyword ?? '').trim();
      const code = String(item.okpd2 ?? '').trim();
      if (!kw && !code) continue;
      const exists = this.nomenclature.find(
        (n) => n.keyword.toLowerCase() === kw.toLowerCase() && n.okpd2 === code,
      );
      if (exists) {
        skipped++;
      } else {
        this.nomenclature.push({
          id: newId('n_'),
          keyword: kw,
          okpd2: code,
          context: parseWordList(item.context),
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }
    if (added || replace) this.scheduleSave();
    return { added, skipped, total: this.nomenclature.length };
  }

  /** Уточняющие слова позиции: в названии закупки должно быть хотя бы одно из них. */
  updateNomenclature(id, { context }) {
    const item = this.nomenclature.find((n) => n.id === id);
    if (!item) return null;
    if (context !== undefined) item.context = parseWordList(context);
    this.scheduleSave();
    return item;
  }

  removeNomenclature(id) {
    const before = this.nomenclature.length;
    this.db.watchlist.nomenclature = this.nomenclature.filter((n) => n.id !== id);
    this.scheduleSave();
    return this.nomenclature.length !== before;
  }

  // ---- watchlist export/import -----------------------------------------

  exportWatchlist() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      companies: this.companies.map((c) => ({
        inn: c.inn,
        name: c.name,
        role: c.role,
        note: c.note,
      })),
      nomenclature: this.nomenclature.map((n) => ({
        keyword: n.keyword,
        okpd2: n.okpd2,
        ...(n.context?.length ? { context: n.context } : {}),
      })),
    };
  }

  importWatchlist({ companies = [], nomenclature = [] }, { replace = false } = {}) {
    if (replace) {
      this.db.watchlist.companies = [];
      this.db.watchlist.nomenclature = [];
    }
    const cRes = this.importCompanies(companies, { overwriteExisting: !replace });
    const nRes = this.importNomenclature(nomenclature);
    return {
      companies: cRes,
      nomenclature: nRes,
    };
  }

  // ---- tenders ---------------------------------------------------------

  get tenders() {
    return this.db.tenders;
  }

  /**
   * Добавляет/обновляет тендер. Возвращает true, если тендер новый.
   * Совпадения (matches) объединяются, чтобы карточка помнила все причины попадания.
   */
  upsertTender(tender) {
    const now = new Date().toISOString();
    const existing = this.tenders[tender.id];
    if (!existing) {
      this.tenders[tender.id] = {
        ...tender,
        links: tender.links ?? (tender.url ? { [tender.source || 'zakupki']: tender.url } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
        seen: false,
        favorite: false,
        archived: false,
      };
      return true;
    }
    const matchKeys = new Set(existing.matches.map((m) => `${m.type}:${m.ref}`));
    for (const m of tender.matches) {
      if (!matchKeys.has(`${m.type}:${m.ref}`)) existing.matches.push(m);
    }
    existing.links = {
      ...(existing.links ?? (existing.url ? { [existing.source || 'zakupki']: existing.url } : {})),
      ...(tender.links ?? (tender.url ? { [tender.source || 'zakupki']: tender.url } : {})),
    };
    existing.lastSeenAt = now;

    // Этап, статус и основную ссылку ведёт один источник: ЕИС, если карточка
    // есть там, иначе площадка, которая нашла её первой. Остальные только
    // дополняют пустые поля, иначе разные названия этапа («Подача заявок» /
    // «Приём заявок») каждый опрос снова помечали бы карточку новой.
    const primary = tender.source === (existing.source || 'zakupki') || tender.source === 'zakupki';
    if (!primary) {
      existing.customer ||= tender.customer;
      existing.price ??= tender.price;
      existing.deadlineAt ||= tender.deadlineAt;
      existing.region ||= tender.region;
      return false;
    }
    const stageChanged = Boolean(tender.stage) && existing.stage !== tender.stage;
    Object.assign(existing, {
      source: tender.source || existing.source,
      title: tender.title || existing.title,
      customer: tender.customer || existing.customer,
      price: tender.price ?? existing.price,
      stage: tender.stage || existing.stage,
      isOpen: tender.isOpen ?? existing.isOpen,
      deadlineAt: tender.deadlineAt || existing.deadlineAt,
      updatedAt: tender.updatedAt || existing.updatedAt,
      url: tender.url || existing.url,
    });
    if (stageChanged) existing.seen = false;
    return false;
  }

  patchTender(id, patch) {
    const t = this.tenders[id];
    if (!t) return null;
    if ('seen' in patch) t.seen = Boolean(patch.seen);
    if ('archived' in patch) t.archived = Boolean(patch.archived);
    if ('favorite' in patch) {
      const fav = Boolean(patch.favorite);
      if (fav && !t.favorite) t.favoritedAt = new Date().toISOString();
      if (!fav) delete t.favoritedAt;
      t.favorite = fav;
    }
    if ('comment' in patch) {
      const comment = String(patch.comment ?? '').trim().slice(0, 2000);
      if (comment) t.comment = comment;
      else delete t.comment;
    }
    this.scheduleSave();
    return t;
  }

  markAllSeen() {
    let n = 0;
    for (const t of Object.values(this.tenders)) {
      if (!t.seen) {
        t.seen = true;
        n++;
      }
    }
    this.scheduleSave();
    return n;
  }

  /**
   * Убирает из ленты в архив просмотренные и закрытые карточки, кроме избранных.
   * Не удаляет: удалённая карточка при следующем опросе вернулась бы как новая.
   */
  archiveSeenAndClosed() {
    let n = 0;
    for (const t of Object.values(this.tenders)) {
      if (t.archived || t.favorite) continue;
      if (t.seen || (t.kind === 'notice' && t.isOpen === false)) {
        t.archived = true;
        t.seen = true;
        n++;
      }
    }
    this.scheduleSave();
    return n;
  }

  /** Продажа имущества в мониторинг не входит: убираем такие карточки, кроме избранных. */
  dropPropertySales() {
    let removed = 0;
    for (const [id, t] of Object.entries(this.tenders)) {
      const sale = t.category === 'sale' || REMOVED_SALE_SOURCES.has(t.source);
      if (sale && !t.favorite) {
        delete this.tenders[id];
        removed++;
      }
    }
    return removed;
  }

  /** Извещения ЕИС, для которых ещё не читали карточку (срок подачи, регион). */
  noticesWithoutCard(limit = 20) {
    return Object.values(this.tenders)
      .filter((t) => t.kind === 'notice' && t.isOpen && !t.archived && (t.source || 'zakupki') === 'zakupki' && !t.cardAt && (t.cardAttempts || 0) < 3)
      .sort((a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt))
      .slice(0, limit);
  }

  applyCard(id, card) {
    const t = this.tenders[id];
    if (!t) return null;
    if (!card) {
      t.cardAttempts = (t.cardAttempts || 0) + 1;
      return t;
    }
    t.cardAt = new Date().toISOString();
    if (card.deadlineAt) t.deadlineAt = card.deadlineAt;
    // В карточке 223-ФЗ — адрес головной компании; регион из предмета («для филиала «Владимирский»») точнее.
    const region = regionFromText(t.title) || card.region;
    if (region) t.region = region;
    if (card.customerInn) t.customerInn ||= card.customerInn;
    this.scheduleSave();
    return t;
  }

  closeStaleNotices(now = Date.now()) {
    let closed = 0;
    for (const t of Object.values(this.tenders)) {
      if (t.kind === 'notice' && t.isOpen && staleNotice(t, now)) {
        t.isOpen = false;
        t.stage = `${t.stage || 'Подача заявок'} (запись устарела)`;
        closed++;
      }
    }
    return closed;
  }

  /** Удаляет тендеры, которые давно не встречались в выборках и не отмечены избранными. */
  prune(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400_000;
    let removed = 0;
    for (const [id, t] of Object.entries(this.tenders)) {
      if (!t.favorite && Date.parse(t.lastSeenAt) < cutoff) {
        delete this.tenders[id];
        removed++;
      }
    }
    return removed;
  }

  // ---- runs & settings -------------------------------------------------

  addRun(run) {
    this.db.runs.unshift(run);
    this.db.runs = this.db.runs.slice(0, 50);
    this.scheduleSave();
  }

  get runs() {
    return this.db.runs;
  }

  get settings() {
    return this.db.settings;
  }

  updateSettings(patch) {
    const s = this.db.settings;
    if (patch.pollIntervalMin != null) {
      const v = Number(patch.pollIntervalMin);
      if (Number.isFinite(v) && v >= 1 && v <= 1440) s.pollIntervalMin = Math.round(v);
    }
    if (typeof patch.onlyOpen === 'boolean') s.onlyOpen = patch.onlyOpen;
    if (typeof patch.searchContracts === 'boolean') s.searchContracts = patch.searchContracts;
    if (typeof patch.notifyTelegram === 'boolean') s.notifyTelegram = patch.notifyTelegram;
    if (patch.laws && typeof patch.laws === 'object') {
      for (const k of ['fz44', 'fz223', 'fz615']) {
        if (typeof patch.laws[k] === 'boolean') s.laws[k] = patch.laws[k];
      }
    }
    if (patch.platforms && typeof patch.platforms === 'object') {
      s.platforms = { ...defaultPlatforms(), ...(s.platforms || {}) };
      for (const id of PLATFORM_IDS) {
        if (typeof patch.platforms[id] === 'boolean') s.platforms[id] = patch.platforms[id];
      }
    }
    if ('minusWords' in patch) s.minusWords = parseWordList(patch.minusWords);
    if ('priceMin' in patch) s.priceMin = parsePriceBound(patch.priceMin);
    if ('priceMax' in patch) s.priceMax = parsePriceBound(patch.priceMax);
    if (s.priceMin != null && s.priceMax != null && s.priceMin > s.priceMax) {
      [s.priceMin, s.priceMax] = [s.priceMax, s.priceMin];
    }
    this.scheduleSave();
    return s;
  }
}
