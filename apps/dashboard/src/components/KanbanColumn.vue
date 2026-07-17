<script setup lang="ts">
import { ref } from 'vue';
import type { JobState, JobSummary } from '@agent/shared';
import type { ColumnDef } from '@/lib/board';
import { canDropTo } from '@/lib/board';
import { useDropTarget, type CardDragData } from '@/composables/dnd';
import TicketCard from './TicketCard.vue';

const props = defineProps<{ column: ColumnDef; jobs: JobSummary[]; showState?: boolean }>();
const emit = defineEmits<{ move: [jobId: string, to: JobState]; open: [jobId: string] }>();

const columnRef = ref<HTMLElement | null>(null);
const over = ref(false);
const allowed = ref(false);

useDropTarget(columnRef, {
  canDrop: (data: CardDragData) =>
    props.column.dropTarget !== undefined && canDropTo(data.from, props.column.dropTarget),
  onDrop: (data: CardDragData) => {
    if (props.column.dropTarget !== undefined) emit('move', data.jobId, props.column.dropTarget);
  },
  onOverChange: (isOver, isAllowed) => {
    over.value = isOver;
    allowed.value = isAllowed;
  },
});
</script>

<template>
  <section
    ref="columnRef"
    class="column"
    :class="{ over, allowed, forbidden: over && !allowed }"
    :style="{ '--accent': column.accent }"
  >
    <header>
      <span class="dot" />
      <span class="label">{{ column.label }}</span>
      <span class="count">{{ jobs.length }}</span>
    </header>
    <div class="cards">
      <TicketCard
        v-for="job in jobs"
        :key="job.id"
        :job="job"
        :show-state="showState"
        @open="emit('open', $event)"
      />
      <p v-if="jobs.length === 0" class="empty faint">—</p>
    </div>
  </section>
</template>

<style scoped>
.column {
  display: flex;
  flex-direction: column;
  min-width: 250px;
  width: 250px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-top: 2px solid var(--accent);
  border-radius: var(--radius);
  max-height: 100%;
}
.column.over.allowed {
  border-color: var(--c-done);
  box-shadow: inset 0 0 0 1px var(--c-done);
}
.column.forbidden {
  border-color: var(--c-fail);
  box-shadow: inset 0 0 0 1px var(--c-fail);
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
.label {
  font-weight: 600;
  font-size: 12.5px;
  flex: 1;
}
.count {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg);
  padding: 1px 7px;
  border-radius: 999px;
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px;
  overflow-y: auto;
  flex: 1;
}
.empty {
  text-align: center;
  padding: 12px 0;
  font-size: 12px;
}
</style>
