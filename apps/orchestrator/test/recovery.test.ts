import { afterEach, describe, expect, it } from 'vitest';
import { runRecovery } from '../src/recovery.js';
import { createHarness, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('Neustart-Recovery', () => {
  it('markiert unterbrochene aktive Jobs als failed und beendet laufende AgentRuns', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-401');

    // Zustand eines mitten im Lauf abgestürzten Jobs simulieren.
    harness.ctx.repos.jobs.update(job.id, {
      state: 'implementing',
      startedAt: new Date().toISOString(),
    });
    const run = harness.ctx.repos.agentRuns.insert({
      jobId: job.id,
      phase: 'implement',
      agent: 'codex',
    });
    // PGID einer garantiert nicht existierenden Prozessgruppe (kill wirft ESRCH → toleriert).
    harness.ctx.repos.agentRuns.update(run.id, { pgid: 2_147_483_600 });

    const result = runRecovery(harness.ctx);
    expect(result.failedJobs).toBe(1);

    const recovered = harness.ctx.repos.jobs.get(job.id)!;
    expect(recovered.state).toBe('failed');
    expect(recovered.lastError).toContain('Neustart');
    expect(recovered.activePgid).toBeNull();

    const runs = harness.ctx.repos.agentRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('canceled');
  });

  it('lässt terminale und inaktive Jobs unangetastet', async () => {
    harness = await createHarness();
    const done = harness.seedJob('APP-402');
    const inbox = harness.seedJob('APP-403');
    harness.ctx.repos.jobs.update(done.id, { state: 'done' });

    runRecovery(harness.ctx);

    expect(harness.ctx.repos.jobs.get(done.id)!.state).toBe('done');
    expect(harness.ctx.repos.jobs.get(inbox.id)!.state).toBe('inbox');
  });

  it('startet Jobs nach Recovery NICHT automatisch neu', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-404');
    harness.ctx.repos.jobs.update(job.id, { state: 'planning' });
    runRecovery(harness.ctx);
    expect(harness.ctx.queue.isQueued(job.id)).toBe(false);
    expect(harness.ctx.repos.jobs.get(job.id)!.state).toBe('failed');
  });
});
