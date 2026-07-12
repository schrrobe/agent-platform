<script setup lang="ts">
import { ref, computed } from 'vue';
import { IDENTIFIER_RE } from '@agent/shared';
import { useProjectsStore } from '@/stores/projects';
import { useJobsStore } from '@/stores/jobs';
import { api, ApiClientError } from '@/api/client';

const emit = defineEmits<{ close: [] }>();
const projects = useProjectsStore();
const jobs = useJobsStore();

const identifier = ref('');
const projectId = ref(
  projects.projects.find((p) => p.active)?.id ?? projects.projects[0]?.id ?? '',
);
const submitting = ref(false);
const error = ref<string | null>(null);

const valid = computed(() => IDENTIFIER_RE.test(identifier.value.trim()) && projectId.value !== '');

async function submit(): Promise<void> {
  if (!valid.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const job = await api.importTicket({
      identifier: identifier.value.trim(),
      projectId: projectId.value,
    });
    jobs.upsert(job);
    emit('close');
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
      <h3>Ticket importieren</h3>
      <p class="muted">Lädt Titel, Beschreibung und Metadaten aus Linear (nur lesend).</p>

      <div class="field">
        <label>Linear-Identifier</label>
        <input v-model="identifier" placeholder="APP-123" @keyup.enter="submit" />
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
      <p v-if="error" class="warn">{{ error }}</p>

      <div class="actions">
        <button @click="emit('close')">Abbrechen</button>
        <button class="primary" :disabled="!valid || submitting" @click="submit">
          {{ submitting ? 'Importiere…' : 'Importieren' }}
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
  width: min(460px, 92vw);
  padding: 22px;
  box-shadow: var(--shadow);
}
.dialog h3 {
  margin: 0 0 6px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
.warn {
  color: var(--c-fail);
  font-size: 12.5px;
}
</style>
