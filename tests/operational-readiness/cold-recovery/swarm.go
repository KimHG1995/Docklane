// Built only against the vendored SwarmKit in Moby 89c5e8fd66634b6128fc4c0e6f1236e2540e46e0.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/moby/swarmkit/v2/agent/exec"
	"github.com/moby/swarmkit/v2/api"
	"github.com/moby/swarmkit/v2/log"
	"github.com/moby/swarmkit/v2/node"
	"github.com/sirupsen/logrus"
)

// Never execute restored tasks while rewriting quorum on the isolated copy.
// Task recovery is deliberately left to dockerd after this process is stopped.
type disabledExecutor struct{}

func (disabledExecutor) Describe(context.Context) (*api.NodeDescription, error) {
	return &api.NodeDescription{Hostname: "docklane-offline-recovery", Platform: &api.Platform{OS: runtime.GOOS, Architecture: runtime.GOARCH}, Engine: &api.EngineDescription{}, Resources: &api.Resources{}}, nil
}
func (disabledExecutor) Configure(context.Context, *api.Node) error { return nil }
func (disabledExecutor) Controller(*api.Task) (exec.Controller, error) {
	return nil, errors.New("task execution disabled during offline recovery")
}
func (disabledExecutor) SetNetworkBootstrapKeys([]*api.EncryptionKey) error { return nil }

func rebuildOffline(o options, key []byte) error {
	log.L.Logger.SetOutput(io.Discard)
	logrus.SetOutput(io.Discard)
	fmt.Fprintln(os.Stderr, "[cold-recovery] phase=node-new")
	n, err := node.New(&node.Config{
		Hostname: "docklane-offline-recovery", StateDir: o.StateDir,
		ListenControlAPI: filepath.Join(o.StateDir, "offline-control.sock"),
		ListenRemoteAPI:  "127.0.0.1:2377", AdvertiseRemoteAPI: "127.0.0.1:2377",
		ForceNewCluster: true, UnlockKey: key, AutoLockManagers: true,
		Availability: api.NodeAvailabilityPause, Executor: disabledExecutor{},
		HeartbeatTick: 1, ElectionTick: 10,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	fmt.Fprintln(os.Stderr, "[cold-recovery] phase=node-start")
	if err = n.Start(ctx); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- n.Err(ctx) }()
	fmt.Fprintln(os.Stderr, "[cold-recovery] phase=node-wait")
	select {
	case <-n.Ready():
		fmt.Fprintln(os.Stderr, "[cold-recovery] phase=node-ready")
	case err = <-exited:
		if err == nil {
			err = errors.New("node exited before ready")
		}
	case <-ctx.Done():
		err = ctx.Err()
	}
	// Stop while the live context is still available, and require flushed state.
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	fmt.Fprintln(os.Stderr, "[cold-recovery] phase=node-stop")
	stopErr := n.Stop(stopCtx)
	if err != nil {
		return err
	}
	if stopErr != nil {
		return stopErr
	}
	return n.Err(stopCtx)
}
