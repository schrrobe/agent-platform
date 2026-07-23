<script setup lang="ts">
import type { JobState } from '@agent/shared';
import { useJobsStore } from '@/stores/jobs';
import { COLUMNS } from '@/lib/board';
import KanbanColumn from './KanbanColumn.vue';

const emit = defineEmits<{
  move: [jobId: string, to: JobState];
  open: [jobId: string];
  reorder: [jobId: string, afterJobId: string | null];
}>();

const jobs = useJobsStore();
</script>

<template>
  <div class="board scroll-x">
    <KanbanColumn
      v-for="column in COLUMNS"
      :key="column.key"
      :column="column"
      :jobs="column.states.flatMap((state) => jobs.byState[state])"
      :show-state="column.states.length > 1"
      @move="(id, to) => emit('move', id, to)"
      @open="emit('open', $event)"
      @reorder="(id, afterId) => emit('reorder', id, afterId)"
    />
  </div>
</template>

<style scoped>
.board {
  display: flex;
  gap: 12px;
  padding: 14px;
  height: 100%;
  align-items: stretch;
}
</style>
