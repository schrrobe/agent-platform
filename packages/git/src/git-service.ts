import fs from 'node:fs';
import path from 'node:path';
import type { ProcessResult, ProcessRunner } from '@agent/shared';
import { branchForIdentifier, isPathInside, isSameOrInside, worktreePathFor } from './paths.js';

/**
 * Sichere Git-Fassade. Bewusst NICHT vorhanden: push, merge, force-push,
 * Branch-Löschung — solche Operationen existieren hier nicht (ADR-010).
 * `.agent/` (PLAN.md/REVIEW.md) wird bei add/status/diff/clean konsequent per
 * Pathspec ausgeschlossen (ADR-005).
 */

export const AGENT_DIR = '.agent';
const EXCLUDE_AGENT = `:(exclude)${AGENT_DIR}`;

export class GitError extends Error {
  constructor(
    message: string,
    readonly result?: ProcessResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitServiceOptions {
  runner: ProcessRunner;
  /** Gefilterte Basis-Umgebung für git-Kindprozesse (mind. PATH, HOME). */
  env: Record<string, string>;
  commandTimeoutMs?: number;
  identity?: GitIdentity;
}

export interface EnsureWorktreeInput {
  repositoryPath: string;
  worktreeRoot: string;
  identifier: string;
  baseBranch: string;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export interface ChangedFile {
  status: string;
  path: string;
}

const DEFAULT_IDENTITY: GitIdentity = {
  name: 'Agent Orchestrator',
  email: 'agent-orchestrator@localhost',
};

export class GitService {
  private readonly runner: ProcessRunner;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly identity: GitIdentity;

  constructor(options: GitServiceOptions) {
    this.runner = options.runner;
    this.env = options.env;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  private async git(
    cwd: string,
    args: string[],
    opts: { allowFailure?: boolean; env?: Record<string, string> } = {},
  ): Promise<ProcessResult> {
    const handle = this.runner.run({
      command: 'git',
      args,
      cwd,
      env: { ...this.env, ...opts.env },
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 20 * 1024 * 1024,
    });
    const result = await handle.result;
    if (!opts.allowFailure && result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 800);
      throw new GitError(`git ${args.join(' ')} fehlgeschlagen: ${detail}`, result);
    }
    return result;
  }

  async isGitRepo(dir: string): Promise<boolean> {
    if (!fs.existsSync(dir)) return false;
    const result = await this.git(dir, ['rev-parse', '--is-inside-work-tree'], {
      allowFailure: true,
    });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  async listWorktrees(repositoryPath: string): Promise<WorktreeEntry[]> {
    const result = await this.git(repositoryPath, ['worktree', 'list', '--porcelain']);
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | null = null;
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: line.slice('worktree '.length).trim(), branch: null };
      } else if (line.startsWith('branch ') && current) {
        current.branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  private async branchExists(repositoryPath: string, branch: string): Promise<boolean> {
    const result = await this.git(
      repositoryPath,
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { allowFailure: true },
    );
    return result.exitCode === 0;
  }

  /**
   * Erstellt oder repariert den Ticket-Worktree idempotent:
   * prune → registrierten Eintrag wiederverwenden → kaputte Reste entfernen →
   * vorhandenen Branch ohne `-b` anbinden, sonst neuen Branch vom Basisbranch.
   */
  async ensureWorktree(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    const repositoryPath = path.resolve(input.repositoryPath);
    const branch = branchForIdentifier(input.identifier);
    const worktreePath = worktreePathFor(input.worktreeRoot, input.identifier);

    if (isSameOrInside(repositoryPath, worktreePath)) {
      throw new GitError(
        `Worktree-Pfad ${worktreePath} darf nicht innerhalb des Repositories ${repositoryPath} liegen`,
      );
    }
    if (isSameOrInside(worktreePath, repositoryPath)) {
      throw new GitError(`Repository ${repositoryPath} liegt im Worktree-Pfad ${worktreePath}`);
    }
    if (!(await this.isGitRepo(repositoryPath))) {
      throw new GitError(`Kein Git-Repository: ${repositoryPath}`);
    }

    await this.git(repositoryPath, ['worktree', 'prune']);
    const entries = await this.listWorktrees(repositoryPath);

    const registered = entries.find((entry) => path.resolve(entry.path) === worktreePath);
    if (registered) {
      if (registered.branch !== branch) {
        throw new GitError(
          `Worktree ${worktreePath} gehört zu Branch ${registered.branch ?? '(detached)'}, erwartet ${branch}`,
        );
      }
      if (await this.isGitRepo(worktreePath)) {
        this.ensureAgentDir(worktreePath);
        return { worktreePath, branch, created: false };
      }
      // Registriert, aber Verzeichnis kaputt/fehlend → austragen und neu anlegen.
      await this.git(repositoryPath, ['worktree', 'remove', '--force', worktreePath], {
        allowFailure: true,
      });
      await this.git(repositoryPath, ['worktree', 'prune']);
    }

    const occupied = entries.find(
      (entry) => entry.branch === branch && path.resolve(entry.path) !== worktreePath,
    );
    if (occupied) {
      throw new GitError(`Branch ${branch} ist bereits im Worktree ${occupied.path} ausgecheckt`);
    }

    if (fs.existsSync(worktreePath)) {
      if (!isPathInside(input.worktreeRoot, worktreePath)) {
        throw new GitError(`Verweigere Löschung außerhalb des Worktree-Roots: ${worktreePath}`);
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }

    const hasBranch = await this.branchExists(repositoryPath, branch);
    if (!hasBranch && !(await this.branchExists(repositoryPath, input.baseBranch))) {
      throw new GitError(`Basisbranch ${input.baseBranch} existiert nicht in ${repositoryPath}`);
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await this.git(
      repositoryPath,
      hasBranch
        ? ['worktree', 'add', worktreePath, branch]
        : ['worktree', 'add', '-b', branch, worktreePath, input.baseBranch],
    );
    this.ensureAgentDir(worktreePath);
    return { worktreePath, branch, created: true };
  }

  private ensureAgentDir(worktreePath: string): void {
    fs.mkdirSync(path.join(worktreePath, AGENT_DIR), { recursive: true });
  }

  /**
   * Bringt den Worktree vor einem Lauf in einen sauberen Zustand: entfernt
   * verwaiste index.lock-Dateien (nach Kills), setzt auf HEAD zurück und räumt
   * untracked Dateien — mit Ausnahme von `.agent/`.
   */
  async cleanWorktree(worktreePath: string): Promise<void> {
    this.removeStaleIndexLock(worktreePath);
    await this.git(worktreePath, ['reset', '--hard', 'HEAD']);
    await this.git(worktreePath, ['clean', '-fd', '-e', AGENT_DIR]);
    this.ensureAgentDir(worktreePath);
  }

  private removeStaleIndexLock(worktreePath: string): void {
    try {
      const gitFile = path.join(worktreePath, '.git');
      const stat = fs.statSync(gitFile);
      let gitDir: string;
      if (stat.isFile()) {
        const content = fs.readFileSync(gitFile, 'utf8');
        const match = /^gitdir:\s*(.+)$/m.exec(content);
        if (!match?.[1]) return;
        gitDir = path.resolve(worktreePath, match[1].trim());
      } else {
        gitDir = gitFile;
      }
      fs.rmSync(path.join(gitDir, 'index.lock'), { force: true });
    } catch {
      // Kein .git oder nicht lesbar — cleanWorktree schlägt dann ohnehin fehl.
    }
  }

  /** Arbeitszustand ohne `.agent/`: leer = keine offenen Änderungen. */
  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    const result = await this.git(worktreePath, [
      'status',
      '--porcelain',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout.trim().length > 0;
  }

  /**
   * Staged und committet alle Änderungen außer `.agent/`. Identität kommt aus
   * Umgebungsvariablen — die globale Git-Konfiguration bleibt unberührt.
   * @returns Commit-Hash oder null, wenn nichts zu committen war.
   */
  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    await this.git(worktreePath, ['add', '-A', '--', '.', EXCLUDE_AGENT]);
    const staged = await this.git(worktreePath, ['diff', '--cached', '--quiet'], {
      allowFailure: true,
    });
    if (staged.exitCode === 0) return null;
    const identityEnv = {
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
    };
    await this.git(worktreePath, ['commit', '-m', message], { env: identityEnv });
    const head = await this.git(worktreePath, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }

  /** Review-Diff: Basisbranch (merge-base) bis HEAD, ohne `.agent/`. */
  async diffAgainstBase(worktreePath: string, baseBranch: string): Promise<string> {
    const result = await this.git(worktreePath, [
      'diff',
      `${baseBranch}...HEAD`,
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout;
  }

  async changedFiles(worktreePath: string, baseBranch: string): Promise<ChangedFile[]> {
    const result = await this.git(worktreePath, [
      'diff',
      '--name-status',
      `${baseBranch}...HEAD`,
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [status = '', ...rest] = line.split(/\s+/);
        return { status, path: rest.join(' ') };
      });
  }

  async currentBranch(worktreePath: string): Promise<string> {
    const result = await this.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.stdout.trim();
  }
}
