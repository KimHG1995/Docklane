package dockerengine

import (
	"context"
	"fmt"
	"math"
	"net"
	"strings"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

type parsedConstraint struct {
	key   string
	op    string
	value string
}

type nodeUsage struct {
	nanoCPUs     int64
	memoryBytes  int64
	serviceTasks uint64
}

func (r *Reader) CheckServiceCapacity(
	ctx context.Context,
	serviceRef string,
	input model.CapacityCheckRequest,
) (model.CapacityCheckResponse, error) {
	service, err := r.resolveServiceForCapacity(ctx, serviceRef)
	if err != nil {
		return model.CapacityCheckResponse{}, err
	}
	if service.Version.Index != input.ExpectedVersion {
		return model.CapacityCheckResponse{}, &ConflictError{Message: fmt.Sprintf(
			"service version conflict: expected %d, got %d",
			input.ExpectedVersion,
			service.Version.Index,
		)}
	}

	nodeResult, err := r.client.NodeList(ctx, client.NodeListOptions{})
	if err != nil {
		return model.CapacityCheckResponse{}, fmt.Errorf("list swarm nodes: %w", err)
	}
	taskResult, err := r.client.TaskList(ctx, client.TaskListOptions{})
	if err != nil {
		return model.CapacityCheckResponse{}, fmt.Errorf("list swarm tasks: %w", err)
	}

	return evaluateServiceCapacity(service, nodeResult.Items, taskResult.Items, input), nil
}

func (r *Reader) resolveServiceForCapacity(
	ctx context.Context,
	serviceRef string,
) (swarm.Service, error) {
	result, err := r.client.ServiceList(ctx, client.ServiceListOptions{Status: true})
	if err != nil {
		return swarm.Service{}, fmt.Errorf("list swarm services: %w", err)
	}
	for _, service := range result.Items {
		if service.ID == serviceRef || service.Spec.Name == serviceRef {
			return service, nil
		}
	}
	return swarm.Service{}, fmt.Errorf("service %q not found", serviceRef)
}

func evaluateServiceCapacity(
	service swarm.Service,
	nodes []swarm.Node,
	tasks []swarm.Task,
	input model.CapacityCheckRequest,
) model.CapacityCheckResponse {
	response := model.CapacityCheckResponse{
		ServiceID:              service.ID,
		Status:                 model.CapacityStatusUnknown,
		TargetReplicas:         input.TargetReplicas,
		Reasons:                make([]string, 0),
		UnsupportedConstraints: make([]string, 0),
		Nodes:                  make([]model.CapacityNode, 0),
	}

	if service.Spec.Mode.Replicated == nil {
		response.Reasons = append(response.Reasons, "SERVICE_MODE_NOT_REPLICATED")
		return response
	}

	currentReplicas := uint64(0)
	if service.Spec.Mode.Replicated.Replicas != nil {
		currentReplicas = *service.Spec.Mode.Replicated.Replicas
	}
	response.CurrentReplicas = currentReplicas

	additional := uint64(0)
	if input.TargetReplicas > currentReplicas {
		additional = input.TargetReplicas - currentReplicas
	}
	overlap := updateOverlapReplicas(service, input.TargetReplicas, input.IncludeUpdateOverlap)
	response.UpdateOverlapReplicas = overlap
	response.RequiredAdditionalReplicas = saturatingAdd(additional, overlap)

	reservations := swarm.Resources{}
	if service.Spec.TaskTemplate.Resources != nil &&
		service.Spec.TaskTemplate.Resources.Reservations != nil {
		reservations = *service.Spec.TaskTemplate.Resources.Reservations
	}
	response.Reservation = model.CapacityResource{
		NanoCPUs:    reservations.NanoCPUs,
		MemoryBytes: reservations.MemoryBytes,
	}

	if response.RequiredAdditionalReplicas == 0 {
		response.Status = model.CapacityStatusSufficient
		return response
	}

	constraints, unsupported := parseCapacityConstraints(service.Spec.TaskTemplate.Placement)
	response.UnsupportedConstraints = unsupported

	usage := capacityUsage(tasks, service.ID)
	maxReplicas := uint64(0)
	platforms := []swarm.Platform(nil)
	if service.Spec.TaskTemplate.Placement != nil {
		maxReplicas = service.Spec.TaskTemplate.Placement.MaxReplicas
		platforms = service.Spec.TaskTemplate.Placement.Platforms
	}

	for _, node := range nodes {
		if node.Status.State != swarm.NodeStateReady ||
			node.Spec.Availability != swarm.NodeAvailabilityActive {
			continue
		}
		if !matchesPlatforms(node, platforms) || !matchesConstraints(node, constraints) {
			continue
		}

		nodeUsage := usage[node.ID]
		availableCPU := clampNonNegative(node.Description.Resources.NanoCPUs - nodeUsage.nanoCPUs)
		availableMemory := clampNonNegative(node.Description.Resources.MemoryBytes - nodeUsage.memoryBytes)
		capacity := response.RequiredAdditionalReplicas
		capacity = minUint64(capacity, slotsForResource(availableCPU, reservations.NanoCPUs, response.RequiredAdditionalReplicas))
		capacity = minUint64(capacity, slotsForResource(availableMemory, reservations.MemoryBytes, response.RequiredAdditionalReplicas))
		if maxReplicas > 0 {
			remaining := uint64(0)
			if nodeUsage.serviceTasks < maxReplicas {
				remaining = maxReplicas - nodeUsage.serviceTasks
			}
			capacity = minUint64(capacity, remaining)
		}

		response.Nodes = append(response.Nodes, model.CapacityNode{
			NodeID:                node.ID,
			Hostname:              node.Description.Hostname,
			AvailableNanoCPUs:     availableCPU,
			AvailableMemoryBytes:  availableMemory,
			ExistingServiceTasks:  nodeUsage.serviceTasks,
			MaxAdditionalReplicas: capacity,
		})
		response.SchedulableAdditionalReplicas = saturatingAdd(
			response.SchedulableAdditionalReplicas,
			capacity,
		)
		if response.SchedulableAdditionalReplicas > response.RequiredAdditionalReplicas {
			response.SchedulableAdditionalReplicas = response.RequiredAdditionalReplicas
		}
	}

	response.EligibleNodeCount = len(response.Nodes)
	if response.EligibleNodeCount == 0 {
		response.Status = model.CapacityStatusInsufficient
		response.UnplacedReplicas = response.RequiredAdditionalReplicas
		response.Reasons = append(response.Reasons, "NO_ELIGIBLE_NODES")
		return response
	}

	if len(response.UnsupportedConstraints) > 0 {
		response.Reasons = append(response.Reasons, "UNSUPPORTED_PLACEMENT_CONSTRAINT")
		response.UnplacedReplicas = unplacedReplicas(
			response.RequiredAdditionalReplicas,
			response.SchedulableAdditionalReplicas,
		)
		return response
	}

	if len(reservations.GenericResources) > 0 {
		response.Reasons = append(response.Reasons, "GENERIC_RESOURCE_RESERVATION_UNSUPPORTED")
		response.UnplacedReplicas = unplacedReplicas(
			response.RequiredAdditionalReplicas,
			response.SchedulableAdditionalReplicas,
		)
		return response
	}

	if reservations.NanoCPUs == 0 && reservations.MemoryBytes == 0 {
		if maxReplicas > 0 && response.SchedulableAdditionalReplicas < response.RequiredAdditionalReplicas {
			response.Status = model.CapacityStatusInsufficient
			response.UnplacedReplicas = unplacedReplicas(
				response.RequiredAdditionalReplicas,
				response.SchedulableAdditionalReplicas,
			)
			response.Reasons = append(response.Reasons, "MAX_REPLICAS_PER_NODE_LIMIT")
			return response
		}
		response.Reasons = append(response.Reasons, "NO_CPU_OR_MEMORY_RESERVATION")
		response.UnplacedReplicas = unplacedReplicas(
			response.RequiredAdditionalReplicas,
			response.SchedulableAdditionalReplicas,
		)
		return response
	}

	response.UnplacedReplicas = unplacedReplicas(
		response.RequiredAdditionalReplicas,
		response.SchedulableAdditionalReplicas,
	)
	if response.UnplacedReplicas > 0 {
		response.Status = model.CapacityStatusInsufficient
		response.Reasons = append(response.Reasons, "INSUFFICIENT_ELIGIBLE_CAPACITY")
		return response
	}

	response.Status = model.CapacityStatusSufficient
	return response
}

func updateOverlapReplicas(
	service swarm.Service,
	targetReplicas uint64,
	include bool,
) uint64 {
	if !include || targetReplicas == 0 || service.Spec.UpdateConfig == nil ||
		service.Spec.UpdateConfig.Order != swarm.UpdateOrderStartFirst {
		return 0
	}
	parallelism := service.Spec.UpdateConfig.Parallelism
	if parallelism == 0 || parallelism > targetReplicas {
		return targetReplicas
	}
	return parallelism
}

func capacityUsage(tasks []swarm.Task, serviceID string) map[string]nodeUsage {
	usage := make(map[string]nodeUsage)
	for _, task := range tasks {
		if task.NodeID == "" || isTerminalTaskState(task.Status.State) {
			continue
		}
		current := usage[task.NodeID]
		if task.Spec.Resources != nil && task.Spec.Resources.Reservations != nil {
			current.nanoCPUs = saturatingInt64Add(
				current.nanoCPUs,
				task.Spec.Resources.Reservations.NanoCPUs,
			)
			current.memoryBytes = saturatingInt64Add(
				current.memoryBytes,
				task.Spec.Resources.Reservations.MemoryBytes,
			)
		}
		if task.ServiceID == serviceID && countsTowardReplicaLimit(task.DesiredState) {
			current.serviceTasks++
		}
		usage[task.NodeID] = current
	}
	return usage
}

func parseCapacityConstraints(placement *swarm.Placement) ([]parsedConstraint, []string) {
	if placement == nil {
		return make([]parsedConstraint, 0), make([]string, 0)
	}
	parsed := make([]parsedConstraint, 0, len(placement.Constraints))
	unsupported := make([]string, 0)
	for _, raw := range placement.Constraints {
		constraint, ok := parseCapacityConstraint(raw)
		if !ok {
			unsupported = append(unsupported, raw)
			continue
		}
		parsed = append(parsed, constraint)
	}
	return parsed, unsupported
}

func parseCapacityConstraint(raw string) (parsedConstraint, bool) {
	for _, op := range []string{"==", "!="} {
		if !strings.Contains(raw, op) {
			continue
		}
		parts := strings.SplitN(raw, op, 2)
		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])
		if key == "" || value == "" || !supportedConstraintKey(key) {
			return parsedConstraint{}, false
		}
		return parsedConstraint{key: key, op: op, value: value}, true
	}
	return parsedConstraint{}, false
}

func supportedConstraintKey(key string) bool {
	lower := strings.ToLower(key)
	return lower == "node.id" ||
		lower == "node.hostname" ||
		lower == "node.ip" ||
		lower == "node.role" ||
		lower == "node.platform.os" ||
		lower == "node.platform.arch" ||
		strings.HasPrefix(lower, "node.labels.") ||
		strings.HasPrefix(lower, "engine.labels.")
}

func matchesConstraints(node swarm.Node, constraints []parsedConstraint) bool {
	for _, constraint := range constraints {
		if !constraintMatchesNode(constraint, node) {
			return false
		}
	}
	return true
}

func constraintMatchesNode(constraint parsedConstraint, node swarm.Node) bool {
	key := strings.ToLower(constraint.key)
	if key == "node.ip" {
		return matchIPConstraint(constraint, node.Status.Addr)
	}

	value := ""
	switch {
	case key == "node.id":
		value = node.ID
	case key == "node.hostname":
		value = node.Description.Hostname
	case key == "node.role":
		value = string(node.Spec.Role)
	case key == "node.platform.os":
		value = node.Description.Platform.OS
	case key == "node.platform.arch":
		value = node.Description.Platform.Architecture
	case strings.HasPrefix(key, "node.labels."):
		labelKey := constraint.key[len("node.labels."):]
		value = node.Spec.Annotations.Labels[labelKey]
	case strings.HasPrefix(key, "engine.labels."):
		labelKey := constraint.key[len("engine.labels."):]
		value = node.Description.Engine.Labels[labelKey]
	default:
		return false
	}

	matched := strings.EqualFold(value, constraint.value)
	if constraint.op == "!=" {
		return !matched
	}
	return matched
}

func matchIPConstraint(constraint parsedConstraint, address string) bool {
	nodeIP := net.ParseIP(address)
	if nodeIP == nil {
		return constraint.op == "!="
	}
	matched := false
	if ip := net.ParseIP(constraint.value); ip != nil {
		matched = ip.Equal(nodeIP)
	} else if _, subnet, err := net.ParseCIDR(constraint.value); err == nil {
		matched = subnet.Contains(nodeIP)
	} else {
		return false
	}
	if constraint.op == "!=" {
		return !matched
	}
	return matched
}

func matchesPlatforms(node swarm.Node, platforms []swarm.Platform) bool {
	if len(platforms) == 0 {
		return true
	}

	nodeOS := strings.ToLower(node.Description.Platform.OS)
	nodeArch := normalizeArchitecture(node.Description.Platform.Architecture)

	for _, platform := range platforms {
		platformOS := strings.ToLower(platform.OS)
		platformArch := normalizeArchitecture(platform.Architecture)

		osMatches := platformOS == "" || platformOS == nodeOS
		archMatches := platformArch == "" || platformArch == nodeArch
		if osMatches && archMatches {
			return true
		}
	}
	return false
}

func normalizeArchitecture(value string) string {
	switch strings.ToLower(value) {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	default:
		return strings.ToLower(value)
	}
}

func countsTowardReplicaLimit(state swarm.TaskState) bool {
	switch state {
	case swarm.TaskStateNew,
		swarm.TaskStateAllocated,
		swarm.TaskStatePending,
		swarm.TaskStateAssigned,
		swarm.TaskStateAccepted,
		swarm.TaskStatePreparing,
		swarm.TaskStateReady,
		swarm.TaskStateStarting,
		swarm.TaskStateRunning,
		swarm.TaskStateComplete:
		return true
	default:
		return false
	}
}

func slotsForResource(available, reservation int64, cap uint64) uint64 {
	if reservation <= 0 {
		return cap
	}
	if available <= 0 {
		return 0
	}
	slots := uint64(available / reservation)
	if slots > cap {
		return cap
	}
	return slots
}

func unplacedReplicas(required, schedulable uint64) uint64 {
	if schedulable >= required {
		return 0
	}
	return required - schedulable
}

func minUint64(left, right uint64) uint64 {
	if left < right {
		return left
	}
	return right
}

func clampNonNegative(value int64) int64 {
	if value < 0 {
		return 0
	}
	return value
}

func saturatingAdd(left, right uint64) uint64 {
	if math.MaxUint64-left < right {
		return math.MaxUint64
	}
	return left + right
}

func saturatingInt64Add(left, right int64) int64 {
	if right > 0 && left > math.MaxInt64-right {
		return math.MaxInt64
	}
	return left + right
}
