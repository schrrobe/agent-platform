/**
 * Einfacher Async-Mutex pro Schlüssel. Alle Zustandswechsel und Jobstarts eines
 * Tickets laufen durch denselben Schlüssel, damit manuelle Aktionen und die
 * Queue nicht nebenläufig denselben Job verändern (ADR-013).
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => task(),
      () => task(),
    );
    // Kette weiterführen, Fehler nicht die Kette abreißen lassen.
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Sperrt mehrere Schlüssel in stabiler Reihenfolge und verhindert Deadlocks. */
  runMany<T>(keys: readonly string[], task: () => Promise<T> | T): Promise<T> {
    const unique = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = unique[index];
      if (key === undefined) return Promise.resolve(task());
      return this.run(key, () => acquire(index + 1));
    };
    return acquire(0);
  }
}
