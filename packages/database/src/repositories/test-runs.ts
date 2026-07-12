import type { CommandKey, RunStatus, TestRun } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso } from '../util.js';

export interface TestRunRow {
  id: string;
  job_id: string;
  iteration: number;
  command_key: string;
  command: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

function mapTestRun(row: TestRunRow): TestRun {
  return {
    id: row.id,
    jobId: row.job_id,
    iteration: row.iteration,
    commandKey: row.command_key as CommandKey,
    command: row.command,
    status: row.status as RunStatus,
    exitCode: row.exit_code,
    stdout: row.stdout,
    stderr: row.stderr,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface TestRunPatch {
  status?: RunStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number | null;
  finishedAt?: string | null;
}

export class TestRunsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: {
    jobId: string;
    iteration: number;
    commandKey: CommandKey;
    command: string;
  }): TestRun {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO test_runs (id, job_id, iteration, command_key, command, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(id, input.jobId, input.iteration, input.commandKey, input.command, nowIso());
    const run = this.get(id);
    if (!run) throw new Error(`TestRun nach Insert nicht auffindbar: ${id}`);
    return run;
  }

  get(id: string): TestRun | undefined {
    const row = this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as
      TestRunRow | undefined;
    return row ? mapTestRun(row) : undefined;
  }

  update(id: string, patch: TestRunPatch): TestRun {
    const columns: Record<keyof TestRunPatch, string> = {
      status: 'status',
      exitCode: 'exit_code',
      stdout: 'stdout',
      stderr: 'stderr',
      durationMs: 'duration_ms',
      finishedAt: 'finished_at',
    };
    const entries = (Object.entries(patch) as Array<[keyof TestRunPatch, unknown]>).filter(
      ([, value]) => value !== undefined,
    );
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${columns[key]} = ?`).join(', ');
      this.db
        .prepare(`UPDATE test_runs SET ${sets} WHERE id = ?`)
        .run(...entries.map(([, value]) => value), id);
    }
    const run = this.get(id);
    if (!run) throw new Error(`TestRun nicht gefunden: ${id}`);
    return run;
  }

  listByJob(jobId: string): TestRun[] {
    const rows = this.db
      .prepare('SELECT * FROM test_runs WHERE job_id = ? ORDER BY started_at ASC, id ASC')
      .all(jobId) as TestRunRow[];
    return rows.map(mapTestRun);
  }
}
