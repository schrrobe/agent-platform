<script setup lang="ts">
import { watch, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { useJobDetailStore } from '@/stores/jobDetail';
import TicketDetailDrawer from '@/components/TicketDetailDrawer.vue';

const props = defineProps<{ id: string }>();
const detail = useJobDetailStore();

onMounted(() => void detail.open(props.id));
watch(
  () => props.id,
  (id) => void detail.open(id),
);
</script>

<template>
  <div class="detail-page">
    <div class="back">
      <RouterLink to="/">← Zurück zum Board</RouterLink>
    </div>
    <TicketDetailDrawer mode="page" class="panel" />
  </div>
</template>

<style scoped>
.detail-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.back {
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.panel {
  flex: 1;
  min-height: 0;
}
</style>
