/** Formatiert eine Dauer (ms) kompakt, z. B. "2m 03s". */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** Laufzeit eines Jobs relativ zu `now` (ms). */
export function runtimeMs(
  startedAt: string | null,
  finishedAt: string | null,
  now: number,
): number {
  if (!startedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return end - start;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const diff = now - new Date(iso).getTime();
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `vor ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `vor ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `vor ${hours}h`;
  return formatDateTime(iso);
}
