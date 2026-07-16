import type { AgentExecutionInput, AgentPhase, ProcessRunner } from '@agent/shared';
import { CliAgentAdapter } from './base.js';

export const HERMES_INSPECTION_TOOLSETS = 'file';
export const HERMES_IMPLEMENTATION_TOOLSETS = 'file,terminal';

const DEFAULT_TOOLSETS: Readonly<Record<AgentPhase, string>> = {
  plan: HERMES_INSPECTION_TOOLSETS,
  implement: HERMES_IMPLEMENTATION_TOOLSETS,
  review: HERMES_INSPECTION_TOOLSETS,
  rework: HERMES_IMPLEMENTATION_TOOLSETS,
  github_review: HERMES_IMPLEMENTATION_TOOLSETS,
};

export interface HermesAdapterOptions {
  runner: ProcessRunner;
  env: Record<string, string>;
  bin?: string;
  model?: string;
  provider?: string;
  /**
   * Explizite Toolsets pro Phase. Hermes-One-shot übernimmt andernfalls die
   * Benutzerkonfiguration, daher setzt der Adapter immer einen festen Wert.
   */
  phaseToolsets?: Partial<Record<AgentPhase, string>>;
}

/**
 * NousResearch Hermes Agent im skriptfähigen One-shot-Modus (`-z`).
 *
 * Hermes liefert dabei ausschließlich die letzte Antwort auf stdout; Timeout,
 * Ausgabelimit und Prozessgruppen-Abbruch bleiben beim ProcessRunner. Persönliche
 * Benutzerkonfiguration und Regeln werden über Umgebung (HERMES_IGNORE_USER_CONFIG,
 * HERMES_IGNORE_RULES) UND CLI-Flags (--ignore-user-config, --ignore-rules)
 * deaktiviert, die interaktive TUI über HERMES_TUI=0.
 *
 * WICHTIG: Hermes `-z` bestätigt Toolaufrufe automatisch. Der Adapter begrenzt
 * deshalb die sichtbaren Toolsets deterministisch, ist selbst aber keine
 * Dateisystem-Sandbox. Schreib-/Leserechte müssen vor einer produktiven
 * Verdrahtung zusätzlich auf OS-Ebene phasenspezifisch begrenzt werden.
 */
export class HermesAdapter extends CliAgentAdapter {
  readonly name = 'hermes';
  private readonly model: string | undefined;
  private readonly provider: string | undefined;
  private readonly phaseToolsets: Readonly<Record<AgentPhase, string>>;

  constructor(options: HermesAdapterOptions) {
    super({
      runner: options.runner,
      env: {
        ...options.env,
        HERMES_IGNORE_USER_CONFIG: '1',
        HERMES_IGNORE_RULES: '1',
        HERMES_TUI: '0',
      },
      bin: options.bin ?? 'hermes',
    });
    this.model = options.model;
    this.provider = options.provider;
    const merged: Record<AgentPhase, string> = { ...DEFAULT_TOOLSETS };
    for (const [phase, toolsets] of Object.entries(options.phaseToolsets ?? {})) {
      if (toolsets !== undefined) merged[phase as AgentPhase] = toolsets;
    }
    this.phaseToolsets = merged;

    for (const [phase, toolsets] of Object.entries(this.phaseToolsets)) {
      if (toolsets.trim().length === 0) {
        throw new Error(`Hermes-Toolsets für Phase '${phase}' dürfen nicht leer sein`);
      }
    }
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    const args = ['--ignore-user-config', '--ignore-rules'];
    if (this.model) args.push('--model', this.model);
    if (this.provider) args.push('--provider', this.provider);
    args.push('--toolsets', this.phaseToolsets[input.phase], '--oneshot', input.prompt);
    return args;
  }
}
