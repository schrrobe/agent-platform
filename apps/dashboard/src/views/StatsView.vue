<script setup lang="ts">
import { computed, onMounted } from 'vue';
import type { AgentPhase } from '@agent/shared';
import { useStatsStore } from '@/stores/stats';
import { formatCompact, formatCost, formatInteger } from '@/lib/format';
import type { ChartRow, ChartSeries } from '@/lib/chart';
import TokenBarChart from '@/components/TokenBarChart.vue';

const stats = useStatsStore();

/** Token-Kategorien in fester Reihenfolge (dataviz: nie durchrotieren). */
const SERIES: ChartSeries[] = [
  { key: 'inputTokens', label: 'Eingabe', color: 'var(--accent)' },
  { key: 'outputTokens', label: 'Ausgabe', color: 'var(--c-done)' },
  { key: 'cacheReadTokens', label: 'Cache gelesen', color: 'var(--c-human)' },
  { key: 'cacheCreationTokens', label: 'Cache erstellt', color: 'var(--c-active)' },
];

const PHASE_LABELS: Record<AgentPhase, string> = {
  plan: 'Plan',
  implement: 'Implementierung',
  review: 'Review',
  rework: 'Nacharbeit',
  github_review: 'GitHub-Review',
};

const TOP_N = 20;

onMounted(() => void stats.load());

const totals = computed(() => stats.stats?.totals ?? null);

const jobRows = computed<ChartRow[]>(() =>
  (stats.stats?.perJob ?? [])
    .filter((j) => j.totals.totalTokens > 0)
    .slice(0, TOP_N)
    .map((j) => ({
      id: j.jobId,
      label: j.ticketIdentifier,
      sublabel: j.ticketTitle,
      segments: {
        inputTokens: j.totals.inputTokens,
        outputTokens: j.totals.outputTokens,
        cacheReadTokens: j.totals.cacheReadTokens,
        cacheCreationTokens: j.totals.cacheCreationTokens,
      },
    })),
);

const jobsWithData = computed(
  () => (stats.stats?.perJob ?? []).filter((j) => j.totals.totalTokens > 0).length,
);

const phaseRows = computed<ChartRow[]>(() =>
  (stats.stats?.perPhase ?? [])
    .filter((p) => p.totals.totalTokens > 0)
    .map((p) => ({
      id: p.phase,
      label: PHASE_LABELS[p.phase] ?? p.phase,
      segments: {
        inputTokens: p.totals.inputTokens,
        outputTokens: p.totals.outputTokens,
        cacheReadTokens: p.totals.cacheReadTokens,
        cacheCreationTokens: p.totals.cacheCreationTokens,
      },
    })),
);

const hasData = computed(() => (totals.value?.totalTokens ?? 0) > 0);
</script>

<template>
  <div class="stats-view">
    <div class="toolbar">
      <h2>Token-Statistik</h2>
      <button :disabled="stats.loading" @click="stats.load()">Aktualisieren</button>
      <span v-if="stats.loading" class="muted">lädt …</span>
      <span v-if="stats.error" class="err">{{ stats.error }}</span>
    </div>

    <div class="scroll-body">
      <p class="hint muted">
        Token-Verbrauch wird pro Agenten-Lauf erfasst. Nur Agenten mit maschinenlesbarer
        Usage-Ausgabe (Claude, Plan-/Review-Phasen) liefern Werte; Codex-/Hermes-Läufe erscheinen
        ohne Token-Daten.
      </p>

      <div v-if="totals" class="tiles">
        <div class="tile card">
          <span class="tile-label">Tokens gesamt</span>
          <span class="tile-value">{{ formatInteger(totals.totalTokens) }}</span>
          <span class="tile-sub faint">{{ formatCompact(totals.totalTokens) }}</span>
        </div>
        <div class="tile card">
          <span class="tile-label">Kosten gesamt</span>
          <span class="tile-value">{{ formatCost(totals.costUsd) }}</span>
          <span class="tile-sub faint">USD (soweit gemeldet)</span>
        </div>
        <div class="tile card">
          <span class="tile-label">Erfasste Läufe</span>
          <span class="tile-value">{{ formatInteger(totals.runCount) }}</span>
          <span class="tile-sub faint">mit Token-Daten</span>
        </div>
        <div class="tile card">
          <span class="tile-label">Ohne Token-Daten</span>
          <span class="tile-value">{{ formatInteger(totals.runsMissingUsage) }}</span>
          <span class="tile-sub faint">Codex / Hermes u. a.</span>
        </div>
      </div>

      <div v-if="hasData" class="legend">
        <span v-for="s in SERIES" :key="s.key" class="legend-item">
          <span class="legend-dot" :style="{ background: s.color }" />
          {{ s.label }}
        </span>
      </div>

      <section v-if="jobRows.length > 0" class="chart-block card">
        <header>
          <h3>Tokens pro Task</h3>
          <span v-if="jobsWithData > jobRows.length" class="muted">
            Top {{ jobRows.length }} von {{ jobsWithData }} Tasks
          </span>
        </header>
        <TokenBarChart :rows="jobRows" :series="SERIES" />
      </section>

      <section v-if="phaseRows.length > 0" class="chart-block card">
        <header><h3>Tokens pro Phase</h3></header>
        <TokenBarChart :rows="phaseRows" :series="SERIES" />
      </section>

      <p v-if="!stats.loading && !hasData" class="empty muted">
        Noch keine Token-Daten vorhanden. Sobald ein Claude-Lauf (Plan oder Review) abgeschlossen
        ist, erscheinen hier Verbrauch und Kosten.
      </p>
    </div>
  </div>
</template>

<style scoped>
.stats-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.toolbar h2 {
  font-size: 15px;
  margin: 0;
  flex: 1;
}
.scroll-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hint {
  font-size: 12.5px;
  margin: 0;
  max-width: 760px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
}
.tile-label {
  font-size: 12px;
  color: var(--text-dim);
}
.tile-value {
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tile-sub {
  font-size: 11px;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--text-dim);
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend-dot {
  width: 11px;
  height: 11px;
  border-radius: 3px;
}
.chart-block {
  padding: 14px 16px;
}
.chart-block header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
}
.chart-block h3 {
  font-size: 13px;
  margin: 0;
}
.err {
  color: var(--c-fail);
  font-size: 12.5px;
}
.empty {
  padding: 24px 0;
  text-align: center;
}
</style>
