<script setup lang="ts">
import { ref } from 'vue';
import type { TestRun } from '@agent/shared';

defineProps<{ testRuns: TestRun[] }>();
const expanded = ref<Set<string>>(new Set());

function toggle(id: string): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}
</script>

<template>
  <div class="tests">
    <div v-for="run in testRuns" :key="run.id" class="test card">
      <button class="head" @click="toggle(run.id)">
        <span class="key">{{ run.commandKey }}</span>
        <code class="cmd">{{ run.command }}</code>
        <span class="it faint">#{{ run.iteration }}</span>
        <span class="status" :class="run.exitCode === 0 ? 'ok' : 'bad'">
          {{ run.exitCode === 0 ? 'OK' : `Exit ${run.exitCode ?? '—'}` }}
        </span>
      </button>
      <div v-if="expanded.has(run.id)" class="output">
        <pre v-if="run.stdout" class="scroll-x">{{ run.stdout }}</pre>
        <pre v-if="run.stderr" class="scroll-x err">{{ run.stderr }}</pre>
      </div>
    </div>
    <p v-if="testRuns.length === 0" class="faint">Keine Testläufe.</p>
  </div>
</template>

<style scoped>
.tests {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 10px 11px;
}
.key {
  text-transform: uppercase;
  font-size: 11px;
  color: var(--text-dim);
  width: 78px;
  flex-shrink: 0;
}
.cmd {
  font-family: var(--mono);
  font-size: 12px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status.ok {
  color: var(--c-done);
}
.status.bad {
  color: var(--c-fail);
}
.output {
  padding: 0 11px 11px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.output pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px;
  max-height: 260px;
  overflow: auto;
}
.output pre.err {
  color: var(--c-fail);
}
</style>
