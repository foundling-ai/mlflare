import { useNavigate } from 'react-router-dom';
import { useStatus } from '../hooks/useStatus';

const stateColors: Record<string, string> = {
  idle: 'text-gray-400',
  waking: 'text-yellow-400',
  running: 'text-green-400',
  cooldown: 'text-blue-400',
  hibernating: 'text-purple-400',
  error: 'text-red-400',
};

const statusColors: Record<string, string> = {
  queued: 'bg-yellow-500/20 text-yellow-400',
  running: 'bg-green-500/20 text-green-400',
  completed: 'bg-blue-500/20 text-blue-400',
  failed: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
};

export default function Dashboard() {
  const { data, error } = useStatus();
  const navigate = useNavigate();

  if (error) {
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6">
        <p className="text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-950 text-white p-6">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  const { instance, recent_runs } = data;

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">MLflare</h1>

      {/* Instance Status Card */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 mb-6">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">GPU Instance</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-gray-500 text-sm">State</p>
            <p className={`text-lg font-semibold ${stateColors[instance.instance_state] ?? 'text-white'}`}>
              {instance.instance_state}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-sm">Queue Depth</p>
            <p className="text-lg font-semibold text-white">{instance.queue_depth}</p>
          </div>
          <div>
            <p className="text-gray-500 text-sm">Current Run</p>
            <p className="text-sm font-mono text-white">
              {instance.current_run_id ? (
                <button
                  onClick={() => navigate(`/runs/${instance.current_run_id}`)}
                  className="text-orange-400 hover:underline"
                >
                  {instance.current_run_id.slice(0, 12)}...
                </button>
              ) : (
                <span className="text-gray-500">-</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-sm">Agent Last Seen</p>
            <p className="text-sm text-white">
              {instance.agent_last_seen ?? <span className="text-gray-500">-</span>}
            </p>
          </div>
        </div>
      </div>

      {/* Queue */}
      {instance.queue.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 mb-6">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Queue</h2>
          {instance.queue.map((entry, i) => (
            <div key={entry.run_id} className="flex items-center gap-3 py-2 border-b border-gray-800 last:border-0">
              <span className="text-gray-500 text-sm w-6">{i + 1}</span>
              <span className="font-mono text-sm text-orange-400">{entry.run_id.slice(0, 12)}</span>
              <span className="text-gray-500 text-sm ml-auto">{entry.queued_at}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Runs */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">Recent Runs</h2>
        {recent_runs.length === 0 ? (
          <p className="text-gray-500">No runs yet</p>
        ) : (
          <div className="space-y-2">
            {recent_runs.map((run) => (
              <button
                key={run.id}
                onClick={() => navigate(`/runs/${run.id}`)}
                className="w-full flex items-center gap-3 py-3 px-3 rounded hover:bg-gray-800 transition-colors text-left"
              >
                <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[run.status] ?? ''}`}>
                  {run.status}
                </span>
                <span className="text-sm text-white">{run.project}/{run.entrypoint}</span>
                <span className="text-xs text-gray-500 ml-auto">{run.created_at}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
