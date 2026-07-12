import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessHandle, ProcessResult, ProcessRunner, ProcessSpec } from '@agent/shared';
import { TestSandbox } from '../src/services/test-sandbox.js';

class RecordingRunner implements ProcessRunner {
  lastSpec: ProcessSpec | null = null;

  run(spec: ProcessSpec): ProcessHandle {
    this.lastSpec = spec;
    const result: ProcessResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      canceled: false,
      truncated: false,
      stdout: '',
      stderr: '',
      durationMs: 1,
    };
    return { pid: 1, pgid: 1, result: Promise.resolve(result), cancel: () => {} };
  }
}

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('TestSandbox', () => {
  it('startet den sicheren Modus über srt mit credential-freiem HOME', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sandbox-'));
    const worktree = path.join(tmp, 'worktree');
    fs.mkdirSync(worktree);
    const runner = new RecordingRunner();
    const sandbox = new TestSandbox({
      runner,
      dataDir: tmp,
      srtBin: '/bin/srt',
      sourceEnv: {
        PATH: '/usr/bin',
        HOME: '/home/real',
        ANTHROPIC_API_KEY: 'secret',
      },
    });
    await sandbox.run({
      jobId: '11111111-1111-4111-8111-111111111111',
      mode: 'sandboxed',
      command: 'pnpm',
      args: ['test'],
      cwd: worktree,
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });

    expect(runner.lastSpec?.command).toBe('/bin/srt');
    expect(runner.lastSpec?.args).toEqual(expect.arrayContaining(['--settings', 'pnpm', 'test']));
    expect(runner.lastSpec?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(runner.lastSpec?.env?.HOME).toContain(
      'test-sandboxes/11111111-1111-4111-8111-111111111111/home',
    );

    const settingsPath = runner.lastSpec?.args[1] as string;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(settings.network.allowedDomains).toEqual([]);
    expect(settings.filesystem.allowWrite).toContain(worktree);
    expect(settings.filesystem.denyWrite).toContain(path.join(worktree, '.git'));
  });

  it('führt Trusted-Modus direkt, aber weiterhin ohne Agenten-Credentials aus', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-sandbox-'));
    const runner = new RecordingRunner();
    const sandbox = new TestSandbox({
      runner,
      dataDir: tmp,
      srtBin: 'srt',
      sourceEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'secret' },
    });
    await sandbox.run({
      jobId: '22222222-2222-4222-8222-222222222222',
      mode: 'trusted',
      command: 'node',
      args: ['--version'],
      cwd: tmp,
      timeoutMs: 1000,
      maxOutputBytes: 1000,
    });
    expect(runner.lastSpec?.command).toBe('node');
    expect(runner.lastSpec?.env?.OPENAI_API_KEY).toBeUndefined();
  });
});
