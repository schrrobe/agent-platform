import type { JobState } from '@agent/shared';
import { MANUAL_TRANSITIONS, isActiveState } from '@agent/shared';

export interface ColumnDef {
  state: JobState;
  label: string;
  accent: string;
}

/** Reihenfolge und Beschriftung der Kanban-Spalten (Spezifikation). */
export const COLUMNS: ColumnDef[] = [
  { state: 'inbox', label: 'Inbox', accent: 'var(--c-inbox)' },
  { state: 'agent_ready', label: 'Agent Ready', accent: 'var(--c-ready)' },
  { state: 'preflight', label: 'Preflight', accent: 'var(--c-active)' },
  { state: 'planning', label: 'Planning', accent: 'var(--c-active)' },
  {
    state: 'awaiting_plan_approval',
    label: 'Planfreigabe',
    accent: 'var(--c-human)',
  },
  { state: 'implementing', label: 'Implementing', accent: 'var(--c-active)' },
  { state: 'testing', label: 'Testing', accent: 'var(--c-active)' },
  { state: 'review', label: 'Review', accent: 'var(--c-active)' },
  { state: 'rework', label: 'Rework', accent: 'var(--c-warn)' },
  { state: 'needs_human', label: 'Needs Human', accent: 'var(--c-human)' },
  {
    state: 'ready_for_human',
    label: 'Ready for Human',
    accent: 'var(--c-done)',
  },
  { state: 'done', label: 'Done', accent: 'var(--c-done)' },
  { state: 'failed', label: 'Failed', accent: 'var(--c-fail)' },
  { state: 'paused', label: 'Paused', accent: 'var(--c-paused)' },
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
