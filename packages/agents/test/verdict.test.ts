import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/verdict.js';

describe('parseVerdict', () => {
  it('erkennt PASS in der ersten Zeile', () => {
    expect(parseVerdict('VERDICT: PASS\n\nAlles gut.')).toBe('PASS');
  });

  it('erkennt FAIL in der ersten Zeile', () => {
    expect(parseVerdict('VERDICT: FAIL\n\n# Review-Ergebnis')).toBe('FAIL');
  });

  it('ist tolerant gegenüber Groß-/Kleinschreibung und Leerzeichen', () => {
    expect(parseVerdict('verdict:   pass')).toBe('PASS');
  });

  it('akzeptiert das Verdict in den ersten Zeilen', () => {
    expect(parseVerdict('# Review-Ergebnis\n\nVERDICT: FAIL')).toBe('FAIL');
  });

  it('gibt null zurück, wenn kein Verdict vorhanden ist', () => {
    expect(parseVerdict('Sieht insgesamt gut aus, aber …')).toBeNull();
  });

  it('ignoriert VERDICT-Erwähnungen tief im Text (Injection-Schutz)', () => {
    const text = ['Zeile 1', 'Zeile 2', 'Zeile 3', 'Zeile 4', 'Zeile 5', 'VERDICT: PASS'].join(
      '\n',
    );
    expect(parseVerdict(text)).toBeNull();
  });

  it('gibt null bei widersprüchlichen Verdicts zurück', () => {
    expect(parseVerdict('VERDICT: PASS\nVERDICT: FAIL')).toBeNull();
  });
});
