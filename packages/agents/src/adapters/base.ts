import type {
  AgentAdapter,
  AgentExecutionInput,
  AgentExecutionResult,
  AgentName,
  AgentUsage,
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
} from '@agent/shared';

export interface CliAdapterOptions {
  runner: ProcessRunner;
  /** Gefilterte Kind-Umgebung (buildChildEnv). */
  env: Record<string, string>;
  bin: string;
}

/**
 * Gemeinsame Basis der CLI-Adapter: Ausführung über den ProcessRunner,
 * Status-Mapping, Run-Registry für cancel(). Workflow-Entscheidungen finden
 * hier nicht statt — Adapter liefern nur Ergebnisse.
 */
export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly name: AgentName;
  protected readonly running = new Map<string, ProcessHandle>();

  constructor(protected readonly options: CliAdapterOptions) {}

  protected abstract buildArgs(input: AgentExecutionInput): string[];

  protected extractOutput(
    result: ProcessResult,
    _input: AgentExecutionInput,
  ): string | Promise<string> {
    return result.stdout.trim();
  }

  protected async beforeRun(_input: AgentExecutionInput): Promise<void> {
    // Hook für Adapter-Vorbereitung (z. B. Verzeichnisse anlegen).
  }

  /**
   * Extrahiert Token-Verbrauch aus der Roh-Ausgabe. Standard: keine Daten.
   * Adapter mit maschinenlesbarer Usage-Ausgabe (Claude JSON) überschreiben dies.
   */
  protected extractUsage(_result: ProcessResult, _input: AgentExecutionInput): AgentUsage | null {
    return null;
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionResult> {
    await this.beforeRun(input);
    const handle = this.options.runner.run({
      command: this.options.bin,
      args: this.buildArgs(input),
      cwd: input.cwd,
      env: this.options.env,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes,
      onOutput: input.onOutput,
    });
    this.running.set(input.runId, handle);
    input.onSpawned?.(handle.pgid);
    try {
      const result = await handle.result;
      const status: AgentExecutionResult['status'] = result.timedOut
        ? 'timeout'
        : result.canceled
          ? 'canceled'
          : result.exitCode === 0
            ? 'completed'
            : 'failed';
      const output = await this.extractOutput(result, input);
      const usage = status === 'completed' ? this.extractUsage(result, input) : null;
      const error =
        status === 'completed'
          ? null
          : status === 'timeout'
            ? `Zeitlimit von ${Math.round(input.timeoutMs / 1000)} s überschritten`
            : status === 'canceled'
              ? 'Lauf wurde abgebrochen'
              : `Exit-Code ${result.exitCode ?? '(kein)'}: ${result.stderr.trim().slice(0, 800)}`;
      return {
        status,
        exitCode: result.exitCode,
        output,
        rawOutput: result.stdout,
        truncated: result.truncated,
        usage,
        error,
        durationMs: result.durationMs,
      };
    } finally {
      this.running.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.running.get(runId)?.cancel();
  }
}
