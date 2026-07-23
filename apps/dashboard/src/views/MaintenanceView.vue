<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { WorktreeInfo } from '@agent/shared';
import { api, ApiClientError } from '@/api/client';
import { formatSizeKb } from '@/lib/format';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const worktrees = ref<WorktreeInfo[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);
const target = ref<WorktreeInfo | null>(null);

const totalSizeKb = computed(() =>
  worktrees.value.reduce((sum, wt) => sum + (wt.sizeKb ?? 0), 0),
);

const STATUS_LABELS: Record<WorktreeInfo['status'], string> = {
  active: 'aktiv',
  bound: 'gebunden',
  orphaned: 'verwaist',
};

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    worktrees.value = await api.listMaintenanceWorktrees();
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  } finally {
    loading.value = false;
  }
}

function removable(wt: WorktreeInfo): boolean {
  return wt.status !== 'active' && !wt.dirty;
}

async function confirmRemove(): Promise<void> {
  if (!target.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.removeMaintenanceWorktree({
      projectId: target.value.projectId,
      path: target.value.path,
      jobId: target.value.jobId,
    });
    target.value = null;
    await load();
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="view">
    <header class="head">
      <div>
        <h2>Worktree-Wartung</h2>
        <p class="muted">
          {{ worktrees.length }} Worktree(s), zusammen {{ formatSizeKb(totalSizeKb) }}.
        </p>
      </div>
      <button :disabled="loading" @click="load">{{ loading ? 'Lädt…' : 'Aktualisieren' }}</button>
    </header>

    <p v-if="error" class="warn">{{ error }}</p>

    <div v-if="loading && worktrees.length === 0" class="muted state">Lade Worktrees…</div>
    <p v-else-if="worktrees.length === 0" class="muted state">Keine Worktrees gefunden.</p>

    <div v-else class="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Projekt</th>
            <th>Pfad</th>
            <th>Branch</th>
            <th>Status</th>
            <th class="num">Größe</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="wt in worktrees" :key="wt.path">
            <td>{{ wt.projectName }}</td>
            <td class="path" :title="wt.path">
              …/{{ wt.path.split('/').slice(-2).join('/') }}
              <span v-if="wt.ticketIdentifier" class="faint">({{ wt.ticketIdentifier }})</span>
            </td>
            <td class="mono">{{ wt.branch ?? '—' }}</td>
            <td>
              <span class="badge" :class="wt.status">{{ STATUS_LABELS[wt.status] }}</span>
              <span v-if="wt.dirty" class="badge dirty">dirty</span>
            </td>
            <td class="num">{{ formatSizeKb(wt.sizeKb) }}</td>
            <td class="num">
              <button
                class="danger"
                :disabled="!removable(wt) || busy"
                :title="
                  wt.status === 'active'
                    ? 'Job läuft oder ist eingeplant'
                    : wt.dirty
                      ? 'Uncommittete Änderungen — nicht löschbar'
                      : 'Worktree entfernen'
                "
                @click="target = wt"
              >
                Entfernen
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ConfirmDialog
      :open="target !== null"
      title="Worktree entfernen?"
      :message="
        target
          ? `${target.path} wird per git worktree remove entfernt. Der Branch bleibt bestehen.`
          : ''
      "
      confirm-label="Entfernen"
      danger
      @confirm="confirmRemove"
      @cancel="target = null"
    />
  </div>
</template>

<style scoped>
.view {
  padding: 18px 22px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}
.head h2 {
  margin: 0 0 4px;
}
.state {
  padding: 24px 0;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
th {
  color: var(--text-dim);
  font-weight: 500;
}
.num {
  text-align: right;
  white-space: nowrap;
}
.path {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mono {
  font-family: var(--mono);
  font-size: 12px;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--text-dim);
}
.badge.orphaned {
  color: var(--c-warn);
}
.badge.active {
  color: var(--c-active);
}
.badge.dirty {
  color: var(--c-fail);
  margin-left: 4px;
}
.warn {
  color: var(--c-fail);
  font-size: 12.5px;
}
</style>
