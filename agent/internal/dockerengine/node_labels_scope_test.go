package dockerengine

import (
	"testing"

	"github.com/moby/moby/api/types/swarm"
)

func TestAffectedServiceIDsForNodeLabelsScopesConstraintsAndPreferences(t *testing.T) {
	services := []swarm.Service{
		{
			ID: "constraint-zone",
			Spec: swarm.ServiceSpec{
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Constraints: []string{"node.labels.zone==a"},
					},
				},
			},
		},
		{
			ID: "preference-rack",
			Spec: swarm.ServiceSpec{
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Preferences: []swarm.PlacementPreference{
							{Spread: &swarm.SpreadOver{SpreadDescriptor: "node.labels.rack"}},
						},
					},
				},
			},
		},
		{
			ID: "unrelated",
			Spec: swarm.ServiceSpec{
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Constraints: []string{"node.labels.region==kr"},
					},
				},
			},
		},
	}

	got := affectedServiceIDsForNodeLabels(services, []string{"zone", "rack"})
	want := []string{"constraint-zone", "preference-rack"}

	if !equalStrings(got, want) {
		t.Fatalf("expected affected services %v, got %v", want, got)
	}
}

func TestAffectedServiceIDsForNodeLabelsIgnoresUnrelatedLabelChanges(t *testing.T) {
	services := []swarm.Service{
		{
			ID: "service-1",
			Spec: swarm.ServiceSpec{
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Constraints: []string{"node.labels.zone==a"},
					},
				},
			},
		},
	}

	got := affectedServiceIDsForNodeLabels(services, []string{"maintenance"})
	if len(got) != 0 {
		t.Fatalf("expected no affected services, got %v", got)
	}
}

func TestChangedNodeLabelKeysTracksSetRemoveAndNoop(t *testing.T) {
	before := map[string]string{
		"zone": "a",
		"rack": "1",
		"same": "value",
	}
	after := map[string]string{
		"zone": "b",
		"same": "value",
		"new":  "yes",
	}

	got := changedNodeLabelKeys(before, after)
	want := []string{"new", "rack", "zone"}
	if !equalStrings(got, want) {
		t.Fatalf("expected changed keys %v, got %v", want, got)
	}
}

func TestValidateAffectedServiceModesRejectsGlobalService(t *testing.T) {
	services := []swarm.Service{
		{
			ID: "global-service",
			Spec: swarm.ServiceSpec{
				Annotations: swarm.Annotations{Name: "global-service"},
				Mode: swarm.ServiceMode{Global: &swarm.GlobalService{}},
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Constraints: []string{"node.labels.zone==a"},
					},
				},
			},
		},
	}

	err := validateAffectedServiceModes(services, []string{"zone"})
	if err == nil {
		t.Fatal("expected global service to be rejected before label mutation")
	}
	if _, ok := err.(*ValidationError); !ok {
		t.Fatalf("expected ValidationError, got %T: %v", err, err)
	}
}

func TestValidateAffectedServiceModesIgnoresUnrelatedGlobalService(t *testing.T) {
	services := []swarm.Service{
		{
			ID: "global-service",
			Spec: swarm.ServiceSpec{
				Annotations: swarm.Annotations{Name: "global-service"},
				Mode: swarm.ServiceMode{Global: &swarm.GlobalService{}},
				TaskTemplate: swarm.TaskSpec{
					Placement: &swarm.Placement{
						Constraints: []string{"node.labels.region==kr"},
					},
				},
			},
		},
	}

	if err := validateAffectedServiceModes(services, []string{"zone"}); err != nil {
		t.Fatalf("expected unrelated global service to be ignored, got %v", err)
	}
}
