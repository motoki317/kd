import { createSignal } from 'solid-js'
import { relativeAge } from './time'
import type { KNode } from './types'

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

// cardTitle builds the SVG <title> tooltip for a node — the small thing native browsers show on
// hover after ~700ms. It mirrors the card's visible facts (kind, full name, status) plus the
// detail the card runs out of room for at small zoom (age, host, restarts), so an operator can
// inspect a node without selecting it.
export function cardTitle(n: KNode, now: Date): string {
  const lines = [`${n.kind} ${n.name}`]
  if (n.status) lines.push(n.status)
  const meta: string[] = []
  if (n.createdAt) meta.push(`${relativeAge(n.createdAt, now)} old`)
  if (n.host) meta.push(`on ${n.host}`)
  if ((n.restarts ?? 0) > 0) meta.push(`↻ ${n.restarts} restarts`)
  if (meta.length > 0) lines.push(meta.join(' · '))
  return lines.join('\n')
}

// cardStatus end-truncates a long status to its own row's width. End (not middle) keeps the leading
// reason — "Init:CrashLoop…" beats "I…ackOff" — and the drawer still shows the full status.
export function cardStatus(status: string): string {
  if (status.length <= CARD_STATUS_MAX) return status
  return status.slice(0, CARD_STATUS_MAX - 1) + '…'
}
