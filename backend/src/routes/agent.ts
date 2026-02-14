import { Hono } from 'hono';
import type { Env } from '../index';
import { agentAuth } from '../middleware/auth';
import type { InstanceOrchestrator } from '../do/instance-orchestrator';
import type { ExperimentRun } from '../do/experiment-run';
import type { MetricBatch } from '../types';

const agent = new Hono<{ Bindings: Env }>();

agent.use('*', agentAuth);

/** Agent checks in for work. */
agent.post('/checkin', async (c) => {
  const body = await c.req.json<{ agent_version: string; hostname: string }>();
  const id = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const stub = c.env.INSTANCE_ORCHESTRATOR.get(id) as unknown as InstanceOrchestrator;
  const assignment = await stub.agentCheckin(body);

  if (assignment) {
    // Mark the run as running in its DO
    const runId = c.env.EXPERIMENT_RUN.idFromName(assignment.run_id);
    const runStub = c.env.EXPERIMENT_RUN.get(runId) as unknown as ExperimentRun;
    await runStub.markRunning();

    // Update D1 as well
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE runs SET status = ?, started_at = datetime(?) WHERE id = ?')
        .bind('running', new Date().toISOString(), assignment.run_id)
        .run(),
    );
  }

  return c.json({ assignment });
});

/** Agent heartbeat. */
agent.post('/heartbeat', async (c) => {
  const id = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const stub = c.env.INSTANCE_ORCHESTRATOR.get(id) as unknown as InstanceOrchestrator;
  await stub.heartbeat();
  return c.json({ ok: true });
});

/** Agent reports metrics. */
agent.post('/metrics', async (c) => {
  const body = await c.req.json<MetricBatch>();
  const runId = c.env.EXPERIMENT_RUN.idFromName(body.run_id);
  const runStub = c.env.EXPERIMENT_RUN.get(runId) as unknown as ExperimentRun;

  // Send to DO synchronously
  await runStub.appendMetrics(body.metrics);

  // Persist to D1 in background
  c.executionCtx.waitUntil(
    (async () => {
      for (const batch of body.metrics) {
        for (const [name, value] of Object.entries(batch.values)) {
          await c.env.DB.prepare(
            'INSERT INTO run_metrics (run_id, step, metric_name, metric_value) VALUES (?, ?, ?, ?)',
          )
            .bind(body.run_id, batch.step, name, value)
            .run();
        }
      }
    })(),
  );

  return c.json({ ok: true });
});

/** Agent reports run completed. */
agent.post('/completed', async (c) => {
  const body = await c.req.json<{ run_id: string; exit_code?: number }>();

  // Update DO
  const runId = c.env.EXPERIMENT_RUN.idFromName(body.run_id);
  const runStub = c.env.EXPERIMENT_RUN.get(runId) as unknown as ExperimentRun;
  await runStub.markCompleted(body.exit_code);

  // Update orchestrator
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  await orchStub.runCompleted(body.run_id);

  // Update D1
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'UPDATE runs SET status = ?, completed_at = datetime(?), exit_code = ? WHERE id = ?',
    )
      .bind('completed', new Date().toISOString(), body.exit_code ?? 0, body.run_id)
      .run(),
  );

  return c.json({ ok: true });
});

/** Agent reports run failed. */
agent.post('/failed', async (c) => {
  const body = await c.req.json<{ run_id: string; error: string; exit_code?: number }>();

  // Update DO
  const runId = c.env.EXPERIMENT_RUN.idFromName(body.run_id);
  const runStub = c.env.EXPERIMENT_RUN.get(runId) as unknown as ExperimentRun;
  await runStub.markFailed(body.error, body.exit_code);

  // Update orchestrator
  const orchId = c.env.INSTANCE_ORCHESTRATOR.idFromName('singleton');
  const orchStub = c.env.INSTANCE_ORCHESTRATOR.get(orchId) as unknown as InstanceOrchestrator;
  await orchStub.runFailed(body.run_id, body.error);

  // Update D1
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'UPDATE runs SET status = ?, completed_at = datetime(?), error_message = ?, exit_code = ? WHERE id = ?',
    )
      .bind('failed', new Date().toISOString(), body.error, body.exit_code ?? 1, body.run_id)
      .run(),
  );

  return c.json({ ok: true });
});

/** Serve bundle from R2 (dev mode). */
agent.get('/bundle/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const object = await c.env.R2.get(key);
  if (!object) {
    return c.json({ error: 'Bundle not found' }, 404);
  }
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/gzip' },
  });
});

export default agent;
