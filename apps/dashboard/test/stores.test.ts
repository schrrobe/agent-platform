import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { AnyWsEnvelope, JobSummary } from '@agent/shared';
import { useJobsStore } from '@/stores/jobs';

function makeJob(id: string, state: JobSummary['state'], createdAt: string): JobSummary {
  return {
    id,
    ticketId: `t-${id}`,
    projectId: 'p1',
    state,
    reviewLoopCount: 0,
    worktreePath: null,
    branch: null,
    baseBranch: 'main',
    currentAgent: null,
    pauseRequested: false,
    activePgid: null,
    deadlineAt: null,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
    projectName: 'Demo',
    repositoryPath: '/repo',
    ticket: {
      id: `t-${id}`,
      projectId: 'p1',
      linearIssueId: `lin-${id}`,
      identifier: `APP-${id}`,
      title: `Titel ${id}`,
      description: '',
      url: '',
      teamKey: null,
      teamName: null,
      priority: null,
      priorityLabel: null,
      labels: [],
      linearState: null,
      linearCreatedAt: null,
      linearUpdatedAt: null,
      importedAt: createdAt,
      updatedAt: createdAt,
    },
  };
}

describe('jobs store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('gruppiert Jobs nach Zustand', () => {
    const store = useJobsStore();
    store.upsert(makeJob('1', 'inbox', '2026-07-01T00:00:00Z'));
    store.upsert(makeJob('2', 'done', '2026-07-02T00:00:00Z'));
    store.upsert(makeJob('3', 'inbox', '2026-07-03T00:00:00Z'));
    expect(store.byState.inbox).toHaveLength(2);
    expect(store.byState.done).toHaveLength(1);
    expect(store.byState.planning).toHaveLength(0);
  });

  it('aktualisiert Jobs aus WebSocket-Events (state_changed)', () => {
    const store = useJobsStore();
    const job = makeJob('1', 'inbox', '2026-07-01T00:00:00Z');
    store.upsert(job);
    const moved: JobSummary = { ...job, state: 'agent_ready' };
    const envelope = {
      type: 'job.state_changed',
      seq: 5,
      ts: '2026-07-01T00:01:00Z',
      jobId: '1',
      payload: { job: moved, fromState: 'inbox', toState: 'agent_ready' },
    } as AnyWsEnvelope;
    store.applyEnvelope(envelope);
    expect(store.byState.agent_ready).toHaveLength(1);
    expect(store.byState.inbox).toHaveLength(0);
  });

  it('sortiert Jobs nach Erstellungszeit', () => {
    const store = useJobsStore();
    store.upsert(makeJob('b', 'inbox', '2026-07-05T00:00:00Z'));
    store.upsert(makeJob('a', 'inbox', '2026-07-01T00:00:00Z'));
    expect(store.jobs.map((j) => j.id)).toEqual(['a', 'b']);
  });
});
