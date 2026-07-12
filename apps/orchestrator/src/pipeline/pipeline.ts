import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import {
  buildImplementPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  parseVerdict,
  type ClaudeCodeAdapter,
  type CodexCliAdapter,
} from '@agent/agents';
import { AGENT_DIR, type GitService } from '@agent/git';
import type { LinearService } from '@agent/linear';
import { decideAfterFailedTests, decideAfterReview, assertTransition } from '@agent/workflow';
import {
  COMMAND_KEYS,
  type AgentName,
  type AgentPhase,
  type Job,
  type JobState,
  type Project,
  type ProcessRunner,
  type Ticket,
} from '@agent/shared';
import type { Repositories } from '@agent/database';
import type { AppConfig } from '../config.js';
import type { Publisher } from '../events/publisher.js';
import type { LogStore } from '../services/log-store.js';
import { tokenizeCommand } from '../services/command.js';
import { PipelineAbort, abortReasonOf } from './errors.js';

export interface PipelineDeps {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  git: GitService;
  claude: ClaudeCodeAdapter;
  codex: CodexCliAdapter;
  linear: LinearService;
  publisher: Publisher;
  logStore: LogStore;
  executor: ProcessRunner;
  childEnv: Record<string, string>;
}

/** Vom Menschen zu behandelnder Ausgang (kein Infrastrukturfehler). */
class NeedsHumanOutcome {
  constructor(readonly message: string) {}
}

/**
 * Deterministische Ausführung eines Jobs durch die Workflow-Phasen. Die
 * Zustandslogik (Übergänge, Limits, Ausgänge) liegt hier und in der
 * Workflow-Engine — nie im Agenten. Pause wird an Phasengrenzen ausgewertet,
 * Cancel/Deadline über das AbortSignal (ADR-007, ADR-008).
 */
export class JobPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async run(jobId: string, signal: AbortSignal): Promise<void> {
    const log = this.deps.logger.child({ jobId });
    const loaded = this.load(jobId);
    if (!loaded) {
      log.warn('Job für Pipeline nicht gefunden');
      return;
    }
    const { project, ticket } = loaded;

    try {
      await this.ensureWorktreeReady(jobId, project, ticket, log);

      // Planung
      if (await this.boundary(jobId, signal)) return;
      await this.transition(jobId, 'planning', 'Planung gestartet');
      await this.planPhase(jobId, ticket, project, signal, log);

      // Implementierungs-/Test-/Review-Schleife
      for (;;) {
        const job = this.mustJob(jobId);
        const iteration = job.reviewLoopCount + 1;
        const isRework = job.reviewLoopCount > 0;

        if (await this.boundary(jobId, signal)) return;
        await this.transition(jobId, 'implementing', 'Implementierung gestartet');
        await this.implementPhase(jobId, ticket, project, iteration, isRework, signal, log);

        if (await this.boundary(jobId, signal)) return;
        await this.transition(jobId, 'testing', 'Tests gestartet');
        const testsOk = await this.testPhase(jobId, project, iteration, signal, log);

        if (!testsOk) {
          const next = decideAfterFailedTests({
            reviewLoopCount: job.reviewLoopCount,
            maxReviewLoops: this.deps.config.limits.maxReviewLoops,
          });
          if (next === 'needs_human') {
            await this.finishNeedsHuman(jobId, 'Pflichtprüfungen nach maximaler Schleifenzahl weiterhin rot');
            return;
          }
          await this.enterRework(jobId, 'Tests fehlgeschlagen — Nacharbeit');
          continue;
        }

        if (await this.boundary(jobId, signal)) return;
        await this.transition(jobId, 'review', 'Review gestartet');
        const verdict = await this.reviewPhase(jobId, ticket, project, iteration, signal, log);

        if (verdict === 'PASS') {
          await this.finishDone(jobId, ticket);
          return;
        }
        const next = decideAfterReview('FAIL', {
          reviewLoopCount: job.reviewLoopCount,
          maxReviewLoops: this.deps.config.limits.maxReviewLoops,
        });
        if (next === 'needs_human') {
          await this.finishNeedsHuman(jobId, 'Review nach maximaler Schleifenzahl weiterhin FAIL');
          return;
        }
        await this.enterRework(jobId, 'Review fehlgeschlagen — Nacharbeit');
      }
    } catch (error) {
      if (error instanceof PipelineAbort) throw error;
      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal), { cause: error });
      if (error instanceof NeedsHumanOutcome) {
        await this.finishNeedsHuman(jobId, error.message);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, 'Pipeline-Fehler');
      await this.fail(jobId, message);
    }
  }

  // ---- Phasen ---------------------------------------------------------------

  private async ensureWorktreeReady(
    jobId: string,
    project: Project,
    ticket: Ticket,
    log: Logger,
  ): Promise<void> {
    const result = await this.deps.git.ensureWorktree({
      repositoryPath: project.repositoryPath,
      worktreeRoot: project.worktreeRoot,
      identifier: ticket.identifier,
      baseBranch: project.baseBranch,
    });
    await this.deps.git.cleanWorktree(result.worktreePath);
    this.deps.repos.jobs.update(jobId, {
      worktreePath: result.worktreePath,
      branch: result.branch,
    });
    this.system(jobId, `Worktree bereit: ${result.worktreePath} (${result.branch})`);
    log.info({ worktree: result.worktreePath, branch: result.branch }, 'Worktree bereit');
  }

  private async planPhase(
    jobId: string,
    ticket: Ticket,
    project: Project,
    signal: AbortSignal,
    log: Logger,
  ): Promise<void> {
    const job = this.mustJob(jobId);
    const prompt = buildPlanPrompt({ ticket, baseBranch: project.baseBranch });
    const result = await this.runAgent(
      { jobId, phase: 'plan', agent: 'claude', prompt, cwd: this.worktree(job) },
      this.deps.claude,
      signal,
    );
    if (result.status !== 'completed' || result.output.trim().length === 0) {
      throw new NeedsHumanOutcome(`Planung nicht verwertbar: ${result.error ?? 'leere Ausgabe'}`);
    }
    await this.writeArtifactFile(job, 'PLAN.md', result.output);
    this.recordArtifact(jobId, result.runId, 'plan', path.join(this.worktree(job), AGENT_DIR, 'PLAN.md'), result.output);
    log.info('PLAN.md erstellt');
  }

  private async implementPhase(
    jobId: string,
    ticket: Ticket,
    project: Project,
    iteration: number,
    isRework: boolean,
    signal: AbortSignal,
    log: Logger,
  ): Promise<void> {
    const job = this.mustJob(jobId);
    const worktree = this.worktree(job);
    const testFeedback = isRework ? this.buildTestReport(jobId, iteration - 1) : null;
    const prompt = buildImplementPrompt({ ticket, isRework, testFeedback });
    const result = await this.runAgent(
      { jobId, phase: isRework ? 'rework' : 'implement', agent: 'codex', prompt, cwd: worktree },
      this.deps.codex,
      signal,
    );
    if (result.status !== 'completed') {
      throw new Error(`Codex-Implementierung fehlgeschlagen: ${result.error ?? 'unbekannt'}`);
    }
    this.recordArtifact(jobId, result.runId, 'summary', null, result.output);

    const commit = await this.deps.git.commitAll(worktree, `agent: ${ticket.identifier} Iteration ${iteration}`);
    const changed = await this.deps.git.changedFiles(worktree, project.baseBranch);
    if (!commit && changed.length === 0) {
      throw new NeedsHumanOutcome('Codex hat keine Dateiänderungen vorgenommen');
    }
    this.system(jobId, `Implementierung committet (${changed.length} geänderte Dateien${commit ? `, ${commit.slice(0, 8)}` : ''})`);
    log.info({ changedFiles: changed.length }, 'Implementierung abgeschlossen');
  }

  private async testPhase(
    jobId: string,
    project: Project,
    iteration: number,
    signal: AbortSignal,
    log: Logger,
  ): Promise<boolean> {
    const job = this.mustJob(jobId);
    const worktree = this.worktree(job);
    const configured = COMMAND_KEYS.filter((key) => project.commands[key]);
    if (configured.length === 0) {
      this.system(jobId, 'Keine Projektbefehle konfiguriert — Testphase übersprungen');
      return true;
    }
    for (const key of configured) {
      const commandString = project.commands[key] as string;
      const testRun = this.deps.repos.testRuns.insert({ jobId, iteration, commandKey: key, command: commandString });
      this.deps.publisher.emit('test.started', jobId, { testRunId: testRun.id, commandKey: key, command: commandString });

      let command: string;
      let args: string[];
      try {
        ({ command, args } = tokenizeCommand(commandString));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.repos.testRuns.update(testRun.id, { status: 'failed', exitCode: null, stderr: message, finishedAt: new Date().toISOString() });
        throw new Error(`Ungültiger ${key}-Befehl: ${message}`, { cause: error });
      }

      const handle = this.deps.executor.run({
        command,
        args,
        cwd: worktree,
        env: this.deps.childEnv,
        timeoutMs: this.deps.config.limits.testCommandTimeoutMs,
        maxOutputBytes: this.deps.config.limits.maxAgentOutputBytes,
        onOutput: (chunk) => {
          this.deps.logStore.append(jobId, { ts: new Date().toISOString(), source: 'test', stream: chunk.stream, text: chunk.text });
          this.deps.publisher.emit('test.output', jobId, { testRunId: testRun.id, stream: chunk.stream, text: chunk.text });
        },
      });
      const onAbort = () => handle.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      let result;
      try {
        result = await handle.result;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      const status = result.timedOut ? 'timeout' : result.canceled ? 'canceled' : result.exitCode === 0 ? 'completed' : 'failed';
      const finished = this.deps.repos.testRuns.update(testRun.id, {
        status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        finishedAt: new Date().toISOString(),
      });
      this.deps.publisher.emit('test.completed', jobId, { testRun: finished });

      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
      if (result.exitCode !== 0) {
        this.system(jobId, `Prüfung '${key}' fehlgeschlagen (Exit ${result.exitCode ?? 'n/a'})`);
        log.warn({ commandKey: key, exitCode: result.exitCode }, 'Pflichtprüfung fehlgeschlagen');
        return false;
      }
    }
    this.system(jobId, 'Alle Pflichtprüfungen bestanden');
    return true;
  }

  private async reviewPhase(
    jobId: string,
    ticket: Ticket,
    project: Project,
    iteration: number,
    signal: AbortSignal,
    log: Logger,
  ): Promise<'PASS' | 'FAIL'> {
    const job = this.mustJob(jobId);
    const worktree = this.worktree(job);
    const diff = await this.deps.git.diffAgainstBase(worktree, project.baseBranch);
    const changed = await this.deps.git.changedFiles(worktree, project.baseBranch);
    // Diff als Artefakt sichern, damit die UI ihn anzeigen kann.
    this.deps.repos.artifacts.insert({ jobId, type: 'diff', content: diff });
    const plan = this.deps.repos.artifacts.latestByType(jobId, 'plan')?.content ?? '(kein Plan gefunden)';
    const testReport = this.buildTestReport(jobId, iteration);
    const prompt = buildReviewPrompt({
      ticket,
      plan,
      diff,
      changedFiles: changed.map((c) => `${c.status}\t${c.path}`).join('\n'),
      testReport,
      iteration,
    });
    const result = await this.runAgent(
      { jobId, phase: 'review', agent: 'claude', prompt, cwd: worktree },
      this.deps.claude,
      signal,
    );
    if (result.status !== 'completed') {
      throw new NeedsHumanOutcome(`Review nicht durchführbar: ${result.error ?? 'unbekannt'}`);
    }
    const verdict = parseVerdict(result.output);
    if (verdict === null) {
      throw new NeedsHumanOutcome('Review-Ausgabe enthält kein eindeutiges VERDICT: PASS|FAIL');
    }
    if (verdict === 'FAIL') {
      await this.writeArtifactFile(job, 'REVIEW.md', result.output);
      const artifact = this.recordArtifact(jobId, result.runId, 'review', path.join(worktree, AGENT_DIR, 'REVIEW.md'), result.output);
      this.deps.repos.reviewIterations.insert({ jobId, iteration, verdict: 'FAIL', artifactId: artifact.id });
      this.deps.publisher.record({ type: 'review.failed', jobId, payload: { iteration }, message: `Review-Iteration ${iteration}: FAIL` });
      log.info({ iteration }, 'Review FAIL');
      return 'FAIL';
    }
    this.recordArtifact(jobId, result.runId, 'review', null, result.output);
    this.deps.repos.reviewIterations.insert({ jobId, iteration, verdict: 'PASS' });
    this.deps.publisher.record({ type: 'review.passed', jobId, payload: { iteration }, message: `Review-Iteration ${iteration}: PASS` });
    log.info({ iteration }, 'Review PASS');
    return 'PASS';
  }

  // ---- Agenten-Hilfen -------------------------------------------------------

  private async runAgent(
    input: { jobId: string; phase: AgentPhase; agent: AgentName; prompt: string; cwd: string },
    adapter: ClaudeCodeAdapter | CodexCliAdapter,
    signal: AbortSignal,
  ): Promise<{ runId: string; status: string; output: string; error: string | null }> {
    const { repos, publisher, logStore, config } = this.deps;
    if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
    const run = repos.agentRuns.insert({ jobId: input.jobId, phase: input.phase, agent: input.agent });
    repos.jobs.update(input.jobId, { currentAgent: input.agent });
    publisher.record({ type: 'agent.started', jobId: input.jobId, payload: { runId: run.id, agent: input.agent, phase: input.phase }, message: `${input.agent} (${input.phase}) gestartet` });

    const onAbort = () => void adapter.cancel(run.id);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await adapter.execute({
        runId: run.id,
        jobId: input.jobId,
        phase: input.phase,
        prompt: input.prompt,
        cwd: input.cwd,
        timeoutMs: config.limits.maxJobRuntimeMs,
        maxOutputBytes: config.limits.maxAgentOutputBytes,
        onOutput: (chunk) => {
          logStore.append(input.jobId, { ts: new Date().toISOString(), source: 'agent', stream: chunk.stream, text: chunk.text });
          publisher.emit('agent.output', input.jobId, { runId: run.id, stream: chunk.stream, text: chunk.text });
        },
        onSpawned: (pgid) => {
          repos.agentRuns.update(run.id, { pgid: pgid ?? null });
          repos.jobs.update(input.jobId, { activePgid: pgid ?? null });
        },
      });
      repos.agentRuns.update(run.id, {
        status: result.status,
        exitCode: result.exitCode,
        output: result.output,
        error: result.error,
        finishedAt: new Date().toISOString(),
      });
      repos.jobs.update(input.jobId, { currentAgent: null, activePgid: null });
      if (result.status === 'completed') {
        publisher.record({ type: 'agent.completed', jobId: input.jobId, payload: { runId: run.id, status: result.status, exitCode: result.exitCode }, message: `${input.agent} (${input.phase}) abgeschlossen` });
      } else {
        publisher.record({ type: 'agent.failed', jobId: input.jobId, payload: { runId: run.id, status: result.status, error: result.error ?? 'unbekannt' }, message: `${input.agent} (${input.phase}): ${result.status}` });
      }
      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
      return { runId: run.id, status: result.status, output: result.output, error: result.error };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  // ---- Zustandswechsel & Ausgänge ------------------------------------------

  private async transition(jobId: string, to: JobState, message: string): Promise<Job> {
    const job = this.mustJob(jobId);
    assertTransition(job.state, to);
    const updated = this.deps.repos.jobs.update(jobId, { state: to });
    this.publishStateChange(jobId, job.state, to, message);
    return updated;
  }

  private async enterRework(jobId: string, message: string): Promise<void> {
    const job = this.mustJob(jobId);
    assertTransition(job.state, 'rework');
    const count = job.reviewLoopCount + 1;
    this.deps.repos.jobs.update(jobId, { state: 'rework', reviewLoopCount: count });
    this.publishStateChange(jobId, job.state, 'rework', `${message} (Schleife ${count}/${this.deps.config.limits.maxReviewLoops})`);
  }

  private async finishDone(jobId: string, ticket: Ticket): Promise<void> {
    const job = this.mustJob(jobId);
    assertTransition(job.state, 'done');
    this.deps.repos.jobs.update(jobId, { state: 'done', finishedAt: new Date().toISOString(), currentAgent: null, activePgid: null, lastError: null });
    this.publishStateChange(jobId, job.state, 'done', 'Review bestanden — fertig (kein automatischer Merge/Push)');
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary) this.deps.publisher.record({ type: 'job.completed', jobId, payload: { job: summary } });
    if (this.deps.linear.commentsEnabled) {
      try {
        await this.deps.linear.postComment(ticket.linearIssueId, `Lokaler Agent-Workflow abgeschlossen für ${ticket.identifier} (Review bestanden).`);
      } catch (error) {
        this.deps.logger.warn({ err: error, jobId }, 'Linear-Kommentar fehlgeschlagen');
      }
    }
  }

  private async finishNeedsHuman(jobId: string, reason: string): Promise<void> {
    const job = this.mustJob(jobId);
    assertTransition(job.state, 'needs_human');
    this.deps.repos.jobs.update(jobId, { state: 'needs_human', lastError: reason, currentAgent: null, activePgid: null });
    this.publishStateChange(jobId, job.state, 'needs_human', reason);
  }

  private async fail(jobId: string, message: string): Promise<void> {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return;
    if (job.state === 'done') return;
    try {
      assertTransition(job.state, 'failed');
    } catch {
      this.deps.repos.jobs.update(jobId, { lastError: message });
      return;
    }
    this.deps.repos.jobs.update(jobId, { state: 'failed', lastError: message, finishedAt: new Date().toISOString(), currentAgent: null, activePgid: null });
    this.publishStateChange(jobId, job.state, 'failed', message);
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary) this.deps.publisher.record({ type: 'job.failed', jobId, payload: { job: summary, error: message } });
  }

  /** Vom Queue-Manager aufgerufen, wenn ein Lauf abgebrochen wurde. */
  async abortToFailed(jobId: string, message: string): Promise<void> {
    await this.fail(jobId, message);
  }

  // ---- Grenzen (Pause/Cancel) ----------------------------------------------

  /** true, wenn die Pipeline anhalten soll (Pause-Request). Wirft bei Abbruch. */
  private async boundary(jobId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
    const job = this.mustJob(jobId);
    if (job.pauseRequested) {
      assertTransition(job.state, 'paused');
      this.deps.repos.jobs.update(jobId, { state: 'paused', pauseRequested: false, currentAgent: null, activePgid: null });
      this.publishStateChange(jobId, job.state, 'paused', 'Pausiert auf Benutzerwunsch');
      const summary = this.deps.repos.jobs.getSummary(jobId);
      if (summary) this.deps.publisher.record({ type: 'job.paused', jobId, payload: { job: summary } });
      return true;
    }
    return false;
  }

  // ---- kleine Helfer --------------------------------------------------------

  private load(jobId: string): { project: Project; ticket: Ticket } | null {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return null;
    const project = this.deps.repos.projects.get(job.projectId);
    const ticket = this.deps.repos.tickets.get(job.ticketId);
    if (!project || !ticket) return null;
    return { project, ticket };
  }

  private mustJob(jobId: string): Job {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) throw new Error(`Job verschwunden: ${jobId}`);
    return job;
  }

  private worktree(job: Job): string {
    if (!job.worktreePath) throw new Error('Worktree-Pfad nicht gesetzt');
    return job.worktreePath;
  }

  private async writeArtifactFile(job: Job, name: string, content: string): Promise<void> {
    const dir = path.join(this.worktree(job), AGENT_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }

  private recordArtifact(
    jobId: string,
    agentRunId: string,
    type: 'plan' | 'review' | 'summary' | 'diff' | 'test_report',
    filePath: string | null,
    content: string,
  ) {
    const artifact = this.deps.repos.artifacts.insert({ jobId, agentRunId, type, path: filePath, content });
    this.deps.publisher.record({
      type: 'artifact.created',
      jobId,
      payload: {
        artifact: {
          id: artifact.id,
          jobId,
          agentRunId,
          type: artifact.type,
          path: artifact.path,
          createdAt: artifact.createdAt,
        },
      },
    });
    return artifact;
  }

  private buildTestReport(jobId: string, iteration: number): string {
    const runs = this.deps.repos.testRuns.listByJob(jobId).filter((r) => r.iteration === iteration);
    if (runs.length === 0) return '(keine Testläufe)';
    return runs
      .map((r) => {
        const head = `## ${r.commandKey}: ${r.command} → Exit ${r.exitCode ?? 'n/a'} (${r.status})`;
        const body = [r.stdout, r.stderr].filter((s) => s.trim().length > 0).join('\n').slice(-4000);
        return `${head}\n${body}`;
      })
      .join('\n\n');
  }

  private system(jobId: string, message: string): void {
    this.deps.logStore.append(jobId, { ts: new Date().toISOString(), source: 'system', stream: 'info', text: message });
  }

  private publishStateChange(jobId: string, from: JobState, to: JobState, message: string): void {
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (!summary) return;
    this.deps.publisher.record({
      type: 'job.state_changed',
      jobId,
      payload: { job: summary, fromState: from, toState: to },
      fromState: from,
      toState: to,
      message,
    });
    this.deps.publisher.emit('job.updated', jobId, { job: summary });
  }
}
