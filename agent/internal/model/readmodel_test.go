package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNodeLabelPlanMarshalsExplicitEmptyTargetLabels(t *testing.T) {
	labels := map[string]string{}
	payload, err := json.Marshal(NodeMutationPlan{
		NodeID:             "node-1",
		Version:            1,
		BeforeSpecHash:     "before",
		TargetSpecHash:     "target",
		TargetAvailability: "active",
		AffectedServiceIDs: []string{},
		TargetLabels:       &labels,
	})
	if err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(string(payload), `"targetLabels":{}`) {
		t.Fatalf("expected explicit empty targetLabels, got %s", payload)
	}
	if !strings.Contains(string(payload), `"affectedServiceIds":[]`) {
		t.Fatalf("expected explicit empty affectedServiceIds, got %s", payload)
	}
}
