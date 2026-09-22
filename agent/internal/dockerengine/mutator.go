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
	input model.ServiceMutationRequest,
) (model.ServiceMutationResponse, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}
	service := result.Service
	if err := validateMutationPrecondition(service, input); err != nil {
		return model.ServiceMutationResponse{}, err
	}
	if service.Spec.Mode.Replicated == nil || input.Replicas == nil {
		return model.ServiceMutationResponse{}, &ValidationError{
			Message: fmt.Sprintf("service %q is not replicated or replicas are missing", serviceID),
		}
	}

	service.Spec.Mode.Replicated.Replicas = input.Replicas
	targetHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationResponse{}, err
	}
	if targetHash != input.TargetSpecHash {
		return model.ServiceMutationResponse{}, &ConflictError{
			Message: "target service spec changed after mutation planning",
		}
	}

	update, err := r.client.ServiceUpdate(ctx, service.ID, client.ServiceUpdateOptions{
		Version: swarm.Version{Index: input.ExpectedVersion},
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
		ServiceID:         service.ID,
		Version:           after.Service.Version.Index,
		TargetSpecHash:    targetHash,
		TargetForceUpdate: service.Spec.TaskTemplate.ForceUpdate,
		Warnings:          update.Warnings,
	}, nil
}

func (r *Reader) RestartService(
	ctx context.Context,
	serviceID string,
	input model.ServiceMutationRequest,
) (model.ServiceMutationResponse, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationResponse{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}
	service := result.Service
	if err := validateMutationPrecondition(service, input); err != nil {
		return model.ServiceMutationResponse{}, err
	}

	service.Spec.TaskTemplate.ForceUpdate++
	targetHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationResponse{}, err
	}
	if targetHash != input.TargetSpecHash {
		return model.ServiceMutationResponse{}, &ConflictError{
			Message: "target service spec changed after mutation planning",
		}
	}

	update, err := r.client.ServiceUpdate(ctx, service.ID, client.ServiceUpdateOptions{
		Version: swarm.Version{Index: input.ExpectedVersion},
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
		ServiceID:         service.ID,
		Version:           after.Service.Version.Index,
		TargetSpecHash:    targetHash,
		TargetForceUpdate: service.Spec.TaskTemplate.ForceUpdate,
		Warnings:          update.Warnings,
	}, nil
}

func validateMutationPrecondition(
	service swarm.Service,
	input model.ServiceMutationRequest,
) error {
	if service.Version.Index != input.ExpectedVersion {
		return &ConflictError{Message: fmt.Sprintf(
			"service version conflict: expected %d, got %d",
			input.ExpectedVersion,
			service.Version.Index,
		)}
	}
	currentHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return err
	}
	if currentHash != input.ExpectedSpecHash {
		return &ConflictError{Message: "service spec changed after mutation planning"}
	}
	return nil
}
