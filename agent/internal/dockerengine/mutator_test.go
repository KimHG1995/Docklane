package dockerengine

import (
	"errors"
	"fmt"
	"testing"

	cerrdefs "github.com/containerd/errdefs"
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
