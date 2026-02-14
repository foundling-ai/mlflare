# MLflare — Platform Specification

**The experiment platform for people who rent GPUs.**

Built and maintained by **Foundling AI** (`foundling-ai/mlflare`).

---

## What Is MLflare

MLflare is an open-source experiment execution platform that manages the full lifecycle of ML experiments on rented GPU infrastructure. It is not just an experiment tracker — it actively orchestrates GPU lifecycle, code delivery, experiment queuing, and result collection.

The core differentiation from MLflow, W&B, Aim, Trackio, and every other tool in this space:

- **GPU lifecycle management** — submitting an experiment wakes a hibernated GPU instance; completing the queue puts it back to sleep. Cost optimization is built into the workflow.
- **Push-to-run code delivery** — bundle your local working directory and push it directly to the GPU. No git ceremony required. Dirty working trees work fine.
- **Edge-native backend** — the entire backend runs on Cloudflare Workers, Durable Objects, R2, and D1. Globally distributed, serverless, near-zero cost.
- **Mobile-first PWA** — purpose-built for checking experiment progress from your phone. Not a desktop UI that happens to render on mobile.
- **Modular architecture** — the GPU agent, Python SDK, CLI, backend, and frontend are independent components connected by a shared API contract. The SDK works without the agent (from Colab, SLURM, local GPU, anywhere).

MLflare is NOT a local dev tool. If someone wants local-only experiment tracking, they should use MLflow. MLflare assumes remote GPU compute as the primary use case.

---

## Architecture Overview

### Three Zones

**1. GPU Instance (Hyperstack)**
- A6000 (or any GPU) that hibernates when idle, wakes on experiment submission
- `mlflare-agent` (Go binary) runs as a systemd service
- Your ML code runs as a Python subprocess managed by the agent
- Agent and ML code are fully decoupled — different repos, different languages, no shared dependencies

**2. Cloudflare Edge**
- **Worker** (TypeScript/Hono) — API router, auth middleware, Hyperstack API integration
- **Durable Object** — experiment state machine, queue, heartbeat monitoring, idle timeout alarms, cost tracking
- **R2** — code bundles, model artifacts, experiment configs, metric timeseries (S3-compatible, zero egress)
- **D1** — experiment catalog, run metadata, params/metrics index (SQLite at the edge)
- **Pages** — hosts the PWA globally

**3. Client Interfaces**
- **PWA** (React + Vite + Tailwind) — mobile-first dashboard, TOTP login, live metrics, run comparison, instance control
- **CLI** (`mlflare`, Go binary) — setup, experiment submission, log tailing, instance management
- **Python SDK** (`pip install mlflare`) — lightweight metric logging client, ~200 lines, works from anywhere

---

## Components

### mlflare CLI (Go)

Single binary installed on the developer's laptop. Shares a Go module with the agent.

**Key commands:**
```
mlflare init          # Cloudflare OAuth + Hyperstack API key + provision everything
mlflare run           # Bundle working dir, upload to R2, submit experiment, wake GPU
mlflare logs          # SSE tail of live training output
mlflare status        # Instance state, current run, queue depth
mlflare queue         # List pending experiments
mlflare cancel        # Cancel current run or drain queue
mlflare runs          # List/compare past experiments
mlflare cost          # GPU spend tracking
mlflare hibernate     # Force hibernate
mlflare wake          # Force wake
mlflare dry-run       # Validate config/bundle locally without submitting
mlflare agent install # SSH into GPU instance, install agent binary + systemd service
mlflare update        # Push updated Worker + PWA assets to Cloudflare
```

**`mlflare init` provisions everything without Wrangler:**
- Opens browser for Cloudflare OAuth (localhost redirect pattern)
- Creates R2 bucket, D1 database, runs migrations
- Deploys Worker (JS embedded in Go binary via `go:embed`)
- Deploys PWA (static assets embedded in Go binary)
- Sets Worker secrets (API token, TOTP secret)
- Prompts for Hyperstack API key
- Shows QR code for authenticator app setup
- All via direct Cloudflare REST API calls — no Node.js, no Wrangler dependency

**`mlflare run` push-to-run flow:**
- Tars working directory (respects `.gitignore` / `.experimentignore`)
- Captures git metadata if available (commit SHA, branch, dirty status, diff)
- Hashes `requirements.txt` for dep caching
- Uploads bundle to R2 (`bundles/{experiment_id}.tar.gz`)
- POSTs experiment config to Worker
- Worker queues experiment, wakes instance if hibernated

### mlflare-agent (Go)

Single static binary installed on the GPU instance. Zero Python dependencies. Cannot conflict with ML environment.

**Lifecycle:**
1. Instance wakes from hibernation, systemd starts agent
2. Agent POSTs `/agent/checkin` with instance metadata
3. Worker responds with experiment assignment (or "nothing queued")
4. Agent downloads bundle from R2, unpacks to workspace
5. Checks dep hash — conditional `pip install -r requirements.txt`
6. Spawns Python subprocess: `python <entrypoint> <args>`
7. Tails stdout/stderr, parses structured JSON metric lines
8. Streams metrics to Worker in batches (~30s interval)
9. Sends heartbeats (~2-3min interval)
10. On subprocess exit: uploads artifacts to R2, POSTs `/agent/completed` or `/agent/failed`
11. Worker responds with next assignment or "queue empty"
12. If queue empty, Worker enters cooldown → hibernates instance

**Workspace management:**
```
/home/ubuntu/workspace/
├── <project-name>/          # Unpacked bundle
└── .cache/
    ├── dep-hashes/          # Tracks installed requirements
    └── datasets/            # Cached data from R2
```

### MLflare Worker (TypeScript)

Hono-based router on Cloudflare Workers. Three route groups with different auth:

**Agent routes** (Bearer token auth):
- `POST /agent/checkin` — agent reports it's alive, gets assignment
- `POST /agent/heartbeat` — keeps DO alive, resets timeout alarm
- `POST /agent/metrics` — batch metric ingestion
- `POST /agent/completed` — run finished successfully
- `POST /agent/failed` — run crashed, includes traceback
- `GET /agent/assignment` — poll for next queued experiment

**API routes** (JWT auth, issued via TOTP):
- `POST /auth/totp` — validate 6-digit code, return JWT (24h expiry)
- `POST /api/experiments` — submit new experiment
- `GET /api/experiments` — list experiments (filterable, paginated)
- `GET /api/runs/:id` — run detail with full metrics
- `GET /api/runs/:id/stream` — SSE endpoint for live metrics
- `GET /api/status` — instance state from DO
- `POST /api/instance/wake` — force restore via Hyperstack API
- `POST /api/instance/hibernate` — force hibernate via Hyperstack API
- `GET /api/cost` — aggregated GPU spend

**SDK routes** (API token auth):
- `POST /sdk/init` — start a run (from any Python environment)
- `POST /sdk/log` — log metrics
- `POST /sdk/finish` — end run
- `POST /sdk/artifact` — upload artifact to R2

### Durable Object — Experiment Manager

Single DO instance per deployment. Manages:

**State machine:**
```
idle → waking → running → cooldown → hibernating → idle
                  ↓
               (queue has more) → running (next experiment)
```

**Responsibilities:**
- Experiment queue (FIFO)
- Instance state tracking
- Heartbeat monitoring with alarm-based dead-man's switch
- Cooldown timer (configurable, ~5-10min) before hibernation
- Cost accumulation (tracks wake/hibernate timestamps, calculates GPU hours)
- Calls Hyperstack hibernate/restore APIs

**Hyperstack API endpoints used:**
- `POST /v1/core/virtual-machines/{id}/hibernate?retain_ip=true` — hibernate
- `GET /v1/core/virtual-machines/{id}/hibernate-restore` — restore
- `GET /v1/core/virtual-machines/{id}` — check status

### MLflare PWA (React + Vite + Tailwind)

Mobile-first progressive web app. Deployed to Cloudflare Pages.

**Auth:** TOTP code → JWT session (24h). No username/password. No OAuth provider.

**Pages:**
- **Dashboard** — instance status (hibernated/running/etc), active run summary, queue depth, daily/monthly cost
- **Experiments** — searchable/filterable list of all runs, sortable by date/metrics
- **Run Detail** — live metric charts (loss curves, lr schedule, GPU util), config, git metadata, artifacts, logs
- **Compare** — side-by-side metric charts for selected runs, parameter diff highlighting
- **Submit** — experiment config form or YAML paste, saved templates

**PWA features:**
- Service worker for offline caching of past run data
- Push notifications on run completion/failure
- Installable on home screen

### Python SDK

Minimal Python package. Optional dependency in ML training code.

```python
import mlflare

run = mlflare.init(
    project="vision-experiments",
    config={"lr": 0.001, "batch_size": 64}
)

for epoch in range(100):
    loss = train_one_epoch()
    run.log({"loss": loss, "epoch": epoch})

run.finish()
```

- ~200 lines of code
- Only dependency: `requests` (or `httpx`)
- wandb-compatible API surface (potential `import mlflare as wandb` support)
- Works with or without the GPU agent — usable from Colab, local GPU, SLURM, anywhere
- Authenticates with API token

**Alternative zero-dependency integration:** training scripts can emit structured JSON to stdout, which the agent parses:
```python
print(json.dumps({"_mlflare": {"loss": 0.34, "epoch": 5}}))
```

---

## Auth Model

No external auth provider. No username/password. Two auth paths:

**Machine-to-machine (agent, SDK, CLI):**
- Static API token (256-bit random, generated during `mlflare init`)
- Sent as `Authorization: Bearer <token>`
- Stored as Cloudflare Worker secret

**Human-facing (PWA):**
- TOTP via authenticator app (Google Authenticator, 1Password, Authy, etc.)
- QR code shown during `mlflare init`, scanned once
- TOTP secret stored as Worker secret
- On PWA login: enter 6-digit code → Worker validates → returns JWT (24h expiry)
- JWT stored in memory (not localStorage), sent in subsequent requests

**Setup flow:**
```
mlflare init
  → generates API_TOKEN
  → generates TOTP_SECRET
  → shows QR code for authenticator app
  → stores both as Worker secrets
```

---

## Monorepo Structure

```
foundling-ai/mlflare/
├── cmd/
│   ├── agent/                  # mlflare-agent binary entry point
│   │   └── main.go
│   └── cli/                    # mlflare CLI binary entry point
│       └── main.go
├── internal/
│   ├── api/                    # Shared Worker API client (used by both agent + CLI)
│   ├── bundle/                 # Tar, upload, .experimentignore logic
│   ├── auth/                   # Token management, TOTP setup, QR generation
│   ├── config/                 # Experiment config parsing + validation
│   ├── cloudflare/             # Cloudflare REST API client (OAuth, Workers, R2, D1, Pages)
│   ├── hyperstack/             # Hyperstack REST API client
│   ├── provision/              # Orchestrates the `mlflare init` flow
│   └── r2/                     # S3-compatible R2 client
├── embedded/
│   ├── worker/                 # Compiled Worker JS (embedded at build time)
│   ├── pwa/                    # Compiled PWA assets (embedded at build time)
│   └── migrations/             # D1 SQL migrations (embedded)
├── backend/                    # Cloudflare Worker source
│   ├── src/
│   │   ├── index.ts            # Hono router
│   │   ├── do/
│   │   │   └── experiment-manager.ts
│   │   ├── routes/
│   │   │   ├── agent.ts
│   │   │   ├── api.ts
│   │   │   ├── sdk.ts
│   │   │   └── auth.ts
│   │   └── lib/
│   │       ├── hyperstack.ts
│   │       └── r2.ts
│   ├── wrangler.toml
│   └── package.json
├── frontend/                   # PWA source
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Experiments.tsx
│   │   │   ├── Submit.tsx
│   │   │   ├── RunDetail.tsx
│   │   │   └── Compare.tsx
│   │   ├── components/
│   │   ├── hooks/
│   │   │   └── useExperimentStream.ts
│   │   └── lib/
│   │       └── api.ts
│   ├── vite.config.ts
│   └── package.json
├── sdk/                        # Python SDK
│   ├── mlflare/
│   │   ├── __init__.py
│   │   ├── client.py
│   │   └── run.py
│   └── pyproject.toml
├── go.mod
├── go.sum
└── README.md
```

---

## Build & Release

CI/CD pipeline:
1. Build TypeScript Worker → `embedded/worker/worker.js`
2. Build Vite PWA → `embedded/pwa/`
3. Go `embed` directive includes both in binary
4. Cross-compile via goreleaser: darwin-arm64, darwin-amd64, linux-amd64, linux-arm64
5. Publish to GitHub Releases
6. Publish Python SDK to PyPI

User install:
```bash
brew install mlflare          # or curl one-liner
mlflare init                  # provisions everything
mlflare agent install <ip>    # sets up GPU instance
mlflare run --dir . --entrypoint train.py
```

---

## Key Design Decisions

1. **Go for agent + CLI, not Python** — single static binary, zero dependency conflicts with ML Python environment. Agent cannot break your training setup.

2. **Push-to-run, not git-pull** — bundle working directory, upload to R2, agent unpacks. Supports dirty working trees. Git metadata captured for reproducibility but git is not in the execution path.

3. **Hibernation, not destroy/recreate** — GPU instance preserves environment across sessions. Installed packages, cached datasets, agent config all persist. Only pay for disk while sleeping.

4. **TOTP auth, not OAuth/Clerk/Auth0** — no external dependencies, no user database, no cost. Single-user/small-team system. Authenticator app for PWA, bearer token for machine access.

5. **Cloudflare edge, not traditional server** — Worker + DO + R2 + D1 runs at near-zero cost on free tier. Globally distributed. No server to maintain.

6. **ML code is separate from platform** — your training repos are your business. The platform bundles and executes whatever you point it at. The optional Python SDK is the only integration surface.

7. **Mobile-first PWA, not desktop-first web UI** — designed for the person checking training progress from their phone. Push notifications, swipeable comparisons, installable.

8. **Experiment execution platform, not just a tracker** — MLflare submits, queues, orchestrates, and manages GPU lifecycle. MLflow just logs what happened.

---

## External APIs

**Hyperstack:**
- Hibernate VM: `POST /v1/core/virtual-machines/{id}/hibernate?retain_ip=true`
- Restore VM: `GET /v1/core/virtual-machines/{id}/hibernate-restore`
- VM status: `GET /v1/core/virtual-machines/{id}`
- Auth: `api_key` header

**Cloudflare (used by CLI during init):**
- OAuth token exchange
- Workers API: deploy script, set secrets
- R2 API: create bucket
- D1 API: create database, run migrations
- Pages API: create project, deploy assets

---

## What MLflare Is Not

- Not a local experiment tracker (use MLflow for that)
- Not a model serving platform
- Not a data versioning tool
- Not a pipeline orchestrator
- Not multi-tenant SaaS (it's self-hosted on your own Cloudflare account)
- Not locked to Hyperstack (the Hyperstack integration is one module — swappable for RunPod, Lambda, Vast.ai, etc.)
