import type { AgentExecutionInput, ProcessResult, ProcessRunner } from '@agent/shared';
import { CliAgentAdapter } from './base.js';

export const CLAUDE_READONLY_TOOLS = 'Read,Glob,Grep';

export interface ClaudeAdapterOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  bin?: string;
  model?: string;
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
  private readonly maxBudgetUsd: number | undefined;

  constructor(options: ClaudeAdapterOptions) {
    super({ runner: options.runner, env: options.env, bin: options.bin ?? 'claude' });
    this.model = options.model;
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
      '--no-session-persistence',
    ];
    if (this.model) args.push('--model', this.model);
    if (this.maxBudgetUsd != null) args.push('--max-budget-usd', String(this.maxBudgetUsd));
    args.push(input.prompt);
    return args;
  }

  protected override extractOutput(result: ProcessResult): string {
    const trimmed = result.stdout.trim();
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown };
      if (parsed && typeof parsed.result === 'string') return parsed.result;
    } catch {
      // Kein JSON (z. B. Fehlerausgabe) — Rohtext zurückgeben.
    }
    return trimmed;
  }
}
