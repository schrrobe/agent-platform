import { describe, expect, it } from 'vitest';
import {
  AgentContractError,
  parseImplementationResult,
  parsePlanResult,
  parseReviewResult,
  renderPlanMarkdown,
} from '../src/contracts.js';

describe('strukturierte Agentenverträge', () => {
  it('validiert und rendert einen Plan', () => {
    const plan = parsePlanResult(
      JSON.stringify({
        version: 1,
        goal: 'Ziel',
        acceptanceCriteria: ['Kriterium'],
        relevantFiles: ['src/a.ts'],
        steps: ['Ändern'],
        testStrategy: ['Testen'],
        risks: [],
        riskLevel: 'low',
        assumptions: [],
        nonGoals: [],
        questions: [],
      }),
    );
    expect(renderPlanMarkdown(plan)).toContain('# Akzeptanzkriterien');
  });

  it('akzeptiert einen JSON-Codeblock, aber keine unvollständigen Verträge', () => {
    expect(
      parseImplementationResult(
        '```json\n{"version":1,"summary":"ok","changedFiles":[],"planDeviations":[],"testsRun":[]}\n```',
      ).summary,
    ).toBe('ok');
    expect(() => parsePlanResult('{"version":1}')).toThrow(AgentContractError);
  });

  it('verweigert PASS mit Findings und FAIL ohne Begründung', () => {
    const passWithFinding = {
      version: 1,
      verdict: 'PASS',
      summary: 'widersprüchlich',
      findings: [
        {
          severity: 'high',
          file: 'a.ts',
          location: null,
          observation: 'x',
          requiredFix: 'y',
          verification: 'z',
        },
      ],
      openAcceptanceCriteria: [],
    };
    expect(() => parseReviewResult(JSON.stringify(passWithFinding))).toThrow(AgentContractError);
    expect(() =>
      parseReviewResult(
        JSON.stringify({
          version: 1,
          verdict: 'FAIL',
          summary: 'ohne Befund',
          findings: [],
          openAcceptanceCriteria: [],
        }),
      ),
    ).toThrow(AgentContractError);
  });
});
