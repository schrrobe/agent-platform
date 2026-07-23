import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import {
  allCriteriaVisual,
  buildImplementPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  classifyVisualCriteria,
  parseImplementationResult,
  parsePlanResult,
  parseReviewResult,
  renderImplementationMarkdown,
  renderPlanMarkdown,
  renderReviewMarkdown,
} from '@agent/agents';
import {
  AGENT_DIR,
  GitConflictError,
  branchKindForTicket,
  type ChangedFile,
  type GitService,
} from '@agent/git';
import type { LinearService } from '@agent/linear';
import { decideAfterFailedTests, decideAfterReview, assertTransition } from '@agent/workflow';
import {
  CHECK_COMMAND_KEYS,
  type AgentAdapter,
  type AgentName,
  type AgentPhase,
  type ArtifactType,
  type CheckCommandKey,
  type Job,
  type JobState,
  type PipelinePhase,
  type PlanResult,
  type Project,
  type ReviewResult,
  type TestExecutionMode,
  type LinearSyncEvent,
  type Ticket,
} from '@agent/shared';
import type { Repositories } from '@agent/database';
import type { AppConfig } from '../config.js';
import type { Publisher } from '../events/publisher.js';
import type { LogStore } from '../services/log-store.js';
import type { TestSandbox } from '../services/test-sandbox.js';
import { tokenizeCommand } from '../services/command.js';
import { PipelineAbort, abortReasonOf } from './errors.js';

export interface PipelineDeps {
  config: AppConfig;
  logger: Logger;
  repos: Repositories;
  git: GitService;
  planner: AgentAdapter;
  implementer: AgentAdapter;
  reviewer: AgentAdapter;
  linear: LinearService;
  publisher: Publisher;
  logStore: LogStore;
  testSandbox: TestSandbox;
}

/** Vom Menschen zu behandelnder Ausgang (kein Infrastrukturfehler). */
class NeedsHumanOutcome {
  constructor(
    readonly message: string,
    readonly resumePhase?: PipelinePhase | null,
  ) {}
}

function displayAgentName(name: AgentName): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * Signatur automatisierter Visual-/E2E-Prüfläufe in Projektbefehlen. Ist ein
 * solcher Runner konfiguriert, gilt Sichtprüfung als maschinell abgedeckt — dann
 * greift die visuelle Handoff-Abkürzung nicht.
 */
const VISUAL_RUNNER_RE =
  /playwright|cypress|percy|chromatic|storybook|puppeteer|webdriver|selenium|backstop|\bloki\b|screenshot|\bvisual\b|\be2e\b/i;

/** Deterministische, checkpoint-fähige Job-Pipeline. */
export class JobPipeline {
  private implementer: AgentAdapter;

  constructor(private readonly deps: PipelineDeps) {
    this.implementer = deps.implementer;
  }

  setImplementer(implementer: AgentAdapter): void {
    this.implementer = implementer;
  }

  get implementationAgent(): AgentName {
    return this.implementer.name;
  }

  /** Pflichtprüfungen für explizite Nacharbeiten außerhalb der normalen Zustands-Pipeline. */
  async verifyPostRunChanges(
    jobId: string,
    project: Project,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const worktree = this.worktree(this.mustJob(jobId));
      const [expectedStatus, expectedStagedDiff] = await Promise.all([
        this.deps.git.workingTreeStatus(worktree),
        this.deps.git.stagedDiff(worktree),
      ]);
      return await this.testPhase(
        jobId,
        project,
        this.mustJob(jobId).reviewLoopCount + 2,
        signal,
        this.deps.logger.child({ jobId, phase: 'github_review_verification' }),
        { expectedStatus, expectedStagedDiff },
      );
    } catch (error) {
      if (error instanceof NeedsHumanOutcome) throw new Error(error.message, { cause: error });
      throw error;
    }
  }

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
      let next: PipelinePhase = this.mustJob(jobId).resumePhase ?? 'preflight';

      if (next === 'preflight') {
        if (await this.boundary(jobId, signal, 'preflight')) return;
        await this.transition(jobId, 'preflight', 'Sicherheits-Preflight gestartet');
        await this.syncLinearState(project, jobId, 'onStart', log);
        await this.preflightPhase(jobId, project, signal, log);
        this.deps.repos.jobs.update(jobId, { resumePhase: 'planning' });
        next = 'planning';
      }

      if (next === 'planning') {
        if (await this.boundary(jobId, signal, 'planning')) return;
        await this.transition(jobId, 'planning', 'Planung gestartet');
        const plan = await this.planPhase(jobId, project, signal, log);
        this.deps.repos.jobs.update(jobId, { resumePhase: 'implementing' });
        const approvalReasons = this.approvalReasons(project, plan);
        if (approvalReasons.length > 0) {
          await this.transition(
            jobId,
            'awaiting_plan_approval',
            `Plan wartet auf Freigabe: ${approvalReasons.join('; ')}`,
          );
          return;
        }
        this.deps.repos.jobs.update(jobId, { planApprovedAt: new Date().toISOString() });
        next = 'implementing';
      }

      for (;;) {
        const beforeImplementation = this.mustJob(jobId);
        const iteration = beforeImplementation.reviewLoopCount + 1;
        const isRework = beforeImplementation.reviewLoopCount > 0;

        if (next === 'implementing') {
          if (await this.boundary(jobId, signal, 'implementing')) return;
          await this.transition(jobId, 'implementing', 'Implementierung gestartet');
          await this.implementPhase(jobId, ticket, project, iteration, isRework, signal, log);
          this.deps.repos.jobs.update(jobId, { resumePhase: 'testing' });
          next = 'testing';
        }

        if (next === 'testing') {
          if (await this.boundary(jobId, signal, 'testing')) return;
          await this.transition(jobId, 'testing', 'Prüfungen gestartet');
          const testsOk = await this.testPhase(jobId, project, iteration, signal, log);
          if (!testsOk) {
            const job = this.mustJob(jobId);
            const target = decideAfterFailedTests({
              reviewLoopCount: job.reviewLoopCount,
              maxReviewLoops: this.deps.config.limits.maxReviewLoops,
            });
            if (target === 'needs_human') {
              await this.finishNeedsHuman(
                jobId,
                'Pflichtprüfungen nach maximaler Schleifenzahl weiterhin rot',
                'implementing',
              );
              return;
            }
            await this.enterRework(jobId, 'Prüfungen fehlgeschlagen — Nacharbeit');
            next = 'implementing';
            continue;
          }
          this.deps.repos.jobs.update(jobId, { resumePhase: 'review' });
          if (project.autonomyMode === 'approve_diff') {
            const job = this.mustJob(jobId);
            const diff = await this.deps.git.diffAgainstBase(this.worktree(job), this.baseCommit(job));
            this.recordArtifact(jobId, null, 'diff', null, diff);
            // Ein während der Tests angefordertes Pause-Request bleibt erhalten und
            // greift nach der Diff-Freigabe an der nächsten Phasengrenze (review).
            await this.transition(
              jobId,
              'awaiting_diff_approval',
              `Diff wartet auf Freigabe (Iteration ${iteration})`,
            );
            return;
          }
          next = 'review';
        }

        if (await this.boundary(jobId, signal, 'review')) return;
        await this.transition(jobId, 'review', 'Review gestartet');
        const review = await this.reviewPhase(jobId, project, iteration, signal, log);
        const visualSignoff = this.detectVisualSignoff(jobId, project, review);
        if (visualSignoff) {
          log.info(
            { criteria: visualSignoff.length },
            'Nur visuelle Akzeptanzkriterien offen — menschliche Abnahme statt Nacharbeit',
          );
          await this.completeForHandoff(jobId, ticket, project, visualSignoff);
          return;
        }
        const target = decideAfterReview(review.verdict, {
          reviewLoopCount: this.mustJob(jobId).reviewLoopCount,
          maxReviewLoops: this.deps.config.limits.maxReviewLoops,
        });
        if (target === 'ready_for_human') {
          await this.completeForHandoff(jobId, ticket, project);
          return;
        }
        if (target === 'needs_human') {
          await this.finishNeedsHuman(
            jobId,
            'Review nach maximaler Schleifenzahl weiterhin FAIL',
            'implementing',
          );
          return;
        }
        await this.enterRework(jobId, 'Review fehlgeschlagen — Nacharbeit');
        next = 'implementing';
      }
    } catch (error) {
      if (error instanceof PipelineAbort) throw error;
      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal), { cause: error });
      if (error instanceof NeedsHumanOutcome) {
        const resumePhase =
          error.resumePhase === undefined
            ? this.resumePhaseForState(this.mustJob(jobId))
            : error.resumePhase;
        await this.finishNeedsHuman(jobId, error.message, resumePhase);
        return;
      }
      if (error instanceof GitConflictError) {
        await this.finishNeedsHuman(
          jobId,
          error.message,
          this.resumePhaseForState(this.mustJob(jobId)),
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, 'Pipeline-Fehler');
      await this.fail(jobId, message);
    } finally {
      try {
        await this.deps.testSandbox.cleanup(jobId);
      } catch (error) {
        log.warn({ err: error }, 'Sandbox-Temp konnte nicht vollständig entfernt werden');
      }
    }
  }

  private async ensureWorktreeReady(
    jobId: string,
    project: Project,
    ticket: Ticket,
    log: Logger,
  ): Promise<void> {
    let job = this.mustJob(jobId);
    if (!job.branch) {
      const branch = await this.deps.git.allocateBranch(
        project.repositoryPath,
        ticket.identifier,
        ticket.title,
        branchKindForTicket(ticket.title, ticket.labels),
      );
      job = this.deps.repos.jobs.update(jobId, { branch });
    }
    const result = await this.deps.git.ensureWorktree({
      repositoryPath: project.repositoryPath,
      worktreeRoot: project.worktreeRoot,
      identifier: ticket.identifier,
      title: ticket.title,
      expectedBranch: job.branch,
      jobId,
      baseBranch: job.baseBranch,
      expectedBaseCommit: job.baseCommitSha,
    });
    await this.deps.git.assertWorktreeClean(result.worktreePath);
    const head = await this.deps.git.currentHead(result.worktreePath);
    this.deps.repos.jobs.update(jobId, {
      worktreePath: result.worktreePath,
      branch: result.branch,
      baseCommitSha: result.baseCommit,
      headCommitSha: head,
    });
    this.system(jobId, `Worktree bereit: ${result.worktreePath} (${result.branch})`);
    log.info({ worktree: result.worktreePath, branch: result.branch }, 'Worktree bereit');
  }

  private async preflightPhase(
    jobId: string,
    project: Project,
    signal: AbortSignal,
    log: Logger,
  ): Promise<void> {
    if (project.testExecutionMode === 'trusted') {
      this.system(jobId, 'WARNUNG: Projektbefehle laufen im expliziten Trusted-Host-Modus');
    }
    if (project.commands.setup) {
      const setupOk = await this.runCommandKeys(jobId, project, 0, ['setup'], true, signal, log);
      if (!setupOk) {
        throw new NeedsHumanOutcome('Projekt-Setup ist bereits auf der Basis fehlgeschlagen');
      }
    }
    if (!project.baselineChecks) {
      this.system(jobId, 'Baseline-Prüfungen laut Projektkonfiguration übersprungen');
      return;
    }
    const keys = CHECK_COMMAND_KEYS.filter((key) => project.commands[key]);
    if (keys.length === 0) {
      this.system(jobId, 'Keine Baseline-Prüfungen konfiguriert');
      return;
    }
    const ok = await this.runCommandKeys(jobId, project, 0, keys, true, signal, log);
    if (!ok) {
      throw new NeedsHumanOutcome(
        'Basisbranch ist bereits vor der Agentenänderung rot; automatische Implementierung gestoppt',
      );
    }
    this.system(jobId, 'Baseline-Prüfungen bestanden');
  }

  private async planPhase(
    jobId: string,
    project: Project,
    signal: AbortSignal,
    log: Logger,
  ): Promise<PlanResult> {
    const job = this.mustJob(jobId);
    const baselineReport = this.buildTestReport(jobId, 0);
    const prompt = buildPlanPrompt({
      tickets: this.jobTickets(jobId),
      baseBranch: job.baseBranch,
      baselineReport,
    });
    const result = await this.runAgent(
      { jobId, phase: 'plan', prompt, cwd: this.worktree(job) },
      this.deps.planner,
      signal,
    );
    if (result.status !== 'completed' || result.output.trim().length === 0) {
      throw new NeedsHumanOutcome(`Planung nicht verwertbar: ${result.error ?? 'leere Ausgabe'}`);
    }
    if (result.truncated) {
      throw new NeedsHumanOutcome(
        'Plan-Ausgabe wurde gekappt und wird nicht automatisch verwendet',
      );
    }
    let plan: PlanResult;
    try {
      plan = parsePlanResult(result.output);
    } catch (error) {
      throw new NeedsHumanOutcome(error instanceof Error ? error.message : String(error));
    }
    const markdown = renderPlanMarkdown(plan);
    await this.writeArtifactFile(job, 'PLAN.md', markdown);
    this.recordArtifact(
      jobId,
      result.runId,
      'plan',
      path.join(this.worktree(job), AGENT_DIR, 'PLAN.md'),
      markdown,
    );
    this.recordArtifact(jobId, result.runId, 'plan_contract', null, JSON.stringify(plan, null, 2));
    log.info({ riskLevel: plan.riskLevel, questions: plan.questions.length }, 'Plan erstellt');
    return plan;
  }

  private approvalReasons(project: Project, plan: PlanResult): string[] {
    const reasons: string[] = [];
    if (project.autonomyMode === 'approve_plan') reasons.push('Projekt verlangt Planfreigabe');
    if (plan.riskLevel === 'high') reasons.push('hohes Planrisiko');
    if (plan.questions.length > 0) reasons.push(`${plan.questions.length} offene Frage(n)`);
    return reasons;
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
    const plan = this.deps.repos.artifacts.latestByType(jobId, 'plan')?.content;
    if (!plan) throw new NeedsHumanOutcome('Freigegebener Plan fehlt', 'planning');
    const approvalNote = this.deps.repos.artifacts.latestByType(jobId, 'approval')?.content ?? null;
    // Human-Feedback nur injizieren, solange es frischer ist als die letzte
    // Implementierungsrunde — deren Artifact „konsumiert" das Feedback.
    const latestImplementation = this.deps.repos.artifacts.latestByType(jobId, 'implementation');
    const latestFeedback = this.deps.repos.artifacts.latestByType(jobId, 'human_feedback');
    const humanFeedback =
      latestFeedback &&
      (!latestImplementation || latestFeedback.createdAt > latestImplementation.createdAt)
        ? latestFeedback.content
        : null;
    const reviewFeedback = isRework
      ? (this.deps.repos.artifacts.latestByType(jobId, 'review')?.content ?? null)
      : null;
    const testFeedback = isRework ? this.buildTestReport(jobId, iteration - 1) : null;
    const prompt = buildImplementPrompt({
      tickets: this.jobTickets(jobId),
      plan,
      isRework,
      approvalNote,
      humanFeedback,
      reviewFeedback,
      testFeedback,
    });
    const result = await this.runAgent(
      { jobId, phase: isRework ? 'rework' : 'implement', prompt, cwd: worktree },
      this.implementer,
      signal,
    );
    if (result.status !== 'completed') {
      throw new Error(
        `${displayAgentName(this.implementer.name)}-Implementierung fehlgeschlagen: ${result.error ?? 'unbekannt'}`,
      );
    }
    if (result.truncated) {
      throw new NeedsHumanOutcome(
        `${displayAgentName(this.implementer.name)}-Ergebnis wurde gekappt; Änderungen bleiben zur Prüfung erhalten`,
      );
    }
    let implementation;
    try {
      implementation = parseImplementationResult(result.output);
    } catch (error) {
      throw new NeedsHumanOutcome(error instanceof Error ? error.message : String(error));
    }

    this.verifyOwner(jobId, project);
    const commit = await this.deps.git.commitAll(
      worktree,
      `${branchKindForTicket(ticket.title, ticket.labels)}: ${ticket.identifier} ${ticket.title}${iteration > 1 ? ` (iteration ${iteration})` : ''}`,
    );
    const base = this.baseCommit(job);
    const changed = await this.deps.git.changedFiles(worktree, base);
    if (!commit && changed.length === 0) {
      throw new NeedsHumanOutcome(
        `${displayAgentName(this.implementer.name)} hat keine Dateiänderungen vorgenommen`,
      );
    }
    const head = await this.deps.git.currentHead(worktree);
    this.deps.repos.jobs.update(jobId, { headCommitSha: head });
    await this.enforceDiffPolicy(worktree, base, project, changed);
    await this.deps.git.assertWorktreeClean(worktree);
    const rendered = renderImplementationMarkdown(implementation);
    this.recordArtifact(jobId, result.runId, 'implementation', null, rendered);
    this.recordArtifact(jobId, result.runId, 'summary', null, result.output);
    this.system(
      jobId,
      `Implementierung committet (${changed.length} Dateien${commit ? `, ${commit.slice(0, 8)}` : ''})`,
    );
    log.info({ changedFiles: changed.length, head }, 'Implementierung abgeschlossen');
  }

  private async enforceDiffPolicy(
    worktree: string,
    base: string,
    project: Project,
    changed: ChangedFile[],
  ): Promise<void> {
    if (changed.length > project.maxChangedFiles) {
      throw new NeedsHumanOutcome(
        `Diff umfasst ${changed.length} Dateien; Projektlimit ist ${project.maxChangedFiles}`,
      );
    }
    const changedPaths = changed.flatMap((entry) =>
      entry.previousPath ? [entry.previousPath, entry.path] : [entry.path],
    );
    const blocked = changedPaths.filter((changed) =>
      project.blockedPaths.some((prefix) => {
        const normalized = prefix.replace(/^\.\/+/, '').replace(/\/+$/, '');
        return changed === normalized || changed.startsWith(`${normalized}/`);
      }),
    );
    if (blocked.length > 0) {
      throw new NeedsHumanOutcome(`Diff berührt gesperrte Pfade: ${blocked.join(', ')}`);
    }
    const [diff, binaryFiles] = await Promise.all([
      this.deps.git.diffAgainstBase(worktree, base),
      this.deps.git.binaryChangedFiles(worktree, base),
    ]);
    const bytes = Buffer.byteLength(diff);
    if (bytes > project.maxDiffBytes) {
      throw new NeedsHumanOutcome(
        `Diff ist ${bytes} Bytes groß; Projektlimit ist ${project.maxDiffBytes}`,
      );
    }
    if (binaryFiles.length > 0) {
      throw new NeedsHumanOutcome(
        `Binäre Änderungen benötigen eine menschliche Prüfung: ${binaryFiles.join(', ')}`,
      );
    }
  }

  private async testPhase(
    jobId: string,
    project: Project,
    iteration: number,
    signal: AbortSignal,
    log: Logger,
    stagedSnapshot?: { expectedStatus: string; expectedStagedDiff: string },
  ): Promise<boolean> {
    if (project.commands.setup) {
      const setupOk = await this.runCommandKeys(
        jobId,
        project,
        iteration,
        ['setup'],
        false,
        signal,
        log,
        stagedSnapshot,
      );
      if (!setupOk) return false;
    }
    const keys = CHECK_COMMAND_KEYS.filter((key) => project.commands[key]);
    if (keys.length === 0) {
      this.system(jobId, 'Keine Projektprüfungen konfiguriert — Testphase übersprungen');
      return true;
    }
    const ok = await this.runCommandKeys(
      jobId,
      project,
      iteration,
      keys,
      false,
      signal,
      log,
      stagedSnapshot,
    );
    this.system(
      jobId,
      ok ? 'Alle Pflichtprüfungen bestanden' : 'Mindestens eine Pflichtprüfung ist rot',
    );
    return ok;
  }

  private async runCommandKeys(
    jobId: string,
    project: Project,
    iteration: number,
    keys: readonly (CheckCommandKey | 'setup')[],
    baseline: boolean,
    signal: AbortSignal,
    log: Logger,
    stagedSnapshot?: { expectedStatus: string; expectedStagedDiff: string },
  ): Promise<boolean> {
    const worktree = this.worktree(this.mustJob(jobId));
    let allOk = true;
    for (const key of keys) {
      const commandString = project.commands[key];
      if (!commandString) continue;
      let command: string;
      let args: string[];
      try {
        ({ command, args } = tokenizeCommand(commandString));
      } catch (error) {
        throw new Error(
          `Ungültiger ${key}-Befehl: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      // 'setup' installiert Abhängigkeiten und braucht Registry-Netzwerk; die
      // sandboxed-Netzwerksperre würde jeden Install-Drift-Fall in ENOTFOUND laufen lassen.
      const mode: TestExecutionMode = key === 'setup' ? 'trusted' : project.testExecutionMode;
      const beforeHead = await this.deps.git.currentHead(worktree);
      const testRun = this.deps.repos.testRuns.insert({
        jobId,
        iteration,
        commandKey: key,
        command: commandString,
        baseline,
        sandboxed: mode === 'sandboxed',
      });
      this.deps.publisher.emit('test.started', jobId, {
        testRunId: testRun.id,
        commandKey: key,
        command: commandString,
      });

      const { handle } = await this.deps.testSandbox.run({
        jobId,
        mode,
        command,
        args,
        cwd: worktree,
        timeoutMs: this.deps.config.limits.testCommandTimeoutMs,
        maxOutputBytes: this.deps.config.limits.maxAgentOutputBytes,
        onOutput: (chunk) => {
          this.deps.logStore.append(jobId, {
            ts: new Date().toISOString(),
            source: 'test',
            stream: chunk.stream,
            text: chunk.text,
          });
          this.deps.publisher.emit('test.output', jobId, {
            testRunId: testRun.id,
            stream: chunk.stream,
            text: chunk.text,
          });
        },
      });
      this.deps.repos.jobs.update(jobId, { activePgid: handle.pgid ?? null });
      const onAbort = () => handle.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      let result;
      try {
        result = await handle.result;
      } finally {
        signal.removeEventListener('abort', onAbort);
        this.deps.repos.jobs.update(jobId, { activePgid: null });
      }

      const status = result.timedOut
        ? 'timeout'
        : result.canceled
          ? 'canceled'
          : result.exitCode === 0
            ? 'completed'
            : 'failed';
      const finished = this.deps.repos.testRuns.update(testRun.id, {
        status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        outputTruncated: result.truncated,
        finishedAt: new Date().toISOString(),
      });
      this.deps.publisher.emit('test.completed', jobId, { testRun: finished });
      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
      if (result.exitCode === null && !result.timedOut && !result.canceled) {
        throw new NeedsHumanOutcome(
          `Prüfung '${key}' konnte nicht gestartet werden. Sandbox Runtime installiert (` +
            `SRT_BIN) oder Trusted-Modus bewusst aktiviert?`,
        );
      }
      if (result.truncated) {
        throw new NeedsHumanOutcome(`Ausgabe der Prüfung '${key}' wurde gekappt`);
      }
      const afterHead = await this.deps.git.currentHead(worktree);
      if (afterHead !== beforeHead) {
        throw new NeedsHumanOutcome(`Prüfung '${key}' hat die Git-Historie verändert`);
      }
      if (stagedSnapshot) {
        const [afterStatus, afterStagedDiff] = await Promise.all([
          this.deps.git.workingTreeStatus(worktree),
          this.deps.git.stagedDiff(worktree),
        ]);
        if (
          afterStatus !== stagedSnapshot.expectedStatus ||
          afterStagedDiff !== stagedSnapshot.expectedStagedDiff
        ) {
          throw new NeedsHumanOutcome(
            `Prüfung '${key}' hat die vorbereiteten Änderungen verändert`,
          );
        }
      } else if (await this.deps.git.hasUncommittedChanges(worktree)) {
        throw new NeedsHumanOutcome(
          `Prüfung '${key}' hat den Worktree verändert; verwende einen rein prüfenden Befehl`,
        );
      }
      this.verifyOwner(jobId, project);
      if (result.exitCode !== 0) {
        allOk = false;
        this.system(jobId, `Prüfung '${key}' fehlgeschlagen (Exit ${result.exitCode ?? 'n/a'})`);
        log.warn({ commandKey: key, exitCode: result.exitCode }, 'Pflichtprüfung fehlgeschlagen');
      }
    }
    return allOk;
  }

  private async reviewPhase(
    jobId: string,
    project: Project,
    iteration: number,
    signal: AbortSignal,
    log: Logger,
  ): Promise<ReviewResult> {
    const job = this.mustJob(jobId);
    const worktree = this.worktree(job);
    const base = this.baseCommit(job);
    const diff = await this.deps.git.diffAgainstBase(worktree, base);
    const changed = await this.deps.git.changedFiles(worktree, base);
    this.deps.repos.artifacts.insert({ jobId, type: 'diff', content: diff });
    const plan = this.deps.repos.artifacts.latestByType(jobId, 'plan')?.content ?? '(kein Plan)';
    const implementationSummary =
      this.deps.repos.artifacts.latestByType(jobId, 'implementation')?.content ?? '(kein Bericht)';
    const prompt = buildReviewPrompt({
      tickets: this.jobTickets(jobId),
      plan,
      diff,
      changedFiles: changed
        .map((entry) =>
          entry.previousPath
            ? `${entry.status}\t${entry.previousPath} → ${entry.path}`
            : `${entry.status}\t${entry.path}`,
        )
        .join('\n'),
      testReport: this.buildTestReport(jobId, iteration),
      implementationSummary,
      iteration,
    });
    const result = await this.runAgent(
      { jobId, phase: 'review', prompt, cwd: worktree },
      this.deps.reviewer,
      signal,
    );
    if (result.status !== 'completed') {
      throw new NeedsHumanOutcome(`Review nicht durchführbar: ${result.error ?? 'unbekannt'}`);
    }
    if (result.truncated) throw new NeedsHumanOutcome('Review-Ausgabe wurde gekappt');
    let review: ReviewResult;
    try {
      review = parseReviewResult(result.output);
    } catch (error) {
      throw new NeedsHumanOutcome(error instanceof Error ? error.message : String(error));
    }
    const markdown = renderReviewMarkdown(review);
    if (review.verdict === 'FAIL') await this.writeArtifactFile(job, 'REVIEW.md', markdown);
    const artifact = this.recordArtifact(
      jobId,
      result.runId,
      'review',
      review.verdict === 'FAIL' ? path.join(worktree, AGENT_DIR, 'REVIEW.md') : null,
      markdown,
    );
    this.deps.repos.reviewIterations.insert({
      jobId,
      iteration,
      verdict: review.verdict,
      artifactId: artifact.id,
    });
    this.deps.publisher.record({
      type: review.verdict === 'PASS' ? 'review.passed' : 'review.failed',
      jobId,
      payload: { iteration },
      message: `Review-Iteration ${iteration}: ${review.verdict}`,
    });
    log.info({ iteration, verdict: review.verdict }, `Review ${review.verdict}`);
    return review;
  }

  /** True, wenn das Projekt einen automatisierten Visual-/E2E-Prüflauf konfiguriert hat. */
  private projectHasVisualCheck(project: Project): boolean {
    return Object.values(project.commands).some(
      (command) => typeof command === 'string' && VISUAL_RUNNER_RE.test(command),
    );
  }

  /**
   * Erkennt den Sonderfall „Review scheitert ausschließlich an rein visuellen
   * Akzeptanzkriterien". In diesem Fall kann keine weitere Nacharbeit helfen (kein
   * Browser/Screenshot-Abgleich, ein Diff-lesender Reviewer sieht keine Pixel), also
   * wird an eine menschliche Sichtprüfung übergeben statt die Review-Schleife zu drehen.
   * Gibt die betroffenen Kriterien zurück oder null, wenn regulär weitergearbeitet wird.
   */
  private detectVisualSignoff(
    jobId: string,
    project: Project,
    review: ReviewResult,
  ): string[] | null {
    // Nur bei FAIL relevant; PASS läuft ohnehin in die normale Übergabe.
    if (review.verdict !== 'FAIL') return null;
    // Echte Code-Findings müssen behoben werden — keine Abkürzung.
    if (review.findings.length > 0) return null;
    // Es muss offene Kriterien geben, und ALLE müssen rein visuell sein.
    if (!allCriteriaVisual(review.openAcceptanceCriteria)) return null;
    // Hat das Projekt einen automatisierten Visual-Check, ist Sichtprüfung maschinell
    // abgedeckt — dann nicht abkürzen, sondern regulär nacharbeiten lassen.
    if (this.projectHasVisualCheck(project)) return null;
    // Absicherung: nur greifen, wenn schon der Plan visuelle Akzeptanzkriterien deklariert
    // hat (verhindert, dass ein spontan visuell klingendes Review die Schleife umgeht).
    if (!this.planDeclaredVisualCriteria(jobId)) return null;
    return classifyVisualCriteria(review.openAcceptanceCriteria);
  }

  /** Prüft, ob der freigegebene Plan mindestens ein visuelles Akzeptanzkriterium enthielt. */
  private planDeclaredVisualCriteria(jobId: string): boolean {
    const contract = this.deps.repos.artifacts.latestByType(jobId, 'plan_contract')?.content;
    if (!contract) return false;
    try {
      const plan = parsePlanResult(contract);
      return classifyVisualCriteria(plan.acceptanceCriteria).length > 0;
    } catch {
      return false;
    }
  }

  private async completeForHandoff(
    jobId: string,
    ticket: Ticket,
    project: Project,
    visualSignoff: string[] = [],
  ): Promise<void> {
    const job = this.mustJob(jobId);
    const worktree = this.worktree(job);
    const base = this.baseCommit(job);
    await this.deps.git.assertWorktreeClean(worktree);
    this.verifyOwner(jobId, project);
    const head = await this.deps.git.currentHead(worktree);
    const currentBase = await this.deps.git.resolveCommit(project.repositoryPath, job.baseBranch);
    const stale = currentBase !== base;
    const diffStat = await this.deps.git.diffStat(worktree, base);
    this.deps.repos.jobs.update(jobId, { headCommitSha: head, baseStale: stale });
    const handoff = [
      '# Menschliche Übergabe',
      `- Ticket: ${ticket.identifier} — ${ticket.title}`,
      `- Branch: \`${job.branch ?? '—'}\``,
      `- Basisbranch: \`${job.baseBranch}\``,
      `- Basis-Commit: \`${base}\``,
      `- Head-Commit: \`${head}\``,
      `- Basisbranch aktuell: \`${currentBase}\``,
      `- Basis veraltet: **${stale ? 'ja' : 'nein'}**`,
      '',
      '## Diffstat',
      '```text',
      diffStat.trim() || '(leer)',
      '```',
      '',
      '## Verifikation',
      this.buildTestReport(jobId, this.mustJob(jobId).reviewLoopCount + 1),
      ...(visualSignoff.length > 0
        ? [
            '',
            '## Visuelle Abnahme erforderlich',
            'Die automatisierten Prüfungen sind grün, aber die folgenden Akzeptanzkriterien sind',
            'rein visuell und maschinell nicht verifizierbar. Bitte im Browser gegen das Design/den',
            'Screenshot prüfen, bevor der Branch übernommen wird:',
            ...visualSignoff.map((criterion) => `- ${criterion}`),
          ]
        : []),
      '',
      'Kein Push und kein Merge wurden ausgeführt. Repository und Branch müssen separat gesichert werden;',
      `optional: \`git -C "${project.repositoryPath}" bundle create <backup>.bundle ${job.branch ?? ''}\``,
    ].join('\n');
    this.recordArtifact(jobId, null, 'handoff', null, handoff);
    if (stale) {
      await this.finishNeedsHuman(
        jobId,
        'Basisbranch hat sich während des Jobs verändert; Branch vor Übergabe manuell aktualisieren',
        null,
      );
      return;
    }
    const current = this.mustJob(jobId);
    assertTransition(current.state, 'ready_for_human');
    this.deps.repos.jobs.update(jobId, {
      state: 'ready_for_human',
      finishedAt: new Date().toISOString(),
      currentAgent: null,
      activePgid: null,
      resumePhase: null,
      lastError: null,
    });
    this.publishStateChange(
      jobId,
      current.state,
      'ready_for_human',
      visualSignoff.length > 0
        ? 'Automatische Prüfungen grün; visuelle Abnahme durch Menschen erforderlich (kein Merge/Push)'
        : 'Review bestanden — bereit zur menschlichen Übergabe (kein Merge/Push)',
    );
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary) {
      this.deps.publisher.record({ type: 'job.ready_for_human', jobId, payload: { job: summary } });
    }
    if (this.deps.linear.commentsEnabled) {
      // Kommentar an jedes Ticket des Vorgangs.
      for (const ticket of this.jobTickets(jobId)) {
        try {
          await this.deps.linear.postComment(
            ticket.linearIssueId,
            visualSignoff.length > 0
              ? `Lokale Agentenarbeit für ${ticket.identifier} ist bereit; es ist noch eine visuelle Abnahme erforderlich (${visualSignoff.length} Kriterium/Kriterien).`
              : `Lokale Agentenarbeit für ${ticket.identifier} ist zur menschlichen Übergabe bereit.`,
          );
        } catch (error) {
          this.deps.logger.warn({ err: error, jobId }, 'Linear-Kommentar fehlgeschlagen');
        }
      }
    }
    await this.syncLinearState(project, jobId, 'onReadyForHuman', this.deps.logger.child({ jobId }));
  }

  /**
   * Setzt den Linear-Workflow-State für ein Job-Ereignis, sofern das Projekt ein
   * Mapping für das Team des Tickets konfiguriert hat. Fehler brechen die Pipeline nie.
   */
  private async syncLinearState(
    project: Project,
    jobId: string,
    event: LinearSyncEvent,
    log: Logger,
  ): Promise<void> {
    // Ein Vorgang umfasst mehrere Tickets — jedes einzeln synchronisieren.
    for (const ticket of this.jobTickets(jobId)) {
      try {
        await this.deps.linear.syncState(
          project.linearStateSync,
          ticket.teamKey,
          ticket.linearIssueId,
          event,
        );
      } catch (error) {
        log.warn(
          { err: error, event, ticket: ticket.identifier },
          'Linear-Status-Sync fehlgeschlagen',
        );
      }
    }
  }

  /** Alle Tickets eines Jobs (primär zuerst) für Prompt-Aufbau und Linear-Sync. */
  private jobTickets(jobId: string): Ticket[] {
    const tickets: Ticket[] = [];
    for (const id of this.deps.repos.jobs.listTicketIdsForJob(jobId)) {
      const ticket = this.deps.repos.tickets.get(id);
      if (ticket) tickets.push(ticket);
    }
    return tickets;
  }

  private async runAgent(
    input: { jobId: string; phase: AgentPhase; prompt: string; cwd: string },
    adapter: AgentAdapter,
    signal: AbortSignal,
  ): Promise<{
    runId: string;
    status: string;
    output: string;
    error: string | null;
    truncated: boolean;
  }> {
    const { repos, publisher, logStore, config } = this.deps;
    const agent = adapter.name;
    if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
    const run = repos.agentRuns.insert({
      jobId: input.jobId,
      phase: input.phase,
      agent,
    });
    repos.jobs.update(input.jobId, { currentAgent: agent });
    publisher.record({
      type: 'agent.started',
      jobId: input.jobId,
      payload: { runId: run.id, agent, phase: input.phase },
      message: `${agent} (${input.phase}) gestartet`,
    });
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
          logStore.append(input.jobId, {
            ts: new Date().toISOString(),
            source: 'agent',
            stream: chunk.stream,
            text: chunk.text,
          });
          publisher.emit('agent.output', input.jobId, {
            runId: run.id,
            stream: chunk.stream,
            text: chunk.text,
          });
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
        outputTruncated: result.truncated,
        error: result.error,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        cacheReadTokens: result.usage?.cacheReadTokens ?? null,
        cacheCreationTokens: result.usage?.cacheCreationTokens ?? null,
        totalTokens: result.usage?.totalTokens ?? null,
        costUsd: result.usage?.costUsd ?? null,
        finishedAt: new Date().toISOString(),
      });
      repos.jobs.update(input.jobId, { currentAgent: null, activePgid: null });
      publisher.record({
        type: result.status === 'completed' ? 'agent.completed' : 'agent.failed',
        jobId: input.jobId,
        payload:
          result.status === 'completed'
            ? { runId: run.id, status: result.status, exitCode: result.exitCode }
            : { runId: run.id, status: result.status, error: result.error ?? 'unbekannt' },
        message: `${agent} (${input.phase}): ${result.status}`,
      });
      if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
      return {
        runId: run.id,
        status: result.status,
        output: result.output,
        error: result.error,
        truncated: result.truncated,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

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
    this.deps.repos.jobs.update(jobId, {
      state: 'rework',
      reviewLoopCount: count,
      resumePhase: 'implementing',
    });
    this.publishStateChange(
      jobId,
      job.state,
      'rework',
      `${message} (Schleife ${count}/${this.deps.config.limits.maxReviewLoops})`,
    );
  }

  private async finishNeedsHuman(
    jobId: string,
    reason: string,
    resumePhase: PipelinePhase | null = null,
  ): Promise<void> {
    const job = this.mustJob(jobId);
    assertTransition(job.state, 'needs_human');
    this.deps.repos.jobs.update(jobId, {
      state: 'needs_human',
      lastError: reason,
      finishedAt: new Date().toISOString(),
      currentAgent: null,
      activePgid: null,
      resumePhase,
    });
    this.publishStateChange(jobId, job.state, 'needs_human', reason);
  }

  private async fail(jobId: string, message: string): Promise<void> {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job || job.state === 'done' || job.state === 'ready_for_human') return;
    try {
      assertTransition(job.state, 'failed');
    } catch {
      this.deps.repos.jobs.update(jobId, { lastError: message });
      return;
    }
    this.deps.repos.jobs.update(jobId, {
      state: 'failed',
      lastError: message,
      finishedAt: new Date().toISOString(),
      currentAgent: null,
      activePgid: null,
    });
    this.publishStateChange(jobId, job.state, 'failed', message);
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary) {
      this.deps.publisher.record({
        type: 'job.failed',
        jobId,
        payload: { job: summary, error: message },
      });
    }
  }

  async abortToFailed(jobId: string, message: string): Promise<void> {
    await this.fail(jobId, message);
  }

  private async boundary(
    jobId: string,
    signal: AbortSignal,
    nextPhase: PipelinePhase,
  ): Promise<boolean> {
    if (signal.aborted) throw new PipelineAbort(abortReasonOf(signal));
    const job = this.mustJob(jobId);
    if (!job.pauseRequested) return false;
    assertTransition(job.state, 'paused');
    this.deps.repos.jobs.update(jobId, {
      state: 'paused',
      pauseRequested: false,
      currentAgent: null,
      activePgid: null,
      resumePhase: nextPhase,
    });
    this.publishStateChange(jobId, job.state, 'paused', `Pausiert vor Phase ${nextPhase}`);
    const summary = this.deps.repos.jobs.getSummary(jobId);
    if (summary)
      this.deps.publisher.record({ type: 'job.paused', jobId, payload: { job: summary } });
    return true;
  }

  private load(jobId: string): { project: Project; ticket: Ticket } | null {
    const job = this.deps.repos.jobs.get(jobId);
    if (!job) return null;
    const project = this.deps.repos.projects.get(job.projectId);
    const ticket = this.deps.repos.tickets.get(job.ticketId);
    return project && ticket ? { project, ticket } : null;
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

  private baseCommit(job: Job): string {
    if (!job.baseCommitSha) throw new Error('Basis-Commit nicht gesetzt');
    return job.baseCommitSha;
  }

  private resumePhaseForState(job: Job): PipelinePhase | null {
    switch (job.state) {
      case 'agent_ready':
        return job.resumePhase ?? 'preflight';
      case 'preflight':
        return 'preflight';
      case 'planning':
        return 'planning';
      case 'implementing':
      case 'rework':
        return 'implementing';
      case 'testing':
        return 'testing';
      case 'review':
        return 'review';
      default:
        return null;
    }
  }

  private verifyOwner(jobId: string, project: Project): void {
    const job = this.mustJob(jobId);
    if (!job.branch) throw new Error('Branch nicht gesetzt');
    this.deps.git.verifyOwner(this.worktree(job), {
      jobId,
      branch: job.branch,
      repositoryPath: project.repositoryPath,
      baseCommit: this.baseCommit(job),
    });
  }

  private async writeArtifactFile(job: Job, name: string, content: string): Promise<void> {
    const dir = path.join(this.worktree(job), AGENT_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }

  private recordArtifact(
    jobId: string,
    agentRunId: string | null,
    type: ArtifactType,
    filePath: string | null,
    content: string,
  ) {
    const artifact = this.deps.repos.artifacts.insert({
      jobId,
      agentRunId,
      type,
      path: filePath,
      content,
    });
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
    const runs = this.deps.repos.testRuns
      .listByJob(jobId)
      .filter((run) => run.iteration === iteration);
    if (runs.length === 0) return '(keine Testläufe)';
    return runs
      .map((run) => {
        const mode = run.sandboxed ? 'sandboxed' : 'trusted-host';
        const phase = run.baseline ? 'Baseline' : `Iteration ${iteration}`;
        const head = `## ${phase} · ${run.commandKey}: ${run.command} → Exit ${run.exitCode ?? 'n/a'} (${run.status}, ${mode})`;
        const body = [run.stdout, run.stderr]
          .filter((value) => value.trim().length > 0)
          .join('\n')
          .slice(-4_000);
        return `${head}\n${body}`;
      })
      .join('\n\n');
  }

  private system(jobId: string, message: string): void {
    this.deps.logStore.append(jobId, {
      ts: new Date().toISOString(),
      source: 'system',
      stream: 'info',
      text: message,
    });
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
