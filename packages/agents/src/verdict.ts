import type { ReviewVerdict } from '@agent/shared';

/**
 * Strikter VERDICT-Parser: Es zählen nur die ersten fünf nicht-leeren Zeilen
 * der Review-Ausgabe (Injection-Schutz: zitierte VERDICT-Zeilen tief im Text
 * werden ignoriert). Fehlend oder mehrdeutig → null → die Engine eskaliert zu
 * needs_human, niemals stilles Rework (ADR-018).
 */
export function parseVerdict(text: string): ReviewVerdict | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 5);
  const found: ReviewVerdict[] = [];
  for (const line of lines) {
    const match = /^VERDICT:\s*(PASS|FAIL)\b/i.exec(line);
    if (match?.[1]) found.push(match[1].toUpperCase() as ReviewVerdict);
  }
  const unique = [...new Set(found)];
  return unique.length === 1 ? (unique[0] as ReviewVerdict) : null;
}
