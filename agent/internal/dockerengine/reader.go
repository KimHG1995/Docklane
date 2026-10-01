package dockerengine

import (
	"context"
	"fmt"
	"sort"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

type Reader struct {
	client *client.Client
}

func NewReader() (*Reader, error) {
	cli, err := client.New(
		client.FromEnv,
		client.WithUserAgent("docklane-agent/pre-alpha"),
	)
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	return &Reader{client: cli}, nil
}

func (r *Reader) Close() error {
	return r.client.Close()
}

func (r *Reader) Identity(ctx context.Context) (model.AgentIdentityResponse, error) {
	infoResult, err := r.client.Info(ctx, client.InfoOptions{})
	if err != nil {
		return model.AgentIdentityResponse{}, fmt.Errorf("read docker info: %w", err)
	}
	nodeID := infoResult.Info.Swarm.NodeID
	if nodeID == "" {
		return model.AgentIdentityResponse{}, fmt.Errorf("docker daemon is not joined to a Swarm")
	}

	swarmResult, err := r.client.SwarmInspect(ctx, client.SwarmInspectOptions{})
	if err != nil {
		return model.AgentIdentityResponse{}, fmt.Errorf("inspect swarm: %w", err)
	}

	nodeResult, err := r.client.NodeInspect(ctx, nodeID, client.NodeInspectOptions{})
	if err != nil {
		return model.AgentIdentityResponse{}, fmt.Errorf("inspect local swarm node %s: %w", nodeID, err)
	}
	node := nodeResult.Node
	if node.ID != nodeID {
		return model.AgentIdentityResponse{}, fmt.Errorf(
			"local Swarm node identity mismatch: docker info reported %s, inspect returned %s",
			nodeID,
			node.ID,
		)
	}
	if node.Spec.Role != swarm.NodeRoleManager {
		return model.AgentIdentityResponse{}, fmt.Errorf("local Swarm node %s is not a manager", nodeID)
	}

	return model.AgentIdentityResponse{
		Component: "docklane-agent",
		ClusterID: swarmResult.Swarm.ID,
		NodeID:    node.ID,
		Hostname:  node.Description.Hostname,
		Manager:   true,
		Leader:    node.ManagerStatus != nil && node.ManagerStatus.Leader,
	}, nil
}

func (r *Reader) Cluster(ctx context.Context) (model.ClusterResponse, error) {
	server, err := r.client.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return model.ClusterResponse{}, fmt.Errorf("read docker server version: %w", err)
	}

	swarmResult, err := r.client.SwarmInspect(ctx, client.SwarmInspectOptions{})
	if err != nil {
		return model.ClusterResponse{}, fmt.Errorf("inspect swarm: %w", err)
	}

	nodeResult, err := r.client.NodeList(ctx, client.NodeListOptions{})
	if err != nil {
		return model.ClusterResponse{}, fmt.Errorf("list swarm nodes: %w", err)
	}

	nodes := make([]model.NodeSummary, 0, len(nodeResult.Items))
	managerTotal, managerReachable, leaderCount := 0, 0, 0

	for _, node := range nodeResult.Items {
		nodes = append(nodes, toNodeSummary(node))

		if node.Spec.Role != swarm.NodeRoleManager {
			continue
		}

		managerTotal++
		if node.ManagerStatus != nil {
			if node.ManagerStatus.Leader {
				leaderCount++
			}
			if node.Status.State == swarm.NodeStateReady &&
				string(node.ManagerStatus.Reachability) == "reachable" {
				managerReachable++
			}
		}
	}

	required := 0
	if managerTotal > 0 {
		required = managerTotal/2 + 1
	}

	return model.ClusterResponse{
		Cluster: model.ClusterSummary{
			ID:            swarmResult.Swarm.ID,
			DockerVersion: server.Version,
			APIVersion:    server.APIVersion,
			CreatedAt:     swarmResult.Swarm.CreatedAt,
			UpdatedAt:     swarmResult.Swarm.UpdatedAt,
			Managers: model.ManagerQuorum{
				Total:       managerTotal,
				Reachable:   managerReachable,
				Required:    required,
				Available:   required > 0 && managerReachable >= required,
				LeaderCount: leaderCount,
			},
		},
		Nodes: nodes,
	}, nil
}

func (r *Reader) Node(ctx context.Context, nodeRef string) (model.NodeDetailResponse, error) {
	node, err := r.resolveNode(ctx, nodeRef)
	if err != nil {
		return model.NodeDetailResponse{}, err
	}

	taskResult, err := r.client.TaskList(ctx, client.TaskListOptions{})
	if err != nil {
		return model.NodeDetailResponse{}, fmt.Errorf("list node tasks: %w", err)
	}

	tasks := make([]model.TaskSummary, 0)
	serviceSet := make(map[string]struct{})
	for _, task := range taskResult.Items {
		if task.NodeID != node.ID || isTerminalTaskState(task.Status.State) {
			continue
		}
		tasks = append(tasks, toTaskSummary(task))
		if task.ServiceID != "" {
			serviceSet[task.ServiceID] = struct{}{}
		}
	}

	serviceIDs := make([]string, 0, len(serviceSet))
	for serviceID := range serviceSet {
		serviceIDs = append(serviceIDs, serviceID)
	}
	sort.Strings(serviceIDs)

	return model.NodeDetailResponse{
		Node:       toNodeSummary(node),
		Tasks:      tasks,
		ServiceIDs: serviceIDs,
	}, nil
}

func (r *Reader) resolveNode(ctx context.Context, nodeRef string) (swarm.Node, error) {
	result, err := r.client.NodeList(ctx, client.NodeListOptions{})
	if err != nil {
		return swarm.Node{}, fmt.Errorf("list swarm nodes: %w", err)
	}

	for _, node := range result.Items {
		if node.ID == nodeRef || node.Description.Hostname == nodeRef {
			return node, nil
		}
	}
	return swarm.Node{}, &NotFoundError{Resource: "node", Ref: nodeRef}
}

func isTerminalTaskState(state swarm.TaskState) bool {
	switch state {
	case swarm.TaskStateComplete,
		swarm.TaskStateShutdown,
		swarm.TaskStateFailed,
		swarm.TaskStateRejected,
		swarm.TaskStateRemove,
		swarm.TaskStateOrphaned:
		return true
	default:
		return false
	}
}

func (r *Reader) Services(ctx context.Context) ([]model.ServiceSummary, error) {
	result, err := r.client.ServiceList(ctx, client.ServiceListOptions{Status: true})
	if err != nil {
		return nil, fmt.Errorf("list swarm services: %w", err)
	}

	services := make([]model.ServiceSummary, 0, len(result.Items))
	for _, service := range result.Items {
		services = append(services, toServiceSummary(service))
	}
	return services, nil
}

func (r *Reader) Service(ctx context.Context, serviceID string) (model.ServiceDetailResponse, error) {
	result, err := r.client.ServiceList(ctx, client.ServiceListOptions{Status: true})
	if err != nil {
		return model.ServiceDetailResponse{}, fmt.Errorf("list swarm services: %w", err)
	}

	var found *swarm.Service
	for i := range result.Items {
		if result.Items[i].ID == serviceID || result.Items[i].Spec.Name == serviceID {
			found = &result.Items[i]
			break
		}
	}
	if found == nil {
		return model.ServiceDetailResponse{}, &NotFoundError{
			Resource: "service",
			Ref:      serviceID,
		}
	}

	tasks, err := r.ServiceTasks(ctx, found.ID)
	if err != nil {
		return model.ServiceDetailResponse{}, err
	}

	serviceSummary := toServiceSummary(*found)
	serviceSummary.RunningReplicas = countDesiredRunningTasks(tasks)

	return model.ServiceDetailResponse{
		Service: serviceSummary,
		Tasks:   tasks,
	}, nil
}

func countDesiredRunningTasks(tasks []model.TaskSummary) uint64 {
	var running uint64
	for _, task := range tasks {
		if task.DesiredState == "running" && task.State == "running" {
			running++
		}
	}
	return running
}

func (r *Reader) ServiceTasks(ctx context.Context, serviceID string) ([]model.TaskSummary, error) {
	result, err := r.client.TaskList(ctx, client.TaskListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list service tasks: %w", err)
	}

	tasks := make([]model.TaskSummary, 0)
	for _, task := range result.Items {
		if task.ServiceID == serviceID {
			tasks = append(tasks, toTaskSummary(task))
		}
	}
	return tasks, nil
}

func toNodeSummary(node swarm.Node) model.NodeSummary {
	specHash, _ := nodeSpecHash(node.Spec)
	labels := make(map[string]string, len(node.Spec.Annotations.Labels))
	for key, value := range node.Spec.Annotations.Labels {
		labels[key] = value
	}
	leader := false
	reachability := ""

	if node.ManagerStatus != nil {
		leader = node.ManagerStatus.Leader
		reachability = string(node.ManagerStatus.Reachability)
	}

	return model.NodeSummary{
		ID:            node.ID,
		Version:       node.Version.Index,
		SpecHash:      specHash,
		Hostname:      node.Description.Hostname,
		Address:       node.Status.Addr,
		Role:          string(node.Spec.Role),
		Availability:  string(node.Spec.Availability),
		State:         string(node.Status.State),
		Message:       node.Status.Message,
		Manager:       node.Spec.Role == swarm.NodeRoleManager,
		Leader:        leader,
		Reachability:  reachability,
		EngineVersion: node.Description.Engine.EngineVersion,
		NanoCPUs:      node.Description.Resources.NanoCPUs,
		MemoryBytes:   node.Description.Resources.MemoryBytes,
		Labels:        labels,
	}
}

func toServiceSummary(service swarm.Service) model.ServiceSummary {
	specHash, _ := serviceSpecHash(service.Spec)
	taskSpecHash, _ := taskSpecHash(service.Spec.TaskTemplate)
	runtimeSpecHash, _ := taskRuntimeSpecHash(service.Spec.TaskTemplate)
	image := ""
	if service.Spec.TaskTemplate.ContainerSpec != nil {
		image = service.Spec.TaskTemplate.ContainerSpec.Image
	}

	mode := "unknown"
	if service.Spec.Mode.Replicated != nil {
		mode = "replicated"
	} else if service.Spec.Mode.Global != nil {
		mode = "global"
	} else if service.Spec.Mode.ReplicatedJob != nil {
		mode = "replicated-job"
	} else if service.Spec.Mode.GlobalJob != nil {
		mode = "global-job"
	}

	var desired, running uint64
	if service.ServiceStatus != nil {
		desired = service.ServiceStatus.DesiredTasks
		running = service.ServiceStatus.RunningTasks
	} else if service.Spec.Mode.Replicated != nil && service.Spec.Mode.Replicated.Replicas != nil {
		desired = *service.Spec.Mode.Replicated.Replicas
	}

	updateState, updateMessage := "", ""
	if service.UpdateStatus != nil {
		updateState = string(service.UpdateStatus.State)
		updateMessage = service.UpdateStatus.Message
	}

	return model.ServiceSummary{
		ID:              service.ID,
		Name:            service.Spec.Name,
		Version:         service.Version.Index,
		SpecHash:        specHash,
		ForceUpdate:     service.Spec.TaskTemplate.ForceUpdate,
		TaskSpecHash:    taskSpecHash,
		RuntimeSpecHash: runtimeSpecHash,
		Image:           image,
		Mode:            mode,
		DesiredReplicas: desired,
		RunningReplicas: running,
		UpdateState:     updateState,
		UpdateMessage:   updateMessage,
		CreatedAt:       service.CreatedAt,
		UpdatedAt:       service.UpdatedAt,
	}
}

func toTaskSummary(task swarm.Task) model.TaskSummary {
	specHash, _ := taskSpecHash(task.Spec)
	runtimeSpecHash, _ := taskRuntimeSpecHash(task.Spec)
	containerID := ""
	if task.Status.ContainerStatus != nil {
		containerID = task.Status.ContainerStatus.ContainerID
	}

	image := ""
	if task.Spec.ContainerSpec != nil {
		image = task.Spec.ContainerSpec.Image
	}

	return model.TaskSummary{
		ID:              task.ID,
		ServiceID:       task.ServiceID,
		SpecHash:        specHash,
		RuntimeSpecHash: runtimeSpecHash,
		Slot:            task.Slot,
		NodeID:          task.NodeID,
		DesiredState:    string(task.DesiredState),
		State:           string(task.Status.State),
		ForceUpdate:     task.Spec.ForceUpdate,
		Message:         task.Status.Message,
		Error:           task.Status.Err,
		ContainerID:     containerID,
		Image:           image,
		Timestamp:       task.Status.Timestamp,
	}
}
