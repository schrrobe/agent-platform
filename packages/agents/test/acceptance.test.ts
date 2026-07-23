import { describe, expect, it } from 'vitest';
import { allCriteriaVisual, classifyVisualCriteria, isVisualCriterion } from '../src/acceptance.js';

describe('isVisualCriterion', () => {
  it('erkennt deutsche wahrnehmungsbezogene Begriffe inkl. Komposita', () => {
    expect(isVisualCriterion('Der Abstand zwischen Chevron und Button ist reduziert')).toBe(true);
    expect(isVisualCriterion('Die Hintergrundfarbe entspricht dem Design')).toBe(true);
    expect(isVisualCriterion('Der Button ist vertikal zentriert')).toBe(true);
    expect(isVisualCriterion('Das Padding ist links und rechts sichtbar')).toBe(true);
  });

  it('erkennt englische Begriffe', () => {
    expect(isVisualCriterion('The footer CTA is aligned with the content column')).toBe(true);
    expect(isVisualCriterion('Rounded corners with a subtle shadow')).toBe(true);
  });

  it('lässt maschinell prüfbare Kriterien unangetastet', () => {
    expect(isVisualCriterion('Der Endpoint gibt bei Fehlern HTTP 400 zurück')).toBe(false);
    expect(isVisualCriterion('Die Summe wird korrekt aus den Positionen berechnet')).toBe(false);
    expect(isVisualCriterion('Neue Unit-Tests decken den Grenzfall ab')).toBe(false);
  });
});

describe('classifyVisualCriteria', () => {
  it('filtert nur die visuellen Kriterien heraus', () => {
    const criteria = [
      'Der Abstand ist reduziert',
      'Der Service validiert die Eingabe',
      'Die Farbe des CTA ist korrekt',
    ];
    expect(classifyVisualCriteria(criteria)).toEqual([
      'Der Abstand ist reduziert',
      'Die Farbe des CTA ist korrekt',
    ]);
  });

  it('ignoriert leere Einträge', () => {
    expect(classifyVisualCriteria(['   ', 'Layout stimmt'])).toEqual(['Layout stimmt']);
  });
});

describe('allCriteriaVisual', () => {
  it('true, wenn alle nicht-leeren Kriterien visuell sind', () => {
    expect(allCriteriaVisual(['Abstand reduziert', 'Farbe korrekt'])).toBe(true);
  });

  it('false, wenn ein maschinell prüfbares Kriterium dabei ist', () => {
    expect(allCriteriaVisual(['Abstand reduziert', 'Endpoint liefert 404'])).toBe(false);
  });

  it('false bei leerer Liste (nichts abzunehmen)', () => {
    expect(allCriteriaVisual([])).toBe(false);
    expect(allCriteriaVisual(['  '])).toBe(false);
  });
});
