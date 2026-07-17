import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, migrate, createRepositories, type Repositories } from '../src/index.js';
import type { AppDatabase } from '../src/db.js';

function freshDb(): { db: AppDatabase; repos: Repositories } {
  const db = openDatabase(':memory:');
  migrate(db);
  return { db, repos: createRepositories(db) };
}

function seedProject(repos: Repositories) {
  return repos.projects.insert({
    name: 'Demo',
    repositoryPath: '/repos/demo',
    baseBranch: 'main',
    worktreeRoot: '/worktrees/demo',
    commands: { test: 'pnpm test' },
    autonomyMode: 'approve_plan',
    testExecutionMode: 'sandboxed',
    baselineChecks: true,
    maxChangedFiles: 100,
    maxDiffBytes: 1024 * 1024,
    blockedPaths: [],
    active: true,
  });
}

function seedTicket(repos: Repositories, projectId: string) {
  return repos.tickets.upsert({
    projectId,
    linearIssueId: 'lin-uuid-1',
    identifier: 'APP-123',
    title: 'Button reparieren',
    description: 'Der Button tut nichts.',
    url: 'https://linear.app/demo/issue/APP-123',
    teamKey: 'APP',
    teamName: 'App-Team',
    priority: 2,
    priorityLabel: 'High',
    labels: ['bug'],
    linearState: 'Todo',
    linearCreatedAt: '2026-07-01T10:00:00.000Z',
    linearUpdatedAt: '2026-07-02T10:00:00.000Z',
  });
}

describe('migrate', () => {
  it('legt alle Tabellen an und ist idempotent', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db);
    expect(first.applied).toContain('001_init.sql');
    expect(first.applied).toContain('002_safety_and_handoff.sql');

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    for (const table of [
      'projects',
      'tickets',
      'jobs',
      'job_events',
      'agent_runs',
      'artifacts',
      'review_iterations',
      'test_runs',
      'settings',
      'schema_migrations',
    ]) {
      expect(tables).toContain(table);
    }

    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
  });
});

describe('Repositories', () => {
  let db: AppDatabase;
  let repos: Repositories;

  beforeEach(() => {
    ({ db, repos } = freshDb());
  });

  it('Projekt-CRUD inkl. Kommando-JSON-Roundtrip', () => {
    const project = seedProject(repos);
    expect(project.commands).toEqual({ test: 'pnpm test' });
    expect(project.active).toBe(true);
    expect(project.autonomyMode).toBe('approve_plan');
    expect(project.testExecutionMode).toBe('sandboxed');

    const updated = repos.projects.update(project.id, {
      commands: { test: 'pnpm test', lint: 'pnpm lint' },
      active: false,
    });
    expect(updated.commands.lint).toBe('pnpm lint');
    expect(updated.active).toBe(false);
    expect(repos.projects.list()).toHaveLength(1);
  });

  it('Ticket-Upsert: Insert beim ersten, Update beim zweiten Import', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    expect(ticket.labels).toEqual(['bug']);

    const again = repos.tickets.upsert({
      projectId: project.id,
      linearIssueId: 'lin-uuid-1',
      identifier: 'APP-123',
      title: 'Button reparieren (aktualisiert)',
      description: 'Neu.',
      url: ticket.url,
      teamKey: 'APP',
      teamName: 'App-Team',
      priority: 1,
      priorityLabel: 'Urgent',
      labels: ['bug', 'ui'],
      linearState: 'In Progress',
      linearCreatedAt: ticket.linearCreatedAt,
      linearUpdatedAt: '2026-07-03T10:00:00.000Z',
    });
    expect(again.id).toBe(ticket.id);
    expect(again.title).toContain('aktualisiert');
    expect(repos.tickets.list()).toHaveLength(1);
    expect(repos.tickets.getByIdentifier('app-123')?.id).toBe(ticket.id);
  });

  it('Job-Lifecycle: Insert in inbox, Patch, Summary-Join', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const job = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });
    expect(job.state).toBe('inbox');
    expect(job.pauseRequested).toBe(false);

    const patched = repos.jobs.update(job.id, {
      state: 'agent_ready',
      worktreePath: '/worktrees/demo/app-123',
      branch: 'agent/app-123',
      pauseRequested: true,
      activePgid: 9876,
      lastError: null,
    });
    expect(patched.state).toBe('agent_ready');
    expect(patched.pauseRequested).toBe(true);
    expect(patched.branch).toBe('agent/app-123');
    expect(patched.baseStale).toBe(false);
    expect(repos.jobs.listActivePgids()).toEqual([{ jobId: job.id, pgid: 9876 }]);

    const summary = repos.jobs.getSummary(job.id);
    expect(summary?.ticket.identifier).toBe('APP-123');
    expect(summary?.projectName).toBe('Demo');
    expect(summary?.repositoryPath).toBe('/repos/demo');
    expect(repos.jobs.listSummaries()).toHaveLength(1);

    expect(repos.jobs.listByStates(['agent_ready'])).toHaveLength(1);
    expect(repos.jobs.listByStates(['done'])).toHaveLength(0);
    expect(repos.jobs.findByProjectInStates(project.id, ['agent_ready'])?.id).toBe(job.id);
  });

  it('Job-Events: monoton steigende Sequenz-IDs', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const job = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });

    const first = repos.jobEvents.append({ jobId: job.id, type: 'job.created' });
    const second = repos.jobEvents.append({
      jobId: job.id,
      type: 'job.state_changed',
      fromState: 'inbox',
      toState: 'agent_ready',
      data: { manual: true },
    });
    expect(second.id).toBeGreaterThan(first.id);
    expect(repos.jobEvents.lastSeq()).toBe(second.id);

    const events = repos.jobEvents.listByJob(job.id);
    expect(events).toHaveLength(2);
    expect(events[1]?.data).toEqual({ manual: true });

    const after = repos.jobEvents.listByJob(job.id, { afterId: first.id });
    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe('job.state_changed');
  });

  it('AgentRuns, Artifacts, ReviewIterations, TestRuns', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const job = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });

    const run = repos.agentRuns.insert({ jobId: job.id, phase: 'plan', agent: 'claude' });
    expect(run.status).toBe('running');
    repos.agentRuns.update(run.id, { pgid: 4321 });
    expect(repos.agentRuns.listRunningPgids()).toEqual([
      { runId: run.id, jobId: job.id, pgid: 4321 },
    ]);

    const done = repos.agentRuns.update(run.id, {
      status: 'completed',
      exitCode: 0,
      output: '# Ziel …',
      finishedAt: '2026-07-12T12:00:00.000Z',
    });
    expect(done.status).toBe('completed');
    expect(done.outputTruncated).toBe(false);
    expect(repos.agentRuns.listRunningPgids()).toHaveLength(0);

    const artifact = repos.artifacts.insert({
      jobId: job.id,
      agentRunId: run.id,
      type: 'plan',
      path: '/worktrees/demo/app-123/.agent/PLAN.md',
      content: '# Ziel …',
    });
    expect(repos.artifacts.latestByType(job.id, 'plan')?.id).toBe(artifact.id);

    const review = repos.reviewIterations.insert({
      jobId: job.id,
      iteration: 1,
      verdict: 'FAIL',
      artifactId: artifact.id,
    });
    expect(repos.reviewIterations.listByJob(job.id)).toEqual([review]);

    const testRun = repos.testRuns.insert({
      jobId: job.id,
      iteration: 1,
      commandKey: 'test',
      command: 'pnpm test',
    });
    const finished = repos.testRuns.update(testRun.id, {
      status: 'failed',
      exitCode: 1,
      stdout: '1 failing',
      durationMs: 1200,
      finishedAt: '2026-07-12T12:01:00.000Z',
    });
    expect(finished.exitCode).toBe(1);
    expect(finished.baseline).toBe(false);
    expect(finished.outputTruncated).toBe(false);
    expect(repos.testRuns.listByJob(job.id)).toHaveLength(1);
  });

  it('tokenStats aggregiert Token pro Job, Agent und Phase', () => {
    const project = seedProject(repos);
    const ticket1 = seedTicket(repos, project.id);
    const job1 = repos.jobs.insert({
      ticketId: ticket1.id,
      projectId: project.id,
      baseBranch: 'main',
    });
    const ticket2 = repos.tickets.upsert({
      projectId: project.id,
      linearIssueId: 'lin-uuid-2',
      identifier: 'APP-999',
      title: 'Zweites Ticket',
      description: '',
      url: 'https://linear.app/demo/issue/APP-999',
      teamKey: 'APP',
      teamName: 'App-Team',
      priority: 2,
      priorityLabel: 'High',
      labels: [],
      linearState: 'Todo',
      linearCreatedAt: '2026-07-01T10:00:00.000Z',
      linearUpdatedAt: '2026-07-02T10:00:00.000Z',
    });
    const job2 = repos.jobs.insert({
      ticketId: ticket2.id,
      projectId: project.id,
      baseBranch: 'main',
    });

    const plan = repos.agentRuns.insert({ jobId: job1.id, phase: 'plan', agent: 'claude' });
    repos.agentRuns.update(plan.id, {
      status: 'completed',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 200,
      cacheCreationTokens: 10,
      totalTokens: 330,
      costUsd: 0.01,
    });
    // Codex-Lauf ohne Usage-Daten — zählt als "runsMissingUsage".
    const impl = repos.agentRuns.insert({ jobId: job1.id, phase: 'implement', agent: 'codex' });
    repos.agentRuns.update(impl.id, { status: 'completed' });
    const review = repos.agentRuns.insert({ jobId: job2.id, phase: 'review', agent: 'claude' });
    repos.agentRuns.update(review.id, {
      status: 'completed',
      inputTokens: 30,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 50,
      costUsd: 0.005,
    });

    const stats = repos.agentRuns.tokenStats();

    expect(stats.totals.totalTokens).toBe(380);
    expect(stats.totals.costUsd).toBeCloseTo(0.015, 6);
    expect(stats.totals.runCount).toBe(2);
    expect(stats.totals.runsMissingUsage).toBe(1);

    // Nach Gesamt-Token absteigend sortiert.
    expect(stats.perJob.map((j) => j.ticketIdentifier)).toEqual(['APP-123', 'APP-999']);
    expect(stats.perJob[0]?.totals.totalTokens).toBe(330);
    expect(stats.perJob[0]?.totals.runsMissingUsage).toBe(1);
    expect(stats.perJob[0]?.projectName).toBe('Demo');
    expect(stats.perJob[1]?.totals.totalTokens).toBe(50);

    const claude = stats.perAgent.find((a) => a.agent === 'claude');
    const codex = stats.perAgent.find((a) => a.agent === 'codex');
    expect(claude?.totals.totalTokens).toBe(380);
    expect(claude?.totals.runCount).toBe(2);
    expect(codex?.totals.totalTokens).toBe(0);
    expect(codex?.totals.runsMissingUsage).toBe(1);

    const planPhase = stats.perPhase.find((p) => p.phase === 'plan');
    expect(planPhase?.totals.totalTokens).toBe(330);
  });

  it('failAllRunning markiert laufende AgentRuns als canceled', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const job = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });
    repos.agentRuns.insert({ jobId: job.id, phase: 'plan', agent: 'claude' });
    repos.agentRuns.insert({ jobId: job.id, phase: 'implement', agent: 'codex' });

    const changed = repos.agentRuns.failAllRunning('Durch Neustart unterbrochen');
    expect(changed).toBe(2);
    const runs = repos.agentRuns.listByJob(job.id);
    expect(runs.every((r) => r.status === 'canceled')).toBe(true);

    const testRun = repos.testRuns.insert({
      jobId: job.id,
      iteration: 1,
      commandKey: 'test',
      command: 'pnpm test',
    });
    expect(repos.testRuns.failAllRunning('Durch Neustart unterbrochen')).toBe(1);
    expect(repos.testRuns.get(testRun.id)?.status).toBe('canceled');
  });

  it('setzt einen Job samt Laufdaten atomar auf Inbox zurück', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const job = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });
    repos.jobs.update(job.id, {
      state: 'failed',
      reviewLoopCount: 2,
      worktreePath: '/worktrees/demo/app-123',
      branch: 'fix/app-123/job',
      baseCommitSha: 'base123',
      headCommitSha: 'head123',
      lastError: 'kaputt',
    });
    const run = repos.agentRuns.insert({ jobId: job.id, phase: 'plan', agent: 'claude' });
    const artifact = repos.artifacts.insert({
      jobId: job.id,
      agentRunId: run.id,
      type: 'plan',
      content: 'Plan',
    });
    repos.reviewIterations.insert({
      jobId: job.id,
      iteration: 1,
      verdict: 'FAIL',
      artifactId: artifact.id,
    });
    repos.testRuns.insert({
      jobId: job.id,
      iteration: 1,
      commandKey: 'test',
      command: 'pnpm test',
    });
    repos.jobEvents.append({ jobId: job.id, type: 'job.failed' });

    const reset = repos.jobs.resetToInbox(job.id, { clearGitMetadata: true });
    expect(reset).toMatchObject({
      state: 'inbox',
      reviewLoopCount: 0,
      worktreePath: null,
      branch: null,
      baseCommitSha: null,
      headCommitSha: null,
      lastError: null,
    });
    expect(repos.agentRuns.listByJob(job.id)).toHaveLength(0);
    expect(repos.artifacts.listByJob(job.id)).toHaveLength(0);
    expect(repos.reviewIterations.listByJob(job.id)).toHaveLength(0);
    expect(repos.testRuns.listByJob(job.id)).toHaveLength(0);
    expect(repos.jobEvents.listByJob(job.id)).toHaveLength(0);
  });

  it('löscht Jobs mit Relationen und das Ticket erst nach dem letzten Job', () => {
    const project = seedProject(repos);
    const ticket = seedTicket(repos, project.id);
    const first = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });
    const second = repos.jobs.insert({
      ticketId: ticket.id,
      projectId: project.id,
      baseBranch: 'main',
    });

    expect(repos.jobs.deleteWithRelations(first.id).ticketDeleted).toBe(false);
    expect(repos.tickets.get(ticket.id)).toBeDefined();
    expect(repos.jobs.deleteWithRelations(second.id).ticketDeleted).toBe(true);
    expect(repos.tickets.get(ticket.id)).toBeUndefined();
  });

  it('Settings: get/set/all', () => {
    repos.settings.set('theme', 'dark');
    repos.settings.set('theme', 'light');
    expect(repos.settings.get('theme')).toBe('light');
    expect(repos.settings.all()).toEqual({ theme: 'light' });
  });

  it('Fremdschlüssel werden erzwungen', () => {
    const project = seedProject(repos);
    seedTicket(repos, project.id);
    expect(() => repos.projects.delete(project.id)).toThrow();
    expect(() =>
      repos.jobs.insert({ ticketId: 'fehlt', projectId: project.id, baseBranch: 'main' }),
    ).toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
