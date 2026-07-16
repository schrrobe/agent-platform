import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig model overrides', () => {
  it('verwendet die kuratierten Defaults, wenn Variablen fehlen', () => {
    const config = loadConfig({});
    expect(config.agents.claudeModel).toBe('opus');
    expect(config.agents.codexModel).toBe('gpt-5.6-sol');
  });

  it('respektiert leere Variablen als expliziten CLI-Default-Opt-out', () => {
    const config = loadConfig({ CLAUDE_MODEL: '', CODEX_MODEL: '' });
    expect(config.agents.claudeModel).toBeUndefined();
    expect(config.agents.codexModel).toBeUndefined();
  });
});
