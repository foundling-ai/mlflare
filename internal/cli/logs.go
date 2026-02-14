package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var logsCmd = &cobra.Command{
	Use:   "logs [run_id]",
	Short: "Stream live metrics from a run via SSE",
	Args:  cobra.ExactArgs(1),
	RunE:  streamLogs,
}

func init() {
	rootCmd.AddCommand(logsCmd)
}

func streamLogs(cmd *cobra.Command, args []string) error {
	runID := args[0]
	workerURL := viper.GetString("worker_url")
	apiToken := viper.GetString("api_token")
	if workerURL == "" || apiToken == "" {
		return fmt.Errorf("worker_url and api_token required")
	}

	url := fmt.Sprintf("%s/api/runs/%s/stream?token=%s", workerURL, runID, apiToken)

	ctx := context.Background()
	return connectSSE(ctx, url)
}

func connectSSE(ctx context.Context, url string) error {
	maxRetries := 5
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			delay := time.Duration(1<<uint(attempt)) * time.Second
			fmt.Printf("Reconnecting in %s...\n", delay)
			time.Sleep(delay)
		}

		err := readSSE(ctx, url)
		if err == nil {
			return nil // Stream completed normally
		}

		if ctx.Err() != nil {
			return ctx.Err()
		}

		fmt.Printf("SSE connection lost: %v\n", err)
	}
	return fmt.Errorf("max reconnection attempts reached")
}

func readSSE(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("SSE status %d", resp.StatusCode)
	}

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := line[6:]
		var event struct {
			Type  string `json:"type"`
			State string `json:"state"`
			Data  []struct {
				Step       int     `json:"step"`
				MetricName string  `json:"metric_name"`
				Value      float64 `json:"metric_value"`
			} `json:"data"`
		}

		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}

		switch event.Type {
		case "metrics":
			for _, m := range event.Data {
				fmt.Printf("[step %d] %s = %.6f\n", m.Step, m.MetricName, m.Value)
			}
		case "heartbeat":
			// Silent
		case "done":
			fmt.Printf("\nRun %s\n", event.State)
			return nil
		}
	}

	return scanner.Err()
}
