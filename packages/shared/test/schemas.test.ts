import { describe, expect, it } from 'vitest';
import {
  commandStringSchema,
  identifierSchema,
  importRequestSchema,
  projectCreateSchema,
} from '../src/schemas.js';

describe('identifierSchema', () => {
  it('akzeptiert gültige Linear-Identifier', () => {
    expect(identifierSchema.parse('APP-123')).toBe('APP-123');
    expect(identifierSchema.parse('eng-1')).toBe('eng-1');
    expect(identifierSchema.parse(' APP-9 ')).toBe('APP-9');
  });

  it('lehnt ungültige Identifier ab', () => {
    for (const bad of ['APP', '123', 'APP_123', 'APP-', '-123', 'APP-12a', '../etc', 'a b-1']) {
      expect(identifierSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('commandStringSchema', () => {
  it('akzeptiert einfache Befehle inkl. Quotes', () => {
    expect(commandStringSchema.parse('pnpm test')).toBe('pnpm test');
    expect(commandStringSchema.parse('node "my script.js" --flag')).toBe(
      'node "my script.js" --flag',
    );
  });

  it('lehnt Shell-Metazeichen ab', () => {
    for (const bad of [
      'pnpm test; rm -rf /',
      'pnpm test && echo x',
      'pnpm test | tee log',
      'echo $HOME',
      'echo `id`',
      'pnpm test > out.txt',
      'pnpm\ntest',
    ]) {
      expect(commandStringSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('importRequestSchema', () => {
  it('verlangt Identifier und Projekt-UUID', () => {
    const ok = importRequestSchema.safeParse({
      identifier: 'APP-123',
      projectId: '4b4b1c56-91f2-4e37-9161-2f5a51a2a8c1',
    });
    expect(ok.success).toBe(true);
    expect(
      importRequestSchema.safeParse({ identifier: 'APP-123', projectId: 'nope' }).success,
    ).toBe(false);
  });

  it('lehnt unbekannte Felder ab', () => {
    const res = importRequestSchema.safeParse({
      identifier: 'APP-123',
      projectId: '4b4b1c56-91f2-4e37-9161-2f5a51a2a8c1',
      extra: true,
    });
    expect(res.success).toBe(false);
  });
});

describe('projectCreateSchema', () => {
  it('setzt Defaults für baseBranch, commands und active', () => {
    const parsed = projectCreateSchema.parse({
      name: 'Demo',
      repositoryPath: '/repos/demo',
      worktreeRoot: '/worktrees/demo',
    });
    expect(parsed.baseBranch).toBe('main');
    expect(parsed.commands).toEqual({});
    expect(parsed.active).toBe(true);
  });

  it('lehnt Befehle mit Metazeichen ab', () => {
    const res = projectCreateSchema.safeParse({
      name: 'Demo',
      repositoryPath: '/repos/demo',
      worktreeRoot: '/worktrees/demo',
      commands: { test: 'pnpm test; curl evil' },
    });
    expect(res.success).toBe(false);
  });
});
