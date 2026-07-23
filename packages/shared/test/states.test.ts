import { describe, expect, it } from 'vitest';
import {
  JOB_STATES,
  TRANSITIONS,
  MANUAL_TRANSITIONS,
  canTransition,
  isManualTransitionAllowed,
  isJobState,
} from '../src/states.js';

describe('TRANSITIONS', () => {
  it('definiert Übergänge für jeden Zustand', () => {
    for (const state of JOB_STATES) {
      expect(TRANSITIONS[state]).toBeDefined();
      expect(MANUAL_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('referenziert ausschließlich gültige Zustände', () => {
    for (const targets of [...Object.values(TRANSITIONS), ...Object.values(MANUAL_TRANSITIONS)]) {
      for (const target of targets) {
        expect(isJobState(target)).toBe(true);
      }
    }
  });

  it('done ist terminal', () => {
    expect(TRANSITIONS.done).toHaveLength(0);
    expect(MANUAL_TRANSITIONS.done).toHaveLength(0);
  });

  it('erlaubt den Kernpfad inbox → … → menschliche Übergabe → done', () => {
    const path = [
      'inbox',
      'agent_ready',
      'preflight',
      'planning',
      'implementing',
      'testing',
      'review',
      'ready_for_human',
      'done',
    ] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('erlaubt die Rework-Schleife review → rework → implementing', () => {
    expect(canTransition('review', 'rework')).toBe(true);
    expect(canTransition('rework', 'implementing')).toBe(true);
  });

  it('lehnt offensichtlich ungültige Übergänge ab', () => {
    expect(canTransition('inbox', 'done')).toBe(false);
    expect(canTransition('done', 'inbox')).toBe(false);
    expect(canTransition('planning', 'review')).toBe(false);
  });

  it('manuelle Übergänge sind eine Teilmenge der erlaubten Übergänge', () => {
    for (const state of JOB_STATES) {
      for (const target of MANUAL_TRANSITIONS[state]) {
        expect(TRANSITIONS[state]).toContain(target);
      }
    }
  });

  it('Systemzustände sind manuell nicht verschiebbar', () => {
    expect(isManualTransitionAllowed('planning', 'implementing')).toBe(false);
    expect(isManualTransitionAllowed('testing', 'review')).toBe(false);
    expect(isManualTransitionAllowed('review', 'done')).toBe(false);
  });

  it('inbox → agent_ready ist der manuelle Startübergang', () => {
    expect(isManualTransitionAllowed('inbox', 'agent_ready')).toBe(true);
  });

  it('Diff-Gate: testing → awaiting_diff_approval → agent_ready', () => {
    expect(canTransition('testing', 'awaiting_diff_approval')).toBe(true);
    expect(canTransition('awaiting_diff_approval', 'agent_ready')).toBe(true);
    expect(canTransition('awaiting_diff_approval', 'inbox')).toBe(true);
  });

  it('„Änderungen anfordern": ready_for_human → agent_ready erlaubt, aber nicht manuell', () => {
    expect(canTransition('ready_for_human', 'agent_ready')).toBe(true);
    expect(isManualTransitionAllowed('ready_for_human', 'agent_ready')).toBe(false);
  });

  it('Diff-Gate ist per Board nur nach inbox verschiebbar', () => {
    expect(isManualTransitionAllowed('awaiting_diff_approval', 'inbox')).toBe(true);
    expect(isManualTransitionAllowed('awaiting_diff_approval', 'agent_ready')).toBe(false);
  });
});
