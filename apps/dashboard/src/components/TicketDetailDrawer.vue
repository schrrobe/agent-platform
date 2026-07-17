<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
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

const props = defineProps<{ mode: 'drawer' | 'page' }>();
const emit = defineEmits<{ close: [] }>();
const router = useRouter();

const store = useJobDetailStore();
const jobs = useJobsStore();

const TABS = [
  'Beschreibung',
  'Verlauf',
  'Live-Logs',
  'PLAN.md',
  'Freigabe',
  'Implementierung',
  'REVIEW.md',
  'Diff',
  'Handoff',
  'GitHub-Review',
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
const confirmReset = ref(false);
const confirmDelete = ref(false);
const removeWorktree = ref(false);
const approvalNote = ref('');
const actionMessage = ref<string | null>(null);
const actionError = ref<string | null>(null);
const editingDescription = ref(false);
const descriptionDraft = ref('');

function artifact(type: ArtifactType): string | null {
  const list = detail.value?.artifacts.filter((a) => a.type === type) ?? [];
  return list.length ? list[list.length - 1]!.content : null;
}

const canStart = computed(() => detail.value?.state === 'inbox');
const canRetry = computed(() =>
  detail.value
    ? !detail.value.baseStale && ['failed', 'needs_human', 'paused'].includes(detail.value.state)
    : false,
);
const canApprove = computed(() => detail.value?.state === 'awaiting_plan_approval');
const canPause = computed(() =>
  detail.value ? PAUSABLE_STATES.includes(detail.value.state) : false,
);
const canCancel = computed(() =>
  detail.value
    ? detail.value.currentAgent != null ||
      !['done', 'failed', 'ready_for_human', 'awaiting_plan_approval'].includes(detail.value.state)
    : false,
);
const canComplete = computed(() => detail.value?.state === 'ready_for_human');
const canAcceptHuman = computed(() => detail.value?.state === 'needs_human');
const canGithubReview = computed(() =>
  detail.value
    ? ['ready_for_human', 'done'].includes(detail.value.state) &&
      detail.value.branch != null &&
      detail.value.currentAgent == null
    : false,
);
const cancelIsPostRun = computed(() =>
  detail.value
    ? detail.value.currentAgent != null && ['ready_for_human', 'done'].includes(detail.value.state)
    : false,
);
const isActive = computed(() =>
  detail.value ? ACTIVE_STATES.includes(detail.value.state) : false,
);
const canManageJob = computed(() =>
  detail.value
    ? detail.value.currentAgent == null &&
      detail.value.activePgid == null &&
      detail.value.state !== 'agent_ready' &&
      !ACTIVE_STATES.includes(detail.value.state)
    : false,
);
const descriptionChanged = computed(
  () => detail.value != null && descriptionDraft.value !== detail.value.ticket.description,
);

function editDescription(): void {
  if (!detail.value || !canManageJob.value) return;
  descriptionDraft.value = detail.value.ticket.description;
  editingDescription.value = true;
  actionMessage.value = null;
  actionError.value = null;
}

function cancelDescriptionEdit(): void {
  editingDescription.value = false;
  descriptionDraft.value = detail.value?.ticket.description ?? '';
}

async function saveDescription(): Promise<void> {
  if (!detail.value || !descriptionChanged.value) return;
  busy.value = true;
  actionMessage.value = null;
  actionError.value = null;
  try {
    const job = await api.updateTicketDescription(detail.value.id, descriptionDraft.value);
    jobs.upsert(job);
    await store.refresh();
    editingDescription.value = false;
    actionMessage.value = 'Beschreibung wurde lokal und in Linear aktualisiert.';
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}

async function act(fn: () => Promise<{ id: string; state: JobState }>): Promise<void> {
  busy.value = true;
  actionMessage.value = null;
  actionError.value = null;
  try {
    const job = await fn();
    jobs.upsert(job as never);
    await store.refresh();
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}

const start = () => act(() => api.startJob(detail.value!.id));
const retry = () => act(() => api.retryJob(detail.value!.id));
const pause = () => act(() => api.pauseJob(detail.value!.id));
const approve = () =>
  act(() => api.approvePlan(detail.value!.id, approvalNote.value)).then(() => {
    approvalNote.value = '';
  });
const complete = () => act(() => api.patchState(detail.value!.id, 'done'));
const acceptHuman = () => act(() => api.patchState(detail.value!.id, 'ready_for_human'));
async function runGithubReview(): Promise<void> {
  busy.value = true;
  actionMessage.value = null;
  actionError.value = null;
  try {
    const { job, result } = await api.runGithubReview(detail.value!.id);
    jobs.upsert(job as never);
    actionMessage.value =
      result.openThreadCount === 0
        ? 'Keine offenen GitHub-Review-Kommentare gefunden.'
        : `${result.addressedThreadCount}/${result.openThreadCount} GitHub-Threads aufgelöst` +
          (result.pushed
            ? ` · Upstream${result.commit ? ` mit ${result.commit.slice(0, 8)}` : ''} aktualisiert`
            : ' · Upstream bereits synchron');
    await store.refresh();
  } catch (error) {
    actionError.value = (error as Error).message;
    await store.refresh();
  } finally {
    busy.value = false;
  }
}
function doCancel(): void {
  confirmCancel.value = false;
  void act(() => api.cancelJob(detail.value!.id));
}

function openReset(): void {
  removeWorktree.value = false;
  confirmReset.value = true;
}

function openDelete(): void {
  removeWorktree.value = false;
  confirmDelete.value = true;
}

async function resetJob(): Promise<void> {
  confirmReset.value = false;
  busy.value = true;
  actionError.value = null;
  try {
    const job = await api.resetJob(detail.value!.id, removeWorktree.value);
    jobs.upsert(job);
    await store.open(job.id);
    actionMessage.value = 'Job wurde vollständig auf Inbox zurückgesetzt.';
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
}

async function deleteJob(): Promise<void> {
  confirmDelete.value = false;
  busy.value = true;
  actionError.value = null;
  const jobId = detail.value!.id;
  try {
    await api.deleteJob(jobId, removeWorktree.value);
    jobs.remove(jobId);
    store.close();
    if (props.mode === 'page') await router.push('/');
    else emit('close');
  } catch (error) {
    actionError.value = (error as Error).message;
  } finally {
    busy.value = false;
  }
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
        <button v-if="canApprove" class="primary" :disabled="busy" @click="approve">
          ✓ Plan freigeben
        </button>
        <button v-if="canComplete" :disabled="busy" @click="complete">✓ Handoff bestätigt</button>
        <button v-if="canAcceptHuman" :disabled="busy" @click="acceptHuman">
          ✓ Manuell zur Übergabe freigeben
        </button>
        <button v-if="canGithubReview" :disabled="busy" @click="runGithubReview">
          {{ busy ? 'Codex prüft GitHub …' : '↻ GitHub-Kommentare mit Codex' }}
        </button>
        <button v-if="canCancel" class="danger" :disabled="busy" @click="confirmCancel = true">
          {{ isActive ? '⏹ Abbrechen' : '✕ Verwerfen' }}
        </button>
        <button v-if="canManageJob" :disabled="busy" @click="openReset">
          ↺ Auf Inbox zurücksetzen
        </button>
        <button v-if="canManageJob" class="danger" :disabled="busy" @click="openDelete">
          🗑 Ticket löschen
        </button>
        <a class="linear-link" :href="detail.ticket.url" target="_blank" rel="noreferrer"
          >Linear ↗</a
        >
      </div>

      <div v-if="actionMessage || actionError" class="action-result">
        <span v-if="actionMessage">{{ actionMessage }}</span>
        <span v-else class="err">{{ actionError }}</span>
      </div>

      <div v-if="canApprove" class="approval">
        <label>Antworten auf offene Fragen oder zusätzliche Freigabehinweise</label>
        <textarea
          v-model="approvalNote"
          rows="3"
          placeholder="Optional: Annahmen bestätigen oder Fragen aus PLAN.md beantworten"
        />
      </div>

      <nav class="tabs scroll-x">
        <button v-for="t in TABS" :key="t" :class="{ active: tab === t }" @click="tab = t">
          {{ t }}
        </button>
      </nav>

      <div class="tab-content">
        <div v-if="tab === 'Beschreibung'" class="description-tab">
          <template v-if="editingDescription">
            <label for="ticket-description">Ticketbeschreibung (Markdown)</label>
            <textarea
              id="ticket-description"
              v-model="descriptionDraft"
              rows="18"
              maxlength="100000"
              :disabled="busy"
            />
            <div class="description-actions">
              <span class="muted">
                Beim Speichern wird die Beschreibung direkt in Linear geändert.
              </span>
              <button :disabled="busy" @click="cancelDescriptionEdit">Abbrechen</button>
              <button
                class="primary"
                :disabled="busy || !descriptionChanged"
                @click="saveDescription"
              >
                {{ busy ? 'Speichere…' : 'In Linear speichern' }}
              </button>
            </div>
          </template>
          <template v-else>
            <div class="description-toolbar">
              <span v-if="!canManageJob" class="faint">
                Während eines aktiven Laufs ist die Bearbeitung gesperrt.
              </span>
              <button :disabled="!canManageJob || busy" @click="editDescription">
                Beschreibung bearbeiten
              </button>
            </div>
            <ArtifactViewer
              :content="detail.ticket.description"
              markdown
              empty="Keine Beschreibung."
            />
          </template>
        </div>
        <WorkflowTimeline v-else-if="tab === 'Verlauf'" :events="detail.events" />
        <LiveLogViewer v-else-if="tab === 'Live-Logs'" :logs="store.logs" />
        <ArtifactViewer
          v-else-if="tab === 'PLAN.md'"
          :content="artifact('plan')"
          markdown
          empty="Noch kein Plan."
        />
        <ArtifactViewer
          v-else-if="tab === 'Freigabe'"
          :content="artifact('approval')"
          markdown
          empty="Keine zusätzlichen Freigabehinweise."
        />
        <ArtifactViewer
          v-else-if="tab === 'Implementierung'"
          :content="artifact('implementation')"
          markdown
          empty="Noch kein Implementierungsbericht."
        />
        <ArtifactViewer
          v-else-if="tab === 'REVIEW.md'"
          :content="artifact('review')"
          markdown
          empty="Noch kein Review."
        />
        <GitDiffViewer v-else-if="tab === 'Diff'" :diff="artifact('diff')" />
        <ArtifactViewer
          v-else-if="tab === 'Handoff'"
          :content="artifact('handoff')"
          markdown
          empty="Noch kein Handoff-Bericht."
        />
        <ArtifactViewer
          v-else-if="tab === 'GitHub-Review'"
          :content="artifact('github_review')"
          markdown
          empty="Noch keine GitHub-Review-Nacharbeit."
        />
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
            <label>Basis-Commit</label><code>{{ detail.baseCommitSha ?? '—' }}</code>
          </div>
          <div>
            <label>Head-Commit</label><code>{{ detail.headCommitSha ?? '—' }}</code>
          </div>
          <div><label>Basis veraltet</label>{{ detail.baseStale ? 'ja' : 'nein' }}</div>
          <div><label>Nächste Phase</label>{{ detail.resumePhase ?? '—' }}</div>
          <div><label>Plan freigegeben</label>{{ formatDateTime(detail.planApprovedAt) }}</div>
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
      :title="cancelIsPostRun ? 'GitHub-Nacharbeit abbrechen?' : 'Job abbrechen?'"
      :message="
        cancelIsPostRun
          ? 'Codex und laufende Prüfungen werden beendet. Noch nicht committete Änderungen dieser Aktion werden aufgeräumt; der bestehende Jobstatus bleibt erhalten.'
          : `Laufende Prozesse werden hart beendet und der Job auf 'failed' gesetzt. Kein Merge/Push findet statt.`
      "
      :confirm-label="cancelIsPostRun ? 'Nacharbeit abbrechen' : 'Abbrechen erzwingen'"
      danger
      @confirm="doCancel"
      @cancel="confirmCancel = false"
    />
    <ConfirmDialog
      :open="confirmReset"
      title="Job auf Inbox zurücksetzen?"
      message="Logs, Ereignisse, Agentenläufe, Artefakte, Reviews und Testergebnisse dieses Jobs werden dauerhaft gelöscht. Ohne Worktree-Entfernung bleiben Branch und vorhandene Commits erhalten."
      confirm-label="Zurücksetzen"
      checkbox-label="Zugehörigen Worktree sicher entfernen und beim nächsten Lauf einen neuen Branch verwenden"
      :checked="removeWorktree"
      danger
      @update:checked="removeWorktree = $event"
      @confirm="resetJob"
      @cancel="confirmReset = false"
    />
    <ConfirmDialog
      :open="confirmDelete"
      title="Ticket vom Board löschen?"
      message="Der lokale Job und seine gesamte Laufhistorie werden dauerhaft gelöscht. Linear bleibt unverändert. Ohne Worktree-Entfernung bleiben Worktree und Branch zur manuellen Sicherung bestehen."
      confirm-label="Ticket löschen"
      checkbox-label="Zugehörigen Worktree sicher entfernen; Branch als Wiederherstellungspunkt behalten"
      :checked="removeWorktree"
      danger
      @update:checked="removeWorktree = $event"
      @confirm="deleteJob"
      @cancel="confirmDelete = false"
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
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  overflow: hidden;
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
.approval {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 18px 12px;
  border-bottom: 1px solid var(--border);
}
.action-result {
  padding: 9px 18px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.approval label {
  color: var(--text-dim);
  font-size: 12px;
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
.description-tab {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
}
.description-toolbar,
.description-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}
.description-toolbar .faint,
.description-actions .muted {
  margin-right: auto;
  font-size: 12px;
}
.description-tab textarea {
  flex: 1;
  min-height: 220px;
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
