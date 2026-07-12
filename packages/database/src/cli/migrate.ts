/**
 * `pnpm db:migrate` — wendet ausstehende Migrationen an.
 * Relative DATABASE_PATH-Angaben werden gegen das Aufrufverzeichnis aufgelöst
 * (INIT_CWD, von pnpm gesetzt), damit `pnpm db:migrate` im Repo-Root dieselbe
 * Datenbank trifft wie der Orchestrator.
 */
import path from 'node:path';
import { openDatabase } from '../db.js';
import { migrate } from '../migrate.js';

const baseDir = process.env.INIT_CWD ?? process.cwd();

try {
  process.loadEnvFile(path.join(baseDir, '.env'));
} catch {
  // Keine .env vorhanden — Umgebungsvariablen der Shell gelten.
}

const rawPath = process.env.DATABASE_PATH ?? './data/orchestrator.db';
const databasePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);

const db = openDatabase(databasePath);
try {
  const { applied } = migrate(db);
  if (applied.length > 0) {
    console.log(`Migrationen angewendet: ${applied.join(', ')}`);
  } else {
    console.log('Schema aktuell — keine neuen Migrationen.');
  }
  console.log(`Datenbank: ${databasePath}`);
} finally {
  db.close();
}
