package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	Addr        string
	InsecureDev bool
	TLSCertFile string
	TLSKeyFile  string
	TLSCAFile   string
}

func Load() (Config, error) {
	insecureDev, err := strconv.ParseBool(envOrDefault("DOCKLANE_AGENT_INSECURE_DEV", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse DOCKLANE_AGENT_INSECURE_DEV: %w", err)
	}

	cfg := Config{
		Addr:        envOrDefault("DOCKLANE_AGENT_ADDR", ":9443"),
		InsecureDev: insecureDev,
		TLSCertFile: os.Getenv("DOCKLANE_AGENT_TLS_CERT_FILE"),
		TLSKeyFile:  os.Getenv("DOCKLANE_AGENT_TLS_KEY_FILE"),
		TLSCAFile:   os.Getenv("DOCKLANE_AGENT_TLS_CA_FILE"),
	}

	if !cfg.InsecureDev && (cfg.TLSCertFile == "" || cfg.TLSKeyFile == "" || cfg.TLSCAFile == "") {
		return Config{}, fmt.Errorf("mTLS files are required unless DOCKLANE_AGENT_INSECURE_DEV=true")
	}

	return cfg, nil
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
