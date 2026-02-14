import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';

interface InstanceStatus {
  instance_state: string;
  current_run_id: string | null;
  queue_depth: number;
  agent_last_seen: string | null;
  queue: Array<{ run_id: string; experiment_id: string; queued_at: string }>;
}

interface RecentRun {
  id: string;
  status: string;
  project: string;
  entrypoint: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface StatusData {
  instance: InstanceStatus;
  recent_runs: RecentRun[];
}

export function useStatus(intervalMs = 10000) {
  const [data, setData] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await apiFetch<StatusData>('/api/status');
      setData(result);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
