/**
 * Gemeinsame Queue-Reihenfolge: höchste Priorität zuerst, dann manuelle Position,
 * dann Erstellzeit. Wird von der Queue-Auswahl (Orchestrator) und der Board-Sortierung
 * (Dashboard) geteilt; das SQL `ORDER BY` in der jobs-Repository spiegelt dieselbe Regel.
 */
export interface QueueOrdered {
  queuePriority: number;
  queuePosition: number;
  createdAt: string;
}

export function compareQueueOrder(a: QueueOrdered, b: QueueOrdered): number {
  return (
    b.queuePriority - a.queuePriority ||
    a.queuePosition - b.queuePosition ||
    a.createdAt.localeCompare(b.createdAt)
  );
}
