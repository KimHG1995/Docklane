package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/config"
)

type fakeReader struct{}

func (fakeReader) Cluster(context.Context) (any, error) {
	return map[string]any{"id": "cluster-1"}, nil
}

func (fakeReader) Service(context.Context, string) (any, error) {
	return map[string]any{"id": "service-1"}, nil
}

func (fakeReader) ServiceTasks(context.Context, string) (any, error) {
	return []any{}, nil
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
