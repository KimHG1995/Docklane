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


func TestTaskRuntimeSpecHashCanonicalizesDefaultContainerRuntime(t *testing.T) {
	implicit := swarm.TaskSpec{
		ContainerSpec: &swarm.ContainerSpec{
			Image: "registry.example.com/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Env:   []string{"APP_ENV=prod"},
		},
	}
	explicit := implicit
	explicit.Runtime = swarm.RuntimeContainer

	implicitHash, err := taskRuntimeSpecHash(implicit)
	if err != nil {
		t.Fatal(err)
	}
	explicitHash, err := taskRuntimeSpecHash(explicit)
	if err != nil {
		t.Fatal(err)
	}
	if implicitHash != explicitHash {
		t.Fatalf(
			"expected implicit and explicit container runtime to match: implicit=%s explicit=%s",
			implicitHash,
			explicitHash,
		)
	}
}

func TestTaskRuntimeSpecHashStillDetectsRuntimeConfigDriftAfterCanonicalization(t *testing.T) {
	target := swarm.TaskSpec{
		ContainerSpec: &swarm.ContainerSpec{
			Image: "registry.example.com/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Env:   []string{"APP_ENV=prod"},
		},
		Runtime: swarm.RuntimeContainer,
	}
	stale := target
	stale.Runtime = ""
	stale.ContainerSpec = &swarm.ContainerSpec{
		Image: target.ContainerSpec.Image,
		Env:   []string{"APP_ENV=staging"},
	}

	targetHash, err := taskRuntimeSpecHash(target)
	if err != nil {
		t.Fatal(err)
	}
	staleHash, err := taskRuntimeSpecHash(stale)
	if err != nil {
		t.Fatal(err)
	}
	if targetHash == staleHash {
		t.Fatal("expected env drift to remain visible after runtime canonicalization")
	}
}
