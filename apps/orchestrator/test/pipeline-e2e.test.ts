import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, nodeCommand, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('Pipeline E2E (Fake-Claude/-Codex)', () => {
  it('durchläuft den Happy Path bis done und erzeugt Worktree, Commit und Artefakte', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-1');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, ['done', 'failed', 'needs_human']);
    expect(state).toBe('done');

    const finished = harness.ctx.repos.jobs.get(job.id)!;
    expect(finished.branch).toBe('agent/app-1');
    expect(finished.worktreePath).toBe(path.join(harness.worktreeRoot, 'app-1'));
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.reviewLoopCount).toBe(0);

    // Worktree existiert und enthält die von Codex erzeugte Datei.
    expect(fs.existsSync(path.join(finished.worktreePath!, 'impl.txt'))).toBe(true);
    // .agent/PLAN.md wurde geschrieben, aber nicht committet (Pathspec-Ausschluss).
    expect(fs.existsSync(path.join(finished.worktreePath!, '.agent', 'PLAN.md'))).toBe(true);

    const artifacts = harness.ctx.repos.artifacts.listByJob(job.id);
    expect(artifacts.some((a) => a.type === 'plan')).toBe(true);
    expect(artifacts.some((a) => a.type === 'review')).toBe(true);
    expect(artifacts.some((a) => a.type === 'summary')).toBe(true);

    const reviews = harness.ctx.repos.reviewIterations.listByJob(job.id);
    expect(reviews.at(-1)?.verdict).toBe('PASS');

    // Zustandshistorie enthält den vollständigen Pfad.
    const events = harness.ctx.repos.jobEvents.listByJob(job.id);
    const toStates = events.filter((e) => e.type === 'job.state_changed').map((e) => e.toState);
    expect(toStates).toEqual(
      expect.arrayContaining(['agent_ready', 'planning', 'implementing', 'testing', 'review', 'done']),
    );

    // Live-Logs wurden geschrieben.
    expect(harness.ctx.logStore.read(job.id).length).toBeGreaterThan(0);
  });

  it('macht nach Review-FAIL Nacharbeit und besteht dann (rework → done)', async () => {
    harness = await createHarness({ reviewSequence: 'FAIL,PASS', maxReviewLoops: 3 });
    const job = harness.seedJob('APP-2');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, ['done', 'failed', 'needs_human']);
    expect(state).toBe('done');

    const finished = harness.ctx.repos.jobs.get(job.id)!;
    expect(finished.reviewLoopCount).toBe(1);

    const reviews = harness.ctx.repos.reviewIterations.listByJob(job.id);
    expect(reviews.map((r) => r.verdict)).toEqual(['FAIL', 'PASS']);

    // REVIEW.md wurde für die Nacharbeit erzeugt; Codex hat daraufhin fixed.txt angelegt.
    expect(fs.existsSync(path.join(finished.worktreePath!, 'fixed.txt'))).toBe(true);

    const events = harness.ctx.repos.jobEvents.listByJob(job.id);
    expect(events.some((e) => e.type === 'review.failed')).toBe(true);
    expect(events.some((e) => e.type === 'review.passed')).toBe(true);
    expect(events.filter((e) => e.toState === 'rework')).toHaveLength(1);
  });

  it('eskaliert nach Erreichen des Review-Limits zu needs_human', async () => {
    harness = await createHarness({ reviewSequence: 'FAIL,FAIL,FAIL,FAIL,FAIL', maxReviewLoops: 2 });
    const job = harness.seedJob('APP-3');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id);
    expect(state).toBe('needs_human');

    const finished = harness.ctx.repos.jobs.get(job.id)!;
    expect(finished.reviewLoopCount).toBe(2);
    expect(finished.lastError).toContain('maximaler Schleifenzahl');
    // 3 Reviews: initial + 2 Nacharbeiten, alle FAIL.
    expect(harness.ctx.repos.reviewIterations.listByJob(job.id)).toHaveLength(3);
  });

  it('setzt bei fehlgeschlagenen Pflichtprüfungen ohne Budget auf needs_human', async () => {
    harness = await createHarness({
      testCommand: nodeCommand('process.exit(1)'),
      maxReviewLoops: 0,
    });
    const job = harness.seedJob('APP-4');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id);
    expect(state).toBe('needs_human');

    const testRuns = harness.ctx.repos.testRuns.listByJob(job.id);
    expect(testRuns.at(-1)?.exitCode).toBe(1);
    // Kein Review bei roter Pflichtprüfung.
    expect(harness.ctx.repos.reviewIterations.listByJob(job.id)).toHaveLength(0);
  });

  it('meldet needs_human, wenn Codex keine Änderung vornimmt', async () => {
    harness = await createHarness({ codexNoChange: true });
    const job = harness.seedJob('APP-5');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id);
    expect(state).toBe('needs_human');
    expect(harness.ctx.repos.jobs.get(job.id)!.lastError).toContain('keine Dateiänderungen');
  });

  it('setzt bei Codex-Fehler (Infrastruktur) auf failed', async () => {
    harness = await createHarness({ codexFails: true });
    const job = harness.seedJob('APP-6');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id);
    expect(state).toBe('failed');
    expect(harness.ctx.repos.jobs.get(job.id)!.lastError).toContain('Codex');
  });

  it('führt keinen Merge/Push aus — Basisbranch bleibt unverändert', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-7');
    const { execFileSync } = await import('node:child_process');
    const before = execFileSync('git', ['rev-parse', 'main'], { cwd: harness.repoDir }).toString().trim();
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['done']);
    const after = execFileSync('git', ['rev-parse', 'main'], { cwd: harness.repoDir }).toString().trim();
    expect(after).toBe(before);
  });
});
