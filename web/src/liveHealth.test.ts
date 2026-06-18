import { describe, expect, it } from 'vitest'
import { createRoot, createSignal } from 'solid-js'
import { createLiveHealth } from './liveHealth'
import type { NamespaceInfo } from './api'

const basePoll: NamespaceInfo[] = [
  { name: 'api-b', health: 'Progressing', nonReady: 2 },
  { name: 'shop', health: 'Healthy' },
]
const apiB = (rows: NamespaceInfo[]) => rows.find((n) => n.name === 'api-b')!

// Drive the factory with plain signals standing in for the cluster-session inputs, so the cache's
// context/generation gating is exercised synchronously without mocking the /namespaces resource.
function harness<T>(run: (h: ReturnType<typeof build>) => T): T {
  return createRoot((dispose) => {
    const h = build()
    try {
      return run(h)
    } finally {
      dispose()
    }
  })
}
function build() {
  const [ctx, setCtx] = createSignal<string | null>('ctxA')
  const [pollGen, setPollGen] = createSignal(0)
  const [namespaceList, setNamespaceList] = createSignal<NamespaceInfo[]>(basePoll)
  const { mergedNamespaces, recordSummary } = createLiveHealth({ ctx, namespaceList, pollGen })
  return { ctx, setCtx, pollGen, setPollGen, namespaceList, setNamespaceList, mergedNamespaces, recordSummary }
}

describe('createLiveHealth', () => {
  it('overlays a recorded summary onto the matching namespace', () =>
    harness((h) => {
      h.recordSummary('ctxA', 'api-b', { health: 'Healthy' })
      expect(apiB(h.mergedNamespaces()).health).toBe('Healthy')
      expect(apiB(h.mergedNamespaces()).nonReady).toBeUndefined()
    }))

  it('holds the live value across an unrelated list change, then yields to a newer poll', () =>
    harness((h) => {
      h.recordSummary('ctxA', 'api-b', { health: 'Degraded', nonReady: 7 })
      // Navigating elsewhere swaps the list object but does NOT bump the poll generation:
      h.setNamespaceList([...basePoll])
      expect(apiB(h.mergedNamespaces()).health).toBe('Degraded') // no flap when leaving the namespace
      h.setPollGen(1) // a genuine 15s /namespaces poll lands
      expect(apiB(h.mergedNamespaces()).health).toBe('Progressing') // self-corrects to the poll
    }))

  it('drops a late summary whose stream context is no longer current', () =>
    harness((h) => {
      h.setCtx('ctxB')
      h.recordSummary('ctxA', 'api-b', { health: 'Healthy' }) // queued event from the torn-down ctxA stream
      h.setCtx('ctxA')
      expect(apiB(h.mergedNamespaces()).health).toBe('Progressing') // never recorded
    }))

  it("does not bleed one context's cached health into a same-named namespace of another", () =>
    harness((h) => {
      h.recordSummary('ctxA', 'api-b', { health: 'Healthy' })
      h.setCtx('ctxB') // ctxB also has an 'api-b'
      expect(apiB(h.mergedNamespaces()).health).toBe('Progressing') // ctxA's entry must not apply here
    }))
})
