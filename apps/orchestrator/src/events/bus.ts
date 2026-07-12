import { EventEmitter } from 'node:events';
import type { AnyWsEnvelope } from '@agent/shared';

/**
 * Interner Event-Bus. Die Pipeline publiziert typisierte Envelopes; der
 * WebSocket-Hub abonniert und verteilt sie an verbundene Clients. Events werden
 * NICHT aus Logs geparst — der Bus ist die einzige Quelle.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Viele gleichzeitige WS-Clients sind erwartbar.
    this.emitter.setMaxListeners(0);
  }

  publish(envelope: AnyWsEnvelope): void {
    this.emitter.emit('event', envelope);
  }

  subscribe(listener: (envelope: AnyWsEnvelope) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
