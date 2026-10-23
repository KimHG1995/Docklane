package httpserver

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KimHG1995/Docklane/agent/internal/model"
)

// mutationBarrier serializes *all* seven Docker mutation handlers with a
// maintenance state transition. BLOCKED acknowledgement only occurs after
// every earlier mutation handler returned. This does not block direct Docker
// CLI/socket writers outside Docklane.
type mutationBarrier struct {
	mu            sync.RWMutex
	path          string
	enabled       bool
	invalid       bool
	state         barrierState
	syncDirectory func(string) error
}

type barrierState struct {
	ClusterID  string `json:"clusterId"`
	Generation string `json:"generation"`
	State      string `json:"state"`
}
type barrierRequest struct {
	ClusterID  string `json:"clusterId"`
	Generation string `json:"generation"`
	State      string `json:"state"`
}

const barrierGenerationHeader = "X-Docklane-Maintenance-Generation"

func newMutationBarrier(path string) *mutationBarrier {
	b := &mutationBarrier{path: path, enabled: path != "", state: barrierState{State: "BLOCKED", Generation: "0"}}
	if !b.enabled {
		return b
	}
	// A prior write that could not confirm durability must never restore OPEN.
	if _, err := os.Stat(path + ".pending"); err == nil || !os.IsNotExist(err) {
		b.invalid = true
		return b
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		// Explicit opt-in without existing durable state must fail closed.
		return b
	}
	if err != nil {
		b.invalid = true
		return b
	}
	var saved barrierState
	if json.Unmarshal(raw, &saved) != nil || !validBarrierState(saved) {
		b.invalid = true
		return b
	}
	b.state = saved
	return b
}

func validBarrierState(v barrierState) bool {
	n, err := strconv.ParseUint(v.Generation, 10, 64)
	return err == nil && n > 0 && clusterIDValue.MatchString(v.ClusterID) &&
		(v.State == "BLOCKED" || v.State == "OPEN")
}

func isMutationPath(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || (parts[0] != "v1" && parts[0] != "v2") || parts[2] == "" {
		return false
	}
	switch parts[1] {
	case "services":
		switch parts[3] {
		case "scale", "restart", "image", "rollback":
			return true
		}
	case "nodes":
		switch parts[3] {
		case "drain", "activate", "labels":
			return true
		}
	}
	return false
}

// guard holds a read lock until a mutation handler finishes. The maintenance
// write lock therefore drains in-flight handlers before returning BLOCKED.
// A restart with missing/corrupt state remains blocked; it is never OPEN by default.
func (b *mutationBarrier) guard(next http.Handler, readIdentity func(context.Context) (model.AgentIdentityResponse, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !b.enabled || !isMutationPath(r) {
			next.ServeHTTP(w, r)
			return
		}
		b.mu.RLock()
		defer b.mu.RUnlock()
		if b.invalid || b.state.State != "OPEN" {
			writeJSON(w, http.StatusConflict, map[string]string{
				"code": "MAINTENANCE_AGENT_BLOCKED", "error": "Agent mutation barrier is closed",
			})
			return
		}
		// The expected cluster header, persisted barrier cluster and *current*
		// Docker Swarm ID must all agree. A restored OPEN file from another
		// Swarm cannot authorize a mutation on the new cluster.
		clusterHeaders := r.Header.Values(expectedClusterHeader)
		if len(clusterHeaders) != 1 || !clusterIDValue.MatchString(clusterHeaders[0]) {
			writeJSON(w, http.StatusPreconditionRequired, map[string]string{
				"code": "CLUSTER_PRECONDITION_REQUIRED", "error": "a valid expected cluster ID is required",
			})
			return
		}
		if b.state.ClusterID != clusterHeaders[0] {
			writeJSON(w, http.StatusPreconditionFailed, map[string]string{
				"code": "CLUSTER_PRECONDITION_FAILED", "error": "saved maintenance barrier belongs to another Swarm",
			})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		identity, err := readIdentity(ctx)
		if err != nil || ctx.Err() != nil || !identity.Manager || identity.NodeID == "" || identity.ClusterID == "" {
			writeClusterUnavailable(w)
			return
		}
		if identity.ClusterID != b.state.ClusterID {
			writeJSON(w, http.StatusPreconditionFailed, map[string]string{
				"code": "CLUSTER_PRECONDITION_FAILED", "error": "current Swarm differs from saved maintenance barrier",
			})
			return
		}
		values := r.Header.Values(barrierGenerationHeader)
		if len(values) != 1 || values[0] != b.state.Generation {
			writeJSON(w, http.StatusConflict, map[string]string{
				"code": "MAINTENANCE_GENERATION_STALE", "error": "Agent mutation generation is not current",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) getMaintenanceBarrier(w http.ResponseWriter, r *http.Request) {
	b := s.barrier
	b.mu.RLock()
	defer b.mu.RUnlock()
	if !b.enabled || b.invalid {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code": "MAINTENANCE_BARRIER_UNAVAILABLE", "error": "Agent barrier is disabled or its state is invalid",
		})
		return
	}
	identity, err := s.reader.Identity(r.Context())
	if err != nil || !identity.Manager || identity.ClusterID == "" || identity.NodeID == "" {
		writeClusterUnavailable(w)
		return
	}
	// Never pair a fresh identity with stale persisted OPEN/BLOCKED state.
	if b.state.ClusterID != identity.ClusterID || !validBarrierState(b.state) {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"code": "CLUSTER_PRECONDITION_FAILED", "error": "saved barrier does not match current Swarm",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"clusterId": b.state.ClusterID, "nodeId": identity.NodeID,
		"generation": b.state.Generation, "state": b.state.State,
	})
}

func (s *Server) setMaintenanceBarrier(w http.ResponseWriter, r *http.Request) {
	b := s.barrier
	if !b.enabled {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code": "MAINTENANCE_BARRIER_UNAVAILABLE", "error": "Agent barrier is disabled or its state is invalid",
		})
		return
	}
	var input barrierRequest
	if err := decodeJSON(r, &input); err != nil || !validBarrierState(barrierState(input)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "INVALID_MAINTENANCE_BARRIER", "error": "clusterId, generation and OPEN/BLOCKED state are required",
		})
		return
	}

	// This exclusive lock drains all previously accepted mutation HTTP
	// handlers and prevents new ones from reaching Docker during persistence.
	b.mu.Lock()
	defer b.mu.Unlock()
	// Another transition may have failed while this request body was being
	// decoded or while we waited for the lock. Never acknowledge invalid state.
	if b.invalid {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"code": "MAINTENANCE_BARRIER_UNAVAILABLE", "error": "Agent barrier is disabled or its state is invalid",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	identity, err := s.reader.Identity(ctx)
	if err != nil || ctx.Err() != nil || !identity.Manager || identity.ClusterID != input.ClusterID || identity.NodeID == "" {
		writeClusterUnavailable(w)
		return
	}
	if b.state.ClusterID != "" && b.state.ClusterID != input.ClusterID {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"code": "CLUSTER_PRECONDITION_FAILED", "error": "barrier pinned to a different Swarm",
		})
		return
	}
	newGeneration, _ := strconv.ParseUint(input.Generation, 10, 64)
	currentGeneration, _ := strconv.ParseUint(b.state.Generation, 10, 64)
	if newGeneration < currentGeneration || (newGeneration == currentGeneration && b.state.State != input.State) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"code": "MAINTENANCE_BARRIER_STALE", "error": "barrier generation cannot move backwards",
		})
		return
	}
	if newGeneration > currentGeneration {
		next := barrierState(input)
		// Never return an acknowledgement before the barrier is durable.
		// A failed persist keeps this process blocked, not opportunistically OPEN.
		if err := b.persist(next); err != nil {
			b.state.State = "BLOCKED"
			b.invalid = true
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"code": "MAINTENANCE_BARRIER_PERSIST_FAILED", "error": "barrier state could not be persisted",
			})
			return
		}
		b.state = next
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"clusterId": identity.ClusterID, "nodeId": identity.NodeID,
		"generation": b.state.Generation, "state": b.state.State,
	})
}

// A durable pending marker is written and synced before the replacement.
// Any interrupted/uncertain write then fails closed across process restarts.
// The marker is removed only after the state file and directory are synced.
func (b *mutationBarrier) persist(state barrierState) error {
	directory := filepath.Dir(b.path)
	marker := b.path + ".pending"
	syncDir := b.syncDirectory
	if syncDir == nil {
		syncDir = syncBarrierDirectory
	}
	pending, err := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return fmt.Errorf("create maintenance pending marker: %w", err)
	}
	if err := pending.Sync(); err != nil {
		pending.Close()
		return err
	}
	if err := pending.Close(); err != nil {
		return err
	}
	if err := syncDir(directory); err != nil {
		return err
	}

	file, err := os.CreateTemp(directory, ".docklane-barrier-*")
	if err != nil {
		return err
	}
	name := file.Name()
	defer os.Remove(name)
	if err := file.Chmod(0600); err != nil {
		file.Close()
		return err
	}
	raw, err := json.Marshal(state)
	if err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, b.path); err != nil {
		return err
	}
	if err := syncDir(directory); err != nil {
		return fmt.Errorf("sync maintenance state directory: %w", err)
	}
	// If removal is interrupted, the marker can remain after reboot.
	// That is conservative: an operator must reconcile and clear it.
	if err := os.Remove(marker); err != nil {
		return fmt.Errorf("remove maintenance pending marker: %w", err)
	}
	return nil
}

func syncBarrierDirectory(directory string) error {
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
