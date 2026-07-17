<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IDENTIFIER_RE } from '@agent/shared';
import type { LinearAssignedIssue } from '@agent/shared';
import { useProjectsStore } from '@/stores/projects';
import { useJobsStore } from '@/stores/jobs';
import { api, ApiClientError } from '@/api/client';

const emit = defineEmits<{ close: [] }>();
const projects = useProjectsStore();
const jobs = useJobsStore();

type Mode = 'assigned' | 'manual';
const mode = ref<Mode>('assigned');

const projectId = ref(
  projects.projects.find((p) => p.active)?.id ?? projects.projects[0]?.id ?? '',
);
const submitting = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

// --- Zugewiesene Tickets ---
const issues = ref<LinearAssignedIssue[]>([]);
const loadingIssues = ref(false);
const issuesError = ref<string | null>(null);
const search = ref('');
const checked = ref<Record<string, boolean>>({});

async function loadIssues(): Promise<void> {
  loadingIssues.value = true;
  issuesError.value = null;
  try {
    issues.value = await api.listAssignedIssues();
  } catch (err) {
    issuesError.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  } finally {
    loadingIssues.value = false;
  }
}

onMounted(loadIssues);

const filteredIssues = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return issues.value;
  return issues.value.filter((issue) =>
    [issue.identifier, issue.title, issue.teamName, issue.teamKey]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(term)),
  );
});
const selectableFiltered = computed(() =>
  filteredIssues.value.filter((issue) => !issue.alreadyImported),
);
const allSelected = computed(
  () =>
    selectableFiltered.value.length > 0 &&
    selectableFiltered.value.every((issue) => checked.value[issue.linearIssueId]),
);
const selectedIssues = computed(() =>
  issues.value.filter((issue) => !issue.alreadyImported && checked.value[issue.linearIssueId]),
);

function toggle(issue: LinearAssignedIssue): void {
  if (issue.alreadyImported) return;
  checked.value = {
    ...checked.value,
    [issue.linearIssueId]: !checked.value[issue.linearIssueId],
  };
}
function toggleAll(): void {
  const next = { ...checked.value };
  const target = !allSelected.value;
  for (const issue of selectableFiltered.value) next[issue.linearIssueId] = target;
  checked.value = next;
}

// --- Manuelle Eingabe ---
const identifiersInput = ref('');
const manualIdentifiers = computed(() => {
  const seen = new Set<string>();
  return identifiersInput.value
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
});
const invalidIdentifiers = computed(() =>
  manualIdentifiers.value.filter((identifier) => !IDENTIFIER_RE.test(identifier)),
);

// --- Gemeinsame Auswahl ---
const identifiers = computed(() =>
  mode.value === 'assigned'
    ? selectedIssues.value.map((issue) => issue.identifier)
    : manualIdentifiers.value,
);
const valid = computed(
  () =>
    identifiers.value.length > 0 &&
    identifiers.value.length <= 100 &&
    (mode.value === 'assigned' || invalidIdentifiers.value.length === 0) &&
    projectId.value !== '',
);

function priorityText(issue: LinearAssignedIssue): string | null {
  if (issue.priorityLabel) return issue.priorityLabel;
  return issue.priority !== null ? `P${issue.priority}` : null;
}

async function submit(): Promise<void> {
  if (!valid.value || submitting.value) return;
  submitting.value = true;
  error.value = null;
  success.value = null;
  try {
    const result = await api.importTickets({
      identifiers: identifiers.value,
      projectId: projectId.value,
    });
    for (const job of result.jobs) jobs.upsert(job);
    if (result.failures.length === 0) {
      emit('close');
      return;
    }
    success.value = `${result.jobs.length} Ticket(s) erfolgreich importiert.`;
    error.value = result.failures
      .map((failure) => `${failure.identifier}: ${failure.message}`)
      .join('\n');
    // Erfolgreich importierte aus der Liste entfernen bzw. neu laden.
    await loadIssues();
    checked.value = {};
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog card">
      <h3>Tickets importieren</h3>

      <div class="tabs">
        <button :class="{ active: mode === 'assigned' }" @click="mode = 'assigned'">
          Mir zugewiesen
        </button>
        <button :class="{ active: mode === 'manual' }" @click="mode = 'manual'">
          Manuell
        </button>
      </div>

      <div class="field">
        <label>Projekt</label>
        <select v-model="projectId">
          <option v-for="p in projects.projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </div>
      <p v-if="projects.projects.length === 0" class="warn">
        Kein Projekt vorhanden — lege zuerst unter „Projekte" eines an.
      </p>

      <!-- Zugewiesene Tickets -->
      <template v-if="mode === 'assigned'">
        <div class="list-head">
          <input v-model="search" class="search" placeholder="Suchen (Titel, Team, Identifier)…" />
          <button class="link" :disabled="selectableFiltered.length === 0" @click="toggleAll">
            {{ allSelected ? 'Auswahl aufheben' : 'Alle auswählen' }}
          </button>
        </div>

        <div v-if="loadingIssues" class="muted state">Lade zugewiesene Tickets…</div>
        <div v-else-if="issuesError" class="state">
          <p class="warn">{{ issuesError }}</p>
          <button @click="loadIssues">Erneut versuchen</button>
        </div>
        <div v-else-if="filteredIssues.length === 0" class="muted state">
          Keine zugewiesenen Tickets gefunden.
        </div>
        <ul v-else class="issues">
          <li
            v-for="issue in filteredIssues"
            :key="issue.linearIssueId"
            :class="{ imported: issue.alreadyImported }"
            @click="toggle(issue)"
          >
            <input
              type="checkbox"
              :checked="!!checked[issue.linearIssueId]"
              :disabled="issue.alreadyImported"
              @click.stop="toggle(issue)"
            />
            <div class="issue-main">
              <div class="issue-title">
                <span class="ident">{{ issue.identifier }}</span>
                <span class="title">{{ issue.title }}</span>
              </div>
              <div class="issue-meta">
                <span v-if="issue.linearState" class="badge">{{ issue.linearState }}</span>
                <span v-if="issue.teamName" class="faint">{{ issue.teamName }}</span>
                <span v-if="priorityText(issue)" class="faint">{{ priorityText(issue) }}</span>
                <span v-if="issue.alreadyImported" class="faint imported-tag">
                  bereits importiert
                </span>
              </div>
            </div>
          </li>
        </ul>
        <span class="faint count">{{ selectedIssues.length }} ausgewählt</span>
      </template>

      <!-- Manuelle Eingabe -->
      <template v-else>
        <div class="field">
          <label>Linear-Identifier (mit Leerzeichen, Komma oder neuer Zeile trennen)</label>
          <textarea
            v-model="identifiersInput"
            rows="6"
            placeholder="APP-123&#10;APP-124&#10;WEB-42"
          />
          <span class="faint count">{{ manualIdentifiers.length }}/100 Tickets</span>
        </div>
        <p v-if="invalidIdentifiers.length" class="warn">
          Ungültige Identifier: {{ invalidIdentifiers.join(', ') }}
        </p>
      </template>

      <p v-if="success" class="success">{{ success }}</p>
      <pre v-if="error" class="warn">{{ error }}</pre>

      <div class="actions">
        <button @click="emit('close')">Abbrechen</button>
        <button class="primary" :disabled="!valid || submitting" @click="submit">
          {{ submitting ? 'Importiere…' : `${identifiers.length || ''} importieren` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  width: min(620px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  padding: 22px;
  box-shadow: var(--shadow);
}
.dialog h3 {
  margin: 0 0 12px;
}
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}
.tabs button {
  flex: 1;
  padding: 7px 10px;
  background: transparent;
}
.tabs button.active {
  background: var(--accent-dim);
  border-color: var(--accent);
}
.list-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 8px;
}
.search {
  flex: 1;
}
.link {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
  padding: 0;
}
.link:hover:not(:disabled) {
  background: none;
  text-decoration: underline;
}
.link:disabled {
  color: var(--text-faint);
  cursor: default;
}
.state {
  padding: 18px 4px;
}
.issues {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  min-height: 120px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.issues li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 9px 11px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.issues li:last-child {
  border-bottom: none;
}
.issues li:hover:not(.imported) {
  background: var(--bg-elev-2);
}
.issues li.imported {
  opacity: 0.5;
  cursor: default;
}
.issue-main {
  flex: 1;
  min-width: 0;
}
.issue-title {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.ident {
  font-weight: 600;
  font-size: 12.5px;
  white-space: nowrap;
}
.title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.issue-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 3px;
  flex-wrap: wrap;
}
.badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--text-dim);
}
.checkbox,
.issues input[type='checkbox'] {
  width: auto;
  margin-top: 2px;
}
.imported-tag {
  font-style: italic;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.warn {
  color: var(--c-fail);
  font-size: 12.5px;
  white-space: pre-wrap;
}
.success {
  color: var(--c-done);
  font-size: 12.5px;
}
.count {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  text-align: right;
}
</style>
