package model

type CapacityStatus string

const (
	CapacityStatusSufficient   CapacityStatus = "SUFFICIENT"
	CapacityStatusInsufficient CapacityStatus = "INSUFFICIENT"
	CapacityStatusUnknown      CapacityStatus = "UNKNOWN"
)

type CapacityCheckRequest struct {
	ExpectedVersion      uint64 `json:"expectedVersion"`
	TargetReplicas       uint64 `json:"targetReplicas"`
	IncludeUpdateOverlap bool   `json:"includeUpdateOverlap"`
}

type CapacityResource struct {
	NanoCPUs    int64 `json:"nanoCpus"`
	MemoryBytes int64 `json:"memoryBytes"`
}

type CapacityNode struct {
	NodeID                string `json:"nodeId"`
	Hostname              string `json:"hostname"`
	AvailableNanoCPUs     int64  `json:"availableNanoCpus"`
	AvailableMemoryBytes  int64  `json:"availableMemoryBytes"`
	ExistingServiceTasks  uint64 `json:"existingServiceTasks"`
	MaxAdditionalReplicas uint64 `json:"maxAdditionalReplicas"`
}

type CapacityCheckResponse struct {
	ServiceID                     string           `json:"serviceId"`
	Status                        CapacityStatus   `json:"status"`
	CurrentReplicas               uint64           `json:"currentReplicas"`
	TargetReplicas                uint64           `json:"targetReplicas"`
	UpdateOverlapReplicas         uint64           `json:"updateOverlapReplicas"`
	RequiredAdditionalReplicas    uint64           `json:"requiredAdditionalReplicas"`
	SchedulableAdditionalReplicas uint64           `json:"schedulableAdditionalReplicas"`
	UnplacedReplicas              uint64           `json:"unplacedReplicas"`
	EligibleNodeCount             int              `json:"eligibleNodeCount"`
	Reservation                   CapacityResource `json:"reservation"`
	Reasons                       []string         `json:"reasons"`
	UnsupportedConstraints        []string         `json:"unsupportedConstraints"`
	Nodes                         []CapacityNode   `json:"nodes"`
}
