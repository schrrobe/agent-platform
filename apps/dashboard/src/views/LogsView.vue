<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { useJobsStore } from '@/stores/jobs';
import { useWsStore } from '@/stores/ws';
import { relativeTime } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge.vue';

const jobs = useJobsStore();
const ws = useWsStore();

const activity = computed(() =>
  [...jobs.jobs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
);
</script>

<template>
  <div class="logs scroll-area">
    <h1>Aktivität</h1>
    <p class="muted">
      Live-Verbindung: <strong>{{ ws.status }}</strong>
      <span v-if="ws.droppedTotal > 0">
        · {{ ws.droppedTotal }} Ereignisse wegen Last verworfen (Detail lädt vollständig nach)</span
      >
    </p>

    <table class="feed">
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Status</th>
          <th>Agent</th>
          <th>Letzter Fehler</th>
          <th>Aktualisiert</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in activity" :key="job.id">
          <td>
            <RouterLink :to="`/jobs/${job.id}`" class="mono">{{
              job.ticket.identifier
            }}</RouterLink>
            <div class="title faint">{{ job.ticket.title }}</div>
          </td>
          <td><StatusBadge :state="job.state" /></td>
          <td class="muted">{{ job.currentAgent ?? '—' }}</td>
          <td class="err">{{ job.lastError ?? '' }}</td>
          <td class="muted">{{ relativeTime(job.updatedAt) }}</td>
        </tr>
        <tr v-if="activity.length === 0">
          <td colspan="5" class="faint">Keine Aktivität.</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.scroll-area {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px;
}
h1 {
  font-size: 20px;
  margin: 0 0 6px;
}
.feed {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
}
.feed th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  color: var(--text-faint);
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.feed td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.mono {
  font-family: var(--mono);
}
.title {
  font-size: 12px;
  margin-top: 2px;
}
.err {
  color: var(--c-fail);
  font-size: 12px;
  max-width: 320px;
}
</style>
