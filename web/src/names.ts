import { createSignal } from 'solid-js'

// Display-name helpers for topology cards. A namespace's ownership tree repeats the parent name
// in every child (Deployment "api" -> ReplicaSet "api-7d9f" -> Pod "api-7d9f-2xkp"), so the
// distinguishing part is buried and gets truncated away. We render children relative to their
// owner and middle-truncate what remains, keeping both the meaningful head and the unique tail.

// relativeName strips the owner's name prefix from a child when it follows the Kubernetes
// generated-name convention (<owner>-<suffix>), so a Pod shows as "2xkp" under its ReplicaSet.
export function relativeName(name: string, ownerName?: string): string {
  if (ownerName && name.length > ownerName.length + 1 && name.startsWith(ownerName + '-')) {
    return name.slice(ownerName.length + 1)
  }
  return name
}

// Compact labels for verbose kinds in the dense topology header, where the full kind would collide
// with the right-aligned status (e.g. PERSISTENTVOLUMECLAIM over "Bound 10Gi"). The drawer still
// shows the full kind; these are kubectl's well-known abbreviations.
const KIND_LABELS: Record<string, string> = {
  PersistentVolumeClaim: 'PVC',
}

// kindLabel returns the compact topology label for a kind, or the kind unchanged when it fits.
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

// Server-discovered kind → API short name ("cm", "pdb", …), populated once per context from
// /kinds (see App.tsx). A Solid signal so a late-arriving fetch re-renders the cards that already
// drew with the fallback. This is the authoritative source — it tracks the cluster (CRD shorts
// included) — so kindShortLabel prefers it over the hardcoded table below.
const [serverShortNames, setServerShortNames] = createSignal<Record<string, string>>({})
export { setServerShortNames }

// Fallback under-icon labels for when the server map hasn't loaded yet (or the kind has no API
// short name). The icon column is ≈40 px wide (10 px uppercase + 0.06em tracking, ~5–6 chars),
// so verbose kinds need an abbreviation. Kinds the API *does* abbreviate (cm, deploy, svc, …) are
// intentionally absent here — the server map covers them; listing them would just risk drifting
// from the cluster's truth. What remains is kinds the apiserver gives no short name but whose full
// kind still overflows the icon column.
const KIND_SHORT_LABELS: Record<string, string> = {
  Secret: 'SECRT',
  Group: 'GRP',
  ClusterRole: 'CROLE',
  RoleBinding: 'RB',
  ClusterRoleBinding: 'CRB',
  APIService: 'APISVC',
  CSINode: 'CSI',
  CSIDriver: 'CSIDRV',
  MutatingWebhookConfiguration: 'MWHK',
  ValidatingWebhookConfiguration: 'VWHK',
}

// kindShortLabel returns the upper-cased API short name when the cluster declares one, else a
// hardcoded fallback, else the upper-cased kind. Reactive: reading serverShortNames() ties callers
// (the topology cards / kind chips) to the /kinds fetch so labels sharpen once it resolves.
export function kindShortLabel(kind: string): string {
  const api = serverShortNames()[kind]
  if (api) return api.toUpperCase()
  return KIND_SHORT_LABELS[kind] ?? kind.toUpperCase()
}

// Extra search aliases for kinds whose kubectl short name isn't a substring of the full kind, so
// muscle-memory queries like "svc" / "sts" find Services / StatefulSets. Only listed where needed
// (e.g. "deploy" already matches "Deployment" by substring; "ing" matches "Ingress"). 2-char shorts
// (rs, ds, cm, …) are omitted because substring match makes them too noisy.
const KIND_ALIASES: Record<string, string[]> = {
  Service: ['svc'],
  StatefulSet: ['sts'],
  // Cluster-scope kinds not matched by substring of their full name.
  CustomResourceDefinition: ['crd'],
  PersistentVolume: ['pv'],
  StorageClass: ['sc'],
  HorizontalPodAutoscaler: ['hpa'],
  PodDisruptionBudget: ['pdb'],
  NetworkPolicy: ['netpol'],
  ResourceQuota: ['quota'],
  MutatingWebhookConfiguration: ['mwhk', 'mwc'],
  ValidatingWebhookConfiguration: ['vwhk', 'vwc'],
}

// kindAliases returns extra search-only synonyms for a kind. The full kind and the kindLabel are
// already matched by nodeMatches; this fills the gaps left by non-substring short names.
export function kindAliases(kind: string): string[] {
  return KIND_ALIASES[kind] ?? []
}

// middleTruncate keeps the head and tail of an over-long label, dropping the middle (usually a
// hash), so both the workload prefix and the unique suffix stay visible.
export function middleTruncate(s: string, max = 22): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

// Card geometry: the icon is on the left (its own column) and the right text column carries name,
// status and the restart/age badge on three vertically-separated rows. Nothing competes on a row,
// so each line gets the full right-column width — no inter-row truncation gymnastics required.
//
// At NODE_WIDTH=220 the right text column is ~162 px. Bold 13 px fits ~22 chars; regular 11 px
// (status) fits ~28; the badge is right-anchored so its budget is its own length. The numbers are
// conservative against proportional-font drift — a one-char-shorter name beats an overflow.
const CARD_NAME_MAX = 22
const CARD_STATUS_MAX = 24

export function cardName(name: string, ownerName?: string): string {
  return middleTruncate(relativeName(name, ownerName), CARD_NAME_MAX)
}

// cardStatus end-truncates a long status to its own row's width. End (not middle) keeps the leading
// reason — "Init:CrashLoop…" beats "I…ackOff" — and the drawer still shows the full status.
export function cardStatus(status: string): string {
  if (status.length <= CARD_STATUS_MAX) return status
  return status.slice(0, CARD_STATUS_MAX - 1) + '…'
}
