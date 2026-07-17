<script setup lang="ts">
import { reactive, computed, onMounted, ref } from 'vue';
import type { Project, ProjectCreateInput } from '@agent/shared';
import { COMMAND_KEYS, SHELL_METACHAR_RE } from '@agent/shared';
import { ApiClientError, api } from '@/api/client';

const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ submit: [input: ProjectCreateInput]; cancel: [] }>();
const picking = ref<'repository' | 'worktree' | null>(null);
const pickerError = ref<string | null>(null);
const repositoryRoot = ref<string | null>(null);
const repositories = ref<Array<{ name: string; path: string }>>([]);
const repositoriesLoading = ref(true);
const repositoriesError = ref<string | null>(null);

const form = reactive({
  name: props.project?.name ?? '',
  repositoryPath: props.project?.repositoryPath ?? '',
  baseBranch: props.project?.baseBranch ?? 'main',
  worktreeRoot: props.project?.worktreeRoot ?? '',
  active: props.project?.active ?? true,
  autonomyMode: props.project?.autonomyMode ?? 'approve_plan',
  testExecutionMode: props.project?.testExecutionMode ?? 'sandboxed',
  baselineChecks: props.project?.baselineChecks ?? true,
  maxChangedFiles: props.project?.maxChangedFiles ?? 100,
  maxDiffMiB: (props.project?.maxDiffBytes ?? 1024 * 1024) / (1024 * 1024),
  blockedPaths: props.project?.blockedPaths.join('\n') ?? '',
  commands: {
    setup: props.project?.commands.setup ?? '',
    format: props.project?.commands.format ?? '',
    lint: props.project?.commands.lint ?? '',
    typecheck: props.project?.commands.typecheck ?? '',
    test: props.project?.commands.test ?? '',
    build: props.project?.commands.build ?? '',
  } as Record<string, string>,
});

const commandErrors = computed(() =>
  COMMAND_KEYS.filter((key) => form.commands[key] && SHELL_METACHAR_RE.test(form.commands[key]!)),
);
const valid = computed(
  () =>
    form.name.trim() !== '' &&
    form.repositoryPath.trim() !== '' &&
    form.worktreeRoot.trim() !== '' &&
    commandErrors.value.length === 0,
);

const selectedRepositoryIsListed = computed(() =>
  repositories.value.some((repository) => repository.path === form.repositoryPath),
);

async function loadRepositories(): Promise<void> {
  repositoriesLoading.value = true;
  repositoriesError.value = null;
  try {
    const result = await api.listRepositories();
    repositoryRoot.value = result.root;
    repositories.value = result.repositories;
  } catch (error) {
    repositoriesError.value =
      error instanceof ApiClientError
        ? error.message
        : 'Repositories konnten nicht geladen werden.';
  } finally {
    repositoriesLoading.value = false;
  }
}

onMounted(loadRepositories);

async function chooseDirectory(kind: 'repository' | 'worktree'): Promise<void> {
  picking.value = kind;
  pickerError.value = null;
  try {
    const result = await api.pickDirectory(kind);
    if (!result.cancelled && result.path) {
      if (kind === 'repository') form.repositoryPath = result.path;
      else form.worktreeRoot = result.path;
    }
  } catch (error) {
    pickerError.value =
      error instanceof ApiClientError
        ? error.message
        : 'Ordnerauswahl konnte nicht geöffnet werden.';
  } finally {
    picking.value = null;
  }
}

function submit(): void {
  if (!valid.value) return;
  const commands: Record<string, string> = {};
  for (const key of COMMAND_KEYS) {
    const value = form.commands[key]?.trim();
    if (value) commands[key] = value;
  }
  emit('submit', {
    name: form.name.trim(),
    repositoryPath: form.repositoryPath.trim(),
    baseBranch: form.baseBranch.trim() || 'main',
    worktreeRoot: form.worktreeRoot.trim(),
    active: form.active,
    autonomyMode: form.autonomyMode,
    testExecutionMode: form.testExecutionMode,
    baselineChecks: form.baselineChecks,
    maxChangedFiles: form.maxChangedFiles,
    maxDiffBytes: Math.round(form.maxDiffMiB * 1024 * 1024),
    blockedPaths: form.blockedPaths
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
    commands,
  });
}
</script>

<template>
  <form class="pform" @submit.prevent="submit">
    <div class="field">
      <label>Name</label>
      <input v-model="form.name" placeholder="Mein Projekt" />
    </div>
    <div class="grid">
      <div class="field">
        <label>Repository-Pfad (absolut)</label>
        <div class="path-control">
          <select
            v-if="repositories.length > 0"
            v-model="form.repositoryPath"
            :disabled="repositoriesLoading"
          >
            <option value="">Repository auswählen</option>
            <option
              v-if="form.repositoryPath && !selectedRepositoryIsListed"
              :value="form.repositoryPath"
            >
              {{ form.repositoryPath }}
            </option>
            <option
              v-for="repository in repositories"
              :key="repository.path"
              :value="repository.path"
            >
              {{ repository.name }}
            </option>
          </select>
          <input
            v-else
            v-model="form.repositoryPath"
            :disabled="repositoriesLoading"
            :placeholder="repositoriesLoading ? 'Repositories werden geladen …' : '/pfad/zum/repo'"
          />
          <button
            type="button"
            class="picker-button"
            :disabled="picking !== null"
            @click="chooseDirectory('repository')"
          >
            {{ picking === 'repository' ? 'Öffne …' : 'Ordner auswählen' }}
          </button>
        </div>
        <span v-if="repositoryRoot && repositories.length" class="field-hint">
          {{ repositories.length }} Repositories aus {{ repositoryRoot }}
        </span>
        <span v-if="repositoriesError" class="warn">{{ repositoriesError }}</span>
      </div>
      <div class="field">
        <label>Basisbranch</label>
        <input v-model="form.baseBranch" placeholder="main" />
      </div>
    </div>
    <div class="field">
      <label>Worktree-Wurzel (außerhalb des Repos)</label>
      <div class="path-control">
        <input v-model="form.worktreeRoot" placeholder="/pfad/zu/worktrees" />
        <button
          type="button"
          class="picker-button"
          :disabled="picking !== null"
          @click="chooseDirectory('worktree')"
        >
          {{ picking === 'worktree' ? 'Öffne …' : 'Ordner auswählen' }}
        </button>
      </div>
    </div>
    <p v-if="pickerError" class="warn">{{ pickerError }}</p>

    <fieldset>
      <legend>Autonomie und Sicherheitsgrenzen</legend>
      <div class="grid">
        <div class="field">
          <label>Planfreigabe</label>
          <select v-model="form.autonomyMode">
            <option value="approve_plan">Plan immer bestätigen</option>
            <option value="full_auto">Niedriges Risiko automatisch</option>
          </select>
        </div>
        <div class="field">
          <label>Projektbefehle ausführen</label>
          <select v-model="form.testExecutionMode">
            <option value="sandboxed">OS-Sandbox (empfohlen)</option>
            <option value="trusted">Trusted Host (nicht isoliert)</option>
          </select>
        </div>
      </div>
      <p v-if="form.testExecutionMode === 'trusted'" class="warn">
        Trusted Host führt vom Agenten veränderten Projektcode direkt auf diesem Rechner aus.
      </p>
      <label class="check">
        <input v-model="form.baselineChecks" type="checkbox" style="width: auto" />
        Prüfungen vor der Implementierung als Baseline ausführen
      </label>
      <div class="grid limits">
        <div class="field">
          <label>Maximal geänderte Dateien</label>
          <input v-model.number="form.maxChangedFiles" type="number" min="1" max="10000" />
        </div>
        <div class="field">
          <label>Maximale Diffgröße (MiB)</label>
          <input v-model.number="form.maxDiffMiB" type="number" min="0.001" max="100" step="0.25" />
        </div>
      </div>
      <div class="field">
        <label>Gesperrte Repository-Pfade (einer pro Zeile)</label>
        <textarea
          v-model="form.blockedPaths"
          rows="3"
          placeholder=".github/workflows&#10;infra/production"
        />
      </div>
    </fieldset>

    <fieldset>
      <legend>Setup und rein prüfende Befehle (ohne Shell-Metazeichen)</legend>
      <div v-for="key in COMMAND_KEYS" :key="key" class="field cmd">
        <label>{{ key }}</label>
        <input
          v-model="form.commands[key]"
          :class="{ invalid: form.commands[key] && SHELL_METACHAR_RE.test(form.commands[key]!) }"
          :placeholder="
            key === 'setup'
              ? 'z. B. pnpm install --offline --frozen-lockfile'
              : key === 'format'
                ? 'z. B. pnpm format:check'
                : `z. B. pnpm ${key}`
          "
        />
      </div>
      <p v-if="commandErrors.length" class="warn">
        Unerlaubte Zeichen in: {{ commandErrors.join(', ') }}
      </p>
    </fieldset>

    <label class="check"
      ><input v-model="form.active" type="checkbox" style="width: auto" /> Aktiv</label
    >

    <div class="actions">
      <button type="button" @click="emit('cancel')">Abbrechen</button>
      <button type="submit" class="primary" :disabled="!valid">Speichern</button>
    </div>
  </form>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
}
.path-control {
  display: flex;
  gap: 8px;
}
.path-control input,
.path-control select {
  min-width: 0;
  flex: 1;
}
.picker-button {
  flex-shrink: 0;
  white-space: nowrap;
}
.limits {
  margin-top: 12px;
}
fieldset {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin: 4px 0 14px;
}
legend {
  color: var(--text-dim);
  font-size: 12px;
  padding: 0 6px;
}
.cmd {
  display: grid;
  grid-template-columns: 92px 1fr;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.cmd label {
  margin: 0;
  text-transform: capitalize;
}
input.invalid {
  border-color: var(--c-fail);
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--text);
}
.warn {
  color: var(--c-fail);
  font-size: 12.5px;
}
.field-hint {
  color: var(--text-dim);
  font-size: 11.5px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
