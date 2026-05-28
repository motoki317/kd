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

export type View = 'ownership' | 'nodes' | 'network' | 'rbac' | 'volumes' | 'all'

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
