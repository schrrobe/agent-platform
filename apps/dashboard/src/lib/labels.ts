import type { JobState } from '@agent/shared';

export const STATE_LABELS: Record<JobState, string> = {
  inbox: 'Inbox',
  agent_ready: 'Agent Ready',
  preflight: 'Preflight',
  planning: 'Planning',
  awaiting_plan_approval: 'Planfreigabe',
  implementing: 'Implementing',
  testing: 'Testing',
  awaiting_diff_approval: 'Diff-Freigabe',
  review: 'Review',
  rework: 'Rework',
  needs_human: 'Needs Human',
  ready_for_human: 'Ready for Human',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: 'Hoch',
  0: 'Normal',
  [-1]: 'Niedrig',
};

export const STATE_COLORS: Record<JobState, string> = {
  inbox: 'var(--c-inbox)',
  agent_ready: 'var(--c-ready)',
  preflight: 'var(--c-active)',
  planning: 'var(--c-active)',
  awaiting_plan_approval: 'var(--c-human)',
  implementing: 'var(--c-active)',
  testing: 'var(--c-active)',
  awaiting_diff_approval: 'var(--c-human)',
  review: 'var(--c-active)',
  rework: 'var(--c-warn)',
  needs_human: 'var(--c-human)',
  ready_for_human: 'var(--c-done)',
  done: 'var(--c-done)',
  failed: 'var(--c-fail)',
  paused: 'var(--c-paused)',
};
