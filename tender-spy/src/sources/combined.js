/**
 * Несколько источников в одном опросе: запускаются параллельно, результаты
 * складываются по порядку источников (ЕИС первым — его карточка и ссылка
 * считаются основными, площадки дополняют её).
 */
export class CombinedSource {
  constructor(sources = []) {
    this.sources = sources;
  }

  async collect(args) {
    const results = await Promise.all(
      this.sources.map((s) =>
        s.collect(args).catch((err) => ({
          tenders: [],
          errors: [{ query: s.constructor.name, message: err.message }],
          queriesRun: 0,
        })),
      ),
    );
    return {
      tenders: results.flatMap((r) => r.tenders ?? []),
      errors: results.flatMap((r) => r.errors ?? []),
      queriesRun: results.reduce((n, r) => n + (r.queriesRun ?? 0), 0),
    };
  }
}
