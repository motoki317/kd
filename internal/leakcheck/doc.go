// Package leakcheck guards the tracked tree against committed machine-local or
// environment-specific identifiers — real kube context/cluster/namespace names and cloud
// account IDs. It is deliberately cluster-agnostic: it hardcodes NO real name. The forbidden
// set is derived at test time from whatever kubeconfig and optional gitignored `.leakcheck`
// denylist exist on the machine running the test, so the same test reads identically on every
// machine. On a host with none of those (CI, a fresh clone) the check is a no-op.
//
// See AGENTS.md, "No machine-local or environment leakage".
package leakcheck
