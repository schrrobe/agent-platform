import path from 'node:path';
import { IDENTIFIER_RE } from '@agent/shared';

export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
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

export function branchForIdentifier(identifier: string): string {
  return `agent/${identifierToSlug(identifier)}`;
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
