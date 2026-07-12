/**
 * Env-Whitelist für Kindprozesse (ADR-016): Agenten und Testbefehle erhalten
 * nur das Nötigste. Secrets wie LINEAR_API_KEY erreichen Kinder nie.
 */
const PASSTHROUGH_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  // Agenten-Auth/-Konfiguration (nur falls gesetzt):
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  // Linux-Konventionen für CLI-Konfigurationen:
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
] as const;

export function buildChildEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.CI = '1';
  env.TERM = 'dumb';
  return { ...env, ...extra };
}
