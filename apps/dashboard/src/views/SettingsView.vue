<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '@/api/client';

interface Health {
  status: string;
  time: string;
  runningJobs: number;
  linearConfigured: boolean;
}

const health = ref<Health | null>(null);
const error = ref<string | null>(null);
const implementationAgent = ref<'codex' | 'claude'>('codex');
const maxConcurrentJobs = ref(1);
const saving = ref(false);

async function setImplementationAgent(value: 'codex' | 'claude'): Promise<void> {
  saving.value = true;
  error.value = null;
  try {
    const result = await api.updateSettings({ implementationAgent: value });
    implementationAgent.value = result.implementationAgent;
    maxConcurrentJobs.value = result.maxConcurrentJobs;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function setMaxConcurrent(event: Event): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isInteger(value) || value < 1 || value > 16) return;
  saving.value = true;
  error.value = null;
  try {
    const result = await api.updateSettings({ maxConcurrentJobs: value });
    maxConcurrentJobs.value = result.maxConcurrentJobs;
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    const [healthRes, settings] = await Promise.all([fetch('/api/health'), api.getSettings()]);
    health.value = (await healthRes.json()) as Health;
    implementationAgent.value = settings.implementationAgent;
    maxConcurrentJobs.value = settings.maxConcurrentJobs;
  } catch (err) {
    error.value = (err as Error).message;
  }
});
</script>

<template>
  <div class="settings scroll-area">
    <h1>Einstellungen</h1>

    <section class="card block">
      <h3>Backend-Status</h3>
      <p v-if="error" class="err">{{ error }}</p>
      <dl v-else-if="health">
        <dt>Status</dt>
        <dd>{{ health.status }}</dd>
        <dt>Laufende Jobs</dt>
        <dd>{{ health.runningJobs }}</dd>
        <dt>Linear konfiguriert</dt>
        <dd>{{ health.linearConfigured ? 'ja' : 'nein (Import benötigt LINEAR_API_KEY)' }}</dd>
        <dt>Serverzeit</dt>
        <dd>{{ health.time }}</dd>
      </dl>
      <p v-else class="faint">Lade …</p>
    </section>

    <section class="card block">
      <h3>Implementierungs-Agent</h3>
      <p class="muted">Wählt, wer Implementierung und Nacharbeit im Worktree ausführt.</p>
      <label class="switch-row">
        <span>Claude statt Codex verwenden</span>
        <input
          type="checkbox"
          :checked="implementationAgent === 'claude'"
          :disabled="saving"
          @change="setImplementationAgent(($event.target as HTMLInputElement).checked ? 'claude' : 'codex')"
        />
      </label>
      <p class="faint">Aktuell: {{ implementationAgent }}</p>
    </section>

    <section class="card block">
      <h3>Parallelität</h3>
      <p class="muted">
        Wie viele Jobs gleichzeitig laufen dürfen. Wird sofort wirksam und überschreibt
        <code>MAX_CONCURRENT_JOBS</code> aus der Umgebung.
      </p>
      <label class="switch-row">
        <span>Maximal gleichzeitige Jobs (1–16)</span>
        <input
          type="number"
          min="1"
          max="16"
          :value="maxConcurrentJobs"
          :disabled="saving"
          @change="setMaxConcurrent"
        />
      </label>
    </section>

    <section class="card block">
      <h3>Konfiguration</h3>
      <p class="muted">
        Laufzeitparameter werden über Umgebungsvariablen gesetzt (siehe
        <code>.env.example</code>): Review-Limit, Job-Zeitlimit, Agenten-Binärpfade und das
        Linear-Kommentar-Flag. Änderungen erfordern einen Neustart des Orchestrators.
      </p>
      <ul class="muted">
        <li><code>MAX_REVIEW_LOOPS</code> — maximale Nacharbeitsschleifen (Standard 3)</li>
        <li><code>MAX_JOB_RUNTIME_MINUTES</code> — hartes Job-Zeitlimit</li>
        <li><code>LINEAR_WRITE_COMMENTS</code> — Kommentare nach Linear (Standard aus)</li>
      </ul>
    </section>

    <section class="card block">
      <h3>Sicherheitsmodell</h3>
      <p class="muted">
        Agenten laufen sandboxed im Ticket-Worktree. Es findet niemals ein automatischer Merge oder
        Push statt. Nur die ausdrücklich gestartete GitHub-Review-Aktion darf den aktuellen
        Job-Branch ohne Force auf seinen vorhandenen Upstream pushen. Linear-Statusänderungen
        finden nur statt, wenn ein Projekt sie explizit konfiguriert; Agenten entscheiden nie über
        Workflowzustände.
      </p>
    </section>
  </div>
</template>

<style scoped>
.scroll-area {
  height: 100%;
  overflow-y: auto;
  padding: 18px 22px;
}
h1 {
  font-size: 20px;
  margin: 0 0 14px;
}
.block {
  padding: 16px 18px;
  margin-bottom: 16px;
  max-width: 720px;
}
.block h3 {
  margin: 0 0 10px;
}
dl {
  display: grid;
  grid-template-columns: 180px 1fr;
  gap: 6px 12px;
  margin: 0;
}
dt {
  color: var(--text-dim);
}
dd {
  margin: 0;
}
code {
  font-family: var(--mono);
  font-size: 12px;
}
.err {
  color: var(--c-fail);
}
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 420px;
  gap: 16px;
}
.switch-row input {
  width: 18px;
  height: 18px;
}
</style>
