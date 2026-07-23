-- Queue-Steuerung: Prioritätsstufen (1=hoch, 0=normal, -1=niedrig) und manuelle
-- Reihenfolge (Fractional Indexing) innerhalb gleicher Priorität.
ALTER TABLE jobs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN queue_position REAL NOT NULL DEFAULT 0;

-- Bestandsjobs behalten ihre FIFO-Ordnung (Position aus dem Erstellzeitpunkt).
UPDATE jobs SET queue_position = CAST(strftime('%s', created_at) AS REAL) * 1000;

CREATE INDEX idx_jobs_queue ON jobs (state, queue_priority DESC, queue_position ASC);
