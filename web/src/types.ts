// Mirrors the Go API JSON (internal/kube/graph). Kept in sync by hand; the shapes are small.

export type Health = 'Healthy' | 'Progressing' | 'Degraded' | 'Suspended' | 'Unknown'

export type EdgeType =
  | 'ownerReference'
  | 'scheduledOn'
  | 'selects'
  | 'routes'
  | 'mounts'
  | 'usesServiceAccount'
  | 'binds'
  // 'refers' is the CR-defined relationship (Workflow → WorkflowTemplate, Certificate →
  // Issuer/Secret, ExternalSecret → SecretStore, generic *Ref fields from the convention
  // scanner). Rendered subtler than ownership so the topology backbone stays the primary read.
  | 'refers'
  // 'guards' links a PodDisruptionBudget to the pods it protects (a node-drain/disruption concern).
  | 'guards'
  // 'governs' links a NetworkPolicy to the pods its podSelector applies to (a traffic concern, in the
  // Network category) — so a policy connects to what it protects instead of floating disconnected.
  | 'governs'
  // 'scrapes' links a ServiceMonitor/VMServiceScrape to the Services it selects (an observability
  // concern, in the Monitoring category) — so a scrape config isn't a floating island.
  | 'scrapes'

// How the topology arranges resources. Replaces the old fixed `View` enum: grouping (the layout
// strategy) is now orthogonal to which relationships are drawn (see RelCategory + relationships.ts).
//   relationship — depth-column tree following the displayed relationship edges
//   nodes         — pods grouped into their host's container
//   kind          — every resource in per-kind boxes
export type GroupBy = 'relationship' | 'nodes' | 'kind'

// A relationship category the operator can toggle on/off; each maps to one or more EdgeType
// (see REL_CATEGORIES in relationships.ts). Composable — several can be active at once.
export type RelCategory = 'ownership' | 'network' | 'volumes' | 'rbac' | 'scheduling' | 'monitoring'

// Resources are canonical-unit resource quantities: CPU in millicores, memory in bytes, and a pod
// count (allocatable only). Every field is optional so "no CPU request set" stays distinguishable
// from "0" — a pod commonly sets a memory request/limit but no CPU one, and that absence is itself
// the signal (an unconstrained pod) the capacity view renders.
export interface Resources {
  cpuMilli?: number
  memBytes?: number
  pods?: number
}

// ResourceUsage is live consumption from metrics-server (CPU millicores, memory bytes), delivered
// out-of-band of the graph via the `usage` SSE event and merged into client state orthogonally.
export interface ResourceUsage {
  cpuMilli?: number
  memBytes?: number
}

// Usage is live consumption keyed by object UID (both Nodes and Pods). Kept separate from KNode so
// the ~15s usage refresh never re-diffs the graph store. Delivered inside the `capacity` event.
export interface Usage {
  items: Record<string, ResourceUsage>
}

// Capacity is the payload of the `capacity` SSE event — the data behind the Nodes group-by. Unlike
// the main graph (scoped to the selected namespace), it is ALWAYS cluster-wide: every Node and every
// Pod across all namespaces, each Pod tagged with its `namespace` so the client shows this-namespace
// pods bright and dims the rest. A node hosts pods from every namespace, so its true utilization can
// only be drawn from the whole cluster's pods — hence this separate, cluster-wide feed. `usage` is
// absent when metrics-server is unavailable (bars then fall back to sizing by request).
export interface Capacity {
  nodes: KNode[]
  usage?: Usage
}

export interface KNode {
  id: string
  kind: string
  apiVersion?: string
  namespace?: string
  name: string
  health: Health
  status?: string
  message?: string // the WHY behind an unhealthy resource (failure reason); empty for healthy ones
  createdAt?: string
  restarts?: number
  containers?: string[]
  initContainers?: string[]
  images?: string[]
  host?: string
  capacity?: string
  taints?: string // a Node's scheduling taints ("key[=value]:Effect, …") — why pods won't schedule here
  netpol?: string[] // a NetworkPolicy's target + per-direction rule summary — what it allows/denies
  scrapes?: string[] // a ServiceMonitor/VMServiceScrape's target selector + endpoints — what it scrapes
  // allocatable is a Node's schedulable capacity (capacity minus system-reserved) — drives the Req
  // bar's track + overcommit check. capacityRes is the node's TOTAL physical capacity (≥ allocatable)
  // — the Use bar gauges actual usage against it, since usage can spill into the reserved region
  // (kubelet, runtime). requests/limits are a Pod's summed container requests/limits (Pod kind); a
  // field is absent when no container sets it, so the view can mark unconstrained pods.
  allocatable?: Resources
  capacityRes?: Resources
  requests?: Resources
  limits?: Resources
  clusterIP?: string
  externalIP?: string
  ports?: string[]
  selector?: string // a Service's pod selector "k=v, k=v" — the "why no endpoints" answer; absent for selectorless
  routes?: string[]
  rules?: string[]
  roleRef?: string
  subjects?: string[]
  dataKeys?: string[] // a ConfigMap/Secret's data keys, "key · size" (names + sizes only, never values)
  quotaUsage?: string[] // a ResourceQuota's consumption, "resource · used / hard"
  secretType?: string // a Secret's type (Opaque, kubernetes.io/tls, …)
  accessModes?: string // a PVC/PV's access modes, abbreviated + "/"-joined (RWO, RWX, ROX, RWOP)
  storageClass?: string // a PVC/PV's storage class
  lastRun?: string // a CronJob's last schedule time (RFC3339)
  active?: number // a Job/CronJob's currently-running pods/jobs
  failed?: number // a Job's failed pod count
  scaleReplicas?: string // an HPA's replica state, "current[ → desired]"
  scaleRange?: string // an HPA's min–max replica bounds ("2–10")
  scaleMetrics?: string // the metric driving an HPA, "cpu 72% / 80%" (current / target)
  appDest?: string // an ArgoCD Application's deploy destination ("[cluster/]namespace")
  appRevision?: string // an ArgoCD Application's synced revision (short SHA / tag)
  pdbPolicy?: string // a PodDisruptionBudget's policy, "min 2" / "max 1"
  disruptions?: string // a PDB's currently-allowed voluntary evictions ("0" → a node drain blocks)
  provisioner?: string // a StorageClass's provisioner (CSI driver / volume plugin)
  reclaimPolicy?: string // a StorageClass's reclaim policy (Delete/Retain)
  volumeBinding?: string // a StorageClass's volume binding mode (Immediate / WaitForFirstConsumer)
  expandable?: boolean // a StorageClass's allowVolumeExpansion
  endpoints?: { ready: number; total: number }
  containerStatuses?: ContainerStatus[]
  labels?: Record<string, string>
  ownerUIDs?: string[]
}

export interface ContainerStatus {
  name: string
  ready: boolean
  restarts?: number
  state: string // "Running", "Waiting: CrashLoopBackOff", "Terminated: Completed"
  init?: boolean
  image?: string // the actually-running image, paired with the container in the drawer
  lastTerminated?: string // why it PREVIOUSLY exited ("OOMKilled (exit 137)") — explains a restart
}

export interface KEdge {
  from: string
  to: string
  type: EdgeType
}

export interface KGraph {
  nodes: KNode[]
  edges: KEdge[]
}

export interface Patch {
  upsertNodes?: KNode[]
  removeNodeIds?: string[]
  upsertEdges?: KEdge[]
  removeEdges?: KEdge[]
}
