<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ArtifactType, JobState } from '@agent/shared';
import { ACTIVE_STATES, PAUSABLE_STATES } from '@agent/shared';
import { useJobDetailStore } from '@/stores/jobDetail';
import { useJobsStore } from '@/stores/jobs';
import { api } from '@/api/client';
import { formatDateTime } from '@/lib/format';
import StatusBadge from './StatusBadge.vue';
import WorkflowTimeline from './WorkflowTimeline.vue';
import LiveLogViewer from './LiveLogViewer.vue';
import AgentRunPanel from './AgentRunPanel.vue';
import ArtifactViewer from './ArtifactViewer.vue';
import GitDiffViewer from './GitDiffViewer.vue';
import TestRunPanel from './TestRunPanel.vue';
import ConfirmDialog from './ConfirmDialog.vue';

defineProps<{ mode: 'drawer' | 'page' }>();
const emit = defineEmits<{ close: [] }>();

const store = useJobDetailStore();
const jobs = useJobsStore();

const TABS = [
  'Beschreibung',
  'Verlauf',
  'Live-Logs',
  'PLAN.md',
  'REVIEW.md',
  'Diff',
  'Tests',
  'Fehler',
  'Metadaten',
  'Agentenläufe',
] as const;
type Tab = (typeof TABS)[number];
const tab = ref<Tab>('Beschreibung');

const detail = computed(() => store.detail);
const busy = ref(false);
const confirmCancel = ref(false);

function artifact(type: ArtifactType): string | null {
  const list = detail.value?.artifacts.filter((a) => a.type === type) ?? [];
  return list.length ? list[list.length - 1]!.content : null;
}

const canStart = computed(() => detail.value?.state === 'inbox');
const canRetry = computed(() =>
  detail.value ? ['failed', 'needs_human', 'paused'].includes(detail.value.state) : false,
);
const canPause = computed(() =>
  detail.value ? PAUSABLE_STATES.includes(detail.value.state) : false,
);
const canCancel = computed(() =>
  detail.value ? !['done', 'failed'].includes(detail.value.state) : false,
);
const canComplete = computed(() => detail.value?.state === 'needs_human');
const isActive = computed(() =>
  detail.value ? ACTIVE_STATES.includes(detail.value.state) : false,
);

async function act(fn: () => Promise<{ id: string; state: JobState }>): Promise<void> {
  busy.value = true;
  try {
    const job = await fn();
    jobs.upsert(job as never);
    await store.refresh();
  } finally {
    busy.value = false;
  }
}

const start = () => act(() => api.startJob(detail.value!.id));
const retry = () => act(() => api.retryJob(detail.value!.id));
const pause = () => act(() => api.pauseJob(detail.value!.id));
const complete = () => act(() => api.patchState(detail.value!.id, 'done'));
function doCancel(): void {
  confirmCancel.value = false;
  void act(() => api.cancelJob(detail.value!.id));
}
</script>

<template>
  <div class="drawer" :class="mode">
    <template v-if="detail">
      <header class="head">
        <div class="titles">
          <div class="row">
            <span class="identifier">{{ detail.ticket.identifier }}</span>
            <StatusBadge :state="detail.state" />
            <span v-if="detail.reviewLoopCount > 0" class="loops"
              >↻ {{ detail.reviewLoopCount }}</span
            >
          </div>
          <h2>{{ detail.ticket.title }}</h2>
        </div>
        <button v-if="mode === 'drawer'" class="close" @click="emit('close')">✕</button>
      </header>

      <div class="actions">
        <button v-if="canStart" class="primary" :disabled="busy" @click="start">▶ Start</button>
        <button v-if="canPause" :disabled="busy" @click="pause">⏸ Pause</button>
        <button v-if="canRetry" :disabled="busy" @click="retry">↻ Erneut</button>
        <button v-if="canComplete" :disabled="busy" @click="complete">✓ Erledigt</button>
        <button v-if="canCancel" class="danger" :disabled="busy" @click="confirmCancel = true">
          {{ isActive ? '⏹ Abbrechen' : '✕ Verwerfen' }}
        </button>
        <a class="linear-link" :href="detail.ticket.url" target="_blank" rel="noreferrer"
          >Linear ↗</a
        >
      </div>

      <nav class="tabs scroll-x">
        <button v-for="t in TABS" :key="t" :class="{ active: tab === t }" @click="tab = t">
          {{ t }}
        </button>
      </nav>

      <div class="tab-content">
        <ArtifactViewer
          v-if="tab === 'Beschreibung'"
          :content="detail.ticket.description"
          markdown
          empty="Keine Beschreibung."
        />
        <WorkflowTimeline v-else-if="tab === 'Verlauf'" :events="detail.events" />
        <LiveLogViewer v-else-if="tab === 'Live-Logs'" :logs="store.logs" />
        <ArtifactViewer
          v-else-if="tab === 'PLAN.md'"
          :content="artifact('plan')"
          markdown
          empty="Noch kein Plan."
        />
        <ArtifactViewer
          v-else-if="tab === 'REVIEW.md'"
          :content="artifact('review')"
          markdown
          empty="Kein Review (FAIL) vorhanden."
        />
        <GitDiffViewer v-else-if="tab === 'Diff'" :diff="artifact('diff')" />
        <TestRunPanel v-else-if="tab === 'Tests'" :test-runs="detail.testRuns" />
        <div v-else-if="tab === 'Fehler'" class="pad">
          <pre v-if="detail.lastError" class="err">{{ detail.lastError }}</pre>
          <p v-else class="faint">Kein Fehler.</p>
        </div>
        <div v-else-if="tab === 'Metadaten'" class="pad meta">
          <div><label>Projekt</label>{{ detail.projectName }}</div>
          <div>
            <label>Repository</label><code>{{ detail.repositoryPath }}</code>
          </div>
          <div>
            <label>Branch</label><code>{{ detail.branch ?? '—' }}</code>
          </div>
          <div>
            <label>Worktree</label><code>{{ detail.worktreePath ?? '—' }}</code>
          </div>
          <div><label>Team</label>{{ detail.ticket.teamName ?? '—' }}</div>
          <div><label>Priorität</label>{{ detail.ticket.priorityLabel ?? '—' }}</div>
          <div><label>Labels</label>{{ detail.ticket.labels.join(', ') || '—' }}</div>
          <div><label>Linear-Status</label>{{ detail.ticket.linearState ?? '—' }}</div>
          <div><label>Gestartet</label>{{ formatDateTime(detail.startedAt) }}</div>
          <div><label>Beendet</label>{{ formatDateTime(detail.finishedAt) }}</div>
        </div>
        <AgentRunPanel v-else-if="tab === 'Agentenläufe'" :runs="detail.agentRuns" />
      </div>
    </template>
    <div v-else-if="store.loading" class="pad faint">Lade …</div>
    <div v-else class="pad faint">Kein Job ausgewählt.</div>

    <ConfirmDialog
      :open="confirmCancel"
      title="Job abbrechen?"
      message="Laufende Prozesse werden hart beendet und der Job auf 'failed' gesetzt. Kein Merge/Push findet statt."
      confirm-label="Abbrechen erzwingen"
      danger
      @confirm="doCancel"
      @cancel="confirmCancel = false"
    />
  </div>
</template>

<style scoped>
.drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-elev);
}
.drawer.drawer {
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow);
}
.head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.identifier {
  font-family: var(--mono);
  color: var(--accent);
}
.loops {
  color: var(--c-warn);
  font-size: 12px;
}
.head h2 {
  margin: 6px 0 0;
  font-size: 16px;
}
.close {
  border: none;
  background: none;
  font-size: 16px;
  height: fit-content;
}
.actions {
  display: flex;
  gap: 8px;
  padding: 12px 18px;
  flex-wrap: wrap;
  align-items: center;
  border-bottom: 1px solid var(--border);
}
.linear-link {
  margin-left: auto;
  font-size: 12px;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.tabs button {
  border: none;
  background: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  color: var(--text-dim);
  padding: 7px 10px;
  white-space: nowrap;
}
.tabs button.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
}
.pad {
  overflow-y: auto;
}
.meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 20px;
}
.meta code {
  font-family: var(--mono);
  font-size: 12px;
  word-break: break-all;
}
.err {
  color: var(--c-fail);
}
</style>
