import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppDatabase } from './db.js';

/** Liegt sowohl relativ zu `src/` als auch zu `dist/` eine Ebene höher. */
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/** Lädt nummerierte Migrationsdateien (`NNN_name.sql`) sortiert nach ID. */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const files = fs
    .readdirSync(dir)
    .filter((file) => /^\d{3}_[\w-]+\.sql$/.test(file))
    .sort();
  return files.map((file) => {
    const id = Number.parseInt(file.slice(0, 3), 10);
    return { id, name: file, sql: fs.readFileSync(path.join(dir, file), 'utf8') };
  });
}

export interface MigrateResult {
  applied: string[];
}

/**
 * Wendet ausstehende Migrationen in aufsteigender Reihenfolge an, jede in einer
 * eigenen Transaktion. Bereits angewendete Migrationen (schema_migrations)
 * werden übersprungen — mehrfacher Aufruf ist idempotent.
 */
export function migrate(db: AppDatabase, migrations: Migration[] = loadMigrations()): MigrateResult {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
  );
  const appliedIds = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(
      (row) => row.id,
    ),
  );
  const applied: string[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)');
  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id, migration.name);
    })();
    applied.push(migration.name);
  }
  return { applied };
}
