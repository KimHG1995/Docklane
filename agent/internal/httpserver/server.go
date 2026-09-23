package httpserver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/dockerengine"
	"github.com/KimHG1995/Docklane/agent/internal/model"
)

type DockerReader interface {
	Cluster(context.Context) (model.ClusterResponse, error)
	Services(context.Context) ([]model.ServiceSummary, error)
	Service(context.Context, string) (model.ServiceDetailResponse, error)
	ServiceTasks(context.Context, string) ([]model.TaskSummary, error)
	Node(context.Context, string) (model.NodeDetailResponse, error)
	PlanDrainNode(context.Context, string, uint64) (model.NodeMutationPlan, error)
	PlanActivateNode(context.Context, string, uint64) (model.NodeMutationPlan, error)
	DrainNode(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error)
	ActivateNode(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error)
	PlanNodeLabels(context.Context, string, model.NodeLabelPatchRequest) (model.NodeMutationPlan, error)
	UpdateNodeLabels(context.Context, string, model.NodeMutationRequest) (model.NodeMutationResponse, error)
	PlanScaleService(context.Context, string, uint64, uint64) (model.ServiceMutationPlan, error)
	PlanRestartService(context.Context, string, uint64) (model.ServiceMutationPlan, error)
	ScaleService(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error)
	RestartService(context.Context, string, model.ServiceMutationRequest) (model.ServiceMutationResponse, error)
}

type Server struct {
	cfg    config.Config
	reader DockerReader
	server *http.Server
}

func New(cfg config.Config, reader DockerReader) *Server {
	s := &Server{cfg: cfg, reader: reader}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("GET /v1/cluster", s.cluster)
	mux.HandleFunc("GET /v1/services", s.services)
	mux.HandleFunc("GET /v1/services/{serviceId}", s.service)
	mux.HandleFunc("GET /v1/services/{serviceId}/tasks", s.serviceTasks)
	mux.HandleFunc("GET /v1/nodes/{nodeId}", s.node)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/plan-drain", s.planDrainNode)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/drain", s.drainNode)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/plan-activate", s.planActivateNode)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/activate", s.activateNode)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/plan-labels", s.planNodeLabels)
	mux.HandleFunc("POST /v1/nodes/{nodeId}/labels", s.updateNodeLabels)
	mux.HandleFunc("POST /v1/services/{serviceId}/plan-scale", s.planScaleService)
	mux.HandleFunc("POST /v1/services/{serviceId}/plan-restart", s.planRestartService)
	mux.HandleFunc("POST /v1/services/{serviceId}/scale", s.scaleService)
	mux.HandleFunc("POST /v1/services/{serviceId}/restart", s.restartService)

	s.server = &http.Server{
		Addr:              cfg.Addr,
		Handler:           requestLogger(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	return s
}

func (s *Server) ListenAndServe() error {
	if s.cfg.InsecureDev {
		slog.Warn("starting agent without mTLS because DOCKLANE_AGENT_INSECURE_DEV=true")
		return s.server.ListenAndServe()
	}

	tlsConfig, err := loadMTLSConfig(s.cfg)
	if err != nil {
		return err
	}
	s.server.TLSConfig = tlsConfig
	return s.server.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.server.Shutdown(ctx)
}

func loadMTLSConfig(cfg config.Config) (*tls.Config, error) {
	caPEM, err := os.ReadFile(cfg.TLSCAFile)
	if err != nil {
		return nil, fmt.Errorf("read client CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("parse client CA")
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  pool,
	}, nil
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"component": "docklane-agent",
	})
}

func (s *Server) cluster(w http.ResponseWriter, r *http.Request) {
	data, err := s.reader.Cluster(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) services(w http.ResponseWriter, r *http.Request) {
	data, err := s.reader.Services(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) service(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	data, err := s.reader.Service(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) serviceTasks(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	data, err := s.reader.ServiceTasks(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) node(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	data, err := s.reader.Node(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) planDrainNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.PlanDrainNode(r.Context(), id, input.ExpectedVersion)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) drainNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.DrainNode(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) planActivateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.PlanActivateNode(r.Context(), id, input.ExpectedVersion)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) activateNode(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.ActivateNode(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) planNodeLabels(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeLabelPatchRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.PlanNodeLabels(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) updateNodeLabels(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("nodeId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("nodeId is required"))
		return
	}

	var input model.NodeMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if input.TargetLabels == nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("targetLabels is required"))
		return
	}

	result, err := s.reader.UpdateNodeLabels(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) planScaleService(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	var input model.ServiceMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if input.Replicas == nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("replicas is required"))
		return
	}

	result, err := s.reader.PlanScaleService(
		r.Context(),
		id,
		input.ExpectedVersion,
		*input.Replicas,
	)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) planRestartService(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	var input model.ServiceMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.PlanRestartService(
		r.Context(),
		id,
		input.ExpectedVersion,
	)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) scaleService(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	var input model.ServiceMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if input.Replicas == nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("replicas is required"))
		return
	}

	result, err := s.reader.ScaleService(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) restartService(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	var input model.ServiceMutationRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.RestartService(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func decodeJSON(r *http.Request, target any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	decoder.DisallowUnknownFields()

	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("request must contain a single JSON object")
	}
	return nil
}

func writeMutationError(w http.ResponseWriter, err error) {
	var conflict *dockerengine.ConflictError
	if errors.As(err, &conflict) {
		writeError(w, http.StatusConflict, err)
		return
	}

	var validation *dockerengine.ValidationError
	if errors.As(err, &validation) {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	writeError(w, http.StatusBadGateway, err)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("encode response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "duration", time.Since(start))
	})
}
