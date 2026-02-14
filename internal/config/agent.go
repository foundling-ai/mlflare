package config

import (
	"fmt"
	"os"

	"github.com/spf13/viper"
)

type AgentConfig struct {
	WorkerURL  string `mapstructure:"worker_url"`
	APIToken   string `mapstructure:"api_token"`
	Hostname   string `mapstructure:"hostname"`
	WorkDir    string `mapstructure:"work_dir"`
	PythonBin  string `mapstructure:"python_bin"`
}

func LoadAgentConfig() (*AgentConfig, error) {
	v := viper.New()

	v.SetConfigName("agent")
	v.SetConfigType("yaml")
	v.AddConfigPath("/etc/mlflare")
	v.AddConfigPath("$HOME/.mlflare")
	v.AddConfigPath(".")

	v.SetEnvPrefix("MLFLARE")
	v.AutomaticEnv()

	// Explicitly bind env vars so Unmarshal picks them up
	v.BindEnv("worker_url")
	v.BindEnv("api_token")
	v.BindEnv("hostname")
	v.BindEnv("work_dir")
	v.BindEnv("python_bin")

	v.SetDefault("work_dir", "/tmp/mlflare-workspace")
	v.SetDefault("python_bin", "python3")

	hostname, _ := os.Hostname()
	v.SetDefault("hostname", hostname)

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("reading config: %w", err)
		}
	}

	cfg := &AgentConfig{}
	if err := v.Unmarshal(cfg); err != nil {
		return nil, fmt.Errorf("unmarshaling config: %w", err)
	}

	if cfg.WorkerURL == "" {
		return nil, fmt.Errorf("worker_url is required (set MLFLARE_WORKER_URL or in config)")
	}
	if cfg.APIToken == "" {
		return nil, fmt.Errorf("api_token is required (set MLFLARE_API_TOKEN or in config)")
	}

	return cfg, nil
}
