import type { Logger } from 'pino';
import type { ProcessRunner } from '@agent/shared';
import type { JobState, WorktreeInfo, WorktreeStatus } from '@agent/shared';
import type { Repositories } from '@agent/database';
import { GitService, isPathInside } from '@agent/git';
import type { JobQueue } from '../pipeline/queue.js';

export interface MaintenanceDeps {
  repos: Repositories;
  git: GitService;
  queue: JobQueue;
  runner: ProcessRunner;
  logger: Logger;
}

/** Höchstzahl paralleler `du`-Aufrufe bei der Größenermittlung. */
const SIZE_CONCURRENCY = 4;

export class MaintenanceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'MaintenanceError';
  }
}

export class MaintenanceService {
  constructor(private readonly deps: MaintenanceDeps) {}

  /** Listet alle Worktrees aktiver Projekte samt Status und Disk-Größe. */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const jobs = this.deps.repos.jobs.listSummaries();
    const jobByPath = new Map(jobs.filter((job) => job.worktreePath).map((job) => [job.worktreePath!, job]));
    const knownJobIds = new Set(jobs.map((job) => job.id));

    const infos: WorktreeInfo[] = [];
    for (const project of this.deps.repos.projects.list()) {
      let entries;
      try {
        entries = await this.deps.git.listWorktrees(project.repositoryPath);
      } catch (error) {
        this.deps.logger.warn(
          { err: error, projectId: project.id },
          'Worktrees konnten nicht gelistet werden',
        );
        continue;
      }
      for (const entry of entries) {
        // Haupt-Repo und Fremdpfade außerhalb des Worktree-Roots überspringen.
        if (!isPathInside(project.worktreeRoot, entry.path)) continue;
        const job = jobByPath.get(entry.path);
        const status = this.classify(entry.path, job?.id ?? null, knownJobIds);
        infos.push({
          projectId: project.id,
          projectName: project.name,
          path: entry.path,
          branch: entry.branch,
          sizeKb: null,
          dirty: false,
          status,
          jobId: job?.id ?? null,
          jobState: (job?.state as JobState | undefined) ?? null,
          ticketIdentifier: job?.ticket.identifier ?? null,
        });
      }
    }

    await this.enrich(infos);
    return infos;
  }

  private classify(worktreePath: string, jobId: string | null, knownJobIds: Set<string>): WorktreeStatus {
    if (jobId) {
      const active =
        this.deps.queue.isRunning(jobId) || this.deps.queue.isQueued(jobId);
      return active ? 'active' : 'bound';
    }
    const owner = this.deps.git.readWorktreeOwner(worktreePath);
    if (!owner || !knownJobIds.has(owner.jobId)) return 'orphaned';
    // Owner-Datei verweist auf einen existierenden Job ohne worktreePath-Zuordnung:
    // konservativ als gebunden behandeln, nicht als verwaist löschbar.
    return 'bound';
  }

  private async enrich(infos: WorktreeInfo[]): Promise<void> {
    for (let i = 0; i < infos.length; i += SIZE_CONCURRENCY) {
      const batch = infos.slice(i, i + SIZE_CONCURRENCY);
      await Promise.all(
        batch.map(async (info) => {
          info.sizeKb = await this.diskSizeKb(info.path);
          info.dirty = await this.isDirty(info.path);
        }),
      );
    }
  }

  private async diskSizeKb(worktreePath: string): Promise<number | null> {
    try {
      const result = await this.deps.runner.run({
        command: 'du',
        args: ['-sk', worktreePath],
        cwd: worktreePath,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
      }).result;
      if (result.exitCode !== 0) return null;
      const kb = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? '', 10);
      return Number.isFinite(kb) ? kb : null;
    } catch {
      return null;
    }
  }

  private async isDirty(worktreePath: string): Promise<boolean> {
    try {
      return await this.deps.git.hasUncommittedChanges(worktreePath);
    } catch {
      return false;
    }
  }

  /** Entfernt einen verwaisten Worktree nach frischer Re-Klassifikation. */
  async removeOrphan(projectId: string, worktreePath: string): Promise<void> {
    const project = this.deps.repos.projects.get(projectId);
    if (!project) throw new MaintenanceError('NOT_FOUND', `Projekt nicht gefunden: ${projectId}`);
    const jobs = this.deps.repos.jobs.listSummaries();
    const knownJobIds = new Set(jobs.map((job) => job.id));
    const boundJob = jobs.find((job) => job.worktreePath === worktreePath);
    const status = this.classify(worktreePath, boundJob?.id ?? null, knownJobIds);
    if (status !== 'orphaned') {
      throw new MaintenanceError(
        'CONFLICT',
        `Worktree ist nicht verwaist (Status: ${status}) und kann hier nicht entfernt werden`,
      );
    }
    await this.deps.git.removeUnownedWorktree(project.repositoryPath, worktreePath, {
      worktreeRoot: project.worktreeRoot,
    });
  }
}
