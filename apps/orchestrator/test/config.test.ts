import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig model overrides', () => {
  it('verwendet die kuratierten Defaults, wenn Variablen fehlen', () => {
    const config = loadConfig({});
    expect(config.agents.claudeModel).toBe('claude-opus-5');
    expect(config.agents.codexModel).toBe('gpt-5.6-sol');
    expect(config.gitIdentity).toEqual({
      name: 'Robert Schreiner',
      email: 'robsch@stagedates.com',
    });
  });

  it('respektiert leere Variablen als expliziten CLI-Default-Opt-out', () => {
    const config = loadConfig({ CLAUDE_MODEL: '', CODEX_MODEL: '' });
    expect(config.agents.claudeModel).toBeUndefined();
    expect(config.agents.codexModel).toBeUndefined();
  });

  it('akzeptiert ein leeres optionales Claude-Kostenlimit', () => {
    const config = loadConfig({ CLAUDE_MAX_BUDGET_USD: '' });
    expect(config.agents.claudeMaxBudgetUsd).toBeUndefined();
  });

  it('akzeptiert Claude als Implementierungs-Agent', () => {
    expect(loadConfig({ IMPLEMENTATION_AGENT: 'claude' }).agents.implementationAgent).toBe('claude');
  });
});
