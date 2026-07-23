<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { LogLine } from '@agent/shared';

const props = defineProps<{ logs: LogLine[] }>();

const container = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const copied = ref(false);

async function copyAll(): Promise<void> {
  const text = props.logs.map((line) => `${line.source}\t${line.text}`).join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}

watch(
  () => props.logs.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    if (container.value) container.value.scrollTop = container.value.scrollHeight;
  },
);

function onScroll(): void {
  const el = container.value;
  if (!el) return;
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}
</script>

<template>
  <div class="log-wrap">
    <div ref="container" class="log scroll-x" @scroll="onScroll">
      <div v-for="line in logs" :key="line.seq" class="ln" :class="[line.stream, line.source]">
        <span class="src">{{ line.source }}</span>
        <span class="txt">{{ line.text }}</span>
      </div>
      <p v-if="logs.length === 0" class="faint empty">Keine Logausgaben.</p>
    </div>
    <div class="bar">
      <label class="follow">
        <input v-model="autoScroll" type="checkbox" style="width: auto" /> Automatisch scrollen
      </label>
      <button type="button" class="copy" :disabled="logs.length === 0" @click="copyAll">
        {{ copied ? 'Kopiert ✓' : 'Alles kopieren' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.log-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.log {
  flex: 1;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-family: var(--mono);
  font-size: 12px;
  min-height: 0;
}
.ln {
  display: flex;
  gap: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 1px 0;
}
.ln .src {
  color: var(--text-faint);
  flex-shrink: 0;
  width: 52px;
  text-transform: uppercase;
  font-size: 10px;
  padding-top: 2px;
}
.ln.stderr .txt {
  color: var(--c-fail);
}
.ln.system .txt {
  color: var(--accent);
}
.empty {
  padding: 8px;
}
.bar {
  margin: 6px 0 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.follow {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-dim);
}
.copy {
  font-size: 12px;
  padding: 4px 10px;
}
</style>
