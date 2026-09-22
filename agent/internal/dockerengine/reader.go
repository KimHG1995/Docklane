package dockerengine

import (
	"context"
	"fmt"

	"github.com/moby/moby/client"
)

type Reader struct {
	client *client.Client
}

type ClusterSnapshot struct {
	Server any `json:"server"`
	Swarm  any `json:"swarm"`
	Nodes  any `json:"nodes"`
}

func NewReader() (*Reader, error) {
	cli, err := client.New(
		client.FromEnv,
		client.WithUserAgent("docklane-agent/pre-alpha"),
	)
	if err != nil {
		return nil, fmt.Errorf("create docker client: %w", err)
	}
	return &Reader{client: cli}, nil
}

func (r *Reader) Close() error {
	return r.client.Close()
}

func (r *Reader) Cluster(ctx context.Context) (any, error) {
	server, err := r.client.ServerVersion(ctx, client.ServerVersionOptions{})
	if err != nil {
		return nil, fmt.Errorf("read docker server version: %w", err)
	}

	swarmResult, err := r.client.SwarmInspect(ctx, client.SwarmInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect swarm: %w", err)
	}

	nodes, err := r.client.NodeList(ctx, client.NodeListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list swarm nodes: %w", err)
	}

	return ClusterSnapshot{
		Server: server,
		Swarm:  swarmResult.Swarm,
		Nodes:  nodes.Items,
	}, nil
}

func (r *Reader) Service(ctx context.Context, serviceID string) (any, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return nil, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}
	return result.Service, nil
}

func (r *Reader) ServiceTasks(ctx context.Context, serviceID string) (any, error) {
	result, err := r.client.TaskList(ctx, client.TaskListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list service tasks: %w", err)
	}

	filtered := result.Items[:0]
	for _, task := range result.Items {
		if task.ServiceID == serviceID {
			filtered = append(filtered, task)
		}
	}
	return filtered, nil
}
