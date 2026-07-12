import type { AgentName, AgentPhase, AgentRun, RunStatus } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso } from '../util.js';

export interface AgentRunRow {
  id: string;
  job_id: string;
  phase: string;
  agent: string;
  status: string;
  pgid: number | null;
  exit_code: number | null;
  output: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

function mapAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    jobId: row.job_id,
    phase: row.phase as AgentPhase,
    agent: row.agent as AgentName,
    status: row.status as RunStatus,
    exitCode: row.exit_code,
    output: row.output,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface AgentRunPatch {
  status?: RunStatus;
  pgid?: number | null;
  exitCode?: number | null;
  output?: string | null;
  error?: string | null;
  finishedAt?: string | null;
}

export class AgentRunsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: { jobId: string; phase: AgentPhase; agent: AgentName }): AgentRun {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, job_id, phase, agent, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, input.jobId, input.phase, input.agent, nowIso());
    const run = this.get(id);
    if (!run) throw new Error(`AgentRun nach Insert nicht auffindbar: ${id}`);
    return run;
  }

  get(id: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
      AgentRunRow | undefined;
    return row ? mapAgentRun(row) : undefined;
  }

  update(id: string, patch: AgentRunPatch): AgentRun {
    const columns: Record<keyof AgentRunPatch, string> = {
      status: 'status',
      pgid: 'pgid',
      exitCode: 'exit_code',
      output: 'output',
      error: 'error',
      finishedAt: 'finished_at',
    };
    const entries = (Object.entries(patch) as Array<[keyof AgentRunPatch, unknown]>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
      this.db
        .prepare(`UPDATE agent_runs SET ${sets} WHERE id = ?`)
        .run(...entries.map(([, value]) => value), id);
    }
    const run = this.get(id);
    if (!run) throw new Error(`AgentRun nicht gefunden: ${id}`);
    return run;
  }

  listByJob(jobId: string): AgentRun[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_runs WHERE job_id = ? ORDER BY started_at ASC, id ASC')
      .all(jobId) as AgentRunRow[];
    return rows.map(mapAgentRun);
  }

  /** PGIDs laufender Runs — Grundlage der Neustart-Recovery (ADR-009). */
  listRunningPgids(): Array<{ runId: string; jobId: string; pgid: number }> {
    const rows = this.db
      .prepare(
        "SELECT id, job_id, pgid FROM agent_runs WHERE status = 'running' AND pgid IS NOT NULL",
      )
      .all() as Array<{ id: string; job_id: string; pgid: number }>;
    return rows.map((row) => ({ runId: row.id, jobId: row.job_id, pgid: row.pgid }));
  }

  /** Markiert alle laufenden Runs als abgebrochen (Neustart-Recovery). */
  failAllRunning(error: string): number {
    const result = this.db
      .prepare(
        `UPDATE agent_runs SET status = 'canceled', error = ?, finished_at = ?
         WHERE status = 'running'`,
      )
      .run(error, nowIso());
    return result.changes;
  }
}
