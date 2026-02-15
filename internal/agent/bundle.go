package agent

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/foundling-ai/mlflare/internal/api"
)

func DownloadAndExtract(ctx context.Context, client *api.Client, bundleURL, baseDir string) (string, error) {
	body, err := client.DownloadBundle(ctx, bundleURL)
	if err != nil {
		return "", fmt.Errorf("downloading bundle: %w", err)
	}
	defer body.Close()

	workDir := filepath.Join(baseDir, "run")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return "", fmt.Errorf("creating work dir: %w", err)
	}

	// Remove previous contents
	entries, _ := os.ReadDir(workDir)
	for _, e := range entries {
		os.RemoveAll(filepath.Join(workDir, e.Name()))
	}

	gz, err := gzip.NewReader(body)
	if err != nil {
		return "", fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("tar read: %w", err)
		}

		target := filepath.Join(workDir, header.Name)

		// Prevent path traversal
		if !filepath.HasPrefix(target, workDir) {
			continue
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			f, err := os.Create(target)
			if err != nil {
				return "", err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return "", err
			}
			f.Close()
			if header.Mode&0o111 != 0 {
				os.Chmod(target, 0o755)
			}
		}
	}

	return workDir, nil
}

// lastDepsHash stores the hash of the last installed deps to avoid reinstalling.
var lastDepsHash string

// EnsureVenv creates a persistent venv at <baseDir>/venv if it doesn't exist,
// and returns the path to the venv's Python binary.
func EnsureVenv(ctx context.Context, baseDir, pythonBin string, logger *slog.Logger) (string, error) {
	venvDir := filepath.Join(baseDir, "venv")
	venvPython := filepath.Join(venvDir, "bin", "python")

	// Check if venv already exists
	if _, err := os.Stat(venvPython); err == nil {
		logger.Debug("venv already exists", "path", venvDir)
		return venvPython, nil
	}

	logger.Info("creating venv", "path", venvDir, "python", pythonBin)
	cmd := exec.CommandContext(ctx, pythonBin, "-m", "venv", venvDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("creating venv: %w", err)
	}

	return venvPython, nil
}

func InstallDeps(ctx context.Context, workDir, depsHash, venvPython string, logger *slog.Logger) error {
	reqFile := filepath.Join(workDir, "requirements.txt")
	if _, err := os.Stat(reqFile); os.IsNotExist(err) {
		return nil
	}

	// Check if all deps are pinned (every non-comment line has == or ===)
	allPinned := true
	reqData, _ := os.ReadFile(reqFile)
	for _, line := range strings.Split(string(reqData), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "-") {
			continue
		}
		if !strings.Contains(line, "==") {
			allPinned = false
			break
		}
	}

	// Skip install only if all deps are pinned AND hash matches
	if allPinned && depsHash != "" && depsHash == lastDepsHash {
		logger.Info("deps hash unchanged (all pinned), skipping install")
		return nil
	}

	args := []string{"-m", "pip", "install", "-r", reqFile, "--quiet"}
	if !allPinned {
		args = append(args, "--upgrade")
		logger.Info("installing dependencies (upgrading unpinned)", "deps_hash", depsHash)
	} else {
		logger.Info("installing dependencies", "deps_hash", depsHash)
	}

	cmd := exec.CommandContext(ctx, venvPython, args...)
	cmd.Dir = workDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pip install: %w", err)
	}

	lastDepsHash = depsHash
	return nil
}
