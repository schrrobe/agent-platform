import { describe, expect, it } from 'vitest';
import type { Ticket } from '@agent/shared';
import {
  buildImplementPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  ticketBlock,
  ticketBlocks,
} from '../src/prompts.js';

function makeTicket(n: number): Ticket {
  return {
    id: `id-${n}`,
    projectId: 'p1',
    linearIssueId: `lin-${n}`,
    identifier: `APP-${n}`,
    title: `Ticket ${n}`,
    description: `Beschreibung ${n}`,
    url: `https://linear.app/demo/issue/APP-${n}`,
    teamKey: 'APP',
    teamName: 'App-Team',
    priority: 2,
    priorityLabel: 'High',
    labels: ['bug'],
    linearState: 'Todo',
    linearCreatedAt: '2026-07-01T10:00:00.000Z',
    linearUpdatedAt: '2026-07-02T10:00:00.000Z',
    importedAt: '2026-07-03T10:00:00.000Z',
    updatedAt: '2026-07-03T10:00:00.000Z',
  };
}

describe('ticketBlocks', () => {
  it('ist bei genau einem Ticket identisch zu ticketBlock', () => {
    const t = makeTicket(1);
    expect(ticketBlocks([t])).toBe(ticketBlock(t));
  });

  it('rendert bei mehreren Tickets eine Vorgang-Kopfzeile und alle Tickets', () => {
    const out = ticketBlocks([makeTicket(1), makeTicket(2), makeTicket(3)]);
    expect(out).toContain('Dieser Vorgang umfasst 3 zusammengehörige Tickets.');
    expect(out).toContain('APP-1');
    expect(out).toContain('APP-2');
    expect(out).toContain('APP-3');
  });
});

describe('Prompt-Builder mit mehreren Tickets', () => {
  const tickets = [makeTicket(1), makeTicket(2)];

  it('buildPlanPrompt enthält alle Ticket-Identifier', () => {
    const prompt = buildPlanPrompt({ tickets, baseBranch: 'main' });
    expect(prompt).toContain('APP-1');
    expect(prompt).toContain('APP-2');
    expect(prompt).toContain('Dieser Vorgang umfasst 2');
  });

  it('buildImplementPrompt enthält alle Ticket-Identifier', () => {
    const prompt = buildImplementPrompt({ tickets, plan: 'Plan', isRework: false });
    expect(prompt).toContain('APP-1');
    expect(prompt).toContain('APP-2');
  });

  it('buildReviewPrompt enthält alle Ticket-Identifier', () => {
    const prompt = buildReviewPrompt({
      tickets,
      plan: 'Plan',
      diff: 'diff',
      changedFiles: 'file.ts',
      testReport: 'ok',
      implementationSummary: 'done',
      iteration: 1,
    });
    expect(prompt).toContain('APP-1');
    expect(prompt).toContain('APP-2');
  });
});
