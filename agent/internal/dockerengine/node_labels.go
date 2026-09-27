package dockerengine

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	cerrdefs "github.com/containerd/errdefs"
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

	beforeLabels := cloneLabels(node.Spec.Annotations.Labels)
	labels := cloneLabels(beforeLabels)
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

	serviceIDs, err := r.serviceIDsAffectedByNodeLabels(
		ctx,
		changedNodeLabelKeys(beforeLabels, labels),
	)
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
		TargetLabels:       &labels,
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

	if input.TargetLabels == nil {
		return model.NodeMutationResponse{}, &ValidationError{
			Message: "targetLabels is required for node label mutation",
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

	targetLabels := cloneLabels(*input.TargetLabels)
	actualServiceIDs, err := r.serviceIDsAffectedByNodeLabels(
		ctx,
		changedNodeLabelKeys(node.Spec.Annotations.Labels, targetLabels),
	)
	if err != nil {
		return model.NodeMutationResponse{}, err
	}
	expectedServiceIDs := append([]string(nil), input.ExpectedServiceIDs...)
	sort.Strings(expectedServiceIDs)
	if !equalStrings(actualServiceIDs, expectedServiceIDs) {
		return model.NodeMutationResponse{}, &ConflictError{
			Message: "affected service set changed after label mutation planning",
		}
	}

	node.Spec.Annotations.Labels = targetLabels
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

func (r *Reader) serviceIDsAffectedByNodeLabels(
	ctx context.Context,
	changedKeys []string,
) ([]string, error) {
	if len(changedKeys) == 0 {
		return make([]string, 0), nil
	}

	result, err := r.client.ServiceList(ctx, client.ServiceListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list swarm services: %w", err)
	}

	return affectedServiceIDsForNodeLabels(result.Items, changedKeys), nil
}

func affectedServiceIDsForNodeLabels(
	services []swarm.Service,
	changedKeys []string,
) []string {
	changed := make(map[string]struct{}, len(changedKeys))
	for _, key := range changedKeys {
		changed[key] = struct{}{}
	}

	ids := make([]string, 0)
	for _, service := range services {
		if placementReferencesNodeLabels(
			service.Spec.TaskTemplate.Placement,
			changed,
		) {
			ids = append(ids, service.ID)
		}
	}
	sort.Strings(ids)
	return ids
}

func placementReferencesNodeLabels(
	placement *swarm.Placement,
	changedKeys map[string]struct{},
) bool {
	if placement == nil || len(changedKeys) == 0 {
		return false
	}

	for _, raw := range placement.Constraints {
		key, ok := nodeLabelKeyFromConstraint(raw)
		if !ok {
			continue
		}
		if _, changed := changedKeys[key]; changed {
			return true
		}
	}

	for _, preference := range placement.Preferences {
		if preference.Spread == nil {
			continue
		}
		key, ok := nodeLabelKeyFromDescriptor(
			preference.Spread.SpreadDescriptor,
		)
		if !ok {
			continue
		}
		if _, changed := changedKeys[key]; changed {
			return true
		}
	}

	return false
}

func nodeLabelKeyFromConstraint(raw string) (string, bool) {
	for _, op := range []string{"==", "!="} {
		if !strings.Contains(raw, op) {
			continue
		}
		parts := strings.SplitN(raw, op, 2)
		return nodeLabelKeyFromDescriptor(strings.TrimSpace(parts[0]))
	}
	return "", false
}

func nodeLabelKeyFromDescriptor(raw string) (string, bool) {
	const prefix = "node.labels."
	value := strings.TrimSpace(raw)
	if len(value) <= len(prefix) ||
		!strings.EqualFold(value[:len(prefix)], prefix) {
		return "", false
	}
	return value[len(prefix):], true
}

func changedNodeLabelKeys(
	before map[string]string,
	after map[string]string,
) []string {
	changed := make(map[string]struct{})

	for key, beforeValue := range before {
		afterValue, exists := after[key]
		if !exists || beforeValue != afterValue {
			changed[key] = struct{}{}
		}
	}
	for key, afterValue := range after {
		beforeValue, exists := before[key]
		if !exists || beforeValue != afterValue {
			changed[key] = struct{}{}
		}
	}

	keys := make([]string, 0, len(changed))
	for key := range changed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
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
