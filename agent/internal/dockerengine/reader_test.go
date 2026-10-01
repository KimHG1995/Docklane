package dockerengine

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/client"
)

func TestCountDesiredRunningTasksExcludesShutdownOverlap(t *testing.T) {
	tasks := []model.TaskSummary{
		{
			ID:           "old",
			DesiredState: "shutdown",
			State:        "running",
			Timestamp:    time.Unix(1, 0),
		},
		{
			ID:           "replacement",
			DesiredState: "running",
			State:        "running",
			Timestamp:    time.Unix(2, 0),
		},
		{
			ID:           "pending",
			DesiredState: "running",
			State:        "preparing",
			Timestamp:    time.Unix(3, 0),
		},
	}

	if got := countDesiredRunningTasks(tasks); got != 1 {
		t.Fatalf("expected one desired running task, got %d", got)
	}
}

func TestIdentityInspectsCanonicalNodeIDWithoutHostnameFallback(t *testing.T) {
	var nodeListCalls int
	var nodeInspectCalls int

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/v1.56/info":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"Swarm": map[string]any{
					"NodeID": "local-node",
				},
			})
		case "/v1.56/swarm":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ID": "cluster-1",
			})
		case "/v1.56/nodes":
			nodeListCalls++
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{
					"ID": "foreign-node",
					"Spec": map[string]any{
						"Role": "manager",
					},
					"Description": map[string]any{
						"Hostname": "local-node",
					},
					"ManagerStatus": map[string]any{
						"Leader": true,
					},
				},
				{
					"ID": "local-node",
					"Spec": map[string]any{
						"Role": "manager",
					},
					"Description": map[string]any{
						"Hostname": "local-host",
					},
					"ManagerStatus": map[string]any{
						"Leader": false,
					},
				},
			})
		case "/v1.56/nodes/local-node":
			nodeInspectCalls++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ID": "local-node",
				"Spec": map[string]any{
					"Role": "manager",
				},
				"Description": map[string]any{
					"Hostname": "local-host",
				},
				"ManagerStatus": map[string]any{
					"Leader": false,
				},
			})
		default:
			http.Error(w, "unexpected Docker API path: "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer server.Close()

	cli, err := client.New(
		client.WithHost("tcp://"+server.Listener.Addr().String()),
		client.WithAPIVersion("1.56"),
	)
	if err != nil {
		t.Fatalf("create Docker client: %v", err)
	}
	defer cli.Close()

	reader := &Reader{client: cli}
	identity, err := reader.Identity(t.Context())
	if err != nil {
		t.Fatalf("read identity: %v", err)
	}

	if identity.ClusterID != "cluster-1" {
		t.Fatalf("expected cluster-1, got %q", identity.ClusterID)
	}
	if identity.NodeID != "local-node" {
		t.Fatalf("expected canonical local node ID, got %q", identity.NodeID)
	}
	if identity.Hostname != "local-host" {
		t.Fatalf("expected local-host, got %q", identity.Hostname)
	}
	if identity.Leader {
		t.Fatal("expected inspected local node to be non-leader")
	}
	if nodeListCalls != 0 {
		t.Fatalf("identity must not use hostname-capable node list resolution, got %d list calls", nodeListCalls)
	}
	if nodeInspectCalls != 1 {
		t.Fatalf("expected one canonical node inspect, got %d", nodeInspectCalls)
	}
}
