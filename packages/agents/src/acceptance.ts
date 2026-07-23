/**
 * Klassifikation von Akzeptanzkriterien nach maschineller Verifizierbarkeit.
 *
 * Rein visuelle/wahrnehmungsbezogene Kriterien (Abstände, Farben, Layout,
 * Ausrichtung …) lassen sich ohne gerenderten Browser und Screenshot-Abgleich
 * nicht automatisch prüfen. Format-, Lint-, Typ- und Unit-Tests können sie nicht
 * abdecken, und ein Diff-lesender Reviewer sieht keine Pixel. Solche Kriterien
 * dürfen daher keine endlose Review→Nacharbeit-Schleife auslösen, sondern gehören
 * in eine menschliche visuelle Abnahme.
 */

/**
 * Wahrnehmungsbezogene Begriffe (Deutsch/Englisch). Bewusst als Teilstring-Treffer
 * gewählt, damit auch deutsche Komposita greifen (z. B. „Hintergrundfarbe",
 * „Schriftgröße", „Abstände"). Die Liste ist konservativ: Ein Fehltreffer führt
 * lediglich zu einer sicheren menschlichen Abnahme statt einer Nacharbeit.
 */
export const PERCEPTUAL_AC_TERMS: readonly string[] = [
  // Abstand / Spacing
  'abstand',
  'abstände',
  'padding',
  'margin',
  'spacing',
  'gap',
  'einrückung',
  // Farbe / Color
  'farbe',
  'color',
  'colour',
  'kontrast',
  'contrast',
  'hintergrund',
  'background',
  'vordergrund',
  'dark mode',
  'dark-mode',
  'dunkelmodus',
  'hell-/dunkel',
  // Layout / Position / Ausrichtung
  'layout',
  'ausgerichtet',
  'ausrichtung',
  'aligned',
  'alignment',
  'zentriert',
  'centered',
  'bündig',
  'positioniert',
  'überlappt',
  'overlap',
  'verdeckt',
  'responsive',
  'breakpoint',
  // Typografie / Form
  'schriftgröße',
  'schriftart',
  'font-size',
  'schriftgrad',
  'radius',
  'abgerundet',
  'rounded',
  'schatten',
  'shadow',
  'rahmen',
  'border',
  // Sichtbarkeit / Darstellung
  'sichtbar',
  'unsichtbar',
  'sichtbarkeit',
  'visibility',
  'angezeigt',
  'displayed',
  'gerendert',
  'rendered',
  'darstellung',
  'optisch',
  'optik',
  'visuell',
  'visual',
  'screenshot',
  'pixel',
  // Bewegung
  'animation',
  'übergang',
  'transition',
  'hover',
];

const PERCEPTUAL_AC_RE = new RegExp(
  PERCEPTUAL_AC_TERMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'iu',
);

/** True, wenn ein einzelnes Akzeptanzkriterium rein visuell/wahrnehmungsbezogen ist. */
export function isVisualCriterion(criterion: string): boolean {
  return PERCEPTUAL_AC_RE.test(criterion);
}

/**
 * Filtert die visuellen/wahrnehmungsbezogenen Einträge aus einer Liste von
 * Akzeptanzkriterien heraus (Reihenfolge bleibt erhalten, leere Einträge fallen weg).
 */
export function classifyVisualCriteria(criteria: readonly string[]): string[] {
  return criteria.filter((entry) => entry.trim().length > 0 && isVisualCriterion(entry));
}

/**
 * True, wenn ALLE (mindestens ein) offenen Kriterien rein visuell sind — d. h. es
 * bleibt nichts maschinell Prüfbares offen, das eine Nacharbeit rechtfertigen würde.
 */
export function allCriteriaVisual(criteria: readonly string[]): boolean {
  const nonEmpty = criteria.filter((entry) => entry.trim().length > 0);
  return nonEmpty.length > 0 && nonEmpty.every((entry) => isVisualCriterion(entry));
}
