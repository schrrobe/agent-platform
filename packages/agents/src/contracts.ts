import {
  implementationResultSchema,
  planResultSchema,
  reviewResultSchema,
  type ImplementationResult,
  type PlanResult,
  type ReviewResult,
} from '@agent/shared';

interface ContractSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[]; message: string }> };
      };
}

export class AgentContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentContractError';
  }
}

function jsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  if (fenced) return fenced;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function parseContract<T>(label: string, text: string, schema: ContractSchema<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(jsonCandidate(text));
  } catch (error) {
    throw new AgentContractError(
      `${label} ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AgentContractError(`${label} verletzt den Ergebnisvertrag: ${detail}`);
  }
  return parsed.data;
}

export const parsePlanResult = (text: string): PlanResult =>
  parseContract('Plan-Ergebnis', text, planResultSchema);

export const parseImplementationResult = (text: string): ImplementationResult =>
  parseContract('Implementierungs-Ergebnis', text, implementationResultSchema);

export const parseReviewResult = (text: string): ReviewResult =>
  parseContract('Review-Ergebnis', text, reviewResultSchema);

function bullets(items: readonly string[], empty = '(keine)'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

export function renderPlanMarkdown(plan: PlanResult): string {
  return [
    '# Ziel',
    plan.goal,
    '# Akzeptanzkriterien',
    bullets(plan.acceptanceCriteria),
    '# Relevante Dateien',
    bullets(plan.relevantFiles),
    '# Implementierungsschritte',
    plan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n'),
    '# Teststrategie',
    bullets(plan.testStrategy),
    '# Risiken',
    `Risikostufe: **${plan.riskLevel}**`,
    bullets(plan.risks),
    '# Annahmen',
    bullets(plan.assumptions),
    '# Offene Fragen',
    bullets(plan.questions),
    '# Nicht-Ziele',
    bullets(plan.nonGoals),
  ].join('\n\n');
}

export function renderImplementationMarkdown(result: ImplementationResult): string {
  return [
    '# Implementierung',
    result.summary,
    '## Gemeldete Dateien',
    bullets(result.changedFiles),
    '## Planabweichungen',
    bullets(result.planDeviations),
    '## Vom Agenten ausgeführte Prüfungen',
    bullets(result.testsRun),
  ].join('\n\n');
}

export function renderReviewMarkdown(review: ReviewResult): string {
  const findings = review.findings.flatMap((finding, index) => [
    `### Problem ${index + 1}`,
    `- Schweregrad: ${finding.severity}`,
    `- Datei: ${finding.file ?? '—'}`,
    `- Symbol oder Zeile: ${finding.location ?? '—'}`,
    `- Beobachtung: ${finding.observation}`,
    `- Erforderliche Korrektur: ${finding.requiredFix}`,
    `- Empfohlene Verifikation: ${finding.verification}`,
  ]);
  return [
    '# Review-Ergebnis',
    `VERDICT: ${review.verdict}`,
    '## Zusammenfassung',
    review.summary,
    '## Gefundene Probleme',
    ...(findings.length > 0 ? findings : ['(keine)']),
    '## Noch offene Akzeptanzkriterien',
    bullets(review.openAcceptanceCriteria),
  ].join('\n\n');
}
