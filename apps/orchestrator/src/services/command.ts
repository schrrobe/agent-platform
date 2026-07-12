import { SHELL_METACHAR_RE } from '@agent/shared';

export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandParseError';
  }
}

/**
 * Zerlegt einen Projekt-Befehlsstring in argv, OHNE eine Shell zu bemühen
 * (ADR-014). Unterstützt einfache und doppelte Quotes für Argumente mit
 * Leerzeichen; Shell-Metazeichen außerhalb von Quotes sind verboten.
 */
export function tokenizeCommand(input: string): { command: string; args: string[] } {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new CommandParseError('Leerer Befehl');
  }
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i] as string;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    if (SHELL_METACHAR_RE.test(char)) {
      throw new CommandParseError(`Shell-Metazeichen ist nicht erlaubt: ${char}`);
    }
    current += char;
    hasToken = true;
  }
  if (quote) {
    throw new CommandParseError('Nicht geschlossenes Anführungszeichen im Befehl');
  }
  if (hasToken) tokens.push(current);

  const [command, ...args] = tokens;
  if (!command) {
    throw new CommandParseError('Kein ausführbarer Befehl gefunden');
  }
  return { command, args };
}
