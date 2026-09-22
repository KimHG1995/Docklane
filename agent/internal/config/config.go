package config

import (
	"fmt"
	"net"
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

	defaultAddr := ":9443"
	if insecureDev {
		defaultAddr = "127.0.0.1:9443"
	}

	cfg := Config{
		Addr:        envOrDefault("DOCKLANE_AGENT_ADDR", defaultAddr),
		InsecureDev: insecureDev,
		TLSCertFile: os.Getenv("DOCKLANE_AGENT_TLS_CERT_FILE"),
		TLSKeyFile:  os.Getenv("DOCKLANE_AGENT_TLS_KEY_FILE"),
		TLSCAFile:   os.Getenv("DOCKLANE_AGENT_TLS_CA_FILE"),
	}

	if cfg.InsecureDev {
		if err := validateLoopbackAddr(cfg.Addr); err != nil {
			return Config{}, err
		}
		return cfg, nil
	}

	if cfg.TLSCertFile == "" || cfg.TLSKeyFile == "" || cfg.TLSCAFile == "" {
		return Config{}, fmt.Errorf("mTLS files are required unless DOCKLANE_AGENT_INSECURE_DEV=true")
	}

	return cfg, nil
}

func validateLoopbackAddr(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("parse DOCKLANE_AGENT_ADDR: %w", err)
	}

	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("insecure Agent mode must bind to loopback, got %q", addr)
	}
	return nil
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
