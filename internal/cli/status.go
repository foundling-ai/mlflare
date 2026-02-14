package cli

import (
	"context"
	"fmt"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/foundling-ai/mlflare/internal/api"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show instance status and recent runs",
	RunE:  showStatus,
}

func init() {
	rootCmd.AddCommand(statusCmd)
}

func showStatus(cmd *cobra.Command, args []string) error {
	workerURL := viper.GetString("worker_url")
	apiToken := viper.GetString("api_token")
	if workerURL == "" || apiToken == "" {
		return fmt.Errorf("worker_url and api_token required")
	}

	client := api.NewClient(workerURL, apiToken)
	ctx := context.Background()

	status, err := client.GetStatus(ctx)
	if err != nil {
		return fmt.Errorf("getting status: %w", err)
	}

	fmt.Println("MLflare Status")
	fmt.Println("==============")
	fmt.Printf("  Instance:    %s\n", status.Instance.InstanceState)
	fmt.Printf("  Current run: %s\n", valueOrDash(status.Instance.CurrentRunID))
	fmt.Printf("  Queue depth: %d\n", status.Instance.QueueDepth)
	fmt.Printf("  Agent seen:  %s\n", valueOrDash(status.Instance.AgentLastSeen))
	fmt.Println()

	if len(status.RecentRuns) > 0 {
		fmt.Println("Recent Runs")
		fmt.Println("-----------")
		for _, r := range status.RecentRuns {
			fmt.Printf("  %s  %-10s  %s/%s  %s\n",
				r.ID[:12], r.Status, r.Project, r.Entrypoint, r.CreatedAt)
		}
	}

	return nil
}

func valueOrDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
