import fs from 'node:fs';
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
    harness.ctx.repos.jobs.update(job.id, { activePgid: 2_147_483_599 });
    const testRun = harness.ctx.repos.testRuns.insert({
      jobId: job.id,
      iteration: 1,
      commandKey: 'test',
      command: 'pnpm test',
    });

    const result = await runRecovery(harness.ctx);
    expect(result.failedJobs).toBe(1);

    const recovered = harness.ctx.repos.jobs.get(job.id)!;
    expect(recovered.state).toBe('failed');
    expect(recovered.lastError).toContain('Neustart');
    expect(recovered.activePgid).toBeNull();

    const runs = harness.ctx.repos.agentRuns.listByJob(job.id);
    expect(runs[0]?.status).toBe('canceled');
    expect(harness.ctx.repos.testRuns.get(testRun.id)?.status).toBe('canceled');
  });

  it('lässt terminale und inaktive Jobs unangetastet', async () => {
    harness = await createHarness();
    const done = harness.seedJob('APP-402');
    const inbox = harness.seedJob('APP-403');
    harness.ctx.repos.jobs.update(done.id, { state: 'done' });

    await runRecovery(harness.ctx);

    expect(harness.ctx.repos.jobs.get(done.id)!.state).toBe('done');
    expect(harness.ctx.repos.jobs.get(inbox.id)!.state).toBe('inbox');
  });

  it('startet Jobs nach Recovery NICHT automatisch neu', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-404');
    harness.ctx.repos.jobs.update(job.id, { state: 'planning' });
    await runRecovery(harness.ctx);
    expect(harness.ctx.queue.isQueued(job.id)).toBe(false);
    expect(harness.ctx.repos.jobs.get(job.id)!.state).toBe('failed');
  });

  it('reiht wartende agent_ready-Jobs nach dem Neustart wieder ein', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-407');
    // Vom Menschen gestartet, aber vor dem Neustart nie an die Reihe gekommen.
    harness.ctx.repos.jobs.update(job.id, { state: 'agent_ready', resumePhase: 'preflight' });

    const result = await runRecovery(harness.ctx);

    expect(result.requeuedJobs).toBe(1);
    expect(harness.ctx.queue.isQueued(job.id)).toBe(true);
    expect(await harness.waitForState(job.id, ['ready_for_human'])).toBe('ready_for_human');
  });

  it('räumt eine unterbrochene GitHub-Nacharbeit auf und erhält den geprüften HEAD', async () => {
    harness = await createHarness();
    const seeded = harness.seedJob('APP-405');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    const before = harness.ctx.repos.jobs.get(seeded.id)!;
    const expectedHead = await harness.ctx.git.currentHead(before.worktreePath!);

    fs.writeFileSync(`${before.worktreePath}/crash-leftover.txt`, 'uncommitted\n');
    harness.ctx.repos.jobs.update(seeded.id, {
      currentAgent: 'codex',
      activePgid: 2_147_483_598,
      headCommitSha: expectedHead,
    });

    const result = await runRecovery(harness.ctx);

    expect(result.recoveredActions).toBe(1);
    const recovered = harness.ctx.repos.jobs.get(seeded.id)!;
    expect(recovered.state).toBe('ready_for_human');
    expect(recovered.currentAgent).toBeNull();
    expect(recovered.activePgid).toBeNull();
    expect(recovered.lastError).toContain('uncommittierte Änderungen wurden verworfen');
    expect(await harness.ctx.git.currentHead(recovered.worktreePath!)).toBe(expectedHead);
    expect(await harness.ctx.git.hasUncommittedChanges(recovered.worktreePath!)).toBe(false);
  });

  it('verwirft bei einem widersprüchlichen HEAD keine unbekannten Änderungen', async () => {
    harness = await createHarness();
    const seeded = harness.seedJob('APP-406');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    const before = harness.ctx.repos.jobs.get(seeded.id)!;
    const persistedHead = await harness.ctx.git.currentHead(before.worktreePath!);

    fs.writeFileSync(`${before.worktreePath}/unknown-commit.txt`, 'committed elsewhere\n');
    const unknownHead = await harness.ctx.git.commitAll(
      before.worktreePath!,
      'test: unknown commit',
    );
    fs.writeFileSync(`${before.worktreePath}/must-survive.txt`, 'manual work\n');
    harness.ctx.repos.jobs.update(seeded.id, {
      currentAgent: 'codex',
      headCommitSha: persistedHead,
    });

    await runRecovery(harness.ctx);

    const recovered = harness.ctx.repos.jobs.get(seeded.id)!;
    expect(recovered.currentAgent).toBeNull();
    expect(recovered.lastError).toContain('konnte nicht sicher aufgeräumt werden');
    expect(await harness.ctx.git.currentHead(recovered.worktreePath!)).toBe(unknownHead);
    expect(fs.existsSync(`${recovered.worktreePath}/must-survive.txt`)).toBe(true);
  });
});
