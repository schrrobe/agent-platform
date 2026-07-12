import type { JobState } from '@agent/shared';

export const STATE_LABELS: Record<JobState, string> = {
  inbox: 'Inbox',
  agent_ready: 'Agent Ready',
  planning: 'Planning',
  implementing: 'Implementing',
  testing: 'Testing',
  review: 'Review',
  rework: 'Rework',
  needs_human: 'Needs Human',
  done: 'Done',
  failed: 'Failed',
  paused: 'Paused',
};

export const STATE_COLORS: Record<JobState, string> = {
  inbox: 'var(--c-inbox)',
  agent_ready: 'var(--c-ready)',
  planning: 'var(--c-active)',
  implementing: 'var(--c-active)',
  testing: 'var(--c-active)',
  review: 'var(--c-active)',
  rework: 'var(--c-warn)',
  needs_human: 'var(--c-human)',
  done: 'var(--c-done)',
  failed: 'var(--c-fail)',
  paused: 'var(--c-paused)',
};
