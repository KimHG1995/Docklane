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


type NotFoundError struct {
	Resource string
	Ref      string
}

func (e *NotFoundError) Error() string {
	return e.Resource + " " + e.Ref + " not found"
}
