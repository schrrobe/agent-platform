import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, nodeCommand, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('JobQueue', () => {
  it('lässt trotz Parallelität > 1 nur einen Schreibjob pro Projekt laufen', async () => {
    // Langsame Testphase erzeugt ein Beobachtungsfenster.
    harness = await createHarness({
      reviewSequence: 'PASS',
      maxConcurrentJobs: 4,
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},400)'),
    });
    const a = harness.seedJob('APP-201');
    const b = harness.seedJob('APP-202');

    await harness.ctx.jobs.start(a.id);
    await harness.ctx.jobs.start(b.id);
    await new Promise((r) => setTimeout(r, 120));

    // Beide gehören zum selben Projekt → höchstens einer läuft.
    expect(harness.ctx.queue.runningJobIds().length).toBe(1);

    await harness.waitForState(a.id, ['done']);
    await harness.waitForState(b.id, ['done']);
    expect(harness.ctx.repos.jobs.get(a.id)!.state).toBe('done');
    expect(harness.ctx.repos.jobs.get(b.id)!.state).toBe('done');
  });

  it('enqueue ist idempotent', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-203');
    harness.ctx.repos.jobs.update(job.id, { state: 'agent_ready' });
    harness.ctx.queue.enqueue(job.id);
    harness.ctx.queue.enqueue(job.id);
    expect(harness.ctx.queue.isQueued(job.id)).toBe(true);
    await harness.waitForState(job.id, ['done', 'failed', 'needs_human']);
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
