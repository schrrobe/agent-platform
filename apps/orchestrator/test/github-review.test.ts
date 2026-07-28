import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentExecutionInput, AgentExecutionResult } from '@agent/shared';
import { GithubReviewService } from '../src/services/github-review.js';
import type {
  GithubClientLike,
  GithubPullRequest,
  GithubReviewThread,
} from '../src/services/github-client.js';
import { createHarness, nodeCommand, type Harness } from './helpers/harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

class ReviewCodex implements AgentAdapter {
  readonly name = 'codex' as const;

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    fs.writeFileSync(path.join(input.cwd, 'github-review-fix.txt'), 'fixed\n');
    return {
      status: 'completed',
      exitCode: 0,
      output: JSON.stringify({
        version: 1,
        summary: 'Review-Hinweis umgesetzt.',
        addressedThreadIds: ['THREAD_1'],
        unaddressed: [],
        changedFiles: ['github-review-fix.txt'],
        testsRun: ['unit tests'],
      }),
      rawOutput: '',
      truncated: false,
      usage: null,
      error: null,
      durationMs: 10,
    };
  }

  async cancel(): Promise<void> {}
}

class NoChangeCodex extends ReviewCodex {
  override async execute(): Promise<AgentExecutionResult> {
    return {
      status: 'completed',
      exitCode: 0,
      output: JSON.stringify({
        version: 1,
        summary: 'Bereits im lokalen Commit erledigt.',
        addressedThreadIds: ['THREAD_1'],
        unaddressed: [],
        changedFiles: [],
        testsRun: [],
      }),
      rawOutput: '',
      truncated: false,
      usage: null,
      error: null,
      durationMs: 10,
    };
  }
}

class InvalidResultCodex extends ReviewCodex {
  override async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    fs.writeFileSync(path.join(input.cwd, 'invalid-result-change.txt'), 'temporary\n');
    return {
      status: 'completed',
      exitCode: 0,
      output: 'kein JSON',
      rawOutput: '',
      truncated: false,
      usage: null,
      error: null,
      durationMs: 10,
    };
  }
}

class CancelableCodex implements AgentAdapter {
  readonly name = 'codex' as const;
  private finish!: (result: AgentExecutionResult) => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    fs.writeFileSync(path.join(input.cwd, 'cancel-me.txt'), 'temporary\n');
    this.markStarted();
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  async cancel(): Promise<void> {
    this.finish({
      status: 'canceled',
      exitCode: null,
      output: '',
      rawOutput: '',
      truncated: false,
      usage: null,
      error: 'Lauf wurde abgebrochen',
      durationMs: 10,
    });
  }
}

class ReviewGithub implements GithubClientLike {
  readonly resolved: string[] = [];
  pushes = 0;
  readonly pr: GithubPullRequest = {
    repository: 'acme/demo',
    owner: 'acme',
    name: 'demo',
    number: 7,
    url: 'https://github.com/acme/demo/pull/7',
    headRefName: 'feature/app-700/test',
  };

  async findPullRequest(): Promise<GithubPullRequest> {
    return this.pr;
  }

  async listReviewThreads(): Promise<GithubReviewThread[]> {
    return [
      {
        id: 'THREAD_1',
        isResolved: false,
        isOutdated: false,
        path: 'src/example.ts',
        line: 12,
        comments: [
          {
            author: 'reviewer',
            body: 'Bitte korrigieren.',
            url: `${this.pr.url}#discussion_r1`,
          },
        ],
      },
    ];
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    this.resolved.push(threadId);
  }

  async pushUpstream(): Promise<boolean> {
    this.pushes += 1;
    return true;
  }
}

class BlockingGithub extends ReviewGithub {
  private releasePush!: () => void;
  private markStarted!: () => void;
  readonly pushStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly pushReleased = new Promise<void>((resolve) => {
    this.releasePush = resolve;
  });

  override async pushUpstream(): Promise<boolean> {
    this.pushes += 1;
    this.markStarted();
    await this.pushReleased;
    return true;
  }

  unblock(): void {
    this.releasePush();
  }
}

function reviewService(codex: AgentAdapter, github: GithubClientLike): GithubReviewService {
  if (!harness) throw new Error('Harness fehlt');
  return new GithubReviewService({
    config: harness.ctx.config,
    repos: harness.ctx.repos,
    git: harness.ctx.git,
    codex,
    github,
    publisher: harness.ctx.publisher,
    logStore: harness.ctx.logStore,
    queue: harness.ctx.queue,
    pipeline: harness.ctx.pipeline,
  });
}

describe('GithubReviewService', () => {
  it('lässt Codex offene Threads bearbeiten, pusht und löst sie danach auf', async () => {
    harness = await createHarness({ testCommand: null });
    const seeded = harness.seedJob('APP-700');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');

    const github = new ReviewGithub();
    const service = reviewService(new ReviewCodex(), github);

    const result = await service.run(seeded.id);

    expect(result).toMatchObject({
      openThreadCount: 1,
      addressedThreadCount: 1,
      remainingThreadCount: 0,
      pushed: true,
    });
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(github.pushes).toBe(1);
    expect(github.resolved).toEqual(['THREAD_1']);
    expect(harness.ctx.repos.artifacts.latestByType(seeded.id, 'github_review')?.content).toContain(
      'Review-Hinweis umgesetzt.',
    );
    expect(harness.ctx.repos.agentRuns.listByJob(seeded.id).at(-1)).toMatchObject({
      phase: 'github_review',
      status: 'completed',
    });
    expect(harness.ctx.repos.jobs.get(seeded.id)?.currentAgent).toBeNull();
  });

  it('pusht und resolved nichts, wenn eine Projektprüfung nach der Nacharbeit fehlschlägt', async () => {
    harness = await createHarness({ testCommand: null });
    const seeded = harness.seedJob('APP-701');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    harness.ctx.repos.projects.update(harness.projectId, {
      commands: { test: nodeCommand('process.exit(1)') },
    });

    const beforeHead = harness.ctx.repos.jobs.get(seeded.id)?.headCommitSha;
    const github = new ReviewGithub();
    const service = reviewService(new ReviewCodex(), github);

    await expect(service.run(seeded.id)).rejects.toThrow(/Projektprüfung/);
    expect(github.pushes).toBe(0);
    expect(github.resolved).toEqual([]);
    const job = harness.ctx.repos.jobs.get(seeded.id)!;
    expect(await harness.ctx.git.currentHead(job.worktreePath!)).toBe(beforeHead);
    expect(await harness.ctx.git.hasUncommittedChanges(job.worktreePath!)).toBe(false);
    expect(fs.existsSync(path.join(job.worktreePath!, 'github-review-fix.txt'))).toBe(false);
  });

  it('pusht einen bereits vorhandenen lokalen Commit auch ohne neue Codex-Änderung vor dem Resolve', async () => {
    harness = await createHarness({ testCommand: null });
    const seeded = harness.seedJob('APP-702');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    const github = new ReviewGithub();

    const result = await reviewService(new NoChangeCodex(), github).run(seeded.id);

    expect(result.commit).toBeNull();
    expect(github.pushes).toBe(1);
    expect(github.resolved).toEqual(['THREAD_1']);
  });

  it('räumt Codex-Änderungen bei ungültigem Ergebnis auf und bleibt retry-fähig', async () => {
    harness = await createHarness({ testCommand: null });
    const seeded = harness.seedJob('APP-703');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    const job = harness.ctx.repos.jobs.get(seeded.id)!;
    const beforeHead = await harness.ctx.git.currentHead(job.worktreePath!);

    await expect(
      reviewService(new InvalidResultCodex(), new ReviewGithub()).run(seeded.id),
    ).rejects.toThrow(/kein gültiges JSON/);

    expect(await harness.ctx.git.currentHead(job.worktreePath!)).toBe(beforeHead);
    expect(await harness.ctx.git.hasUncommittedChanges(job.worktreePath!)).toBe(false);
    expect(fs.existsSync(path.join(job.worktreePath!, 'invalid-result-change.txt'))).toBe(false);
  });

  it('hält Queue-Slot und Aktivstatus bis nach Push/Resolve und verhindert Doppelläufe', async () => {
    // Parallelität 1: der Lease der Nacharbeit belegt den einzigen Slot.
    harness = await createHarness({ testCommand: null, maxConcurrentJobs: 1 });
    const reviewed = harness.seedJob('APP-704');
    const waiting = harness.seedJob('APP-705');
    await harness.ctx.jobs.start(reviewed.id);
    expect(await harness.waitForState(reviewed.id, ['ready_for_human'])).toBe('ready_for_human');
    const github = new BlockingGithub();
    const service = reviewService(new ReviewCodex(), github);

    const action = service.run(reviewed.id);
    await github.pushStarted;
    expect(harness.ctx.repos.jobs.get(reviewed.id)?.currentAgent).toBe('codex');
    expect(harness.ctx.repos.jobs.get(reviewed.id)?.headCommitSha).toBe(
      await harness.ctx.git.currentHead(harness.ctx.repos.jobs.get(reviewed.id)!.worktreePath!),
    );
    expect(harness.ctx.queue.runningJobIds()).toContain(reviewed.id);
    await expect(service.run(reviewed.id)).rejects.toThrow(/läuft bereits/);

    await harness.ctx.jobs.start(waiting.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(harness.ctx.repos.jobs.get(waiting.id)?.state).toBe('agent_ready');
    expect(harness.ctx.queue.runningJobIds()).not.toContain(waiting.id);

    github.unblock();
    await action;
    expect(harness.ctx.repos.jobs.get(reviewed.id)?.currentAgent).toBeNull();
    expect(await harness.waitForState(waiting.id, ['ready_for_human'])).toBe('ready_for_human');
  });

  it('ist über die normale Job-Abbruchaktion abbrechbar und räumt Änderungen auf', async () => {
    harness = await createHarness({ testCommand: null });
    const seeded = harness.seedJob('APP-706');
    await harness.ctx.jobs.start(seeded.id);
    expect(await harness.waitForState(seeded.id, ['ready_for_human'])).toBe('ready_for_human');
    const codex = new CancelableCodex();
    const action = reviewService(codex, new ReviewGithub()).run(seeded.id);
    await codex.started;

    await harness.ctx.jobs.cancel(seeded.id);
    await expect(action).rejects.toThrow(/abgebrochen/);

    const job = harness.ctx.repos.jobs.get(seeded.id)!;
    expect(job.state).toBe('ready_for_human');
    expect(job.currentAgent).toBeNull();
    expect(harness.ctx.queue.isRunning(seeded.id)).toBe(false);
    expect(await harness.ctx.git.hasUncommittedChanges(job.worktreePath!)).toBe(false);
    expect(fs.existsSync(path.join(job.worktreePath!, 'cancel-me.txt'))).toBe(false);
  });
});
