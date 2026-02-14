-- MLflare D1 Schema

CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    config TEXT, -- JSON
    git_branch TEXT,
    git_commit TEXT,
    git_dirty INTEGER DEFAULT 0,
    entrypoint TEXT NOT NULL,
    deps_hash TEXT,
    bundle_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES experiments(id),
    status TEXT NOT NULL DEFAULT 'queued', -- queued | running | completed | failed | cancelled
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    exit_code INTEGER
);

CREATE TABLE IF NOT EXISTS run_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    step INTEGER NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL,
    logged_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_run_metrics_run_step ON run_metrics(run_id, step);
CREATE INDEX IF NOT EXISTS idx_run_metrics_run_name ON run_metrics(run_id, metric_name);

CREATE TABLE IF NOT EXISTS run_params (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id),
    param_name TEXT NOT NULL,
    param_value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_params_run ON run_params(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_experiment ON runs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project);
