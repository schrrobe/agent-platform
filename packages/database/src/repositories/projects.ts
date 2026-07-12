import type { Project, ProjectCommands } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso, parseJson, toBool, toInt } from '../util.js';

export interface ProjectRow {
  id: string;
  name: string;
  repository_path: string;
  base_branch: string;
  worktree_root: string;
  commands_json: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repository_path,
    baseBranch: row.base_branch,
    worktreeRoot: row.worktree_root,
    commands: parseJson<ProjectCommands>(row.commands_json, {}),
    active: toBool(row.active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ProjectCreate {
  name: string;
  repositoryPath: string;
  baseBranch: string;
  worktreeRoot: string;
  commands: ProjectCommands;
  active: boolean;
}

export type ProjectPatch = Partial<ProjectCreate>;

export class ProjectsRepository {
  constructor(private readonly db: AppDatabase) {}

  insert(input: ProjectCreate): Project {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects
          (id, name, repository_path, base_branch, worktree_root, commands_json, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.repositoryPath,
        input.baseBranch,
        input.worktreeRoot,
        JSON.stringify(input.commands),
        toInt(input.active),
        now,
        now,
      );
    const project = this.get(id);
    if (!project) throw new Error(`Projekt nach Insert nicht auffindbar: ${id}`);
    return project;
  }

  update(id: string, patch: ProjectPatch): Project {
    const current = this.get(id);
    if (!current) throw new Error(`Projekt nicht gefunden: ${id}`);
    const merged: ProjectCreate = {
      name: patch.name ?? current.name,
      repositoryPath: patch.repositoryPath ?? current.repositoryPath,
      baseBranch: patch.baseBranch ?? current.baseBranch,
      worktreeRoot: patch.worktreeRoot ?? current.worktreeRoot,
      commands: patch.commands ?? current.commands,
      active: patch.active ?? current.active,
    };
    this.db
      .prepare(
        `UPDATE projects SET name = ?, repository_path = ?, base_branch = ?, worktree_root = ?,
          commands_json = ?, active = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.repositoryPath,
        merged.baseBranch,
        merged.worktreeRoot,
        JSON.stringify(merged.commands),
        toInt(merged.active),
        nowIso(),
        id,
      );
    const project = this.get(id);
    if (!project) throw new Error(`Projekt nicht gefunden: ${id}`);
    return project;
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? mapProject(row) : undefined;
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC')
      .all() as ProjectRow[];
    return rows.map(mapProject);
  }

  /** Wirft bei Fremdschlüssel-Verletzung (Projekt hat Tickets/Jobs). */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return result.changes > 0;
  }
}
