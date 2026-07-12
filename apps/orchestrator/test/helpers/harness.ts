import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { LinearService, type LinearClientLike } from '@agent/linear';
import type { AppConfig } from '../../src/config.js';
import { bootstrap } from '../../src/server.js';
import type { AppContext } from '../../src/context.js';
import type { JobState, JobSummary } from '@agent/shared';

const TERMINAL: JobState[] = ['done', 'failed', 'needs_human', 'paused'];

export interface HarnessOptions {
  reviewSequence?: string;
  testCommand?: string | null;
  maxReviewLoops?: number;
  maxJobRuntimeMs?: number;
  maxConcurrentJobs?: number;
  /** Codex bricht künstlich ab (Exit-Code ungleich 0). */
  codexFails?: boolean;
  /** Codex erzeugt keine Änderung (für needs_human bei leerem Diff). */
  codexNoChange?: boolean;
  /** Fake-Linear-Client für Import-Tests. */
  linearClient?: LinearClientLike;
  linearWriteComments?: boolean;
}

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  tmp: string;
  repoDir: string;
  worktreeRoot: string;
  projectId: string;
  stateFile: string;
  seedJob(identifier?: string): JobSummary;
  waitForState(jobId: string, states?: JobState[], timeoutMs?: number): Promise<JobState>;
  cleanup(): Promise<void>;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@localhost',
    },
    stdio: 'ignore',
  });
}

export function nodeCommand(code: string): string {
  return `${process.execPath} -e "${code}"`;
}

/** Fake-Claude als eigenständiges, per Test konfiguriertes Node-Skript. */
function claudeScript(stateFile: string, reviewSequence: string): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
const STATE = ${JSON.stringify(stateFile)};
const SEQ = ${JSON.stringify(reviewSequence)}.split(',').map((s) => s.trim());
const prompt = process.argv[process.argv.length - 1] ?? '';
const isReview = prompt.includes('Code-Reviewer') || prompt.includes('VERDICT: PASS');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
let result;
if (isReview) {
  const s = load();
  const idx = s.review ?? 0; s.review = idx + 1; save(s);
  const verdict = SEQ[Math.min(idx, SEQ.length - 1)];
  result = verdict === 'PASS'
    ? 'VERDICT: PASS\\n\\nAlle Akzeptanzkriterien erfuellt.'
    : ['VERDICT: FAIL','','# Review-Ergebnis','','VERDICT: FAIL','','## Zusammenfassung','Noch nicht fertig.','','## Gefundene Probleme','','### Problem 1','- Schweregrad: hoch','- Datei: impl.txt','- Beobachtung: Fix fehlt','- Erforderliche Korrektur: fixed.txt anlegen'].join('\\n');
} else {
  result = ['# Ziel','x','# Akzeptanzkriterien','- x','# Betroffene Architektur','x','# Relevante Dateien','- impl.txt','# Implementierungsschritte','1. x','# Teststrategie','x','# Risiken','x','# Annahmen','x','# Nicht-Ziele','x'].join('\\n');
}
process.stdout.write(JSON.stringify({ type: 'result', result }));
`;
}

/** Fake-Codex als eigenständiges, per Test konfiguriertes Node-Skript. */
function codexScript(stateFile: string, opts: { fails: boolean; noChange: boolean }): string {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const STATE = ${JSON.stringify(stateFile)};
const FAILS = ${opts.fails ? 'true' : 'false'};
const NO_CHANGE = ${opts.noChange ? 'true' : 'false'};
const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const cwd = val('-C') ?? process.cwd();
const lastMsg = val('--output-last-message');
const load = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const s = load(); const run = (s.codex ?? 0) + 1; s.codex = run; save(s);
if (FAILS) { process.stderr.write('codex fake failure\\n'); process.exit(2); }
if (!NO_CHANGE) {
  fs.writeFileSync(path.join(cwd, 'impl.txt'), 'Implementierung Lauf ' + run + '\\n');
  if (fs.existsSync(path.join(cwd, '.agent', 'REVIEW.md'))) {
    fs.writeFileSync(path.join(cwd, 'fixed.txt'), 'fixed\\n');
  }
}
if (lastMsg) fs.writeFileSync(lastMsg, 'Codex-Lauf ' + run);
process.stdout.write('codex fake run ' + run + '\\n');
`;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-'));
  const repoDir = path.join(tmp, 'repo');
  const worktreeRoot = path.join(tmp, 'worktrees');
  const dataDir = path.join(tmp, 'data');
  const binDir = path.join(tmp, 'bin');
  for (const dir of [repoDir, worktreeRoot, dataDir, binDir]) fs.mkdirSync(dir, { recursive: true });

  git(repoDir, ['init', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n');
  git(repoDir, ['add', '-A']);
  git(repoDir, ['commit', '-m', 'init']);

  const stateFile = path.join(tmp, 'fake-state.json');
  fs.writeFileSync(stateFile, '{}');

  const claudeBin = path.join(binDir, 'fake-claude.mjs');
  const codexBin = path.join(binDir, 'fake-codex.mjs');
  fs.writeFileSync(claudeBin, claudeScript(stateFile, options.reviewSequence ?? 'PASS'));
  fs.writeFileSync(
    codexBin,
    codexScript(stateFile, { fails: options.codexFails ?? false, noChange: options.codexNoChange ?? false }),
  );
  fs.chmodSync(claudeBin, 0o755);
  fs.chmodSync(codexBin, 0o755);

  const config: AppConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    dataDir,
    logsDir: path.join(dataDir, 'logs'),
    linear: { apiKey: '', writeComments: false },
    defaults: { repoRoot: '', worktreeRoot: '', baseBranch: 'main' },
    agents: {
      claudeBin,
      codexBin,
      claudeModel: undefined,
      codexModel: undefined,
      claudeMaxBudgetUsd: undefined,
    },
    limits: {
      maxReviewLoops: options.maxReviewLoops ?? 3,
      maxJobRuntimeMs: options.maxJobRuntimeMs ?? 30_000,
      maxAgentOutputBytes: 5 * 1024 * 1024,
      maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
      testCommandTimeoutMs: 15_000,
    },
    logLevel: 'silent',
  };

  const linear = options.linearClient
    ? new LinearService({ client: options.linearClient, writeComments: options.linearWriteComments })
    : undefined;
  const { app, ctx } = await bootstrap({
    config,
    logger: pino({ level: 'silent' }),
    context: linear ? { linear } : undefined,
  });

  const testCommand =
    options.testCommand === null ? undefined : (options.testCommand ?? nodeCommand('process.exit(0)'));
  const project = ctx.repos.projects.insert({
    name: 'E2E',
    repositoryPath: repoDir,
    baseBranch: 'main',
    worktreeRoot,
    commands: testCommand ? { test: testCommand } : {},
    active: true,
  });

  let counter = 0;
  const seedJob = (identifier = `APP-${(counter += 1)}`): JobSummary => {
    const ticket = ctx.repos.tickets.upsert({
      projectId: project.id,
      linearIssueId: `lin-${identifier}`,
      identifier,
      title: `Ticket ${identifier}`,
      description: 'Test',
      url: `https://linear.app/x/${identifier}`,
      teamKey: 'APP',
      teamName: 'App',
      priority: 2,
      priorityLabel: 'High',
      labels: [],
      linearState: 'Todo',
      linearCreatedAt: null,
      linearUpdatedAt: null,
    });
    const job = ctx.repos.jobs.insert({ ticketId: ticket.id, projectId: project.id, baseBranch: 'main' });
    return ctx.repos.jobs.getSummary(job.id)!;
  };

  const waitForState = async (
    jobId: string,
    states: JobState[] = TERMINAL,
    timeoutMs = 25_000,
  ): Promise<JobState> => {
    const start = Date.now();
    for (;;) {
      const job = ctx.repos.jobs.get(jobId);
      if (job && states.includes(job.state)) return job.state;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout: Job ${jobId} erreichte ${states.join('/')} nicht (aktuell: ${job?.state})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const cleanup = async (): Promise<void> => {
    ctx.queue.abortAll('Test-Cleanup');
    await app.close();
    ctx.db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return {
    ctx,
    app,
    tmp,
    repoDir,
    worktreeRoot,
    projectId: project.id,
    stateFile,
    seedJob,
    waitForState,
    cleanup,
  };
}
