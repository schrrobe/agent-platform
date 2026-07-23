import { LinearClient } from '@linear/sdk';
import { IDENTIFIER_RE } from '@agent/shared';
import type {
  LinearStateSyncConfig,
  LinearSyncEvent,
  LinearWorkflowState,
} from '@agent/shared';

/**
 * Linear liefert Ticketdaten und erlaubt die explizite Aktualisierung von
 * Beschreibung und — nur bei explizit konfiguriertem Projekt-Mapping — dem
 * Workflow-State, sowie optionale Kommentare. Der Client ist als schmales
 * strukturelles Interface abstrahiert, damit Tests ohne SDK-Mocks auskommen und
 * SDK-Major-Bumps (Linear released aggressiv) nur diese Datei betreffen.
 */

export class LinearError extends Error {
  constructor(
    message: string,
    readonly causeMessage?: string,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

export interface LinearLabelConnectionLike {
  nodes: Array<{ name: string }>;
  pageInfo?: { hasNextPage: boolean };
  fetchNext?: () => Promise<LinearLabelConnectionLike>;
}

export interface LinearIssueLike {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority?: number;
  priorityLabel?: string;
  createdAt?: Date;
  updatedAt?: Date;
  team?: Promise<{ key: string; name: string } | undefined>;
  state?: Promise<{ name: string } | undefined>;
  labels?: () => Promise<LinearLabelConnectionLike>;
}

export interface LinearIssueConnectionLike {
  nodes: LinearIssueLike[];
  pageInfo?: { hasNextPage: boolean };
  fetchNext?: () => Promise<LinearIssueConnectionLike>;
}

/** Filter-/Sortieroptionen, wie sie der Linear-Client (bzw. Fake) versteht. */
export interface LinearIssuesQueryLike {
  first?: number;
  filter?: Record<string, unknown>;
  orderBy?: string;
}

export interface LinearClientLike {
  issue(id: string): Promise<LinearIssueLike>;
  issues?(variables?: LinearIssuesQueryLike): Promise<LinearIssueConnectionLike>;
  createComment?(input: { issueId: string; body: string }): Promise<unknown>;
  updateIssue?(
    id: string,
    input: { description?: string; stateId?: string },
  ): Promise<{ success: boolean }>;
  teamStates?(teamKey: string): Promise<LinearWorkflowState[]>;
}

/**
 * Ermittelt den Ziel-State für ein Job-Ereignis. Liefert null, wenn kein Sync
 * konfiguriert ist, der teamKey nicht passt oder das Ereignis nicht gemappt ist.
 */
export function resolveLinearSyncState(
  config: LinearStateSyncConfig | null,
  teamKey: string | null,
  event: LinearSyncEvent,
): string | null {
  if (!config || !teamKey || config.teamKey !== teamKey) return null;
  return config[event];
}

/** Ticketdaten, wie sie lokal gespeichert werden (ohne Projektzuordnung). */
export interface LinearTicketDraft {
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

/** Leichtgewichtige Übersicht eines zugewiesenen Tickets (für die Auswahl-Liste). */
export interface LinearAssignedIssueSummary {
  linearIssueId: string;
  identifier: string;
  title: string;
  url: string;
  teamKey: string | null;
  teamName: string | null;
  priority: number | null;
  priorityLabel: string | null;
  linearState: string | null;
  linearUpdatedAt: string | null;
}

export function createLinearClientAdapter(apiKey: string): LinearClientLike {
  const client = new LinearClient({ apiKey });
  return {
    issue: (id: string) => client.issue(id) as unknown as Promise<LinearIssueLike>,
    issues: (variables) =>
      client.issues(variables as never) as unknown as Promise<LinearIssueConnectionLike>,
    createComment: (input) => client.createComment(input),
    updateIssue: (id, input) => client.updateIssue(id, input),
    teamStates: async (teamKey) => {
      const teams = await client.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      if (!team) return [];
      const states = await team.states();
      return states.nodes.map((state) => ({
        id: state.id,
        name: state.name,
        type: state.type,
        position: state.position,
      }));
    },
  };
}

async function fetchAllLabels(issue: LinearIssueLike): Promise<string[]> {
  if (!issue.labels) return [];
  try {
    let connection = await issue.labels();
    let guard = 0;
    while (connection.pageInfo?.hasNextPage && connection.fetchNext && guard < 20) {
      connection = await connection.fetchNext();
      guard += 1;
    }
    return connection.nodes.map((node) => node.name);
  } catch {
    // Labels sind nicht kritisch für den Import.
    return [];
  }
}

export interface LinearServiceOptions {
  apiKey?: string;
  /** Standard: false — Kommentare nach Linear sind explizit opt-in. */
  writeComments?: boolean;
  /** Testbarkeit: eigener Client statt SDK. */
  client?: LinearClientLike;
}

export class LinearService {
  private readonly client: LinearClientLike | null;
  private readonly writeComments: boolean;

  constructor(options: LinearServiceOptions) {
    this.writeComments = options.writeComments ?? false;
    this.client =
      options.client ?? (options.apiKey ? createLinearClientAdapter(options.apiKey) : null);
  }

  get commentsEnabled(): boolean {
    return this.writeComments;
  }

  private requireClient(): LinearClientLike {
    if (!this.client) {
      throw new LinearError(
        'LINEAR_API_KEY ist nicht konfiguriert — Import aus Linear nicht möglich.',
      );
    }
    return this.client;
  }

  /** Lädt ein Ticket anhand seines Identifiers (z. B. `APP-123`). */
  async fetchTicket(identifier: string): Promise<LinearTicketDraft> {
    const trimmed = identifier.trim();
    if (!IDENTIFIER_RE.test(trimmed)) {
      throw new LinearError(`Ungültiger Linear-Identifier: ${identifier}`);
    }
    const client = this.requireClient();
    let issue: LinearIssueLike | undefined;
    try {
      issue = await client.issue(trimmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(`Linear-Abfrage für ${trimmed} fehlgeschlagen: ${message}`, message);
    }
    if (!issue) {
      throw new LinearError(`Ticket ${trimmed} wurde in Linear nicht gefunden.`);
    }
    const [team, state, labels] = await Promise.all([
      issue.team ?? Promise.resolve(undefined),
      issue.state ?? Promise.resolve(undefined),
      fetchAllLabels(issue),
    ]);
    return {
      linearIssueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? '',
      url: issue.url,
      teamKey: team?.key ?? null,
      teamName: team?.name ?? null,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      labels,
      linearState: state?.name ?? null,
      linearCreatedAt: issue.createdAt?.toISOString() ?? null,
      linearUpdatedAt: issue.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Lädt offene, dem aktuellen API-Token zugewiesene Tickets als Auswahl-Liste.
   * Erledigte und abgebrochene Tickets werden ausgeblendet, sortiert nach letzter Änderung.
   */
  async listAssignedIssues(limit = 50): Promise<LinearAssignedIssueSummary[]> {
    const client = this.requireClient();
    if (!client.issues) {
      throw new LinearError(
        'Der konfigurierte Linear-Client unterstützt keine Ticket-Listen.',
      );
    }
    const capped = Math.max(1, Math.min(Math.trunc(limit), 100));
    let connection: LinearIssueConnectionLike;
    try {
      connection = await client.issues({
        first: capped,
        orderBy: 'updatedAt',
        filter: {
          assignee: { isMe: { eq: true } },
          state: { type: { nin: ['completed', 'canceled'] } },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(`Linear-Abfrage der Ticket-Liste fehlgeschlagen: ${message}`, message);
    }
    const nodes = connection.nodes.slice(0, capped);
    return Promise.all(nodes.map((issue) => this.toAssignedSummary(issue)));
  }

  private async toAssignedSummary(issue: LinearIssueLike): Promise<LinearAssignedIssueSummary> {
    const [team, state] = await Promise.all([
      issue.team ?? Promise.resolve(undefined),
      issue.state ?? Promise.resolve(undefined),
    ]);
    return {
      linearIssueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      teamKey: team?.key ?? null,
      teamName: team?.name ?? null,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      linearState: state?.name ?? null,
      linearUpdatedAt: issue.updatedAt?.toISOString() ?? null,
    };
  }

  /** Aktualisiert ausschließlich die Beschreibung eines bestehenden Linear-Tickets. */
  async updateDescription(linearIssueId: string, description: string): Promise<void> {
    const client = this.requireClient();
    if (!client.updateIssue) {
      throw new LinearError(
        'Der konfigurierte Linear-Client unterstützt keine Ticket-Aktualisierungen.',
      );
    }
    try {
      const result = await client.updateIssue(linearIssueId, { description });
      if (!result.success) {
        throw new Error('Linear hat die Aktualisierung nicht bestätigt');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(
        `Linear-Beschreibung konnte nicht aktualisiert werden: ${message}`,
        message,
      );
    }
  }

  /** Listet die Workflow-States eines Teams (nach Position sortiert), für die Sync-Konfiguration. */
  async listTeamStates(teamKey: string): Promise<LinearWorkflowState[]> {
    const client = this.requireClient();
    if (!client.teamStates) {
      throw new LinearError('Der konfigurierte Linear-Client unterstützt keine Team-States.');
    }
    try {
      const states = await client.teamStates(teamKey);
      return [...states].sort((a, b) => a.position - b.position);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(`Linear-States konnten nicht geladen werden: ${message}`, message);
    }
  }

  /**
   * Setzt den Workflow-State eines Tickets. Nur bei explizit konfiguriertem
   * Projekt-Mapping verwendet (siehe resolveLinearSyncState).
   */
  async updateState(linearIssueId: string, stateId: string): Promise<void> {
    const client = this.requireClient();
    if (!client.updateIssue) {
      throw new LinearError(
        'Der konfigurierte Linear-Client unterstützt keine Ticket-Aktualisierungen.',
      );
    }
    try {
      const result = await client.updateIssue(linearIssueId, { stateId });
      if (!result.success) {
        throw new Error('Linear hat die Statusänderung nicht bestätigt');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(`Linear-Status konnte nicht gesetzt werden: ${message}`, message);
    }
  }

  /**
   * Wendet das konfigurierte Status-Mapping für ein Job-Ereignis an. Liefert true,
   * wenn tatsächlich ein Status gesetzt wurde; wirft bei API-Fehlern (der Aufrufer
   * entscheidet über Logging/Schlucken). Einziger Ort der Sync-Mechanik.
   */
  async syncState(
    config: LinearStateSyncConfig | null,
    teamKey: string | null,
    linearIssueId: string,
    event: LinearSyncEvent,
  ): Promise<boolean> {
    const stateId = resolveLinearSyncState(config, teamKey, event);
    if (!stateId) return false;
    await this.updateState(linearIssueId, stateId);
    return true;
  }

  /**
   * Optionaler Kommentar nach Linear — nur aktiv, wenn LINEAR_WRITE_COMMENTS=true.
   */
  async postComment(linearIssueId: string, body: string): Promise<'written' | 'skipped'> {
    if (!this.writeComments) return 'skipped';
    const client = this.requireClient();
    if (!client.createComment) {
      throw new LinearError('Der konfigurierte Linear-Client unterstützt keine Kommentare.');
    }
    try {
      await client.createComment({ issueId: linearIssueId, body });
      return 'written';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LinearError(`Linear-Kommentar fehlgeschlagen: ${message}`, message);
    }
  }
}
