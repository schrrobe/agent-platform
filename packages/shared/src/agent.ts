import type { AgentPhase } from './types.js';
import type { ProcessOutputChunk } from './process.js';

export interface AgentExecutionInput {
  /** Eindeutige Run-ID (agent_runs.id) — dient auch zum Abbrechen. */
  runId: string;
  jobId: string;
  phase: AgentPhase;
  prompt: string;
  /** Arbeitsverzeichnis des Agenten (immer der Job-Worktree). */
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onOutput?: (chunk: ProcessOutputChunk) => void;
  /** Meldet die Prozessgruppen-ID nach dem Spawn (für Recovery-Persistenz). */
  onSpawned?: (pgid: number | undefined) => void;
}

export interface AgentExecutionResult {
  status: 'completed' | 'failed' | 'timeout' | 'canceled';
  exitCode: number | null;
  /** Extrahiertes Endergebnis (Claude: result-Feld; Codex: letzte Agent-Message). */
  output: string;
  /** Roh-Ausgabe (gekappt) für Diagnose. */
  rawOutput: string;
  error: string | null;
  durationMs: number;
}

/**
 * Abstraktion über konkrete Agenten-CLIs. Adapter führen aus und liefern
 * Ergebnisse — Workflow-Entscheidungen (Zustände, Limits, Merges) trifft
 * ausschließlich die Workflow-Engine. Vorbereitet für eine spätere
 * Hermes-Delegationsschicht als dritten Adapter.
 */
export interface AgentAdapter {
  name: string;
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
  cancel(runId: string): Promise<void>;
}
