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

// Extra search aliases for kinds whose kubectl short name isn't a substring of the full kind, so
// muscle-memory queries like "svc" / "sts" find Services / StatefulSets. Only listed where needed
// (e.g. "deploy" already matches "Deployment" by substring; "ing" matches "Ingress"). 2-char shorts
// (rs, ds, cm, …) are omitted because substring match makes them too noisy.
const KIND_ALIASES: Record<string, string[]> = {
  Service: ['svc'],
  StatefulSet: ['sts'],
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

// CARD_NAME_MAX is the name-line character budget at NODE_WIDTH: tuned so a full-width name fills
// the card up to its right padding.
const CARD_NAME_MAX = 22

// cardName is a topology card's display name: stripped of its owner prefix, then middle-truncated
// to fit the card. When a right-side badge (restart count and/or age, e.g. "↻3", "2d", "↻3 · 2d")
// shares the name line, reserve its width first so the name truncates short of it instead of
// rendering underneath. The reserve is in name-characters: the ↻ glyph is ~2 of them wide, each
// regular char ~1, plus ~2 for a visible gap. Char-count is only an estimate for a proportional
// font, so lean generous — a slightly shorter name beats an overlap.
export function cardName(name: string, ownerName: string | undefined, rightBadge: string | number = ''): string {
  // Back-compat: old call sites passed `restarts: number`. Convert to the badge string they used to imply.
  const badge = typeof rightBadge === 'number' ? (rightBadge > 0 ? `↻${rightBadge}` : '') : rightBadge
  const reserved = badge ? badge.length + (badge.match(/↻/g)?.length ?? 0) + 2 : 0
  return middleTruncate(relativeName(name, ownerName), CARD_NAME_MAX - reserved)
}

// TOP_LINE_CHARS is the kind+status character budget for the card's top line at NODE_WIDTH, with
// kind left- and status right-aligned. GAP keeps a visible space between them.
const TOP_LINE_CHARS = 24
const TOP_LINE_GAP = 2

// cardStatus fits the right-aligned status onto the top line beside the left-aligned kind,
// end-truncating it to the width the kind leaves. Without this an unbounded status — an Ingress
// host, a cordoned Node's "Ready,SchedulingDisabled", an "Init:CrashLoopBackOff" — overflows the
// card or renders on top of the kind. End-truncation keeps the meaningful head (the reason / host
// prefix); the drawer shows the full status.
export function cardStatus(status: string, kindLabel: string): string {
  const budget = TOP_LINE_CHARS - kindLabel.length - TOP_LINE_GAP
  if (status.length <= budget) return status
  return status.slice(0, Math.max(1, budget - 1)) + '…'
}
