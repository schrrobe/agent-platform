import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentExecutionInput,
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from '@agent/shared';
import { ClaudeCodeAdapter } from '../src/adapters/claude.js';
import { CodexCliAdapter } from '../src/adapters/codex.js';
import {
  HERMES_IMPLEMENTATION_TOOLSETS,
  HERMES_INSPECTION_TOOLSETS,
  HermesAdapter,
} from '../src/adapters/hermes.js';
import { buildChildEnv, buildCodexEnv, buildGitEnv, buildTestEnv } from '../src/env.js';

function makeResult(partial: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    canceled: false,
    truncated: false,
    stdout: '',
    stderr: '',
    durationMs: 5,
    ...partial,
  };
}

class RecordingRunner implements ProcessRunner {
  lastSpec: ProcessSpec | undefined;
  constructor(
    private readonly result: ProcessResult | (() => ProcessResult),
    private readonly onRun?: (spec: ProcessSpec) => void,
  ) {}

  run(spec: ProcessSpec): ProcessHandle {
    this.lastSpec = spec;
    this.onRun?.(spec);
    const res = typeof this.result === 'function' ? this.result() : this.result;
    return { pid: 100, pgid: 100, result: Promise.resolve(res), cancel: () => {} };
  }
}

function baseInput(overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return {
    runId: 'run-1',
    jobId: 'job-1',
    phase: 'plan',
    prompt: 'PROMPT-INHALT',
    cwd: '/worktrees/app-123',
    timeoutMs: 60_000,
    maxOutputBytes: 1024,
    ...overrides,
  };
}

describe('ClaudeCodeAdapter', () => {
  it('baut strikt lesende, non-interaktive Argumente', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: '{"result":"PLAN"}' }));
    const adapter = new ClaudeCodeAdapter({
      runner,
      env: {},
      model: 'sonnet',
      effort: 'high',
      maxBudgetUsd: 2,
    });
    await adapter.execute(baseInput());

    const args = runner.lastSpec?.args ?? [];
    expect(args).toContain('-p');
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json']));
    expect(args).toEqual(expect.arrayContaining(['--tools', 'Read,Glob,Grep']));
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--json-schema');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] as string)).toMatchObject({
      type: 'object',
    });
    expect(args).toContain('--no-session-persistence');
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
    expect(args).toEqual(expect.arrayContaining(['--effort', 'high']));
    expect(args).toEqual(expect.arrayContaining(['--max-budget-usd', '2']));
    // Sandbox-Bypass-Flags dürfen NIE vorkommen.
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.at(-1)).toBe('PROMPT-INHALT');
    // Prompt darf niemals über eine Shell laufen.
    expect(runner.lastSpec?.cwd).toBe('/worktrees/app-123');
  });

  it('extrahiert das result-Feld aus JSON-Ausgabe', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: '{"result":"# Ziel\\nPlan"}' }));
    const adapter = new ClaudeCodeAdapter({ runner, env: {} });
    const res = await adapter.execute(baseInput());
    expect(res.status).toBe('completed');
    expect(res.output).toBe('# Ziel\nPlan');
  });

  it('bevorzugt das validierte structured_output-Feld', async () => {
    const runner = new RecordingRunner(
      makeResult({
        stdout: JSON.stringify({
          result: 'Fallback',
          structured_output: { version: 1, goal: 'Strukturiert' },
        }),
      }),
    );
    const result = await new ClaudeCodeAdapter({ runner, env: {} }).execute(baseInput());
    expect(JSON.parse(result.output)).toMatchObject({ version: 1, goal: 'Strukturiert' });
  });

  it('fällt bei Nicht-JSON auf Rohtext zurück und meldet Fehlerstatus', async () => {
    const runner = new RecordingRunner(makeResult({ exitCode: 1, stdout: 'boom', stderr: 'err' }));
    const adapter = new ClaudeCodeAdapter({ runner, env: {} });
    const res = await adapter.execute(baseInput());
    expect(res.status).toBe('failed');
    expect(res.output).toBe('boom');
    expect(res.error).toContain('Exit-Code 1');
  });

  it('mappt Timeout und Cancel auf den Status', async () => {
    const timeoutRunner = new RecordingRunner(makeResult({ timedOut: true, exitCode: null }));
    const t = await new ClaudeCodeAdapter({ runner: timeoutRunner, env: {} }).execute(baseInput());
    expect(t.status).toBe('timeout');

    const cancelRunner = new RecordingRunner(makeResult({ canceled: true, exitCode: null }));
    const c = await new ClaudeCodeAdapter({ runner: cancelRunner, env: {} }).execute(baseInput());
    expect(c.status).toBe('canceled');
  });

  it('reicht eine gekappte Prozessausgabe fail-closed an die Pipeline weiter', async () => {
    const runner = new RecordingRunner(
      makeResult({ stdout: '{"result":"PLAN"}', truncated: true }),
    );
    const result = await new ClaudeCodeAdapter({ runner, env: {} }).execute(baseInput());
    expect(result.truncated).toBe(true);
  });

  it('liest Token-Verbrauch und Kosten aus dem usage-Block', async () => {
    const runner = new RecordingRunner(
      makeResult({
        stdout: JSON.stringify({
          result: 'PLAN',
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 200,
          },
          total_cost_usd: 0.0123,
        }),
      }),
    );
    const result = await new ClaudeCodeAdapter({ runner, env: {} }).execute(baseInput());
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 10,
      cacheReadTokens: 200,
      totalTokens: 350,
      costUsd: 0.0123,
    });
  });

  it('liefert usage=null ohne usage-Block und bei Nicht-JSON', async () => {
    const withoutUsage = new RecordingRunner(makeResult({ stdout: '{"result":"PLAN"}' }));
    expect(
      (await new ClaudeCodeAdapter({ runner: withoutUsage, env: {} }).execute(baseInput())).usage,
    ).toBeNull();

    const plain = new RecordingRunner(makeResult({ stdout: 'kein-json' }));
    expect(
      (await new ClaudeCodeAdapter({ runner: plain, env: {} }).execute(baseInput())).usage,
    ).toBeNull();
  });

  it('erfasst keine usage bei fehlgeschlagenem Lauf', async () => {
    const runner = new RecordingRunner(
      makeResult({ exitCode: 1, stdout: JSON.stringify({ usage: { input_tokens: 5 } }) }),
    );
    const result = await new ClaudeCodeAdapter({ runner, env: {} }).execute(baseInput());
    expect(result.status).toBe('failed');
    expect(result.usage).toBeNull();
  });
});

describe('CodexCliAdapter', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('baut sandbox-begrenzte Argumente mit Worktree-Wurzel', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: 'egal' }));
    const adapter = new CodexCliAdapter({
      runner,
      env: {},
      lastMessageDir: dir,
      model: 'gpt-x',
      reasoningEffort: 'medium',
    });
    await adapter.execute(baseInput({ phase: 'implement' }));

    const args = runner.lastSpec?.args ?? [];
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(args).toEqual(expect.arrayContaining(['-C', '/worktrees/app-123']));
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args).toEqual(expect.arrayContaining(['--color', 'never']));
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-x']));
    expect(args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=medium']));
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
    expect(args.at(-1)).toBe('PROMPT-INHALT');
  });

  it('liest das Ergebnis aus der output-last-message-Datei', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: 'jsonl-rauschen' }), (spec) => {
      const idx = spec.args.indexOf('--output-last-message');
      const file = spec.args[idx + 1] as string;
      fs.writeFileSync(file, 'Habe X implementiert.\n');
    });
    const adapter = new CodexCliAdapter({ runner, env: {}, lastMessageDir: dir });
    const res = await adapter.execute(baseInput({ phase: 'implement' }));
    expect(res.output).toBe('Habe X implementiert.');
  });

  it('fällt ohne Ergebnisdatei auf das Konsolenende zurück', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: 'letzte zeilen der konsole' }));
    const adapter = new CodexCliAdapter({ runner, env: {}, lastMessageDir: dir });
    const res = await adapter.execute(baseInput({ phase: 'implement' }));
    expect(res.output).toContain('letzte zeilen');
  });
});

describe('HermesAdapter', () => {
  it('nutzt isolierten One-shot-Modus mit expliziten Toolsets', async () => {
    const runner = new RecordingRunner(makeResult({ stdout: '{"version":1}\n' }));
    const adapter = new HermesAdapter({
      runner,
      env: { PATH: '/usr/bin', HERMES_IGNORE_RULES: '0' },
      model: 'anthropic/claude-sonnet-4.6',
      provider: 'anthropic',
    });
    const result = await adapter.execute(baseInput());

    expect(runner.lastSpec?.command).toBe('hermes');
    expect(runner.lastSpec?.args).toEqual([
      '--ignore-user-config',
      '--ignore-rules',
      '--model',
      'anthropic/claude-sonnet-4.6',
      '--provider',
      'anthropic',
      '--toolsets',
      HERMES_INSPECTION_TOOLSETS,
      '--oneshot',
      'PROMPT-INHALT',
    ]);
    expect(runner.lastSpec?.args).not.toContain('--yolo');
    expect(runner.lastSpec?.env).toMatchObject({
      PATH: '/usr/bin',
      HERMES_IGNORE_USER_CONFIG: '1',
      HERMES_IGNORE_RULES: '1',
      HERMES_TUI: '0',
    });
    expect(result.output).toBe('{"version":1}');
  });

  it('setzt für Schreibphasen Terminal- und Dateiwerkzeuge fest', async () => {
    const runner = new RecordingRunner(makeResult());
    const adapter = new HermesAdapter({ runner, env: {} });
    await adapter.execute(baseInput({ phase: 'implement' }));

    const args = runner.lastSpec?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(['--toolsets', HERMES_IMPLEMENTATION_TOOLSETS]));
  });

  it('erlaubt phasenspezifische Toolsets, aber nie einen impliziten leeren Wert', async () => {
    const runner = new RecordingRunner(makeResult());
    const adapter = new HermesAdapter({
      runner,
      env: {},
      phaseToolsets: { review: 'context_engine' },
    });
    await adapter.execute(baseInput({ phase: 'review' }));
    expect(runner.lastSpec?.args).toEqual(expect.arrayContaining(['--toolsets', 'context_engine']));

    expect(() => new HermesAdapter({ runner, env: {}, phaseToolsets: { plan: '  ' } })).toThrow(
      /dürfen nicht leer sein/,
    );
  });
});

describe('buildChildEnv', () => {
  it('leitet nur Whitelist-Variablen durch und filtert Secrets', () => {
    const env = buildChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LINEAR_API_KEY: 'geheim',
      AWS_SECRET_ACCESS_KEY: 'geheim2',
      ANTHROPIC_API_KEY: 'sk-ant',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.NO_COLOR).toBe('1');
    expect(env.CI).toBe('1');
    expect(env.LINEAR_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('trennt Codex-, Git- und Test-Credentials strikt', () => {
    const source = {
      PATH: '/usr/bin',
      HOME: '/home/real',
      ANTHROPIC_API_KEY: 'ant',
      OPENAI_API_KEY: 'openai',
      OPENAI_BASE_URL: 'http://127.0.0.1:8799',
      CODEX_HOME: '/home/real/.codex',
    };
    const codex = buildCodexEnv(source);
    expect(codex.OPENAI_API_KEY).toBe('openai');
    // Proxy-Base-URL (z. B. Headroom) wird durchgereicht.
    expect(codex.OPENAI_BASE_URL).toBe('http://127.0.0.1:8799');
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();

    const git = buildGitEnv(source, '/tmp/git-home');
    expect(git.HOME).toBe('/tmp/git-home');
    expect(git.OPENAI_API_KEY).toBeUndefined();
    expect(git.OPENAI_BASE_URL).toBeUndefined();
    expect(git.GIT_CONFIG_NOSYSTEM).toBe('1');

    const tests = buildTestEnv('/tmp/test-home', source);
    expect(tests.HOME).toBe('/tmp/test-home');
    expect(tests.ANTHROPIC_API_KEY).toBeUndefined();
    expect(tests.OPENAI_API_KEY).toBeUndefined();
    expect(tests.OPENAI_BASE_URL).toBeUndefined();
    expect(tests.CODEX_HOME).toBeUndefined();
  });
});
