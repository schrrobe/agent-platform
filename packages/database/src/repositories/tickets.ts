import type { Ticket } from '@agent/shared';
import type { AppDatabase } from '../db.js';
import { newId, nowIso, parseJson } from '../util.js';

export interface TicketRow {
  id: string;
  project_id: string;
  linear_issue_id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  team_key: string | null;
  team_name: string | null;
  priority: number | null;
  priority_label: string | null;
  labels_json: string;
  linear_state: string | null;
  linear_created_at: string | null;
  linear_updated_at: string | null;
  imported_at: string;
  updated_at: string;
}

export function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    projectId: row.project_id,
    linearIssueId: row.linear_issue_id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    url: row.url,
    teamKey: row.team_key,
    teamName: row.team_name,
    priority: row.priority,
    priorityLabel: row.priority_label,
    labels: parseJson<string[]>(row.labels_json, []),
    linearState: row.linear_state,
    linearCreatedAt: row.linear_created_at,
    linearUpdatedAt: row.linear_updated_at,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

export interface TicketUpsert {
  projectId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamKey: string | null;
  teamName: string | null;
  priority: number | null;
  priorityLabel: string | null;
  labels: string[];
  linearState: string | null;
  linearCreatedAt: string | null;
  linearUpdatedAt: string | null;
}

export class TicketsRepository {
  constructor(private readonly db: AppDatabase) {}

  /** Insert oder Update anhand der Linear-Issue-UUID (Re-Import aktualisiert). */
  upsert(input: TicketUpsert): Ticket {
    const existing = this.getByLinearIssueId(input.linearIssueId);
    const now = nowIso();
    if (existing) {
      this.db
        .prepare(
          `UPDATE tickets SET project_id = ?, identifier = ?, title = ?, description = ?, url = ?,
            team_key = ?, team_name = ?, priority = ?, priority_label = ?, labels_json = ?,
            linear_state = ?, linear_created_at = ?, linear_updated_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.projectId,
          input.identifier,
          input.title,
          input.description,
          input.url,
          input.teamKey,
          input.teamName,
          input.priority,
          input.priorityLabel,
          JSON.stringify(input.labels),
          input.linearState,
          input.linearCreatedAt,
          input.linearUpdatedAt,
          now,
          existing.id,
        );
      const updated = this.get(existing.id);
      if (!updated) throw new Error(`Ticket nach Update nicht auffindbar: ${existing.id}`);
      return updated;
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO tickets
          (id, project_id, linear_issue_id, identifier, title, description, url, team_key, team_name,
           priority, priority_label, labels_json, linear_state, linear_created_at, linear_updated_at,
           imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.linearIssueId,
        input.identifier,
        input.title,
        input.description,
        input.url,
        input.teamKey,
        input.teamName,
        input.priority,
        input.priorityLabel,
        JSON.stringify(input.labels),
        input.linearState,
        input.linearCreatedAt,
        input.linearUpdatedAt,
        now,
        now,
      );
    const ticket = this.get(id);
    if (!ticket) throw new Error(`Ticket nach Insert nicht auffindbar: ${id}`);
    return ticket;
  }

  get(id: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
      TicketRow | undefined;
    return row ? mapTicket(row) : undefined;
  }

  getByLinearIssueId(linearIssueId: string): Ticket | undefined {
    const row = this.db
      .prepare('SELECT * FROM tickets WHERE linear_issue_id = ?')
      .get(linearIssueId) as TicketRow | undefined;
    return row ? mapTicket(row) : undefined;
  }

  getByIdentifier(identifier: string): Ticket | undefined {
    const row = this.db
      .prepare('SELECT * FROM tickets WHERE identifier = ? COLLATE NOCASE')
      .get(identifier) as TicketRow | undefined;
    return row ? mapTicket(row) : undefined;
  }

  list(): Ticket[] {
    const rows = this.db
      .prepare('SELECT * FROM tickets ORDER BY imported_at ASC')
      .all() as TicketRow[];
    return rows.map(mapTicket);
  }
}
