import express from 'express';
import path from 'node:path';
import { config } from './src/config.js';
import { Store } from './src/store.js';
import { isValidInn, normalizeInn } from './src/inn.js';
import { ZakupkiSource, buildQueries } from './src/sources/zakupki.js';
import { DemoSource } from './src/sources/demo.js';
import { TelegramNotifier } from './src/notify.js';
import { Scheduler } from './src/scheduler.js';
import { keywordMatches } from './src/tenders.js';

let proxyDispatcher = undefined;
if (config.proxy && typeof fetch === 'function') {
  try {
    const undici = await import('undici').catch(() => null);
    if (undici?.ProxyAgent) {
      proxyDispatcher = new undici.ProxyAgent(config.proxy);
    }
  } catch (err) {
    console.warn('[config] Не удалось инициализировать ProxyAgent:', err.message);
  }
}

const log = console;
const store = new Store(config.dataFile);

const source =
  config.mode === 'demo'
    ? new DemoSource({ log })
    : new ZakupkiSource({
        base: config.zakupkiBase,
        userAgent: config.userAgent,
        timeoutMs: config.requestTimeoutMs,
        delayMs: config.requestDelayMs,
        dispatcher: proxyDispatcher,
        log,
      });

const notifier = new TelegramNotifier({ token: config.telegram.token, chatId: config.telegram.chatId, log });
const scheduler = new Scheduler({ store, source, notifier, retentionDays: config.retentionDays, log });

const app = express();
app.use(express.json({ limit: '256kb' }));

// Health check для мониторинга облачных платформ (Amvera, k8s, docker)
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use(express.static(path.join(config.rootDir, 'public'), { extensions: ['html'] }));

// ---- SSE: живые события для интерфейса --------------------------------------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}
scheduler.on('run:start', (d) => broadcast('run:start', d));
scheduler.on('run:done', ({ run, added }) => broadcast('run:done', { run, added: added.map(brief) }));

function brief(t) {
  return { id: t.id, title: t.title, customer: t.customer, price: t.price, url: t.url, law: t.law, matches: t.matches };
}

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify(scheduler.status)}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ---- state ------------------------------------------------------------------
function stats() {
  const all = Object.values(store.tenders);
  return {
    total: all.length,
    unseen: all.filter((t) => !t.seen && !t.archived).length,
    open: all.filter((t) => t.kind === 'notice' && t.isOpen && !t.archived).length,
    contracts: all.filter((t) => t.kind === 'contract').length,
    favorites: all.filter((t) => t.favorite).length,
  };
}

function analytics() {
  const all = Object.values(store.tenders);
  const active = all.filter((t) => !t.archived);

  let totalPrice = 0;
  let priceCount = 0;
  let maxPrice = 0;
  const byLaw = { 44: { count: 0, sum: 0 }, 223: { count: 0, sum: 0 }, 615: { count: 0, sum: 0 }, other: { count: 0, sum: 0 } };
  const byKind = { notice: { count: 0, sum: 0 }, contract: { count: 0, sum: 0 } };
  const byStage = {};
  const customerMap = new Map();
  const supplierMap = new Map();

  for (const t of active) {
    const p = typeof t.price === 'number' && Number.isFinite(t.price) ? t.price : 0;
    if (p > 0) {
      totalPrice += p;
      priceCount++;
      if (p > maxPrice) maxPrice = p;
    }

    const lawKey = byLaw[t.law] ? t.law : 'other';
    byLaw[lawKey].count++;
    byLaw[lawKey].sum += p;

    const kindKey = t.kind === 'contract' ? 'contract' : 'notice';
    byKind[kindKey].count++;
    byKind[kindKey].sum += p;

    const st = t.stage || 'Не указан';
    if (!byStage[st]) byStage[st] = { count: 0, sum: 0 };
    byStage[st].count++;
    byStage[st].sum += p;

    if (t.customer) {
      const cur = customerMap.get(t.customer) || { name: t.customer, count: 0, sum: 0 };
      cur.count++;
      cur.sum += p;
      customerMap.set(t.customer, cur);
    }
    if (t.supplier) {
      const cur = supplierMap.get(t.supplier) || { name: t.supplier, count: 0, sum: 0 };
      cur.count++;
      cur.sum += p;
      supplierMap.set(t.supplier, cur);
    }
  }

  const topCustomers = Array.from(customerMap.values())
    .sort((a, b) => b.sum - a.sum || b.count - a.count)
    .slice(0, 10);
  const topSuppliers = Array.from(supplierMap.values())
    .sort((a, b) => b.sum - a.sum || b.count - a.count)
    .slice(0, 10);

  return {
    totalTenders: active.length,
    totalPrice,
    avgPrice: priceCount > 0 ? Math.round(totalPrice / priceCount) : 0,
    maxPrice,
    byLaw,
    byKind,
    byStage,
    topCustomers,
    topSuppliers,
  };
}

app.get('/api/state', (_req, res) => {
  res.json({
    mode: config.mode,
    settings: store.settings,
    watchlist: { companies: store.companies, nomenclature: store.nomenclature },
    status: scheduler.status,
    stats: stats(),
    analytics: analytics(),
    lastRun: store.runs[0] ?? null,
  });
});

app.get('/api/analytics', (_req, res) => {
  res.json(analytics());
});

// ---- tenders ----------------------------------------------------------------
function filterTenders(query) {
  const q = String(query.q ?? '').trim();
  const kind = query.kind;
  const law = query.law;
  const company = query.company;
  const nomen = query.nomen;
  const onlyNew = query.onlyNew === '1';
  const onlyOpen = query.onlyOpen === '1';
  const favorite = query.favorite === '1';
  const archived = query.archived === '1';
  const minPrice = Number(query.minPrice) || null;
  const maxPrice = Number(query.maxPrice) || null;

  let list = Object.values(store.tenders).filter((t) => Boolean(t.archived) === archived);
  if (kind && kind !== 'all') list = list.filter((t) => t.kind === kind);
  if (law && law !== 'all') list = list.filter((t) => t.law === law);
  if (company) list = list.filter((t) => t.matches.some((m) => m.type === 'company' && m.ref === company));
  if (nomen) list = list.filter((t) => t.matches.some((m) => m.type !== 'company' && m.ref === nomen));
  if (onlyNew) list = list.filter((t) => !t.seen);
  if (onlyOpen) list = list.filter((t) => t.kind === 'contract' || t.isOpen);
  if (favorite) list = list.filter((t) => t.favorite);
  if (minPrice) list = list.filter((t) => (t.price ?? 0) >= minPrice);
  if (maxPrice) list = list.filter((t) => (t.price ?? Infinity) <= maxPrice);
  if (q) {
    list = list.filter((t) =>
      keywordMatches(q, `${t.title} ${t.customer ?? ''} ${t.supplier ?? ''} ${t.number}`) || t.number.includes(q),
    );
  }

  const sort = query.sort || 'fresh';
  const by = {
    fresh: (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0),
    published: (a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0),
    deadline: (a, b) => Date.parse(a.deadlineAt ?? '2999-01-01') - Date.parse(b.deadlineAt ?? '2999-01-01'),
    price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    price_asc: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
  };
  list.sort(by[sort] ?? by.fresh);
  return list;
}

app.get('/api/tenders', (req, res) => {
  const list = filterTenders(req.query);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({ total: list.length, items: list.slice(0, limit) });
});

app.get('/api/tenders.csv', (req, res) => {
  const list = filterTenders(req.query);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Тип', 'Закон', 'Номер', 'Наименование', 'Заказчик', 'Поставщик', 'Цена', 'Этап', 'Размещено', 'Окончание подачи', 'Причина', 'Ссылка'];
  const rows = list.map((t) =>
    [
      t.kind === 'contract' ? 'Контракт' : 'Извещение',
      t.law === 'other' ? '' : `${t.law}-ФЗ`,
      t.number,
      t.title,
      t.customer,
      t.supplier,
      t.price ?? '',
      t.stage,
      t.publishedAt ? t.publishedAt.slice(0, 10) : '',
      t.deadlineAt ? t.deadlineAt.slice(0, 10) : '',
      t.matches.map((m) => (m.type === 'company' ? `ИНН ${m.ref} ${m.label}` : m.label)).join('; '),
      t.url,
    ]
      .map(esc)
      .join(';'),
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="tenders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + [header.map(esc).join(';'), ...rows].join('\r\n'));
});

app.patch('/api/tenders/:id', (req, res) => {
  const t = store.patchTender(req.params.id, req.body ?? {});
  if (!t) return res.status(404).json({ error: 'Тендер не найден' });
  res.json(t);
});

app.post('/api/tenders/mark-all-seen', (_req, res) => {
  res.json({ marked: store.markAllSeen(), stats: stats() });
});

// ---- watchlist: предприятия -------------------------------------------------
app.post('/api/companies', (req, res) => {
  const inn = normalizeInn(req.body?.inn);
  if (!isValidInn(inn)) return res.status(400).json({ error: 'Некорректный ИНН: нужно 10 или 12 цифр с верной контрольной суммой' });
  const role = ['any', 'customer', 'supplier'].includes(req.body?.role) ? req.body.role : 'any';
  const { company, created } = store.addCompany({ inn, name: req.body?.name, role, note: req.body?.note });
  res.status(created ? 201 : 200).json(company);
});

app.post('/api/companies/batch', (req, res) => {
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: 'Передайте массив items' });
  const overwrite = Boolean(req.body?.overwrite);
  const validItems = [];
  const invalid = [];

  for (const raw of rawItems) {
    const inn = normalizeInn(raw.inn);
    if (!isValidInn(inn)) {
      invalid.push({ raw, reason: 'Некорректный ИНН или контрольная сумма' });
      continue;
    }
    const role = ['any', 'customer', 'supplier'].includes(raw.role) ? raw.role : 'any';
    validItems.push({ inn, name: raw.name, role, note: raw.note });
  }

  const result = store.importCompanies(validItems, { overwriteExisting: overwrite });
  result.invalid = invalid;
  res.json(result);
});

app.patch('/api/companies/:id', (req, res) => {
  const patch = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim();
  if (['any', 'customer', 'supplier'].includes(req.body?.role)) patch.role = req.body.role;
  if (typeof req.body?.note === 'string') patch.note = req.body.note.trim();
  const company = store.updateCompany(req.params.id, patch);
  if (!company) return res.status(404).json({ error: 'Предприятие не найдено' });
  res.json(company);
});

app.delete('/api/companies/:id', (req, res) => {
  res.json({ removed: store.removeCompany(req.params.id) });
});

// ---- watchlist: номенклатура ------------------------------------------------
app.post('/api/nomenclature', (req, res) => {
  const keyword = String(req.body?.keyword ?? '').trim();
  const okpd2 = String(req.body?.okpd2 ?? '').trim();
  if (!keyword && !okpd2) return res.status(400).json({ error: 'Укажите ключевые слова и/или код ОКПД2' });
  if (okpd2 && !/^\d{2}(\.\d{1,3})*$/.test(okpd2)) return res.status(400).json({ error: 'ОКПД2 должен выглядеть как 24.20.13' });
  if (keyword.length > 120) return res.status(400).json({ error: 'Слишком длинная фраза' });
  const { item, created } = store.addNomenclature({ keyword, okpd2 });
  res.status(created ? 201 : 200).json(item);
});

app.delete('/api/nomenclature/:id', (req, res) => {
  res.json({ removed: store.removeNomenclature(req.params.id) });
});

// ---- watchlist: импорт/экспорт ----------------------------------------------
app.get('/api/watchlist/export', (_req, res) => {
  res.json(store.exportWatchlist());
});

app.post('/api/watchlist/import', (req, res) => {
  const payload = req.body || {};
  const replace = Boolean(req.body?.replace);
  const rawCompanies = Array.isArray(payload.companies) ? payload.companies : [];
  const rawNomen = Array.isArray(payload.nomenclature) ? payload.nomenclature : [];

  const validCompanies = [];
  const invalidCompanies = [];
  for (const raw of rawCompanies) {
    const inn = normalizeInn(raw.inn);
    if (!isValidInn(inn)) {
      invalidCompanies.push({ raw, reason: 'Некорректный ИНН' });
      continue;
    }
    const role = ['any', 'customer', 'supplier'].includes(raw.role) ? raw.role : 'any';
    validCompanies.push({ inn, name: raw.name, role, note: raw.note });
  }

  const validNomen = [];
  for (const raw of rawNomen) {
    const keyword = String(raw.keyword ?? '').trim();
    const okpd2 = String(raw.okpd2 ?? '').trim();
    if (keyword || okpd2) validNomen.push({ keyword, okpd2 });
  }

  const result = store.importWatchlist({ companies: validCompanies, nomenclature: validNomen }, { replace });
  result.invalidCompanies = invalidCompanies;
  res.json(result);
});

// ---- настройки, опрос, история -----------------------------------------------
app.patch('/api/settings', (req, res) => {
  const before = store.settings.pollIntervalMin;
  const settings = store.updateSettings(req.body ?? {});
  if (settings.pollIntervalMin !== before) scheduler.schedule();
  res.json(settings);
});

app.post('/api/telegram/test', async (_req, res) => {
  const result = await notifier.testConnection();
  if (result.ok) res.json({ ok: true, message: 'Тестовое сообщение успешно отправлено в Telegram' });
  else res.status(400).json({ ok: false, error: result.error || 'Не удалось отправить сообщение' });
});

app.post('/api/scan', async (_req, res) => {
  if (scheduler.running) return res.status(409).json({ error: 'Опрос уже выполняется' });
  const run = await scheduler.runOnce({ trigger: 'manual' });
  res.json({ run, stats: stats() });
});

app.get('/api/runs', (_req, res) => res.json(store.runs));

app.get('/api/queries', (_req, res) => {
  res.json(
    buildQueries({
      companies: store.companies,
      nomenclature: store.nomenclature,
      settings: store.settings,
      base: config.zakupkiBase,
    }).map(({ kind, label, url }) => ({ kind, label, url })),
  );
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Нет такого метода' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log.error(err);
  res.status(500).json({ error: err.message || 'Внутренняя ошибка' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info(`Tender Spy → http://localhost:${config.port}  (режим: ${config.mode}, источник: ${scheduler.status.source}, интервал: ${store.settings.pollIntervalMin} мин)`);
  scheduler.start();
});

function shutdown() {
  scheduler.stop();
  try {
    store.save();
  } catch (err) {
    log.error('[store] не удалось сохранить при выходе:', err.message);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
