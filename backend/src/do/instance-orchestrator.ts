import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import type { InstanceState, AgentAssignment } from '../types';
import { createHyperstackClient, type HyperstackClient } from '../lib/hyperstack';

type AlarmType = 'cooldown' | 'heartbeat_timeout' | 'wake_poll' | 'hibernate_poll';

interface QueueEntry {
  run_id: string;
  experiment_id: string;
  entrypoint: string;
  bundle_key: string;
  deps_hash: string | null;
  config: string | null; // JSON
  queued_at: string;
}

export class InstanceOrchestrator extends DurableObject<Env> {
  sql: SqlStorage;
  private hyperstack: HyperstackClient | null = null;
  private isDev: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.isDev = env.ENVIRONMENT === 'development';
    if (!this.isDev && env.HYPERSTACK_API_KEY) {
      this.hyperstack = createHyperstackClient(env.HYPERSTACK_API_KEY);
    }
    this.initTables();
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        instance_state TEXT NOT NULL DEFAULT 'idle',
        current_run_id TEXT,
        agent_last_seen TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO state (id, instance_state) VALUES (1, 'idle');

      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        experiment_id TEXT NOT NULL,
        entrypoint TEXT NOT NULL,
        bundle_key TEXT NOT NULL,
        deps_hash TEXT,
        config TEXT,
        queued_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS alarms (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        alarm_type TEXT
      );
      INSERT OR IGNORE INTO alarms (id) VALUES (1);
    `);
  }

  private getState(): { instance_state: InstanceState; current_run_id: string | null; agent_last_seen: string | null } {
    const row = this.sql.exec('SELECT instance_state, current_run_id, agent_last_seen FROM state WHERE id = 1').one();
    return {
      instance_state: row.instance_state as InstanceState,
      current_run_id: row.current_run_id as string | null,
      agent_last_seen: row.agent_last_seen as string | null,
    };
  }

  private setState(state: InstanceState, currentRunId?: string | null) {
    if (currentRunId !== undefined) {
      this.sql.exec(
        `UPDATE state SET instance_state = ?, current_run_id = ?, updated_at = datetime('now') WHERE id = 1`,
        state,
        currentRunId,
      );
    } else {
      this.sql.exec(
        `UPDATE state SET instance_state = ?, updated_at = datetime('now') WHERE id = 1`,
        state,
      );
    }
  }

  private setAlarm(type: AlarmType, delayMs: number) {
    this.sql.exec('UPDATE alarms SET alarm_type = ? WHERE id = 1', type);
    this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private getAlarmType(): AlarmType | null {
    const row = this.sql.exec('SELECT alarm_type FROM alarms WHERE id = 1').one();
    return row.alarm_type as AlarmType | null;
  }

  private getQueueDepth(): number {
    const row = this.sql.exec('SELECT COUNT(*) as cnt FROM queue').one();
    return row.cnt as number;
  }

  private peekQueue(): QueueEntry | null {
    const rows = this.sql.exec('SELECT * FROM queue ORDER BY id ASC LIMIT 1').toArray();
    return rows.length > 0 ? (rows[0] as unknown as QueueEntry) : null;
  }

  private dequeue(): QueueEntry | null {
    const entry = this.peekQueue();
    if (entry) {
      this.sql.exec('DELETE FROM queue WHERE run_id = ?', entry.run_id);
    }
    return entry;
  }

  /** Enqueue a new experiment run. */
  async enqueue(params: {
    run_id: string;
    experiment_id: string;
    entrypoint: string;
    bundle_key: string;
    deps_hash?: string;
    config?: Record<string, unknown>;
  }): Promise<{ position: number }> {
    this.sql.exec(
      'INSERT INTO queue (run_id, experiment_id, entrypoint, bundle_key, deps_hash, config) VALUES (?, ?, ?, ?, ?, ?)',
      params.run_id,
      params.experiment_id,
      params.entrypoint,
      params.bundle_key,
      params.deps_hash ?? null,
      params.config ? JSON.stringify(params.config) : null,
    );

    const state = this.getState();
    if (state.instance_state === 'idle') {
      await this.wakeInstance();
    }

    return { position: this.getQueueDepth() };
  }

  /** Agent checks in — return assignment if available. */
  async agentCheckin(_info: { agent_version: string; hostname: string }): Promise<AgentAssignment | null> {
    const state = this.getState();
    this.sql.exec(`UPDATE state SET agent_last_seen = datetime('now') WHERE id = 1`);

    if (state.current_run_id) {
      // Already assigned
      return null;
    }

    const entry = this.dequeue();
    if (!entry) {
      // No work — start cooldown
      if (state.instance_state === 'running' || state.instance_state === 'waking') {
        this.setState('cooldown');
        this.setAlarm('cooldown', 5 * 60 * 1000); // 5 min cooldown
      }
      return null;
    }

    this.setState('running', entry.run_id);
    this.setAlarm('heartbeat_timeout', 5 * 60 * 1000); // 5 min timeout

    return {
      run_id: entry.run_id,
      experiment_id: entry.experiment_id,
      entrypoint: entry.entrypoint,
      bundle_key: entry.bundle_key,
      deps_hash: entry.deps_hash ?? undefined,
      config: entry.config ? JSON.parse(entry.config) : undefined,
    };
  }

  /** Agent heartbeat — reset timeout. */
  async heartbeat(): Promise<void> {
    this.sql.exec(`UPDATE state SET agent_last_seen = datetime('now') WHERE id = 1`);
    const state = this.getState();
    if (state.instance_state === 'running') {
      this.setAlarm('heartbeat_timeout', 5 * 60 * 1000);
    }
  }

  /** Run completed — try next in queue. */
  async runCompleted(runId: string): Promise<void> {
    const state = this.getState();
    if (state.current_run_id !== runId) return;

    this.setState('running', null);

    // Check for more work
    const next = this.peekQueue();
    if (!next) {
      this.setState('cooldown');
      this.setAlarm('cooldown', 5 * 60 * 1000);
    }
    // Next checkin will pick up the queued work
  }

  /** Run failed — try next in queue. */
  async runFailed(runId: string, _error?: string): Promise<void> {
    await this.runCompleted(runId);
  }

  /** Get current orchestrator state (for status API). */
  async getStatus(): Promise<{
    instance_state: InstanceState;
    current_run_id: string | null;
    queue_depth: number;
    agent_last_seen: string | null;
    queue: Array<{ run_id: string; experiment_id: string; queued_at: string }>;
  }> {
    const state = this.getState();
    const queueEntries = this.sql.exec('SELECT run_id, experiment_id, queued_at FROM queue ORDER BY id ASC').toArray();
    return {
      instance_state: state.instance_state,
      current_run_id: state.current_run_id,
      queue_depth: this.getQueueDepth(),
      agent_last_seen: state.agent_last_seen,
      queue: queueEntries as unknown as Array<{ run_id: string; experiment_id: string; queued_at: string }>,
    };
  }

  /** Force wake the instance. */
  async forceWake(): Promise<void> {
    const state = this.getState();
    if (state.instance_state === 'idle' || state.instance_state === 'hibernating') {
      await this.wakeInstance();
    }
  }

  /** Force hibernate the instance. */
  async forceHibernate(): Promise<void> {
    const state = this.getState();
    if (state.instance_state !== 'idle' && state.instance_state !== 'hibernating') {
      await this.hibernateInstance();
    }
  }

  private async wakeInstance() {
    this.setState('waking');
    if (this.hyperstack && !this.isDev) {
      try {
        await this.hyperstack.restoreVm(this.env.HYPERSTACK_VM_ID);
        this.setAlarm('wake_poll', 15_000); // Poll every 15s
      } catch (e) {
        console.error('Failed to restore VM:', e);
        this.setState('error');
      }
    } else {
      // Dev mode: instant wake
      this.setState('running');
    }
  }

  private async hibernateInstance() {
    this.setState('hibernating');
    if (this.hyperstack && !this.isDev) {
      try {
        await this.hyperstack.hibernateVm(this.env.HYPERSTACK_VM_ID);
        this.setAlarm('hibernate_poll', 15_000);
      } catch (e) {
        console.error('Failed to hibernate VM:', e);
        this.setState('error');
      }
    } else {
      // Dev mode: instant hibernate
      this.setState('idle');
    }
  }

  override async alarm(): Promise<void> {
    const alarmType = this.getAlarmType();
    const state = this.getState();

    switch (alarmType) {
      case 'cooldown': {
        // Cooldown expired — if no new work, hibernate
        if (this.getQueueDepth() === 0 && !state.current_run_id) {
          await this.hibernateInstance();
        } else {
          this.setState('running');
        }
        break;
      }

      case 'heartbeat_timeout': {
        // Agent didn't heartbeat in time
        if (state.instance_state === 'running' && state.current_run_id) {
          console.error(`Heartbeat timeout for run ${state.current_run_id}`);
          this.setState('running', null);
          // Check queue for more work
          if (this.getQueueDepth() === 0) {
            this.setState('cooldown');
            this.setAlarm('cooldown', 5 * 60 * 1000);
          }
        }
        break;
      }

      case 'wake_poll': {
        if (state.instance_state !== 'waking' || !this.hyperstack) break;
        try {
          const vm = await this.hyperstack.getVmStatus(this.env.HYPERSTACK_VM_ID);
          if (vm.status === 'ACTIVE') {
            this.setState('running');
          } else {
            this.setAlarm('wake_poll', 15_000);
          }
        } catch (e) {
          console.error('Wake poll failed:', e);
          this.setAlarm('wake_poll', 30_000);
        }
        break;
      }

      case 'hibernate_poll': {
        if (state.instance_state !== 'hibernating' || !this.hyperstack) break;
        try {
          const vm = await this.hyperstack.getVmStatus(this.env.HYPERSTACK_VM_ID);
          if (vm.status === 'HIBERNATED') {
            this.setState('idle');
          } else {
            this.setAlarm('hibernate_poll', 15_000);
          }
        } catch (e) {
          console.error('Hibernate poll failed:', e);
          this.setAlarm('hibernate_poll', 30_000);
        }
        break;
      }
    }
  }
}
