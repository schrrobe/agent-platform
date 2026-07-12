/**
 * Getrennte Umgebungen für Agenten, Git und Projektcode. Insbesondere erhalten
 * Test-/Setup-Befehle niemals Modell-Credentials oder das echte HOME.
 */

const RUNTIME_KEYS = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

function runtimeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNTIME_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.CI = '1';
  env.TERM = 'dumb';
  return env;
}

function copy(source: NodeJS.ProcessEnv, target: Record<string, string>, keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (value) target[key] = value;
  }
}

export function buildClaudeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = runtimeEnv(source);
  copy(source, env, ['HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']);
  return env;
}

export function buildCodexEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = runtimeEnv(source);
  copy(source, env, ['HOME', 'OPENAI_API_KEY', 'CODEX_HOME']);
  return env;
}

export function buildGitEnv(
  source: NodeJS.ProcessEnv = process.env,
  isolatedHome?: string,
): Record<string, string> {
  const env = runtimeEnv(source);
  if (isolatedHome) env.HOME = isolatedHome;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function buildTestEnv(
  isolatedHome: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = runtimeEnv(source);
  env.HOME = isolatedHome;
  env.XDG_CONFIG_HOME = `${isolatedHome}/.config`;
  env.XDG_DATA_HOME = `${isolatedHome}/.local/share`;
  env.XDG_CACHE_HOME = `${isolatedHome}/.cache`;
  return env;
}

/** @deprecated Neue Aufrufer müssen eine phasenspezifische Umgebung wählen. */
export const buildChildEnv = buildClaudeEnv;
