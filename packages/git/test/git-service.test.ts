import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessHandle, ProcessResult, ProcessRunner, ProcessSpec } from '@agent/shared';
import { GitError, GitService } from '../src/git-service.js';

function makeResult(partial: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    canceled: false,
    truncated: false,
    stdout: '',
    stderr: '',
    durationMs: 1,
    ...partial,
  };
}

type Responder = (spec: ProcessSpec) => Partial<ProcessResult> | undefined;

class FakeRunner implements ProcessRunner {
  calls: ProcessSpec[] = [];
  constructor(private readonly responder: Responder = () => undefined) {}

  run(spec: ProcessSpec): ProcessHandle {
    this.calls.push(spec);
    return {
      pid: 42,
      pgid: 42,
      result: Promise.resolve(makeResult(this.responder(spec))),
      cancel: () => {},
    };
  }

  argsOfCall(matcher: (spec: ProcessSpec) => boolean): ProcessSpec | undefined {
    return this.calls.find(matcher);
  }
}

const hasArgs = (spec: ProcessSpec, ...parts: string[]) =>
  parts.every((part) => spec.args.includes(part));

let tmp: string;
let repoDir: string;
let worktreeRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-test-'));
  repoDir = path.join(tmp, 'repo');
  worktreeRoot = path.join(tmp, 'worktrees');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(worktreeRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function service(responder: Responder): { git: GitService; runner: FakeRunner } {
  const runner = new FakeRunner(responder);
  const git = new GitService({ runner, env: { PATH: '/usr/bin' } });
  return { git, runner };
}

/** Standard-Responder: Repo gültig, keine Worktrees, kein Agent-Branch. */
function baseResponder(overrides: Responder = () => undefined): Responder {
  return (spec) => {
    const custom = overrides(spec);
    if (custom) return custom;
    if (hasArgs(spec, 'rev-parse', '--is-inside-work-tree')) return { stdout: 'true\n' };
    if (hasArgs(spec, 'worktree', 'list')) return { stdout: '' };
    if (hasArgs(spec, 'show-ref') && spec.args.some((a) => a.includes('agent/')))
      return { exitCode: 1 };
    if (hasArgs(spec, 'show-ref')) return { exitCode: 0 };
    return undefined;
  };
}

describe('ensureWorktree', () => {
  it('legt Branch und Worktree neu an (add -b vom Basisbranch)', async () => {
    const { git, runner } = service(baseResponder());
    const result = await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      baseBranch: 'main',
    });

    expect(result.created).toBe(true);
    expect(result.branch).toBe('agent/app-123');
    expect(result.worktreePath).toBe(path.join(worktreeRoot, 'app-123'));

    const add = runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'add'));
    expect(add?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'agent/app-123',
      path.join(worktreeRoot, 'app-123'),
      'main',
    ]);
    expect(runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'prune'))).toBeDefined();
    expect(fs.existsSync(path.join(worktreeRoot, 'app-123', '.agent'))).toBe(true);
  });

  it('verwendet existierenden Branch ohne -b weiter', async () => {
    const { git, runner } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'show-ref', 'refs/heads/agent/app-123')) return { exitCode: 0 };
        return undefined;
      }),
    );
    await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      baseBranch: 'main',
    });
    const add = runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'add'));
    expect(add?.args).toEqual(['worktree', 'add', path.join(worktreeRoot, 'app-123'), 'agent/app-123']);
  });

  it('verwendet registrierten, gesunden Worktree unverändert weiter', async () => {
    const worktreePath = path.join(worktreeRoot, 'app-123');
    fs.mkdirSync(worktreePath, { recursive: true });
    const { git, runner } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'worktree', 'list')) {
          return {
            stdout: `worktree ${repoDir}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${worktreePath}\nHEAD bbb\nbranch refs/heads/agent/app-123\n`,
          };
        }
        return undefined;
      }),
    );
    const result = await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      baseBranch: 'main',
    });
    expect(result.created).toBe(false);
    expect(runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'add'))).toBeUndefined();
  });

  it('wirft, wenn der Branch in einem anderen Worktree ausgecheckt ist', async () => {
    const { git } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'worktree', 'list')) {
          return {
            stdout: `worktree ${path.join(tmp, 'anderswo')}\nHEAD bbb\nbranch refs/heads/agent/app-123\n`,
          };
        }
        return undefined;
      }),
    );
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/bereits im Worktree/);
  });

  it('wirft, wenn der Worktree-Pfad im Repository läge', async () => {
    const { git } = service(baseResponder());
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot: path.join(repoDir, 'wt'),
        identifier: 'APP-123',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(GitError);
  });

  it('wirft, wenn der Basisbranch fehlt', async () => {
    const { git } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'show-ref')) return { exitCode: 1 };
        return undefined;
      }),
    );
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/Basisbranch/);
  });
});

describe('commitAll', () => {
  it('staged mit .agent-Ausschluss und committet mit Env-Identität', async () => {
    const { git, runner } = service((spec) => {
      if (hasArgs(spec, 'diff', '--cached', '--quiet')) return { exitCode: 1 };
      if (hasArgs(spec, 'rev-parse', 'HEAD')) return { stdout: 'abc123\n' };
      return undefined;
    });
    const hash = await git.commitAll(repoDir, 'agent: Iteration 1');
    expect(hash).toBe('abc123');

    const add = runner.argsOfCall((spec) => spec.args[0] === 'add');
    expect(add?.args).toEqual(['add', '-A', '--', '.', ':(exclude).agent']);

    const commit = runner.argsOfCall((spec) => spec.args[0] === 'commit');
    expect(commit?.args).toEqual(['commit', '-m', 'agent: Iteration 1']);
    expect(commit?.env?.GIT_AUTHOR_NAME).toBe('Agent Orchestrator');
    expect(commit?.env?.GIT_COMMITTER_EMAIL).toBe('agent-orchestrator@localhost');
  });

  it('liefert null, wenn nichts zu committen ist', async () => {
    const { git, runner } = service((spec) => {
      if (hasArgs(spec, 'diff', '--cached', '--quiet')) return { exitCode: 0 };
      return undefined;
    });
    expect(await git.commitAll(repoDir, 'leer')).toBeNull();
    expect(runner.argsOfCall((spec) => spec.args[0] === 'commit')).toBeUndefined();
  });
});

describe('cleanWorktree', () => {
  it('entfernt stale index.lock und räumt mit .agent-Ausnahme', async () => {
    const worktreePath = path.join(worktreeRoot, 'app-123');
    const gitDir = path.join(tmp, 'gitdir');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');

    const { git, runner } = service(() => undefined);
    await git.cleanWorktree(worktreePath);

    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(false);
    expect(runner.argsOfCall((spec) => hasArgs(spec, 'reset', '--hard', 'HEAD'))).toBeDefined();
    const clean = runner.argsOfCall((spec) => spec.args[0] === 'clean');
    expect(clean?.args).toEqual(['clean', '-fd', '-e', '.agent']);
  });
});

describe('Diff und Status', () => {
  it('diffAgainstBase nutzt merge-base-Diff ohne .agent', async () => {
    const { git, runner } = service((spec) => {
      if (spec.args[0] === 'diff') return { stdout: 'diff --git a/x b/x\n' };
      return undefined;
    });
    const diff = await git.diffAgainstBase(repoDir, 'main');
    expect(diff).toContain('diff --git');
    const call = runner.argsOfCall((spec) => spec.args[0] === 'diff');
    expect(call?.args).toEqual(['diff', 'main...HEAD', '--', '.', ':(exclude).agent']);
  });

  it('changedFiles parst name-status-Ausgabe', async () => {
    const { git } = service((spec) => {
      if (hasArgs(spec, '--name-status')) return { stdout: 'M\tsrc/app.ts\nA\tsrc/neu.ts\n' };
      return undefined;
    });
    expect(await git.changedFiles(repoDir, 'main')).toEqual([
      { status: 'M', path: 'src/app.ts' },
      { status: 'A', path: 'src/neu.ts' },
    ]);
  });

  it('hasUncommittedChanges schließt .agent aus', async () => {
    const { git, runner } = service((spec) => {
      if (spec.args[0] === 'status') return { stdout: '' };
      return undefined;
    });
    expect(await git.hasUncommittedChanges(repoDir)).toBe(false);
    const call = runner.argsOfCall((spec) => spec.args[0] === 'status');
    expect(call?.args).toEqual(['status', '--porcelain', '--', '.', ':(exclude).agent']);
  });
});
