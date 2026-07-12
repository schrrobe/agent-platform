<script setup lang="ts">
import { computed } from 'vue';
import { parseUnifiedDiff, diffStat } from '@/lib/diff';

const props = defineProps<{ diff: string | null | undefined }>();

const lines = computed(() => parseUnifiedDiff(props.diff ?? ''));
const stat = computed(() => diffStat(lines.value));
</script>

<template>
  <div class="diff-wrap">
    <p v-if="lines.length === 0" class="faint">Kein Diff vorhanden.</p>
    <template v-else>
      <div class="stat">
        <span>{{ stat.files }} Datei(en)</span>
        <span class="add">+{{ stat.additions }}</span>
        <span class="del">−{{ stat.deletions }}</span>
      </div>
      <div class="diff scroll-x">
        <div v-for="(line, i) in lines" :key="i" class="dl" :class="line.kind">
          {{ line.text || ' ' }}
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.diff-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.stat {
  display: flex;
  gap: 12px;
  font-size: 12px;
  padding: 4px 2px 8px;
}
.add {
  color: var(--c-done);
}
.del {
  color: var(--c-fail);
}
.diff {
  flex: 1;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12px;
  min-height: 0;
}
.dl {
  white-space: pre;
  padding: 0 10px;
}
.dl.add {
  background: color-mix(in srgb, var(--c-done) 14%, transparent);
  color: #b7f0c0;
}
.dl.del {
  background: color-mix(in srgb, var(--c-fail) 14%, transparent);
  color: #f6b6ad;
}
.dl.hunk {
  color: var(--accent);
  background: var(--bg-elev-2);
}
.dl.meta {
  color: var(--text-faint);
}
</style>
