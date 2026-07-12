import { defineStore } from 'pinia';
import { ref } from 'vue';
import { WsClient, type WsStatus } from '@/api/ws';
import { useJobsStore } from './jobs';
import { useJobDetailStore } from './jobDetail';

/**
 * Verbindet den WebSocket-Client mit den Stores. Live-Events aktualisieren
 * Board und Detailansicht; bei Verbindungsaufbau oder Sequenzlücke wird der
 * Zustand vollständig neu geladen (kein Polling).
 */
export const useWsStore = defineStore('ws', () => {
  const status = ref<WsStatus>('closed');
  const droppedTotal = ref(0);
  let client: WsClient | null = null;

  function connect(): void {
    if (client) return;
    const jobs = useJobsStore();
    const jobDetail = useJobDetailStore();
    client = new WsClient({
      onStatus: (s) => (status.value = s),
      onEvent: (envelope) => {
        if (envelope.type === 'log.truncated') {
          droppedTotal.value += envelope.payload.droppedCount;
          return;
        }
        jobs.applyEnvelope(envelope);
        jobDetail.applyEnvelope(envelope);
      },
      onGap: () => {
        void jobs.load();
        void jobDetail.refresh();
      },
    });
    client.connect();
  }

  function disconnect(): void {
    client?.close();
    client = null;
    status.value = 'closed';
  }

  return { status, droppedTotal, connect, disconnect };
});
