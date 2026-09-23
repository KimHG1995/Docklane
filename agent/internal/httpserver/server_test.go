package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/model"
)

type fakeReader struct{}

func (fakeReader) Cluster(context.Context) (model.ClusterResponse, error) {
	return model.ClusterResponse{
		Cluster: model.ClusterSummary{ID: "cluster-1"},
		Nodes:   []model.NodeSummary{},
	}, nil
}

func (fakeReader) Services(context.Context) ([]model.ServiceSummary, error) {
	return []model.ServiceSummary{{ID: "service-1"}}, nil
}

func (fakeReader) Service(context.Context, string) (model.ServiceDetailResponse, error) {
	return model.ServiceDetailResponse{
		Service: model.ServiceSummary{
			ID:          "service-1",
			Version:     1,
			SpecHash:    "before",
			ForceUpdate: 0,
		},
		Tasks: []model.TaskSummary{},
	}, nil
}

func (fakeReader) ServiceTasks(context.Context, string) ([]model.TaskSummary, error) {
	return []model.TaskSummary{}, nil
}

func (fakeReader) CheckServicePlacement(
	context.Context,
	string,
) (model.ServicePlacementResponse, error) {
	return model.ServicePlacementResponse{
		ServiceID:              "service-1",
		Status:                 model.PlacementStatusConverged,
		DesiredReplicas:        1,
		RunningReplicas:        1,
		Reasons:                []string{},
		UnsupportedConstraints: []string{},
		Violations:             []model.PlacementViolation{},
	}, nil
}

func (fakeReader) CheckServiceCapacity(
	context.Context,
	string,
	model.CapacityCheckRequest,
) (model.CapacityCheckResponse, error) {
	return model.CapacityCheckResponse{
		ServiceID:                     "service-1",
		Status:                        model.CapacityStatusSufficient,
		CurrentReplicas:               1,
		TargetReplicas:                2,
		RequiredAdditionalReplicas:    1,
		SchedulableAdditionalReplicas: 1,
		Reservation:                   model.CapacityResource{},
		Reasons:                       []string{},
		UnsupportedConstraints:        []string{},
		Nodes:                         []model.CapacityNode{},
	}, nil
}

func (fakeReader) Node(context.Context, string) (model.NodeDetailResponse, error) {
	return model.NodeDetailResponse{
		Node: model.NodeSummary{
			ID:           "node-1",
			Version:      1,
			SpecHash:     "node-before",
			Availability: "active",
		},
		Tasks:      []model.TaskSummary{},
		ServiceIDs: []string{},
	}, nil
}

func (fakeReader) PlanDrainNode(
	context.Context,
	string,
	uint64,
) (model.NodeMutationPlan, error) {
	return model.NodeMutationPlan{
		NodeID:             "node-1",
		Version:            1,
		BeforeSpecHash:     "node-before",
		TargetSpecHash:     "node-drain",
		TargetAvailability: "drain",
		AffectedServiceIDs: []string{},
	}, nil
}

func (fakeReader) PlanActivateNode(
	context.Context,
	string,
	uint64,
) (model.NodeMutationPlan, error) {
	return model.NodeMutationPlan{
		NodeID:             "node-1",
		Version:            1,
		BeforeSpecHash:     "node-before",
		TargetSpecHash:     "node-active",
		TargetAvailability: "active",
		AffectedServiceIDs: []string{},
	}, nil
}

func (fakeReader) DrainNode(
	context.Context,
	string,
	model.NodeMutationRequest,
) (model.NodeMutationResponse, error) {
	return model.NodeMutationResponse{
		NodeID:             "node-1",
		Version:            2,
		TargetSpecHash:     "node-drain",
		TargetAvailability: "drain",
	}, nil
}

func (fakeReader) ActivateNode(
	context.Context,
	string,
	model.NodeMutationRequest,
) (model.NodeMutationResponse, error) {
	return model.NodeMutationResponse{
		NodeID:             "node-1",
		Version:            2,
		TargetSpecHash:     "node-active",
		TargetAvailability: "active",
	}, nil
}

func (fakeReader) PlanNodeLabels(
	context.Context,
	string,
	model.NodeLabelPatchRequest,
) (model.NodeMutationPlan, error) {
	return model.NodeMutationPlan{
		NodeID:             "node-1",
		Version:            1,
		BeforeSpecHash:     "node-before",
		TargetSpecHash:     "node-labels",
		TargetAvailability: "active",
		AffectedServiceIDs: []string{},
		TargetLabels: func() *map[string]string {
			labels := map[string]string{"zone": "a"}
			return &labels
		}(),
	}, nil
}

func (fakeReader) UpdateNodeLabels(
	context.Context,
	string,
	model.NodeMutationRequest,
) (model.NodeMutationResponse, error) {
	return model.NodeMutationResponse{
		NodeID:             "node-1",
		Version:            2,
		TargetSpecHash:     "node-labels",
		TargetAvailability: "active",
	}, nil
}

func (fakeReader) PlanScaleService(
	context.Context,
	string,
	uint64,
	uint64,
) (model.ServiceMutationPlan, error) {
	replicas := uint64(2)
	return model.ServiceMutationPlan{
		ServiceID:         "service-1",
		Version:           1,
		BeforeSpecHash:    "before",
		TargetSpecHash:    "target",
		TargetForceUpdate: 0,
		TargetReplicas:    &replicas,
	}, nil
}

func (fakeReader) PlanRestartService(
	context.Context,
	string,
	uint64,
) (model.ServiceMutationPlan, error) {
	return model.ServiceMutationPlan{
		ServiceID:         "service-1",
		Version:           1,
		BeforeSpecHash:    "before",
		TargetSpecHash:    "target",
		TargetForceUpdate: 1,
	}, nil
}

func (fakeReader) ScaleService(
	context.Context,
	string,
	model.ServiceMutationRequest,
) (model.ServiceMutationResponse, error) {
	return model.ServiceMutationResponse{
		ServiceID:         "service-1",
		Version:           2,
		TargetSpecHash:    "target",
		TargetForceUpdate: 0,
	}, nil
}

func (fakeReader) RestartService(
	context.Context,
	string,
	model.ServiceMutationRequest,
) (model.ServiceMutationResponse, error) {
	return model.ServiceMutationResponse{
		ServiceID:         "service-1",
		Version:           2,
		TargetSpecHash:    "target",
		TargetForceUpdate: 1,
	}, nil
}

func TestHealth(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestCluster(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(http.MethodGet, "/v1/cluster", nil)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestServices(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(http.MethodGet, "/v1/services", nil)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestPlanRestart(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/services/service-1/plan-restart",
		strings.NewReader(`{"expectedVersion":1}`),
	)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestNodeDetail(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(http.MethodGet, "/v1/nodes/node-1", nil)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestPlanDrainNode(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/nodes/node-1/plan-drain",
		strings.NewReader(`{"expectedVersion":1}`),
	)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestPlanNodeLabels(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/nodes/node-1/plan-labels",
		strings.NewReader(`{"expectedVersion":1,"set":{"zone":"a"},"remove":[]}`),
	)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestServiceCapacityCheck(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/services/service-1/capacity-check",
		strings.NewReader(`{"expectedVersion":1,"targetReplicas":2,"includeUpdateOverlap":false}`),
	)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}

func TestServicePlacementCheck(t *testing.T) {
	s := New(config.Config{InsecureDev: true}, fakeReader{})
	req := httptest.NewRequest(
		http.MethodGet,
		"/v1/services/service-1/placement-check",
		nil,
	)
	res := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", res.Code)
	}
}
