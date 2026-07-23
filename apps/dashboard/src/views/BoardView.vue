<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { JobState } from '@agent/shared';
import { useJobsStore } from '@/stores/jobs';
import { useJobDetailStore } from '@/stores/jobDetail';
import { useSelectionStore } from '@/stores/selection';
import { api, ApiClientError } from '@/api/client';
import KanbanBoard from '@/components/KanbanBoard.vue';
import TicketDetailDrawer from '@/components/TicketDetailDrawer.vue';
import TicketImportDialog from '@/components/TicketImportDialog.vue';

const jobs = useJobsStore();
const detail = useJobDetailStore();
const selection = useSelectionStore();
const showImport = ref(false);
const drawerOpen = ref(false);
const notice = ref<string | null>(null);
const grouping = ref(false);
const selectedJobs = computed(() => jobs.jobs.filter((job) => selection.has(job.id)));
const canGroup = computed(() => {
  if (selectedJobs.value.length < 2 || selectedJobs.value.some((job) => job.state !== 'inbox')) {
    return false;
  }
  return new Set(selectedJobs.value.map((job) => job.projectId)).size === 1;
});

watch(
  () => jobs.jobs.map((job) => `${job.id}:${job.state}`).join('|'),
  () => {
    for (const job of selectedJobs.value) {
      if (job.state !== 'inbox') selection.remove(job.id);
    }
  },
);

async function groupSelected(): Promise<void> {
  if (!canGroup.value) return;
  notice.value = null;
  grouping.value = true;
  try {
    const survivor = await api.groupJobs(selectedJobs.value.map((job) => job.id));
    jobs.upsert(survivor);
    for (const id of selection.ids) if (id !== survivor.id) jobs.remove(id);
    selection.clear();
  } catch (err) {
    notice.value = err instanceof ApiClientError ? err.message : (err as Error).message;
    await jobs.load();
  } finally {
    grouping.value = false;
  }
}

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

async function reorder(jobId: string, afterJobId: string | null): Promise<void> {
  notice.value = null;
  try {
    const job = await api.reorderJob(jobId, afterJobId);
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
      <button class="primary" @click="showImport = true">+ Tickets importieren</button>
      <span class="muted">{{ jobs.jobs.length }} Tickets</span>
      <template v-if="selection.count > 0">
        <button class="primary" :disabled="!canGroup || grouping" @click="groupSelected">
          Als Vorgang gruppieren ({{ selection.count }})
        </button>
        <button @click="selection.clear()">Auswahl aufheben</button>
      </template>
      <span v-if="jobs.error" class="err">{{ jobs.error }}</span>
      <span v-if="notice" class="err">{{ notice }}</span>
    </div>

    <KanbanBoard class="board" @move="move" @open="open" @reorder="reorder" />

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
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 50;
}
.drawer {
  width: min(680px, 100%);
  max-height: 100%;
}
</style>
