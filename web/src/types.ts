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
  ports?: string[]
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
