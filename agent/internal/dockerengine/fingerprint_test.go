package dockerengine

import (
	"testing"

	"github.com/moby/moby/api/types/swarm"
)

func TestTaskRuntimeSpecHashIgnoresPlacementOnlyChanges(t *testing.T) {
	before := swarm.TaskSpec{
		ContainerSpec: &swarm.ContainerSpec{
			Image: "registry.example.com/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Env:   []string{"APP_ENV=prod"},
		},
		Placement: &swarm.Placement{
			Constraints: []string{"node.labels.zone==a"},
		},
		ForceUpdate: 3,
	}
	after := before
	after.Placement = &swarm.Placement{
		Constraints: []string{"node.labels.zone==b"},
	}

	beforeFull, err := taskSpecHash(before)
	if err != nil {
		t.Fatal(err)
	}
	afterFull, err := taskSpecHash(after)
	if err != nil {
		t.Fatal(err)
	}
	if beforeFull == afterFull {
		t.Fatal("expected full TaskSpec hash to change with placement")
	}

	beforeRuntime, err := taskRuntimeSpecHash(before)
	if err != nil {
		t.Fatal(err)
	}
	afterRuntime, err := taskRuntimeSpecHash(after)
	if err != nil {
		t.Fatal(err)
	}
	if beforeRuntime != afterRuntime {
		t.Fatalf(
			"expected placement-only change to keep runtime hash: before=%s after=%s",
			beforeRuntime,
			afterRuntime,
		)
	}
}

func TestTaskRuntimeSpecHashChangesForRuntimeConfig(t *testing.T) {
	before := swarm.TaskSpec{
		ContainerSpec: &swarm.ContainerSpec{
			Image: "registry.example.com/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Env:   []string{"APP_ENV=prod"},
		},
	}
	after := before
	after.ContainerSpec = &swarm.ContainerSpec{
		Image: before.ContainerSpec.Image,
		Env:   []string{"APP_ENV=staging"},
	}

	beforeHash, err := taskRuntimeSpecHash(before)
	if err != nil {
		t.Fatal(err)
	}
	afterHash, err := taskRuntimeSpecHash(after)
	if err != nil {
		t.Fatal(err)
	}
	if beforeHash == afterHash {
		t.Fatal("expected runtime config change to change runtime hash")
	}
}
