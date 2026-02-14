package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
)

func RunSubprocess(ctx context.Context, workDir, pythonBin, entrypoint string, batcher *MetricBatcher, logger *slog.Logger) (int, error) {
	cmd := exec.CommandContext(ctx, pythonBin, entrypoint)
	cmd.Dir = workDir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return 1, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return 1, fmt.Errorf("starting process: %w", err)
	}

	logger.Info("subprocess started", "pid", cmd.Process.Pid)

	// Read stdout — parse __mlflare__ JSON lines
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			logger.Debug("stdout", "line", line)

			var payload struct {
				MLflare map[string]float64 `json:"__mlflare__"`
			}
			if err := json.Unmarshal([]byte(line), &payload); err == nil && payload.MLflare != nil {
				batcher.Add(payload.MLflare)
			}
		}
	}()

	// Read stderr
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			logger.Warn("stderr", "line", scanner.Text())
		}
	}()

	err = cmd.Wait()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	logger.Info("subprocess exited", "exit_code", exitCode)
	return exitCode, err
}
