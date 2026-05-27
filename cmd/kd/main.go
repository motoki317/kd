// Command kd is a web-served Kubernetes dashboard.
//
// It connects to a Kubernetes cluster via client-go informers, builds a relationship
// graph of cluster resources, and serves an ArgoCD-style 2D topology UI over HTTP.
// See docs/ADR/ for the design decisions behind this tool.
package main

import (
	"fmt"
	"os"
)

func main() {
	// Wired up in Phase 3 (config → kube store → api → server). See docs/plans/master-plan.md.
	fmt.Fprintln(os.Stdout, "kd: not yet implemented")
}
