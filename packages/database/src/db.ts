import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type AppDatabase = Database.Database;

/**
 * Öffnet (und erstellt bei Bedarf) die SQLite-Datenbank mit den Projekt-Pragmas:
 * WAL für parallele Leser, busy_timeout gegen SQLITE_BUSY durch Zweitprozesse,
 * erzwungene Fremdschlüssel (ADR-014).
 */
export function openDatabase(databasePath: string): AppDatabase {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}
