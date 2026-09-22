package dockerengine

import (
	"context"
	"fmt"

	"github.com/KimHG1995/Docklane/agent/internal/model"
	"github.com/moby/moby/client"
)

func (r *Reader) PlanScaleService(
	ctx context.Context,
	serviceID string,
	expectedVersion uint64,
	replicas uint64,
) (model.ServiceMutationPlan, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationPlan{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}
	service := result.Service
	if service.Version.Index != expectedVersion {
		return model.ServiceMutationPlan{}, &ConflictError{Message: fmt.Sprintf(
			"service version conflict: expected %d, got %d",
			expectedVersion,
			service.Version.Index,
		)}
	}
	if service.Spec.Mode.Replicated == nil {
		return model.ServiceMutationPlan{}, &ValidationError{
			Message: fmt.Sprintf("service %q is not replicated", serviceID),
		}
	}

	beforeHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	service.Spec.Mode.Replicated.Replicas = &replicas
	targetHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}

	return model.ServiceMutationPlan{
		ServiceID:         service.ID,
		Version:           service.Version.Index,
		BeforeSpecHash:    beforeHash,
		TargetSpecHash:    targetHash,
		TargetForceUpdate: service.Spec.TaskTemplate.ForceUpdate,
		TargetReplicas:    &replicas,
	}, nil
}

func (r *Reader) PlanRestartService(
	ctx context.Context,
	serviceID string,
	expectedVersion uint64,
) (model.ServiceMutationPlan, error) {
	result, err := r.client.ServiceInspect(ctx, serviceID, client.ServiceInspectOptions{})
	if err != nil {
		return model.ServiceMutationPlan{}, fmt.Errorf("inspect service %q: %w", serviceID, err)
	}
	service := result.Service
	if service.Version.Index != expectedVersion {
		return model.ServiceMutationPlan{}, &ConflictError{Message: fmt.Sprintf(
			"service version conflict: expected %d, got %d",
			expectedVersion,
			service.Version.Index,
		)}
	}

	beforeHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	service.Spec.TaskTemplate.ForceUpdate++
	targetHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}

	return model.ServiceMutationPlan{
		ServiceID:         service.ID,
		Version:           service.Version.Index,
		BeforeSpecHash:    beforeHash,
		TargetSpecHash:    targetHash,
		TargetForceUpdate: service.Spec.TaskTemplate.ForceUpdate,
	}, nil
}
