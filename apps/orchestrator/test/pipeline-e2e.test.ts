import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { worktreePathForJob } from '@agent/git';
import { createHarness, nodeCommand, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('Pipeline E2E (Fake-Claude/-Codex)', () => {
  it('erzwingt trotz Automatik eine Freigabe bei hohem Planrisiko', async () => {
    harness = await createHarness({ planRiskLevel: 'high' });
    const job = harness.seedJob('APP-10');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, [
      'awaiting_plan_approval',
      'failed',
      'needs_human',
    ]);
    expect(state, harness.ctx.repos.jobs.get(job.id)?.lastError ?? '').toBe(
      'awaiting_plan_approval',
    );
    expect(JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')).codex).toBeUndefined();
  });

  it('durchläuft den Happy Path bis ready_for_human und erzeugt Handoff-Artefakte', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-1');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, ['ready_for_human', 'failed', 'needs_human']);
    expect(state).toBe('ready_for_human');

    const finished = harness.ctx.repos.jobs.get(job.id)!;
    const suffix = job.id.replaceAll('-', '');
    expect(finished.branch).toBe(`feature/app-1/${suffix}`);
    expect(finished.worktreePath).toBe(path.join(harness.worktreeRoot, `app-1-${suffix}`));
    expect(finished.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(finished.headCommitSha).toMatch(/^[0-9a-f]{40}$/);
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
    expect(artifacts.some((a) => a.type === 'handoff')).toBe(true);

    const reviews = harness.ctx.repos.reviewIterations.listByJob(job.id);
    expect(reviews.at(-1)?.verdict).toBe('PASS');

    // Zustandshistorie enthält den vollständigen Pfad.
    const events = harness.ctx.repos.jobEvents.listByJob(job.id);
    const toStates = events.filter((e) => e.type === 'job.state_changed').map((e) => e.toState);
    expect(toStates).toEqual(
      expect.arrayContaining([
        'agent_ready',
        'planning',
        'implementing',
        'testing',
        'review',
        'ready_for_human',
      ]),
    );

    // Live-Logs wurden geschrieben.
    expect(harness.ctx.logStore.read(job.id).length).toBeGreaterThan(0);
  });

  it('macht nach Review-FAIL Nacharbeit und besteht dann (rework → ready_for_human)', async () => {
    harness = await createHarness({ reviewSequence: 'FAIL,PASS', maxReviewLoops: 3 });
    const job = harness.seedJob('APP-2');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id, ['ready_for_human', 'failed', 'needs_human']);
    expect(state).toBe('ready_for_human');

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
    harness = await createHarness({
      reviewSequence: 'FAIL,FAIL,FAIL,FAIL,FAIL',
      maxReviewLoops: 2,
    });
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

  it('stoppt bei roter Baseline vor der Agentenimplementierung', async () => {
    harness = await createHarness({ testCommand: nodeCommand('process.exit(1)') });
    harness.ctx.repos.projects.update(harness.projectId, { baselineChecks: true });
    const job = harness.seedJob('APP-40');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id)).toBe('needs_human');
    expect(JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')).codex).toBeUndefined();
    expect(harness.ctx.repos.testRuns.listByJob(job.id)[0]?.baseline).toBe(true);
  });

  it('führt unabhängige Pflichtprüfungen gesammelt statt fail-fast aus', async () => {
    harness = await createHarness({ maxReviewLoops: 0, testCommand: null });
    harness.ctx.repos.projects.update(harness.projectId, {
      commands: {
        lint: nodeCommand('process.exit(1)'),
        test: nodeCommand('process.exit(2)'),
      },
    });
    const job = harness.seedJob('APP-41');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id)).toBe('needs_human');
    expect(harness.ctx.repos.testRuns.listByJob(job.id).map((run) => run.exitCode)).toEqual([1, 2]);
  });

  it('eskaliert, wenn ein angeblicher Prüfbefehl den Worktree verändert', async () => {
    harness = await createHarness({
      testCommand: nodeCommand("require('node:fs').writeFileSync('generated.txt','x')"),
    });
    const job = harness.seedJob('APP-42');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id)).toBe('needs_human');
    expect(harness.ctx.repos.jobs.get(job.id)?.lastError).toContain('Worktree verändert');
  });

  it('meldet needs_human, wenn Codex keine Änderung vornimmt', async () => {
    harness = await createHarness({ codexNoChange: true });
    const job = harness.seedJob('APP-5');
    await harness.ctx.jobs.start(job.id);
    const state = await harness.waitForState(job.id);
    expect(state).toBe('needs_human');
    expect(harness.ctx.repos.jobs.get(job.id)!.lastError).toContain('keine Dateiänderungen');
  });

  it('eskaliert einen belegten Worktree-Pfad ohne fremde Dateien zu löschen', async () => {
    harness = await createHarness();
    const job = harness.seedJob('APP-50');
    const target = path.join(harness.worktreeRoot, `app-50-${job.id.replaceAll('-', '')}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'important.txt'), 'behalten');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id, ['needs_human', 'failed'])).toBe('needs_human');
    expect(fs.readFileSync(path.join(target, 'important.txt'), 'utf8')).toBe('behalten');
  });

  it('eskaliert deterministisch bei gesperrten Diff-Pfaden', async () => {
    harness = await createHarness();
    harness.ctx.repos.projects.update(harness.projectId, { blockedPaths: ['impl.txt'] });
    const job = harness.seedJob('APP-51');
    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id)).toBe('needs_human');
    expect(harness.ctx.repos.jobs.get(job.id)?.lastError).toContain('gesperrte Pfade');
    expect(harness.ctx.repos.jobs.get(job.id)?.headCommitSha).not.toBeNull();
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
    const before = execFileSync('git', ['rev-parse', 'main'], { cwd: harness.repoDir })
      .toString()
      .trim();
    await harness.ctx.jobs.start(job.id);
    await harness.waitForState(job.id, ['ready_for_human']);
    const after = execFileSync('git', ['rev-parse', 'main'], { cwd: harness.repoDir })
      .toString()
      .trim();
    expect(after).toBe(before);
  });

  it('erkennt einen während des Laufs fortgeschrittenen Basisbranch als stale', async () => {
    harness = await createHarness({
      reviewSequence: 'PASS',
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},400)'),
    });
    const job = harness.seedJob('APP-8');
    await harness.ctx.jobs.start(job.id);
    const started = Date.now();
    while (harness.ctx.repos.jobs.get(job.id)?.state !== 'testing' && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.writeFileSync(path.join(harness.repoDir, 'README.md'), '# Basis fortgeschritten\n');
    const { execFileSync } = await import('node:child_process');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    };
    execFileSync('git', ['add', 'README.md'], { cwd: harness.repoDir, env });
    execFileSync('git', ['commit', '-m', 'advance base'], { cwd: harness.repoDir, env });

    expect(await harness.waitForState(job.id, ['needs_human'])).toBe('needs_human');
    expect(harness.ctx.repos.jobs.get(job.id)?.baseStale).toBe(true);
    expect(
      harness.ctx.repos.artifacts.listByJob(job.id).some((artifact) => artifact.type === 'handoff'),
    ).toBe(true);
  });

  it('setzt einen pausierten Job am gespeicherten Phasen-Checkpoint fort', async () => {
    harness = await createHarness({
      reviewSequence: 'PASS',
      testCommand: nodeCommand('setTimeout(function(){process.exit(0)},300)'),
    });
    const job = harness.seedJob('APP-9');
    await harness.ctx.jobs.start(job.id);
    const started = Date.now();
    while (harness.ctx.repos.jobs.get(job.id)?.state !== 'testing' && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await harness.ctx.jobs.pause(job.id);
    expect(await harness.waitForState(job.id, ['paused'])).toBe('paused');
    expect(harness.ctx.repos.jobs.get(job.id)?.resumePhase).toBe('review');

    await harness.ctx.jobs.retry(job.id);
    const resumed = await harness.waitForState(job.id, [
      'ready_for_human',
      'failed',
      'needs_human',
    ]);
    expect(resumed, harness.ctx.repos.jobs.get(job.id)?.lastError ?? '').toBe('ready_for_human');
    expect(JSON.parse(fs.readFileSync(harness.stateFile, 'utf8')).codex).toBe(1);
    expect(harness.ctx.repos.testRuns.listByJob(job.id)).toHaveLength(1);
  });

  it('persistiert den Branch vor der Worktree-Erstellung und behält ihn bei Ticket-Änderungen', async () => {
    harness = await createHarness({ reviewSequence: 'PASS' });
    const job = harness.seedJob('APP-910');
    const obstruction = worktreePathForJob(harness.worktreeRoot, 'APP-910', job.id);
    fs.mkdirSync(obstruction, { recursive: true });

    await harness.ctx.jobs.start(job.id);
    expect(await harness.waitForState(job.id, ['needs_human'])).toBe('needs_human');
    const persistedBranch = harness.ctx.repos.jobs.get(job.id)?.branch;
    expect(persistedBranch).toMatch(/^feature\/app-910\//);

    const ticket = harness.ctx.repos.tickets.get(job.ticketId)!;
    harness.ctx.repos.tickets.upsert({
      projectId: ticket.projectId,
      linearIssueId: ticket.linearIssueId,
      identifier: ticket.identifier,
      title: 'Bug nach Re-Import',
      description: ticket.description,
      url: ticket.url,
      teamKey: ticket.teamKey,
      teamName: ticket.teamName,
      priority: ticket.priority,
      priorityLabel: ticket.priorityLabel,
      labels: ['bug'],
      linearState: ticket.linearState,
      linearCreatedAt: ticket.linearCreatedAt,
      linearUpdatedAt: ticket.linearUpdatedAt,
    });
    fs.rmSync(obstruction, { recursive: true });

    await harness.ctx.jobs.retry(job.id);
    expect(await harness.waitForState(job.id, ['ready_for_human'])).toBe('ready_for_human');
    expect(harness.ctx.repos.jobs.get(job.id)?.branch).toBe(persistedBranch);
  });
});
