package dockerengine

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	cerrdefs "github.com/containerd/errdefs"

	"github.com/KimHG1995/Docklane/agent/internal/model"
)

func TestMapServiceUpdateErrorMapsConflict(t *testing.T) {
	err := mapServiceUpdateError(
		"restart",
		"service-1",
		fmt.Errorf("docker update: %w", cerrdefs.ErrConflict),
	)

	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected ConflictError, got %T: %v", err, err)
	}
}

func TestMapServiceUpdateErrorKeepsUnexpectedError(t *testing.T) {
	err := mapServiceUpdateError("scale", "service-1", errors.New("boom"))

	var conflict *ConflictError
	if errors.As(err, &conflict) {
		t.Fatalf("did not expect ConflictError: %v", err)
	}
}


func TestNodeMutationPlanSerializesEmptyAffectedServicesAsArray(t *testing.T) {
	payload, err := json.Marshal(model.NodeMutationPlan{
		NodeID:             "node-1",
		Version:            1,
		BeforeSpecHash:     "before",
		TargetSpecHash:     "target",
		TargetAvailability: "active",
		AffectedServiceIDs: make([]string, 0),
	})
	if err != nil {
		t.Fatalf("marshal node plan: %v", err)
	}

	body := string(payload)
	if !strings.Contains(body, `"affectedServiceIds":[]`) {
		t.Fatalf("expected empty array, got %s", body)
	}
}
