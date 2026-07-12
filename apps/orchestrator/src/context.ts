import path from 'node:path';
import type { Logger } from 'pino';
import { ClaudeCodeAdapter, CodexCliAdapter, ProcessExecutor, buildChildEnv } from '@agent/agents';
import { GitService } from '@agent/git';
import { LinearService } from '@agent/linear';
import { createRepositories, type AppDatabase, type Repositories } from '@agent/database';
import type { AppConfig } from './config.js';
import { EventBus } from './events/bus.js';
import { Publisher } from './events/publisher.js';
import { LogStore } from './services/log-store.js';
import { KeyedMutex } from './services/mutex.js';
import { JobPipeline } from './pipeline/pipeline.js';
import { JobQueue } from './pipeline/queue.js';
import { JobService } from './services/job-service.js';

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: AppDatabase;
  repos: Repositories;
  bus: EventBus;
  publisher: Publisher;
  logStore: LogStore;
  linear: LinearService;
  git: GitService;
  executor: ProcessExecutor;
  queue: JobQueue;
  pipeline: JobPipeline;
  jobs: JobService;
}

export interface ContextOverrides {
  /** Ersatz-LinearService (Tests injizieren einen Fake-Client). */
  linear?: LinearService;
}

export function createContext(
  config: AppConfig,
  logger: Logger,
  db: AppDatabase,
  overrides: ContextOverrides = {},
): AppContext {
  const repos = createRepositories(db);
  const bus = new EventBus();
  const publisher = new Publisher(bus, repos.jobEvents);
  const logStore = new LogStore(config.logsDir);
  const childEnv = buildChildEnv(process.env);

  const executor = new ProcessExecutor();
  const git = new GitService({ runner: executor, env: childEnv });
  const linear =
    overrides.linear ??
    new LinearService({
      apiKey: config.linear.apiKey || undefined,
      writeComments: config.linear.writeComments,
    });

  const claude = new ClaudeCodeAdapter({
    runner: executor,
    env: childEnv,
    bin: config.agents.claudeBin,
    model: config.agents.claudeModel,
    maxBudgetUsd: config.agents.claudeMaxBudgetUsd,
  });
  const codex = new CodexCliAdapter({
    runner: executor,
    env: childEnv,
    bin: config.agents.codexBin,
    model: config.agents.codexModel,
    lastMessageDir: path.join(config.dataDir, 'codex-runs'),
  });

  const pipeline = new JobPipeline({
    config,
    logger,
    repos,
    git,
    claude,
    codex,
    linear,
    publisher,
    logStore,
    executor,
    childEnv,
  });
  const queue = new JobQueue({ pipeline, config, logger, repos });
  const mutex = new KeyedMutex();
  const jobs = new JobService({ config, repos, publisher, queue, linear, logStore, mutex });

  return {
    config,
    logger,
    db,
    repos,
    bus,
    publisher,
    logStore,
    linear,
    git,
    executor,
    queue,
    pipeline,
    jobs,
  };
}
