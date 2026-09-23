package dockerengine

import (
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
)

func TestEvaluateServicePlacementWaitsForConstraintReschedule(t *testing.T) {
	service := capacityTestService(1, 0, 0)
	service.Spec.TaskTemplate.Placement = &swarm.Placement{
		Constraints: []string{"node.labels.zone==a"},
	}
	nodes := []swarm.Node{
		capacityTestNode("node-a", "worker-a", "a", 1, 1),
		capacityTestNode("node-b", "worker-b", "b", 1, 1),
	}
	task := capacityTestTask("service-1", "node-b", 0, 0)
	task.ID = "task-old"

	result := evaluateServicePlacement(service, nodes, []swarm.Task{task})
	if result.Status != model.PlacementStatusPending {
		t.Fatalf("expected pending, got %s", result.Status)
	}
	if len(result.Violations) != 1 ||
		result.Violations[0].Reason != "PLACEMENT_CONSTRAINT_MISMATCH" {
		t.Fatalf("unexpected violations: %+v", result.Violations)
	}
}

func TestEvaluateServicePlacementConvergesAfterReschedule(t *testing.T) {
	service := capacityTestService(1, 0, 0)
	service.Spec.TaskTemplate.Placement = &swarm.Placement{
		Constraints: []string{"node.labels.zone==a"},
	}
	nodes := []swarm.Node{
		capacityTestNode("node-a", "worker-a", "a", 1, 1),
	}
	task := capacityTestTask("service-1", "node-a", 0, 0)
	task.ID = "task-new"

	result := evaluateServicePlacement(service, nodes, []swarm.Task{task})
	if result.Status != model.PlacementStatusConverged {
		t.Fatalf("expected converged, got %s (%v)", result.Status, result.Reasons)
	}
}
