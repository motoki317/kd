// The client's resource-dimension vocabulary: which of CPU / memory a usage view is showing, and how to
// read that dimension off a Resources-like object. A neutral leaf both the drawer bars (resourceBars) and
// the Nodes capacity view (capacityLayout) depend on downward — neither imports the other for it. Kept
// out of types.ts, which mirrors the Go API JSON; this is a client-only UI concept.

export type CapResource = 'cpu' | 'memory'

// resourceOf reads the active resource's quantity (CPU millicores or memory bytes) off a Resources
// object, returning undefined when that resource is unset (the absent-request case the capacity view marks).
export const resourceOf = (r: { cpuMilli?: number; memBytes?: number } | undefined, res: CapResource): number | undefined =>
  !r ? undefined : res === 'cpu' ? r.cpuMilli : r.memBytes
