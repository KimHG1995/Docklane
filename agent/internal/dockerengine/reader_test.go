package dockerengine

import (
	"testing"
	"time"

	"github.com/KimHG1995/Docklane/agent/internal/model"
)

func TestCountDesiredRunningTasksExcludesShutdownOverlap(t *testing.T) {
	tasks := []model.TaskSummary{
		{
			ID:           "old",
			DesiredState: "shutdown",
			State:        "running",
			Timestamp:    time.Unix(1, 0),
		},
		{
			ID:           "replacement",
			DesiredState: "running",
			State:        "running",
			Timestamp:    time.Unix(2, 0),
		},
		{
			ID:           "pending",
			DesiredState: "running",
			State:        "preparing",
			Timestamp:    time.Unix(3, 0),
		},
	}

	if got := countDesiredRunningTasks(tasks); got != 1 {
		t.Fatalf("expected one desired running task, got %d", got)
	}
}
