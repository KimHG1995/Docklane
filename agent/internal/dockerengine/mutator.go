package dockerengine

import (
	"context"
	"fmt"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/api/types/swarm"
	"github.com/moby/moby/client"
)

func (r *Reader) ScaleService(
	ctx context.Context,
	serviceID string,
	expectedVersion uint64,
	replicas uint64,
) (model.ServiceMutationResponse, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}

	service := result.Service
	if service.Version.Index != expectedVersion {
		return model.ServiceMutationResponse{}, fmt.Errorf(
			"service version conflict: expected %d, got %d",
			expectedVersion,
			service.Version.Index,
		)
	}
	if service.Spec.Mode.Replicated == nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("service %q is not replicated", serviceID)
	}

	service.Spec.Mode.Replicated.Replicas = &replicas
	update, err := r.client.ServiceUpdate(ctx, service.ID, client.ServiceUpdateOptions{
		Version: swarm.Version{Index: expectedVersion},
		Spec:    service.Spec,
	})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("scale service %q: %w", serviceID, err)
	}

	after, err := r.client.ServiceInspect(ctx, service.ID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect updated service %q: %w", serviceID, err)
	}

	return model.ServiceMutationResponse{
		ServiceID: service.ID,
		Version:   after.Service.Version.Index,
		Warnings:  update.Warnings,
	}, nil
}

func (r *Reader) RestartService(
	ctx context.Context,
	serviceID string,
	expectedVersion uint64,
) (model.ServiceMutationResponse, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}

	service := result.Service
	if service.Version.Index != expectedVersion {
		return model.ServiceMutationResponse{}, fmt.Errorf(
			"service version conflict: expected %d, got %d",
			expectedVersion,
			service.Version.Index,
		)
	}

	service.Spec.TaskTemplate.ForceUpdate++
	update, err := r.client.ServiceUpdate(ctx, service.ID, client.ServiceUpdateOptions{
		Version: swarm.Version{Index: expectedVersion},
		Spec:    service.Spec,
	})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("restart service %q: %w", serviceID, err)
	}

	after, err := r.client.ServiceInspect(ctx, service.ID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect updated service %q: %w", serviceID, err)
	}

	return model.ServiceMutationResponse{
		ServiceID: service.ID,
		Version:   after.Service.Version.Index,
		Warnings:  update.Warnings,
	}, nil
}
