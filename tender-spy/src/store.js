import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_VERSION = 1;

export function defaultSettings() {
  return {
    pollIntervalMin: 30,
    onlyOpen: true,
    laws: { fz44: true, fz223: true, fz615: false },
    searchContracts: true,
    notifyTelegram: false,
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

  addNomenclature({ keyword, okpd2 = '' }) {
    const kw = keyword.trim();
    const code = okpd2.trim();
    const exists = this.nomenclature.find(
      (n) => n.keyword.toLowerCase() === kw.toLowerCase() && n.okpd2 === code,
    );
    if (exists) return { item: exists, created: false };
    const item = { id: newId('n_'), keyword: kw, okpd2: code, createdAt: new Date().toISOString() };
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
          createdAt: new Date().toISOString(),
        });
        added++;
      }
    }
    if (added || replace) this.scheduleSave();
    return { added, skipped, total: this.nomenclature.length };
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
    const stageChanged = existing.stage !== tender.stage;
    Object.assign(existing, {
      title: tender.title || existing.title,
      customer: tender.customer || existing.customer,
      price: tender.price ?? existing.price,
      stage: tender.stage || existing.stage,
      deadlineAt: tender.deadlineAt || existing.deadlineAt,
      updatedAt: tender.updatedAt || existing.updatedAt,
      url: tender.url || existing.url,
      lastSeenAt: now,
    });
    if (stageChanged) existing.seen = false;
    return false;
  }

  patchTender(id, patch) {
    const t = this.tenders[id];
    if (!t) return null;
    const allowed = ['seen', 'favorite', 'archived', 'comment'];
    for (const k of allowed) if (k in patch) t[k] = patch[k];
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
    this.scheduleSave();
    return s;
  }
}
