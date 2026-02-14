package agent

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/foundling-ai/mlflare/internal/api"
)

const flushInterval = 30 * time.Second

type MetricBatcher struct {
	client *api.Client
	runID  string
	logger *slog.Logger

	mu      sync.Mutex
	step    int
	pending []api.MetricPayload
	cancel  context.CancelFunc
}

func NewMetricBatcher(client *api.Client, runID string, logger *slog.Logger) *MetricBatcher {
	return &MetricBatcher{
		client: client,
		runID:  runID,
		logger: logger,
	}
}

func (b *MetricBatcher) Start(ctx context.Context) {
	bctx, cancel := context.WithCancel(ctx)
	b.cancel = cancel

	go func() {
		ticker := time.NewTicker(flushInterval)
		defer ticker.Stop()
		for {
			select {
			case <-bctx.Done():
				return
			case <-ticker.C:
				b.Flush(ctx)
			}
		}
	}()
}

func (b *MetricBatcher) Stop() {
	if b.cancel != nil {
		b.cancel()
	}
}

func (b *MetricBatcher) Add(values map[string]float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending = append(b.pending, api.MetricPayload{
		Step:   b.step,
		Values: values,
	})
	b.step++
}

func (b *MetricBatcher) Flush(ctx context.Context) {
	b.mu.Lock()
	if len(b.pending) == 0 {
		b.mu.Unlock()
		return
	}
	metrics := b.pending
	b.pending = nil
	b.mu.Unlock()

	err := b.client.SendMetrics(ctx, api.MetricBatch{
		RunID:   b.runID,
		Metrics: metrics,
	})
	if err != nil {
		b.logger.Error("failed to flush metrics", "error", err, "count", len(metrics))
		// Put them back
		b.mu.Lock()
		b.pending = append(metrics, b.pending...)
		b.mu.Unlock()
	} else {
		b.logger.Debug("flushed metrics", "count", len(metrics))
	}
}
