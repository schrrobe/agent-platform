import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { TokenStats } from '@agent/shared';
import { api } from '@/api/client';

export const useStatsStore = defineStore('stats', () => {
  const stats = ref<TokenStats | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      stats.value = await api.tokenStats();
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  return { stats, loading, error, load };
});
