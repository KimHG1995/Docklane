package main

import (
	"fmt"
	"os"
	"runtime"
)

func main() {
	if runtime.GOOS != "linux" || os.Getenv("DOCKLANE_OR_DISPOSABLE_HOST") != "1" {
		fmt.Fprintln(os.Stderr, "[cold-recovery] explicit disposable Linux copy required")
		os.Exit(1)
	}
	if err := execute(os.Args[1:], os.Stdin, os.Stdout, rebuildOffline); err != nil {
		fmt.Fprintln(os.Stderr, "[cold-recovery] failed; keep original backup and discard uncertain working copy")
		os.Exit(1)
	}
}
