import { Hono } from 'hono';
import type { Env } from '../index';
import { jwtAuth } from '../middleware/auth';
import { ulid } from '../lib/ulid';
import type { InstanceOrchestrator } from '../do/instance-orchestrator';
import type { ExperimentRun } from '../do/experiment-run';
import type { ExperimentSubmission } from '../types';

const api = new Hono<{ Bindings: Env }>();

api.use('*', jwtAuth);

/** Submit a new experiment. */
api.post('/experiments', async (c) => {
  const body = await c.req.json<ExperimentSubmission>();
  const experimentId = ulid();
  const runId = ulid();

  // Insert into D1
  await c.env.DB.prepare(
    `INSERT INTO experiments (id, project, entrypoint, config, git_branch, git_commit, git_dirty, deps_hash, bundle_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      experimentId,
      body.project,
      body.entrypoint,
      body.config ? JSON.stringify(body.config) : null,
      body.git_branch ?? null,
      body.git_commit ?? null,
      body.git_dirty ? 1 : 0,
      body.deps_hash ?? null,
      body.bundle_key,
    )
    .run();

  await c.env.DB.prepare(
    'INSERT INTO runs (id, experiment_id, status) VALUES (?, ?, ?)',
  )
    .bind(runId, experimentId, 'queued')
    .run();

  // Initialize ExperimentRun DO
  const runDoId = c.env.EXPERIMENT_RUN.idFromName(runId);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;
  await runStub.initialize({
    run_id: runId,
    experiment_id: experimentId,
    project: body.project,
    entrypoint: body.entrypoint,
    config: body.config,
    git_branch: body.git_branch,
    git_commit: body.git_commit,
  });

  // Enqueue in orchestrator
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  const { position } = await orchStub.enqueue({
    run_id: runId,
    experiment_id: experimentId,
    entrypoint: body.entrypoint,
    bundle_key: body.bundle_key,
    deps_hash: body.deps_hash,
    config: body.config,
  });

  return c.json({ experiment_id: experimentId, run_id: runId, queue_position: position }, 201);
});

/** List experiments. */
api.get('/experiments', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT e.*, r.id as run_id, r.status as run_status, r.created_at as run_created_at
     FROM experiments e
     LEFT JOIN runs r ON r.experiment_id = e.id
     ORDER BY e.created_at DESC
     LIMIT 50`,
  ).all();

  return c.json({ experiments: result.results });
});

/** Get run detail. */
api.get('/runs/:id', async (c) => {
  const id = c.req.param('id');
  const runDoId = c.env.EXPERIMENT_RUN.idFromName(id);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;
  const state = await runStub.getState();
  return c.json(state);
});

/** SSE stream for run metrics. */
api.get('/runs/:id/stream', async (c) => {
  const id = c.req.param('id');
  const runDoId = c.env.EXPERIMENT_RUN.idFromName(id);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: unknown) => {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  c.executionCtx.waitUntil(
    (async () => {
      try {
        let lastMetricId = 0;
        for (let i = 0; i < 300; i++) {
          // ~10 min max
          const state = await runStub.getState();
          const newMetrics = await runStub.getMetrics(undefined, lastMetricId);

          if (newMetrics.length > 0) {
            lastMetricId = Math.max(...newMetrics.map((m) => (m as unknown as { id: number }).id ?? lastMetricId));
            send({ type: 'metrics', data: newMetrics, state: state.status });
          } else {
            send({ type: 'heartbeat', state: state.status });
          }

          if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
            send({ type: 'done', state: state.status });
            break;
          }

          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e) {
        console.error('SSE error:', e);
      } finally {
        writer.close();
      }
    })(),
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

/** Get system status. */
api.get('/status', async (c) => {
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  const status = await orchStub.getStatus();

  // Get recent runs from D1
  const recentRuns = await c.env.DB.prepare(
    `SELECT r.id, r.status, r.created_at, r.started_at, r.completed_at,
            e.project, e.entrypoint
     FROM runs r JOIN experiments e ON r.experiment_id = e.id
     ORDER BY r.created_at DESC LIMIT 10`,
  ).all();

  return c.json({
    instance: status,
    recent_runs: recentRuns.results,
  });
});

/** Force wake instance. */
api.post('/instance/wake', async (c) => {
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  await orchStub.forceWake();
  return c.json({ ok: true });
});

/** Force hibernate instance. */
api.post('/instance/hibernate', async (c) => {
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  await orchStub.forceHibernate();
  return c.json({ ok: true });
});

export default api;
