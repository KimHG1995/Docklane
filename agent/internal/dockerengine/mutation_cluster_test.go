package dockerengine

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/moby/moby/client"
)

func TestFinalMutationClusterChecksLiveSwarm(t *testing.T) {
	cluster := "cluster-a"
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1.56/swarm":
			calls++
			_ = json.NewEncoder(w).Encode(map[string]string{"ID": cluster})
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	defer srv.Close()

	cli, err := client.New(client.WithHost("tcp://"+srv.Listener.Addr().String()), client.WithAPIVersion("1.56"))
	if err != nil {
		t.Fatal(err)
	}
	defer cli.Close()
	reader := &Reader{client: cli}
	ctx := WithExpectedMutationCluster(context.Background(), "cluster-a")
	if err := reader.requireFinalMutationCluster(ctx); err != nil {
		t.Fatal(err)
	}
	cluster = "cluster-b"
	var guarded *MutationClusterGuardError
	if err := reader.requireFinalMutationCluster(ctx); !errors.As(err, &guarded) || guarded.Code != MutationClusterMismatch {
		t.Fatalf("expected mismatch, got %v", err)
	}
	if calls != 2 {
		t.Fatalf("required fresh Swarm inspection for every final check: %d", calls)
	}
}

func TestFinalMutationClusterUnavailableOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(WithExpectedMutationCluster(context.Background(), "cluster-a"))
	cancel()
	reader := &Reader{}
	var guarded *MutationClusterGuardError
	if err := reader.requireFinalMutationCluster(ctx); !errors.As(err, &guarded) || guarded.Code != MutationClusterUnavailable {
		t.Fatalf("expected unavailable on cancellation, got %v", err)
	}
}
