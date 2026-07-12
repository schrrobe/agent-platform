import { describe, expect, it } from 'vitest';
import { JOB_STATES, TRANSITIONS } from '@agent/shared';
import {
  InvalidTransitionError,
  assertManualTransition,
  assertTransition,
  decideAfterFailedTests,
  decideAfterReview,
} from '../src/state-machine.js';

describe('assertTransition', () => {
  it('lässt alle Übergänge der Transitions-Map zu', () => {
    for (const from of JOB_STATES) {
      for (const to of TRANSITIONS[from]) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('wirft für jeden nicht gelisteten Übergang', () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        if (!TRANSITIONS[from].includes(to)) {
          expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
        }
      }
    }
  });
});

describe('assertManualTransition', () => {
  it('erlaubt den manuellen Start inbox → agent_ready', () => {
    expect(() => assertManualTransition('inbox', 'agent_ready')).not.toThrow();
  });

  it('erlaubt Retry und Freigabe aus failed/needs_human/paused', () => {
    expect(() => assertManualTransition('failed', 'agent_ready')).not.toThrow();
    expect(() => assertManualTransition('needs_human', 'agent_ready')).not.toThrow();
    expect(() => assertManualTransition('needs_human', 'done')).not.toThrow();
    expect(() => assertManualTransition('paused', 'agent_ready')).not.toThrow();
    expect(() => assertManualTransition('paused', 'inbox')).not.toThrow();
  });

  it('verbietet manuelle Eingriffe in Systemzustände', () => {
    expect(() => assertManualTransition('planning', 'implementing')).toThrow(
      InvalidTransitionError,
    );
    expect(() => assertManualTransition('testing', 'review')).toThrow(InvalidTransitionError);
    expect(() => assertManualTransition('review', 'done')).toThrow(InvalidTransitionError);
    expect(() => assertManualTransition('inbox', 'done')).toThrow(InvalidTransitionError);
  });
});

describe('decideAfterReview', () => {
  it('PASS führt unabhängig vom Zähler zu done', () => {
    expect(decideAfterReview('PASS', { reviewLoopCount: 0, maxReviewLoops: 3 })).toBe('done');
    expect(decideAfterReview('PASS', { reviewLoopCount: 3, maxReviewLoops: 3 })).toBe('done');
  });

  it('FAIL mit Budget führt zu rework', () => {
    expect(decideAfterReview('FAIL', { reviewLoopCount: 0, maxReviewLoops: 3 })).toBe('rework');
    expect(decideAfterReview('FAIL', { reviewLoopCount: 2, maxReviewLoops: 3 })).toBe('rework');
  });

  it('FAIL am Limit eskaliert zu needs_human (Default 3 Schleifen)', () => {
    expect(decideAfterReview('FAIL', { reviewLoopCount: 3, maxReviewLoops: 3 })).toBe(
      'needs_human',
    );
    expect(decideAfterReview('FAIL', { reviewLoopCount: 5, maxReviewLoops: 3 })).toBe(
      'needs_human',
    );
  });

  it('respektiert konfigurierbare Limits', () => {
    expect(decideAfterReview('FAIL', { reviewLoopCount: 0, maxReviewLoops: 0 })).toBe(
      'needs_human',
    );
    expect(decideAfterReview('FAIL', { reviewLoopCount: 4, maxReviewLoops: 5 })).toBe('rework');
  });
});

describe('decideAfterFailedTests', () => {
  it('nutzt dasselbe Schleifenbudget wie das Review', () => {
    expect(decideAfterFailedTests({ reviewLoopCount: 0, maxReviewLoops: 3 })).toBe('rework');
    expect(decideAfterFailedTests({ reviewLoopCount: 3, maxReviewLoops: 3 })).toBe('needs_human');
  });
});
