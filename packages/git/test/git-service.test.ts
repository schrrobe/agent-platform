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
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const JOB_SUFFIX = '11111111111141118111111111111111';

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

/** Standard-Responder: Repo gültig, keine Worktrees, kein Job-Branch. */
function baseResponder(overrides: Responder = () => undefined): Responder {
  return (spec) => {
    const custom = overrides(spec);
    if (custom) return custom;
    if (hasArgs(spec, 'rev-parse', '--is-inside-work-tree')) return { stdout: 'true\n' };
    if (hasArgs(spec, 'rev-parse', '--git-path')) {
      return { stdout: `${path.join(repoDir, '.git', 'info', 'attributes')}\n` };
    }
    if (hasArgs(spec, 'rev-parse', '--verify')) return { stdout: 'base123\n' };
    if (hasArgs(spec, 'worktree', 'list')) return { stdout: '' };
    if (
      hasArgs(spec, 'show-ref') &&
      spec.args.some((a) => /refs\/heads\/(fix|chore|feature)\//.test(a))
    )
      return { exitCode: 1 };
    if (hasArgs(spec, 'show-ref')) return { exitCode: 0 };
    return undefined;
  };
}

describe('allocateBranch', () => {
  it('weicht bei einer vorhandenen menschlichen Branch-Kollision stabil aus', async () => {
    const base = `feature/app-123/${JOB_SUFFIX}`;
    const { git } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'show-ref', `refs/heads/${base}`)) return { exitCode: 0 };
        return undefined;
      }),
    );

    await expect(git.allocateBranch(repoDir, 'APP-123', JOB_ID, 'feature')).resolves.toBe(
      `${base}-2`,
    );
  });
});

describe('ensureWorktree', () => {
  it('legt Branch und Worktree neu an (add -b vom Basisbranch)', async () => {
    const { git, runner } = service(baseResponder());
    const result = await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      jobId: JOB_ID,
      baseBranch: 'main',
    });

    expect(result.created).toBe(true);
    expect(result.branch).toBe(`feature/app-123/${JOB_SUFFIX}`);
    expect(result.worktreePath).toBe(path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`));
    expect(result.baseCommit).toBe('base123');

    const add = runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'add'));
    expect(add?.args).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'worktree',
      'add',
      '-b',
      `feature/app-123/${JOB_SUFFIX}`,
      path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`),
      'base123',
    ]);
    expect(runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'prune'))).toBeUndefined();
    expect(fs.existsSync(path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`, '.agent'))).toBe(true);
  });

  it('bindet den bekannten Branch eines begonnenen Jobs ohne -b erneut an', async () => {
    const { git, runner } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'show-ref', `refs/heads/feature/app-123/${JOB_SUFFIX}`))
          return { exitCode: 0 };
        return undefined;
      }),
    );
    await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      jobId: JOB_ID,
      baseBranch: 'main',
      expectedBaseCommit: 'base123',
    });
    const add = runner.argsOfCall((spec) => hasArgs(spec, 'worktree', 'add'));
    expect(add?.args).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'worktree',
      'add',
      path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`),
      `feature/app-123/${JOB_SUFFIX}`,
    ]);
  });

  it('verwendet registrierten, gesunden Worktree unverändert weiter', async () => {
    const worktreePath = path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`);
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.join(worktreePath, '.agent'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreePath, '.agent', 'OWNER.json'),
      JSON.stringify({
        jobId: JOB_ID,
        branch: `feature/app-123/${JOB_SUFFIX}`,
        repositoryPath: repoDir,
        baseCommit: 'base123',
      }),
    );
    const { git, runner } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'worktree', 'list')) {
          return {
            stdout: `worktree ${repoDir}\nHEAD aaa\nbranch refs/heads/main\n\nworktree ${worktreePath}\nHEAD bbb\nbranch refs/heads/feature/app-123/${JOB_SUFFIX}\n`,
          };
        }
        return undefined;
      }),
    );
    const result = await git.ensureWorktree({
      repositoryPath: repoDir,
      worktreeRoot,
      identifier: 'APP-123',
      jobId: JOB_ID,
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
            stdout: `worktree ${path.join(tmp, 'anderswo')}\nHEAD bbb\nbranch refs/heads/feature/app-123/${JOB_SUFFIX}\n`,
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
        jobId: JOB_ID,
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
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(GitError);
  });

  it('erkennt auch eine symlink-basierte Worktree-Wurzel innerhalb des Repositories', async () => {
    const nested = path.join(repoDir, 'nested');
    const linkedRoot = path.join(tmp, 'linked-worktrees');
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(nested, linkedRoot);
    const { git } = service(baseResponder());
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot: linkedRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/darf nicht innerhalb/);
  });

  it('wirft, wenn der Basisbranch fehlt', async () => {
    const { git } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'rev-parse', '--verify')) return { exitCode: 1, stderr: 'missing' };
        if (hasArgs(spec, 'show-ref')) return { exitCode: 1 };
        return undefined;
      }),
    );
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/Basisbranch/);
  });

  it('verweigert Repositories, die den reservierten .agent-Pfad tracken', async () => {
    const { git } = service(
      baseResponder((spec) =>
        hasArgs(spec, 'ls-tree') ? { stdout: '.agent/project-file.md\n' } : undefined,
      ),
    );
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/reservierten Pfad/);
  });

  it('verweigert externe Filter aus getrackten .gitattributes-Dateien', async () => {
    const { git } = service(
      baseResponder((spec) => {
        if (hasArgs(spec, 'ls-tree') && !spec.args.includes('.agent')) {
          return { stdout: '.gitattributes\n' };
        }
        if (hasArgs(spec, 'show')) return { stdout: '*.png filter=evil\n' };
        return undefined;
      }),
    );
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/externen Git-Filter/);
  });

  it('verweigert externe Filter aus .git/info/attributes', async () => {
    const infoDir = path.join(repoDir, '.git', 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'attributes'), '*.bin filter=evil\n');
    const { git } = service(baseResponder());
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/externen Git-Filter/);
  });

  it('löscht kein unbekanntes Verzeichnis am berechneten Zielpfad', async () => {
    const occupiedPath = path.join(worktreeRoot, `app-123-${JOB_SUFFIX}`);
    fs.mkdirSync(occupiedPath, { recursive: true });
    fs.writeFileSync(path.join(occupiedPath, 'important.txt'), 'behalten');
    const { git } = service(baseResponder());
    await expect(
      git.ensureWorktree({
        repositoryPath: repoDir,
        worktreeRoot,
        identifier: 'APP-123',
        jobId: JOB_ID,
        baseBranch: 'main',
      }),
    ).rejects.toThrow(/keine automatische Löschung/);
    expect(fs.readFileSync(path.join(occupiedPath, 'important.txt'), 'utf8')).toBe('behalten');
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

    const add = runner.argsOfCall((spec) => spec.args.includes('add'));
    expect(add?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      'add',
      '-A',
      '--',
      '.',
      ':(exclude).agent',
    ]);

    const commit = runner.argsOfCall((spec) => spec.args.includes('commit'));
    expect(commit?.args).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.fsmonitor=false',
      'commit',
      '--no-verify',
      '-m',
      'agent: Iteration 1',
    ]);
    expect(commit?.env?.GIT_AUTHOR_NAME).toBe('Agent Orchestrator');
    expect(commit?.env?.GIT_COMMITTER_EMAIL).toBe('agent-orchestrator@localhost');
  });

  it('liefert null, wenn nichts zu committen ist', async () => {
    const { git, runner } = service((spec) => {
      if (hasArgs(spec, 'diff', '--cached', '--quiet')) return { exitCode: 0 };
      return undefined;
    });
    expect(await git.commitAll(repoDir, 'leer')).toBeNull();
    expect(runner.argsOfCall((spec) => spec.args.includes('commit'))).toBeUndefined();
  });

  it('verweigert vor dem Staging neu aktivierte externe Filter', async () => {
    fs.writeFileSync(path.join(repoDir, '.gitattributes'), '*.bin filter=evil\n');
    const { git, runner } = service((spec) => {
      if (hasArgs(spec, 'ls-files')) return { stdout: '.gitattributes\n' };
      return undefined;
    });
    await expect(git.commitAll(repoDir, 'unsicher')).rejects.toThrow(/externen Git-Filter/);
    expect(runner.argsOfCall((spec) => spec.args.includes('add'))).toBeUndefined();
  });
});

describe('assertWorktreeClean', () => {
  it('lässt index.lock unangetastet und führt kein destruktives reset/clean aus', async () => {
    const worktreePath = path.join(worktreeRoot, 'app-123');
    const gitDir = path.join(tmp, 'gitdir');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(gitDir, 'index.lock'), '');

    const { git, runner } = service(() => undefined);
    await git.assertWorktreeClean(worktreePath);

    expect(fs.existsSync(path.join(gitDir, 'index.lock'))).toBe(true);
    expect(runner.argsOfCall((spec) => hasArgs(spec, 'reset', '--hard', 'HEAD'))).toBeUndefined();
    expect(runner.argsOfCall((spec) => spec.args[0] === 'clean')).toBeUndefined();
  });

  it('verweigert einen schmutzigen Worktree, statt Änderungen zu verwerfen', async () => {
    const { git } = service((spec) =>
      spec.args.includes('status') ? { stdout: ' M src/app.ts\n' } : undefined,
    );
    await expect(git.assertWorktreeClean(repoDir)).rejects.toThrow(/lokale Änderungen/);
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
    expect(call?.args).toEqual([
      'diff',
      '--no-ext-diff',
      'main...HEAD',
      '--',
      '.',
      ':(exclude).agent',
    ]);
  });

  it('changedFiles parst name-status-Ausgabe', async () => {
    const { git } = service((spec) => {
      if (hasArgs(spec, '--name-status')) {
        return { stdout: 'M\tsrc/app.ts\nA\tsrc/neu.ts\nR100\tsrc/alt.ts\tsrc/neu2.ts\n' };
      }
      return undefined;
    });
    expect(await git.changedFiles(repoDir, 'main')).toEqual([
      { status: 'M', path: 'src/app.ts' },
      { status: 'A', path: 'src/neu.ts' },
      { status: 'R100', previousPath: 'src/alt.ts', path: 'src/neu2.ts' },
    ]);
  });

  it('hasUncommittedChanges schließt .agent aus', async () => {
    const { git, runner } = service((spec) => {
      if (hasArgs(spec, 'status')) return { stdout: '' };
      return undefined;
    });
    expect(await git.hasUncommittedChanges(repoDir)).toBe(false);
    const call = runner.argsOfCall((spec) => spec.args.includes('status'));
    expect(call?.args).toEqual([
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain',
      '-z',
      '--',
      '.',
      ':(exclude).agent',
    ]);
  });

  it('erkennt binäre Änderungen über numstat', async () => {
    const { git } = service((spec) => {
      if (hasArgs(spec, '--numstat')) {
        return { stdout: '12\t3\tsrc/app.ts\n-\t-\tassets/image.png\n' };
      }
      return undefined;
    });
    expect(await git.binaryChangedFiles(repoDir, 'main')).toEqual(['assets/image.png']);
  });
});
