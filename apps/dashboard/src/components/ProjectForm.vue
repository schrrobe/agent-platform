<script setup lang="ts">
import { reactive, computed } from 'vue';
import type { Project, ProjectCreateInput } from '@agent/shared';
import { COMMAND_KEYS, SHELL_METACHAR_RE } from '@agent/shared';

const props = defineProps<{ project?: Project }>();
const emit = defineEmits<{ submit: [input: ProjectCreateInput]; cancel: [] }>();

const form = reactive({
  name: props.project?.name ?? '',
  repositoryPath: props.project?.repositoryPath ?? '',
  baseBranch: props.project?.baseBranch ?? 'main',
  worktreeRoot: props.project?.worktreeRoot ?? '',
  active: props.project?.active ?? true,
  commands: {
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
        <input v-model="form.repositoryPath" placeholder="/pfad/zum/repo" />
      </div>
      <div class="field">
        <label>Basisbranch</label>
        <input v-model="form.baseBranch" placeholder="main" />
      </div>
    </div>
    <div class="field">
      <label>Worktree-Wurzel (außerhalb des Repos)</label>
      <input v-model="form.worktreeRoot" placeholder="/pfad/zu/worktrees" />
    </div>

    <fieldset>
      <legend>Projektbefehle (ohne Shell-Metazeichen)</legend>
      <div v-for="key in COMMAND_KEYS" :key="key" class="field cmd">
        <label>{{ key }}</label>
        <input
          v-model="form.commands[key]"
          :class="{ invalid: form.commands[key] && SHELL_METACHAR_RE.test(form.commands[key]!) }"
          :placeholder="`z. B. pnpm ${key}`"
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
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
