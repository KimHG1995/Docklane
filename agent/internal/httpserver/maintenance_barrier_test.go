package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/model"
)

func TestMaintenanceBarrierDurableAndFailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	b := newMutationBarrier(path)
	if !b.enabled || b.state.State != "BLOCKED" {
		t.Fatal("missing state must block")
	}
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	s.barrier = b
	// Install barrier wrapper around the real mux handler for this test.
	handler := b.guard(s.server.Handler, s.reader.Identity)
	for _, route := range []string{"/v2/services/service-1/restart", "/v2/nodes/node-1/drain"} {
		req := httptest.NewRequest(http.MethodPost, route, strings.NewReader("{}"))
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if res.Code != http.StatusConflict {
			t.Fatalf("%s expected 409, got %d", route, res.Code)
		}
	}
	req := httptest.NewRequest(http.MethodPut, "/v1/maintenance/barrier", strings.NewReader(`{"clusterId":"cluster-1","generation":"1","state":"OPEN"}`))
	res := httptest.NewRecorder()
	s.setMaintenanceBarrier(res, req)
	if res.Code != 200 {
		t.Fatalf("open: %d %s", res.Code, res.Body.String())
	}
	reloaded := newMutationBarrier(path)
	if reloaded.invalid || reloaded.state.State != "OPEN" {
		t.Fatal("barrier was not persisted")
	}
	req = httptest.NewRequest(http.MethodPut, "/v1/maintenance/barrier", strings.NewReader(`{"clusterId":"cluster-1","generation":"2","state":"BLOCKED"}`))
	res = httptest.NewRecorder()
	s.setMaintenanceBarrier(res, req)
	if res.Code != 200 {
		t.Fatalf("close: %d %s", res.Code, res.Body.String())
	}
	reloaded = newMutationBarrier(path)
	if reloaded.state.State != "BLOCKED" || reloaded.state.Generation != "2" {
		t.Fatal("closed barrier not persisted")
	}
	req = httptest.NewRequest(http.MethodPut, "/v1/maintenance/barrier", strings.NewReader(`{"clusterId":"cluster-1","generation":"1","state":"OPEN"}`))
	res = httptest.NewRecorder()
	s.setMaintenanceBarrier(res, req)
	if res.Code != 409 {
		t.Fatalf("stale generation should be rejected: %d", res.Code)
	}
}

func TestMaintenanceBarrierCorruptStateFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	b := newMutationBarrier(path)
	if !b.invalid {
		t.Fatal("corruption must fail closed")
	}
}

func TestMaintenanceMutationRoutes(t *testing.T) {
	for _, route := range []string{"/v1/services/svc/restart", "/v2/services/svc/scale", "/v2/services/svc/image", "/v2/services/svc/rollback", "/v2/nodes/n/drain", "/v2/nodes/n/activate", "/v2/nodes/n/labels"} {
		if !isMutationPath(httptest.NewRequest(http.MethodPost, route, nil)) {
			t.Fatal(route)
		}
	}
	for _, route := range []string{"/v1/services/svc/plan-restart", "/v1/identity", "/v2/services/svc/plan-scale"} {
		if isMutationPath(httptest.NewRequest(http.MethodPost, route, nil)) {
			t.Fatal(route)
		}
	}
}

func TestBarrierStateJSON(t *testing.T) {
	v := barrierState{ClusterID: "cluster-1", Generation: "4", State: "BLOCKED"}
	raw, _ := json.Marshal(v)
	var decoded barrierState
	if err := json.Unmarshal(raw, &decoded); err != nil || !validBarrierState(decoded) {
		t.Fatal(err)
	}
}

func TestBarrierRejectsRestoredForeignSwarm(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	b := newMutationBarrier(path)
	if err := b.persist(barrierState{ClusterID: "swarm-A", Generation: "1", State: "OPEN"}); err != nil {
		t.Fatal(err)
	}
	b = newMutationBarrier(path)
	identity := func(context.Context) (model.AgentIdentityResponse, error) {
		return model.AgentIdentityResponse{ClusterID: "swarm-B", NodeID: "manager-b", Manager: true}, nil
	}
	invoked := false
	handler := b.guard(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		invoked = true
	}), identity)
	req := httptest.NewRequest(http.MethodPost, "/v2/services/svc/restart", strings.NewReader("{}"))
	req.Header.Set(expectedClusterHeader, "swarm-B")
	req.Header.Set(barrierGenerationHeader, "1")
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	if resp.Code != http.StatusPreconditionFailed || invoked {
		t.Fatalf("new Swarm must not inherit old OPEN: status=%d invoked=%v", resp.Code, invoked)
	}
	req.Header.Set(expectedClusterHeader, "swarm-A")
	resp = httptest.NewRecorder()
	handler.ServeHTTP(resp, req)
	if resp.Code != http.StatusPreconditionFailed || invoked {
		t.Fatalf("current Swarm mismatch must reject: status=%d invoked=%v", resp.Code, invoked)
	}
	server := &Server{barrier: b, reader: foreignSwarmReader{fakeReader{}}}
	get := httptest.NewRecorder()
	server.getMaintenanceBarrier(get, httptest.NewRequest(http.MethodGet, "/v1/maintenance/barrier", nil))
	if get.Code != http.StatusPreconditionFailed {
		t.Fatalf("GET must not pair B identity with A OPEN: %d %s", get.Code, get.Body.String())
	}
}

type foreignSwarmReader struct{ fakeReader }

func (foreignSwarmReader) Identity(context.Context) (model.AgentIdentityResponse, error) {
	return model.AgentIdentityResponse{ClusterID: "swarm-B", NodeID: "manager-b", Manager: true}, nil
}

func TestBarrierPostRenameSyncFailureRemainsBlockedAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	b := newMutationBarrier(path)
	calls := 0
	b.syncDirectory = func(dir string) error {
		calls++
		if calls == 2 {
			return errors.New("injected directory fsync failure after rename")
		}
		return syncBarrierDirectory(dir)
	}
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	s.barrier = b
	req := httptest.NewRequest(http.MethodPut, "/v1/maintenance/barrier",
		strings.NewReader(`{"clusterId":"cluster-1","generation":"1","state":"OPEN"}`))
	resp := httptest.NewRecorder()
	s.setMaintenanceBarrier(resp, req)
	if resp.Code != http.StatusServiceUnavailable || !b.invalid || b.state.State != "BLOCKED" {
		t.Fatalf("failed persistence must block in process: status=%d invalid=%v state=%s",
			resp.Code, b.invalid, b.state.State)
	}
	if calls != 2 {
		t.Fatalf("expected failure after rename, got %d syncs", calls)
	}
	restarted := newMutationBarrier(path)
	if !restarted.invalid || restarted.state.State == "OPEN" {
		t.Fatal("pending marker must prevent reopening after uncertain write")
	}
	if _, err := os.Stat(path + ".pending"); err != nil {
		t.Fatalf("pending marker must survive failure: %v", err)
	}
}

func TestBarrierPendingMarkerPreventsRestartAfterInitialSyncFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	b := newMutationBarrier(path)
	b.syncDirectory = func(string) error {
		return errors.New("injected initial pending-marker directory sync failure")
	}
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	s.barrier = b
	req := httptest.NewRequest(http.MethodPut, "/v1/maintenance/barrier",
		strings.NewReader(`{"clusterId":"cluster-1","generation":"1","state":"OPEN"}`))
	resp := httptest.NewRecorder()
	s.setMaintenanceBarrier(resp, req)
	if resp.Code != http.StatusServiceUnavailable || !b.invalid {
		t.Fatalf("initial sync error must fail closed: status=%d invalid=%v", resp.Code, b.invalid)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("state file should not be replaced after initial marker sync failure: %v", err)
	}
	if _, err := os.Stat(path + ".pending"); err != nil {
		t.Fatalf("pending marker must remain: %v", err)
	}
	restarted := newMutationBarrier(path)
	if !restarted.invalid || restarted.state.State == "OPEN" {
		t.Fatal("restarted barrier must not become OPEN after failed initial sync")
	}
}
