<script setup lang="ts">
import type { JobState } from '@agent/shared';
import { useJobsStore } from '@/stores/jobs';
import { COLUMNS } from '@/lib/board';
import KanbanColumn from './KanbanColumn.vue';

const emit = defineEmits<{ move: [jobId: string, to: JobState]; open: [jobId: string] }>();

const jobs = useJobsStore();
</script>

<template>
  <div class="board scroll-x">
    <KanbanColumn
      v-for="column in COLUMNS"
      :key="column.state"
      :column="column"
      :jobs="jobs.byState[column.state]"
      @move="(id, to) => emit('move', id, to)"
      @open="emit('open', $event)"
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
