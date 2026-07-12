CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  base_branch TEXT NOT NULL DEFAULT 'main',
  worktree_root TEXT NOT NULL,
  commands_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  linear_issue_id TEXT NOT NULL UNIQUE,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  team_key TEXT,
  team_name TEXT,
  priority INTEGER,
  priority_label TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  linear_state TEXT,
  linear_created_at TEXT,
  linear_updated_at TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tickets_project ON tickets(project_id);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL DEFAULT 'inbox',
  review_loop_count INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  branch TEXT,
  base_branch TEXT NOT NULL,
  current_agent TEXT,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  active_pgid INTEGER,
  deadline_at TEXT,
  last_error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_state ON jobs(state);
CREATE INDEX idx_jobs_ticket ON jobs(ticket_id);
CREATE INDEX idx_jobs_project ON jobs(project_id);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  message TEXT,
  data_json TEXT
);
CREATE INDEX idx_job_events_job ON job_events(job_id, id);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  pgid INTEGER,
  exit_code INTEGER,
  output TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_agent_runs_job ON agent_runs(job_id, started_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  agent_run_id TEXT REFERENCES agent_runs(id),
  type TEXT NOT NULL,
  path TEXT,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_job ON artifacts(job_id, created_at);

CREATE TABLE review_iterations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  iteration INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_iterations_job ON review_iterations(job_id, iteration);

CREATE TABLE test_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  iteration INTEGER NOT NULL,
  command_key TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_test_runs_job ON test_runs(job_id, started_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
