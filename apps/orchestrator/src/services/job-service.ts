import {
  PAUSABLE_STATES,
  isManualTransitionAllowed,
  type Job,
  type JobDetail,
  type JobState,
  type JobSummary,
} from '@agent/shared';
import type { Repositories } from '@agent/database';
import { LinearService } from '@agent/linear';
import { assertManualTransition } from '@agent/workflow';
import type { AppConfig } from '../config.js';
import type { Publisher } from '../events/publisher.js';
import type { LogStore } from '../services/log-store.js';
import type { KeyedMutex } from '../services/mutex.js';
import type { JobQueue } from '../pipeline/queue.js';

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

  private withJob<T>(jobId: string, fn: (job: Job) => T | Promise<T>): Promise<T> {
    const initial = this.deps.repos.jobs.get(jobId);
    if (!initial) throw new JobServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
    return this.deps.mutex.run(`ticket:${initial.ticketId}`, async () => {
      const job = this.deps.repos.jobs.get(jobId);
      if (!job) throw new JobServiceError('NOT_FOUND', `Job nicht gefunden: ${jobId}`);
      return fn(job);
    });
  }

  /** Setzt den Job auf agent_ready, setzt Zähler zurück und reiht ihn ein. */
  private moveToAgentReady(job: Job, message: string): JobSummary {
    if (!isManualTransitionAllowed(job.state, 'agent_ready')) {
      throw new JobServiceError(
        'INVALID_TRANSITION',
        `Start aus Zustand ${job.state} ist nicht erlaubt`,
      );
    }
    this.deps.repos.jobs.update(job.id, {
      state: 'agent_ready',
      reviewLoopCount: 0,
      pauseRequested: false,
      lastError: null,
      finishedAt: null,
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
    return this.withJob(jobId, (job) => this.moveToAgentReady(job, 'Workflow gestartet'));
  }

  async retry(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (job.state !== 'failed' && job.state !== 'needs_human' && job.state !== 'paused') {
        throw new JobServiceError(
          'CONFLICT',
          `Retry ist nur aus failed/needs_human/paused möglich (aktuell: ${job.state})`,
        );
      }
      return this.moveToAgentReady(job, 'Erneuter Versuch gestartet');
    });
  }

  async pause(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (!PAUSABLE_STATES.includes(job.state)) {
        throw new JobServiceError('CONFLICT', `Pause aus Zustand ${job.state} nicht möglich`);
      }
      if (this.deps.queue.isRunning(jobId)) {
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
      });
      this.broadcastStateChange(jobId, job.state, 'paused', 'Pausiert');
      const summary = this.getSummary(jobId);
      this.deps.publisher.record({ type: 'job.paused', jobId, payload: { job: summary } });
      return summary;
    });
  }

  async cancel(jobId: string): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (job.state === 'done' || job.state === 'failed') {
        throw new JobServiceError('CONFLICT', `Job ist bereits ${job.state}`);
      }
      if (this.deps.queue.isRunning(jobId)) {
        // Harter Abbruch: Prozessgruppe wird gekillt, Pipeline setzt failed.
        this.deps.queue.cancel(jobId);
        return this.getSummary(jobId);
      }
      this.deps.queue.cancel(jobId);
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

  /** Manuelle Zustandsänderung (Kanban-DnD / PATCH). */
  async patchState(jobId: string, to: JobState): Promise<JobSummary> {
    return this.withJob(jobId, (job) => {
      if (this.deps.queue.isRunning(jobId)) {
        throw new JobServiceError(
          'CONFLICT',
          'Laufender Job kann nicht manuell verschoben werden — nutze Pause oder Abbruch',
        );
      }
      assertManualTransition(job.state, to);
      if (to === 'agent_ready') {
        return this.moveToAgentReady(job, 'Workflow per Board gestartet');
      }
      const patch =
        to === 'done' ? { state: to, finishedAt: new Date().toISOString() } : { state: to };
      this.deps.repos.jobs.update(jobId, patch);
      this.broadcastStateChange(jobId, job.state, to, `Manuell nach ${to} verschoben`);
      return this.getSummary(jobId);
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
