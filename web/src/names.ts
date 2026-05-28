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
// to fit the card. When a restart badge (↻N) shares the name line (right-aligned), it reserves the
// badge's width first so the name truncates short of it instead of rendering underneath. The reserve
// is in name-characters: the ↻ glyph is ~2 of them wide, each digit ~1, plus ~2 for a visible gap.
// Char-count is only an estimate for a proportional font, so lean generous — a slightly shorter name
// beats an overlap.
export function cardName(name: string, ownerName: string | undefined, restarts = 0): string {
  const reserved = restarts > 0 ? String(restarts).length + 4 : 0
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
