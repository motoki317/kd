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
	// EdgeRefers links a CR to another resource it references through a non-owner field
	// (a Workflow's WorkflowTemplate, a Certificate's Issuer, an ExternalSecret's
	// SecretStore, …). Inferred by the convention scanner or by a curated CRD ref rule.
	EdgeRefers EdgeType = "refers"
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
	Message    string            `json:"message,omitempty"`    // the WHY behind an unhealthy resource (status.message / a blocking condition); empty for healthy ones
	CreatedAt  string            `json:"createdAt,omitempty"`  // RFC3339 creation time, for age display
	Restarts   int32             `json:"restarts,omitempty"`   // pod container restart total, a crash signal
	Containers []string          `json:"containers,omitempty"` // pod container names, for the log picker
	Images     []string          `json:"images,omitempty"`     // distinct container images, "what's deployed here"
	Host       string            `json:"host,omitempty"`       // node a pod is scheduled on (spec.nodeName)
	Capacity   string            `json:"capacity,omitempty"`   // a Node's CPU/memory/pod capacity, for "how big is this node"
	ClusterIP  string            `json:"clusterIP,omitempty"`  // a Service's reachable address ("headless"/ExternalName target for those)
	ExternalIP string            `json:"externalIP,omitempty"` // a Service's external address (LoadBalancer ingress / externalIPs / "pending")
	Ports      []string          `json:"ports,omitempty"`      // a Service's port mappings, "port→target[:nodePort]/proto"
	Routes     []string          `json:"routes,omitempty"`     // an Ingress/HTTPRoute routing table, "host/path → service:port"
	Rules      []string          `json:"rules,omitempty"`      // a Role/ClusterRole's policy rules, "resources: verbs"
	RoleRef    string            `json:"roleRef,omitempty"`    // a RoleBinding/ClusterRoleBinding's target role, "Kind/name"
	Subjects   []string          `json:"subjects,omitempty"`   // a binding's grantees, "Kind: [namespace/]name" (incl. non-node User/Group)
	Labels     map[string]string `json:"labels,omitempty"`
	OwnerUIDs  []string          `json:"ownerUIDs,omitempty"`
	// ContainerStatuses is the per-container runtime state of a pod (init containers first), so the
	// drawer can show which container is unready or crash-looping rather than just an aggregate.
	ContainerStatuses []ContainerStatus `json:"containerStatuses,omitempty"`
	// Endpoints, when set (selector-based Services only), reports how many of the pods the Service's
	// selector matches are Ready — the "is anything actually serving this?" signal. nil for non-Services
	// and selectorless Services (which define their endpoints manually/externally), so the UI can tell
	// "no backends" apart from "not selector-based".
	Endpoints *Endpoints `json:"endpoints,omitempty"`
	// Allocatable, Requests, Limits carry structured (canonical-unit) resource quantities for the
	// capacity view, kept separate from the human-readable Capacity string (which still feeds the
	// drawer). Each is nil for kinds it doesn't apply to, so the client renders nothing rather than a
	// misleading zero.
	Allocatable *Resources `json:"allocatable,omitempty"` // a Node's schedulable capacity (Node kind)
	CapacityRes *Resources `json:"capacityRes,omitempty"` // a Node's TOTAL physical capacity (Node kind); ≥ Allocatable by the system-reserved overhead
	Requests    *Resources `json:"requests,omitempty"`    // a Pod's summed container requests (Pod kind)
	Limits      *Resources `json:"limits,omitempty"`      // a Pod's summed container limits (Pod kind)
}

// Resources holds canonical-unit resource quantities: CPU millicores, memory bytes, and a pod
// count (allocatable only). Pointer fields so "no CPU request set" stays distinct from "0" — a pod
// commonly sets memory but not CPU, and that absence is itself a signal the capacity view renders.
type Resources struct {
	CPUMilli *int64 `json:"cpuMilli,omitempty"`
	MemBytes *int64 `json:"memBytes,omitempty"`
	Pods     *int64 `json:"pods,omitempty"`
}

// Endpoints summarizes how many of a Service's selected pods are Ready out of the total it selects.
type Endpoints struct {
	Ready int `json:"ready"`
	Total int `json:"total"`
}

// ContainerStatus is one pod container's runtime state, condensed for display.
type ContainerStatus struct {
	Name     string `json:"name"`
	Ready    bool   `json:"ready"`
	Restarts int32  `json:"restarts,omitempty"`
	State    string `json:"state"`           // "Running", "Waiting: CrashLoopBackOff", "Terminated: Completed"
	Init     bool   `json:"init,omitempty"`  // an init container (runs to completion before the app ones)
	Image    string `json:"image,omitempty"` // the actually-running image, so the drawer pairs each container with its image
	// LastTerminated is why the container PREVIOUSLY exited (e.g. "OOMKilled (exit 137)"), from
	// lastState.terminated. Empty unless the container restarted at least once — it answers "why did
	// this restart" for a now-Running container, the actionable signal otherwise buried in the manifest.
	LastTerminated string `json:"lastTerminated,omitempty"`
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
