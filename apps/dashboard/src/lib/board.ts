import type { JobState } from '@agent/shared';
import { MANUAL_TRANSITIONS, isActiveState } from '@agent/shared';

export interface ColumnDef {
  key: string;
  label: string;
  accent: string;
  /** Zustände, deren Karten in dieser Spalte landen. */
  states: JobState[];
  /** Ziel-Zustand bei Drop; fehlt → Spalte ist nie Drop-Ziel. */
  dropTarget?: JobState;
}

function single(state: JobState, label: string, accent: string): ColumnDef {
  return { key: state, label, accent, states: [state], dropTarget: state };
}

/** Reihenfolge und Beschriftung der Kanban-Spalten (Spezifikation). */
export const COLUMNS: ColumnDef[] = [
  single('inbox', 'Inbox', 'var(--c-inbox)'),
  single('agent_ready', 'Agent Ready', 'var(--c-ready)'),
  {
    key: 'in_progress',
    label: 'In Arbeit',
    accent: 'var(--c-active)',
    states: ['preflight', 'planning', 'implementing', 'testing', 'review', 'rework'],
  },
  single('awaiting_plan_approval', 'Planfreigabe', 'var(--c-human)'),
  single('needs_human', 'Needs Human', 'var(--c-human)'),
  single('ready_for_human', 'Ready for Human', 'var(--c-done)'),
  single('done', 'Done', 'var(--c-done)'),
  single('failed', 'Failed', 'var(--c-fail)'),
  single('paused', 'Paused', 'var(--c-paused)'),
];

/**
 * Ob eine Karte per Drag-and-drop von `from` nach `to` verschoben werden darf.
 * Nutzt exakt die manuell erlaubten Übergänge der Workflow-Engine; laufende
 * Jobs (aktive Systemzustände) sind unverschiebbar — dort greifen Pause/Abbruch.
 */
export function canDropTo(from: JobState, to: JobState): boolean {
  if (from === to) return false;
  if (isActiveState(from)) return false;
  return MANUAL_TRANSITIONS[from].includes(to);
}

export function isManualStartTarget(from: JobState, to: JobState): boolean {
  return to === 'agent_ready' && canDropTo(from, to);
}
