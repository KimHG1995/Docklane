package dockerengine

import (
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
)

func TestEvaluateServiceCapacitySufficient(t *testing.T) {
	service := capacityTestService(2, 1_000_000_000, 512*1024*1024)
	nodes := []swarm.Node{
		capacityTestNode("node-1", "worker-1", "a", 2_000_000_000, 2*1024*1024*1024),
		capacityTestNode("node-2", "worker-2", "a", 2_000_000_000, 2*1024*1024*1024),
	}
	tasks := []swarm.Task{
		capacityTestTask("service-1", "node-1", 1_000_000_000, 512*1024*1024),
		capacityTestTask("service-1", "node-2", 1_000_000_000, 512*1024*1024),
	}

	result := evaluateServiceCapacity(service, nodes, tasks, model.CapacityCheckRequest{
		ExpectedVersion: 1,
		TargetReplicas:  3,
	})

	if result.Status != model.CapacityStatusSufficient {
		t.Fatalf("expected sufficient, got %s (%v)", result.Status, result.Reasons)
	}
	if result.RequiredAdditionalReplicas != 1 || result.UnplacedReplicas != 0 {
		t.Fatalf("unexpected replica capacity: %+v", result)
	}
}

func TestEvaluateServiceCapacityInsufficient(t *testing.T) {
	service := capacityTestService(2, 1_000_000_000, 512*1024*1024)
	nodes := []swarm.Node{
		capacityTestNode("node-1", "worker-1", "a", 2_000_000_000, 2*1024*1024*1024),
		capacityTestNode("node-2", "worker-2", "a", 2_000_000_000, 2*1024*1024*1024),
	}
	tasks := []swarm.Task{
		capacityTestTask("service-1", "node-1", 1_000_000_000, 512*1024*1024),
		capacityTestTask("service-1", "node-2", 1_000_000_000, 512*1024*1024),
	}

	result := evaluateServiceCapacity(service, nodes, tasks, model.CapacityCheckRequest{
		ExpectedVersion: 1,
		TargetReplicas:  5,
	})

	if result.Status != model.CapacityStatusInsufficient {
		t.Fatalf("expected insufficient, got %s (%v)", result.Status, result.Reasons)
	}
	if result.UnplacedReplicas != 1 {
		t.Fatalf("expected one unplaced replica, got %d", result.UnplacedReplicas)
	}
}

func TestEvaluateServiceCapacityHonorsPlacementConstraints(t *testing.T) {
	service := capacityTestService(2, 1_000_000_000, 512*1024*1024)
	service.Spec.TaskTemplate.Placement = &swarm.Placement{
		Constraints: []string{"node.labels.zone==a"},
	}
	nodes := []swarm.Node{
		capacityTestNode("node-1", "worker-1", "a", 2_000_000_000, 2*1024*1024*1024),
		capacityTestNode("node-2", "worker-2", "b", 2_000_000_000, 2*1024*1024*1024),
	}
	tasks := []swarm.Task{
		capacityTestTask("service-1", "node-1", 1_000_000_000, 512*1024*1024),
		capacityTestTask("service-1", "node-2", 1_000_000_000, 512*1024*1024),
	}

	result := evaluateServiceCapacity(service, nodes, tasks, model.CapacityCheckRequest{
		ExpectedVersion: 1,
		TargetReplicas:  4,
	})

	if result.Status != model.CapacityStatusInsufficient {
		t.Fatalf("expected insufficient, got %s", result.Status)
	}
	if result.EligibleNodeCount != 1 {
		t.Fatalf("expected one eligible node, got %d", result.EligibleNodeCount)
	}
}

func TestEvaluateServiceCapacityUnknownWithoutReservations(t *testing.T) {
	service := capacityTestService(1, 0, 0)
	nodes := []swarm.Node{
		capacityTestNode("node-1", "worker-1", "a", 2_000_000_000, 2*1024*1024*1024),
	}

	result := evaluateServiceCapacity(service, nodes, nil, model.CapacityCheckRequest{
		ExpectedVersion: 1,
		TargetReplicas:  2,
	})

	if result.Status != model.CapacityStatusUnknown {
		t.Fatalf("expected unknown, got %s", result.Status)
	}
	if len(result.Reasons) != 1 || result.Reasons[0] != "NO_CPU_OR_MEMORY_RESERVATION" {
		t.Fatalf("unexpected reasons: %v", result.Reasons)
	}
}

func TestEvaluateServiceCapacityIncludesStartFirstOverlap(t *testing.T) {
	service := capacityTestService(2, 1_000_000_000, 256*1024*1024)
	service.Spec.UpdateConfig = &swarm.UpdateConfig{
		Order:       swarm.UpdateOrderStartFirst,
		Parallelism: 1,
	}
	nodes := []swarm.Node{
		capacityTestNode("node-1", "worker-1", "a", 4_000_000_000, 4*1024*1024*1024),
	}
	tasks := []swarm.Task{
		capacityTestTask("service-1", "node-1", 1_000_000_000, 256*1024*1024),
		capacityTestTask("service-1", "node-1", 1_000_000_000, 256*1024*1024),
	}

	result := evaluateServiceCapacity(service, nodes, tasks, model.CapacityCheckRequest{
		ExpectedVersion:      1,
		TargetReplicas:       2,
		IncludeUpdateOverlap: true,
	})

	if result.UpdateOverlapReplicas != 1 || result.RequiredAdditionalReplicas != 1 {
		t.Fatalf("expected one overlap replica, got %+v", result)
	}
	if result.Status != model.CapacityStatusSufficient {
		t.Fatalf("expected sufficient, got %s", result.Status)
	}
}

func capacityTestService(replicas uint64, nanoCPUs, memoryBytes int64) swarm.Service {
	return swarm.Service{
		ID: "service-1",
		Spec: swarm.ServiceSpec{
			Annotations: swarm.Annotations{Name: "api"},
			Mode: swarm.ServiceMode{
				Replicated: &swarm.ReplicatedService{Replicas: &replicas},
			},
			TaskTemplate: swarm.TaskSpec{
				Resources: &swarm.ResourceRequirements{
					Reservations: &swarm.Resources{
						NanoCPUs:    nanoCPUs,
						MemoryBytes: memoryBytes,
					},
				},
			},
		},
	}
}

func capacityTestNode(
	id, hostname, zone string,
	nanoCPUs, memoryBytes int64,
) swarm.Node {
	return swarm.Node{
		ID: id,
		Spec: swarm.NodeSpec{
			Role:         swarm.NodeRoleWorker,
			Availability: swarm.NodeAvailabilityActive,
			Annotations: swarm.Annotations{
				Labels: map[string]string{"zone": zone},
			},
		},
		Description: swarm.NodeDescription{
			Hostname: hostname,
			Platform: swarm.Platform{OS: "linux", Architecture: "amd64"},
			Resources: swarm.Resources{
				NanoCPUs:    nanoCPUs,
				MemoryBytes: memoryBytes,
			},
		},
		Status: swarm.NodeStatus{State: swarm.NodeStateReady, Addr: "10.0.0.1"},
	}
}

func capacityTestTask(
	serviceID, nodeID string,
	nanoCPUs, memoryBytes int64,
) swarm.Task {
	return swarm.Task{
		ServiceID: serviceID,
		NodeID:    nodeID,
		Status:    swarm.TaskStatus{State: swarm.TaskStateRunning},
		Spec: swarm.TaskSpec{
			Resources: &swarm.ResourceRequirements{
				Reservations: &swarm.Resources{
					NanoCPUs:    nanoCPUs,
					MemoryBytes: memoryBytes,
				},
			},
		},
	}
}
