import {
  canTransition,
  isManualTransitionAllowed,
  type JobState,
  type ReviewVerdict,
} from '@agent/shared';

/**
 * Deterministische Workflow-Engine. Ausschließlich diese Logik entscheidet über
 * Zustandswechsel, Wiederholungen, Limits und Fehlerstatus — niemals ein Agent.
 */

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobState,
    readonly to: JobState,
    message?: string,
  ) {
    super(message ?? `Ungültiger Zustandswechsel: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** Wirft, wenn der Übergang nicht in der Transitions-Map erlaubt ist. */
export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Wirft, wenn der Übergang nicht manuell (Benutzeraktion) erlaubt ist. */
export function assertManualTransition(from: JobState, to: JobState): void {
  if (!isManualTransitionAllowed(from, to)) {
    throw new InvalidTransitionError(
      from,
      to,
      `Manueller Zustandswechsel ${from} → ${to} ist nicht erlaubt`,
    );
  }
}

export interface LoopBudget {
  /** Bisher verbrauchte Rework-Schleifen (Eintritte in `rework`). */
  reviewLoopCount: number;
  /** Konfiguriertes Maximum (MAX_REVIEW_LOOPS, Default 3). */
  maxReviewLoops: number;
}

export function hasLoopBudget(budget: LoopBudget): boolean {
  return budget.reviewLoopCount < budget.maxReviewLoops;
}

/**
 * Nach fehlgeschlagener Testphase: erneute Nacharbeit solange Budget vorhanden,
 * sonst Eskalation an den Menschen (ADR-008; `failed` bleibt Infrastrukturfehlern
 * vorbehalten).
 */
export function decideAfterFailedTests(budget: LoopBudget): 'rework' | 'needs_human' {
  return hasLoopBudget(budget) ? 'rework' : 'needs_human';
}

/** Nach dem Claude-Review: PASS → menschliche Übergabe, sonst Rework/Eskalation. */
export function decideAfterReview(
  verdict: ReviewVerdict,
  budget: LoopBudget,
): 'ready_for_human' | 'rework' | 'needs_human' {
  if (verdict === 'PASS') return 'ready_for_human';
  return hasLoopBudget(budget) ? 'rework' : 'needs_human';
}
