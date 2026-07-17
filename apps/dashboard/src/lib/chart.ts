/** Datentypen für {@link TokenBarChart}. */
export interface ChartSeries {
  key: string;
  label: string;
  /** CSS-Farbe (z. B. `var(--accent)`). */
  color: string;
}

export interface ChartRow {
  id: string;
  label: string;
  sublabel?: string;
  segments: Record<string, number>;
}
