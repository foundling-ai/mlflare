package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

var cfgFile string

var rootCmd = &cobra.Command{
	Use:   "mlflare",
	Short: "MLflare — ML experiment execution platform",
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func init() {
	cobra.OnInitialize(initConfig)
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default: ~/.mlflare/config.yaml)")
	rootCmd.PersistentFlags().String("worker-url", "", "MLflare Worker URL")
	rootCmd.PersistentFlags().String("api-token", "", "API token")
	viper.BindPFlag("worker_url", rootCmd.PersistentFlags().Lookup("worker-url"))
	viper.BindPFlag("api_token", rootCmd.PersistentFlags().Lookup("api-token"))
}

func initConfig() {
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		configDir := filepath.Join(home, ".mlflare")
		viper.AddConfigPath(configDir)
		viper.SetConfigName("config")
		viper.SetConfigType("yaml")
	}

	viper.SetEnvPrefix("MLFLARE")
	viper.AutomaticEnv()

	viper.ReadInConfig()
}
