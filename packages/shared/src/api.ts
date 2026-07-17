import type { AgentName, AgentPhase } from './types.js';
import type { JobState } from './states.js';

/** Aggregierte Token-/Kostensumme über eine Menge von Agenten-Läufen. */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Läufe mit Usage-Daten. */
  runCount: number;
  /** Läufe ohne Usage-Daten (z. B. Codex/Hermes) — für Vollständigkeitshinweis. */
  runsMissingUsage: number;
}

/** Token-Verbrauch pro Job (Task) inkl. Ticket-Kontext für die Beschriftung. */
export interface JobTokenUsage {
  jobId: string;
  ticketIdentifier: string;
  ticketTitle: string;
  projectName: string;
  state: JobState;
  totals: TokenUsageTotals;
}

export interface AgentTokenUsage {
  agent: AgentName;
  totals: TokenUsageTotals;
}

export interface PhaseTokenUsage {
  phase: AgentPhase;
  totals: TokenUsageTotals;
}

/** Antwort von `GET /api/stats/tokens`. */
export interface TokenStats {
  totals: TokenUsageTotals;
  /** Nach Gesamt-Token absteigend sortiert. */
  perJob: JobTokenUsage[];
  perAgent: AgentTokenUsage[];
  perPhase: PhaseTokenUsage[];
}

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'CONFLICT',
  'LINEAR_ERROR',
  'GITHUB_ERROR',
  'AGENT_ERROR',
  'INTERNAL',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as Record<string, unknown>;
  return (
    typeof code === 'string' &&
    (API_ERROR_CODES as readonly string[]).includes(code) &&
    typeof message === 'string'
  );
}
