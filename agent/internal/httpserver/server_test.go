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
