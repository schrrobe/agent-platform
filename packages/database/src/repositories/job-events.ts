import type { JobEvent, JobState } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { nowIso, parseJson } from '../util.js';

export interface JobEventRow {
  id: number;
  job_id: string;
  ts: string;
  type: string;
  from_state: string | null;
  to_state: string | null;
  message: string | null;
  data_json: string | null;
}

function mapEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    ts: row.ts,
    type: row.type,
    fromState: row.from_state as JobState | null,
    toState: row.to_state as JobState | null,
    message: row.message,
    data: parseJson<unknown>(row.data_json, null),
  };
}

export interface JobEventInsert {
  jobId: string;
  type: string;
  fromState?: JobState | null;
  toState?: JobState | null;
  message?: string | null;
  data?: unknown;
}

/** Unveränderliche Workflow-Historie; `id` dient zugleich als WS-Sequenznummer. */
export class JobEventsRepository {
  constructor(private readonly db: AppDatabase) {}

  append(input: JobEventInsert): JobEvent {
    const result = this.db
      .prepare(
        `INSERT INTO job_events (job_id, ts, type, from_state, to_state, message, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.jobId,
        nowIso(),
        input.type,
        input.fromState ?? null,
        input.toState ?? null,
        input.message ?? null,
        input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      );
    const row = this.db
      .prepare('SELECT * FROM job_events WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as JobEventRow;
    return mapEvent(row);
  }

  listByJob(jobId: string, opts: { afterId?: number; limit?: number } = {}): JobEvent[] {
    const limit = opts.limit ?? 1000;
    const afterId = opts.afterId ?? 0;
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(jobId, afterId, limit) as JobEventRow[];
    return rows.map(mapEvent);
  }

  listRecent(limit = 200): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events ORDER BY id DESC LIMIT ?')
      .all(limit) as JobEventRow[];
    return rows.map(mapEvent).reverse();
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(id) AS max_id FROM job_events').get() as {
      max_id: number | null;
    };
    return row.max_id ?? 0;
  }
}
