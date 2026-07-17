import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DirectoryPickerKind = 'repository' | 'worktree';

export class DirectoryPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryPickerUnavailableError';
  }
}

type CommandResult = string | null | undefined;

function runPicker(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        if (!error) {
          const selected = stdout.trim();
          resolve(selected || null);
          return;
        }

        const code = String((error as NodeJS.ErrnoException).code);
        if (code === 'ENOENT') {
          resolve(undefined);
          return;
        }

        // Native directory pickers use a non-zero exit code for cancellation.
        if (code === '1' || code === '-128') {
          resolve(null);
          return;
        }

        reject(error);
      },
    );
  });
}

function promptFor(kind: DirectoryPickerKind): string {
  return kind === 'repository' ? 'Git-Repository auswählen' : 'Worktree-Wurzel auswählen';
}

function normalizeSelectedDirectory(selected: string): string {
  const directory = path.normalize(path.resolve(selected));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    throw new Error(`Der ausgewählte Ordner ist nicht erreichbar: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Der ausgewählte Pfad ist kein Ordner: ${directory}`);
  }
  return directory;
}

/** Öffnet den nativen Ordnerdialog des lokalen Betriebssystems. */
export async function pickDirectory(kind: DirectoryPickerKind): Promise<string | null> {
  const prompt = promptFor(kind);
  let selected: CommandResult;

  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`;
    selected = await runPicker('osascript', ['-e', script]);
    if (selected === undefined) {
      throw new DirectoryPickerUnavailableError('macOS-Ordnerauswahl ist nicht verfügbar.');
    }
  } else if (process.platform === 'linux') {
    selected = await runPicker('zenity', [
      '--file-selection',
      '--directory',
      `--title=${prompt}`,
      '--filename',
      `${os.homedir()}${path.sep}`,
    ]);

    if (selected === undefined) {
      selected = await runPicker('kdialog', [
        '--getexistingdirectory',
        os.homedir(),
        '--title',
        prompt,
      ]);
    }

    if (selected === undefined) {
      throw new DirectoryPickerUnavailableError(
        'Keine grafische Ordnerauswahl gefunden. Installiere unter Linux zenity oder kdialog.',
      );
    }
  } else {
    throw new DirectoryPickerUnavailableError(
      `Native Ordnerauswahl wird auf ${process.platform} nicht unterstützt.`,
    );
  }

  return selected === null ? null : normalizeSelectedDirectory(selected);
}
