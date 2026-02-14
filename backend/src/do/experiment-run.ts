import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import type { RunStatus } from '../types';

export class ExperimentRun extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initTables();
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS run_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        run_id TEXT,
        experiment_id TEXT,
        project TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        entrypoint TEXT,
        config TEXT,
        git_branch TEXT,
        git_commit TEXT,
        error_message TEXT,
        exit_code INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );
      INSERT OR IGNORE INTO run_state (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS metric_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        step INTEGER NOT NULL,
        metric_name TEXT NOT NULL,
        metric_value REAL NOT NULL,
        logged_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mp_step ON metric_points(step);
      CREATE INDEX IF NOT EXISTS idx_mp_name ON metric_points(metric_name);

      CREATE TABLE IF NOT EXISTS metric_summary (
        metric_name TEXT PRIMARY KEY,
        last_value REAL NOT NULL,
        last_step INTEGER NOT NULL,
        min_value REAL NOT NULL,
        max_value REAL NOT NULL,
        count INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS log_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        stream TEXT NOT NULL DEFAULT 'stdout',
        logged_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** Initialize run state. */
  async initialize(params: {
    run_id: string;
    experiment_id: string;
    project: string;
    entrypoint: string;
    config?: Record<string, unknown>;
    git_branch?: string;
    git_commit?: string;
  }): Promise<void> {
    this.sql.exec(
      `UPDATE run_state SET
        run_id = ?, experiment_id = ?, project = ?, entrypoint = ?,
        config = ?, git_branch = ?, git_commit = ?, status = 'queued'
      WHERE id = 1`,
      params.run_id,
      params.experiment_id,
      params.project,
      params.entrypoint,
      params.config ? JSON.stringify(params.config) : null,
      params.git_branch ?? null,
      params.git_commit ?? null,
    );
  }

  /** Mark run as started. */
  async markRunning(): Promise<void> {
    this.sql.exec(
      `UPDATE run_state SET status = 'running', started_at = datetime('now') WHERE id = 1`,
    );
  }

  /** Append metrics batch. */
  async appendMetrics(metrics: Array<{ step: number; values: Record<string, number> }>): Promise<void> {
    for (const batch of metrics) {
      for (const [name, value] of Object.entries(batch.values)) {
        this.sql.exec(
          'INSERT INTO metric_points (step, metric_name, metric_value) VALUES (?, ?, ?)',
          batch.step,
          name,
          value,
        );
        // Upsert summary
        this.sql.exec(
          `INSERT INTO metric_summary (metric_name, last_value, last_step, min_value, max_value, count)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(metric_name) DO UPDATE SET
             last_value = ?,
             last_step = MAX(last_step, ?),
             min_value = MIN(min_value, ?),
             max_value = MAX(max_value, ?),
             count = count + 1`,
          name, value, batch.step, value, value,
          value, batch.step, value, value,
        );
      }
    }
  }

  /** Append log lines. */
  async appendLogs(lines: Array<{ line: string; stream?: string }>): Promise<void> {
    for (const entry of lines) {
      this.sql.exec(
        'INSERT INTO log_lines (line, stream) VALUES (?, ?)',
        entry.line,
        entry.stream ?? 'stdout',
      );
    }
  }

  /** Mark run completed. */
  async markCompleted(exitCode?: number): Promise<void> {
    this.sql.exec(
      `UPDATE run_state SET status = 'completed', completed_at = datetime('now'), exit_code = ? WHERE id = 1`,
      exitCode ?? 0,
    );
  }

  /** Mark run failed. */
  async markFailed(error: string, exitCode?: number): Promise<void> {
    this.sql.exec(
      `UPDATE run_state SET status = 'failed', completed_at = datetime('now'), error_message = ?, exit_code = ? WHERE id = 1`,
      error,
      exitCode ?? 1,
    );
  }

  /** Get current run state + latest metrics. */
  async getState(): Promise<{
    run_id: string | null;
    experiment_id: string | null;
    project: string | null;
    status: RunStatus;
    entrypoint: string | null;
    config: Record<string, unknown> | null;
    git_branch: string | null;
    git_commit: string | null;
    error_message: string | null;
    exit_code: number | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    metrics: Record<string, { value: number; step: number; min: number; max: number; count: number }>;
  }> {
    const row = this.sql.exec('SELECT * FROM run_state WHERE id = 1').one();
    const summaryRows = this.sql.exec('SELECT * FROM metric_summary').toArray();
    const metrics: Record<string, { value: number; step: number; min: number; max: number; count: number }> = {};
    for (const s of summaryRows) {
      metrics[s.metric_name as string] = {
        value: s.last_value as number,
        step: s.last_step as number,
        min: s.min_value as number,
        max: s.max_value as number,
        count: s.count as number,
      };
    }

    return {
      run_id: row.run_id as string | null,
      experiment_id: row.experiment_id as string | null,
      project: row.project as string | null,
      status: row.status as RunStatus,
      entrypoint: row.entrypoint as string | null,
      config: row.config ? JSON.parse(row.config as string) : null,
      git_branch: row.git_branch as string | null,
      git_commit: row.git_commit as string | null,
      error_message: row.error_message as string | null,
      exit_code: row.exit_code as number | null,
      created_at: row.created_at as string,
      started_at: row.started_at as string | null,
      completed_at: row.completed_at as string | null,
      metrics,
    };
  }

  /** Get metric history for a specific metric. */
  async getMetrics(name?: string, since?: number): Promise<Array<{ step: number; metric_name: string; metric_value: number; logged_at: string }>> {
    if (name) {
      const rows = since
        ? this.sql.exec('SELECT * FROM metric_points WHERE metric_name = ? AND id > ? ORDER BY step', name, since).toArray()
        : this.sql.exec('SELECT * FROM metric_points WHERE metric_name = ? ORDER BY step', name).toArray();
      return rows as unknown as Array<{ step: number; metric_name: string; metric_value: number; logged_at: string }>;
    }
    const rows = since
      ? this.sql.exec('SELECT * FROM metric_points WHERE id > ? ORDER BY step', since).toArray()
      : this.sql.exec('SELECT * FROM metric_points ORDER BY step').toArray();
    return rows as unknown as Array<{ step: number; metric_name: string; metric_value: number; logged_at: string }>;
  }
}
