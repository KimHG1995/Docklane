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

func (r *Reader) PlanUpdateServiceImage(
	ctx context.Context,
	serviceID string,
	expectedVersion uint64,
	image string,
) (model.ServiceMutationPlan, error) {
	if !isDigestPinnedImage(image) {
		return model.ServiceMutationPlan{}, &ValidationError{
			Message: "deployment image must be pinned by sha256 digest",
		}
	}

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
	if service.Spec.Mode.Replicated == nil || service.Spec.TaskTemplate.ContainerSpec == nil {
		return model.ServiceMutationPlan{}, &ValidationError{
			Message: fmt.Sprintf("service %q is not a supported replicated container service", serviceID),
		}
	}

	beforeHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	service.Spec.TaskTemplate.ContainerSpec.Image = image
	targetHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	targetTaskSpecHash, err := taskSpecHash(service.Spec.TaskTemplate)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}

	return model.ServiceMutationPlan{
		ServiceID:          service.ID,
		Version:            service.Version.Index,
		BeforeSpecHash:     beforeHash,
		TargetSpecHash:     targetHash,
		TargetForceUpdate:  service.Spec.TaskTemplate.ForceUpdate,
		TargetImage:        image,
		TargetTaskSpecHash: targetTaskSpecHash,
	}, nil
}


func (r *Reader) PlanRollbackService(
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
	if service.PreviousSpec == nil {
		return model.ServiceMutationPlan{}, &ValidationError{
			Message: fmt.Sprintf("service %q does not have a previous spec", serviceID),
		}
	}
	if service.PreviousSpec.Mode.Replicated == nil ||
		service.PreviousSpec.TaskTemplate.ContainerSpec == nil {
		return model.ServiceMutationPlan{}, &ValidationError{
			Message: fmt.Sprintf(
				"service %q previous spec is not a supported replicated container service",
				serviceID,
			),
		}
	}

	beforeHash, err := serviceSpecHash(service.Spec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	targetHash, err := serviceSpecHash(*service.PreviousSpec)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}
	targetTaskSpecHash, err := taskSpecHash(service.PreviousSpec.TaskTemplate)
	if err != nil {
		return model.ServiceMutationPlan{}, err
	}

	targetImage := service.PreviousSpec.TaskTemplate.ContainerSpec.Image
	var targetReplicas *uint64
	if service.PreviousSpec.Mode.Replicated.Replicas != nil {
		replicas := *service.PreviousSpec.Mode.Replicated.Replicas
		targetReplicas = &replicas
	}

	return model.ServiceMutationPlan{
		ServiceID:          service.ID,
		Version:            service.Version.Index,
		BeforeSpecHash:     beforeHash,
		TargetSpecHash:     targetHash,
		TargetForceUpdate:  service.PreviousSpec.TaskTemplate.ForceUpdate,
		TargetReplicas:     targetReplicas,
		TargetImage:        targetImage,
		TargetTaskSpecHash: targetTaskSpecHash,
	}, nil
}
