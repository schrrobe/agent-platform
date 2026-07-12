export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Parst einen unified `git diff` in klassifizierte Zeilen für die farbige
 * Darstellung. Bewusst simpel gehalten — keine Interpretation, nur Klassifikation.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];
  return diff.split('\n').map((text) => {
    let kind: DiffLineKind = 'context';
    if (
      text.startsWith('diff --git') ||
      text.startsWith('index ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ')
    ) {
      kind = 'meta';
    } else if (text.startsWith('@@')) {
      kind = 'hunk';
    } else if (text.startsWith('+')) {
      kind = 'add';
    } else if (text.startsWith('-')) {
      kind = 'del';
    }
    return { kind, text };
  });
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.text.startsWith('diff --git')) files += 1;
    else if (line.kind === 'add' && !line.text.startsWith('+++')) additions += 1;
    else if (line.kind === 'del' && !line.text.startsWith('---')) deletions += 1;
  }
  return { files, additions, deletions };
}
