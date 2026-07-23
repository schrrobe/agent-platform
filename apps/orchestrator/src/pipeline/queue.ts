import type { Logger } from 'pino';
import { compareQueueOrder } from '@agent/shared';
import type { Repositories } from '@agent/database';
import type { AppConfig } from '../config.js';
import type { JobPipeline } from './pipeline.js';
import type { AbortReason } from './errors.js';
import { PipelineAbort } from './errors.js';

interface RunningEntry {
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
  projectId: string;
  kind: 'pipeline' | 'lease';
}

export interface QueueLease {
  signal: AbortSignal;
  release(): void;
}

interface LeaseRequest {
  jobId: string;
  projectId: string;
  resolve: (lease: QueueLease) => void;
  reject: (error: Error) => void;
}

/**
 * Lokale In-Prozess-Job-Queue. Begrenzt die Parallelität (Default 1), erlaubt
 * pro Projekt nur einen laufenden Schreibjob (schützt das geteilte `.git`) und
 * damit auch pro Worktree höchstens einen Job. Neustarts starten Jobs nicht
 * automatisch neu — Retry ist stets explizit (ADR-009).
 */
export class JobQueue {
  private readonly running = new Map<string, RunningEntry>();
  private readonly waiting: string[] = [];
  private readonly rerunRequested = new Set<string>();
  private readonly leaseWaiting: LeaseRequest[] = [];
  private readonly idleWaiters = new Map<string, Set<() => void>>();
  private stopping = false;

  constructor(
    private readonly deps: {
      pipeline: JobPipeline;
      config: AppConfig;
      logger: Logger;
      repos: Repositories;
    },
  ) {}

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  hasLease(jobId: string): boolean {
    return (
      this.running.get(jobId)?.kind === 'lease' ||
      this.leaseWaiting.some((request) => request.jobId === jobId)
    );
  }

  isQueued(jobId: string): boolean {
    return (
      this.running.has(jobId) ||
      this.waiting.includes(jobId) ||
      this.rerunRequested.has(jobId) ||
      this.leaseWaiting.some((request) => request.jobId === jobId)
    );
  }

  /** Reserviert denselben globalen/Projekt-Schreibslot wie ein normaler Pipeline-Job. */
  reserve(jobId: string): Promise<QueueLease> {
    if (this.stopping) return Promise.reject(new Error('Queue wird beendet'));
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return Promise.reject(new Error(`Job nicht gefunden: ${jobId}`));
    if (this.hasLease(jobId)) {
      return Promise.reject(new Error('Für diesen Job läuft bereits eine Queue-Aktion'));
    }
    return new Promise((resolve, reject) => {
      this.leaseWaiting.push({ jobId, projectId: job.projectId, resolve, reject });
      this.pump();
    });
  }

  runningJobIds(): string[] {
    return [...this.running.keys()];
  }

  /** Wartet auf das vollständige Queue-Finally eines Jobs (wichtig nach Terminal-Events). */
  whenIdle(jobId: string): Promise<void> {
    if (!this.isQueued(jobId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.idleWaiters.get(jobId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(jobId, waiters);
    });
  }

  private resolveIdleWaiters(jobId: string): void {
    if (this.isQueued(jobId)) return;
    const waiters = this.idleWaiters.get(jobId);
    if (!waiters) return;
    this.idleWaiters.delete(jobId);
    for (const resolve of waiters) resolve();
  }

  /** Reiht einen Job zur Ausführung ein (idempotent). */
  enqueue(jobId: string): void {
    if (this.stopping) return;
    if (this.running.has(jobId) || this.waiting.includes(jobId)) return;
    this.waiting.push(jobId);
    this.pump();
  }

  /** Plant einen Checkpoint-Fortlauf auch dann, wenn der aktuelle Lauf gerade ausläuft. */
  enqueueAfterCurrent(jobId: string): void {
    if (this.stopping) return;
    if (this.running.has(jobId)) {
      this.rerunRequested.add(jobId);
      return;
    }
    this.enqueue(jobId);
  }

  /** Bricht einen laufenden Job hart ab (Prozessgruppe wird gekillt). */
  cancel(jobId: string): boolean {
    const entry = this.running.get(jobId);
    const idx = this.waiting.indexOf(jobId);
    if (idx >= 0) this.waiting.splice(idx, 1);
    const leaseIdx = this.leaseWaiting.findIndex((request) => request.jobId === jobId);
    if (leaseIdx >= 0) {
      const [request] = this.leaseWaiting.splice(leaseIdx, 1);
      request?.reject(new Error('Vom Benutzer abgebrochen'));
    }
    this.rerunRequested.delete(jobId);
    if (entry) {
      const reason: AbortReason = { type: 'cancel', message: 'Vom Benutzer abgebrochen' };
      entry.controller.abort(reason);
    }
    this.resolveIdleWaiters(jobId);
    return entry != null || idx >= 0 || leaseIdx >= 0;
  }

  private hasProjectConflict(projectId: string): boolean {
    for (const entry of this.running.values()) {
      if (entry.projectId === projectId) return true;
    }
    return false;
  }

  /** Erhöht/senkt die Parallelität zur Laufzeit und füllt frei gewordene Slots sofort. */
  setMaxConcurrent(value: number): void {
    this.deps.config.limits.maxConcurrentJobs = value;
    this.pump();
  }

  private pump(): void {
    if (this.stopping) return;
    if (this.running.size >= this.deps.config.limits.maxConcurrentJobs) return;
    // Wartende Jobs nach Queue-Priorität, manueller Position, Alter — nicht FIFO-Einfügung.
    const candidates = this.waiting
      .map((jobId) => ({ jobId, job: this.deps.repos.jobs.get(jobId) }))
      .filter(
        (entry): entry is { jobId: string; job: NonNullable<typeof entry.job> } =>
          entry.job != null && !this.hasProjectConflict(entry.job.projectId),
      )
      .sort((a, b) => compareQueueOrder(a.job, b.job));
    const idx = candidates.length ? this.waiting.indexOf(candidates[0]!.jobId) : -1;
    if (idx >= 0) {
      const [jobId] = this.waiting.splice(idx, 1);
      if (jobId) this.start(jobId);
    } else {
      const leaseIdx = this.leaseWaiting.findIndex(
        (request) => !this.hasProjectConflict(request.projectId),
      );
      if (leaseIdx < 0) return;
      const [request] = this.leaseWaiting.splice(leaseIdx, 1);
      if (request) this.startLease(request);
    }
    // Weitere Slots füllen, falls Parallelität > 1.
    if (this.running.size < this.deps.config.limits.maxConcurrentJobs) this.pump();
  }

  private startLease(request: LeaseRequest): void {
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => {
      controller.abort({
        type: 'deadline',
        message: `Zeitlimit von ${Math.round(this.deps.config.limits.maxJobRuntimeMs / 60_000)} Minuten überschritten`,
      } satisfies AbortReason);
    }, this.deps.config.limits.maxJobRuntimeMs);
    deadlineTimer.unref?.();
    this.running.set(request.jobId, {
      controller,
      deadlineTimer,
      projectId: request.projectId,
      kind: 'lease',
    });
    let released = false;
    request.resolve({
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        clearTimeout(deadlineTimer);
        this.running.delete(request.jobId);
        this.resolveIdleWaiters(request.jobId);
        this.pump();
      },
    });
  }

  private start(jobId: string): void {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return;
    const controller = new AbortController();
    const now = new Date();
    const deadline = new Date(now.getTime() + this.deps.config.limits.maxJobRuntimeMs);
    this.deps.repos.jobs.update(jobId, {
      startedAt: now.toISOString(),
      deadlineAt: deadline.toISOString(),
      finishedAt: null,
      lastError: null,
    });
    const deadlineTimer = setTimeout(() => {
      controller.abort({
        type: 'deadline',
        message: `Zeitlimit von ${Math.round(this.deps.config.limits.maxJobRuntimeMs / 60_000)} Minuten überschritten`,
      } satisfies AbortReason);
    }, this.deps.config.limits.maxJobRuntimeMs);
    deadlineTimer.unref?.();

    this.running.set(jobId, {
      controller,
      deadlineTimer,
      projectId: job.projectId,
      kind: 'pipeline',
    });
    const log = this.deps.logger.child({ jobId });
    log.info('Job gestartet');

    void this.deps.pipeline
      .run(jobId, controller.signal)
      .catch(async (error) => {
        const message =
          error instanceof PipelineAbort
            ? error.reason.message
            : error instanceof Error
              ? error.message
              : String(error);
        await this.deps.pipeline.abortToFailed(jobId, message);
      })
      .finally(() => {
        clearTimeout(deadlineTimer);
        this.running.delete(jobId);
        if (this.rerunRequested.delete(jobId) && !this.waiting.includes(jobId)) {
          this.waiting.push(jobId);
        }
        this.resolveIdleWaiters(jobId);
        log.info('Job beendet');
        this.pump();
      });
  }

  /** Bei Shutdown: alle laufenden Jobs abbrechen. */
  abortAll(reason: string): void {
    this.stopping = true;
    const noLongerQueued = new Set([
      ...this.waiting,
      ...this.rerunRequested,
      ...this.leaseWaiting.map((request) => request.jobId),
    ]);
    this.waiting.length = 0;
    this.rerunRequested.clear();
    for (const request of this.leaseWaiting.splice(0)) {
      request.reject(new Error(reason));
    }
    for (const jobId of noLongerQueued) this.resolveIdleWaiters(jobId);
    for (const entry of this.running.values()) {
      entry.controller.abort({ type: 'cancel', message: reason } satisfies AbortReason);
    }
  }
}
