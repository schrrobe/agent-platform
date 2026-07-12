import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AnyWsEnvelope, JobDetail, LogLine } from '@agent/shared';
import { api } from '@/api/client';

export const useJobDetailStore = defineStore('jobDetail', () => {
  const detail = ref<JobDetail | null>(null);
  const logs = ref<LogLine[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let liveSeq = 1_000_000; // Lokale Sequenz für nicht persistierte Live-Logs.

  async function open(jobId: string): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [d, l] = await Promise.all([api.getJob(jobId), api.getLogs(jobId)]);
      detail.value = d;
      logs.value = l;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function refresh(): Promise<void> {
    if (detail.value) await open(detail.value.id);
  }

  function close(): void {
    detail.value = null;
    logs.value = [];
  }

  function applyEnvelope(envelope: AnyWsEnvelope): void {
    const current = detail.value;
    if (!current || envelope.jobId !== current.id) return;
    switch (envelope.type) {
      case 'agent.output':
        logs.value = [
          ...logs.value,
          {
            seq: (liveSeq += 1),
            ts: envelope.ts,
            source: 'agent',
            stream: envelope.payload.stream,
            text: envelope.payload.text,
          },
        ];
        break;
      case 'test.output':
        logs.value = [
          ...logs.value,
          {
            seq: (liveSeq += 1),
            ts: envelope.ts,
            source: 'test',
            stream: envelope.payload.stream,
            text: envelope.payload.text,
          },
        ];
        break;
      case 'job.state_changed':
      case 'agent.completed':
      case 'agent.started':
      case 'artifact.created':
      case 'review.passed':
      case 'review.failed':
      case 'test.completed':
        // Verlaufsdaten neu laden (günstig, lokal).
        void refresh();
        break;
      default:
        break;
    }
  }

  return { detail, logs, loading, error, open, refresh, close, applyEnvelope };
});
