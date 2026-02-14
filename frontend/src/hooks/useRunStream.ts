import { useState, useEffect, useRef } from 'react';
import { getToken } from '../lib/api';

interface MetricPoint {
  step: number;
  metric_name: string;
  metric_value: number;
}

interface RunStreamState {
  metrics: MetricPoint[];
  status: string;
  connected: boolean;
}

export function useRunStream(runId: string, active: boolean) {
  const [state, setState] = useState<RunStreamState>({
    metrics: [],
    status: 'unknown',
    connected: false,
  });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!active || !runId) return;

    const token = getToken();
    const url = `/api/runs/${runId}/stream?token=${token}`;

    function connect() {
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        setState((prev) => ({ ...prev, connected: true }));
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'metrics' && data.data) {
            setState((prev) => ({
              ...prev,
              metrics: [...prev.metrics, ...data.data],
              status: data.state,
            }));
          } else if (data.type === 'done') {
            setState((prev) => ({ ...prev, status: data.state, connected: false }));
            es.close();
          } else if (data.type === 'heartbeat') {
            setState((prev) => ({ ...prev, status: data.state }));
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        es.close();
        setState((prev) => ({ ...prev, connected: false }));
        // Auto-reconnect after 3s
        setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      esRef.current?.close();
    };
  }, [runId, active]);

  return state;
}
