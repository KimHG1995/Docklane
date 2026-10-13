package dockerengine

import (
	"context"

	"github.com/moby/moby/client"
)

// The expected cluster is carried from a verified HTTP mutation admission
// through the exact Docker update path. Other read/plan calls remain unchanged.
type expectedMutationClusterKey struct{}

func WithExpectedMutationCluster(ctx context.Context, clusterID string) context.Context {
	return context.WithValue(ctx, expectedMutationClusterKey{}, clusterID)
}

const (
	MutationClusterMismatch = "CLUSTER_PRECONDITION_FAILED"
	MutationClusterUnavailable = "CLUSTER_IDENTITY_UNAVAILABLE"
)

// These errors occur only before the Docker update request is attempted.
type MutationClusterGuardError struct{ Code string }

func (e *MutationClusterGuardError) Error() string {
	if e.Code == MutationClusterMismatch {
		return "current Swarm cluster changed before Docker update"
	}
	return "Swarm identity could not be verified before Docker update"
}

// This is intentionally a final, fresh Swarm inspect immediately before the
// Docker mutation API call. The same Docker client is used. Docker does not
// expose a cluster-ID compare-and-update transaction, so a rejoin happening
// after this read remains an unclosed external race.
func (r *Reader) requireFinalMutationCluster(ctx context.Context) error {
	expected, ok := ctx.Value(expectedMutationClusterKey{}).(string)
	if !ok || expected == "" {
		return nil // standalone internal Reader callers without HTTP admission
	}
	if ctx.Err() != nil {
		return &MutationClusterGuardError{Code: MutationClusterUnavailable}
	}
	observed, err := r.client.SwarmInspect(ctx, client.SwarmInspectOptions{})
	if err != nil || ctx.Err() != nil || observed.Swarm.ID == "" {
		return &MutationClusterGuardError{Code: MutationClusterUnavailable}
	}
	if observed.Swarm.ID != expected {
		return &MutationClusterGuardError{Code: MutationClusterMismatch}
	}
	return nil
}
