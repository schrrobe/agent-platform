import { describe, expect, it } from 'vitest';
import {
  PathValidationError,
  branchKindForTicket,
  branchForIdentifier,
  branchForTicket,
  identifierToSlug,
  isPathInside,
  ticketTitleToSlug,
  worktreePathFor,
  worktreePathForJob,
} from '../src/paths.js';

describe('isPathInside', () => {
  it('erkennt echte Unterpfade', () => {
    expect(isPathInside('/worktrees', '/worktrees/app-123')).toBe(true);
    expect(isPathInside('/worktrees', '/worktrees/a/b/c')).toBe(true);
  });

  it('lehnt identische, benachbarte und Traversal-Pfade ab', () => {
    expect(isPathInside('/worktrees', '/worktrees')).toBe(false);
    expect(isPathInside('/worktrees', '/worktrees/../etc')).toBe(false);
    expect(isPathInside('/worktrees', '/etc')).toBe(false);
    expect(isPathInside('/worktrees', '/worktrees-other/x')).toBe(false);
  });
});

describe('identifierToSlug / branchForIdentifier', () => {
  it('normalisiert gültige Identifier', () => {
    expect(identifierToSlug('APP-123')).toBe('app-123');
    expect(branchForIdentifier('APP-123')).toBe('feature/app-123');
    expect(branchForTicket('APP-123', 'Login für größere Kunden', 'fix')).toBe(
      'fix/app-123/login-fur-grossere-kunden',
    );
    expect(ticketTitleToSlug('  Größe & Übersicht  ')).toBe('grosse-ubersicht');
  });

  it('verwendet konventionelle Kategorien aus Ticket-Metadaten', () => {
    expect(branchKindForTicket('Login funktioniert nicht', ['bug', 'ui'])).toBe('fix');
    expect(branchKindForTicket('Dependencies aktualisieren', ['maintenance'])).toBe('chore');
    expect(branchKindForTicket('Export hinzufügen', ['enhancement'])).toBe('feature');
    expect(branchForIdentifier('APP-123', 'fix')).toBe('fix/app-123');
  });

  it('wirft bei Pfad-Traversal-Versuchen und ungültigen Formaten', () => {
    for (const bad of ['../etc', 'APP-123/../x', 'APP 123', 'APP-', '.hidden-1x', 'a/b-1']) {
      expect(() => identifierToSlug(bad), bad).toThrow(PathValidationError);
    }
  });
});

describe('worktreePathFor', () => {
  it('baut Pfade innerhalb des Worktree-Roots', () => {
    expect(worktreePathFor('/worktrees/demo', 'APP-123')).toBe('/worktrees/demo/app-123');
    expect(
      worktreePathForJob('/worktrees/demo', 'APP-123', '11111111-1111-4111-8111-111111111111'),
    ).toBe('/worktrees/demo/app-123-11111111111141118111111111111111');
  });

  it('kann durch Identifier nicht aus dem Root ausbrechen', () => {
    expect(() => worktreePathFor('/worktrees/demo', '../../APP-123')).toThrow(PathValidationError);
  });
});
