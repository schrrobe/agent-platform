import { describe, expect, it } from 'vitest';
import { JOB_STATES } from '@agent/shared';
import { COLUMNS, canDropTo, isManualStartTarget } from '@/lib/board';

describe('Board-Spalten', () => {
  it('bilden alle Zustände in fester Reihenfolge ab', () => {
    expect(COLUMNS).toHaveLength(JOB_STATES.length);
    expect(COLUMNS.map((c) => c.state)).toEqual([
      'inbox',
      'agent_ready',
      'preflight',
      'planning',
      'awaiting_plan_approval',
      'implementing',
      'testing',
      'review',
      'rework',
      'needs_human',
      'ready_for_human',
      'done',
      'failed',
      'paused',
    ]);
  });
});

describe('canDropTo', () => {
  it('erlaubt den manuellen Start inbox → agent_ready', () => {
    expect(canDropTo('inbox', 'agent_ready')).toBe(true);
    expect(isManualStartTarget('inbox', 'agent_ready')).toBe(true);
  });

  it('verbietet das Ziehen aus laufenden Systemzuständen', () => {
    for (const from of [
      'preflight',
      'planning',
      'implementing',
      'testing',
      'review',
      'rework',
    ] as const) {
      for (const to of JOB_STATES) {
        expect(canDropTo(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it('erlaubt Retry/Freigabe aus Endzuständen', () => {
    expect(canDropTo('failed', 'agent_ready')).toBe(true);
    expect(canDropTo('needs_human', 'agent_ready')).toBe(true);
    expect(canDropTo('needs_human', 'ready_for_human')).toBe(true);
    expect(canDropTo('paused', 'agent_ready')).toBe(true);
    expect(canDropTo('paused', 'inbox')).toBe(true);
    expect(canDropTo('ready_for_human', 'done')).toBe(true);
  });

  it('verbietet unsinnige Ziele', () => {
    expect(canDropTo('inbox', 'done')).toBe(false);
    expect(canDropTo('inbox', 'inbox')).toBe(false);
    expect(canDropTo('done', 'agent_ready')).toBe(false);
  });
});
