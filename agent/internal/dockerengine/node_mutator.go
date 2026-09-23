package dockerengine

import (
	"context"
	"fmt"
	"sort"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

func (r *Reader) PlanDrainNode(
	ctx context.Context,
	nodeRef string,
	expectedVersion uint64,
) (model.NodeMutationPlan, error) {
	return r.planNodeAvailability(
		ctx,
		nodeRef,
		expectedVersion,
		swarm.NodeAvailabilityDrain,
	)
}

func (r *Reader) PlanActivateNode(
	ctx context.Context,
	nodeRef string,
	expectedVersion uint64,
) (model.NodeMutationPlan, error) {
	return r.planNodeAvailability(
		ctx,
		nodeRef,
		expectedVersion,
		swarm.NodeAvailabilityActive,
	)
}

func (r *Reader) planNodeAvailability(
	ctx context.Context,
	nodeRef string,
	expectedVersion uint64,
	targetAvailability swarm.NodeAvailability,
) (model.NodeMutationPlan, error) {
	node, err := r.resolveNode(ctx, nodeRef)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}
	if node.Version.Index != expectedVersion {
		return model.NodeMutationPlan{}, &ConflictError{Message: fmt.Sprintf(
			"node version conflict: expected %d, got %d",
			expectedVersion,
			node.Version.Index,
		)}
	}

	beforeHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	node.Spec.Availability = targetAvailability
	targetHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	detail, err := r.Node(ctx, node.ID)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	serviceIDs := append([]string(nil), detail.ServiceIDs...)
	sort.Strings(serviceIDs)

	return model.NodeMutationPlan{
		NodeID:             node.ID,
		Version:            node.Version.Index,
		BeforeSpecHash:     beforeHash,
		TargetSpecHash:     targetHash,
		TargetAvailability: string(targetAvailability),
		AffectedServiceIDs: serviceIDs,
	}, nil
}

func (r *Reader) DrainNode(
	ctx context.Context,
	nodeRef string,
	input model.NodeMutationRequest,
) (model.NodeMutationResponse, error) {
	return r.updateNodeAvailability(
		ctx,
		nodeRef,
		input,
		swarm.NodeAvailabilityDrain,
	)
}

func (r *Reader) ActivateNode(
	ctx context.Context,
	nodeRef string,
	input model.NodeMutationRequest,
) (model.NodeMutationResponse, error) {
	return r.updateNodeAvailability(
		ctx,
		nodeRef,
		input,
		swarm.NodeAvailabilityActive,
	)
}

func (r *Reader) updateNodeAvailability(
	ctx context.Context,
	nodeRef string,
	input model.NodeMutationRequest,
	targetAvailability swarm.NodeAvailability,
) (model.NodeMutationResponse, error) {
	node, err := r.resolveNode(ctx, nodeRef)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	if node.Version.Index != input.ExpectedVersion {
		return model.NodeMutationResponse{}, &ConflictError{Message: fmt.Sprintf(
			"node version conflict: expected %d, got %d",
			input.ExpectedVersion,
			node.Version.Index,
		)}
	}

	if targetAvailability == swarm.NodeAvailabilityDrain {
		detail, err := r.Node(ctx, node.ID)
		if err != nil {
			return model.NodeMutationResponse{}, err
		}
		actualServiceIDs := append([]string(nil), detail.ServiceIDs...)
		expectedServiceIDs := append([]string(nil), input.ExpectedServiceIDs...)
		sort.Strings(actualServiceIDs)
		sort.Strings(expectedServiceIDs)
		if !equalStrings(actualServiceIDs, expectedServiceIDs) {
			return model.NodeMutationResponse{}, &ConflictError{
				Message: "node task set changed after mutation planning",
			}
		}
	}

	currentHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	if currentHash != input.ExpectedSpecHash {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "node spec changed after mutation planning",
		}
	}

	node.Spec.Availability = targetAvailability
	targetHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	if targetHash != input.TargetSpecHash {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "target node spec changed after mutation planning",
		}
	}

	_, err = r.client.NodeUpdate(ctx, node.ID, client.NodeUpdateOptions{
		Version: swarm.Version{Index: input.ExpectedVersion},
		Spec:    node.Spec,
	})
	if err != nil {
		if cerrdefs.IsConflict(err) {
			return model.NodeMutationResponse{}, &ConflictError{
				Message: fmt.Sprintf(
					"update node %q: Docker rejected stale node version",
					node.ID,
				),
			}
		}
		return model.NodeMutationResponse{}, fmt.Errorf(
			"update node %q availability: %w",
			node.ID,
			err,
		)
	}

	after, err := r.client.NodeInspect(ctx, node.ID, client.NodeInspectOptions{})
	if err != nil {
		return model.NodeMutationResponse{}, fmt.Errorf(
			"inspect updated node %q: %w",
			node.ID,
			err,
		)
	}

	return model.NodeMutationResponse{
		NodeID:             node.ID,
		Version:            after.Node.Version.Index,
		TargetSpecHash:     targetHash,
		TargetAvailability: string(targetAvailability),
	}, nil
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
