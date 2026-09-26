import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { rejectReason } from './filters.js';

/**
 * ЕИС уже отобрал выдачу по НМЦК. Здесь отсекаем только карточки, чья цена
 * известна и лежит вне диапазона; без распознанной цены карточку оставляем.
 */
function priceAllowed(price, { priceMin = null, priceMax = null } = {}) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return true;
  if (priceMin != null && price < priceMin) return false;
  if (priceMax != null && price > priceMax) return false;
  return true;
}

/**
 * Один «опрос» = собрать карточки из источника по всему watchlist,
 * слить в хранилище, посчитать новые, разослать уведомления.
 * Планировщик запускает опросы по таймеру и по запросу из UI.
 */
export class Scheduler extends EventEmitter {
  constructor({ store, source, notifier, retentionDays = 90, cardsPerRun = 40, cardDelayMs = 1500, log = console }) {
    super();
    this.store = store;
    this.source = source;
    this.notifier = notifier;
    this.retentionDays = retentionDays;
    this.cardsPerRun = cardsPerRun;
    this.cardDelayMs = cardDelayMs;
    this.enriching = null;
    this.log = log;
    this.running = false;
    this.timer = null;
    this.nextRunAt = null;
    this.lastRun = null;
  }

  get status() {
    return {
      running: this.running,
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun,
      source:
        this.source.constructor.name === 'DemoSource'
          ? 'demo'
          : this.source.constructor.name === 'CombinedSource'
            ? 'zakupki+platforms'
            : 'zakupki',
      telegram: this.notifier?.enabled ?? false,
    };
  }

  start() {
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  schedule() {
    clearTimeout(this.timer);
    const minutes = this.store.settings.pollIntervalMin || 30;
    const delay = minutes * 60_000;
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.runOnce({ trigger: 'timer' }).catch((err) => this.log.error('[scheduler]', err));
    }, delay);
    this.timer.unref?.();
  }

  async runOnce({ trigger = 'manual' } = {}) {
    if (this.running) return { skipped: true, reason: 'already-running' };
    const { nomenclature, settings } = this.store;
    if (!nomenclature.length) {
      const run = {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        trigger,
        queriesRun: 0,
        found: 0,
        added: 0,
        errors: [{ query: '—', message: 'Список наблюдения пуст: добавьте номенклатуру' }],
      };
      this.lastRun = run;
      this.store.addRun(run);
      this.schedule();
      return run;
    }

    this.running = true;
    this.emit('run:start', { trigger });
    const startedAt = new Date().toISOString();
    let result = { tenders: [], errors: [], queriesRun: 0 };
    try {
      result = await this.source.collect({ nomenclature, settings });
    } catch (err) {
      result.errors.push({ query: 'источник', message: err.message });
    }

    const added = [];
    let filtered = 0;
    for (const t of result.tenders) {
      if (settings.onlyOpen && t.kind === 'notice' && t.isOpen === false) continue;
      if (!priceAllowed(t.price, settings)) continue;
      if (rejectReason(t, { nomenclature, settings })) {
        filtered++;
        continue;
      }
      if (this.store.upsertTender(t)) added.push(this.store.tenders[t.id]);
    }
    this.store.closeStaleNotices();
    const pruned = this.store.prune(this.retentionDays);
    this.store.scheduleSave();

    const run = {
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger,
      queriesRun: result.queriesRun,
      found: result.tenders.length,
      added: added.length,
      filtered,
      pruned,
      errors: result.errors,
    };
    this.lastRun = run;
    this.store.addRun(run);
    this.running = false;
    this.emit('run:done', { run, added });

    if (added.length && settings.notifyTelegram && this.notifier?.enabled) {
      this.notifier.notifyNewTenders(added).catch((err) => this.log.warn('[telegram]', err.message));
    }

    this.schedule();
    this.enrichCards().catch((err) => this.log.warn('[cards]', err.message));
    return run;
  }

  /**
   * В RSS ЕИС нет срока подачи и региона — дочитываем карточки извещений
   * в фоне, понемногу за опрос, чтобы не нагружать ЕИС.
   */
  enrichCards() {
    if (this.enriching || typeof this.source.fetchNoticeCard !== 'function') return this.enriching ?? Promise.resolve(0);
    this.enriching = (async () => {
      const list = this.store.noticesWithoutCard(this.cardsPerRun);
      let done = 0;
      for (let i = 0; i < list.length; i++) {
        let card = null;
        try {
          card = await this.source.fetchNoticeCard(list[i]);
        } catch (err) {
          this.log.warn?.(`[cards] ${list[i].number}: ${err.message}`);
        }
        this.store.applyCard(list[i].id, card && (card.deadlineAt || card.region) ? card : null);
        if (card) done++;
        if (i < list.length - 1) await sleep(this.cardDelayMs);
      }
      if (list.length) {
        this.store.closeStaleNotices();
        this.store.scheduleSave();
        this.emit('cards:done', { checked: list.length, done });
      }
      return done;
    })().finally(() => {
      this.enriching = null;
    });
    return this.enriching;
  }
}
