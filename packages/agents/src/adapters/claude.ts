import type { AgentExecutionInput, AgentUsage, ProcessResult, ProcessRunner } from '@agent/shared';
import {
  IMPLEMENTATION_RESULT_JSON_SCHEMA,
  PLAN_RESULT_JSON_SCHEMA,
  REVIEW_RESULT_JSON_SCHEMA,
} from '@agent/shared';
import { CliAgentAdapter } from './base.js';

export const CLAUDE_READONLY_TOOLS = 'Read,Glob,Grep';
export const CLAUDE_IMPLEMENTATION_TOOLS = 'Read,Glob,Grep,Edit,Write';

export interface ClaudeAdapterOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  bin?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  maxBudgetUsd?: number;
}

/**
 * Claude Code CLI für Plan- und Review-Phasen — strikt lesend:
 * `--tools` entfernt Bash/Edit/Write hart aus dem Toolset, `--permission-mode
 * plan` als zweite Schranke. Verifiziert gegen Claude CLI 2.1.x (ADR-015);
 * `--max-turns` existiert dort nicht mehr, Budget läuft über
 * `--max-budget-usd` plus Wall-Clock-Timeout des Executors.
 * Sandbox-Bypass-Flags (`--dangerously-skip-permissions`) sind tabu.
 */
export class ClaudeCodeAdapter extends CliAgentAdapter {
  readonly name = 'claude';
  private readonly model: string | undefined;
  private readonly effort: 'low' | 'medium' | 'high' | undefined;
  private readonly maxBudgetUsd: number | undefined;

  constructor(options: ClaudeAdapterOptions) {
    super({ runner: options.runner, env: options.env, bin: options.bin ?? 'claude' });
    this.model = options.model;
    this.effort = options.effort;
    this.maxBudgetUsd = options.maxBudgetUsd;
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    const writable = input.phase === 'implement' || input.phase === 'rework';
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      writable ? CLAUDE_IMPLEMENTATION_TOOLS : CLAUDE_READONLY_TOOLS,
      '--permission-mode',
      writable ? 'acceptEdits' : 'plan',
      '--safe-mode',
      '--no-session-persistence',
    ];
    const schema =
      input.phase === 'plan'
        ? PLAN_RESULT_JSON_SCHEMA
        : input.phase === 'review'
          ? REVIEW_RESULT_JSON_SCHEMA
          : IMPLEMENTATION_RESULT_JSON_SCHEMA;
    args.push('--json-schema', JSON.stringify(schema));
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    if (this.maxBudgetUsd != null) args.push('--max-budget-usd', String(this.maxBudgetUsd));
    args.push(input.prompt);
    return args;
  }

  protected override extractOutput(result: ProcessResult): string {
    const trimmed = result.stdout.trim();
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown; structured_output?: unknown };
      if (parsed && parsed.structured_output && typeof parsed.structured_output === 'object') {
        return JSON.stringify(parsed.structured_output);
      }
      if (parsed && typeof parsed.result === 'string') return parsed.result;
    } catch {
      // Kein JSON (z. B. Fehlerausgabe) — Rohtext zurückgeben.
    }
    return trimmed;
  }

  /**
   * Liest den Token-Verbrauch aus dem `usage`-Block der Claude-JSON-Ausgabe
   * (`--output-format json`, ADR-015). Fehlt der Block oder ist die Ausgabe kein
   * JSON, liefert die Methode `null` — der Lauf zählt dann als „ohne Usage-Daten“.
   */
  protected override extractUsage(result: ProcessResult): AgentUsage | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const root = parsed as { usage?: unknown; total_cost_usd?: unknown };
    if (typeof root.usage !== 'object' || root.usage === null) return null;
    const usage = root.usage as Record<string, unknown>;
    const num = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0);
    const inputTokens = num(usage.input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cacheCreationTokens = num(usage.cache_creation_input_tokens);
    const cacheReadTokens = num(usage.cache_read_input_tokens);
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      costUsd: typeof root.total_cost_usd === 'number' ? root.total_cost_usd : null,
    };
  }
}
