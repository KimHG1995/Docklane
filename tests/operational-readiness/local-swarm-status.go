// Read local Swarm status without the quorum-dependent /info endpoint.
// References: Moby v28.5.2 system.pingHandler and cluster.Cluster.Status.
// This helper does not establish manager readiness or recovery acceptance.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func readLocalSwarmStatus(socket string) (string, error) {
	transport := &http.Transport{
		// Intentionally no ProxyFromEnvironment or Docker endpoint overrides.
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 4096,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   2 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	request, err := http.NewRequest(http.MethodHead, "http://docker/_ping", nil)
	if err != nil {
		return "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	values := response.Header.Values("Swarm")
	if response.StatusCode != http.StatusOK || len(values) != 1 {
		return "", errors.New("unavailable or ambiguous local status")
	}
	// The optional header must never default to inactive or pending.
	switch values[0] {
	case "inactive", "pending", "error", "locked", "active/worker", "active/manager":
		return values[0], nil
	default:
		return "", errors.New("unsupported local status")
	}
}

func run(args []string, output io.Writer) error {
	flags := flag.NewFlagSet("local-swarm-status", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	socket := flags.String("socket", "/var/run/docker.sock", "absolute Unix socket path")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !filepath.IsAbs(*socket) {
		return errors.New("expected only an absolute Unix socket path")
	}
	state, err := readLocalSwarmStatus(*socket)
	if err != nil {
		return err
	}
	return json.NewEncoder(output).Encode(map[string]string{
		"LocalNodeState": state,
		"StateSource":    "ping-swarm-header",
	})
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		// Never emit remote headers, response bodies, paths or raw errors.
		fmt.Fprintln(os.Stderr, "[local-swarm-status] unavailable or invalid response")
		os.Exit(1)
	}
}
