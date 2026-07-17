import path from 'node:path';
import { IDENTIFIER_RE } from '@agent/shared';

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}

export const BRANCH_KINDS = ['fix', 'chore', 'feature'] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

/** Leitet eine übliche Branch-Kategorie deterministisch aus Ticket-Metadaten ab. */
export function branchKindForTicket(title: string, labels: readonly string[]): BranchKind {
  const terms = [title, ...labels].map((value) => value.trim().toLowerCase());
  if (terms.some((value) => /(^|[\s:/_-])(bug|bugfix|defect|fix|hotfix)([\s:/_-]|$)/.test(value))) {
    return 'fix';
  }
  if (
    terms.some((value) =>
      /(^|[\s:/_-])(chore|ci|deps|dependencies|dependency|docs|documentation|maintenance|refactor|test)([\s:/_-]|$)/.test(
        value,
      ),
    )
  ) {
    return 'chore';
  }
  return 'feature';
}

/** true, wenn `child` strikt innerhalb von `parent` liegt (nicht identisch). */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isSameOrInside(parent: string, child: string): boolean {
  return path.resolve(parent) === path.resolve(child) || isPathInside(parent, child);
}

/** `APP-123` → `app-123`; wirft bei allem, was kein Linear-Identifier ist. */
export function identifierToSlug(identifier: string): string {
  const trimmed = identifier.trim();
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new PathValidationError(`Ungültiger Ticket-Identifier: ${identifier}`);
  }
  return trimmed.toLowerCase();
}

export function branchForIdentifier(identifier: string, kind: BranchKind = 'feature'): string {
  return `${kind}/${identifierToSlug(identifier)}`;
}

/** Erzeugt aus einem Ticket-Titel einen kurzen, Git-sicheren und lesbaren Slug. */
export function ticketTitleToSlug(title: string): string {
  const slug = title
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('ß', 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return slug || 'ticket';
}

export function branchForTicket(
  identifier: string,
  title: string,
  kind: BranchKind = 'feature',
): string {
  return `${branchForIdentifier(identifier, kind)}/${ticketTitleToSlug(title)}`;
}

export function jobSuffix(jobId: string): string {
  const normalized = jobId.trim().toLowerCase();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(normalized)) {
    throw new PathValidationError(`Ungültige Job-ID für Git-Pfad: ${jobId}`);
  }
  return normalized.replaceAll('-', '');
}

/**
 * Berechnet den Worktree-Pfad und garantiert, dass er innerhalb des
 * konfigurierten Worktree-Roots bleibt (Pfad-Traversal-Schutz).
 */
export function worktreePathFor(worktreeRoot: string, identifier: string): string {
  const slug = identifierToSlug(identifier);
  const resolved = path.resolve(worktreeRoot, slug);
  if (!isPathInside(worktreeRoot, resolved)) {
    throw new PathValidationError(
      `Worktree-Pfad ${resolved} liegt außerhalb von ${path.resolve(worktreeRoot)}`,
    );
  }
  return resolved;
}

export function worktreePathForJob(
  worktreeRoot: string,
  identifier: string,
  jobId: string,
): string {
  const slug = `${identifierToSlug(identifier)}-${jobSuffix(jobId)}`;
  const resolved = path.resolve(worktreeRoot, slug);
  if (!isPathInside(worktreeRoot, resolved)) {
    throw new PathValidationError(
      `Worktree-Pfad ${resolved} liegt außerhalb von ${path.resolve(worktreeRoot)}`,
    );
  }
  return resolved;
}
