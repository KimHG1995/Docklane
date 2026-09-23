package httpserver

import (
	"fmt"
	"net/http"

	"github.com/KimHG1995/Docklane/agent/internal/model"
)

func (s *Server) capacityCheck(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("serviceId")
	if id == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("serviceId is required"))
		return
	}

	var input model.CapacityCheckRequest
	if err := decodeJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	result, err := s.reader.CheckServiceCapacity(r.Context(), id, input)
	if err != nil {
		writeMutationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
