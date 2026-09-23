package dockerengine

import (
	"context"
	"fmt"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

func (r *Reader) CheckServicePlacement(
	ctx context.Context,
	serviceRef string,
) (model.ServicePlacementResponse, error) {
	service, err := r.resolveServiceForCapacity(ctx, serviceRef)
	if err != nil {
		return model.ServicePlacementResponse{}, err
	}

	nodeResult, err := r.client.NodeList(ctx, client.NodeListOptions{})
	if err != nil {
		return model.ServicePlacementResponse{}, fmt.Errorf("list swarm nodes: %w", err)
	}
	taskResult, err := r.client.TaskList(ctx, client.TaskListOptions{})
	if err != nil {
		return model.ServicePlacementResponse{}, fmt.Errorf("list swarm tasks: %w", err)
	}

	return evaluateServicePlacement(service, nodeResult.Items, taskResult.Items), nil
}

func evaluateServicePlacement(
	service swarm.Service,
	nodes []swarm.Node,
	tasks []swarm.Task,
) model.ServicePlacementResponse {
	response := model.ServicePlacementResponse{
		ServiceID:              service.ID,
		Status:                 model.PlacementStatusUnknown,
		Reasons:                make([]string, 0),
		UnsupportedConstraints: make([]string, 0),
		Violations:             make([]model.PlacementViolation, 0),
	}

	if service.Spec.Mode.Replicated == nil {
		response.Reasons = append(response.Reasons, "SERVICE_MODE_NOT_REPLICATED")
		return response
	}

	if service.Spec.Mode.Replicated.Replicas != nil {
		response.DesiredReplicas = *service.Spec.Mode.Replicated.Replicas
	}

	constraints, unsupported := parseCapacityConstraints(service.Spec.TaskTemplate.Placement)
	response.UnsupportedConstraints = unsupported
	if len(unsupported) > 0 {
		response.Reasons = append(response.Reasons, "UNSUPPORTED_PLACEMENT_CONSTRAINT")
		return response
	}

	platforms := []swarm.Platform(nil)
	if service.Spec.TaskTemplate.Placement != nil {
		platforms = service.Spec.TaskTemplate.Placement.Platforms
	}

	nodeByID := make(map[string]swarm.Node, len(nodes))
	for _, node := range nodes {
		nodeByID[node.ID] = node
	}

	for _, task := range tasks {
		if task.ServiceID != service.ID || task.Status.State != swarm.TaskStateRunning {
			continue
		}

		response.RunningReplicas++
		node, ok := nodeByID[task.NodeID]
		if !ok {
			response.Violations = append(response.Violations, model.PlacementViolation{
				TaskID: task.ID,
				NodeID: task.NodeID,
				Reason: "NODE_NOT_FOUND",
			})
			continue
		}

		if !matchesPlatforms(node, platforms) {
			response.Violations = append(response.Violations, model.PlacementViolation{
				TaskID: task.ID,
				NodeID: task.NodeID,
				Reason: "PLATFORM_MISMATCH",
			})
			continue
		}

		if !matchesConstraints(node, constraints) {
			response.Violations = append(response.Violations, model.PlacementViolation{
				TaskID: task.ID,
				NodeID: task.NodeID,
				Reason: "PLACEMENT_CONSTRAINT_MISMATCH",
			})
		}
	}

	if response.RunningReplicas != response.DesiredReplicas {
		response.Status = model.PlacementStatusPending
		response.Reasons = append(response.Reasons, "REPLICA_CONVERGENCE_PENDING")
	}
	if len(response.Violations) > 0 {
		response.Status = model.PlacementStatusPending
		response.Reasons = append(response.Reasons, "PLACEMENT_CONVERGENCE_PENDING")
	}
	if len(response.Reasons) == 0 {
		response.Status = model.PlacementStatusConverged
	}

	return response
}
