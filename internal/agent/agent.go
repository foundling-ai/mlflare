package agent

import (
	"context"
	"log/slog"
	"time"

	"github.com/foundling-ai/mlflare/internal/api"
	"github.com/foundling-ai/mlflare/internal/config"
	"github.com/foundling-ai/mlflare/internal/version"
)

const checkinInterval = 10 * time.Second

type Agent struct {
	cfg    *config.AgentConfig
	client *api.Client
	logger *slog.Logger
}

func New(cfg *config.AgentConfig, logger *slog.Logger) *Agent {
	return &Agent{
		cfg:    cfg,
		client: api.NewClient(cfg.WorkerURL, cfg.APIToken),
		logger: logger,
	}
}

func (a *Agent) Run(ctx context.Context) error {
	a.logger.Info("agent starting", "worker_url", a.cfg.WorkerURL, "hostname", a.cfg.Hostname)

	for {
		select {
		case <-ctx.Done():
			a.logger.Info("agent shutting down")
			return nil
		default:
		}

		resp, err := a.client.Checkin(ctx, api.CheckinRequest{
			AgentVersion: version.Version,
			Hostname:     a.cfg.Hostname,
		})
		if err != nil {
			a.logger.Error("checkin failed", "error", err)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(checkinInterval):
			}
			continue
		}

		if resp.Assignment == nil {
			a.logger.Debug("no assignment, waiting")
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(checkinInterval):
			}
			continue
		}

		a.logger.Info("received assignment",
			"run_id", resp.Assignment.RunID,
			"experiment_id", resp.Assignment.ExperimentID,
			"entrypoint", resp.Assignment.Entrypoint,
		)

		if err := a.executeRun(ctx, resp.Assignment); err != nil {
			a.logger.Error("run execution failed", "run_id", resp.Assignment.RunID, "error", err)
		}
	}
}

func (a *Agent) executeRun(ctx context.Context, assignment *api.Assignment) error {
	// Start heartbeat
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go RunHeartbeat(hbCtx, a.client, a.logger)

	// Start metric batcher
	batcher := NewMetricBatcher(a.client, assignment.RunID, a.logger)
	batcher.Start(ctx)
	defer batcher.Stop()

	// Download and extract bundle
	workDir, err := DownloadAndExtract(ctx, a.client, assignment.BundleURL, a.cfg.WorkDir)
	if err != nil {
		_ = a.client.ReportFailed(ctx, api.FailedRequest{
			RunID:    assignment.RunID,
			Error:    "bundle download failed: " + err.Error(),
			ExitCode: 1,
		})
		return err
	}

	// Create/reuse venv for isolated dependencies
	venvPython, err := EnsureVenv(ctx, a.cfg.WorkDir, a.cfg.PythonBin, a.logger)
	if err != nil {
		_ = a.client.ReportFailed(ctx, api.FailedRequest{
			RunID:    assignment.RunID,
			Error:    "venv creation failed: " + err.Error(),
			ExitCode: 1,
		})
		return err
	}

	// Install deps into venv if needed
	if err := InstallDeps(ctx, workDir, assignment.DepsHash, venvPython, a.logger); err != nil {
		a.logger.Warn("dep install failed", "error", err)
	}

	// Run the experiment subprocess using venv Python
	exitCode, runErr := RunSubprocess(ctx, workDir, venvPython, assignment.Entrypoint, batcher, a.logger)

	// Flush remaining metrics
	batcher.Flush(ctx)

	// Report result
	if runErr != nil || exitCode != 0 {
		errMsg := "process exited with non-zero code"
		if runErr != nil {
			errMsg = runErr.Error()
		}
		_ = a.client.ReportFailed(ctx, api.FailedRequest{
			RunID:    assignment.RunID,
			Error:    errMsg,
			ExitCode: exitCode,
		})
		return runErr
	}

	return a.client.ReportCompleted(ctx, api.CompletedRequest{
		RunID:    assignment.RunID,
		ExitCode: 0,
	})
}
