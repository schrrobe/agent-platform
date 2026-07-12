import type { FastifyInstance } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import type { WebSocket } from '@fastify/websocket';
import type { AnyWsEnvelope } from '@agent/shared';
import type { AppContext } from '../context.js';

/** Ab dieser Puffergröße (Bytes) werden Events verworfen (ADR-012). */
const BACKPRESSURE_LIMIT = 1024 * 1024;

/**
 * WebSocket-Hub. Verteilt Bus-Events an alle Clients. Bei langsamen Clients
 * (voller Sendepuffer) werden Events verworfen und mit `log.truncated`
 * angekündigt — die kanonische Historie liegt in DB/NDJSON und wird nach
 * Reconnect über REST nachgeladen (Sequenz-IDs erlauben Lückenerkennung).
 */
export async function registerWebSocket(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(websocketPlugin, { options: { maxPayload: 4 * 1024 * 1024 } });

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    let dropped = 0;

    const send = (envelope: AnyWsEnvelope): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > BACKPRESSURE_LIMIT) {
        dropped += 1;
        return;
      }
      try {
        if (dropped > 0) {
          socket.send(
            JSON.stringify({
              type: 'log.truncated',
              seq: null,
              ts: new Date().toISOString(),
              jobId: null,
              payload: { droppedCount: dropped },
            }),
          );
          dropped = 0;
        }
        socket.send(JSON.stringify(envelope));
      } catch {
        // Verbindung inzwischen geschlossen — ignorieren.
      }
    };

    // Begrüßung: aktueller Sequenzstand zur Lückenerkennung nach Reconnect.
    send({
      type: 'hello',
      seq: ctx.repos.jobEvents.lastSeq(),
      ts: new Date().toISOString(),
      jobId: null,
      payload: { seq: ctx.repos.jobEvents.lastSeq(), serverTime: new Date().toISOString() },
    });

    const unsubscribe = ctx.bus.subscribe(send);
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
  });
}
