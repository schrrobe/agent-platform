import type { Logger } from 'pino';
import type { Repositories } from '@agent/database';
import type { AppConfig } from '../config.js';
import type { JobPipeline } from './pipeline.js';
import type { AbortReason } from './errors.js';
import { PipelineAbort } from './errors.js';

interface RunningEntry {
  controller: AbortController;
  deadlineTimer: NodeJS.Timeout;
  projectId: string;
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

  isQueued(jobId: string): boolean {
    return (
      this.running.has(jobId) || this.waiting.includes(jobId) || this.rerunRequested.has(jobId)
    );
  }

  runningJobIds(): string[] {
    return [...this.running.keys()];
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
    if (!entry) {
      // Noch nicht gestartet: aus der Warteschlange nehmen.
      const idx = this.waiting.indexOf(jobId);
      if (idx >= 0) this.waiting.splice(idx, 1);
      this.rerunRequested.delete(jobId);
      return idx >= 0;
    }
    this.rerunRequested.delete(jobId);
    const reason: AbortReason = { type: 'cancel', message: 'Vom Benutzer abgebrochen' };
    entry.controller.abort(reason);
    return true;
  }

  private hasProjectConflict(projectId: string): boolean {
    for (const entry of this.running.values()) {
      if (entry.projectId === projectId) return true;
    }
    return false;
  }

  private pump(): void {
    if (this.stopping) return;
    if (this.running.size >= this.deps.config.limits.maxConcurrentJobs) return;
    const idx = this.waiting.findIndex((jobId) => {
      const job = this.deps.repos.jobs.get(jobId);
      return job != null && !this.hasProjectConflict(job.projectId);
    });
    if (idx < 0) return;
    const [jobId] = this.waiting.splice(idx, 1);
    if (jobId) this.start(jobId);
    // Weitere Slots füllen, falls Parallelität > 1.
    if (this.running.size < this.deps.config.limits.maxConcurrentJobs) this.pump();
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

    this.running.set(jobId, { controller, deadlineTimer, projectId: job.projectId });
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
        log.info('Job beendet');
        this.pump();
      });
  }

  /** Bei Shutdown: alle laufenden Jobs abbrechen. */
  abortAll(reason: string): void {
    this.stopping = true;
    this.waiting.length = 0;
    this.rerunRequested.clear();
    for (const entry of this.running.values()) {
      entry.controller.abort({ type: 'cancel', message: reason } satisfies AbortReason);
    }
  }
}
