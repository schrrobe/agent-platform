import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';

/**
 * Reaktiver Zeitstempel, der im Intervall aktualisiert wird — Grundlage für
 * mitlaufende Laufzeitanzeigen, ohne pro Karte einen eigenen Timer zu starten.
 */
export function useClock(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  let handle: number | undefined;
  onMounted(() => {
    handle = window.setInterval(() => (now.value = Date.now()), intervalMs);
  });
  onBeforeUnmount(() => {
    if (handle !== undefined) window.clearInterval(handle);
  });
  return now;
}
