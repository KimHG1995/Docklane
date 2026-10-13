package dockerengine

import (
	"context"

	"github.com/moby/moby/client"
)

type expectedMutationClusterKey struct{}

func WithExpectedMutationCluster(ctx context.Context, clusterID string) context.Context {
	return context.WithValue(ctx, expectedMutationClusterKey{}, clusterID)
}

const (
	MutationClusterMismatch    = "CLUSTER_PRECONDITION_FAILED"
	MutationClusterUnavailable = "CLUSTER_IDENTITY_UNAVAILABLE"
)

type MutationClusterGuardError struct{ Code string }

func (e *MutationClusterGuardError) Error() string {
	if e.Code == MutationClusterMismatch {
		return "current Swarm cluster changed before Docker update"
	}
	return "Swarm identity could not be verified before Docker update"
}

// Fresh identity verification happens immediately before a Docker mutation.
// An external leave/join between this read and the update remains possible.
func (r *Reader) requireFinalMutationCluster(ctx context.Context) error {
	expected, ok := ctx.Value(expectedMutationClusterKey{}).(string)
	if !ok || expected == "" {
		return nil
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
