import type {
  AgentName,
  AgentPhase,
  Artifact,
  IsoDateTime,
  JobSummary,
  RunStatus,
  TestRun,
} from './types.js';
import type { JobState } from './states.js';

/** WebSocket-Eventtypen (Spezifikation) plus interne Zusatz-Events. */
export const WS_EVENT_TYPES = [
  'job.created',
  'job.updated',
  'job.state_changed',
  'job.started',
  'job.ready_for_human',
  'job.completed',
  'job.failed',
  'job.paused',
  'agent.started',
  'agent.output',
  'agent.completed',
  'agent.failed',
  'artifact.created',
  'review.passed',
  'review.failed',
  'test.started',
  'test.output',
  'test.completed',
  'log.truncated',
  'hello',
] as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[number];

export interface WsPayloads {
  'job.created': { job: JobSummary };
  'job.updated': { job: JobSummary };
  'job.state_changed': { job: JobSummary; fromState: JobState; toState: JobState };
  'job.started': { job: JobSummary };
  'job.ready_for_human': { job: JobSummary };
  'job.completed': { job: JobSummary };
  'job.failed': { job: JobSummary; error: string };
  'job.paused': { job: JobSummary };
  'agent.started': { runId: string; agent: AgentName; phase: AgentPhase };
  'agent.output': { runId: string; stream: 'stdout' | 'stderr'; text: string };
  'agent.completed': { runId: string; status: RunStatus; exitCode: number | null };
  'agent.failed': { runId: string; status: RunStatus; error: string };
  'artifact.created': { artifact: Omit<Artifact, 'content'> };
  'review.passed': { iteration: number };
  'review.failed': { iteration: number };
  'test.started': { testRunId: string; commandKey: string; command: string };
  'test.output': { testRunId: string; stream: 'stdout' | 'stderr'; text: string };
  'test.completed': { testRun: TestRun };
  /** Client-spezifisch: Ausgabe-Events wurden wegen Backpressure verworfen. */
  'log.truncated': { droppedCount: number };
  /** Begrüßung nach Connect: aktueller Sequenzstand für Gap-Erkennung. */
  hello: { seq: number; serverTime: IsoDateTime };
}

export interface WsEnvelope<T extends WsEventType = WsEventType> {
  type: T;
  /** Monotone Sequenz-ID aus `job_events`; null für nicht persistierte Events. */
  seq: number | null;
  ts: IsoDateTime;
  jobId: string | null;
  payload: WsPayloads[T];
}

export type AnyWsEnvelope = { [T in WsEventType]: WsEnvelope<T> }[WsEventType];
