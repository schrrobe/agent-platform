import type { ReviewIteration, ReviewVerdict } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso } from '../util.js';

export interface ReviewIterationRow {
  id: string;
  job_id: string;
  iteration: number;
  verdict: string;
  artifact_id: string | null;
  created_at: string;
}

function mapReviewIteration(row: ReviewIterationRow): ReviewIteration {
  return {
    id: row.id,
    jobId: row.job_id,
    iteration: row.iteration,
    verdict: row.verdict as ReviewVerdict,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
  };
}

export class ReviewIterationsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: {
    jobId: string;
    iteration: number;
    verdict: ReviewVerdict;
    artifactId?: string | null;
  }): ReviewIteration {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO review_iterations (id, job_id, iteration, verdict, artifact_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.jobId, input.iteration, input.verdict, input.artifactId ?? null, nowIso());
    const row = this.db.prepare('SELECT * FROM review_iterations WHERE id = ?').get(
      id,
    ) as ReviewIterationRow;
    return mapReviewIteration(row);
  }

  listByJob(jobId: string): ReviewIteration[] {
    const rows = this.db
      .prepare('SELECT * FROM review_iterations WHERE job_id = ? ORDER BY iteration ASC, id ASC')
      .all(jobId) as ReviewIterationRow[];
    return rows.map(mapReviewIteration);
  }
}
