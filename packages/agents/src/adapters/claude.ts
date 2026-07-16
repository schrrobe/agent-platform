import type { AgentExecutionInput, ProcessResult, ProcessRunner } from '@agent/shared';
import { PLAN_RESULT_JSON_SCHEMA, REVIEW_RESULT_JSON_SCHEMA } from '@agent/shared';
import { CliAgentAdapter } from './base.js';

export const CLAUDE_READONLY_TOOLS = 'Read,Glob,Grep';

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
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      CLAUDE_READONLY_TOOLS,
      '--permission-mode',
      'plan',
      '--safe-mode',
      '--no-session-persistence',
    ];
    const schema = input.phase === 'plan' ? PLAN_RESULT_JSON_SCHEMA : REVIEW_RESULT_JSON_SCHEMA;
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
}
