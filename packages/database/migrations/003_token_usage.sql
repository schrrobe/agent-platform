-- Token-Verbrauch pro Agenten-Lauf. Nullable: nur Agenten mit maschinenlesbarer
-- Usage-Ausgabe (Claude Code JSON) liefern Werte; Codex/Hermes bleiben NULL.
ALTER TABLE agent_runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN total_tokens INTEGER;
ALTER TABLE agent_runs ADD COLUMN cost_usd REAL;
