package httpserver

import (
	"context"
	"net/http"
	"regexp"
	"time"
)

const expectedClusterHeader = "X-Docklane-Expected-Cluster-ID"

var clusterIDValue = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// requireMutationCluster is called after body validation, immediately before
// dispatching the mutation. Identity from an earlier HTTP request is never used.
// This is an Agent admission check, not an atomic Docker inspect/update primitive.
func (s *Server) requireMutationCluster(w http.ResponseWriter, r *http.Request) bool {
	values := r.Header.Values(expectedClusterHeader)
	if len(values) == 0 {
		writeJSON(w, http.StatusPreconditionRequired, map[string]string{
			"code": "CLUSTER_PRECONDITION_REQUIRED", "error": "expected cluster header is required",
		})
		return false
	}
	if len(values) != 1 || !clusterIDValue.MatchString(values[0]) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"code": "INVALID_CLUSTER_PRECONDITION", "error": "expected cluster header must be one bounded identifier",
		})
		return false
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if ctx.Err() != nil {
		writeClusterUnavailable(w)
		return false
	}
	identity, err := s.reader.Identity(ctx)
	if err != nil || ctx.Err() != nil || !identity.Manager || identity.ClusterID == "" || identity.NodeID == "" {
		writeClusterUnavailable(w)
		return false
	}
	if identity.ClusterID != values[0] {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{
			"code": "CLUSTER_PRECONDITION_FAILED", "error": "current cluster does not match the mutation target",
		})
		return false
	}
	return true
}

func writeClusterUnavailable(w http.ResponseWriter) {
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{
		"code": "CLUSTER_IDENTITY_UNAVAILABLE", "error": "current manager cluster identity could not be verified",
	})
}
