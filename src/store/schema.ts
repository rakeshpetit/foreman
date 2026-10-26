export const MIGRATIONS: string[] = [
  `
  CREATE TABLE counters (kind TEXT PRIMARY KEY, n INTEGER NOT NULL);
  CREATE TABLE requests (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, target_repo TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'planning',
    phase TEXT NOT NULL DEFAULT 'planning', token_budget INTEGER, created_at TEXT NOT NULL
  );
  CREATE TABLE milestones (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), seq INTEGER NOT NULL,
    title TEXT NOT NULL, branch TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL REFERENCES milestones(id), seq INTEGER NOT NULL,
    ref TEXT, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'default',
    origin TEXT NOT NULL DEFAULT 'planned', parent_task_id TEXT, size_est TEXT,
    lane TEXT NOT NULL DEFAULT 'normal', stage TEXT, stage_state TEXT,
    round_stage INTEGER NOT NULL DEFAULT 0, round_total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued', agent_overrides TEXT, branch TEXT, file_path TEXT
  );
  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id), depends_on TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on)
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
    stage TEXT NOT NULL, agent TEXT, model TEXT, effort TEXT, started_at TEXT NOT NULL,
    ended_at TEXT, verdict TEXT, tokens_in INTEGER, tokens_out INTEGER, cache_read INTEGER,
    cache_write INTEGER, context_peak INTEGER, cost_usd REAL, duration_ms INTEGER,
    exit_code INTEGER, report_path TEXT, error TEXT
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT, channel TEXT,
    requested_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE TABLE leases (task_id TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), paused_until TEXT, reason TEXT);
  INSERT INTO queue_state (id) VALUES (1);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL,
    subject TEXT, payload TEXT
  );
  `,
];
