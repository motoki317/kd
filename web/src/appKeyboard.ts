// The global keyboard shortcut map, extracted from App.tsx so the whole key surface — including
// the load-bearing Escape back-out ladder — reads as one unit instead of being buried mid-App.
// A factory, not a module-level listener: App calls it inside its component body so onMount /
// onCleanup attach and detach the window listener with the app root. It owns the two input refs
// the shortcuts focus and returns their ref-setters for App's JSX to wire in.

import { onCleanup, onMount, type Accessor, type Setter } from 'solid-js'
import { GROUP_OPTIONS } from './components/Topology'
import type { GraphState } from './graphState'
import { navCandidates, nextSelection } from './nav'
import type { GroupBy, Health, KNode } from './types'

export function createAppKeyboard(deps: {
  nodes: Accessor<KNode[]>
  search: Accessor<string>
  setSearch: Setter<string>
  healthFilter: Accessor<Health | null>
  setHealthFilter: Setter<Health | null>
  kindFilter: Accessor<Set<string>>
  setKindFilter: Setter<Set<string>>
  selectedId: Accessor<string | null>
  setSelectedId: Setter<string | null>
  graph: GraphState
  setGroupBy: Setter<GroupBy>
  setSidebarHidden: Setter<boolean>
  showHelp: Accessor<boolean>
  setShowHelp: Setter<boolean>
  setCopiedRef: Setter<string | null>
  goBackSelection: () => boolean
  jumpToTrouble: () => boolean
}) {
  const {
    nodes,
    search,
    setSearch,
    healthFilter,
    setHealthFilter,
    kindFilter,
    setKindFilter,
    selectedId,
    setSelectedId,
    graph,
    setGroupBy,
    setSidebarHidden,
    showHelp,
    setShowHelp,
    setCopiedRef,
    goBackSelection,
    jumpToTrouble,
  } = deps

  // Global keys: "/" jumps to the namespace filter, Cmd/Ctrl+K to the resource search, Escape
  // backs out (blur a field, else close the drawer) — the muscle-memory shortcuts operators
  // expect, with no on-screen chrome.
  let filterEl: HTMLInputElement | undefined
  let searchEl: HTMLInputElement | undefined
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      const num = Number(e.key)
      // Cmd/Ctrl+K focuses the topology search (GitHub-style "find any resource"). Works even
      // when typing in another field — the operator's intent is "switch to search".
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        searchEl?.focus()
        searchEl?.select()
        return
      }
      // Cmd/Ctrl+B toggles the namespace sidebar (cycle 299). VS Code uses the same shortcut for
      // its sidebar, so the muscle memory carries over for most operators.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        setSidebarHidden((v) => !v)
        return
      }
      // Alt+Left walks the navigation history back (cycle 300). Browser-back semantics inside the
      // drawer — chase an owner chip or event-source pill, then step back without re-clicking.
      // Alt+Left is the universal "back" gesture on Windows/Linux and isn't claimed by browser
      // history on the SPA route.
      if (e.altKey && e.key === 'ArrowLeft') {
        if (goBackSelection()) e.preventDefault()
        return
      }
      // Alt+T steps to the next troubled namespace — "take me to the problem", and again for the next
      // one (cycles worst-first, wrapping). No-op when the whole cluster is Healthy (nothing to jump
      // to) so the key never yanks you to an arbitrary ns. First landing matches the first-load
      // default selection (cycle 320); repeats walk the rest of the troubled set.
      // e.code too: macOS composes Option+T into key '†', so a key-only match never fires for Mac
      // operators — code is the physical key, immune to the composition (kept alongside key so
      // non-QWERTY layouts where 'T' sits elsewhere still match on what's printed).
      if (e.altKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT') && !typing) {
        if (jumpToTrouble()) e.preventDefault()
        return
      }
      if (e.key === '?' && !typing) {
        setShowHelp((s) => !s)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        filterEl?.focus()
      } else if (!typing && num >= 1 && num <= GROUP_OPTIONS.length) {
        setGroupBy(GROUP_OPTIONS[num - 1].id) // 1-3: Relationship / Nodes / Kind grouping
      } else if (!typing && (e.key === 'j' || e.key === 'ArrowDown')) {
        // Walk selection through the graph, troubled-first, so stepping surfaces problems before
        // healthy nodes. Scoped to the active search/health filter so stepping visits only what's
        // spotlighted. The selection drives the drawer and the topology's pan-to-selection.
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter(), kindFilter())
        setSelectedId((cur) => nextSelection(cand, cur, 1) ?? cur)
      } else if (!typing && (e.key === 'k' || e.key === 'ArrowUp')) {
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter(), kindFilter())
        setSelectedId((cur) => nextSelection(cand, cur, -1) ?? cur)
      } else if (!typing && e.key === 'y' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 'y' yanks the current selection's "Kind/name" to the clipboard — same string Shift+click
        // on the drawer copy button produces (cycle 287), but without opening the drawer first.
        // Mirrors the vim yank verb, so muscle memory carries over. Brief toast via help overlay-
        // adjacent state would be overkill; the standard browser clipboard pulse is the feedback.
        const sel = graph.nodes[selectedId() ?? '']
        if (sel) {
          const ref = `${sel.kind}/${sel.name}`
          // Optional-chain the WHOLE promise chain, not just `clipboard` — in a non-secure context
          // (plain http://<lan-ip>, a real kd access path) `navigator.clipboard` is undefined, so the
          // bare `?.writeText(ref).then(…)` threw an uncaught TypeError on `.then` of undefined.
          // Confirm only on a real success (matches CopyButton's silent-no-op-when-unavailable).
          navigator.clipboard?.writeText(ref)?.then(() => setCopiedRef(ref))?.catch(() => {})
        }
      } else if (e.key === 'Escape') {
        // Progressive back-out: help overlay, blur a field, close the drawer, then clear filters.
        if (showHelp()) setShowHelp(false)
        else if (typing) (el as HTMLElement).blur()
        else if (selectedId()) setSelectedId(null)
        else if (search() || healthFilter() || kindFilter().size > 0) {
          setSearch('')
          setHealthFilter(null)
          setKindFilter(new Set<string>())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return {
    filterRef: (el: HTMLInputElement) => (filterEl = el),
    searchRef: (el: HTMLInputElement) => (searchEl = el),
  }
}
