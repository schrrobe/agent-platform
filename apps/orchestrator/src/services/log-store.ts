import fs from 'node:fs';
import path from 'node:path';
import type { LogLine } from '@agent/shared';

/**
 * Persistenter, zeilenbasierter Live-Log je Job als NDJSON. Kanonische Quelle
 * für `GET /api/jobs/:id/logs` und für den Nachlauf nach WS-Reconnect
 * (die WS-Ausgabe selbst ist verlustbehaftet, ADR-012).
 */
export class LogStore {
  private readonly seqByJob = new Map<string, number>();

  constructor(private readonly logsDir: string) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  private fileFor(jobId: string): string {
    return path.join(this.logsDir, `${jobId}.ndjson`);
  }

  private nextSeq(jobId: string): number {
    let seq = this.seqByJob.get(jobId);
    if (seq === undefined) {
      // Beim ersten Zugriff aus bestehender Datei ableiten (Neustart-sicher).
      seq = this.countLines(jobId);
    }
    seq += 1;
    this.seqByJob.set(jobId, seq);
    return seq;
  }

  private countLines(jobId: string): number {
    try {
      const content = fs.readFileSync(this.fileFor(jobId), 'utf8');
      return content.split('\n').filter((line) => line.length > 0).length;
    } catch {
      return 0;
    }
  }

  append(jobId: string, entry: Omit<LogLine, 'seq'>): LogLine {
    const line: LogLine = { seq: this.nextSeq(jobId), ...entry };
    fs.appendFileSync(this.fileFor(jobId), `${JSON.stringify(line)}\n`);
    return line;
  }

  read(jobId: string, opts: { afterSeq?: number; limit?: number } = {}): LogLine[] {
    let content: string;
    try {
      content = fs.readFileSync(this.fileFor(jobId), 'utf8');
    } catch {
      return [];
    }
    const afterSeq = opts.afterSeq ?? 0;
    const lines = content
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine)
      .filter((line) => line.seq > afterSeq);
    const limit = opts.limit ?? 1000;
    return lines.slice(-limit);
  }

  /** Entfernt die persistierte Logdatei eines Jobs und startet dessen Sequenz neu. */
  clear(jobId: string): void {
    fs.rmSync(this.fileFor(jobId), { force: true });
    this.seqByJob.delete(jobId);
  }
}
