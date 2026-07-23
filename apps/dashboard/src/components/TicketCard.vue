<script setup lang="ts">
import { computed, ref } from 'vue';
import type { JobSummary } from '@agent/shared';
import { isActiveState } from '@agent/shared';
import {
  useCardDropTarget,
  useDraggableCard,
  type CardDragData,
  type Edge,
} from '@/composables/dnd';
import { PRIORITY_LABELS } from '@/lib/labels';
import { formatDuration, relativeTime, runtimeMs } from '@/lib/format';
import { useClock } from '@/composables/clock';
import { useSelectionStore } from '@/stores/selection';
import StatusBadge from '@/components/StatusBadge.vue';

const props = defineProps<{ job: JobSummary; showState?: boolean }>();
const emit = defineEmits<{
  open: [jobId: string];
  reorder: [draggedId: string, targetId: string, edge: Edge | null];
}>();

const selection = useSelectionStore();
// Nur Inbox-Jobs lassen sich zu einem Vorgang gruppieren.
const selectable = computed(() => props.job.state === 'inbox');
const selected = computed(() => selection.has(props.job.id));
const groupSize = computed(() => props.job.additionalTickets.length + 1);
const allIdentifiers = computed(() =>
  [props.job.ticket, ...props.job.additionalTickets].map((t) => t.identifier).join(', '),
);

const cardRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const edge = ref<Edge | null>(null);
useDraggableCard(
  cardRef,
  () => ({ jobId: props.job.id, from: props.job.state }),
  (d) => (dragging.value = d),
);

// Manuelles Umsortieren nur in den wartenden Spalten.
const reorderable = computed(
  () => props.job.state === 'inbox' || props.job.state === 'agent_ready',
);
useCardDropTarget(cardRef, {
  canDrop: (data: CardDragData) =>
    reorderable.value && data.from === props.job.state && data.jobId !== props.job.id,
  onDrop: (data, dropEdge) => emit('reorder', data.jobId, props.job.id, dropEdge),
  onEdgeChange: (e) => (edge.value = e),
});

const now = useClock();
const isActive = computed(() => isActiveState(props.job.state));
// Badge nur bei abweichender Priorität — normale (0) Tickets bleiben unmarkiert.
const priorityLabel = computed(() =>
  props.job.queuePriority === 0 ? null : (PRIORITY_LABELS[props.job.queuePriority] ?? null),
);
const runtime = computed(() =>
  formatDuration(runtimeMs(props.job.startedAt, props.job.finishedAt, now.value)),
);
</script>

<template>
  <article
    ref="cardRef"
    class="ticket card"
    :class="{
      dragging,
      active: isActive,
      selected,
      'edge-top': edge === 'top',
      'edge-bottom': edge === 'bottom',
    }"
    @click="emit('open', job.id)"
  >
    <header>
      <input
        v-if="selectable"
        type="checkbox"
        class="select"
        :checked="selected"
        title="Für Vorgang auswählen"
        @click.stop
        @change="selection.toggle(job.id)"
      />
      <span class="identifier">{{ job.ticket.identifier }}</span>
      <span v-if="groupSize > 1" class="vorgang" :title="allIdentifiers">
        ⧉ {{ groupSize }} Tickets
      </span>
      <span
        v-if="priorityLabel"
        class="priority"
        :class="job.queuePriority > 0 ? 'high' : 'low'"
        :title="`Queue-Priorität: ${priorityLabel}`"
      >
        {{ job.queuePriority > 0 ? '▲' : '▼' }}
      </span>
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
.ticket.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.select {
  cursor: pointer;
  margin: 0;
  flex-shrink: 0;
}
.vorgang {
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-dim);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}
.ticket.edge-top {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.ticket.edge-bottom {
  box-shadow: inset 0 -2px 0 0 var(--accent);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}
.identifier {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  margin-right: auto;
}
.priority {
  font-size: 11px;
}
.priority.high {
  color: var(--c-fail);
}
.priority.low {
  color: var(--text-dim);
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
