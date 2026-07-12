import type { AnyWsEnvelope, JobState, WsEventType, WsPayloads } from '@agent/shared';
import type { JobEventsRepository } from '@agent/database';
import type { EventBus } from './bus.js';

/**
 * Brücke zwischen Workflow-Historie und WebSocket. `record` schreibt ein
 * unveränderliches job_event (dessen Auto-Increment-ID als Sequenznummer dient)
 * und sendet es mit dieser Sequenz. `emit` verschickt flüchtige, hochvolumige
 * Events (Agenten-/Testausgabe) ohne Persistenz und ohne Sequenz.
 */
export class Publisher {
  constructor(
    private readonly bus: EventBus,
    private readonly jobEvents: JobEventsRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  record<T extends WsEventType>(input: {
    type: T;
    jobId: string;
    payload: WsPayloads[T];
    fromState?: JobState | null;
    toState?: JobState | null;
    message?: string | null;
    data?: unknown;
  }): AnyWsEnvelope {
    const event = this.jobEvents.append({
      jobId: input.jobId,
      type: input.type,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      message: input.message ?? null,
      data: input.data,
    });
    const envelope = {
      type: input.type,
      seq: event.id,
      ts: event.ts,
      jobId: input.jobId,
      payload: input.payload,
    } as AnyWsEnvelope;
    this.bus.publish(envelope);
    return envelope;
  }

  emit<T extends WsEventType>(type: T, jobId: string | null, payload: WsPayloads[T]): void {
    this.bus.publish({
      type,
      seq: null,
      ts: this.clock(),
      jobId,
      payload,
    } as AnyWsEnvelope);
  }
}
