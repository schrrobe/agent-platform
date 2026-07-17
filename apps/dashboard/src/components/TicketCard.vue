<script setup lang="ts">
import { computed, ref } from 'vue';
import type { JobSummary } from '@agent/shared';
import { isActiveState } from '@agent/shared';
import { useDraggableCard } from '@/composables/dnd';
import { formatDuration, relativeTime, runtimeMs } from '@/lib/format';
import { useClock } from '@/composables/clock';
import StatusBadge from '@/components/StatusBadge.vue';

const props = defineProps<{ job: JobSummary; showState?: boolean }>();
const emit = defineEmits<{ open: [jobId: string] }>();

const cardRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
useDraggableCard(
  cardRef,
  () => ({ jobId: props.job.id, from: props.job.state }),
  (d) => (dragging.value = d),
);

const now = useClock();
const isActive = computed(() => isActiveState(props.job.state));
const runtime = computed(() =>
  formatDuration(runtimeMs(props.job.startedAt, props.job.finishedAt, now.value)),
);
</script>

<template>
  <article
    ref="cardRef"
    class="ticket card"
    :class="{ dragging, active: isActive }"
    @click="emit('open', job.id)"
  >
    <header>
      <span class="identifier">{{ job.ticket.identifier }}</span>
      <StatusBadge v-if="showState" :state="job.state" />
      <span v-if="job.reviewLoopCount > 0" class="loops" title="Review-Schleifen">
        ↻ {{ job.reviewLoopCount }}
      </span>
    </header>
    <div class="title">{{ job.ticket.title }}</div>

    <div class="meta">
      <span v-if="job.currentAgent" class="agent">{{ job.currentAgent }}</span>
      <span v-if="job.startedAt" class="runtime">⏱ {{ runtime }}</span>
    </div>

    <div class="repo faint">
      <span>{{ job.projectName }}</span>
      <span v-if="job.branch" class="branch" :title="job.branch">⎇ {{ job.branch }}</span>
    </div>

    <div v-if="job.lastError" class="error" :title="job.lastError">⚠ {{ job.lastError }}</div>

    <footer class="faint">{{ relativeTime(job.updatedAt, now) }}</footer>
  </article>
</template>

<style scoped>
.ticket {
  padding: 10px 11px;
  cursor: grab;
  display: flex;
  flex-direction: column;
  gap: 6px;
  user-select: none;
}
.ticket:hover {
  border-color: var(--accent-dim);
}
.ticket.dragging {
  opacity: 0.4;
}
.ticket.active {
  border-left: 3px solid var(--c-active);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.identifier {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
}
.loops {
  font-size: 11px;
  color: var(--c-warn);
}
.title {
  font-weight: 500;
  line-height: 1.35;
}
.meta {
  display: flex;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-dim);
}
.agent {
  text-transform: capitalize;
  color: var(--c-active);
}
.repo {
  display: flex;
  gap: 8px;
  font-size: 11px;
  justify-content: space-between;
}
.branch {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}
.error {
  font-size: 11px;
  color: var(--c-fail);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
footer {
  font-size: 10.5px;
}
</style>
