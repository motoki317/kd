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

// How the topology arranges resources. Replaces the old fixed `View` enum: grouping (the layout
// strategy) is now orthogonal to which relationships are drawn (see RelCategory + relationships.ts).
//   relationship — depth-column tree following the displayed relationship edges
//   nodes         — pods grouped into their host's container
//   kind          — every resource in per-kind boxes
export type GroupBy = 'relationship' | 'nodes' | 'kind'

// A relationship category the operator can toggle on/off; each maps to one or more EdgeType
// (see REL_CATEGORIES in relationships.ts). Composable — several can be active at once.
export type RelCategory = 'ownership' | 'network' | 'volumes' | 'rbac' | 'scheduling'

export interface KNode {
  id: string
  kind: string
  apiVersion?: string
  namespace?: string
  name: string
  health: Health
  status?: string
  createdAt?: string
  restarts?: number
  containers?: string[]
  images?: string[]
  host?: string
  capacity?: string
  clusterIP?: string
  externalIP?: string
  ports?: string[]
  routes?: string[]
  rules?: string[]
  roleRef?: string
  subjects?: string[]
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
