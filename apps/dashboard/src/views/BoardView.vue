<script setup lang="ts">
import { ref } from 'vue';
import type { JobState } from '@agent/shared';
import { useJobsStore } from '@/stores/jobs';
import { useJobDetailStore } from '@/stores/jobDetail';
import { api, ApiClientError } from '@/api/client';
import KanbanBoard from '@/components/KanbanBoard.vue';
import TicketDetailDrawer from '@/components/TicketDetailDrawer.vue';
import TicketImportDialog from '@/components/TicketImportDialog.vue';

const jobs = useJobsStore();
const detail = useJobDetailStore();
const showImport = ref(false);
const drawerOpen = ref(false);
const notice = ref<string | null>(null);

async function open(jobId: string): Promise<void> {
  drawerOpen.value = true;
  await detail.open(jobId);
}
function closeDrawer(): void {
  drawerOpen.value = false;
  detail.close();
}

async function move(jobId: string, to: JobState): Promise<void> {
  notice.value = null;
  try {
    const job = await api.patchState(jobId, to);
    jobs.upsert(job);
  } catch (err) {
    notice.value = err instanceof ApiClientError ? err.message : (err as Error).message;
    await jobs.load();
  }
}
</script>

<template>
  <div class="board-view">
    <div class="toolbar">
      <button class="primary" @click="showImport = true">+ Ticket importieren</button>
      <span class="muted">{{ jobs.jobs.length }} Tickets</span>
      <span v-if="jobs.error" class="err">{{ jobs.error }}</span>
      <span v-if="notice" class="err">{{ notice }}</span>
    </div>

    <KanbanBoard class="board" @move="move" @open="open" />

    <div v-if="drawerOpen" class="drawer-overlay" @click.self="closeDrawer">
      <TicketDetailDrawer mode="drawer" class="drawer" @close="closeDrawer" />
    </div>

    <TicketImportDialog v-if="showImport" @close="showImport = false" />
  </div>
</template>

<style scoped>
.board-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.board {
  flex: 1;
  min-height: 0;
}
.err {
  color: var(--c-fail);
  font-size: 12.5px;
}
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: flex-end;
  z-index: 50;
}
.drawer {
  width: min(680px, 100vw);
}
</style>
