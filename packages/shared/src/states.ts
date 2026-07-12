/**
 * Lokale Workflow-Zustände. Linear-Status bleibt davon vollständig unberührt.
 */
export const JOB_STATES = [
  'inbox',
  'agent_ready',
  'preflight',
  'planning',
  'awaiting_plan_approval',
  'implementing',
  'testing',
  'review',
  'rework',
  'needs_human',
  'ready_for_human',
  'done',
  'failed',
  'paused',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/**
 * Erlaubte Übergänge der deterministischen State Machine.
 *
 * Abweichungen von der Spezifikations-Beispiel-Map (siehe ADR-008 / ADR-007 / ADR-018):
 * - `testing → needs_human`: am Rework-Limit endet der Job immer beim Menschen,
 *   `failed` bleibt Infrastrukturfehlern vorbehalten.
 * - `planning → needs_human` / `implementing → needs_human`: liefert ein Agent kein
 *   verwertbares Ergebnis (leerer Plan, keine Dateiänderung), eskaliert die Engine
 *   zum Menschen statt still zu scheitern.
 * - `testing → paused` und `review → paused`: Pause ist ein Soft-Request, der an
 *   Phasengrenzen greift — auch nach Test- und Review-Phase.
 */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  inbox: ['agent_ready', 'failed', 'paused'],
  agent_ready: [
    'preflight',
    'planning',
    'implementing',
    'testing',
    'review',
    'needs_human',
    'failed',
    'paused',
  ],
  preflight: ['planning', 'needs_human', 'failed', 'paused'],
  planning: ['awaiting_plan_approval', 'implementing', 'needs_human', 'failed', 'paused'],
  awaiting_plan_approval: ['agent_ready', 'inbox', 'failed'],
  implementing: ['testing', 'needs_human', 'failed', 'paused'],
  testing: ['review', 'rework', 'needs_human', 'failed', 'paused'],
  review: ['ready_for_human', 'rework', 'needs_human', 'failed', 'paused'],
  rework: ['implementing', 'paused'],
  failed: ['agent_ready', 'paused'],
  needs_human: ['agent_ready', 'ready_for_human', 'failed', 'paused'],
  ready_for_human: ['done'],
  paused: ['agent_ready', 'inbox', 'failed'],
  done: [],
};

/**
 * Übergänge, die Benutzer direkt auslösen dürfen (Drag-and-drop / PATCH state).
 * Alles andere setzt ausschließlich die Workflow-Engine.
 * Pause läuft über den dedizierten Pause-Endpunkt (Soft-Request), nicht über PATCH.
 */
export const MANUAL_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  inbox: ['agent_ready'],
  agent_ready: [],
  preflight: [],
  planning: [],
  awaiting_plan_approval: ['inbox'],
  implementing: [],
  testing: [],
  review: [],
  rework: [],
  failed: ['agent_ready'],
  needs_human: ['agent_ready', 'ready_for_human'],
  ready_for_human: ['done'],
  paused: ['agent_ready', 'inbox'],
  done: [],
};

/** Zustände, in denen die Pipeline aktiv arbeitet (laufender Job). */
export const ACTIVE_STATES: readonly JobState[] = [
  'preflight',
  'planning',
  'implementing',
  'testing',
  'review',
  'rework',
];

/** Zustände, aus denen ein Pause-Request zulässig ist. */
export const PAUSABLE_STATES: readonly JobState[] = ['agent_ready', ...ACTIVE_STATES];

/** Zustände, aus denen Cancel zulässig ist (hartes Beenden laufender Prozesse). */
export const CANCELABLE_STATES: readonly JobState[] = [...ACTIVE_STATES];

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

export function isActiveState(state: JobState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function canTransition(from: JobState, to: JobState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isManualTransitionAllowed(from: JobState, to: JobState): boolean {
  return MANUAL_TRANSITIONS[from].includes(to);
}
