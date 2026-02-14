import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import authRoutes from './routes/auth';
import agentRoutes from './routes/agent';
import apiRoutes from './routes/api';
import sdkRoutes from './routes/sdk';

export { InstanceOrchestrator } from './do/instance-orchestrator';
export { ExperimentRun } from './do/experiment-run';

export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  INSTANCE_ORCHESTRATOR: DurableObjectNamespace;
  EXPERIMENT_RUN: DurableObjectNamespace;
  API_TOKEN: string;
  TOTP_SECRET: string;
  JWT_SECRET: string;
  HYPERSTACK_API_KEY: string;
  HYPERSTACK_VM_ID: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.route('/auth', authRoutes);
app.route('/agent', agentRoutes);
app.route('/api', apiRoutes);
app.route('/sdk', sdkRoutes);

export default app;
