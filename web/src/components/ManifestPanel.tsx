import { createEffect, createMemo, createResource, createSignal, For, Index, on, Show, Suspense } from 'solid-js'
import { fetchResource, isForbidden, type ManifestFormat } from '../api'
import { splitByMatch } from '../logs'
import { computeFolds, mergeMatchRuns, splitManifestLines, type FoldRegion, type ManifestLine, type MatchRun, type Span } from '../manifestSyntax'
import { nextRovingIndex } from '../rovingFocus'
import CopyButton from './CopyButton'

// Above this many characters, skip syntax tokenization and render each line as one uncolored token —
// a giant bundled CRD must never trade interactivity for coloring (folding and find still work).
const SYNTAX_MAX = 200_000
// A match run with its 0-based position, so the "current" <mark> is chosen from data rather than a
// render-time counter (a keyed <For> reuses rows across query edits and would not reset one).
interface IndexedRun extends MatchRun {
  matchIndex: number
}
// One rendered manifest line: its fold role, its leading-space depth (so the chevron steps right with
// the field it folds), whether a collapsed ancestor hides it, and its search overlay. A hidden line
// stays in the DOM (clipped to zero height) rather than removed, so a drag-select spanning a fold still
// copies the collapsed YAML/JSON.
interface Row {
  line: number
  foldable: boolean
  collapsed: boolean
  hidden: boolean
  hiddenCount: number
  indent: number
  runs: IndexedRun[]
}
const EMPTY_FOLDS: ReadonlySet<number> = new Set()
function renderSpan(s: Span) {
  return s.type === 'plain' ? s.text : <span class={`mf-${s.type}`}>{s.text}</span>
}

// ManifestPanel is the drawer's Manifest tab: the server-rendered YAML/JSON text with a format
// radiogroup and a within-manifest find. It owns the whole fetch+find state cluster (format, the
// keyed resource, query, current-match index) so DetailDrawer stays the tab orchestrator — the same
// split that gave ResourceSummary its KindFacts. `nodeId` is the reset trigger: a new resource must
// not inherit the previous one's query or scroll position.
export default function ManifestPanel(props: {
  resKey: { ctx: string; ns: string; kind: string; name: string } | null
  nodeId?: string
  active: boolean
}) {
  // YAML is the default manifest view (what operators read); JSON stays one click away. Format is
  // part of the resource key, so flipping it refetches the server-rendered text. The manifest is
  // fetched as soon as a node is selected, so switching tabs is instant.
  const [format, setFormat] = createSignal<ManifestFormat>('yaml')
  // Refs so the format radiogroup's arrow keys can move DOM focus to follow the roving tabindex.
  const formatRefs: Partial<Record<ManifestFormat, HTMLButtonElement>> = {}
  const [detail] = createResource(
    () => (props.resKey ? { ...props.resKey, format: format() } : null),
    (k) => fetchResource(k.ctx, k.ns, k.kind, k.name, k.format),
  )
  // Within-manifest search: long YAMLs hide an env var or a strategy buried 80 lines down. Resets
  // on selection change so the query doesn't follow into a new resource's manifest. The memo guards
  // detail.error the same way the events list does — the resource throws on read when errored.
  const [manifestQuery, setManifestQuery] = createSignal('')
  // 0-based index of the "current" highlighted match within the manifest. Pressing Enter in the
  // find field scrolls to the next match and bumps this index; the matching <mark> gets a stronger
  // styling so the operator can tell "this is where you are" vs the other matches.
  const [manifestMatchIdx, setManifestMatchIdx] = createSignal(0)
  // Collapsed fold headers (by line index). Declared above the nodeId effect so that eager effect can
  // reset it without hitting the temporal dead zone. A line index only means something for one
  // (resource, format) pairing, so both resets clear it (see the format effect below).
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<number>>(EMPTY_FOLDS)
  const toggleFold = (line: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(line) ? next.delete(line) : next.add(line)
      return next
    })
  let sectionEl: HTMLElement | undefined
  createEffect(
    on(
      () => props.nodeId,
      () => {
        setManifestQuery('')
        setManifestMatchIdx(0)
        setCollapsed(EMPTY_FOLDS)
        // Scroll back to the top too — a scrolled-down manifest must not carry the operator's prior
        // position into a fresh resource.
        const mp = sectionEl?.querySelector('.manifest') as HTMLElement | null
        if (mp) mp.scrollTop = 0
      },
    ),
  )
  // YAML and JSON line up differently, so a fold (keyed by line index) cannot carry across a format
  // flip. defer: true keeps the initial render — collapsed already starts empty.
  createEffect(on(format, () => setCollapsed(EMPTY_FOLDS), { defer: true }))
  // The manifest body read WITHOUT suspending. This memo is EAGER (created at panel init, outside the
  // <Suspense> below), so reading the suspending detail() here would register the suspend with the
  // drawer's OUTER boundary (App wraps the whole drawer) — and every manifest refetch would then detach
  // + re-insert the drawer DOM, replaying its slide-in ("the sidebar keeps re-opening"). Reading
  // .latest gated on state is the same stale-while-revalidating trick loadedEvents uses: it never
  // suspends. The genuine first-load fallback still belongs to the INNER <Suspense>, whose <pre> body
  // reads detail() directly.
  const manifestText = createMemo(() => (detail.state === 'ready' || detail.state === 'refreshing' ? detail.latest ?? '' : ''))
  // One entry per source line, syntax-tokenized. Keyed on (text, format) only, so typing in find or
  // toggling a fold never re-tokenizes. Above the size ceiling each line keeps a single plain token
  // (no coloring) — folding and find need only the line text, not its colors.
  const lines = createMemo<ManifestLine[]>(() => {
    const text = manifestText()
    if (text === '') return []
    if (text.length > SYNTAX_MAX) return text.split('\n').map((t) => ({ text: t, tokens: [{ text: t, type: 'plain' as const }] }))
    return splitManifestLines(text, format())
  })
  const foldByHeader = createMemo(() => {
    const m = new Map<number, FoldRegion>()
    for (const r of computeFolds(lines().map((l) => l.text))) m.set(r.header, r)
    return m
  })
  // Every source line becomes a row; a line inside a collapsed region's body is marked hidden (clipped
  // to zero height by CSS) rather than dropped, so a drag-select across a fold still copies the
  // collapsed text. An active query force-expands everything (eff is empty) so no hit hides behind a
  // fold — the way the browser's own find reveals folded text. Each row's match index is precomputed
  // (not a render-time counter a keyed <For> would not reset). Match indices only matter under a query,
  // and a query un-hides every row, so assigning them across hidden rows too is consistent.
  const rows = createMemo<Row[]>(() => {
    if (detail.error) return []
    const ls = lines()
    const fbh = foldByHeader()
    const q = manifestQuery()
    const eff = q ? EMPTY_FOLDS : collapsed()
    const out: Row[] = []
    let mi = 0
    // The furthest line index still hidden by an active collapse. Regions nest by indent, so a single
    // furthest-end marker covers nested folds (an inner region's end never exceeds its parent's).
    let hiddenUntil = -1
    for (let i = 0; i < ls.length; i++) {
      const region = fbh.get(i)
      const hidden = i <= hiddenUntil
      const isCollapsed = !!region && eff.has(i)
      if (isCollapsed && !hidden) hiddenUntil = Math.max(hiddenUntil, region.end)
      const text = ls[i].text
      const runs = mergeMatchRuns(ls[i].tokens, splitByMatch(text, q)).map((r) => ({ ...r, matchIndex: r.match ? mi++ : -1 }))
      out.push({
        line: i,
        foldable: !!region,
        collapsed: isCollapsed,
        hidden,
        hiddenCount: region?.hiddenCount ?? 0,
        indent: text.length - text.trimStart().length,
        runs,
      })
    }
    return out
  })
  // Counted over the whole text: the find query never spans a newline, so per-line and whole-text
  // match totals are identical, and the count must stay stable regardless of what is folded.
  const manifestMatchCount = createMemo(() => (manifestQuery() ? splitByMatch(manifestText(), manifestQuery()).filter((s) => s.match).length : 0))
  let manifestPre: HTMLPreElement | undefined
  function scrollManifestMatch(idx: number) {
    if (!manifestPre) return
    const marks = manifestPre.querySelectorAll<HTMLElement>('mark.manifest-match')
    const target = marks[idx]
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function stepMatch(dir: 1 | -1) {
    const total = manifestMatchCount()
    if (total === 0) return
    const next = (manifestMatchIdx() + dir + total) % total
    setManifestMatchIdx(next)
    queueMicrotask(() => scrollManifestMatch(next))
  }
  // On a query change, reset to the first match AND scroll it into view — so typing reveals the first
  // hit immediately, the way the browser's own find does. Without the scroll the count read "1/3"
  // while the manifest stayed pinned at the top with the hit below the fold, and the first Enter then
  // appeared to skip straight to "2/3". Deferred a microtask so the freshly-rendered <mark>s exist
  // before we scroll. Placed below scrollManifestMatch/manifestMatchCount so the eager `on` (defer:
  // false) doesn't reference them in the temporal dead zone.
  createEffect(on(manifestQuery, () => {
    setManifestMatchIdx(0)
    if (manifestQuery() && manifestMatchCount() > 0) queueMicrotask(() => scrollManifestMatch(0))
  }))
  let findInput: HTMLInputElement | undefined

  return (
    <section
      class="manifest-section"
      classList={{ hidden: !props.active }}
      ref={sectionEl}
      role="tabpanel"
      id="drawer-tabpanel-manifest"
      aria-labelledby="drawer-tab-manifest"
    >
      <div class="manifest-head">
        {/* Single-select (YAML vs JSON) → a radiogroup, matching the toolbar's Group/Resource
            segmented controls: a screen reader hears "radio group, YAML selected, 1 of 2" and
            ←/→ move between formats. Plain toggle buttons left the active format unannounced. */}
        <span
          class="manifest-format"
          role="radiogroup"
          aria-label="Manifest format"
          onKeyDown={(e) => {
            const ids: ManifestFormat[] = ['yaml', 'json']
            const i = nextRovingIndex(e.key, ids.indexOf(format()), ids.length)
            if (i === null) return
            e.preventDefault()
            setFormat(ids[i])
            formatRefs[ids[i]]?.focus()
          }}
        >
          <For each={['yaml', 'json'] as const}>
            {(f) => (
              <button
                ref={(el) => (formatRefs[f] = el)}
                role="radio"
                aria-checked={format() === f}
                tabindex={format() === f ? 0 : -1}
                classList={{ active: format() === f }}
                onClick={() => setFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            )}
          </For>
        </span>
        {/* Within-manifest find: case-insensitive substring highlight. Enter steps through
            the matches (scrolling each into view), Esc clears without leaving the drawer. */}
        <input
          class="manifest-find"
          ref={findInput}
          placeholder="find in manifest…"
          aria-label="Find in manifest"
          value={manifestQuery()}
          onInput={(e) => setManifestQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Two-stage Esc: clear first, then blur (matches the other find/search fields,
              // cycle 268). Keeps the global Esc handler from running until both are done.
              if (manifestQuery()) setManifestQuery('')
              else (e.currentTarget as HTMLInputElement).blur()
            }
            else if (e.key === 'Enter') {
              e.preventDefault()
              stepMatch(e.shiftKey ? -1 : 1)
            }
          }}
        />
        <Show when={manifestQuery()}>
          <span class="manifest-find-count" classList={{ none: manifestMatchCount() === 0 }}>
            {manifestMatchCount() === 0
              ? 'no matches'
              : `${manifestMatchIdx() + 1}/${manifestMatchCount()}`}
          </span>
        </Show>
        <CopyButton text={() => detail() ?? ''} title="Copy manifest" />
      </div>
      <Suspense fallback={<div class="drawer-loading">loading…</div>}>
        {/* detail() throws if the fetch errored, so check detail.error before reading it.
            Same 403 split as the events tab: a policy denial names itself. */}
        <Show
          when={!detail.error && detail() != null}
          fallback={
            <div class="drawer-loading">
              {isForbidden(detail.error) ? 'Access denied — your kd role can\'t read this manifest.' : 'unavailable'}
            </div>
          }
        >
          <pre class="manifest" ref={manifestPre} tabindex="0">
            {/* One row per visible line: a fold gutter + the syntax-colored line. A collapsed header
                shows a "⋯ N lines" affordance in place of its hidden body. Search hits wrap their spans
                in a <mark> whose index drives the "current" emphasis. */}
            {/* <Index>, not <For>: rows() is one entry per source line with a stable length (a collapsed
                region's body rows stay in the DOM, clipped, rather than being dropped), so keying by
                POSITION reuses every .mf-row node and only updates each row's reactive props on a fold
                toggle. A reference-keyed <For> rebuilt all rows on every toggle (rows() yields fresh
                objects), which destroyed the scroll container's children and snapped scrollTop to the
                top mid-scroll. Reusing the nodes holds the operator's scroll position and keeps focus on
                the clicked chevron. The list is rebuilt only when lines() changes (new resource/format). */}
            <Index each={rows()}>
              {(row) => (
                <div
                  class="mf-row"
                  classList={{ 'mf-collapsed': row().collapsed, 'mf-hidden': row().hidden }}
                  aria-hidden={row().hidden || undefined}
                  style={{ '--mf-indent': row().indent }}
                >
                  <button
                    class="mf-fold"
                    classList={{ 'mf-fold-leaf': !row().foldable }}
                    tabindex={-1}
                    aria-hidden={!row().foldable}
                    aria-label={row().collapsed ? 'Expand field' : 'Collapse field'}
                    aria-expanded={row().foldable ? !row().collapsed : undefined}
                    onClick={() => row().foldable && toggleFold(row().line)}
                  >
                    {row().foldable ? (row().collapsed ? '▸' : '▾') : ''}
                  </button>
                  <span class="mf-line-content">
                    <For each={row().runs}>
                      {(run) =>
                        run.match ? (
                          <mark class="manifest-match" classList={{ current: run.matchIndex === manifestMatchIdx() }}>
                            <For each={run.spans}>{(s) => renderSpan(s)}</For>
                          </mark>
                        ) : (
                          <For each={run.spans}>{(s) => renderSpan(s)}</For>
                        )
                      }
                    </For>
                    <Show when={row().collapsed}>
                      <button class="mf-more" tabindex={-1} title={`${row().hiddenCount} lines hidden`} onClick={() => toggleFold(row().line)}>
                        {`⋯ ${row().hiddenCount} lines`}
                      </button>
                    </Show>
                  </span>
                </div>
              )}
            </Index>
          </pre>
        </Show>
      </Suspense>
    </section>
  )
}
