package dockerengine

import (
	"context"
	"fmt"
	"sort"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

func (r *Reader) PlanNodeLabels(
	ctx context.Context,
	nodeRef string,
	input model.NodeLabelPatchRequest,
) (model.NodeMutationPlan, error) {
	node, err := r.resolveNode(ctx, nodeRef)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}
	if node.Version.Index != input.ExpectedVersion {
		return model.NodeMutationPlan{}, &ConflictError{Message: fmt.Sprintf(
			"node version conflict: expected %d, got %d",
			input.ExpectedVersion,
			node.Version.Index,
		)}
	}

	beforeHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	labels := cloneLabels(node.Spec.Annotations.Labels)
	for key, value := range input.Set {
		labels[key] = value
	}
	for _, key := range input.Remove {
		delete(labels, key)
	}
	node.Spec.Annotations.Labels = labels

	targetHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	serviceIDs, err := r.allServiceIDs(ctx)
	if err != nil {
		return model.NodeMutationPlan{}, err
	}

	return model.NodeMutationPlan{
		NodeID:             node.ID,
		Version:            node.Version.Index,
		BeforeSpecHash:     beforeHash,
		TargetSpecHash:     targetHash,
		TargetAvailability: string(node.Spec.Availability),
		AffectedServiceIDs: serviceIDs,
		TargetLabels:       labels,
	}, nil
}

func (r *Reader) UpdateNodeLabels(
	ctx context.Context,
	nodeRef string,
	input model.NodeMutationRequest,
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

	actualServiceIDs, err := r.allServiceIDs(ctx)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	expectedServiceIDs := append([]string(nil), input.ExpectedServiceIDs...)
	sort.Strings(expectedServiceIDs)
	if !equalStrings(actualServiceIDs, expectedServiceIDs) {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "cluster service set changed after label mutation planning",
		}
	}

	currentHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	if currentHash != input.ExpectedSpecHash {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "node spec changed after label mutation planning",
		}
	}

	node.Spec.Annotations.Labels = cloneLabels(input.TargetLabels)
	targetHash, err := nodeSpecHash(node.Spec)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	if targetHash != input.TargetSpecHash {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "target node labels changed after mutation planning",
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
					"update node %q labels: Docker rejected stale node version",
					node.ID,
				),
			}
		}
		return model.NodeMutationResponse{}, fmt.Errorf(
			"update node %q labels: %w",
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
		TargetAvailability: string(after.Node.Spec.Availability),
	}, nil
}

func (r *Reader) allServiceIDs(ctx context.Context) ([]string, error) {
	result, err := r.client.ServiceList(ctx, client.ServiceListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list swarm services: %w", err)
	}
	ids := make([]string, 0, len(result.Items))
	for _, service := range result.Items {
		ids = append(ids, service.ID)
	}
	sort.Strings(ids)
	return ids, nil
}

func cloneLabels(input map[string]string) map[string]string {
	labels := make(map[string]string, len(input))
	for key, value := range input {
		labels[key] = value
	}
	return labels
}
