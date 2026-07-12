import type { JobState } from './states.js';

/** Alle Zeitstempel sind ISO-8601-Strings (UTC). */
export type IsoDateTime = string;

export const COMMAND_KEYS = ['format', 'lint', 'typecheck', 'test', 'build'] as const;
export type CommandKey = (typeof COMMAND_KEYS)[number];

/** Pro Projekt erlaubte Prüf-/Build-Befehle (Strings ohne Shell-Features, siehe ADR-014). */
export type ProjectCommands = Partial<Record<CommandKey, string>>;

export interface Project {
  id: string;
  name: string;
  repositoryPath: string;
  baseBranch: string;
  worktreeRoot: string;
  commands: ProjectCommands;
  active: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface Ticket {
  id: string;
  projectId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  teamKey: string | null;
  teamName: string | null;
  priority: number | null;
  priorityLabel: string | null;
  labels: string[];
  linearState: string | null;
  linearCreatedAt: IsoDateTime | null;
  linearUpdatedAt: IsoDateTime | null;
  importedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type AgentName = 'claude' | 'codex';
export type AgentPhase = 'plan' | 'implement' | 'review' | 'rework';
export type RunStatus = 'running' | 'completed' | 'failed' | 'canceled' | 'timeout';

export interface Job {
  id: string;
  ticketId: string;
  projectId: string;
  state: JobState;
  reviewLoopCount: number;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string;
  currentAgent: AgentName | null;
  pauseRequested: boolean;
  activePgid: number | null;
  deadlineAt: IsoDateTime | null;
  lastError: string | null;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Board-/Listendarstellung: Job inklusive Ticket- und Projektkontext. */
export interface JobSummary extends Job {
  ticket: Ticket;
  projectName: string;
  repositoryPath: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  ts: IsoDateTime;
  type: string;
  fromState: JobState | null;
  toState: JobState | null;
  message: string | null;
  data: unknown;
}

export interface AgentRun {
  id: string;
  jobId: string;
  phase: AgentPhase;
  agent: AgentName;
  status: RunStatus;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export type ArtifactType = 'plan' | 'review' | 'summary' | 'diff' | 'test_report';

export interface Artifact {
  id: string;
  jobId: string;
  agentRunId: string | null;
  type: ArtifactType;
  path: string | null;
  content: string;
  createdAt: IsoDateTime;
}

export type ReviewVerdict = 'PASS' | 'FAIL';

export interface ReviewIteration {
  id: string;
  jobId: string;
  iteration: number;
  verdict: ReviewVerdict;
  artifactId: string | null;
  createdAt: IsoDateTime;
}

export interface TestRun {
  id: string;
  jobId: string;
  iteration: number;
  commandKey: CommandKey;
  command: string;
  status: RunStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number | null;
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

/** Detailansicht: Job mit allen zugehörigen Verlaufsdaten. */
export interface JobDetail extends JobSummary {
  events: JobEvent[];
  agentRuns: AgentRun[];
  artifacts: Artifact[];
  reviewIterations: ReviewIteration[];
  testRuns: TestRun[];
}

export interface LogLine {
  seq: number;
  ts: IsoDateTime;
  source: 'agent' | 'test' | 'system';
  stream: 'stdout' | 'stderr' | 'info';
  text: string;
}
