import { ACTIVE_STATES } from '@agent/shared';
import type { AppContext } from './context.js';

/**
 * Neustart-Wiederherstellung (ADR-009). Nach einem Absturz können Kindprozesse
 * überleben und Worktrees mutieren. Beim Start werden daher überlebende
 * Prozessgruppen beendet und alle Jobs in aktiven Zuständen als „durch Neustart
 * unterbrochen" markiert. Es wird NICHTS automatisch neu gestartet — Retry ist
 * ausschließlich explizit.
 */
export async function runRecovery(
  ctx: AppContext,
): Promise<{ killedGroups: number; failedJobs: number; recoveredActions: number }> {
  const log = ctx.logger.child({ scope: 'recovery' });

  let killedGroups = 0;
  const groups = new Map<number, string>();
  for (const { pgid, jobId } of ctx.repos.agentRuns.listRunningPgids()) groups.set(pgid, jobId);
  for (const { pgid, jobId } of ctx.repos.jobs.listActivePgids()) groups.set(pgid, jobId);
  for (const [pgid, jobId] of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
      killedGroups += 1;
      log.warn({ jobId, pgid }, 'Überlebende Prozessgruppe beendet');
    } catch {
      // ESRCH: Gruppe existiert nicht mehr — erwartbar.
    }
  }
  ctx.repos.agentRuns.failAllRunning('Durch Neustart unterbrochen');
  ctx.repos.testRuns.failAllRunning('Durch Neustart unterbrochen');

  const active = ctx.repos.jobs.listByStates(ACTIVE_STATES);
  for (const job of active) {
    ctx.repos.jobs.update(job.id, {
      state: 'failed',
      lastError: 'Durch Neustart unterbrochen',
      finishedAt: new Date().toISOString(),
      currentAgent: null,
      activePgid: null,
    });
    ctx.repos.jobEvents.append({
      jobId: job.id,
      type: 'job.state_changed',
      fromState: job.state,
      toState: 'failed',
      message: 'Durch Neustart unterbrochen',
    });
    log.warn({ jobId: job.id, from: job.state }, 'Unterbrochenen Job als failed markiert');
  }

  const interruptedActions = ctx.repos.jobs
    .listSummaries()
    .filter((job) => job.currentAgent !== null && ['ready_for_human', 'done'].includes(job.state));
  for (const job of interruptedActions) {
    let message = 'GitHub-Nacharbeit durch Neustart unterbrochen';
    try {
      if (!job.worktreePath || !job.branch || !job.baseCommitSha || !job.headCommitSha) {
        throw new Error('persistierte Worktree- oder Commit-Daten sind unvollständig');
      }
      ctx.git.verifyOwner(job.worktreePath, {
        jobId: job.id,
        branch: job.branch,
        repositoryPath: job.repositoryPath,
        baseCommit: job.baseCommitSha,
      });
      await ctx.git.discardJobChanges(job.worktreePath, job.headCommitSha);
      message += '; uncommittierte Änderungen wurden verworfen';
    } catch (error) {
      message += `; Worktree konnte nicht sicher aufgeräumt werden: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    ctx.repos.jobs.update(job.id, {
      currentAgent: null,
      activePgid: null,
      lastError: message,
    });
    ctx.repos.jobEvents.append({
      jobId: job.id,
      type: 'job.github_review_interrupted',
      message,
    });
    log.warn({ jobId: job.id, state: job.state }, message);
  }

  if (killedGroups > 0 || active.length > 0 || interruptedActions.length > 0) {
    log.info(
      {
        killedGroups,
        failedJobs: active.length,
        recoveredActions: interruptedActions.length,
      },
      'Recovery abgeschlossen',
    );
  }
  return {
    killedGroups,
    failedJobs: active.length,
    recoveredActions: interruptedActions.length,
  };
}
