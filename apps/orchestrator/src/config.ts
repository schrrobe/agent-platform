import path from 'node:path';
import { z } from 'zod';

/**
 * Konfiguration aus Umgebungsvariablen, validiert mit Zod. Bei ungültiger
 * Konfiguration bricht die Anwendung mit einer verständlichen Meldung ab.
 * Pfade werden gegen ein stabiles Basisverzeichnis aufgelöst (INIT_CWD, von
 * pnpm gesetzt) — so trifft `pnpm db:migrate` dieselbe DB wie `pnpm dev`.
 */

const booleanString = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().default('./data/orchestrator.db'),
  DATA_DIR: z.string().default('./data'),

  LINEAR_API_KEY: z.string().optional().default(''),
  LINEAR_WRITE_COMMENTS: booleanString.default(false),

  REPO_ROOT: z.string().optional().default(''),
  WORKTREE_ROOT: z.string().optional().default(''),
  BASE_BRANCH: z.string().default('main'),

  CLAUDE_BIN: z.string().default('claude'),
  CODEX_BIN: z.string().default('codex'),
  SRT_BIN: z.string().default('srt'),
  CLAUDE_MODEL: z.string().optional().default('opus'),
  CODEX_MODEL: z.string().optional().default('gpt-5.6-sol'),
  CLAUDE_EFFORT: z.enum(['low', 'medium', 'high']).default('high'),
  CODEX_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  CLAUDE_MAX_BUDGET_USD: z.coerce.number().positive().optional(),

  MAX_REVIEW_LOOPS: z.coerce.number().int().min(0).max(50).default(3),
  MAX_JOB_RUNTIME_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  MAX_AGENT_OUTPUT_MB: z.coerce.number().int().min(1).max(500).default(10),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(16).default(1),
  TEST_COMMAND_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(240).default(10),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  host: string;
  port: number;
  databasePath: string;
  dataDir: string;
  logsDir: string;
  linear: {
    apiKey: string;
    writeComments: boolean;
  };
  defaults: {
    repoRoot: string;
    worktreeRoot: string;
    baseBranch: string;
  };
  agents: {
    claudeBin: string;
    codexBin: string;
    srtBin: string;
    claudeModel: string | undefined;
    codexModel: string | undefined;
    claudeEffort: 'low' | 'medium' | 'high';
    codexEffort: 'low' | 'medium' | 'high';
    claudeMaxBudgetUsd: number | undefined;
  };
  limits: {
    maxReviewLoops: number;
    maxJobRuntimeMs: number;
    maxAgentOutputBytes: number;
    maxConcurrentJobs: number;
    testCommandTimeoutMs: number;
  };
  logLevel: string;
}

export function baseDir(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function resolveFromBase(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir(), value);
}

/** Lädt `.env` (falls vorhanden) aus dem Basisverzeichnis. */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile(path.join(baseDir(), '.env'));
  } catch {
    // Keine .env — Shell-Umgebung gilt.
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Ungültige Konfiguration:\n${issues}`);
  }
  const env = parsed.data;
  const dataDir = resolveFromBase(env.DATA_DIR);
  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databasePath:
      env.DATABASE_PATH === ':memory:' ? ':memory:' : resolveFromBase(env.DATABASE_PATH),
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    linear: {
      apiKey: env.LINEAR_API_KEY,
      writeComments: env.LINEAR_WRITE_COMMENTS,
    },
    defaults: {
      repoRoot: env.REPO_ROOT ? resolveFromBase(env.REPO_ROOT) : '',
      worktreeRoot: env.WORKTREE_ROOT ? resolveFromBase(env.WORKTREE_ROOT) : '',
      baseBranch: env.BASE_BRANCH,
    },
    agents: {
      claudeBin: env.CLAUDE_BIN,
      codexBin: env.CODEX_BIN,
      srtBin: env.SRT_BIN,
      claudeModel: env.CLAUDE_MODEL === '' ? undefined : env.CLAUDE_MODEL,
      codexModel: env.CODEX_MODEL === '' ? undefined : env.CODEX_MODEL,
      claudeEffort: env.CLAUDE_EFFORT,
      codexEffort: env.CODEX_EFFORT,
      claudeMaxBudgetUsd: env.CLAUDE_MAX_BUDGET_USD,
    },
    limits: {
      maxReviewLoops: env.MAX_REVIEW_LOOPS,
      maxJobRuntimeMs: env.MAX_JOB_RUNTIME_MINUTES * 60_000,
      maxAgentOutputBytes: env.MAX_AGENT_OUTPUT_MB * 1024 * 1024,
      maxConcurrentJobs: env.MAX_CONCURRENT_JOBS,
      testCommandTimeoutMs: env.TEST_COMMAND_TIMEOUT_MINUTES * 60_000,
    },
    logLevel: env.LOG_LEVEL,
  };
}
