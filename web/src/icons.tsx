import { type JSX } from 'solid-js'

// Topology cards used to identify a resource by its uppercase KIND text alone (POD, DEPLOYMENT,
// REPLICASET, …). At small font size and in a dense graph, similarly-prefixed names ("Deployment"
// vs "DaemonSet") read identically in peripheral vision. A distinct silhouette per kind makes types
// recognizable without reading — workloads from networking from storage from RBAC. Icons are
// monochrome and use the same dim color as the kind text, so they never compete with the health
// stripe / border (which carries status, not type).
//
// Each entry returns SVG primitives that compose inside a 14x14 viewBox via <g> at the card's
// top-left. Fragments only (no nested <svg>) — the card SVG provides the coordinate space.

const icons: Record<string, () => JSX.Element> = {
  // A single round container — the atomic compute unit.
  Pod: () => <circle cx="7" cy="7" r="4.5" />,
  // Three stacked layers — a Deployment manages a stack of identical replicas (its RS history).
  Deployment: () => (
    <>
      <rect x="2.5" y="2.5" width="9" height="2" rx="0.5" />
      <rect x="2.5" y="6" width="9" height="2" rx="0.5" />
      <rect x="2.5" y="9.5" width="9" height="2" rx="0.5" />
    </>
  ),
  // Two stacked layers — a ReplicaSet is the unit a Deployment stacks; one fewer rect than its parent.
  ReplicaSet: () => (
    <>
      <rect x="2.5" y="4" width="9" height="2.5" rx="0.5" />
      <rect x="2.5" y="8" width="9" height="2.5" rx="0.5" />
    </>
  ),
  // Stacked layers with a side handle — "stateful" volume hint, distinguishes from Deployment.
  StatefulSet: () => (
    <>
      <rect x="3" y="2.5" width="8" height="2.5" rx="0.5" />
      <rect x="3" y="6" width="8" height="2.5" rx="0.5" />
      <rect x="3" y="9.5" width="8" height="2.5" rx="0.5" />
      <line x1="12.5" y1="3" x2="12.5" y2="11.5" />
    </>
  ),
  // Three dots in a row — one daemon per node, scheduled across the cluster.
  DaemonSet: () => (
    <>
      <circle cx="3" cy="7" r="1.5" />
      <circle cx="7" cy="7" r="1.5" />
      <circle cx="11" cy="7" r="1.5" />
      <line x1="2" y1="11" x2="12" y2="11" />
    </>
  ),
  // Play triangle in a box — a Job is a "run once" task.
  Job: () => (
    <>
      <rect x="2" y="2" width="10" height="10" rx="1.5" />
      <path d="M 6 5 L 6 9 L 9.5 7 z" />
    </>
  ),
  // Clock with a small calendar tab — scheduled (recurring) Job.
  CronJob: () => (
    <>
      <circle cx="7" cy="8" r="4" />
      <path d="M 7 5.5 L 7 8 L 9 9" />
      <line x1="5" y1="2.5" x2="9" y2="2.5" />
    </>
  ),
  // Hub-and-spokes — a Service load-balances to its endpoints.
  Service: () => (
    <>
      <circle cx="7" cy="7" r="1.5" />
      <circle cx="2.5" cy="3" r="1.2" />
      <circle cx="11.5" cy="3" r="1.2" />
      <circle cx="2.5" cy="11" r="1.2" />
      <circle cx="11.5" cy="11" r="1.2" />
      <line x1="6" y1="6" x2="3" y2="3.5" />
      <line x1="8" y1="6" x2="11" y2="3.5" />
      <line x1="6" y1="8" x2="3" y2="10.5" />
      <line x1="8" y1="8" x2="11" y2="10.5" />
    </>
  ),
  // Arrow entering a wall — external traffic routed into the cluster.
  Ingress: () => (
    <>
      <line x1="1.5" y1="7" x2="8" y2="7" />
      <path d="M 5.5 4.5 L 8 7 L 5.5 9.5" />
      <line x1="10" y1="2.5" x2="10" y2="11.5" />
      <line x1="12.5" y1="2.5" x2="12.5" y2="11.5" />
    </>
  ),
  // Document with content lines — a ConfigMap's k/v entries.
  ConfigMap: () => (
    <>
      <path d="M 3 2 L 8.5 2 L 11 4.5 L 11 12 L 3 12 z" />
      <line x1="4.5" y1="6" x2="9.5" y2="6" />
      <line x1="4.5" y1="8" x2="9.5" y2="8" />
      <line x1="4.5" y1="10" x2="7.5" y2="10" />
    </>
  ),
  // Key — a Secret holds credentials.
  Secret: () => (
    <>
      <circle cx="4.5" cy="7" r="2.5" />
      <line x1="6.5" y1="7" x2="12" y2="7" />
      <line x1="10" y1="7" x2="10" y2="9.5" />
      <line x1="12" y1="7" x2="12" y2="9" />
    </>
  ),
  // Cylinder — a PVC is persistent storage.
  PersistentVolumeClaim: () => (
    <>
      <ellipse cx="7" cy="3.5" rx="4.5" ry="1.5" />
      <line x1="2.5" y1="3.5" x2="2.5" y2="10.5" />
      <line x1="11.5" y1="3.5" x2="11.5" y2="10.5" />
      <path d="M 2.5 10.5 a 4.5 1.5 0 0 0 9 0" fill="none" />
    </>
  ),
  // Server box with ports — a Node is a worker machine.
  Node: () => (
    <>
      <rect x="2" y="3" width="10" height="8" rx="1" />
      <line x1="2" y1="7" x2="12" y2="7" />
      <circle cx="4" cy="5" r="0.5" fill="currentColor" />
      <circle cx="4" cy="9" r="0.5" fill="currentColor" />
    </>
  ),
  // Brackets — a Namespace is a labelled scope around resources.
  Namespace: () => (
    <>
      <path d="M 5 2.5 L 2.5 2.5 L 2.5 11.5 L 5 11.5" />
      <path d="M 9 2.5 L 11.5 2.5 L 11.5 11.5 L 9 11.5" />
    </>
  ),
  // Person — a ServiceAccount represents an identity.
  ServiceAccount: () => (
    <>
      <circle cx="7" cy="5" r="2.2" />
      <path d="M 2.5 12 C 3 8.5 5 7.5 7 7.5 C 9 7.5 11 8.5 11.5 12" />
    </>
  ),
  // Same identity shape as ServiceAccount — a User is an RBAC identity too; shows up only in
  // binding-subject rows (not as a topology node), so visual sameness with SA reads as "identity".
  User: () => (
    <>
      <circle cx="7" cy="5" r="2.2" />
      <path d="M 2.5 12 C 3 8.5 5 7.5 7 7.5 C 9 7.5 11 8.5 11.5 12" />
    </>
  ),
  // Two overlapping people — a Group is a set of identities; distinguishes from User/SA at a glance.
  Group: () => (
    <>
      <circle cx="4.5" cy="5" r="1.8" />
      <circle cx="9.5" cy="5" r="1.8" />
      <path d="M 1.5 12 C 2 9 3.5 8 5 8 C 5.5 8 6.2 8.2 6.5 8.5" />
      <path d="M 7.5 8.5 C 7.8 8.2 8.5 8 9 8 C 10.5 8 12 9 12.5 12" />
    </>
  ),
  // Scroll — a Role grants permissions, like a written charter.
  Role: () => (
    <>
      <path d="M 3 3 L 10 3 L 10 11 L 4 11 L 3 9.5 z" />
      <line x1="5" y1="5.5" x2="8.5" y2="5.5" />
      <line x1="5" y1="7.5" x2="8.5" y2="7.5" />
      <line x1="5" y1="9.5" x2="7" y2="9.5" />
    </>
  ),
  // Scroll with a small overlay — cluster-scoped Role.
  ClusterRole: () => (
    <>
      <path d="M 2.5 4 L 8 4 L 8 11.5 L 3.5 11.5 L 2.5 10 z" />
      <line x1="4" y1="6" x2="6.5" y2="6" />
      <line x1="4" y1="8" x2="6.5" y2="8" />
      <rect x="7" y="2" width="5" height="4.5" rx="0.5" />
    </>
  ),
  // Chain links — a binding ties a role to a subject.
  RoleBinding: () => (
    <>
      <rect x="1.5" y="4.5" width="6" height="5" rx="2.5" />
      <rect x="6.5" y="4.5" width="6" height="5" rx="2.5" />
    </>
  ),
  // Two chain links with a cluster wrapper.
  ClusterRoleBinding: () => (
    <>
      <rect x="1" y="5" width="5.5" height="4.5" rx="2.2" />
      <rect x="7.5" y="5" width="5.5" height="4.5" rx="2.2" />
      <line x1="1" y1="2.5" x2="13" y2="2.5" />
      <line x1="1" y1="12" x2="13" y2="12" />
    </>
  ),
  // Three connected dots — service backends.
  Endpoints: () => (
    <>
      <circle cx="3.5" cy="7" r="1.5" />
      <circle cx="10.5" cy="7" r="1.5" />
      <circle cx="7" cy="3" r="1.5" />
      <line x1="3.5" y1="7" x2="10.5" y2="7" />
      <line x1="3.5" y1="7" x2="7" y2="3" />
      <line x1="10.5" y1="7" x2="7" y2="3" />
    </>
  ),
  // Closed cylinder — the actual backing volume (vs PVC's open cylinder = the claim).
  PersistentVolume: () => (
    <>
      <ellipse cx="7" cy="3.5" rx="4.5" ry="1.5" />
      <line x1="2.5" y1="3.5" x2="2.5" y2="10.5" />
      <line x1="11.5" y1="3.5" x2="11.5" y2="10.5" />
      <ellipse cx="7" cy="10.5" rx="4.5" ry="1.5" />
    </>
  ),
  // Document with a + badge overlay — a CRD extends the cluster's API vocabulary.
  CustomResourceDefinition: () => (
    <>
      <path d="M 2 2.5 L 7.5 2.5 L 7.5 11.5 L 2 11.5 z" />
      <line x1="3" y1="5" x2="6.5" y2="5" />
      <line x1="3" y1="7" x2="6.5" y2="7" />
      <line x1="3" y1="9" x2="5.5" y2="9" />
      {/* Plus badge: offset top-right, signals "custom addition" */}
      <circle cx="11" cy="4" r="2.8" class="crd-badge-bg" fill="var(--surface)" stroke="none" />
      <line x1="11" y1="2.2" x2="11" y2="5.8" />
      <line x1="9.2" y1="4" x2="12.8" y2="4" />
    </>
  ),
  // Stacked layers with a globe ring — a StorageClass is a cluster-wide storage policy.
  StorageClass: () => (
    <>
      <rect x="2.5" y="3.5" width="9" height="2" rx="0.5" />
      <rect x="2.5" y="7" width="9" height="2" rx="0.5" />
      <line x1="11.5" y1="2" x2="11.5" y2="12" />
    </>
  ),
}

// Fallback for kinds without a dedicated icon (CRDs, future additions): a generic squared outline so
// the card layout stays consistent rather than printing kind text at a different x-offset.
const fallback = () => <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" />

// kindIcon renders the SVG fragment for the given kind, or the fallback shape. The caller is
// expected to wrap it in a <g> with the desired stroke/fill/transform.
export function kindIcon(kind: string): JSX.Element {
  return (icons[kind] ?? fallback)()
}

// hasKindIcon reports whether a kind has a dedicated icon (vs the generic fallback). Useful for
// tests that assert coverage of currently-emitted kinds without snapshotting visuals.
export function hasKindIcon(kind: string): boolean {
  return kind in icons
}

// kindFromRef extracts the leading kind from a binding's roleRef string ("Role/foo",
// "ClusterRole/bar") or a binding-subject string ("User: x", "Group: g", "ServiceAccount: ns/sa").
// Returns "" if neither shape matches, so a caller can decide whether to render an icon at all.
export function kindFromRef(ref: string): string {
  const slash = ref.indexOf('/')
  const colon = ref.indexOf(':')
  // Subject lines use "Kind: rest"; roleRef uses "Kind/rest". Pick the earlier separator (if any).
  if (colon !== -1 && (slash === -1 || colon < slash)) return ref.slice(0, colon).trim()
  if (slash !== -1) return ref.slice(0, slash).trim()
  return ''
}
