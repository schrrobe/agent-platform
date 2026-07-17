import type { AgentAdapter, GithubReviewActionResult, Job, Project } from '@agent/shared';
import type { Repositories } from '@agent/database';
import type { GitService } from '@agent/git';
import {
  buildGithubReviewPrompt,
  parseGithubReviewResult,
  renderGithubReviewMarkdown,
} from '@agent/agents';
import type { AppConfig } from '../config.js';
import type { Publisher } from '../events/publisher.js';
import type { LogStore } from './log-store.js';
import type { JobQueue } from '../pipeline/queue.js';
import type { JobPipeline } from '../pipeline/pipeline.js';
import type { GithubClientLike } from './github-client.js';

export class GithubReviewServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'EXTERNAL' | 'AGENT_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'GithubReviewServiceError';
  }
}

interface GithubReviewServiceDeps {
  config: AppConfig;
  repos: Repositories;
  git: GitService;
  codex: AgentAdapter;
  github: GithubClientLike;
  publisher: Publisher;
  logStore: LogStore;
  queue: JobQueue;
  pipeline: JobPipeline;
}

type PreparedJob = Job & {
  worktreePath: string;
  branch: string;
  baseCommitSha: string;
};

/** Explizite Post-Run-Aktion: Review-Threads bearbeiten, pushen, danach auflösen. */
export class GithubReviewService {
  constructor(private readonly deps: GithubReviewServiceDeps) {}

  async run(jobId: string): Promise<GithubReviewActionResult> {
    const initial = this.deps.repos.jobs.get(jobId);
    if (!initial) throw new GithubReviewServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
    if (!['ready_for_human', 'done'].includes(initial.state)) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `GitHub-Nacharbeit ist nur am Ende eines Durchgangs möglich (aktuell: ${initial.state})`,
      );
    }
    if (!initial.worktreePath || !initial.branch || !initial.baseCommitSha) {
      throw new GithubReviewServiceError('CONFLICT', 'Job besitzt keinen vollständigen Worktree');
    }
    if (initial.currentAgent || this.deps.queue.hasLease(jobId)) {
      throw new GithubReviewServiceError('CONFLICT', 'GitHub-Nacharbeit läuft bereits');
    }
    const leasePromise = this.deps.queue.reserve(jobId);
    this.deps.repos.jobs.update(jobId, { currentAgent: this.deps.codex.name });
    this.publishJobUpdated(jobId);
    let lease;
    try {
      try {
        lease = await leasePromise;
      } catch (error) {
        throw new GithubReviewServiceError(
          'CONFLICT',
          error instanceof Error ? error.message : String(error),
        );
      }
      const job = this.deps.repos.jobs.get(jobId);
      if (!job) throw new GithubReviewServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
      return await this.runLocked(job, lease.signal);
    } finally {
      lease?.release();
      this.deps.repos.jobs.update(jobId, { currentAgent: null, activePgid: null });
      this.publishJobUpdated(jobId);
    }
  }

  private async runLocked(job: Job, signal: AbortSignal): Promise<GithubReviewActionResult> {
    if (!['ready_for_human', 'done'].includes(job.state)) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `GitHub-Nacharbeit ist nur am Ende eines Durchgangs möglich (aktuell: ${job.state})`,
      );
    }
    if (!job.worktreePath || !job.branch || !job.baseCommitSha) {
      throw new GithubReviewServiceError('CONFLICT', 'Job besitzt keinen vollständigen Worktree');
    }
    return this.executeLocked(
      {
        ...job,
        worktreePath: job.worktreePath,
        branch: job.branch,
        baseCommitSha: job.baseCommitSha,
      },
      signal,
    );
  }

  private async executeLocked(
    job: PreparedJob,
    signal: AbortSignal,
  ): Promise<GithubReviewActionResult> {
    this.assertNotAborted(signal);
    const project = this.deps.repos.projects.get(job.projectId);
    const ticket = this.deps.repos.tickets.get(job.ticketId);
    if (!project || !ticket) {
      throw new GithubReviewServiceError('NOT_FOUND', 'Projekt- oder Ticketdaten fehlen');
    }

    this.deps.git.verifyOwner(job.worktreePath, {
      jobId: job.id,
      branch: job.branch,
      repositoryPath: project.repositoryPath,
      baseCommit: job.baseCommitSha,
    });
    await this.deps.git.assertWorktreeClean(job.worktreePath);
    const beforeHead = await this.deps.git.currentHead(job.worktreePath);
    // Recovery-Anker vor jedem externen Aufruf persistieren. Bei einem Prozesscrash
    // darf nur auf genau diesen zuvor sauberen, job-eigenen HEAD zurückgesetzt werden.
    this.deps.repos.jobs.update(job.id, { headCommitSha: beforeHead });

    let pullRequest;
    let allThreads;
    try {
      pullRequest = await this.deps.github.findPullRequest(job.worktreePath, job.branch, signal);
      allThreads = await this.deps.github.listReviewThreads(pullRequest, job.worktreePath, signal);
    } catch (error) {
      throw new GithubReviewServiceError(
        'EXTERNAL',
        error instanceof Error ? error.message : String(error),
      );
    }
    const openThreads = allThreads.filter((thread) => !thread.isResolved);
    if (openThreads.length === 0) {
      this.system(job.id, 'GitHub: keine offenen Review-Threads gefunden');
      return {
        pullRequestUrl: pullRequest.url,
        openThreadCount: 0,
        addressedThreadCount: 0,
        remainingThreadCount: 0,
        commit: null,
        pushed: false,
        summary: 'Keine offenen Review-Threads gefunden.',
      };
    }

    let changesFinalized = false;
    try {
      const prompt = buildGithubReviewPrompt({
        ticket,
        pullRequestUrl: pullRequest.url,
        threads: openThreads.map(({ isResolved: _isResolved, ...thread }) => thread),
      });
      const run = this.deps.repos.agentRuns.insert({
        jobId: job.id,
        phase: 'github_review',
        agent: this.deps.codex.name,
      });
      this.deps.publisher.record({
        type: 'agent.started',
        jobId: job.id,
        payload: { runId: run.id, agent: this.deps.codex.name, phase: 'github_review' },
        message: `${this.deps.codex.name} (github_review) gestartet`,
      });
      let execution;
      const onAbort = () => void this.deps.codex.cancel(run.id);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        execution = await this.deps.codex.execute({
          runId: run.id,
          jobId: job.id,
          phase: 'github_review',
          prompt,
          cwd: job.worktreePath,
          timeoutMs: this.deps.config.limits.maxJobRuntimeMs,
          maxOutputBytes: this.deps.config.limits.maxAgentOutputBytes,
          onOutput: (chunk) => {
            this.deps.logStore.append(job.id, {
              ts: new Date().toISOString(),
              source: 'agent',
              stream: chunk.stream,
              text: chunk.text,
            });
            this.deps.publisher.emit('agent.output', job.id, {
              runId: run.id,
              stream: chunk.stream,
              text: chunk.text,
            });
          },
          onSpawned: (pgid) => {
            this.deps.repos.agentRuns.update(run.id, { pgid: pgid ?? null });
            this.deps.repos.jobs.update(job.id, { activePgid: pgid ?? null });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.repos.agentRuns.update(run.id, {
          status: 'failed',
          error: message,
          finishedAt: new Date().toISOString(),
        });
        this.deps.publisher.record({
          type: 'agent.failed',
          jobId: job.id,
          payload: { runId: run.id, status: 'failed', error: message },
          message: `codex (github_review): failed`,
        });
        throw new GithubReviewServiceError('AGENT_ERROR', message);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      this.deps.repos.agentRuns.update(run.id, {
        status: execution.status,
        exitCode: execution.exitCode,
        output: execution.output,
        outputTruncated: execution.truncated,
        error: execution.error,
        finishedAt: new Date().toISOString(),
      });
      this.deps.publisher.record({
        type: execution.status === 'completed' ? 'agent.completed' : 'agent.failed',
        jobId: job.id,
        payload:
          execution.status === 'completed'
            ? { runId: run.id, status: 'completed', exitCode: execution.exitCode }
            : {
                runId: run.id,
                status: execution.status,
                error: execution.error ?? 'unbekannt',
              },
        message: `codex (github_review): ${execution.status}`,
      });
      if (execution.status !== 'completed' || execution.truncated) {
        throw new GithubReviewServiceError(
          'AGENT_ERROR',
          execution.truncated
            ? 'Codex-Ausgabe wurde gekappt; GitHub-Kommentare bleiben offen'
            : (execution.error ?? 'Codex-Nacharbeit fehlgeschlagen'),
        );
      }
      this.assertNotAborted(signal);

      let result;
      try {
        result = parseGithubReviewResult(execution.output);
      } catch (error) {
        throw new GithubReviewServiceError(
          'AGENT_ERROR',
          error instanceof Error ? error.message : String(error),
        );
      }
      this.validateCoverage(
        openThreads.map((thread) => thread.id),
        result.addressedThreadIds,
        result.unaddressed.map((item) => item.threadId),
      );

      const headAfterAgent = await this.deps.git.currentHead(job.worktreePath);
      if (headAfterAgent !== beforeHead) {
        throw new GithubReviewServiceError(
          'CONFLICT',
          'Codex hat die Git-Historie verändert; Push und Kommentarauflösung wurden gestoppt',
        );
      }
      await this.deps.git.stageAll(job.worktreePath);
      await this.enforceStagedPolicy(job.worktreePath, project);

      let checksPassed;
      try {
        checksPassed = await this.deps.pipeline.verifyPostRunChanges(job.id, project, signal);
      } catch (error) {
        throw new GithubReviewServiceError(
          'CONFLICT',
          `Projektprüfungen konnten nicht sicher abgeschlossen werden: ${
            error instanceof Error ? error.message : String(error)
          }; GitHub-Kommentare bleiben offen`,
        );
      }
      if (!checksPassed) {
        throw new GithubReviewServiceError(
          'CONFLICT',
          'Mindestens eine Projektprüfung ist fehlgeschlagen; GitHub-Kommentare bleiben offen',
        );
      }
      this.assertNotAborted(signal);

      const commit = await this.deps.git.commitStaged(
        job.worktreePath,
        `fix: ${ticket.identifier} ${ticket.title} review feedback`,
      );
      const finalizedHead = commit ?? beforeHead;
      // Ein verifizierter Commit ist ab jetzt der Recovery-Anker und darf bei
      // einem Crash während Push/Resolve nicht wieder verworfen werden.
      this.deps.repos.jobs.update(job.id, { headCommitSha: finalizedHead });
      changesFinalized = true;
      await this.deps.git.assertWorktreeClean(job.worktreePath);

      let pushed: boolean;
      try {
        pushed = await this.deps.github.pushUpstream(job.worktreePath, job.branch, signal);
      } catch (error) {
        throw new GithubReviewServiceError(
          'EXTERNAL',
          `${error instanceof Error ? error.message : String(error)}; GitHub-Kommentare bleiben offen`,
        );
      }
      this.assertNotAborted(signal);

      let resolvedCount = 0;
      try {
        for (const threadId of result.addressedThreadIds) {
          await this.deps.github.resolveReviewThread(threadId, job.worktreePath, signal);
          resolvedCount += 1;
        }
      } catch (error) {
        throw new GithubReviewServiceError(
          'EXTERNAL',
          `GitHub-Auflösung nach ${resolvedCount}/${result.addressedThreadIds.length} Threads fehlgeschlagen: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const head = await this.deps.git.currentHead(job.worktreePath);
      this.deps.repos.jobs.update(job.id, { headCommitSha: head, lastError: null });
      const content = [
        `Pull Request: ${pullRequest.url}`,
        `Commit: ${commit ?? '(keine Codeänderung)'}`,
        `Push: ${pushed ? 'erfolgreich' : 'bereits synchron'}`,
        '',
        renderGithubReviewMarkdown(result),
      ].join('\n');
      const artifact = this.deps.repos.artifacts.insert({
        jobId: job.id,
        agentRunId: run.id,
        type: 'github_review',
        content,
      });
      this.deps.publisher.record({
        type: 'artifact.created',
        jobId: job.id,
        payload: {
          artifact: {
            id: artifact.id,
            jobId: artifact.jobId,
            agentRunId: artifact.agentRunId,
            type: artifact.type,
            path: artifact.path,
            createdAt: artifact.createdAt,
          },
        },
      });
      this.system(
        job.id,
        `GitHub-Nacharbeit abgeschlossen: ${resolvedCount}/${openThreads.length} Threads aufgelöst`,
      );
      const summary = this.deps.repos.jobs.getSummary(job.id);
      if (summary) this.deps.publisher.emit('job.updated', job.id, { job: summary });
      return {
        pullRequestUrl: pullRequest.url,
        openThreadCount: openThreads.length,
        addressedThreadCount: resolvedCount,
        remainingThreadCount: openThreads.length - resolvedCount,
        commit,
        pushed,
        summary: result.summary,
      };
    } catch (error) {
      if (!changesFinalized) {
        try {
          await this.deps.git.discardJobChanges(job.worktreePath, beforeHead);
        } catch (cleanupError) {
          throw new GithubReviewServiceError(
            'CONFLICT',
            `${error instanceof Error ? error.message : String(error)}; automatisches Aufräumen fehlgeschlagen: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        }
      }
      throw error;
    }
  }

  private validateCoverage(
    openThreadIds: string[],
    addressedThreadIds: string[],
    unaddressedThreadIds: string[],
  ): void {
    const open = new Set(openThreadIds);
    const addressed = new Set(addressedThreadIds);
    const unaddressed = new Set(unaddressedThreadIds);
    if (
      addressed.size !== addressedThreadIds.length ||
      unaddressed.size !== unaddressedThreadIds.length
    ) {
      throw new GithubReviewServiceError(
        'AGENT_ERROR',
        'Codex-Ergebnis enthält doppelte Thread-IDs',
      );
    }
    for (const id of addressed) {
      if (!open.has(id) || unaddressed.has(id)) {
        throw new GithubReviewServiceError(
          'AGENT_ERROR',
          `Codex-Ergebnis enthält eine unbekannte oder widersprüchliche Thread-ID: ${id}`,
        );
      }
    }
    for (const id of unaddressed) {
      if (!open.has(id)) {
        throw new GithubReviewServiceError(
          'AGENT_ERROR',
          `Codex-Ergebnis enthält eine unbekannte Thread-ID: ${id}`,
        );
      }
    }
    const covered = new Set([...addressed, ...unaddressed]);
    const missing = openThreadIds.filter((id) => !covered.has(id));
    if (missing.length > 0) {
      throw new GithubReviewServiceError(
        'AGENT_ERROR',
        `Codex-Ergebnis lässt offene Threads unbeantwortet: ${missing.join(', ')}`,
      );
    }
  }

  private async enforceStagedPolicy(worktree: string, project: Project): Promise<void> {
    const changed = await this.deps.git.stagedChangedFiles(worktree);
    if (changed.length > project.maxChangedFiles) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `GitHub-Nacharbeit umfasst ${changed.length} Dateien; Projektlimit ist ${project.maxChangedFiles}`,
      );
    }
    const changedPaths = changed.flatMap((entry) =>
      entry.previousPath ? [entry.previousPath, entry.path] : [entry.path],
    );
    const blocked = changedPaths.filter((changedPath) =>
      project.blockedPaths.some((prefix) => {
        const normalized = prefix.replace(/^\.\/+/, '').replace(/\/+$/, '');
        return changedPath === normalized || changedPath.startsWith(`${normalized}/`);
      }),
    );
    if (blocked.length > 0) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `GitHub-Nacharbeit berührt gesperrte Pfade: ${blocked.join(', ')}`,
      );
    }
    const [diff, binaryFiles] = await Promise.all([
      this.deps.git.stagedDiff(worktree),
      this.deps.git.stagedBinaryChangedFiles(worktree),
    ]);
    const bytes = Buffer.byteLength(diff);
    if (bytes > project.maxDiffBytes) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `GitHub-Nacharbeit ist ${bytes} Bytes groß; Projektlimit ist ${project.maxDiffBytes}`,
      );
    }
    if (binaryFiles.length > 0) {
      throw new GithubReviewServiceError(
        'CONFLICT',
        `Binäre Änderungen benötigen eine menschliche Prüfung: ${binaryFiles.join(', ')}`,
      );
    }
  }

  private system(jobId: string, message: string): void {
    this.deps.logStore.append(jobId, {
      ts: new Date().toISOString(),
      source: 'system',
      stream: 'info',
      text: message,
    });
  }

  private publishJobUpdated(jobId: string): void {
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary) this.deps.publisher.emit('job.updated', jobId, { job: summary });
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const reason = signal.reason as { message?: unknown } | undefined;
    throw new GithubReviewServiceError(
      'CONFLICT',
      typeof reason?.message === 'string' ? reason.message : 'GitHub-Nacharbeit abgebrochen',
    );
  }
}
