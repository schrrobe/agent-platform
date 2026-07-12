import type { Artifact, ArtifactType } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso } from '../util.js';

export interface ArtifactRow {
  id: string;
  job_id: string;
  agent_run_id: string | null;
  type: string;
  path: string | null;
  content: string;
  created_at: string;
}

function mapArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    jobId: row.job_id,
    agentRunId: row.agent_run_id,
    type: row.type as ArtifactType,
    path: row.path,
    content: row.content,
    createdAt: row.created_at,
  };
}

export class ArtifactsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: {
    jobId: string;
    agentRunId?: string | null;
    type: ArtifactType;
    path?: string | null;
    content: string;
  }): Artifact {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO artifacts (id, job_id, agent_run_id, type, path, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.jobId,
        input.agentRunId ?? null,
        input.type,
        input.path ?? null,
        input.content,
        nowIso(),
      );
    const artifact = this.get(id);
    if (!artifact) throw new Error(`Artefakt nach Insert nicht auffindbar: ${id}`);
    return artifact;
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      ArtifactRow | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  listByJob(jobId: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY created_at ASC, id ASC')
      .all(jobId) as ArtifactRow[];
    return rows.map(mapArtifact);
  }

  latestByType(jobId: string, type: ArtifactType): Artifact | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM artifacts WHERE job_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      )
      .get(jobId, type) as ArtifactRow | undefined;
    return row ? mapArtifact(row) : undefined;
  }
}
