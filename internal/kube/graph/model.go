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
	// EdgeGuards links a PodDisruptionBudget to the Pods its selector protects, so a degraded PDB
	// ("0/3 healthy") leads to the failing pods that explain it instead of being a triage dead-end.
	EdgeGuards EdgeType = "guards"
	// EdgeGoverns links a NetworkPolicy to the Pods its podSelector applies to, so a policy isn't a
	// disconnected island — the operator sees which pods' traffic it controls (the Network view's
	// "what does this protect" answer). A traffic concern, distinct from EdgeGuards' disruption one.
	EdgeGoverns EdgeType = "governs"
	// EdgeScrapes links a ServiceMonitor/VMServiceScrape to the Services its selector targets, so a
	// scrape config isn't a disconnected island — the operator sees which Services it monitors (the
	// Monitoring view's "what does this scrape" answer). An observability concern, distinct from
	// traffic and disruption.
	EdgeScrapes EdgeType = "scrapes"
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
	Restarts   int32             `json:"restarts,omitempty"`   // pod restart total (init + app containers), a crash signal
	Containers []string          `json:"containers,omitempty"` // pod app container names, for the log picker
	// InitContainers names a pod's init containers (spec order), so the log picker can also reach a
	// failed init container's logs — the place a pod stuck in Init records WHY. Kept separate from
	// Containers so the picker can label the two groups (init runs to completion before the app ones).
	InitContainers []string `json:"initContainers,omitempty"`
	Images         []string `json:"images,omitempty"` // distinct container images, "what's deployed here"
	Host       string            `json:"host,omitempty"`       // node a pod is scheduled on (spec.nodeName)
	Capacity   string            `json:"capacity,omitempty"`   // a Node's CPU/memory/pod capacity, for "how big is this node"
	Taints     string            `json:"taints,omitempty"`     // a Node's scheduling taints ("key[=value]:Effect, …"), "why won't pods land here"
	NetPol     []string          `json:"netpol,omitempty"`     // a NetworkPolicy's target + per-direction rule summary, "what does this allow/deny"
	ClusterIP  string            `json:"clusterIP,omitempty"`  // a Service's reachable address ("headless"/ExternalName target for those)
	ExternalIP string            `json:"externalIP,omitempty"` // a Service's external address (LoadBalancer ingress / externalIPs / "pending")
	Ports      []string          `json:"ports,omitempty"`      // a Service's port mappings, "port→target[:nodePort]/proto"
	Selector   string            `json:"selector,omitempty"`   // a Service's pod selector "k=v, k=v" — the "why no endpoints" answer; "" for selectorless
	Routes     []string          `json:"routes,omitempty"`     // an Ingress/HTTPRoute/IngressRoute routing table, "match → service:port"
	Scrapes    []string          `json:"scrapes,omitempty"`    // a ServiceMonitor/VMServiceScrape's target selector + endpoints, "what does this scrape, on which port/path"
	Rules      []string          `json:"rules,omitempty"`      // a Role/ClusterRole's policy rules, "resources: verbs"
	RoleRef    string            `json:"roleRef,omitempty"`    // a RoleBinding/ClusterRoleBinding's target role, "Kind/name"
	Subjects   []string          `json:"subjects,omitempty"`   // a binding's grantees, "Kind: [namespace/]name" (incl. non-node User/Group)
	DataKeys   []string          `json:"dataKeys,omitempty"`   // a ConfigMap/Secret's data keys, "key · size" (NAMES + sizes only — never values, even for a Secret)
	SecretType string            `json:"secretType,omitempty"` // a Secret's type (Opaque, kubernetes.io/tls, …) — the operationally-important classifier
	AccessModes string           `json:"accessModes,omitempty"` // a PVC/PV's access modes, abbreviated + "/"-joined (RWO, RWX, ROX, RWOP)
	StorageClass string          `json:"storageClass,omitempty"` // a PVC/PV's storage class (the provisioner/tier — gp3, standard, …)
	LastRun     string           `json:"lastRun,omitempty"`     // a CronJob's last schedule time (RFC3339) — "did it actually fire?"
	Active      int32            `json:"active,omitempty"`      // a Job/CronJob's currently-running pods/jobs ("is one running now?")
	Failed      int32            `json:"failed,omitempty"`      // a Job's failed pod count — burning retries the "succeeded/total" status hides
	ScaleReplicas string         `json:"scaleReplicas,omitempty"` // an HPA's replica state, "current[ → desired]" (mid-scale shows the arrow)
	ScaleRange  string           `json:"scaleRange,omitempty"`  // an HPA's min–max replica bounds ("2–10") — is it at the ceiling?
	PDBPolicy   string           `json:"pdbPolicy,omitempty"`   // a PodDisruptionBudget's policy, "min 2" / "max 1" (the configured intent)
	Disruptions string           `json:"disruptions,omitempty"` // a PDB's currently-allowed voluntary evictions ("0" → a node drain blocks here); "" for non-PDBs
	Provisioner string           `json:"provisioner,omitempty"` // a StorageClass's provisioner (the CSI driver / volume plugin) — its defining fact
	ReclaimPolicy string         `json:"reclaimPolicy,omitempty"` // a StorageClass's reclaim policy (Delete/Retain) — does deleting a PVC destroy the data?
	VolumeBinding string         `json:"volumeBinding,omitempty"` // a StorageClass's volume binding mode (Immediate / WaitForFirstConsumer)
	Expandable  bool             `json:"expandable,omitempty"`  // a StorageClass's allowVolumeExpansion — can PVCs on it grow?
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
