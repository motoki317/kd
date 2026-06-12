import { createEffect, createMemo, createResource, createSignal, For, on, Show, Suspense } from 'solid-js'
import { fetchResource, isForbidden, type ManifestFormat } from '../api'
import { splitByMatch } from '../logs'
import { nextRovingIndex } from '../rovingFocus'
import CopyButton from './CopyButton'

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
  let sectionEl: HTMLElement | undefined
  createEffect(
    on(
      () => props.nodeId,
      () => {
        setManifestQuery('')
        setManifestMatchIdx(0)
        // Scroll back to the top too — a scrolled-down manifest must not carry the operator's prior
        // position into a fresh resource.
        const mp = sectionEl?.querySelector('.manifest') as HTMLElement | null
        if (mp) mp.scrollTop = 0
      },
    ),
  )
  const manifestSegments = createMemo(() => {
    if (detail.error) return []
    return splitByMatch(detail() ?? '', manifestQuery())
  })
  const manifestMatchCount = createMemo(() => (manifestQuery() ? manifestSegments().filter((s) => s.match).length : 0))
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
            <Show when={manifestQuery()} fallback={detail()}>
              {(() => {
                // Per-segment render: each match gets a sequential index so the "current"
                // mark can be styled differently from the others. Counter lives outside the
                // For loop because Solid doesn't expose the running match index naturally.
                let mi = -1
                return (
                  <For each={manifestSegments()}>
                    {(p) => {
                      if (!p.match) return <>{p.text}</>
                      mi++
                      const idx = mi
                      return (
                        <mark
                          class="manifest-match"
                          classList={{ current: idx === manifestMatchIdx() }}
                        >
                          {p.text}
                        </mark>
                      )
                    }}
                  </For>
                )
              })()}
            </Show>
          </pre>
        </Show>
      </Suspense>
    </section>
  )
}
