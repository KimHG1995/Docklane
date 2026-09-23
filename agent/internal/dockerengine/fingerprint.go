package dockerengine

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/moby/moby/api/types/swarm"
)

func serviceSpecHash(spec swarm.ServiceSpec) (string, error) {
	return specHash("service", spec)
}

func nodeSpecHash(spec swarm.NodeSpec) (string, error) {
	return specHash("node", spec)
}

func specHash(kind string, spec any) (string, error) {
	payload, err := json.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("marshal %s spec: %w", kind, err)
	}
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:]), nil
}
