// Pure graph layout: turns nodes+edges into positioned geometry. No DOM, so it is
// unit-testable. See docs/ADR/20260527-frontend-stack.md.
//
// Barrel for the layout modules; the explicit named re-exports below ARE the public surface —
// importers use './layout' and never reach into the sibling modules. Internally the modules
// import each other directly (never through this barrel) to keep the graph cycle-free:
// core ← collapse ← hubs ← relationship, and core/collapse ← kind ← relationship.

export { byName, COLLAPSE_KIND, NODE_HEIGHT, NODE_WIDTH } from './core'
export type { CollapseMeta, Layout, Point, PositionedNode } from './core'
export { COLLAPSE_VISIBLE, connGroups } from './collapse'
export { kindGroups, layoutGraphByKind } from './kind'
export { layoutGraph, layoutGraphWithOrphans } from './relationship'
export type { OrphanLayout } from './relationship'
