import { spawn } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import type {
  ProcessHandle,
  ProcessResult,
  ProcessRunner,
  ProcessSpec,
} from '@agent/shared';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Zeilenpuffer-Limit: Prozesse ohne Newlines fluten sonst den Speicher. */
const MAX_LINE_REMAINDER = 1024 * 1024;

/**
 * Begrenzter Ausgabespeicher: behält den Kopf (80 %) und einen Tail-Ringpuffer
 * (20 %), damit bei überlaufender Ausgabe Anfang UND Ende erhalten bleiben —
 * z. B. für VERDICT-Zeilen am Ende langer Reviews.
 */
class BoundedBuffer {
  private headParts: string[] = [];
  private headBytes = 0;
  private tailParts: string[] = [];
  private tailBytes = 0;
  truncated = false;

  constructor(
    private readonly headLimit: number,
    private readonly tailLimit: number,
  ) {}

  push(text: string): void {
    const bytes = Buffer.byteLength(text);
    if (!this.truncated && this.headBytes + bytes <= this.headLimit) {
      this.headParts.push(text);
      this.headBytes += bytes;
      return;
    }
    this.truncated = true;
    this.tailParts.push(text);
    this.tailBytes += bytes;
    while (this.tailBytes > this.tailLimit && this.tailParts.length > 1) {
      const removed = this.tailParts.shift() as string;
      this.tailBytes -= Buffer.byteLength(removed);
    }
    if (this.tailBytes > this.tailLimit && this.tailParts.length === 1) {
      const only = this.tailParts[0] as string;
      const keep = only.slice(-this.tailLimit);
      this.tailParts[0] = keep;
      this.tailBytes = Buffer.byteLength(keep);
    }
  }

  toString(): string {
    if (!this.truncated) return this.headParts.join('');
    return `${this.headParts.join('')}\n… [Ausgabe gekürzt] …\n${this.tailParts.join('')}`;
  }
}

export interface ProcessExecutorOptions {
  /** Wartezeit zwischen SIGTERM und SIGKILL (Default 5 s). */
  killGraceMs?: number;
}

/**
 * Sichere Prozessausführung (Spezifikation "Prozessausführung"):
 * spawn ohne Shell, getrennte Argumente, explizites cwd, gefilterte Env,
 * Timeout, Abbruch, Prozessgruppen-Kill, Output-Begrenzung, Live-Streaming.
 */
export class ProcessExecutor implements ProcessRunner {
  private readonly killGraceMs: number;

  constructor(options: ProcessExecutorOptions = {}) {
    this.killGraceMs = options.killGraceMs ?? 5_000;
  }

  run(spec: ProcessSpec): ProcessHandle {
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const headLimit = Math.max(1024, Math.floor(maxBytes * 0.8));
    const tailLimit = Math.max(1024, maxBytes - headLimit);
    const detached = process.platform !== 'win32';
    const startedAt = Date.now();

    let timedOut = false;
    let canceled = false;
    let settled = false;
    let liveTruncationAnnounced = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const stdoutBuf = new BoundedBuffer(headLimit, tailLimit);
    const stderrBuf = new BoundedBuffer(headLimit, tailLimit);

    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env ? { ...spec.env } : {},
      stdio: [spec.stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      detached,
    });

    const pid = child.pid;
    const pgid = detached && pid != null ? pid : undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (detached && pid != null) {
          process.kill(-pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // ESRCH: Gruppe existiert nicht mehr — Einzelprozess als Fallback.
        try {
          child.kill(signal);
        } catch {
          /* bereits beendet */
        }
      }
    };

    const terminate = (): void => {
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => killGroup('SIGKILL'), this.killGraceMs);
      graceTimer.unref?.();
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    const emit = (stream: 'stdout' | 'stderr', buf: BoundedBuffer, text: string): void => {
      buf.push(text.endsWith('\n') ? text : `${text}\n`);
      if (!spec.onOutput) return;
      if (!buf.truncated) {
        spec.onOutput({ stream, text });
      } else if (!liveTruncationAnnounced) {
        liveTruncationAnnounced = true;
        spec.onOutput({
          stream,
          text: '… [Live-Ausgabe wegen Größenlimit gekürzt — Kopf und Ende bleiben erhalten] …',
        });
      }
    };

    const makeStreamHandler = (stream: 'stdout' | 'stderr', buf: BoundedBuffer) => {
      let remainder = '';
      const onData = (data: Buffer): void => {
        remainder += data.toString('utf8');
        if (remainder.includes('\n')) {
          const lines = remainder.split('\n');
          remainder = lines.pop() ?? '';
          emit(stream, buf, stripAnsi(lines.join('\n')));
        }
        if (remainder.length > MAX_LINE_REMAINDER) {
          emit(stream, buf, stripAnsi(remainder));
          remainder = '';
        }
      };
      const flush = (): void => {
        if (remainder.length > 0) {
          emit(stream, buf, stripAnsi(remainder));
          remainder = '';
        }
      };
      return { onData, flush };
    };

    const stdoutHandler = makeStreamHandler('stdout', stdoutBuf);
    const stderrHandler = makeStreamHandler('stderr', stderrBuf);
    child.stdout?.on('data', stdoutHandler.onData);
    child.stderr?.on('data', stderrHandler.onData);

    if (spec.stdin != null && child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE bei früh beendetem Kind ignorieren */
      });
      child.stdin.write(spec.stdin);
      child.stdin.end();
    }

    const result = new Promise<ProcessResult>((resolve) => {
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (graceTimer) clearTimeout(graceTimer);
        stdoutHandler.flush();
        stderrHandler.flush();
        resolve({
          exitCode,
          signal,
          timedOut,
          canceled,
          truncated: stdoutBuf.truncated || stderrBuf.truncated,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          durationMs: Date.now() - startedAt,
        });
      };

      child.on('error', (error: NodeJS.ErrnoException) => {
        stderrBuf.push(`Prozessstart fehlgeschlagen: ${error.message}\n`);
        finish(null, null);
      });
      child.on('close', (code, signal) => finish(code, signal ?? null));
    });

    return {
      pid,
      pgid,
      result,
      cancel: () => {
        canceled = true;
        terminate();
      },
    };
  }
}
