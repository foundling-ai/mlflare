package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/hashicorp/go-retryablehttp"
)

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

func NewClient(baseURL, token string) *Client {
	rc := retryablehttp.NewClient()
	rc.RetryMax = 3
	rc.RetryWaitMin = 1 * time.Second
	rc.RetryWaitMax = 10 * time.Second
	rc.Logger = nil

	return &Client{
		baseURL:    baseURL,
		token:      token,
		httpClient: rc.StandardClient(),
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, result any) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshaling request: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("creating request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("executing request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("reading response: %w", err)
	}

	if resp.StatusCode >= 400 {
		return fmt.Errorf("API error %d: %s", resp.StatusCode, string(respBody))
	}

	if result != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, result); err != nil {
			return fmt.Errorf("unmarshaling response: %w", err)
		}
	}

	return nil
}

// Agent endpoints

type CheckinRequest struct {
	AgentVersion string `json:"agent_version"`
	Hostname     string `json:"hostname"`
}

type CheckinResponse struct {
	Assignment *Assignment `json:"assignment"`
}

type Assignment struct {
	RunID        string         `json:"run_id"`
	ExperimentID string         `json:"experiment_id"`
	Entrypoint   string         `json:"entrypoint"`
	BundleURL    string         `json:"bundle_url"`
	DepsHash     string         `json:"deps_hash,omitempty"`
	Config       map[string]any `json:"config,omitempty"`
}

func (c *Client) Checkin(ctx context.Context, req CheckinRequest) (*CheckinResponse, error) {
	var resp CheckinResponse
	err := c.do(ctx, "POST", "/agent/checkin", req, &resp)
	return &resp, err
}

func (c *Client) Heartbeat(ctx context.Context) error {
	return c.do(ctx, "POST", "/agent/heartbeat", nil, nil)
}

type MetricBatch struct {
	RunID   string          `json:"run_id"`
	Metrics []MetricPayload `json:"metrics"`
}

type MetricPayload struct {
	Step   int                `json:"step"`
	Values map[string]float64 `json:"values"`
}

func (c *Client) SendMetrics(ctx context.Context, batch MetricBatch) error {
	return c.do(ctx, "POST", "/agent/metrics", batch, nil)
}

type CompletedRequest struct {
	RunID    string `json:"run_id"`
	ExitCode int    `json:"exit_code"`
}

func (c *Client) ReportCompleted(ctx context.Context, req CompletedRequest) error {
	return c.do(ctx, "POST", "/agent/completed", req, nil)
}

type FailedRequest struct {
	RunID    string `json:"run_id"`
	Error    string `json:"error"`
	ExitCode int    `json:"exit_code"`
}

func (c *Client) ReportFailed(ctx context.Context, req FailedRequest) error {
	return c.do(ctx, "POST", "/agent/failed", req, nil)
}

// CLI/API endpoints

type ExperimentSubmission struct {
	Project    string         `json:"project"`
	Entrypoint string         `json:"entrypoint"`
	Config     map[string]any `json:"config,omitempty"`
	GitBranch  string         `json:"git_branch,omitempty"`
	GitCommit  string         `json:"git_commit,omitempty"`
	GitDirty   bool           `json:"git_dirty,omitempty"`
	DepsHash   string         `json:"deps_hash,omitempty"`
	BundleKey  string         `json:"bundle_key"`
}

type SubmitResponse struct {
	ExperimentID  string `json:"experiment_id"`
	RunID         string `json:"run_id"`
	QueuePosition int    `json:"queue_position"`
}

func (c *Client) SubmitExperiment(ctx context.Context, sub ExperimentSubmission) (*SubmitResponse, error) {
	var resp SubmitResponse
	err := c.do(ctx, "POST", "/sdk/experiments", sub, &resp)
	return &resp, err
}

type StatusResponse struct {
	Instance struct {
		InstanceState string `json:"instance_state"`
		CurrentRunID  string `json:"current_run_id"`
		QueueDepth    int    `json:"queue_depth"`
		AgentLastSeen string `json:"agent_last_seen"`
	} `json:"instance"`
	RecentRuns []struct {
		ID          string `json:"id"`
		Status      string `json:"status"`
		Project     string `json:"project"`
		Entrypoint  string `json:"entrypoint"`
		CreatedAt   string `json:"created_at"`
		StartedAt   string `json:"started_at"`
		CompletedAt string `json:"completed_at"`
	} `json:"recent_runs"`
}

func (c *Client) GetStatus(ctx context.Context) (*StatusResponse, error) {
	var resp StatusResponse
	err := c.do(ctx, "GET", "/sdk/status", nil, &resp)
	return &resp, err
}

func (c *Client) UploadBundle(ctx context.Context, key, filePath, apiToken string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return fmt.Errorf("opening bundle: %w", err)
	}
	defer f.Close()

	req, err := http.NewRequestWithContext(ctx, "PUT", c.baseURL+"/sdk/bundle/"+key, f)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/gzip")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("uploading bundle: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload error %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func (c *Client) DownloadBundle(ctx context.Context, url string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		resp.Body.Close()
		return nil, fmt.Errorf("download error %d", resp.StatusCode)
	}
	return resp.Body, nil
}
