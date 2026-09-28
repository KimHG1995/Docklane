package dockerengine

import "regexp"

var digestPinnedImagePattern = regexp.MustCompile(`@sha256:[A-Fa-f0-9]{64}$`)

func isDigestPinnedImage(image string) bool {
	return digestPinnedImagePattern.MatchString(image)
}
