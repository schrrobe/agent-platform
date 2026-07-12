import type { AnyWsEnvelope } from '@agent/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsClientHandlers {
  onEvent: (envelope: AnyWsEnvelope) => void;
  onStatus: (status: WsStatus) => void;
  /** Aufgerufen, wenn eine Sequenzlücke erkannt wurde → vollständiger Refetch. */
  onGap: () => void;
}

/**
 * WebSocket-Client mit automatischem Reconnect (exponentielles Backoff) und
 * Sequenzlücken-Erkennung. Persistierte Events tragen monotone Sequenz-IDs;
 * fehlt eine, lädt der Client den Zustand per REST neu — kein Polling.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private lastSeq = 0;
  private backoff = 500;
  private closedByUser = false;
  private reconnectTimer: number | null = null;

  constructor(private readonly handlers: WsClientHandlers) {}

  private url(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws`;
  }

  connect(): void {
    this.closedByUser = false;
    this.handlers.onStatus('connecting');
    const socket = new WebSocket(this.url());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoff = 500;
      this.handlers.onStatus('open');
      // Nach (Wieder-)Verbindung immer neu laden, um verpasste Events auszugleichen.
      this.handlers.onGap();
    });

    socket.addEventListener('message', (event) => {
      let envelope: AnyWsEnvelope;
      try {
        envelope = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (envelope.seq !== null) {
        if (this.lastSeq > 0 && envelope.seq > this.lastSeq + 1) {
          this.handlers.onGap();
        }
        this.lastSeq = Math.max(this.lastSeq, envelope.seq);
      }
      this.handlers.onEvent(envelope);
    });

    socket.addEventListener('close', () => {
      this.handlers.onStatus('closed');
      if (!this.closedByUser) this.scheduleReconnect();
    });
    socket.addEventListener('error', () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 10_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }
}
