package httpserver

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/KimHG1995/Docklane/agent/internal/config"
	"github.com/KimHG1995/Docklane/agent/internal/model"
)

type DockerReader interface {
	Cluster(context.Context) (model.ClusterResponse, error)
	Services(context.Context) ([]model.ServiceSummary, error)
	Service(context.Context, string) (model.ServiceDetailResponse, error)
	ServiceTasks(context.Context, string) ([]model.TaskSummary, error)
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
