-- Optionales Linear-Status-Sync-Mapping pro Projekt (JSON, 'null' = deaktiviert).
ALTER TABLE projects ADD COLUMN linear_state_sync_json TEXT NOT NULL DEFAULT 'null';
