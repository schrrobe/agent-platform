<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Project, ProjectCreateInput } from '@agent/shared';
import { useProjectsStore } from '@/stores/projects';
import { ApiClientError } from '@/api/client';
import ProjectForm from '@/components/ProjectForm.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';

const projects = useProjectsStore();
const editing = ref<Project | 'new' | null>(null);
const toDelete = ref<Project | null>(null);
const error = ref<string | null>(null);

async function save(input: ProjectCreateInput): Promise<void> {
  error.value = null;
  try {
    if (editing.value && editing.value !== 'new') {
      await projects.update(editing.value.id, input);
    } else {
      await projects.create(input);
    }
    editing.value = null;
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  }
}

const deleteMessage = computed(
  () =>
    `„${toDelete.value?.name ?? ''}" wird entfernt. Möglich nur, wenn keine Tickets/Jobs existieren.`,
);

function commandsSummary(project: Project): string {
  const entries = Object.entries(project.commands).filter(([, v]) => v);
  if (entries.length === 0) return 'keine Befehle';
  return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

async function confirmDelete(): Promise<void> {
  if (!toDelete.value) return;
  error.value = null;
  try {
    await projects.remove(toDelete.value.id);
  } catch (err) {
    error.value = err instanceof ApiClientError ? err.message : (err as Error).message;
  } finally {
    toDelete.value = null;
  }
}
</script>

<template>
  <div class="projects scroll-area">
    <div class="header">
      <h1>Projekte</h1>
      <button class="primary" @click="editing = 'new'">+ Neues Projekt</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>

    <div v-if="editing" class="card editor">
      <h3>{{ editing === 'new' ? 'Projekt anlegen' : 'Projekt bearbeiten' }}</h3>
      <ProjectForm
        :project="editing === 'new' ? undefined : editing"
        @submit="save"
        @cancel="editing = null"
      />
    </div>

    <div class="list">
      <div v-for="project in projects.projects" :key="project.id" class="card row">
        <div class="info">
          <div class="name">
            {{ project.name }}
            <span v-if="!project.active" class="inactive">inaktiv</span>
          </div>
          <code class="path">{{ project.repositoryPath }}</code>
          <div class="cmds faint">{{ commandsSummary(project) }}</div>
          <div class="cmds faint">
            {{ project.autonomyMode }} · Tests: {{ project.testExecutionMode }} · Baseline:
            {{ project.baselineChecks ? 'an' : 'aus' }} · Diff-Limit:
            {{ project.maxChangedFiles }} Dateien
          </div>
        </div>
        <div class="controls">
          <button @click="editing = project">Bearbeiten</button>
          <button class="danger" @click="toDelete = project">Löschen</button>
        </div>
      </div>
      <p v-if="projects.projects.length === 0" class="faint">Noch keine Projekte.</p>
    </div>

    <ConfirmDialog
      :open="toDelete !== null"
      title="Projekt löschen?"
      :message="deleteMessage"
      confirm-label="Löschen"
      danger
      @confirm="confirmDelete"
      @cancel="toDelete = null"
    />
  </div>
</template>

<style scoped>
.scroll-area {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
h1 {
  font-size: 20px;
  margin: 0 0 14px;
}
.editor {
  padding: 18px;
  margin-bottom: 18px;
  max-width: 720px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 900px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  gap: 14px;
}
.name {
  font-weight: 600;
}
.inactive {
  font-size: 11px;
  color: var(--c-warn);
  margin-left: 8px;
}
.path {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-dim);
}
.cmds {
  font-size: 11.5px;
  margin-top: 3px;
}
.controls {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.err {
  color: var(--c-fail);
}
</style>
