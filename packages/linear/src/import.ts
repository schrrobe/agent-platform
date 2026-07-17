import { LinearClient } from '@linear/sdk';
import { IDENTIFIER_RE } from '@agent/shared';

/**
 * Linear liefert Ticketdaten und erlaubt die explizite Aktualisierung einer
 * Beschreibung sowie optionale Kommentare. Statusänderungen finden nie statt.
 * Der Client ist als schmales strukturelles
 * Interface abstrahiert, damit Tests ohne SDK-Mocks auskommen und SDK-Major-
 * Bumps (Linear released aggressiv) nur diese Datei betreffen.
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

export interface LinearClientLike {
  issue(id: string): Promise<LinearIssueLike>;
  createComment?(input: { issueId: string; body: string }): Promise<unknown>;
  updateIssue?(id: string, input: { description: string }): Promise<{ success: boolean }>;
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

export function createLinearClientAdapter(apiKey: string): LinearClientLike {
  const client = new LinearClient({ apiKey });
  return {
    issue: (id: string) => client.issue(id) as unknown as Promise<LinearIssueLike>,
    createComment: (input) => client.createComment(input),
    updateIssue: (id, input) => client.updateIssue(id, input),
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

  /**
   * Optionaler Kommentar nach Linear — nur aktiv, wenn LINEAR_WRITE_COMMENTS=true.
   * Es werden niemals Status, Titel oder andere Felder verändert.
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
