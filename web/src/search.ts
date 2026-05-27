import type { KNode } from './types'

// nodeMatches reports whether a node should stay lit for the given query. It matches the name, the
// kind, any label (key or value), and any container image — so an operator can find a resource by
// what it's called, what it is, how it's tagged (app=shop), or what it runs (nginx:1.25). The query
// is matched case-insensitively; callers pass it pre-trimmed.
export function nodeMatches(n: KNode, query: string): boolean {
  const q = query.toLowerCase()
  if (!q) return false
  if (n.name.toLowerCase().includes(q)) return true
  if (n.kind.toLowerCase().includes(q)) return true
  if (n.images?.some((img) => img.toLowerCase().includes(q))) return true
  if (n.labels) {
    for (const [k, v] of Object.entries(n.labels)) {
      if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) return true
    }
  }
  return false
}
