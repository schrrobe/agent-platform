import path from 'node:path';
import fs from 'node:fs';
import type { Logger } from 'pino';
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  ProcessExecutor,
  buildClaudeEnv,
  buildCodexEnv,
  buildGitEnv,
  buildGithubEnv,
} from '@agent/agents';
import { GitService } from '@agent/git';
import { LinearService } from '@agent/linear';
import { createRepositories, type AppDatabase, type Repositories } from '@agent/database';
import type { AppConfig } from './config.js';
import { EventBus } from './events/bus.js';
import { Publisher } from './events/publisher.js';
import { LogStore } from './services/log-store.js';
import { KeyedMutex } from './services/mutex.js';
import { TestSandbox } from './services/test-sandbox.js';
import { JobPipeline } from './pipeline/pipeline.js';
import { JobQueue } from './pipeline/queue.js';
import { JobService } from './services/job-service.js';
import { GithubCliClient } from './services/github-client.js';
import { GithubReviewService } from './services/github-review.js';

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
  testSandbox: TestSandbox;
  queue: JobQueue;
  pipeline: JobPipeline;
  jobs: JobService;
  githubReviews: GithubReviewService;
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
  const gitHome = path.join(config.dataDir, 'git-home');
  fs.mkdirSync(gitHome, { recursive: true });
  const gitEnv = buildGitEnv(process.env, gitHome);
  const claudeEnv = buildClaudeEnv(process.env);
  const codexEnv = buildCodexEnv(process.env);
  const githubEnv = buildGithubEnv(process.env);

  const executor = new ProcessExecutor();
  const git = new GitService({ runner: executor, env: gitEnv });
  const testSandbox = new TestSandbox({
    runner: executor,
    dataDir: config.dataDir,
    srtBin: config.agents.srtBin,
  });
  const linear =
    overrides.linear ??
    new LinearService({
      apiKey: config.linear.apiKey || undefined,
      writeComments: config.linear.writeComments,
    });

  const claude = new ClaudeCodeAdapter({
    runner: executor,
    env: claudeEnv,
    bin: config.agents.claudeBin,
    model: config.agents.claudeModel,
    effort: config.agents.claudeEffort,
    maxBudgetUsd: config.agents.claudeMaxBudgetUsd,
  });
  const codex = new CodexCliAdapter({
    runner: executor,
    env: codexEnv,
    bin: config.agents.codexBin,
    model: config.agents.codexModel,
    reasoningEffort: config.agents.codexEffort,
    lastMessageDir: path.join(config.dataDir, 'codex-runs'),
  });

  const pipeline = new JobPipeline({
    config,
    logger,
    repos,
    git,
    planner: claude,
    implementer: codex,
    reviewer: claude,
    linear,
    publisher,
    logStore,
    testSandbox,
  });
  const queue = new JobQueue({ pipeline, config, logger, repos });
  const mutex = new KeyedMutex();
  const jobs = new JobService({ config, repos, publisher, queue, linear, logStore, mutex });
  const github = new GithubCliClient(executor, githubEnv);
  const githubReviews = new GithubReviewService({
    config,
    repos,
    git,
    codex,
    github,
    publisher,
    logStore,
    queue,
    pipeline,
  });

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
    testSandbox,
    queue,
    pipeline,
    jobs,
    githubReviews,
  };
}
