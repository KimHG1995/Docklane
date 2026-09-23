package httpserver

import (
	"fmt"
	"net/http"
)

func (s *Server) placementCheck(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	result, err := s.reader.CheckServicePlacement(r.Context(), id)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
