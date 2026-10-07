package httpserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/model"
)

// Embed the interface so an unexpected read/plan call fails instead of silently
// succeeding. All seven actual mutations below count dispatches independently.
type clusterPreconditionReader struct {
	DockerReader
	cluster       string
	identityErr   error
	manager       bool
	identityCalls int
	mutations     []string
}

func (f *clusterPreconditionReader) Identity(context.Context) (model.AgentIdentityResponse, error) {
	f.identityCalls++
	return model.AgentIdentityResponse{Component: "docklane-agent", ClusterID: f.cluster,
		NodeID: "manager-1", Manager: f.manager}, f.identityErr
}
func (f *clusterPreconditionReader) DrainNode(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error) {
	f.mutations = append(f.mutations, "drain")
	return model.NodeMutationResponse{}, nil
}
func (f *clusterPreconditionReader) ActivateNode(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error) {
	f.mutations = append(f.mutations, "activate")
	return model.NodeMutationResponse{}, nil
}
func (f *clusterPreconditionReader) UpdateNodeLabels(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error) {
	f.mutations = append(f.mutations, "labels")
	return model.NodeMutationResponse{}, nil
}
func (f *clusterPreconditionReader) ScaleService(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error) {
	f.mutations = append(f.mutations, "scale")
	return model.ServiceMutationResponse{}, nil
}
func (f *clusterPreconditionReader) RestartService(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error) {
	f.mutations = append(f.mutations, "restart")
	return model.ServiceMutationResponse{}, nil
}
func (f *clusterPreconditionReader) UpdateServiceImage(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error) {
	f.mutations = append(f.mutations, "image")
	return model.ServiceMutationResponse{}, nil
}
func (f *clusterPreconditionReader) RollbackService(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error) {
	f.mutations = append(f.mutations, "rollback")
	return model.ServiceMutationResponse{}, nil
}

var guardedMutationCases = []struct{ path, body, action string }{
	{"nodes/node-1/drain", `{}`, "drain"},
	{"nodes/node-1/activate", `{}`, "activate"},
	{"nodes/node-1/labels", `{"targetLabels":{}}`, "labels"},
	{"services/service-1/scale", `{"replicas":2}`, "scale"},
	{"services/service-1/restart", `{}`, "restart"},
	{"services/service-1/image", `{"image":"registry/image@sha256:abc"}`, "image"},
	{"services/service-1/rollback", `{}`, "rollback"},
}

func TestMutationClusterPreconditionAllRoutes(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		for _, route := range guardedMutationCases {
			for _, tc := range []struct {
				expected string
				status   int
				writes   int
			}{
				{"cluster-a", http.StatusOK, 1},
				{"cluster-b", http.StatusPreconditionFailed, 0},
				{"", http.StatusPreconditionRequired, 0},
			} {
				t.Run(version+"/"+route.action+"/"+tc.expected, func(t *testing.T) {
					reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
					s := New(config.Config{}, reader)
					r := httptest.NewRequest(http.MethodPost, "/"+version+"/"+route.path, strings.NewReader(route.body))
					if tc.expected != "" {
						r.Header.Set("X-Docklane-Expected-Cluster-ID", tc.expected)
					}
					w := httptest.NewRecorder()
					s.server.Handler.ServeHTTP(w, r)
					if w.Code != tc.status || len(reader.mutations) != tc.writes {
						t.Fatalf("status=%d want=%d writes=%v body=%s", w.Code, tc.status, reader.mutations, w.Body.String())
					}
					if tc.writes == 1 && reader.mutations[0] != route.action {
						t.Fatal("wrong mutation handler")
					}
					if tc.expected == "" && reader.identityCalls != 0 {
						t.Fatal("missing precondition contacted Docker")
					}
				})
			}
		}
	}
}

func TestMutationClusterPreconditionRechecksAfterIdentityRead(t *testing.T) {
	reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
	s := New(config.Config{}, reader)
	s.server.Handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/v1/identity", nil))
	reader.cluster = "cluster-b" // Same endpoint, no observed transport outage.
	r := httptest.NewRequest(http.MethodPost, "/v2/services/service-1/restart", strings.NewReader(`{}`))
	r.Header.Set("X-Docklane-Expected-Cluster-ID", "cluster-a")
	w := httptest.NewRecorder()
	s.server.Handler.ServeHTTP(w, r)
	if w.Code != http.StatusPreconditionFailed || len(reader.mutations) != 0 || reader.identityCalls != 2 {
		t.Fatalf("stale identity authorized mutation: status=%d writes=%v identities=%d", w.Code, reader.mutations, reader.identityCalls)
	}
}

type clusterSwitchBody struct {
	io.Reader
	onRead func()
}

func (b *clusterSwitchBody) Read(p []byte) (int, error) {
	if b.onRead != nil {
		b.onRead()
		b.onRead = nil
	}
	return b.Reader.Read(p)
}
func (b *clusterSwitchBody) Close() error { return nil }

func TestMutationClusterPreconditionRunsAfterBodyDecode(t *testing.T) {
	reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
	s := New(config.Config{}, reader)
	body := &clusterSwitchBody{Reader: strings.NewReader(`{}`), onRead: func() { reader.cluster = "cluster-b" }}
	r := httptest.NewRequest(http.MethodPost, "/v2/services/service-1/restart", body)
	r.Header.Set("X-Docklane-Expected-Cluster-ID", "cluster-a")
	w := httptest.NewRecorder()
	s.server.Handler.ServeHTTP(w, r)
	if w.Code != http.StatusPreconditionFailed || len(reader.mutations) != 0 {
		t.Fatalf("body delay bypass: %d %v", w.Code, reader.mutations)
	}
}

func TestMutationClusterPreconditionRejectsAmbiguousHeaders(t *testing.T) {
	for _, values := range [][]string{{"cluster-a", "cluster-a"}, {"cluster-a", "cluster-b"}, {"cluster-a,cluster-b"}, {" cluster-a"}, {""}, {strings.Repeat("a", 129)}, {"a\t"}, {"a/b"}} {
		t.Run(strings.Join(values, "|"), func(t *testing.T) {
			reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
			s := New(config.Config{}, reader)
			r := httptest.NewRequest(http.MethodPost, "/v2/services/service-1/restart", strings.NewReader(`{}`))
			for _, v := range values {
				r.Header.Add("X-Docklane-Expected-Cluster-ID", v)
			}
			w := httptest.NewRecorder()
			s.server.Handler.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest || len(reader.mutations) != 0 || reader.identityCalls != 0 {
				t.Fatalf("ambiguous precondition allowed: %d %v", w.Code, reader.mutations)
			}
		})
	}
}

func TestMutationClusterPreconditionFailsClosedOnUnknownIdentity(t *testing.T) {
	for _, tc := range []struct {
		cluster string
		manager bool
		err     error
	}{{"cluster-a", true, errors.New("private daemon details")}, {"", true, nil}, {"cluster-a", false, nil}} {
		reader := &clusterPreconditionReader{cluster: tc.cluster, manager: tc.manager, identityErr: tc.err}
		s := New(config.Config{}, reader)
		r := httptest.NewRequest(http.MethodPost, "/v2/services/service-1/restart", strings.NewReader(`{}`))
		r.Header.Set("X-Docklane-Expected-Cluster-ID", "cluster-a")
		w := httptest.NewRecorder()
		s.server.Handler.ServeHTTP(w, r)
		if w.Code != http.StatusServiceUnavailable || len(reader.mutations) != 0 || strings.Contains(w.Body.String(), "private daemon") {
			t.Fatalf("unknown identity not closed: %d %v %s", w.Code, reader.mutations, w.Body.String())
		}
	}
}

func TestMutationClusterPreconditionHonorsCancelledRequest(t *testing.T) {
	reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
	s := New(config.Config{}, reader)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest(http.MethodPost, "/v2/services/service-1/restart", strings.NewReader(`{}`)).WithContext(ctx)
	r.Header.Set("X-Docklane-Expected-Cluster-ID", "cluster-a")
	w := httptest.NewRecorder()
	s.server.Handler.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable || len(reader.mutations) != 0 {
		t.Fatalf("cancelled request dispatched: %d", w.Code)
	}
}

func TestMutationClusterPreconditionDoesNotChangeDiscovery(t *testing.T) {
	reader := &clusterPreconditionReader{cluster: "cluster-a", manager: true}
	s := New(config.Config{}, reader)
	for _, path := range []string{"/v1/health", "/v1/identity"} {
		w := httptest.NewRecorder()
		s.server.Handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("discovery requires mutation header: %s=%d", path, w.Code)
		}
	}
	if len(reader.mutations) != 0 {
		t.Fatal("discovery mutated")
	}
}
