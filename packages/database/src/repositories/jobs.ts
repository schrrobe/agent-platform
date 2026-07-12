import type { AgentName, Job, JobState, JobSummary, PipelinePhase } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso, toBool, toInt } from '../util.js';
import { mapTicket, type TicketRow } from './tickets.js';

export interface JobRow {
  id: string;
  ticket_id: string;
  project_id: string;
  state: string;
  review_loop_count: number;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string;
  base_commit_sha: string | null;
  head_commit_sha: string | null;
  base_stale: number;
  resume_phase: string | null;
  plan_approved_at: string | null;
  current_agent: string | null;
  pause_requested: number;
  active_pgid: number | null;
  deadline_at: string | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectId: row.project_id,
    state: row.state as JobState,
    reviewLoopCount: row.review_loop_count,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommitSha: row.base_commit_sha,
    headCommitSha: row.head_commit_sha,
    baseStale: toBool(row.base_stale),
    resumePhase: row.resume_phase as PipelinePhase | null,
    planApprovedAt: row.plan_approved_at,
    currentAgent: row.current_agent as AgentName | null,
    pauseRequested: toBool(row.pause_requested),
    activePgid: row.active_pgid,
    deadlineAt: row.deadline_at,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface JobCreate {
  ticketId: string;
  projectId: string;
  baseBranch: string;
}

export interface JobPatch {
  state?: JobState;
  reviewLoopCount?: number;
  worktreePath?: string | null;
  branch?: string | null;
  baseCommitSha?: string | null;
  headCommitSha?: string | null;
  baseStale?: boolean;
  resumePhase?: PipelinePhase | null;
  planApprovedAt?: string | null;
  currentAgent?: AgentName | null;
  pauseRequested?: boolean;
  activePgid?: number | null;
  deadlineAt?: string | null;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

const JOB_PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  state: 'state',
  reviewLoopCount: 'review_loop_count',
  worktreePath: 'worktree_path',
  branch: 'branch',
  baseCommitSha: 'base_commit_sha',
  headCommitSha: 'head_commit_sha',
  baseStale: 'base_stale',
  resumePhase: 'resume_phase',
  planApprovedAt: 'plan_approved_at',
  currentAgent: 'current_agent',
  pauseRequested: 'pause_requested',
  activePgid: 'active_pgid',
  deadlineAt: 'deadline_at',
  lastError: 'last_error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

const SUMMARY_SELECT = `
SELECT
  j.id, j.ticket_id, j.project_id, j.state, j.review_loop_count, j.worktree_path, j.branch,
  j.base_branch, j.base_commit_sha, j.head_commit_sha, j.base_stale, j.resume_phase,
  j.plan_approved_at, j.current_agent, j.pause_requested, j.active_pgid, j.deadline_at, j.last_error,
  j.started_at, j.finished_at, j.created_at, j.updated_at,
  t.id AS t_id, t.project_id AS t_project_id, t.linear_issue_id AS t_linear_issue_id,
  t.identifier AS t_identifier, t.title AS t_title, t.description AS t_description,
  t.url AS t_url, t.team_key AS t_team_key, t.team_name AS t_team_name,
  t.priority AS t_priority, t.priority_label AS t_priority_label, t.labels_json AS t_labels_json,
  t.linear_state AS t_linear_state, t.linear_created_at AS t_linear_created_at,
  t.linear_updated_at AS t_linear_updated_at, t.imported_at AS t_imported_at,
  t.updated_at AS t_updated_at,
  p.name AS p_name, p.repository_path AS p_repository_path
FROM jobs j
JOIN tickets t ON t.id = j.ticket_id
JOIN projects p ON p.id = j.project_id`;

type SummaryRow = JobRow & {
  [K in keyof TicketRow as `t_${string & K}`]: TicketRow[K];
} & { p_name: string; p_repository_path: string };

function mapSummary(row: SummaryRow): JobSummary {
  const ticketRow: TicketRow = {
    id: row.t_id,
    project_id: row.t_project_id,
    linear_issue_id: row.t_linear_issue_id,
    identifier: row.t_identifier,
    title: row.t_title,
    description: row.t_description,
    url: row.t_url,
    team_key: row.t_team_key,
    team_name: row.t_team_name,
    priority: row.t_priority,
    priority_label: row.t_priority_label,
    labels_json: row.t_labels_json,
    linear_state: row.t_linear_state,
    linear_created_at: row.t_linear_created_at,
    linear_updated_at: row.t_linear_updated_at,
    imported_at: row.t_imported_at,
    updated_at: row.t_updated_at,
  };
  return {
    ...mapJob(row),
    ticket: mapTicket(ticketRow),
    projectName: row.p_name,
    repositoryPath: row.p_repository_path,
  };
}

export class JobsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: JobCreate): Job {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, ticket_id, project_id, state, base_branch, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?, ?)`,
      )
      .run(id, input.ticketId, input.projectId, input.baseBranch, now, now);
    const job = this.get(id);
    if (!job) throw new Error(`Job nach Insert nicht auffindbar: ${id}`);
    return job;
  }

  get(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  update(id: string, patch: JobPatch): Job {
    const entries = (Object.entries(patch) as Array<[keyof JobPatch, unknown]>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${JOB_PATCH_COLUMNS[key]} = ?`).join(', ');
      const values = entries.map(([, value]) =>
        typeof value === 'boolean' ? toInt(value) : value,
      );
      this.db
        .prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...values, nowIso(), id);
    }
    const job = this.get(id);
    if (!job) throw new Error(`Job nicht gefunden: ${id}`);
    return job;
  }

  listSummaries(): JobSummary[] {
    const rows = this.db
      .prepare(`${SUMMARY_SELECT} ORDER BY j.created_at ASC`)
      .all() as SummaryRow[];
    return rows.map(mapSummary);
  }

  getSummary(id: string): JobSummary | undefined {
    const row = this.db.prepare(`${SUMMARY_SELECT} WHERE j.id = ?`).get(id) as
      SummaryRow | undefined;
    return row ? mapSummary(row) : undefined;
  }

  listByStates(states: readonly JobState[]): Job[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE state IN (${placeholders}) ORDER BY created_at ASC`)
      .all(...states) as JobRow[];
    return rows.map(mapJob);
  }

  listByTicket(ticketId: string): Job[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs WHERE ticket_id = ? ORDER BY created_at ASC')
      .all(ticketId) as JobRow[];
    return rows.map(mapJob);
  }

  findByProjectInStates(projectId: string, states: readonly JobState[]): Job | undefined {
    if (states.length === 0) return undefined;
    const placeholders = states.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE project_id = ? AND state IN (${placeholders}) LIMIT 1`)
      .get(projectId, ...states) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  findByWorktreeInStates(worktreePath: string, states: readonly JobState[]): Job | undefined {
    if (states.length === 0) return undefined;
    const placeholders = states.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE worktree_path = ? AND state IN (${placeholders}) LIMIT 1`)
      .get(worktreePath, ...states) as JobRow | undefined;
    return row ? mapJob(row) : undefined;
  }

  listActivePgids(): Array<{ jobId: string; pgid: number }> {
    const rows = this.db
      .prepare('SELECT id, active_pgid FROM jobs WHERE active_pgid IS NOT NULL')
      .all() as Array<{ id: string; active_pgid: number }>;
    return rows.map((row) => ({ jobId: row.id, pgid: row.active_pgid }));
  }
}
