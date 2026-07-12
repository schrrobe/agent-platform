<script setup lang="ts">
import type { AgentRun } from '@agent/shared';
import { formatDateTime } from '@/lib/format';

defineProps<{ runs: AgentRun[] }>();

function duration(run: AgentRun): string {
  if (!run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}
</script>

<template>
  <div class="runs">
    <div v-for="run in runs" :key="run.id" class="run card">
      <div class="head">
        <span class="agent">{{ run.agent }}</span>
        <span class="phase faint">{{ run.phase }}</span>
        <span class="status" :class="run.status">{{ run.status }}</span>
        <span class="faint">Exit {{ run.exitCode ?? '—' }}</span>
        <span class="faint">{{ duration(run) }}</span>
      </div>
      <div class="ts faint">{{ formatDateTime(run.startedAt) }}</div>
      <pre v-if="run.error" class="err">{{ run.error }}</pre>
    </div>
    <p v-if="runs.length === 0" class="faint">Noch keine Agentenläufe.</p>
  </div>
</template>

<style scoped>
.runs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.run {
  padding: 9px 11px;
}
.head {
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.agent {
  font-weight: 600;
  text-transform: capitalize;
}
.phase {
  text-transform: uppercase;
  font-size: 11px;
}
.status {
  font-size: 11px;
  text-transform: uppercase;
}
.status.completed {
  color: var(--c-done);
}
.status.failed,
.status.timeout {
  color: var(--c-fail);
}
.status.running {
  color: var(--c-active);
}
.status.canceled {
  color: var(--text-dim);
}
.ts {
  font-size: 11px;
  margin-top: 2px;
}
.err {
  color: var(--c-fail);
  margin-top: 6px;
  font-size: 11.5px;
}
</style>
