<script setup lang="ts">
import { computed } from 'vue';
import type { JobState } from '@agent/shared';
import { STATE_COLORS, STATE_LABELS } from '@/lib/labels';

const props = defineProps<{ state: JobState }>();

const label = computed(() => STATE_LABELS[props.state]);
const color = computed(() => STATE_COLORS[props.state]);
</script>

<template>
  <span class="badge" :style="{ '--badge-color': color }">
    <span class="dot" />
    {{ label }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 500;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--badge-color);
  border: 1px solid color-mix(in srgb, var(--badge-color) 40%, transparent);
  background: color-mix(in srgb, var(--badge-color) 12%, transparent);
  white-space: nowrap;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--badge-color);
}
</style>
