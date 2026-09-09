package journal

import "os/exec"

// runCmd runs a command for tests and returns its stdout.
func runCmd(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}
