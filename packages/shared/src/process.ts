/**
 * Typen der sicheren Prozessausführung. Die Implementierung liegt in
 * `@agent/agents` (ProcessExecutor); `@agent/git` erhält den Runner per
 * Injektion (ADR-011). Dieses Paket bleibt frei von Node-Runtime-Importen.
 */

export interface ProcessOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ProcessSpec {
  /** Ausführbare Datei — niemals ein Shell-String. */
  command: string;
  args: readonly string[];
  /** Arbeitsverzeichnis, immer explizit. */
  cwd: string;
  /** Vollständige Umgebung des Kindprozesses (bereits gefiltert). */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Obergrenze für insgesamt gepufferte Ausgabe (Kopf + Tail, siehe Executor). */
  maxOutputBytes?: number;
  /** Zeilenweise Live-Ausgabe (bereits ANSI-bereinigt). */
  onOutput?: (chunk: ProcessOutputChunk) => void;
  /** Text, der dem Kind auf stdin übergeben wird; ohne Angabe wird stdin geschlossen. */
  stdin?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  canceled: boolean;
  /** true, wenn Ausgabe wegen maxOutputBytes verworfen wurde. */
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessHandle {
  pid: number | undefined;
  /** Prozessgruppen-ID (POSIX: identisch mit pid bei detached spawn). */
  pgid: number | undefined;
  result: Promise<ProcessResult>;
  /** Beendet die gesamte Prozessgruppe (SIGTERM → Grace → SIGKILL). */
  cancel(): void;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): ProcessHandle;
}
