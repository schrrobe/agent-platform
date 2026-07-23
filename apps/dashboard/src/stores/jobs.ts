import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AnyWsEnvelope, JobState, JobSummary } from '@agent/shared';
import { JOB_STATES, compareQueueOrder } from '@agent/shared';
import { api } from '@/api/client';

export const useJobsStore = defineStore('jobs', () => {
  const jobsById = ref<Record<string, JobSummary>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  const jobs = computed(() =>
    Object.values(jobsById.value).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    ),
  );

  const byState = computed<Record<JobState, JobSummary[]>>(() => {
    const map = Object.fromEntries(JOB_STATES.map((s) => [s, [] as JobSummary[]])) as Record<
      JobState,
      JobSummary[]
    >;
    for (const job of jobs.value) map[job.state].push(job);
    for (const state of JOB_STATES) {
      map[state].sort(compareQueueOrder);
    }
    return map;
  });

  function upsert(job: JobSummary): void {
    jobsById.value = { ...jobsById.value, [job.id]: job };
  }

  function remove(jobId: string): void {
    const next = { ...jobsById.value };
    delete next[jobId];
    jobsById.value = next;
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const list = await api.listJobs();
      jobsById.value = Object.fromEntries(list.map((job) => [job.id, job]));
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** Aktualisiert den Board-Zustand aus einem WebSocket-Ereignis. */
  function applyEnvelope(envelope: AnyWsEnvelope): void {
    switch (envelope.type) {
      case 'job.created':
      case 'job.updated':
      case 'job.started':
      case 'job.ready_for_human':
      case 'job.completed':
      case 'job.paused':
        upsert(envelope.payload.job);
        break;
      case 'job.state_changed':
        upsert(envelope.payload.job);
        break;
      case 'job.failed':
        upsert(envelope.payload.job);
        break;
      case 'job.deleted':
        remove(envelope.payload.jobId);
        break;
      default:
        break;
    }
  }

  return { jobsById, jobs, byState, loading, error, load, upsert, remove, applyEnvelope };
});
