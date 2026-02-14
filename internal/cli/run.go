package cli

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/foundling-ai/mlflare/internal/api"
)

var runCmd = &cobra.Command{
	Use:   "run",
	Short: "Bundle and submit an experiment",
	RunE:  runExperiment,
}

var (
	runDir        string
	runEntrypoint string
	runProject    string
)

func init() {
	runCmd.Flags().StringVar(&runDir, "dir", ".", "Directory to bundle")
	runCmd.Flags().StringVar(&runEntrypoint, "entrypoint", "train.py", "Python entrypoint script")
	runCmd.Flags().StringVar(&runProject, "project", "", "Project name")
	runCmd.MarkFlagRequired("project")
	rootCmd.AddCommand(runCmd)
}

func runExperiment(cmd *cobra.Command, args []string) error {
	workerURL := viper.GetString("worker_url")
	apiToken := viper.GetString("api_token")
	if workerURL == "" || apiToken == "" {
		return fmt.Errorf("worker_url and api_token required (set via config, flags, or env)")
	}

	ctx := context.Background()
	client := api.NewClient(workerURL, apiToken)

	// Resolve directory
	absDir, err := filepath.Abs(runDir)
	if err != nil {
		return fmt.Errorf("resolving directory: %w", err)
	}

	fmt.Printf("Bundling %s...\n", absDir)

	// Get git metadata
	gitBranch := gitOutput(absDir, "rev-parse", "--abbrev-ref", "HEAD")
	gitCommit := gitOutput(absDir, "rev-parse", "HEAD")
	gitDirty := gitOutput(absDir, "status", "--porcelain") != ""

	// Hash requirements.txt if exists
	depsHash := ""
	reqFile := filepath.Join(absDir, "requirements.txt")
	if data, err := os.ReadFile(reqFile); err == nil {
		h := sha256.Sum256(data)
		depsHash = fmt.Sprintf("%x", h[:8])
	}

	// Create tar.gz bundle
	bundlePath, err := createBundle(absDir)
	if err != nil {
		return fmt.Errorf("creating bundle: %w", err)
	}
	defer os.Remove(bundlePath)

	bundleKey := fmt.Sprintf("bundles/%s/%s", runProject, filepath.Base(bundlePath))

	// Upload bundle through Worker (works for both local dev and production)
	fmt.Printf("Uploading bundle (%s)...\n", bundleKey)
	if err := client.UploadBundle(ctx, bundleKey, bundlePath, apiToken); err != nil {
		return fmt.Errorf("uploading bundle: %w", err)
	}

	// Submit experiment
	fmt.Println("Submitting experiment...")
	resp, err := client.SubmitExperiment(ctx, api.ExperimentSubmission{
		Project:    runProject,
		Entrypoint: runEntrypoint,
		GitBranch:  gitBranch,
		GitCommit:  gitCommit,
		GitDirty:   gitDirty,
		DepsHash:   depsHash,
		BundleKey:  bundleKey,
	})
	if err != nil {
		return fmt.Errorf("submitting experiment: %w", err)
	}

	fmt.Printf("\nExperiment submitted!\n")
	fmt.Printf("  Experiment: %s\n", resp.ExperimentID)
	fmt.Printf("  Run:        %s\n", resp.RunID)
	fmt.Printf("  Queue pos:  %d\n", resp.QueuePosition)
	fmt.Printf("\nTrack with: mlflare logs %s\n", resp.RunID)

	return nil
}

func gitOutput(dir string, args ...string) string {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func createBundle(dir string) (string, error) {
	f, err := os.CreateTemp("", "mlflare-bundle-*.tar.gz")
	if err != nil {
		return "", err
	}
	defer f.Close()

	gw := gzip.NewWriter(f)
	defer gw.Close()
	tw := tar.NewWriter(gw)
	defer tw.Close()

	// Read .gitignore patterns
	ignorePatterns := readGitignore(dir)

	err = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, _ := filepath.Rel(dir, path)
		if relPath == "." {
			return nil
		}

		// Skip common dirs
		base := filepath.Base(path)
		if info.IsDir() && (base == ".git" || base == "node_modules" || base == "__pycache__" || base == ".venv" || base == "venv") {
			return filepath.SkipDir
		}

		// Skip ignored files
		for _, pattern := range ignorePatterns {
			if matched, _ := filepath.Match(pattern, base); matched {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = relPath

		if err := tw.WriteHeader(header); err != nil {
			return err
		}

		if !info.Mode().IsRegular() {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.Copy(tw, file)
		return err
	})

	return f.Name(), err
}

func readGitignore(dir string) []string {
	data, err := os.ReadFile(filepath.Join(dir, ".gitignore"))
	if err != nil {
		return nil
	}
	var patterns []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			patterns = append(patterns, line)
		}
	}
	return patterns
}
