package dockerengine

type ConflictError struct {
	Message string
}

func (e *ConflictError) Error() string {
	return e.Message
}

type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	return e.Message
}
