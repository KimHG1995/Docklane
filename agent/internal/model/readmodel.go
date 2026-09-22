package model

import "time"

type ManagerQuorum struct {
	Total       int  `json:"total"`
	Reachable   int  `json:"reachable"`
	Required    int  `json:"required"`
	Available   bool `json:"available"`
	LeaderCount int  `json:"leaderCount"`
}

type NodeSummary struct {
	ID            string `json:"id"`
	Version       uint64 `json:"version"`
	SpecHash      string `json:"specHash"`
	Hostname      string `json:"hostname"`
	Address       string `json:"address"`
	Role          string `json:"role"`
	Availability  string `json:"availability"`
	State         string `json:"state"`
	Message       string `json:"message,omitempty"`
	Manager       bool   `json:"manager"`
	Leader        bool   `json:"leader"`
	Reachability  string `json:"reachability,omitempty"`
	EngineVersion string `json:"engineVersion,omitempty"`
	NanoCPUs      int64  `json:"nanoCpus"`
	MemoryBytes   int64  `json:"memoryBytes"`
}

type ClusterSummary struct {
	ID            string        `json:"id"`
	DockerVersion string        `json:"dockerVersion"`
	APIVersion    string        `json:"apiVersion"`
	CreatedAt     time.Time     `json:"createdAt"`
	UpdatedAt     time.Time     `json:"updatedAt"`
	Managers      ManagerQuorum `json:"managers"`
}

type ClusterResponse struct {
	Cluster ClusterSummary `json:"cluster"`
	Nodes   []NodeSummary  `json:"nodes"`
}

type ServiceSummary struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Version         uint64    `json:"version"`
	SpecHash        string    `json:"specHash"`
	ForceUpdate     uint64    `json:"forceUpdate"`
	Image           string    `json:"image,omitempty"`
	Mode            string    `json:"mode"`
	DesiredReplicas uint64    `json:"desiredReplicas"`
	RunningReplicas uint64    `json:"runningReplicas"`
	UpdateState     string    `json:"updateState,omitempty"`
	UpdateMessage   string    `json:"updateMessage,omitempty"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type TaskSummary struct {
	ID           string    `json:"id"`
	ServiceID    string    `json:"serviceId"`
	Slot         int       `json:"slot"`
	NodeID       string    `json:"nodeId,omitempty"`
	DesiredState string    `json:"desiredState"`
	State        string    `json:"state"`
	ForceUpdate  uint64    `json:"forceUpdate"`
	Message      string    `json:"message,omitempty"`
	Error        string    `json:"error,omitempty"`
	ContainerID  string    `json:"containerId,omitempty"`
	Image        string    `json:"image,omitempty"`
	Timestamp    time.Time `json:"timestamp"`
}

type ServiceDetailResponse struct {
	Service ServiceSummary `json:"service"`
	Tasks   []TaskSummary  `json:"tasks"`
}

type ServiceMutationRequest struct {
	ExpectedVersion  uint64  `json:"expectedVersion"`
	ExpectedSpecHash string  `json:"expectedSpecHash"`
	TargetSpecHash   string  `json:"targetSpecHash"`
	Replicas         *uint64 `json:"replicas,omitempty"`
}

type ServiceMutationPlan struct {
	ServiceID         string  `json:"serviceId"`
	Version           uint64  `json:"version"`
	BeforeSpecHash    string  `json:"beforeSpecHash"`
	TargetSpecHash    string  `json:"targetSpecHash"`
	TargetForceUpdate uint64  `json:"targetForceUpdate"`
	TargetReplicas    *uint64 `json:"targetReplicas,omitempty"`
}

type ServiceMutationResponse struct {
	ServiceID         string   `json:"serviceId"`
	Version           uint64   `json:"version"`
	TargetSpecHash    string   `json:"targetSpecHash"`
	TargetForceUpdate uint64   `json:"targetForceUpdate"`
	Warnings          []string `json:"warnings,omitempty"`
}


type NodeDetailResponse struct {
	Node       NodeSummary   `json:"node"`
	Tasks      []TaskSummary `json:"tasks"`
	ServiceIDs []string      `json:"serviceIds"`
}

type NodeMutationRequest struct {
	ExpectedVersion  uint64 `json:"expectedVersion"`
	ExpectedSpecHash string `json:"expectedSpecHash"`
	TargetSpecHash   string `json:"targetSpecHash"`
}

type NodeMutationPlan struct {
	NodeID             string   `json:"nodeId"`
	Version            uint64   `json:"version"`
	BeforeSpecHash     string   `json:"beforeSpecHash"`
	TargetSpecHash     string   `json:"targetSpecHash"`
	TargetAvailability string   `json:"targetAvailability"`
	AffectedServiceIDs []string `json:"affectedServiceIds"`
}

type NodeMutationResponse struct {
	NodeID             string `json:"nodeId"`
	Version            uint64 `json:"version"`
	TargetSpecHash     string `json:"targetSpecHash"`
	TargetAvailability string `json:"targetAvailability"`
}
