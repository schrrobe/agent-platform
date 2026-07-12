<script setup lang="ts">
import { onMounted, ref } from 'vue';

interface Health {
  status: string;
  time: string;
  runningJobs: number;
  linearConfigured: boolean;
}

const health = ref<Health | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    health.value = (await res.json()) as Health;
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
      <h3>Konfiguration</h3>
      <p class="muted">
        Laufzeitparameter werden über Umgebungsvariablen gesetzt (siehe
        <code>.env.example</code>): Review-Limit, Job-Zeitlimit, maximale Parallelität,
        Agenten-Binärpfade und das Linear-Kommentar-Flag. Änderungen erfordern einen Neustart des
        Orchestrators.
      </p>
      <ul class="muted">
        <li><code>MAX_REVIEW_LOOPS</code> — maximale Nacharbeitsschleifen (Standard 3)</li>
        <li><code>MAX_JOB_RUNTIME_MINUTES</code> — hartes Job-Zeitlimit</li>
        <li><code>MAX_CONCURRENT_JOBS</code> — gleichzeitige Jobs (Standard 1)</li>
        <li><code>LINEAR_WRITE_COMMENTS</code> — Kommentare nach Linear (Standard aus)</li>
      </ul>
    </section>

    <section class="card block">
      <h3>Sicherheitsmodell</h3>
      <p class="muted">
        Agenten laufen sandboxed im Ticket-Worktree. Es findet niemals ein automatischer Merge oder
        Push statt, keine Linear-Statusänderung, und Agenten entscheiden nie über Workflowzustände.
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
</style>
