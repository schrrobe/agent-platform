import { describe, expect, it, vi } from 'vitest';
import {
  LinearError,
  LinearService,
  type LinearClientLike,
  type LinearIssueLike,
} from '../src/import.js';

function fakeIssue(overrides: Partial<LinearIssueLike> = {}): LinearIssueLike {
  return {
    id: 'uuid-1',
    identifier: 'APP-123',
    title: 'Button reparieren',
    description: 'Der Button tut nichts.',
    url: 'https://linear.app/demo/issue/APP-123',
    priority: 2,
    priorityLabel: 'High',
    createdAt: new Date('2026-07-01T10:00:00Z'),
    updatedAt: new Date('2026-07-02T10:00:00Z'),
    team: Promise.resolve({ key: 'APP', name: 'App-Team' }),
    state: Promise.resolve({ name: 'Todo' }),
    labels: async () => ({ nodes: [{ name: 'bug' }] }),
    ...overrides,
  };
}

describe('LinearService.fetchTicket', () => {
  it('importiert alle Felder inklusive Team, Status und Labels', async () => {
    const client: LinearClientLike = { issue: vi.fn(async () => fakeIssue()) };
    const service = new LinearService({ client });

    const draft = await service.fetchTicket('APP-123');
    expect(client.issue).toHaveBeenCalledWith('APP-123');
    expect(draft).toEqual({
      linearIssueId: 'uuid-1',
      identifier: 'APP-123',
      title: 'Button reparieren',
      description: 'Der Button tut nichts.',
      url: 'https://linear.app/demo/issue/APP-123',
      teamKey: 'APP',
      teamName: 'App-Team',
      priority: 2,
      priorityLabel: 'High',
      labels: ['bug'],
      linearState: 'Todo',
      linearCreatedAt: '2026-07-01T10:00:00.000Z',
      linearUpdatedAt: '2026-07-02T10:00:00.000Z',
    });
  });

  it('paginiert Labels über fetchNext', async () => {
    const page2 = { nodes: [{ name: 'bug' }, { name: 'ui' }] };
    const page1 = {
      nodes: [{ name: 'bug' }],
      pageInfo: { hasNextPage: true },
      fetchNext: async () => page2,
    };
    const client: LinearClientLike = {
      issue: async () => fakeIssue({ labels: async () => page1 }),
    };
    const service = new LinearService({ client });
    const draft = await service.fetchTicket('APP-123');
    expect(draft.labels).toEqual(['bug', 'ui']);
  });

  it('toleriert fehlende optionale Felder', async () => {
    const client: LinearClientLike = {
      issue: async () =>
        fakeIssue({
          description: undefined,
          priority: undefined,
          priorityLabel: undefined,
          team: undefined,
          state: undefined,
          labels: undefined,
          createdAt: undefined,
          updatedAt: undefined,
        }),
    };
    const service = new LinearService({ client });
    const draft = await service.fetchTicket('APP-123');
    expect(draft.description).toBe('');
    expect(draft.teamKey).toBeNull();
    expect(draft.labels).toEqual([]);
    expect(draft.linearCreatedAt).toBeNull();
  });

  it('lehnt ungültige Identifier ab, ohne Linear zu kontaktieren', async () => {
    const issue = vi.fn();
    const service = new LinearService({ client: { issue } });
    await expect(service.fetchTicket('../etc/passwd')).rejects.toThrow(LinearError);
    expect(issue).not.toHaveBeenCalled();
  });

  it('übersetzt SDK-Fehler in LinearError', async () => {
    const service = new LinearService({
      client: {
        issue: async () => {
          throw new Error('Entity not found');
        },
      },
    });
    await expect(service.fetchTicket('APP-999')).rejects.toThrow(/APP-999/);
  });

  it('wirft verständlich ohne API-Key', async () => {
    const service = new LinearService({});
    await expect(service.fetchTicket('APP-123')).rejects.toThrow(/LINEAR_API_KEY/);
  });
});

describe('LinearService.postComment', () => {
  it('ist standardmäßig deaktiviert und ruft Linear nicht auf', async () => {
    const createComment = vi.fn();
    const service = new LinearService({ client: { issue: vi.fn(), createComment } });
    await expect(service.postComment('uuid-1', 'Hallo')).resolves.toBe('skipped');
    expect(createComment).not.toHaveBeenCalled();
    expect(service.commentsEnabled).toBe(false);
  });

  it('schreibt nur bei explizit aktiviertem Flag', async () => {
    const createComment = vi.fn(async () => ({}));
    const service = new LinearService({
      client: { issue: vi.fn(), createComment },
      writeComments: true,
    });
    await expect(service.postComment('uuid-1', 'Hallo')).resolves.toBe('written');
    expect(createComment).toHaveBeenCalledWith({ issueId: 'uuid-1', body: 'Hallo' });
  });
});

describe('LinearService.updateDescription', () => {
  it('aktualisiert ausschließlich die Beschreibung des angegebenen Tickets', async () => {
    const updateIssue = vi.fn(async () => ({ success: true }));
    const service = new LinearService({ client: { issue: vi.fn(), updateIssue } });

    await service.updateDescription('uuid-1', 'Neue **Beschreibung**');

    expect(updateIssue).toHaveBeenCalledWith('uuid-1', {
      description: 'Neue **Beschreibung**',
    });
  });

  it('übersetzt eine nicht bestätigte Mutation in einen LinearError', async () => {
    const service = new LinearService({
      client: { issue: vi.fn(), updateIssue: vi.fn(async () => ({ success: false })) },
    });
    await expect(service.updateDescription('uuid-1', 'Neu')).rejects.toThrow(LinearError);
  });
});
