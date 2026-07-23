import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * Auswahl-Zustand für das Board: welche Inbox-Jobs sind zum Gruppieren
 * (Vorgang bilden) markiert. Neue Set-Instanzen bei Mutation für sichere
 * Reaktivität.
 */
export const useSelectionStore = defineStore('boardSelection', () => {
  const selected = ref<Set<string>>(new Set());

  const ids = computed(() => [...selected.value]);
  const count = computed(() => selected.value.size);

  function has(id: string): boolean {
    return selected.value.has(id);
  }

  function toggle(id: string): void {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected.value = next;
  }

  function clear(): void {
    if (selected.value.size > 0) selected.value = new Set();
  }

  function remove(id: string): void {
    if (!selected.value.has(id)) return;
    const next = new Set(selected.value);
    next.delete(id);
    selected.value = next;
  }

  return { selected, ids, count, has, toggle, clear, remove };
});
