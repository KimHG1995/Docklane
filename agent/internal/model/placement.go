package model

type PlacementStatus string

const (
	PlacementStatusConverged PlacementStatus = "CONVERGED"
	PlacementStatusPending   PlacementStatus = "PENDING"
	PlacementStatusUnknown   PlacementStatus = "UNKNOWN"
)

type PlacementViolation struct {
	TaskID string `json:"taskId"`
	NodeID string `json:"nodeId"`
	Reason string `json:"reason"`
}

type ServicePlacementResponse struct {
	ServiceID              string               `json:"serviceId"`
	Status                 PlacementStatus      `json:"status"`
	DesiredReplicas        uint64               `json:"desiredReplicas"`
	RunningReplicas        uint64               `json:"runningReplicas"`
	Reasons                []string             `json:"reasons"`
	UnsupportedConstraints []string             `json:"unsupportedConstraints"`
	Violations             []PlacementViolation `json:"violations"`
}
