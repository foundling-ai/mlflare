package provision

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/viper"
	"gopkg.in/yaml.v3"

	"github.com/foundling-ai/mlflare/internal/auth"
)

type Config struct {
	WorkerURL         string `yaml:"worker_url"`
	APIToken          string `yaml:"api_token"`
	AccountID         string `yaml:"account_id"`
	R2AccessKeyID     string `yaml:"r2_access_key_id"`
	R2SecretAccessKey string `yaml:"r2_secret_access_key"`
	R2Bucket          string `yaml:"r2_bucket"`
	D1DatabaseID      string `yaml:"d1_database_id"`
}

func SaveConfig(cfg *Config) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}

	configDir := filepath.Join(home, ".mlflare")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}

	configFile := filepath.Join(configDir, "config.yaml")
	if err := os.WriteFile(configFile, data, 0o600); err != nil {
		return err
	}

	fmt.Printf("Config saved to %s\n", configFile)
	return nil
}

func LoadConfig() (*Config, error) {
	return &Config{
		WorkerURL:         viper.GetString("worker_url"),
		APIToken:          viper.GetString("api_token"),
		AccountID:         viper.GetString("account_id"),
		R2AccessKeyID:     viper.GetString("r2_access_key_id"),
		R2SecretAccessKey: viper.GetString("r2_secret_access_key"),
		R2Bucket:          viper.GetString("r2_bucket"),
		D1DatabaseID:      viper.GetString("d1_database_id"),
	}, nil
}

func GenerateSecrets() (apiToken, totpSecret string, err error) {
	apiToken, err = auth.GenerateAPIToken()
	if err != nil {
		return "", "", fmt.Errorf("generating API token: %w", err)
	}

	key, err := auth.GenerateTOTPSecret("MLflare", "admin")
	if err != nil {
		return "", "", fmt.Errorf("generating TOTP: %w", err)
	}

	auth.DisplayQRCode(key)
	totpSecret = key.Secret()

	return apiToken, totpSecret, nil
}
