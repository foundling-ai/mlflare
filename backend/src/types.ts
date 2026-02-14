export type InstanceState =
  | 'idle'
  | 'waking'
  | 'running'
  | 'cooldown'
  | 'hibernating'
  | 'error';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExperimentSubmission {
  project: string;
  entrypoint: string;
  config?: Record<string, unknown>;
  git_branch?: string;
  git_commit?: string;
  git_dirty?: boolean;
  deps_hash?: string;
  bundle_key: string;
}

export interface AgentCheckin {
  agent_version: string;
  hostname: string;
}

export interface AgentAssignment {
  run_id: string;
  experiment_id: string;
  entrypoint: string;
  bundle_url: string;
  deps_hash?: string;
  config?: Record<string, unknown>;
}

export interface MetricBatch {
  run_id: string;
  metrics: Array<{
    step: number;
    values: Record<string, number>;
  }>;
}

export interface RunDetail {
  id: string;
  experiment_id: string;
  project: string;
  status: RunStatus;
  config?: Record<string, unknown>;
  entrypoint: string;
  git_branch?: string;
  git_commit?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error_message?: string;
  exit_code?: number;
  metrics: Record<string, { value: number; step: number }>;
}

export interface SdkInitRequest {
  project: string;
  config?: Record<string, unknown>;
}

export interface SdkLogRequest {
  run_id: string;
  metrics: Record<string, number>;
  step: number;
}

export interface SdkFinishRequest {
  run_id: string;
  status: string;
}
