import { Hono } from 'hono';
import type { Env } from '../index';
import { sdkAuth } from '../middleware/auth';
import { ulid } from '../lib/ulid';
import type { ExperimentRun } from '../do/experiment-run';
import type { InstanceOrchestrator } from '../do/instance-orchestrator';
import type { SdkInitRequest, SdkLogRequest, SdkFinishRequest, ExperimentSubmission } from '../types';

const sdk = new Hono<{ Bindings: Env }>();

sdk.use('*', sdkAuth);

/** Initialize a new SDK run (no bundle — used for standalone logging). */
sdk.post('/init', async (c) => {
  const body = await c.req.json<SdkInitRequest>();
  const experimentId = ulid();
  const runId = ulid();

  // Insert experiment + run into D1
  await c.env.DB.prepare(
    `INSERT INTO experiments (id, project, entrypoint, config, bundle_key)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      experimentId,
      body.project,
      'sdk',
      body.config ? JSON.stringify(body.config) : null,
      'sdk-direct',
    )
    .run();

  await c.env.DB.prepare(
    `INSERT INTO runs (id, experiment_id, status, started_at)
     VALUES (?, ?, ?, datetime(?))`,
  )
    .bind(runId, experimentId, 'running', new Date().toISOString())
    .run();

  // Initialize DO
  const runDoId = c.env.EXPERIMENT_RUN.idFromName(runId);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;
  await runStub.initialize({
    run_id: runId,
    experiment_id: experimentId,
    project: body.project,
    entrypoint: 'sdk',
    config: body.config,
  });
  await runStub.markRunning();

  // Save params in D1
  if (body.config) {
    c.executionCtx.waitUntil(
      (async () => {
        for (const [name, value] of Object.entries(body.config!)) {
          await c.env.DB.prepare(
            'INSERT INTO run_params (run_id, param_name, param_value) VALUES (?, ?, ?)',
          )
            .bind(runId, name, String(value))
            .run();
        }
      })(),
    );
  }

  return c.json({ run_id: runId, experiment_id: experimentId });
});

/** Log metrics from SDK. */
sdk.post('/log', async (c) => {
  const body = await c.req.json<SdkLogRequest>();

  const runDoId = c.env.EXPERIMENT_RUN.idFromName(body.run_id);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;
  await runStub.appendMetrics([{ step: body.step, values: body.metrics }]);

  // Persist to D1 in background
  c.executionCtx.waitUntil(
    (async () => {
      for (const [name, value] of Object.entries(body.metrics)) {
        await c.env.DB.prepare(
          'INSERT INTO run_metrics (run_id, step, metric_name, metric_value) VALUES (?, ?, ?, ?)',
        )
          .bind(body.run_id, body.step, name, value)
          .run();
      }
    })(),
  );

  return c.json({ ok: true });
});

/** Finish SDK run. */
sdk.post('/finish', async (c) => {
  const body = await c.req.json<SdkFinishRequest>();

  const runDoId = c.env.EXPERIMENT_RUN.idFromName(body.run_id);
  const runStub = c.env.EXPERIMENT_RUN.get(runDoId) as unknown as ExperimentRun;

  if (body.status === 'failed') {
    await runStub.markFailed('SDK reported failure');
  } else {
    await runStub.markCompleted();
  }

  // Update D1
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'UPDATE runs SET status = ?, completed_at = datetime(?) WHERE id = ?',
    )
      .bind(body.status === 'failed' ? 'failed' : 'completed', new Date().toISOString(), body.run_id)
      .run(),
  );

  return c.json({ ok: true });
});

/** Submit experiment (CLI uses API token, not JWT). */
sdk.post('/experiments', async (c) => {
  const body = await c.req.json<ExperimentSubmission>();
  const experimentId = ulid();
  const runId = ulid();

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

/** Get system status (CLI uses API token, not JWT). */
sdk.get('/status', async (c) => {
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  const status = await orchStub.getStatus();

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

/** Upload bundle to R2 via Worker. */
sdk.put('/bundle/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.arrayBuffer();
  await c.env.R2.put(key, body);
  return c.json({ key });
});

export default sdk;
