-- Vorgänge: ein Job kann mehrere Tickets bündeln.
-- jobs.ticket_id bleibt das primäre Ticket (Branch/Worktree/Card); zusätzliche
-- (sekundäre) Tickets werden hier verknüpft. Ein sekundäres Ticket gehört zu
-- genau einem Vorgang (UNIQUE), primär zuerst über die Position sortiert.
CREATE TABLE job_tickets (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  position REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, ticket_id)
);
CREATE INDEX idx_job_tickets_job ON job_tickets(job_id);
CREATE UNIQUE INDEX idx_job_tickets_ticket ON job_tickets(ticket_id);
