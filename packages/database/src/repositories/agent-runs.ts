import type {
  AgentName,
  AgentPhase,
  AgentRun,
  AgentTokenUsage,
  JobState,
  JobTokenUsage,
  PhaseTokenUsage,
  RunStatus,
  TokenStats,
  TokenUsageTotals,
} from '@agent/shared';
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
  output_truncated: number;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
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
    outputTruncated: row.output_truncated === 1,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface AgentRunPatch {
  status?: RunStatus;
  pgid?: number | null;
  exitCode?: number | null;
  output?: string | null;
  outputTruncated?: boolean;
  error?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  finishedAt?: string | null;
}

/**
 * SUM-Spalten für Token-Aggregate. Referenziert `agent_runs` als Alias `a`,
 * damit die Fragmente auch in JOIN-Abfragen eindeutig bleiben. NULL-Token-Werte
 * (Läufe ohne Usage-Daten) zählen als 0; `run_count`/`runs_missing_usage`
 * unterscheiden Läufe mit und ohne Usage.
 */
const TOTALS_COLUMNS = `
  SUM(COALESCE(a.input_tokens, 0)) AS input_tokens,
  SUM(COALESCE(a.output_tokens, 0)) AS output_tokens,
  SUM(COALESCE(a.cache_read_tokens, 0)) AS cache_read_tokens,
  SUM(COALESCE(a.cache_creation_tokens, 0)) AS cache_creation_tokens,
  SUM(COALESCE(a.total_tokens, 0)) AS total_tokens,
  SUM(COALESCE(a.cost_usd, 0)) AS cost_usd,
  SUM(CASE WHEN a.total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS run_count,
  SUM(CASE WHEN a.total_tokens IS NULL THEN 1 ELSE 0 END) AS runs_missing_usage
`;

interface TotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  run_count: number | null;
  runs_missing_usage: number | null;
}

function mapTotals(row: TotalsRow): TokenUsageTotals {
  return {
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    costUsd: row.cost_usd ?? 0,
    runCount: row.run_count ?? 0,
    runsMissingUsage: row.runs_missing_usage ?? 0,
  };
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
      outputTruncated: 'output_truncated',
      error: 'error',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      cacheReadTokens: 'cache_read_tokens',
      cacheCreationTokens: 'cache_creation_tokens',
      totalTokens: 'total_tokens',
      costUsd: 'cost_usd',
      finishedAt: 'finished_at',
    };
    const entries = (Object.entries(patch) as Array<[keyof AgentRunPatch, unknown]>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
      this.db
        .prepare(`UPDATE agent_runs SET ${sets} WHERE id = ?`)
        .run(
          ...entries.map(([, value]) => (typeof value === 'boolean' ? (value ? 1 : 0) : value)),
          id,
        );
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

  /**
   * Token-/Kosten-Statistik über alle Agenten-Läufe: Gesamtsumme sowie
   * Aufschlüsselung pro Job (Task), Agent und Phase. Läufe ohne Usage-Daten
   * (Codex/Hermes) fließen mit 0 ein, werden aber in `runsMissingUsage` gezählt.
   */
  tokenStats(): TokenStats {
    const totals = mapTotals(
      this.db.prepare(`SELECT ${TOTALS_COLUMNS} FROM agent_runs a`).get() as TotalsRow,
    );

    const perJobRows = this.db
      .prepare(
        `SELECT j.id AS job_id,
                t.identifier AS ticket_identifier,
                t.title AS ticket_title,
                p.name AS project_name,
                j.state AS state,
                ${TOTALS_COLUMNS}
         FROM agent_runs a
         JOIN jobs j ON j.id = a.job_id
         JOIN tickets t ON t.id = j.ticket_id
         JOIN projects p ON p.id = j.project_id
         GROUP BY j.id
         ORDER BY total_tokens DESC, j.created_at DESC`,
      )
      .all() as Array<
      TotalsRow & {
        job_id: string;
        ticket_identifier: string;
        ticket_title: string;
        project_name: string;
        state: string;
      }
    >;
    const perJob: JobTokenUsage[] = perJobRows.map((row) => ({
      jobId: row.job_id,
      ticketIdentifier: row.ticket_identifier,
      ticketTitle: row.ticket_title,
      projectName: row.project_name,
      state: row.state as JobState,
      totals: mapTotals(row),
    }));

    const perAgentRows = this.db
      .prepare(
        `SELECT a.agent AS agent, ${TOTALS_COLUMNS}
         FROM agent_runs a
         GROUP BY a.agent
         ORDER BY total_tokens DESC`,
      )
      .all() as Array<TotalsRow & { agent: string }>;
    const perAgent: AgentTokenUsage[] = perAgentRows.map((row) => ({
      agent: row.agent as AgentName,
      totals: mapTotals(row),
    }));

    const perPhaseRows = this.db
      .prepare(
        `SELECT a.phase AS phase, ${TOTALS_COLUMNS}
         FROM agent_runs a
         GROUP BY a.phase
         ORDER BY total_tokens DESC`,
      )
      .all() as Array<TotalsRow & { phase: string }>;
    const perPhase: PhaseTokenUsage[] = perPhaseRows.map((row) => ({
      phase: row.phase as AgentPhase,
      totals: mapTotals(row),
    }));

    return { totals, perJob, perAgent, perPhase };
  }
}
