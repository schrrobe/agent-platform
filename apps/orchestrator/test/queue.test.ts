import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, nodeCommand, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('JobQueue', () => {
  it('führt mehrere Jobs desselben Projekts bis zur Parallelitätsgrenze gleichzeitig aus', async () => {
    // Langsame Testphase erzeugt ein Beobachtungsfenster.
    harness = await createHarness({
      reviewSequence: 'PASS',
      maxConcurrentJobs: 3,
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},400)'),
    });
    const a = harness.seedJob('APP-201');
    const b = harness.seedJob('APP-202');
    const c = harness.seedJob('APP-203');

    await harness.ctx.jobs.start(a.id);
    await harness.ctx.jobs.start(b.id);
    await harness.ctx.jobs.start(c.id);
    await new Promise((r) => setTimeout(r, 120));

    // Gleiches Projekt, eigene Worktrees → alle drei laufen nebenläufig.
    expect(harness.ctx.queue.runningJobIds().length).toBe(3);

    for (const job of [a, b, c]) {
      await harness.waitForState(job.id, ['ready_for_human']);
      expect(harness.ctx.repos.jobs.get(job.id)!.state).toBe('ready_for_human');
    }
    // Jeder Job bekam seinen eigenen Branch und Worktree.
    const worktrees = [a, b, c].map((job) => harness!.ctx.repos.jobs.get(job.id)!.worktreePath);
    const branches = [a, b, c].map((job) => harness!.ctx.repos.jobs.get(job.id)!.branch);
    expect(new Set(worktrees).size).toBe(3);
    expect(new Set(branches).size).toBe(3);
  });

  it('hält Jobs über der Parallelitätsgrenze zurück', async () => {
    harness = await createHarness({
      reviewSequence: 'PASS',
      maxConcurrentJobs: 2,
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},400)'),
    });
    const jobs = [
      harness.seedJob('APP-211'),
      harness.seedJob('APP-212'),
      harness.seedJob('APP-213'),
    ];
    for (const job of jobs) await harness.ctx.jobs.start(job.id);
    await new Promise((r) => setTimeout(r, 120));

    expect(harness.ctx.queue.runningJobIds().length).toBe(2);

    for (const job of jobs) await harness.waitForState(job.id, ['ready_for_human']);
  });

  it('enqueue ist idempotent', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-203');
    harness.ctx.repos.jobs.update(job.id, { state: 'agent_ready' });
    harness.ctx.queue.enqueue(job.id);
    harness.ctx.queue.enqueue(job.id);
    expect(harness.ctx.queue.isQueued(job.id)).toBe(true);
    await harness.waitForState(job.id, ['ready_for_human', 'failed', 'needs_human']);
  });

  it('bricht einen laufenden Job per cancel hart ab (→ failed)', async () => {
    harness = await createHarness({
      reviewSequence: 'PASS',
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},5000)'),
    });
    const job = harness.seedJob('APP-204');
    await harness.ctx.jobs.start(job.id);
    // Warten, bis der Job tatsächlich läuft.
    const started = Date.now();
    while (!harness.ctx.queue.isRunning(job.id) && Date.now() - started < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await harness.ctx.jobs.cancel(job.id);
    const state = await harness.waitForState(job.id, ['failed']);
    expect(state).toBe('failed');
    expect(harness.ctx.repos.jobs.get(job.id)!.lastError).toContain('abgebrochen');
  });

  it('respektiert das Job-Zeitlimit (Deadline → failed)', async () => {
    harness = await createHarness({
      reviewSequence: 'PASS',
      maxJobRuntimeMs: 1500,
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},5000)'),
    });
    const job = harness.seedJob('APP-205');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, ['failed'], 10_000);
    expect(state).toBe('failed');
    expect(harness.ctx.repos.jobs.get(job.id)!.lastError).toContain('Zeitlimit');
  });
});
