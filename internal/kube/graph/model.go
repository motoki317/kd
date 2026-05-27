// Package graph turns a snapshot of Kubernetes objects into a typed relationship graph
// of nodes (resources) and edges (relationships), with normalized per-kind health.
//
// Build is a pure function of its input, so the whole graph model is unit-tested against
// YAML fixtures with no live cluster. See docs/ADR/20260527-resource-relationship-graph.md.
package graph

// EdgeType enumerates the relationship kinds kd renders.
type EdgeType string

const (
	// EdgeOwner is the primary parent-child relationship from metadata.ownerReferences.
	EdgeOwner EdgeType = "ownerReference"
	// EdgeScheduledOn links a Pod to the Node it runs on (pod.spec.nodeName).
	EdgeScheduledOn EdgeType = "scheduledOn"
	// EdgeSelects links a Service to the Pods its selector matches.
	EdgeSelects EdgeType = "selects"
	// EdgeRoutes links an Ingress to the Services it routes to.
	EdgeRoutes EdgeType = "routes"
	// EdgeMounts links a Pod to ConfigMaps/Secrets/PVCs it references.
	EdgeMounts EdgeType = "mounts"
	// EdgeUsesServiceAccount links a Pod to its ServiceAccount.
	EdgeUsesServiceAccount EdgeType = "usesServiceAccount"
	// EdgeBinds links a RoleBinding/ClusterRoleBinding to its Role and subjects.
	EdgeBinds EdgeType = "binds"
)

// Health is the normalized status shared across kinds, so the UI colors nodes uniformly.
type Health string

const (
	HealthHealthy     Health = "Healthy"
	HealthProgressing Health = "Progressing"
	HealthDegraded    Health = "Degraded"
	HealthSuspended   Health = "Suspended"
	HealthUnknown     Health = "Unknown"
)

// Node is one resource in the graph.
type Node struct {
	ID         string            `json:"id"` // object UID, or a derived stable id for synthetic nodes
	Kind       string            `json:"kind"`
	APIVersion string            `json:"apiVersion,omitempty"`
	Namespace  string            `json:"namespace,omitempty"`
	Name       string            `json:"name"`
	Health     Health            `json:"health"`
	Status     string            `json:"status,omitempty"`     // short human-readable status, e.g. "Running", "2/2"
	CreatedAt  string            `json:"createdAt,omitempty"`  // RFC3339 creation time, for age display
	Restarts   int32             `json:"restarts,omitempty"`   // pod container restart total, a crash signal
	Containers []string          `json:"containers,omitempty"` // pod container names, for the log picker
	Labels     map[string]string `json:"labels,omitempty"`
	OwnerUIDs  []string          `json:"ownerUIDs,omitempty"`
}

// Edge is a typed relationship from one node to another.
type Edge struct {
	From string   `json:"from"`
	To   string   `json:"to"`
	Type EdgeType `json:"type"`
}

// Graph is the full set of nodes and edges for a scope (e.g. a namespace).
type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}
