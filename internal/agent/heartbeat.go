package agent

import (
	"context"
	"log/slog"
	"time"

	"github.com/foundling-ai/mlflare/internal/api"
)

const heartbeatInterval = 2 * time.Minute

func RunHeartbeat(ctx context.Context, client *api.Client, logger *slog.Logger) {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := client.Heartbeat(ctx); err != nil {
				logger.Error("heartbeat failed", "error", err)
			} else {
				logger.Debug("heartbeat sent")
			}
		}
	}
}
