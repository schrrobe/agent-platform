import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentExecutionInput, ProcessResult, ProcessRunner } from '@agent/shared';
import { CliAgentAdapter } from './base.js';

export interface CodexAdapterOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  bin?: string;
  model?: string;
  /** Verzeichnis für `--output-last-message`-Dateien (außerhalb der Worktrees). */
  lastMessageDir: string;
}

/**
 * Codex CLI für Implementierungs- und Rework-Phasen. Sandbox: workspace-write,
 * begrenzt auf den Worktree (`-C`); Netzwerk bleibt deaktiviert (Default) und
 * `--ignore-user-config` verhindert, dass Nutzer-Konfiguration es re-aktiviert.
 * `--ephemeral` verhindert Session-Persistenz. `codex exec` fragt nie
 * interaktiv nach — Bypass-Flags wie `--dangerously-bypass-approvals-and-sandbox`
 * werden nie verwendet (ADR-015). Das Endergebnis kommt zuverlässig über
 * `--output-last-message` statt über fragiles JSONL-Parsing.
 */
export class CodexCliAdapter extends CliAgentAdapter {
  readonly name = 'codex';
  private readonly model: string | undefined;
  private readonly lastMessageDir: string;

  constructor(options: CodexAdapterOptions) {
    super({ runner: options.runner, env: options.env, bin: options.bin ?? 'codex' });
    this.model = options.model;
    this.lastMessageDir = options.lastMessageDir;
  }

  private lastMessageFile(runId: string): string {
    return path.join(this.lastMessageDir, `${runId}.last-message.txt`);
  }

  protected override async beforeRun(): Promise<void> {
    await fs.mkdir(this.lastMessageDir, { recursive: true });
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    const args = [
      'exec',
      '--sandbox',
      'workspace-write',
      '-C',
      input.cwd,
      '--ephemeral',
      '--ignore-user-config',
      '--color',
      'never',
      '--output-last-message',
      this.lastMessageFile(input.runId),
    ];
    if (this.model) args.push('-m', this.model);
    args.push(input.prompt);
    return args;
  }

  protected override async extractOutput(
    result: ProcessResult,
    input: AgentExecutionInput,
  ): Promise<string> {
    const file = this.lastMessageFile(input.runId);
    try {
      const text = await fs.readFile(file, 'utf8');
      await fs.rm(file, { force: true });
      if (text.trim().length > 0) return text.trim();
    } catch {
      // Datei fehlt (Abbruch/alte CLI) — Fallback auf Konsolenende.
    }
    return result.stdout.trim().slice(-4000);
  }
}
