import { describe, expect, it } from 'vitest';
import { ProcessExecutor } from '../src/process/executor.js';

const NODE = process.execPath;

describe('ProcessExecutor', () => {
  const executor = new ProcessExecutor({ killGraceMs: 300 });

  it('erfasst stdout und Exit-Code eines erfolgreichen Prozesses', async () => {
    const handle = executor.run({
      command: NODE,
      args: ['-e', 'process.stdout.write("hallo welt")'],
      cwd: process.cwd(),
    });
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hallo welt');
    expect(result.timedOut).toBe(false);
  });

  it('trennt stderr und nicht-null Exit-Codes', async () => {
    const handle = executor.run({
      command: NODE,
      args: ['-e', 'process.stderr.write("kaputt"); process.exit(3)'],
      cwd: process.cwd(),
    });
    const result = await handle.result;
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('kaputt');
  });

  it('streamt Ausgabe zeilenweise über onOutput', async () => {
    const lines: string[] = [];
    const handle = executor.run({
      command: NODE,
      args: ['-e', 'console.log("a"); console.log("b"); console.error("c")'],
      cwd: process.cwd(),
      onOutput: (chunk) => lines.push(`${chunk.stream}:${chunk.text}`),
    });
    await handle.result;
    expect(lines).toContain('stdout:a');
    expect(lines).toContain('stdout:b');
    expect(lines).toContain('stderr:c');
  });

  it('erzwingt Timeout und beendet den Prozess', async () => {
    const handle = executor.run({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 200,
    });
    const result = await handle.result;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('bricht laufende Prozesse über cancel ab', async () => {
    const handle = executor.run({
      command: NODE,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    setTimeout(() => handle.cancel(), 100);
    const result = await handle.result;
    expect(result.canceled).toBe(true);
  });

  it('beendet die gesamte Prozessgruppe (Kind-Prozesse überleben nicht)', async () => {
    // Startet ein Kind, das seinerseits ein langlebiges Enkel-Kind spawnt.
    const script = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;
    const handle = executor.run({
      command: NODE,
      args: ['-e', script],
      cwd: process.cwd(),
      timeoutMs: 10_000,
    });
    expect(handle.pgid).toBeGreaterThan(0);
    setTimeout(() => handle.cancel(), 200);
    const result = await handle.result;
    expect(result.canceled).toBe(true);
    // Prozessgruppe ist weg: erneutes Killen wirft ESRCH.
    let alive = true;
    try {
      process.kill(-(handle.pgid as number), 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('begrenzt die Ausgabegröße und behält Kopf und Tail', async () => {
    const handle = executor.run({
      command: NODE,
      args: [
        '-e',
        'for (let i=0;i<20000;i++) console.log("ZEILE_"+i)',
      ],
      cwd: process.cwd(),
      maxOutputBytes: 4096,
    });
    const result = await handle.result;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain('ZEILE_0');
    expect(result.stdout).toContain('gekürzt');
    expect(result.stdout).toContain('ZEILE_19999');
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(20000);
  });

  it('übergibt stdin und meldet Prozessstartfehler statt zu werfen', async () => {
    const ok = await executor
      .run({
        command: NODE,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        cwd: process.cwd(),
        stdin: 'echo-mich',
      })
      .result;
    expect(ok.stdout).toContain('echo-mich');

    const missing = await executor
      .run({ command: '/nicht/vorhanden/xyz', args: [], cwd: process.cwd() })
      .result;
    expect(missing.exitCode).toBeNull();
    expect(missing.stderr).toContain('fehlgeschlagen');
  });
});
