import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACTIVE_STATES,
  PAUSABLE_STATES,
  isManualTransitionAllowed,
  type BulkTicketImportResult,
  type Job,
  type JobDetail,
  type JobState,
  type JobSummary,
  type PipelinePhase,
} from '@agent/shared';
import type { Repositories } from '@agent/database';
import type { GitService } from '@agent/git';
import { LinearService } from '@agent/linear';
import { assertManualTransition, assertTransition } from '@agent/workflow';
import type { AppConfig } from '../config.js';
import type { Publisher } from '../events/publisher.js';
import type { LogStore } from '../services/log-store.js';
import type { KeyedMutex } from '../services/mutex.js';
import type { JobQueue } from '../pipeline/queue.js';
import type { TestSandbox } from './test-sandbox.js';

export class JobServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_TRANSITION' | 'LINEAR_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'JobServiceError';
  }
}

interface JobServiceDeps {
  config: AppConfig;
  repos: Repositories;
  publisher: Publisher;
  queue: JobQueue;
  linear: LinearService;
  logStore: LogStore;
  mutex: KeyedMutex;
  git: GitService;
  testSandbox: TestSandbox;
}

export interface JobCleanupOptions {
  removeWorktree: boolean;
}

/**
 * Kapselt alle Job-Aktionen. Jede Mutation läuft durch die per-Ticket-Mutex und
 * re-validiert den aktuellen Zustand im Lock (ADR-013). Die zulässigen manuellen
 * Übergänge stammen aus der Workflow-Engine — nicht aus dem Client.
 */
export class JobService {
  constructor(private readonly deps: JobServiceDeps) {}

  listSummaries(): JobSummary[] {
    return this.deps.repos.jobs.listSummaries();
  }

  getSummary(jobId: string): JobSummary {
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (!summary) throw new JobServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
    return summary;
  }

  getDetail(jobId: string): JobDetail {
    const summary = this.getSummary(jobId);
    return {
      ...summary,
      events: this.deps.repos.jobEvents.listByJob(jobId, { limit: 2000 }),
      agentRuns: this.deps.repos.agentRuns.listByJob(jobId),
      artifacts: this.deps.repos.artifacts.listByJob(jobId),
      reviewIterations: this.deps.repos.reviewIterations.listByJob(jobId),
      testRuns: this.deps.repos.testRuns.listByJob(jobId),
    };
  }

  async importTicket(identifier: string, projectId: string): Promise<JobSummary> {
    const project = this.deps.repos.projects.get(projectId);
    if (!project) throw new JobServiceError('NOT_FOUND', `Projekt nicht gefunden: ${projectId}`);
    return this.deps.mutex.run(`import:${identifier.toLowerCase()}`, async () => {
      let draft;
      try {
        draft = await this.deps.linear.fetchTicket(identifier);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new JobServiceError('LINEAR_ERROR', message);
      }
      const ticket = this.deps.repos.tickets.upsert({ ...draft, projectId });
      const job = this.deps.repos.jobs.insert({
        ticketId: ticket.id,
        projectId,
        baseBranch: project.baseBranch,
      });
      this.deps.repos.jobEvents.append({
        jobId: job.id,
        type: 'job.created',
        toState: 'inbox',
        message: `Ticket ${ticket.identifier} importiert`,
      });
      const summary = this.getSummary(job.id);
      this.deps.publisher.emit('job.created', job.id, { job: summary });
      return summary;
    });
  }

  async importTickets(
    identifiers: readonly string[],
    projectId: string,
  ): Promise<BulkTicketImportResult> {
    if (!this.deps.repos.projects.get(projectId)) {
      throw new JobServiceError('NOT_FOUND', `Projekt nicht gefunden: ${projectId}`);
    }
    const unique = [...new Map(identifiers.map((id) => [id.toLowerCase(), id])).values()];
    const result: BulkTicketImportResult = { jobs: [], failures: [] };
    for (const identifier of unique) {
      try {
        result.jobs.push(await this.importTicket(identifier, projectId));
      } catch (error) {
        result.failures.push({
          identifier,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async updateTicketDescription(jobId: string, description: string): Promise<JobSummary> {
    return this.withJob(jobId, async (job) => {
      if (
        job.state === 'agent_ready' ||
        ACTIVE_STATES.includes(job.state) ||
        job.currentAgent != null ||
        job.activePgid != null
      ) {
        throw new JobServiceError(
          'CONFLICT',
          'Die Beschreibung kann während eines aktiven Agentenlaufs nicht geändert werden.',
        );
      }
      const ticket = this.deps.repos.tickets.get(job.ticketId);
      if (!ticket) {
        throw new JobServiceError('NOT_FOUND', `Ticket nicht gefunden: ${job.ticketId}`);
      }
      try {
        await this.deps.linear.updateDescription(ticket.linearIssueId, description);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new JobServiceError('LINEAR_ERROR', message);
      }
      this.deps.repos.tickets.updateDescription(ticket.id, description);
      const summary = this.getSummary(job.id);
      this.deps.publisher.record({
        type: 'job.updated',
        jobId: job.id,
        payload: { job: summary },
        message: `Beschreibung von ${ticket.identifier} in Linear aktualisiert`,
      });
      return summary;
    });
  }

  private withJob<T>(jobId: string, fn: (job: Job) => T | Promise<T>): Promise<T> {
    const initial = this.deps.repos.jobs.get(jobId);
    if (!initial) throw new JobServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
    return this.deps.mutex.run(`ticket:${initial.ticketId}`, async () => {
      const job = this.deps.repos.jobs.get(jobId);
      if (!job) throw new JobServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
      return fn(job);
    });
  }

  /** Setzt den Job auf agent_ready und reiht ihn am gewünschten Checkpoint ein. */
  private moveToAgentReady(
    job: Job,
    message: string,
    options: { resumePhase: PipelinePhase; resetLoops?: boolean },
  ): JobSummary {
    if (!isManualTransitionAllowed(job.state, 'agent_ready')) {
      throw new JobServiceError(
        'INVALID_TRANSITION',
        `Start aus Zustand ${job.state} ist nicht erlaubt`,
      );
    }
    this.deps.repos.jobs.update(job.id, {
      state: 'agent_ready',
      reviewLoopCount: options.resetLoops ? 0 : job.reviewLoopCount,
      pauseRequested: false,
      lastError: null,
      finishedAt: null,
      resumePhase: options.resumePhase,
      planApprovedAt:
        options.resumePhase === 'preflight' || options.resumePhase === 'planning'
          ? null
          : job.planApprovedAt,
    });
    this.deps.logStore.append(job.id, {
      ts: new Date().toISOString(),
      source: 'system',
      stream: 'info',
      text: message,
    });
    this.broadcastStateChange(job.id, job.state, 'agent_ready', message);
    this.deps.queue.enqueue(job.id);
    return this.getSummary(job.id);
  }

  async start(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) =>
      this.moveToAgentReady(job, 'Workflow gestartet', {
        resumePhase: 'preflight',
        resetLoops: true,
      }),
    );
  }

  async retry(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (job.state !== 'failed' && job.state !== 'needs_human' && job.state !== 'paused') {
        throw new JobServiceError(
          'CONFLICT',
          `Retry ist nur aus failed/needs_human/paused möglich (aktuell: ${job.state})`,
        );
      }
      if (job.baseStale) {
        throw new JobServiceError(
          'CONFLICT',
          'Basisbranch ist fortgeschritten; Branch manuell aktualisieren oder Ticket als neuen Job importieren',
        );
      }
      return this.moveToAgentReady(job, 'Lauf am gespeicherten Checkpoint fortgesetzt', {
        resumePhase: job.resumePhase ?? 'preflight',
        resetLoops: job.state !== 'paused',
      });
    });
  }

  async approvePlan(jobId: string, note: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (job.state !== 'awaiting_plan_approval') {
        throw new JobServiceError(
          'INVALID_TRANSITION',
          `Planfreigabe ist nur aus awaiting_plan_approval möglich (aktuell: ${job.state})`,
        );
      }
      assertTransition(job.state, 'agent_ready');
      if (note.trim()) {
        const artifact = this.deps.repos.artifacts.insert({
          jobId,
          type: 'approval',
          content: note.trim(),
        });
        this.deps.publisher.record({
          type: 'artifact.created',
          jobId,
          payload: {
            artifact: {
              id: artifact.id,
              jobId,
              agentRunId: null,
              type: artifact.type,
              path: null,
              createdAt: artifact.createdAt,
            },
          },
        });
      }
      this.deps.repos.jobs.update(jobId, {
        state: 'agent_ready',
        planApprovedAt: new Date().toISOString(),
        resumePhase: 'implementing',
        finishedAt: null,
        lastError: null,
      });
      this.broadcastStateChange(jobId, job.state, 'agent_ready', 'Plan menschlich freigegeben');
      this.deps.queue.enqueueAfterCurrent(jobId);
      return this.getSummary(jobId);
    });
  }

  async pause(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (!PAUSABLE_STATES.includes(job.state)) {
        throw new JobServiceError('CONFLICT', `Pause aus Zustand ${job.state} nicht möglich`);
      }
      if (
        this.deps.queue.isRunning(jobId) ||
        (job.currentAgent != null && this.deps.queue.isQueued(jobId))
      ) {
        // Soft-Pause: greift an der nächsten Phasengrenze.
        this.deps.repos.jobs.update(jobId, { pauseRequested: true });
        this.deps.logStore.append(jobId, {
          ts: new Date().toISOString(),
          source: 'system',
          stream: 'info',
          text: 'Pause angefordert — hält an der nächsten Phasengrenze',
        });
        return this.getSummary(jobId);
      }
      // Nicht (mehr) laufend: direkt pausieren.
      this.deps.queue.cancel(jobId);
      this.deps.repos.jobs.update(jobId, {
        state: 'paused',
        pauseRequested: false,
        currentAgent: null,
        activePgid: null,
        resumePhase: job.resumePhase ?? 'preflight',
      });
      this.broadcastStateChange(jobId, job.state, 'paused', 'Pausiert');
      const summary = this.getSummary(jobId);
      this.deps.publisher.record({ type: 'job.paused', jobId, payload: { job: summary } });
      return summary;
    });
  }

  async cancel(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (
        this.deps.queue.isRunning(jobId) ||
        (job.currentAgent != null && this.deps.queue.isQueued(jobId))
      ) {
        // Pipeline oder explizite Post-Run-Aktion über ihr Queue-AbortSignal stoppen.
        this.deps.queue.cancel(jobId);
        return this.getSummary(jobId);
      }
      if (
        job.state === 'done' ||
        job.state === 'failed' ||
        job.state === 'ready_for_human' ||
        job.state === 'awaiting_plan_approval'
      ) {
        throw new JobServiceError('CONFLICT', `Job ist bereits ${job.state}`);
      }
      this.deps.queue.cancel(jobId);
      assertTransition(job.state, 'failed');
      this.deps.repos.jobs.update(jobId, {
        state: 'failed',
        lastError: 'Vom Benutzer abgebrochen',
        finishedAt: new Date().toISOString(),
        currentAgent: null,
        activePgid: null,
      });
      this.broadcastStateChange(jobId, job.state, 'failed', 'Vom Benutzer abgebrochen');
      const summary = this.getSummary(jobId);
      this.deps.publisher.record({
        type: 'job.failed',
        jobId,
        payload: { job: summary, error: 'Vom Benutzer abgebrochen' },
      });
      return summary;
    });
  }

  private assertIdleForDestructiveAction(job: Job): void {
    if (this.deps.queue.isQueued(job.id) || job.currentAgent || job.activePgid != null) {
      throw new JobServiceError(
        'CONFLICT',
        'Laufender oder wartender Job kann nicht zurückgesetzt oder gelöscht werden',
      );
    }
  }

  private worktreeOwner(job: Job): {
    jobId: string;
    branch: string;
    repositoryPath: string;
    baseCommit: string;
  } | null {
    if (!job.worktreePath) return null;
    const project = this.deps.repos.projects.get(job.projectId);
    if (!project || !job.branch || !job.baseCommitSha) {
      throw new JobServiceError(
        'CONFLICT',
        'Worktree-Metadaten sind unvollständig; keine automatische Bereinigung möglich',
      );
    }
    return {
      jobId: job.id,
      branch: job.branch,
      repositoryPath: project.repositoryPath,
      baseCommit: job.baseCommitSha,
    };
  }

  private async cleanupRuntimeFiles(jobId: string): Promise<void> {
    const runFiles = this.deps.repos.agentRuns.listByJob(jobId).map((run) =>
      fs.rm(path.join(this.deps.config.dataDir, 'codex-runs', `${run.id}.last-message.txt`), {
        force: true,
      }),
    );
    await Promise.all([this.deps.testSandbox.cleanup(jobId), ...runFiles]);
  }

  async resetToInbox(jobId: string, options: JobCleanupOptions): Promise<JobSummary> {
    return this.withJob(jobId, async (job) => {
      this.assertIdleForDestructiveAction(job);
      const owner = this.worktreeOwner(job);
      if (job.worktreePath && owner) {
        if (options.removeWorktree) {
          await this.deps.git.removeOwnedWorktree(owner.repositoryPath, job.worktreePath, owner);
        } else {
          this.deps.git.clearOwnedAgentArtifacts(job.worktreePath, owner);
        }
      }

      await this.cleanupRuntimeFiles(jobId);
      this.deps.repos.jobs.resetToInbox(jobId, {
        clearGitMetadata: options.removeWorktree,
      });
      this.deps.logStore.clear(jobId);
      const summary = this.getSummary(jobId);
      this.deps.logStore.append(jobId, {
        ts: new Date().toISOString(),
        source: 'system',
        stream: 'info',
        text: 'Job vollständig auf Inbox zurückgesetzt',
      });
      this.deps.publisher.record({
        type: 'job.state_changed',
        jobId,
        payload: { job: summary, fromState: job.state, toState: 'inbox' },
        fromState: job.state,
        toState: 'inbox',
        message: 'Job vollständig auf Inbox zurückgesetzt',
      });
      this.deps.publisher.emit('job.updated', jobId, { job: summary });
      return summary;
    });
  }

  async delete(jobId: string, options: JobCleanupOptions): Promise<void> {
    return this.withJob(jobId, async (job) => {
      this.assertIdleForDestructiveAction(job);
      const owner = this.worktreeOwner(job);
      if (options.removeWorktree && job.worktreePath && owner) {
        await this.deps.git.removeOwnedWorktree(owner.repositoryPath, job.worktreePath, owner);
      }
      await this.cleanupRuntimeFiles(jobId);
      this.deps.repos.jobs.deleteWithRelations(jobId);
      this.deps.logStore.clear(jobId);
      this.deps.publisher.emit('job.deleted', jobId, { jobId });
    });
  }

  /** Manuelle Zustandsänderung (Kanban-DnD / PATCH). */
  async patchState(jobId: string, to: JobState): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (this.deps.queue.isQueued(jobId) || job.currentAgent) {
        throw new JobServiceError(
          'CONFLICT',
          'Laufender Job kann nicht manuell verschoben werden — nutze Pause oder Abbruch',
        );
      }
      assertManualTransition(job.state, to);
      if (to === 'agent_ready') {
        return this.moveToAgentReady(job, 'Workflow per Board gestartet', {
          resumePhase: job.resumePhase ?? 'preflight',
          resetLoops: job.state !== 'paused',
        });
      }
      if (to === 'inbox') {
        this.deps.repos.jobs.update(jobId, {
          state: to,
          resumePhase: 'preflight',
          planApprovedAt: null,
        });
        this.broadcastStateChange(jobId, job.state, to, 'Plan verworfen und nach Inbox verschoben');
        return this.getSummary(jobId);
      }
      const patch =
        to === 'done'
          ? { state: to, finishedAt: new Date().toISOString(), resumePhase: null }
          : { state: to };
      this.deps.repos.jobs.update(jobId, patch);
      this.broadcastStateChange(jobId, job.state, to, `Manuell nach ${to} verschoben`);
      const summary = this.getSummary(jobId);
      if (to === 'done') {
        this.deps.publisher.record({ type: 'job.completed', jobId, payload: { job: summary } });
      }
      return summary;
    });
  }

  private broadcastStateChange(jobId: string, from: JobState, to: JobState, message: string): void {
    const summary = this.getSummary(jobId);
    this.deps.publisher.record({
      type: 'job.state_changed',
      jobId,
      payload: { job: summary, fromState: from, toState: to },
      fromState: from,
      toState: to,
      message,
    });
  }
}
