import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ProcessHandle,
  ProcessOutputChunk,
  ProcessRunner,
  TestExecutionMode,
} from '@agent/shared';
import { buildTestEnv } from '@agent/agents';
import { jobSuffix } from '@agent/git';

export interface TestSandboxOptions {
  runner: ProcessRunner;
  dataDir: string;
  srtBin: string;
  sourceEnv?: NodeJS.ProcessEnv;
}

export interface TestCommandInput {
  jobId: string;
  mode: TestExecutionMode;
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  onOutput?: (chunk: ProcessOutputChunk) => void;
}

/**
 * Führt Projektcode mit einer credential-freien Umgebung aus. Im Defaultmodus
 * kapselt Anthropic Sandbox Runtime (macOS: sandbox-exec, Linux: bubblewrap)
 * den Prozess zusätzlich auf Betriebssystemebene ein und sperrt Netzwerkzugriff.
 */
export class TestSandbox {
  private readonly sourceEnv: NodeJS.ProcessEnv;

  constructor(private readonly options: TestSandboxOptions) {
    this.sourceEnv = options.sourceEnv ?? process.env;
  }

  private root(jobId: string): string {
    return path.join(this.options.dataDir, 'test-sandboxes', jobId);
  }

  private runtimeTemp(jobId: string): string {
    const systemTemp = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    return path.join(systemTemp, 'agent-platform-srt', jobSuffix(jobId));
  }

  private withCleanup(handle: ProcessHandle, runtimeTemp: string): ProcessHandle {
    return {
      ...handle,
      result: handle.result.finally(async () => {
        await fs.rm(runtimeTemp, { recursive: true, force: true });
      }),
    };
  }

  async cleanup(jobId: string): Promise<void> {
    await Promise.all([
      fs.rm(this.root(jobId), { recursive: true, force: true }),
      fs.rm(this.runtimeTemp(jobId), { recursive: true, force: true }),
    ]);
  }

  private sensitiveReadPaths(): string[] {
    const home = this.sourceEnv.HOME;
    const candidates = [
      this.sourceEnv.CLAUDE_CONFIG_DIR,
      this.sourceEnv.CODEX_HOME,
      ...(home
        ? [
            '.ssh',
            '.aws',
            '.gnupg',
            '.kube',
            '.docker',
            '.codex',
            '.claude',
            '.npmrc',
            '.netrc',
            '.git-credentials',
            '.config/gh',
            '.config/gcloud',
            '.config/op',
          ].map((entry) => path.join(home, entry))
        : []),
    ];
    return [...new Set(candidates.filter((entry): entry is string => Boolean(entry)))].filter(
      (entry) => fsSync.existsSync(entry),
    );
  }

  async run(input: TestCommandInput): Promise<{ handle: ProcessHandle; sandboxed: boolean }> {
    const root = this.root(input.jobId);
    const home = path.join(root, 'home');
    const temp = this.runtimeTemp(input.jobId);
    await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(temp, { recursive: true })]);
    const env = buildTestEnv(home, this.sourceEnv);
    env.TMPDIR = temp;

    if (input.mode === 'trusted') {
      return {
        sandboxed: false,
        handle: this.withCleanup(
          this.options.runner.run({
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            env,
            timeoutMs: input.timeoutMs,
            maxOutputBytes: input.maxOutputBytes,
            onOutput: input.onOutput,
          }),
          temp,
        ),
      };
    }

    const settingsPath = path.join(root, 'settings.json');
    const settings = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: [...this.sensitiveReadPaths(), path.join(input.cwd, '.agent')],
        allowWrite: [input.cwd, root, temp],
        denyWrite: [path.join(input.cwd, '.git'), path.join(input.cwd, '.agent')],
      },
    };
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return {
      sandboxed: true,
      handle: this.withCleanup(
        this.options.runner.run({
          command: this.options.srtBin,
          args: ['--settings', settingsPath, input.command, ...input.args],
          cwd: input.cwd,
          env,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          onOutput: input.onOutput,
        }),
        temp,
      ),
    };
  }
}
