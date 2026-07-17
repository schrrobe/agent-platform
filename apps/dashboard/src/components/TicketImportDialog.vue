<script setup lang="ts">
import { ref, computed } from 'vue';
import { IDENTIFIER_RE } from '@agent/shared';
import { useProjectsStore } from '@/stores/projects';
import { useJobsStore } from '@/stores/jobs';
import { api, ApiClientError } from '@/api/client';

const emit = defineEmits<{ close: [] }>();
const projects = useProjectsStore();
const jobs = useJobsStore();

const identifiersInput = ref('');
const projectId = ref(
  projects.projects.find((p) => p.active)?.id ?? projects.projects[0]?.id ?? '',
);
const submitting = ref(false);
const error = ref<string | null>(null);
const success = ref<string | null>(null);

const identifiers = computed(() => {
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
  identifiers.value.filter((identifier) => !IDENTIFIER_RE.test(identifier)),
);
const valid = computed(
  () =>
    identifiers.value.length > 0 &&
    identifiers.value.length <= 100 &&
    invalidIdentifiers.value.length === 0 &&
    projectId.value !== '',
);

async function submit(): Promise<void> {
  if (!valid.value) return;
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
      <p class="muted">
        Lädt bis zu 100 Tickets aus Linear und ordnet sie gemeinsam einem Projekt zu.
      </p>

      <div class="field">
        <label>Linear-Identifier (mit Leerzeichen, Komma oder neuer Zeile trennen)</label>
        <textarea
          v-model="identifiersInput"
          rows="6"
          placeholder="APP-123&#10;APP-124&#10;WEB-42"
        />
        <span class="faint count">{{ identifiers.length }}/100 Tickets</span>
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
      <p v-if="invalidIdentifiers.length" class="warn">
        Ungültige Identifier: {{ invalidIdentifiers.join(', ') }}
      </p>
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
  width: min(560px, 92vw);
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
.success {
  color: var(--c-done);
  font-size: 12.5px;
}
.count {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  text-align: right;
}
</style>
