package docker

import "errors"

func isNotFound(err error) bool { return errors.Is(err, ErrNotFound) }

func asAPIError(err error, target **APIError) bool { return errors.As(err, target) }
