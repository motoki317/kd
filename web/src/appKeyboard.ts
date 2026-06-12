// The global keyboard shortcut map, extracted from App.tsx so the whole key surface — including
// the load-bearing Escape back-out ladder — reads as one unit instead of being buried mid-App.
// A factory, not a module-level listener: App calls it inside its component body so onMount /
// onCleanup attach and detach the window listener with the app root. It owns the search input ref
// the shortcuts focus and returns its ref-setter for App's JSX to wire in.
//
// Deliberately MINIMAL — four bindings, nothing else. Every other action has a visible, clickable
// control (group tabs, Fit button, drawer tabs, copy buttons, sidebar toggle, filter inputs), and
// a dashboard a beginner can drive from the screen alone must not grow a parallel invisible key
// surface that needs a reference card to hold. Shortcuts removed here (Cmd+K/Cmd+B/Alt+T/Alt+←/
// 1-3/j/k/y/f/=/-/0/[/]/Cmd+F/Shift+E) should NOT come back without removing a binding in trade.

import { onCleanup, onMount, type Accessor, type Setter } from 'solid-js'
import { navCandidates, nextSelection } from './nav'
import type { Health, KNode } from './types'

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
  showHelp: Accessor<boolean>
  setShowHelp: Setter<boolean>
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
    showHelp,
    setShowHelp,
  } = deps

  let searchEl: HTMLInputElement | undefined
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA'
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '?' && !typing) {
        setShowHelp((s) => !s)
      } else if (e.key === '/' && !typing) {
        // "/" focuses the one search box — the GitHub/Slack convention every operator carries.
        e.preventDefault()
        searchEl?.focus()
        searchEl?.select()
      } else if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        // Walk selection through the graph, troubled-first, so stepping surfaces problems before
        // healthy nodes. Scoped to the active search/health filter so stepping visits only what's
        // spotlighted. The selection drives the drawer and the topology's pan-to-selection.
        e.preventDefault()
        const cand = navCandidates(nodes(), search(), healthFilter(), kindFilter())
        setSelectedId((cur) => nextSelection(cand, cur, e.key === 'ArrowDown' ? 1 : -1) ?? cur)
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
    searchRef: (el: HTMLInputElement) => (searchEl = el),
  }
}
