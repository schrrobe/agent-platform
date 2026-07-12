<script setup lang="ts">
import type { JobEvent } from '@agent/shared';
import { formatDateTime } from '@/lib/format';

defineProps<{ events: JobEvent[] }>();
</script>

<template>
  <ol class="timeline">
    <li v-for="event in events" :key="event.id" class="entry">
      <div class="marker" />
      <div class="body">
        <div class="line">
          <strong>{{ event.type }}</strong>
          <span v-if="event.fromState && event.toState" class="transition faint">
            {{ event.fromState }} → {{ event.toState }}
          </span>
        </div>
        <div v-if="event.message" class="message muted">{{ event.message }}</div>
        <div class="ts faint">{{ formatDateTime(event.ts) }} · #{{ event.id }}</div>
      </div>
    </li>
    <li v-if="events.length === 0" class="faint">Noch keine Ereignisse.</li>
  </ol>
</template>

<style scoped>
.timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.entry {
  display: flex;
  gap: 12px;
  padding: 0 0 14px;
  position: relative;
}
.entry:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 12px;
  bottom: 0;
  width: 1px;
  background: var(--border);
}
.marker {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--accent);
  margin-top: 4px;
  flex-shrink: 0;
  z-index: 1;
}
.line {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.transition {
  font-family: var(--mono);
  font-size: 11.5px;
}
.message {
  font-size: 12.5px;
}
.ts {
  font-size: 11px;
  margin-top: 2px;
}
</style>
