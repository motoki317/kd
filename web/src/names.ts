import { createSignal } from 'solid-js'
import { relativeAge } from './time'
import type { KEdge, KNode } from './types'

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

// shortNodeName drops the DNS domain from a cloud node name for display — EKS/GKE/on-prem nodes are
// `<hostname>.<domain>` (ip-10-8-77-146.us-west-2.compute.internal), and that domain repeats
// identically on every node, so it's pure noise that pushes the distinguishing hostname + the pod
// count off to the right. The hostname (the private IP for EKS) is unique per node within a cluster,
// so dropping the domain doesn't collide; callers keep the full name in a title/tooltip. Names with
// no dot (docker-desktop, gke-default-pool-abc-xy) are returned unchanged.
export function shortNodeName(name: string): string {
  const dot = name.indexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
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

// cardKindLabel is the under-icon label for a topology card, capped to the ~44 px icon column so a
// kind with no abbreviation (a CRD whose full kind upper-cases long, e.g. "CLUSTERISSUER") ellipsis-
// truncates instead of spilling across the card into the name. SVG <text> ignores CSS text-overflow,
// so the clip is done here; end-truncation keeps the head, which carries the most identity. The full
// kind still shows in the hover tooltip and the drawer. ~7 chars fit, so the API/fallback shorts
// (≤6: NETPOL, DEPLOY, APISVC, …) pass through untouched.
const CARD_KIND_MAX = 7
export function cardKindLabel(kind: string): string {
  const s = kindShortLabel(kind)
  return s.length <= CARD_KIND_MAX ? s : s.slice(0, CARD_KIND_MAX - 1) + '…'
}

// Extra search aliases for kinds whose kubectl short name isn't a substring of the full kind, so
// muscle-memory queries like "svc" / "sts" find Services / StatefulSets. Only listed where needed
// (e.g. "deploy" already matches "Deployment" by substring; "ing" matches "Ingress"). 2-char shorts
// (rs, ds, cm, …) are omitted because substring match makes them too noisy.
const KIND_ALIASES: Record<string, string[]> = {
  Service: ['svc'],
  StatefulSet: ['sts'],
  PersistentVolumeClaim: ['pvc'], // "pvc" isn't a contiguous substring of the kind
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

// kindAliases returns extra search-only synonyms for a kind. The full kind is already matched by
// nodeMatches; this fills the gaps left by short names that aren't a substring of it.
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

// A leading ellipsis marks a card name whose owner prefix was elided, so "…-2xkp" reads as a relative
// name at a glance. Stripping used to be silent — the short name looked identical to a full one, and an
// operator could only discover the elision by opening the drawer. The separator hyphen is kept after the
// mark so the boundary is obvious; the full name still shows in the hover tooltip and the drawer.
const PREFIX_MARK = '…'

export function cardName(name: string, ownerName?: string): string {
  const rel = relativeName(name, ownerName)
  if (rel !== name) return PREFIX_MARK + middleTruncate('-' + rel, CARD_NAME_MAX - PREFIX_MARK.length)
  return middleTruncate(name, CARD_NAME_MAX)
}

// prefixParentNames maps each node id to the name of its longest PREFIX-PARENT — a related node whose
// name is a '-'-bounded prefix of this node's name (ReplicaSet "api-7d9f" parents Pod "api-7d9f-2xkp").
// Scans EVERY edge, not just ownerReference, so generated children of any kind shorten the same way
// (a CRD instance "<template>-<id>" under its template via a refers edge). The prefix test guards
// against false parents — a Service that merely selects a Pod is not a name ancestor — and the longest
// match wins so the closest ancestor (ReplicaSet over Deployment) is used. Feeds cardName so a child
// renders relative to its parent in the tree.
export function prefixParentNames(nodes: KNode[], edges: KEdge[]): Map<string, string> {
  const nameById = new Map(nodes.map((n) => [n.id, n.name]))
  const parents = new Map<string, string>()
  for (const e of edges) {
    const parent = nameById.get(e.from)
    const child = nameById.get(e.to)
    if (parent === undefined || child === undefined) continue
    if (child.length <= parent.length + 1 || !child.startsWith(parent + '-')) continue
    const cur = parents.get(e.to)
    if (cur === undefined || parent.length > cur.length) parents.set(e.to, parent)
  }
  return parents
}

// cardTitle builds the SVG <title> tooltip for a node — the small thing native browsers show on
// hover after ~700ms. It mirrors the card's visible facts (kind, full name, status) plus the
// detail the card runs out of room for at small zoom (age, host, restarts), so an operator can
// inspect a node without selecting it.
// nodeHead is the identity triple every node summary leads with: "Kind name", then the status, then
// the failure reason. The reason (server-set only for unhealthy nodes) sits right under the status it
// explains, so a reader takes in the WHY next to the WHAT. Shared by the card tooltip and the aria-live
// selection announcement so the two can't drift on what a node's summary says.
function nodeHead(n: KNode): string[] {
  const parts = [`${n.kind} ${n.name}`]
  if (n.status) parts.push(n.status)
  if (n.message) parts.push(n.message)
  return parts
}

export function cardTitle(n: KNode, now: Date): string {
  const lines = nodeHead(n)
  const meta: string[] = []
  if (n.createdAt) meta.push(`${relativeAge(n.createdAt, now)} old`)
  if (n.host) meta.push(`on ${n.host}`)
  if ((n.restarts ?? 0) > 0) meta.push(`↻ ${n.restarts} restarts`)
  if (meta.length > 0) lines.push(meta.join(' · '))
  return lines.join('\n')
}

// selectionLabel is the single-line announcement an aria-live region speaks when the selection
// changes (j/k stepping keeps focus on the body, so the drawer never announces itself). Same facts
// as the card tooltip's head — kind+name, status, failure reason — comma-joined for speech and
// prefixed "Selected " for context. Empty when nothing is selected, so the region stays silent.
export function selectionLabel(n: KNode | null | undefined): string {
  if (!n) return ''
  return `Selected ${nodeHead(n).join(', ')}`
}

// cardStatus end-truncates a long status to its own row's width. End (not middle) keeps the leading
// reason — "Init:CrashLoop…" beats "I…ackOff" — and the drawer still shows the full status.
export function cardStatus(status: string): string {
  if (status.length <= CARD_STATUS_MAX) return status
  return status.slice(0, CARD_STATUS_MAX - 1) + '…'
}

// pluralizeKind renders a Kubernetes Kind for a count label ("Show 8 more Endpoints"). Naive `+ 's'`
// doubled an already-plural Kind ("Endpoints" → "Endpointss") and mangled consonant+y
// ("NetworkPolicy" → "NetworkPolicys"); this handles the cases kd's Kind names actually hit. Not full
// English inflection — a Kind already ending in 's' is left as-is (Endpoints stays Endpoints; the rare
// singular "Ingress" reads fine in a tooltip), consonant+y → 'ies', else +'s'. n === 1 → unchanged.
export function pluralizeKind(kind: string, n: number): string {
  if (n === 1 || kind.endsWith('s')) return kind
  if (/[^aeiou]y$/i.test(kind)) return kind.slice(0, -1) + 'ies'
  return kind + 's'
}
