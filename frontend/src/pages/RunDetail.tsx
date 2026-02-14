import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useRunStream } from '../hooks/useRunStream';

interface RunState {
  run_id: string;
  experiment_id: string;
  project: string;
  status: string;
  entrypoint: string;
  config: Record<string, unknown> | null;
  git_branch: string | null;
  git_commit: string | null;
  error_message: string | null;
  exit_code: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  metrics: Record<string, { value: number; step: number; min: number; max: number; count: number }>;
}

export default function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunState | null>(null);
  const [error, setError] = useState('');
  const isActive = run?.status === 'running' || run?.status === 'queued';
  const stream = useRunStream(id!, isActive);

  useEffect(() => {
    if (!id) return;
    apiFetch<RunState>(`/api/runs/${id}`)
      .then(setRun)
      .catch((e) => setError(e.message));
  }, [id]);

  // Merge stream metrics into run state
  const allMetrics = { ...run?.metrics };
  for (const m of stream.metrics) {
    const existing = allMetrics[m.metric_name];
    if (!existing || m.step > existing.step) {
      allMetrics[m.metric_name] = {
        value: m.metric_value,
        step: m.step,
        min: existing ? Math.min(existing.min, m.metric_value) : m.metric_value,
        max: existing ? Math.max(existing.max, m.metric_value) : m.metric_value,
        count: existing ? existing.count + 1 : 1,
      };
    }
  }

  const displayStatus = stream.status !== 'unknown' ? stream.status : run?.status ?? 'unknown';

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 max-w-4xl mx-auto">
      <a href="/" className="text-gray-400 hover:text-white text-sm mb-4 inline-block">&larr; Dashboard</a>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-bold">{run.project}</h1>
        <StatusBadge status={displayStatus} />
        {stream.connected && (
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Live" />
        )}
      </div>

      {/* Info Grid */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
          <Info label="Run ID" value={run.run_id} mono />
          <Info label="Entrypoint" value={run.entrypoint} />
          <Info label="Created" value={run.created_at} />
          <Info label="Started" value={run.started_at} />
          <Info label="Completed" value={run.completed_at} />
          <Info label="Exit Code" value={run.exit_code?.toString()} />
          {run.git_branch && <Info label="Branch" value={run.git_branch} />}
          {run.git_commit && <Info label="Commit" value={run.git_commit.slice(0, 8)} mono />}
        </div>
      </div>

      {/* Error */}
      {run.error_message && (
        <div className="bg-red-900/20 border border-red-800 rounded-lg p-4 mb-6">
          <p className="text-red-400 text-sm font-mono">{run.error_message}</p>
        </div>
      )}

      {/* Config */}
      {run.config && Object.keys(run.config).length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">Config</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {Object.entries(run.config).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 border-b border-gray-800">
                <span className="text-gray-400">{k}</span>
                <span className="text-white font-mono">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Metrics */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Metrics</h2>
        {Object.keys(allMetrics).length === 0 ? (
          <p className="text-gray-500">No metrics logged yet</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {Object.entries(allMetrics).map(([name, m]) => (
              <div key={name} className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-400 text-xs mb-1">{name}</p>
                <p className="text-2xl font-bold text-white">{m.value.toFixed(4)}</p>
                <div className="flex gap-3 mt-2 text-xs text-gray-500">
                  <span>step {m.step}</span>
                  <span>min {m.min.toFixed(4)}</span>
                  <span>max {m.max.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    queued: 'bg-yellow-500/20 text-yellow-400',
    running: 'bg-green-500/20 text-green-400',
    completed: 'bg-blue-500/20 text-blue-400',
    failed: 'bg-red-500/20 text-red-400',
    cancelled: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`text-xs px-2 py-1 rounded-full ${colors[status] ?? 'bg-gray-700 text-gray-300'}`}>
      {status}
    </span>
  );
}

function Info({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-gray-500 text-xs">{label}</p>
      <p className={`text-white ${mono ? 'font-mono' : ''}`}>{value ?? <span className="text-gray-600">-</span>}</p>
    </div>
  );
}
