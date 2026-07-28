import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProcessResult, ProcessRunner } from '@agent/shared';
import {
  branchForTicket,
  isPathInside,
  isSameOrInside,
  jobSuffix,
  worktreePathForJob,
  type BranchKind,
} from './paths.js';

/**
 * Sichere Git-Fassade. Bewusst NICHT vorhanden: push, merge, force-push,
 * Branch-Löschung — solche Operationen existieren hier nicht (ADR-010).
 * `.agent/` (OWNER/PLAN/REVIEW) wird bei add/status/diff konsequent per
 * Pathspec ausgeschlossen (ADR-005).
 */

export const AGENT_DIR = '.agent';
export const OWNER_FILE = 'OWNER.json';
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

/** Sicherer Halt wegen vorhandener/menschlicher Git-Arbeit, kein Infrastrukturfehler. */
export class GitConflictError extends GitError {
  constructor(message: string) {
    super(message);
    this.name = 'GitConflictError';
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
  /** Neue Aufrufer setzen den Titel; ohne ihn bleibt das alte Hash-Schema kompatibel. */
  title?: string;
  branchKind?: BranchKind;
  /** Bereits persistierter Branch; hält begonnene Jobs über Namensänderungen hinweg fortsetzbar. */
  expectedBranch?: string | null;
  jobId: string;
  baseBranch: string;
  expectedBaseCommit?: string | null;
}

export interface EnsureWorktreeResult {
  worktreePath: string;
  branch: string;
  baseCommit: string;
  created: boolean;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export interface WorktreeOwner {
  jobId: string;
  branch: string;
  repositoryPath: string;
  baseCommit: string;
}

export interface ChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

const DEFAULT_IDENTITY: GitIdentity = {
  name: 'Agent Orchestrator',
  email: 'agent-orchestrator@localhost',
};

function canonicalPath(value: string): string {
  let cursor = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...missing);
  } catch {
    return path.resolve(value);
  }
}

function splitGitPaths(output: string): string[] {
  return output
    .split(output.includes('\0') ? '\0' : '\n')
    .map((entry) => entry.trimEnd())
    .filter(Boolean);
}

export class GitService {
  private readonly runner: ProcessRunner;
  private readonly env: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly identity: GitIdentity;
  private readonly repoLocks = new Map<string, Promise<unknown>>();

  constructor(options: GitServiceOptions) {
    this.runner = options.runner;
    this.env = options.env;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
    this.identity = options.identity ?? DEFAULT_IDENTITY;
  }

  /**
   * Serialisiert repo-weite Schreiboperationen (Branch-Vergabe, `worktree
   * add/remove`) je Repository. Nebenläufige Jobs desselben Projekts arbeiten in
   * eigenen Worktrees mit eigener `index.lock`, teilen aber `.git` — nur die
   * repo-globalen Abschnitte brauchen daher einen Riegel.
   */
  private withRepoLock<T>(repositoryPath: string, task: () => Promise<T>): Promise<T> {
    const key = canonicalPath(path.resolve(repositoryPath));
    const previous = this.repoLocks.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => task(),
      () => task(),
    );
    this.repoLocks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
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
      maxOutputBytes: 128 * 1024 * 1024,
    });
    const result = await handle.result;
    if (result.truncated) {
      throw new GitError(`git ${args.join(' ')} lieferte eine gekappte Ausgabe`, result);
    }
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

  /** Wählt vor der Persistierung einen freien, konventionellen Job-Branch. */
  async allocateBranch(
    repositoryPath: string,
    identifier: string,
    title: string,
    kind: BranchKind,
  ): Promise<string> {
    return this.withRepoLock(repositoryPath, async () => {
      const base = branchForTicket(identifier, title, kind);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
        if (!(await this.branchExists(repositoryPath, candidate))) return candidate;
      }
      throw new GitConflictError(`Kein freier Branchname für ${identifier} gefunden`);
    });
  }

  private async hasTrackedAgentDirectory(repositoryPath: string, ref: string): Promise<boolean> {
    const result = await this.git(repositoryPath, [
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      '--',
      AGENT_DIR,
    ]);
    return result.stdout.trim().length > 0;
  }

  private assertSafeAttributes(content: string, source: string): void {
    const hasFilter = content
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').trim())
      .filter(Boolean)
      .some((line) => /(?:^|\s)-?!?filter(?:=|\s|$)/.test(line));
    if (hasFilter) {
      throw new GitConflictError(
        `${source} aktiviert einen externen Git-Filter; automatische Checkouts/Commits verweigert`,
      );
    }
  }

  private async assertNoTrackedFilters(repositoryPath: string, ref: string): Promise<void> {
    const listed = await this.git(repositoryPath, ['ls-tree', '-r', '--name-only', '-z', ref]);
    const attributePaths = splitGitPaths(listed.stdout).filter(
      (entry) => entry === '.gitattributes' || entry.endsWith('/.gitattributes'),
    );
    for (const attributePath of attributePaths) {
      const content = await this.git(repositoryPath, ['show', `${ref}:${attributePath}`]);
      this.assertSafeAttributes(content.stdout, attributePath);
    }
  }

  private async assertNoRepositoryAttributeOverrides(repositoryPath: string): Promise<void> {
    const configured = await this.git(
      repositoryPath,
      ['config', '--local', '--get', 'core.attributesFile'],
      { allowFailure: true },
    );
    if (configured.exitCode === 0 && configured.stdout.trim()) {
      throw new GitConflictError(
        'Lokale Git-Konfiguration core.attributesFile ist für automatische Checkouts nicht erlaubt',
      );
    }
    const resolved = await this.git(repositoryPath, ['rev-parse', '--git-path', 'info/attributes']);
    const reported = resolved.stdout.trim();
    const infoAttributes = path.isAbsolute(reported)
      ? reported
      : path.resolve(repositoryPath, reported);
    if (infoAttributes && fs.existsSync(infoAttributes)) {
      const stat = fs.lstatSync(infoAttributes);
      if (!stat.isFile()) {
        throw new GitConflictError('Git info/attributes ist keine reguläre Datei');
      }
      this.assertSafeAttributes(fs.readFileSync(infoAttributes, 'utf8'), 'Git info/attributes');
    }
  }

  private async assertNoWorktreeFilters(worktreePath: string): Promise<void> {
    const listed = await this.git(worktreePath, [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    const attributePaths = splitGitPaths(listed.stdout).filter(
      (entry) => entry === '.gitattributes' || entry.endsWith('/.gitattributes'),
    );
    for (const attributePath of attributePaths) {
      const absolute = path.resolve(worktreePath, attributePath);
      if (!isSameOrInside(worktreePath, absolute)) {
        throw new GitConflictError(`Unsicherer .gitattributes-Pfad: ${attributePath}`);
      }
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile()) {
        throw new GitConflictError(`${attributePath} ist keine reguläre Datei`);
      }
      this.assertSafeAttributes(fs.readFileSync(absolute, 'utf8'), attributePath);
    }
  }

  /**
   * Erstellt den jobgebundenen Worktree idempotent. Bereits registrierte
   * Worktrees werden nur bei passender Eigentümerdatei wiederverwendet;
   * beschädigte oder unbekannte Pfade werden niemals automatisch entfernt.
   */
  async ensureWorktree(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    return this.withRepoLock(input.repositoryPath, () => this.ensureWorktreeUnlocked(input));
  }

  private async ensureWorktreeUnlocked(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    const repositoryPath = path.resolve(input.repositoryPath);
    const branch =
      input.expectedBranch ??
      branchForTicket(input.identifier, input.title ?? jobSuffix(input.jobId), input.branchKind);
    const worktreePath = worktreePathForJob(input.worktreeRoot, input.identifier, input.jobId);

    const canonicalRepositoryPath = canonicalPath(repositoryPath);
    const canonicalWorktreePath = canonicalPath(worktreePath);
    if (isSameOrInside(canonicalRepositoryPath, canonicalWorktreePath)) {
      throw new GitError(
        `Worktree-Pfad ${worktreePath} darf nicht innerhalb des Repositories ${repositoryPath} liegen`,
      );
    }
    if (isSameOrInside(canonicalWorktreePath, canonicalRepositoryPath)) {
      throw new GitError(`Repository ${repositoryPath} liegt im Worktree-Pfad ${worktreePath}`);
    }
    if (!(await this.isGitRepo(repositoryPath))) {
      throw new GitError(`Kein Git-Repository: ${repositoryPath}`);
    }
    await this.assertNoRepositoryAttributeOverrides(repositoryPath);

    let baseCommit: string;
    try {
      baseCommit = input.expectedBaseCommit
        ? await this.resolveCommit(repositoryPath, input.expectedBaseCommit)
        : await this.resolveCommit(repositoryPath, input.baseBranch);
    } catch (error) {
      if (input.expectedBaseCommit) throw error;
      throw new GitError(`Basisbranch ${input.baseBranch} existiert nicht in ${repositoryPath}`);
    }
    if (await this.hasTrackedAgentDirectory(repositoryPath, baseCommit)) {
      throw new GitConflictError(
        `Repository verwendet den reservierten Pfad ${AGENT_DIR}/ bereits im Basis-Commit`,
      );
    }
    await this.assertNoTrackedFilters(repositoryPath, baseCommit);

    const entries = await this.listWorktrees(repositoryPath);

    const registered = entries.find(
      (entry) => canonicalPath(entry.path) === canonicalPath(worktreePath),
    );
    if (registered) {
      if (registered.branch !== branch) {
        throw new GitConflictError(
          `Worktree ${worktreePath} gehört zu Branch ${registered.branch ?? '(detached)'}, erwartet ${branch}`,
        );
      }
      if (await this.isGitRepo(worktreePath)) {
        this.verifyOwner(worktreePath, {
          jobId: input.jobId,
          branch,
          repositoryPath,
          baseCommit,
        });
        return { worktreePath, branch, baseCommit, created: false };
      }
      throw new GitConflictError(
        `Registrierter Worktree ${worktreePath} ist beschädigt; keine automatische Löschung`,
      );
    }

    const occupied = entries.find(
      (entry) =>
        entry.branch === branch && canonicalPath(entry.path) !== canonicalPath(worktreePath),
    );
    if (occupied) {
      throw new GitConflictError(
        `Branch ${branch} ist bereits im Worktree ${occupied.path} ausgecheckt`,
      );
    }

    if (fs.existsSync(worktreePath)) {
      throw new GitConflictError(
        `Worktree-Ziel ${worktreePath} existiert, ist aber nicht diesem Job zugeordnet; keine automatische Löschung`,
      );
    }

    const hasBranch = await this.branchExists(repositoryPath, branch);
    if (hasBranch && !input.expectedBaseCommit) {
      throw new GitConflictError(
        `Branch ${branch} existiert bereits, ist aber keinem begonnenen Job zugeordnet`,
      );
    }

    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    await this.git(
      repositoryPath,
      hasBranch
        ? [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            'worktree',
            'add',
            worktreePath,
            branch,
          ]
        : [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            'worktree',
            'add',
            '-b',
            branch,
            worktreePath,
            baseCommit,
          ],
    );
    this.writeOwner(worktreePath, {
      jobId: input.jobId,
      branch,
      repositoryPath,
      baseCommit,
    });
    return { worktreePath, branch, baseCommit, created: true };
  }

  private ensureAgentDir(worktreePath: string): void {
    fs.mkdirSync(path.join(worktreePath, AGENT_DIR), { recursive: true });
  }

  private writeOwner(
    worktreePath: string,
    owner: { jobId: string; branch: string; repositoryPath: string; baseCommit: string },
  ): void {
    this.ensureAgentDir(worktreePath);
    fs.writeFileSync(
      path.join(worktreePath, AGENT_DIR, OWNER_FILE),
      `${JSON.stringify({ ...owner, repositoryPath: canonicalPath(owner.repositoryPath) }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  }

  verifyOwner(worktreePath: string, expected: WorktreeOwner): void {
    const ownerPath = path.join(worktreePath, AGENT_DIR, OWNER_FILE);
    let owner: Record<string, unknown>;
    try {
      owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      const detail = error instanceof Error ? ` (${error.message})` : '';
      throw new GitConflictError(
        `Worktree-Eigentümerdatei fehlt oder ist ungültig: ${ownerPath}${detail}`,
      );
    }
    const matches =
      owner.jobId === expected.jobId &&
      owner.branch === expected.branch &&
      owner.baseCommit === expected.baseCommit &&
      typeof owner.repositoryPath === 'string' &&
      canonicalPath(owner.repositoryPath) === canonicalPath(expected.repositoryPath);
    if (!matches) {
      throw new GitConflictError(
        `Worktree ${worktreePath} gehört nicht zum erwarteten Job ${expected.jobId}`,
      );
    }
  }

  /** Entfernt nur generierte Plan-/Review-Dateien eines verifizierten Job-Worktrees. */
  clearOwnedAgentArtifacts(worktreePath: string, expected: WorktreeOwner): void {
    this.verifyOwner(worktreePath, expected);
    for (const file of ['PLAN.md', 'REVIEW.md']) {
      fs.rmSync(path.join(worktreePath, AGENT_DIR, file), { force: true });
    }
  }

  /** Liest die Eigentümerdatei tolerant; null bei fehlender/ungültiger Datei. */
  readWorktreeOwner(worktreePath: string): WorktreeOwner | null {
    const ownerPath = path.join(worktreePath, AGENT_DIR, OWNER_FILE);
    try {
      const raw = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
      if (
        typeof raw.jobId === 'string' &&
        typeof raw.branch === 'string' &&
        typeof raw.repositoryPath === 'string' &&
        typeof raw.baseCommit === 'string'
      ) {
        return {
          jobId: raw.jobId,
          branch: raw.branch,
          repositoryPath: raw.repositoryPath,
          baseCommit: raw.baseCommit,
        };
      }
    } catch {
      // fehlende oder kaputte Datei → verwaist
    }
    return null;
  }

  /**
   * Entfernt einen sauberen Worktree über Git. Der Branch bleibt bestehen.
   * `.agent/` wird temporär gesichert, damit `git worktree remove` ohne `--force` arbeiten kann.
   */
  private async removeWorktreeInternal(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<void> {
    const agentDir = path.join(worktreePath, AGENT_DIR);
    const hasAgentDir = fs.existsSync(agentDir);
    if (!hasAgentDir) {
      await this.git(repositoryPath, ['worktree', 'remove', worktreePath]);
      return;
    }
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-worktree-remove-'));
    const backupAgentDir = path.join(backupRoot, AGENT_DIR);
    try {
      fs.cpSync(agentDir, backupAgentDir, { recursive: true });
      fs.rmSync(agentDir, { recursive: true });
      try {
        await this.git(repositoryPath, ['worktree', 'remove', worktreePath]);
      } catch (error) {
        if (fs.existsSync(worktreePath) && !fs.existsSync(agentDir)) {
          fs.cpSync(backupAgentDir, agentDir, { recursive: true });
        }
        throw error;
      }
    } finally {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  }

  /** Entfernt einen sauberen, eindeutig zugeordneten Worktree. Der Branch bleibt bestehen. */
  async removeOwnedWorktree(
    repositoryPath: string,
    worktreePath: string,
    expected: WorktreeOwner,
  ): Promise<void> {
    this.verifyOwner(worktreePath, expected);
    await this.assertWorktreeClean(worktreePath);
    await this.withRepoLock(repositoryPath, () =>
      this.removeWorktreeInternal(repositoryPath, worktreePath),
    );
  }

  /**
   * Entfernt einen verwaisten Worktree (kein zugehöriger Job mehr). Vier Schutzschichten:
   * Pfad strikt unter `worktreeRoot` und ≠ Repo, in git registriert, sauber (kein --force).
   */
  async removeUnownedWorktree(
    repositoryPath: string,
    worktreePath: string,
    options: { worktreeRoot: string },
  ): Promise<void> {
    if (!isPathInside(options.worktreeRoot, worktreePath)) {
      throw new GitConflictError(
        `Worktree ${worktreePath} liegt nicht innerhalb von ${options.worktreeRoot}`,
      );
    }
    if (canonicalPath(worktreePath) === canonicalPath(repositoryPath)) {
      throw new GitConflictError('Das Haupt-Repository kann nicht entfernt werden');
    }
    await this.withRepoLock(repositoryPath, async () => {
      const entries = await this.listWorktrees(repositoryPath);
      const registered = entries.some(
        (entry) => canonicalPath(entry.path) === canonicalPath(worktreePath),
      );
      if (!registered) {
        throw new GitConflictError(
          `Worktree ${worktreePath} ist bei ${repositoryPath} nicht registriert`,
        );
      }
      await this.assertWorktreeClean(worktreePath);
      await this.removeWorktreeInternal(repositoryPath, worktreePath);
    });
  }

  /**
   * Verweigert jeden schmutzigen Worktree. Es gibt bewusst weder reset/clean
   * noch eine automatische Entfernung von Git-Locks.
   */
  async assertWorktreeClean(worktreePath: string): Promise<void> {
    if (await this.hasUncommittedChanges(worktreePath)) {
      throw new GitConflictError(
        `Worktree ${worktreePath} enthält lokale Änderungen; kein automatisches reset/clean`,
      );
    }
  }

  /** Arbeitszustand ohne `.agent/`: leer = keine offenen Änderungen. */
  async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    return (await this.workingTreeStatus(worktreePath)).trim().length > 0;
  }

  async workingTreeStatus(worktreePath: string): Promise<string> {
    const result = await this.git(worktreePath, [
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain',
      '-z',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout;
  }

  /** Verwirft ausschließlich Änderungen eines zuvor sauberen Job-Worktrees. */
  async discardJobChanges(worktreePath: string, expectedHead: string): Promise<void> {
    const head = await this.currentHead(worktreePath);
    if (head !== expectedHead) {
      throw new GitConflictError(
        `Git-HEAD wurde während der Aktion verändert (${head}, erwartet ${expectedHead}); kein automatisches Aufräumen`,
      );
    }
    await this.git(worktreePath, [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      'reset',
      '--hard',
      expectedHead,
    ]);
    await this.git(worktreePath, ['clean', '-fd', '--', '.', EXCLUDE_AGENT]);
    await this.assertWorktreeClean(worktreePath);
  }

  /**
   * Staged alle Änderungen außer `.agent/`, damit Policies vor dem Commit auf
   * dem vollständigen Index (einschließlich neuer Dateien) prüfen können.
   */
  async stageAll(worktreePath: string): Promise<void> {
    await this.assertNoWorktreeFilters(worktreePath);
    await this.git(worktreePath, [
      '-c',
      'core.fsmonitor=false',
      'add',
      '-A',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    // Ein Agent könnte `.agent/` selbst gestaged haben; der reservierte Pfad darf nie committen.
    await this.git(worktreePath, ['reset', '--quiet', '--', AGENT_DIR], { allowFailure: true });
  }

  /** Committet den bereits geprüften Index. */
  async commitStaged(worktreePath: string, message: string): Promise<string | null> {
    const staged = await this.git(worktreePath, ['diff', '--no-ext-diff', '--cached', '--quiet'], {
      allowFailure: true,
    });
    if (staged.exitCode === 0) return null;
    const identityEnv = {
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
    };
    await this.git(
      worktreePath,
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.fsmonitor=false',
        'commit',
        '--no-verify',
        '-m',
        message,
      ],
      { env: identityEnv },
    );
    const head = await this.git(worktreePath, ['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }

  /** Staged und committet alle Änderungen außer `.agent/`. */
  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    await this.stageAll(worktreePath);
    return this.commitStaged(worktreePath, message);
  }

  async stagedChangedFiles(worktreePath: string): Promise<ChangedFile[]> {
    const result = await this.git(worktreePath, [
      'diff',
      '--no-ext-diff',
      '--cached',
      '--name-status',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return this.parseChangedFiles(result.stdout);
  }

  async stagedDiff(worktreePath: string): Promise<string> {
    const result = await this.git(worktreePath, [
      'diff',
      '--no-ext-diff',
      '--cached',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout;
  }

  async stagedBinaryChangedFiles(worktreePath: string): Promise<string[]> {
    const result = await this.git(worktreePath, [
      'diff',
      '--no-ext-diff',
      '--cached',
      '--numstat',
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return this.parseBinaryChangedFiles(result.stdout);
  }

  private async diffRange(
    worktreePath: string,
    baseRef: string,
    extraArgs: string[] = [],
  ): Promise<string> {
    const result = await this.git(worktreePath, [
      'diff',
      '--no-ext-diff',
      ...extraArgs,
      `${baseRef}...HEAD`,
      '--',
      '.',
      EXCLUDE_AGENT,
    ]);
    return result.stdout;
  }

  /** Review-Diff: Basisbranch (merge-base) bis HEAD, ohne `.agent/`. */
  async diffAgainstBase(worktreePath: string, baseBranch: string): Promise<string> {
    return this.diffRange(worktreePath, baseBranch);
  }

  async changedFiles(worktreePath: string, baseBranch: string): Promise<ChangedFile[]> {
    const stdout = await this.diffRange(worktreePath, baseBranch, ['--name-status']);
    return this.parseChangedFiles(stdout);
  }

  private parseChangedFiles(stdout: string): ChangedFile[] {
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [status = '', ...paths] = line.split('\t');
        if ((status.startsWith('R') || status.startsWith('C')) && paths.length >= 2) {
          return {
            status,
            previousPath: paths[0] as string,
            path: paths.at(-1) as string,
          };
        }
        return { status, path: paths.join('\t') };
      });
  }

  async currentBranch(worktreePath: string): Promise<string> {
    const result = await this.git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.stdout.trim();
  }

  async resolveCommit(repositoryPath: string, ref: string): Promise<string> {
    const result = await this.git(repositoryPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return result.stdout.trim();
  }

  async currentHead(worktreePath: string): Promise<string> {
    return this.resolveCommit(worktreePath, 'HEAD');
  }

  async diffStat(worktreePath: string, baseRef: string): Promise<string> {
    return this.diffRange(worktreePath, baseRef, ['--stat']);
  }

  async binaryChangedFiles(worktreePath: string, baseRef: string): Promise<string[]> {
    const stdout = await this.diffRange(worktreePath, baseRef, ['--numstat']);
    return this.parseBinaryChangedFiles(stdout);
  }

  private parseBinaryChangedFiles(stdout: string): string[] {
    return stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([added, removed]) => added === '-' && removed === '-')
      .map((parts) => parts.slice(2).join('\t'))
      .filter(Boolean);
  }
}
