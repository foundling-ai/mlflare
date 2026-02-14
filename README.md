# MLflare

**The experiment platform for people who rent GPUs.**

MLflare manages the full lifecycle of ML experiments on rented GPU infrastructure: submit experiment from laptop, GPU wakes, code runs, metrics stream back, GPU sleeps.

Built on Cloudflare Workers, Durable Objects, R2, and D1. Near-zero backend cost.

---

## Architecture

```
┌──────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│   Your       │     │   Cloudflare Edge    │     │   GPU Instance   │
│   Laptop     │     │                      │     │   (Hyperstack)   │
│              │     │  Worker (Hono)       │     │                  │
│  mlflare CLI ├────►│  ├─ /auth  (TOTP)    │     │  mlflare-agent   │
│  Python SDK  │     │  ├─ /api   (JWT)     │◄───►│  (Go binary)     │
│  PWA         │     │  ├─ /agent (Bearer)  │     │                  │
│              │     │  └─ /sdk   (Bearer)  │     │  Python subprocess│
└──────────────┘     │                      │     └──────────────────┘
                     │  Durable Objects     │
                     │  ├─ InstanceOrchestrator (queue, state machine)
                     │  └─ ExperimentRun    (per-run metrics)
                     │                      │
                     │  D1 (SQLite)         │
                     │  R2 (bundles)        │
                     └──────────────────────┘
```

**Components:**
- **CLI** (`mlflare`) — bundle code, submit experiments, tail logs, check status
- **Agent** (`mlflare-agent`) — runs on GPU, checks in for work, executes experiments, streams metrics
- **Worker** — Hono API, auth, orchestration, Hyperstack integration
- **PWA** — TOTP login, dashboard, live run detail
- **Python SDK** — zero-dependency `init()`/`log()`/`finish()`, wandb-compatible API

---

## Prerequisites

| Tool | Version | Used for |
|------|---------|----------|
| Node.js | 20+ | Worker + PWA |
| pnpm | 10+ | JS package management |
| Go | 1.23+ | CLI + Agent |
| Python | 3.9+ | SDK (optional) |

---

## Local Development

Everything runs on your machine. No Cloudflare account, no Hyperstack, no GPU needed.

### 1. Install dependencies

```bash
git clone https://github.com/foundling-ai/mlflare.git
cd mlflare
pnpm install
```

### 2. Build the frontend

```bash
cd frontend && pnpm build && cd ..
```

### 3. Initialize the local D1 database

```bash
cd backend
npx wrangler d1 execute mlflare-db --local --file=migrations/0001_initial.sql
```

### 4. Start the Worker

```bash
cd backend
pnpm dev
```

This starts wrangler dev at `http://localhost:8787` with:
- Local D1 database
- Local R2 storage
- Local Durable Objects
- Dev secrets from `.dev.vars` (auto-created during setup)
- `ENVIRONMENT=development` — skips all Hyperstack API calls

Verify: `curl http://localhost:8787/health` should return `{"status":"ok"}`.

### 5. Build and run the agent

In a second terminal:

```bash
go build -o mlflare-agent ./cmd/agent

MLFLARE_WORKER_URL=http://localhost:8787 \
MLFLARE_API_TOKEN=dev-token-for-testing \
./mlflare-agent
```

The agent will poll the Worker for assignments every 10 seconds. In dev mode the Worker skips Hyperstack wake/hibernate — the instance is treated as always "running".

### 6. Build the CLI and submit an experiment

In a third terminal:

```bash
go build -o mlflare ./cmd/cli
```

Create a test training script:

```bash
mkdir /tmp/test-experiment
cat > /tmp/test-experiment/train.py << 'PYEOF'
from mlflare.stdout import log_metrics
import time

for i in range(20):
    loss = 1.0 / (i + 1)
    accuracy = 1.0 - loss
    log_metrics(loss=loss, accuracy=accuracy)
    time.sleep(0.5)

print("Training complete!")
PYEOF
```

Submit it:

```bash
./mlflare run \
  --dir /tmp/test-experiment \
  --entrypoint train.py \
  --project my-first-experiment \
  --worker-url http://localhost:8787 \
  --api-token dev-token-for-testing
```

The agent (terminal 2) will pick up the assignment, download the bundle, run `train.py`, parse the `__mlflare__` JSON metric lines from stdout, and stream them back to the Worker.

### 7. Monitor the run

**CLI:**

```bash
# Check status
./mlflare status --worker-url http://localhost:8787 --api-token dev-token-for-testing

# Stream live metrics
./mlflare logs <run_id> --worker-url http://localhost:8787 --api-token dev-token-for-testing
```

**PWA:**

Open `http://localhost:8787/login`. The dev TOTP secret is `JBSWY3DPEHPK3PXP` — add it to any authenticator app (Google Authenticator, 1Password, Authy) to generate 6-digit codes. After login you'll see the dashboard with instance state, active run, and queue.

**Frontend dev server** (hot reload):

```bash
cd frontend && pnpm dev
# http://localhost:5173 — proxies API calls to :8787
```

### 8. Use the Python SDK (standalone, no agent)

The SDK works independently of the agent — useful for Colab, SLURM, local GPU, etc.

```bash
cd sdk
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

```python
import mlflare

run = mlflare.init(
    project="sdk-test",
    config={"lr": 3e-4, "batch_size": 64},
    url="http://localhost:8787",
    token="dev-token-for-testing",
)

for i in range(10):
    run.log({"loss": 1.0 / (i + 1), "accuracy": i / 10})

run.finish()
```

Or use the context manager:

```python
with mlflare.init(project="sdk-test", url="http://localhost:8787", token="dev-token-for-testing") as run:
    run.log({"loss": 0.5})
    # auto-finishes on exit, marks "failed" if exception
```

Run the SDK tests:

```bash
.venv/bin/python -m pytest tests/ -v
```

### Dev secrets reference

The file `backend/.dev.vars` contains hardcoded dev secrets:

| Variable | Dev Value | Purpose |
|----------|-----------|---------|
| `API_TOKEN` | `dev-token-for-testing` | Agent + SDK auth |
| `TOTP_SECRET` | `JBSWY3DPEHPK3PXP` | PWA login codes |
| `JWT_SECRET` | `dev-jwt-secret-32-chars-minimum!!` | JWT signing |
| `HYPERSTACK_API_KEY` | `not-needed-for-local` | Skipped in dev |
| `HYPERSTACK_VM_ID` | `not-needed-for-local` | Skipped in dev |
| `ENVIRONMENT` | `development` | Disables Hyperstack calls |

---

## Production Deployment

Production requires a Cloudflare account and a Hyperstack (or similar) GPU instance.

### 1. Set up Cloudflare resources

```bash
# Login to Cloudflare
cd backend
npx wrangler login

# Create D1 database
npx wrangler d1 create mlflare-db
# Note the database_id from the output
```

Update `backend/wrangler.jsonc` — replace `"database_id": "local"` with the real ID:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "mlflare-db",
    "database_id": "<your-database-id>"
  }
]
```

```bash
# Create R2 bucket
npx wrangler r2 bucket create mlflare-storage

# Run D1 migration
npx wrangler d1 execute mlflare-db --remote --file=migrations/0001_initial.sql
```

### 2. Generate secrets

```bash
# Generate API token (used by agent + SDK + CLI)
openssl rand -base64 32

# Generate JWT signing secret
openssl rand -base64 32

# Generate TOTP secret — use any TOTP tool, or:
# python3 -c "import secrets, base64; print(base64.b32encode(secrets.token_bytes(20)).decode())"
# Add the secret to your authenticator app
```

### 3. Set Worker secrets

```bash
npx wrangler secret put API_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put TOTP_SECRET
npx wrangler secret put HYPERSTACK_API_KEY
npx wrangler secret put HYPERSTACK_VM_ID
```

Set `ENVIRONMENT` to `production`:

```bash
echo "production" | npx wrangler secret put ENVIRONMENT
```

### 4. Deploy

```bash
# Build frontend
cd frontend && pnpm build && cd ..

# Deploy Worker (serves both API and PWA static assets)
cd backend && npx wrangler deploy
```

The Worker URL will be `https://mlflare.<your-subdomain>.workers.dev`.

### 5. Create R2 API credentials (for CLI bundle uploads)

In the Cloudflare dashboard:
1. Go to **R2 > Manage R2 API Tokens**
2. Create a token with read/write access to the `mlflare-storage` bucket
3. Note the Access Key ID and Secret Access Key

### 6. Set up local CLI config

Create `~/.mlflare/config.yaml`:

```yaml
worker_url: https://mlflare.<your-subdomain>.workers.dev
api_token: <your-API_TOKEN>
account_id: <your-cloudflare-account-id>
r2_access_key_id: <your-r2-key-id>
r2_secret_access_key: <your-r2-secret-key>
r2_bucket: mlflare-storage
```

Build the CLI:

```bash
go build -o mlflare ./cmd/cli
# Move to PATH: sudo mv mlflare /usr/local/bin/
```

Test it:

```bash
mlflare status
```

### 7. Set up Hyperstack GPU instance

1. Create a Hyperstack account and provision a VM (A6000, H100, etc.)
2. Hibernate the VM to stop billing — it will be woken automatically when experiments are submitted
3. Note your Hyperstack API key and VM ID (set as Worker secrets in step 3)

### 8. Install the agent on the GPU

Build the agent for Linux:

```bash
GOOS=linux GOARCH=amd64 go build -o mlflare-agent ./cmd/agent
```

Copy to the GPU instance:

```bash
scp mlflare-agent <gpu-ip>:/usr/local/bin/
scp configs/mlflare-agent.service <gpu-ip>:/tmp/
```

On the GPU instance:

```bash
# Create agent config
sudo mkdir -p /etc/mlflare
sudo tee /etc/mlflare/agent.yaml << EOF
worker_url: https://mlflare.<your-subdomain>.workers.dev
api_token: <your-API_TOKEN>
work_dir: /home/ubuntu/mlflare-workspace
python_bin: python3
EOF

# Install systemd service
sudo mv /tmp/mlflare-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mlflare-agent
sudo systemctl start mlflare-agent

# Check it's running
sudo journalctl -u mlflare-agent -f
```

The agent starts on boot, survives hibernation/restore cycles, and auto-reconnects.

### 9. Submit your first production experiment

```bash
mlflare run \
  --dir ./my-training-code \
  --entrypoint train.py \
  --project my-project
```

This will:
1. Bundle your code into a tar.gz
2. Upload to R2 via the Worker
3. Submit the experiment to the queue
4. The Worker wakes the Hyperstack VM
5. The agent picks up the assignment
6. Your code runs on the GPU
7. Metrics stream back in real-time
8. When the queue empties, the VM hibernates after a 5-minute cooldown

Monitor from your phone at `https://mlflare.<your-subdomain>.workers.dev`.

---

## Python SDK

Install from the repo (PyPI publish pending):

```bash
pip install -e ./sdk
```

### API

```python
import mlflare

# Initialize a run
run = mlflare.init(
    project="my-project",
    config={"lr": 3e-4, "epochs": 100},
    url="https://mlflare.example.workers.dev",  # or MLFLARE_URL env var
    token="your-api-token",                      # or MLFLARE_API_TOKEN env var
)

# Log metrics (auto-incrementing step)
run.log({"loss": 0.5, "accuracy": 0.8})
run.log({"loss": 0.3, "accuracy": 0.9})

# Or with explicit step
run.log({"loss": 0.1}, step=100)

# Finish the run
run.finish()
```

### Context manager

```python
with mlflare.init(project="my-project") as run:
    for epoch in range(100):
        loss = train_one_epoch()
        run.log({"loss": loss, "epoch": epoch})
    # auto-finishes; marks "failed" if an exception is raised
```

### Module-level convenience

```python
import mlflare

mlflare.init(project="quick-test")
mlflare.log({"loss": 0.5})
mlflare.finish()
```

### Stdout mode (zero-import, agent-parsed)

For scripts where you don't want to import the SDK:

```python
from mlflare.stdout import log_metrics

log_metrics(loss=0.5, accuracy=0.8)
# Emits: {"__mlflare__": {"loss": 0.5, "accuracy": 0.8}}
# The agent parses this from stdout automatically
```

Or manually (no mlflare dependency at all):

```python
import json
print(json.dumps({"__mlflare__": {"loss": 0.5}}), flush=True)
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `MLFLARE_URL` | Worker URL (fallback for `url=` param) |
| `MLFLARE_API_TOKEN` | API token (fallback for `token=` param) |

---

## Project Structure

```
mlflare/
├── cmd/
│   ├── agent/main.go              # Agent binary entry point
│   └── cli/main.go                # CLI binary entry point
├── internal/
│   ├── agent/                     # Agent: main loop, bundle, subprocess, heartbeat, batcher
│   ├── api/                       # Shared HTTP client (agent + CLI)
│   ├── auth/                      # TOTP generation, QR display
│   ├── bundle/                    # (placeholder)
│   ├── cli/                       # Cobra commands: init, run, logs, status
│   ├── cloudflare/                # cloudflare-go wrapper for R2/D1
│   ├── config/                    # Agent config (Viper)
│   ├── hyperstack/                # (placeholder)
│   ├── provision/                 # Config save/load, secret generation
│   └── r2/                        # AWS SDK v2 S3-compatible R2 client
├── embedded/
│   ├── embed.go                   # go:embed directives
│   ├── worker/                    # Compiled Worker (build artifact)
│   ├── pwa/                       # Compiled PWA (build artifact)
│   └── migrations/                # D1 SQL migrations
├── backend/
│   ├── src/
│   │   ├── index.ts               # Hono app, route mounting, DO exports
│   │   ├── types.ts               # Shared TypeScript types
│   │   ├── do/
│   │   │   ├── instance-orchestrator.ts  # State machine, queue, alarms
│   │   │   └── experiment-run.ts         # Per-run metrics, logs
│   │   ├── routes/
│   │   │   ├── auth.ts            # POST /auth/totp
│   │   │   ├── agent.ts           # /agent/* (checkin, heartbeat, metrics, completed, failed)
│   │   │   ├── api.ts             # /api/* (experiments, runs, status, instance control)
│   │   │   └── sdk.ts             # /sdk/* (init, log, finish)
│   │   ├── middleware/
│   │   │   └── auth.ts            # agentAuth, jwtAuth, sdkAuth
│   │   └── lib/
│   │       ├── jwt.ts             # HS256 JWT via Web Crypto
│   │       ├── totp.ts            # RFC 6238 TOTP validation
│   │       ├── ulid.ts            # ULID generator
│   │       └── hyperstack.ts      # Hyperstack API client
│   ├── migrations/
│   │   └── 0001_initial.sql       # D1 schema
│   ├── wrangler.jsonc             # Worker config
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.tsx                # React Router: /login, /, /runs/:id
│   │   ├── main.tsx               # Entry point
│   │   ├── index.css              # Tailwind v4
│   │   ├── pages/
│   │   │   ├── Login.tsx          # TOTP 6-digit input
│   │   │   ├── Dashboard.tsx      # Instance status, queue, recent runs
│   │   │   └── RunDetail.tsx      # Run info, config, live metrics
│   │   ├── hooks/
│   │   │   ├── useStatus.ts       # Polling hook (10s interval)
│   │   │   └── useRunStream.ts    # SSE hook with auto-reconnect
│   │   └── lib/
│   │       └── api.ts             # Fetch wrapper, JWT management
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── sdk/
│   ├── mlflare/
│   │   ├── __init__.py            # init(), log(), finish()
│   │   ├── _client.py             # HTTP client (urllib, zero deps)
│   │   ├── _run.py                # Run class, context manager, atexit
│   │   └── stdout.py              # log_metrics() for agent parsing
│   ├── tests/
│   │   ├── test_run.py
│   │   └── test_stdout.py
│   └── pyproject.toml
├── configs/
│   └── mlflare-agent.service      # systemd unit file
├── go.mod
├── go.sum
├── pnpm-workspace.yaml
└── package.json
```

---

## API Routes

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/totp` | none | Validate TOTP code, return JWT |

### Agent (Bearer token)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/agent/checkin` | Check in, receive assignment |
| POST | `/agent/heartbeat` | Keep-alive signal |
| POST | `/agent/metrics` | Batch metric upload |
| POST | `/agent/completed` | Report run success |
| POST | `/agent/failed` | Report run failure |
| GET | `/agent/bundle/:key` | Download bundle from R2 |

### API (JWT)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/experiments` | Submit new experiment |
| GET | `/api/experiments` | List experiments |
| GET | `/api/runs/:id` | Get run detail |
| GET | `/api/runs/:id/stream` | SSE live metrics |
| GET | `/api/status` | Instance + queue status |
| PUT | `/api/bundle/:key` | Upload bundle to R2 |
| POST | `/api/instance/wake` | Force wake GPU |
| POST | `/api/instance/hibernate` | Force hibernate GPU |

### SDK (Bearer token)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/sdk/init` | Start a new run |
| POST | `/sdk/log` | Log metrics |
| POST | `/sdk/finish` | End a run |

---

## Instance State Machine

```
idle ──► waking ──► running ──► cooldown ──► hibernating ──► idle
                      │                          ▲
                      │    (queue empty, 5min)    │
                      ▼                          │
                 (run completes) ────────────────┘
                      │
                 (queue has more) ──► running (next run)
```

In dev mode (`ENVIRONMENT=development`), transitions between idle/waking/hibernating are instant — no Hyperstack API calls.

---

## Build Pipeline

Full build from source to binaries:

```bash
# Frontend
cd frontend && pnpm build && cd ..

# Backend type-check
cd backend && pnpm exec tsc --noEmit && cd ..

# SDK tests
cd sdk && .venv/bin/python -m pytest tests/ -v && cd ..

# Go binaries
go build -o mlflare ./cmd/cli
go build -o mlflare-agent ./cmd/agent

# Cross-compile agent for GPU (Linux)
GOOS=linux GOARCH=amd64 go build -o mlflare-agent-linux ./cmd/agent
```

---

## License

MIT
