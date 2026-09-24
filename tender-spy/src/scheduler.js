import { EventEmitter } from 'node:events';

/**
 * Один «опрос» = собрать карточки из источника по всему watchlist,
 * слить в хранилище, посчитать новые, разослать уведомления.
 * Планировщик запускает опросы по таймеру и по запросу из UI.
 */
export class Scheduler extends EventEmitter {
  constructor({ store, source, notifier, retentionDays = 90, log = console }) {
    super();
    this.store = store;
    this.source = source;
    this.notifier = notifier;
    this.retentionDays = retentionDays;
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
      source: this.source.constructor.name === 'DemoSource' ? 'demo' : 'zakupki',
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
    for (const t of result.tenders) {
      if (settings.onlyOpen && t.kind === 'notice' && t.isOpen === false) continue;
      if (this.store.upsertTender(t)) added.push(this.store.tenders[t.id]);
    }
    const pruned = this.store.prune(this.retentionDays);
    this.store.scheduleSave();

    const run = {
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger,
      queriesRun: result.queriesRun,
      found: result.tenders.length,
      added: added.length,
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
    return run;
  }
}
