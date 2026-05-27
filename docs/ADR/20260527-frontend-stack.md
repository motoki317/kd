---
date: "2026-05-27"
author: "@motoki317"
status: "accepted"
---

# Context

The client renders a 2D resource topology with clear parent-child relationships, plus detail
and log panels, with UX as the top priority. The user prefers Solid.js over React's reactive
model. We need to choose the framework, build tool, graph-layout approach, and styling, and
keep the bundle lean for a dashboard embedded in a Go binary.

# Decision

- **Framework: Solid.js + TypeScript.** Fine-grained reactivity maps well to high-frequency
  graph/status updates from the SSE feed — only changed nodes re-render, no virtual-DOM diff.
- **Build: Vite.** Fast dev server; production build is embedded into the Go binary via
  `go:embed` (architecture-overview ADR). Dev uses a Vite proxy to the Go API.
- **Graph layout: `@dagrejs/dagre`.** A mature directed-graph layout engine (the same family
  ArgoCD uses) computes node positions and edge routes for the ownership tree and other views.
  kd renders the laid-out graph itself with **SVG** driven by Solid signals — no heavyweight
  React-Flow-style dependency (none fits Solid well), keeping us in control of interaction and
  performance.
- **Rendering: SVG** for nodes/edges (crisp, accessible, easy hit-testing and CSS styling) with
  pan/zoom. Canvas is a fallback only if very large namespaces demand it.
- **Styling: a small CSS design system** (CSS custom properties for tokens; component-scoped
  CSS). Avoids a utility-framework build dependency in the embedded bundle and keeps the
  health-color palette centralized for consistency with the graph's status enum.
- **State/transport:** a thin SSE client maps `snapshot`/`patch` events into a Solid store; the
  store is the single source of truth the layout and panels read from.

Layout structure: a left namespace/scope picker, the central topology canvas, and a
right-hand drawer for resource detail / log viewer (drill-down), so operators see state and
dig in without losing context.

# Consequences

- Solid's reactivity makes live status changes cheap and keeps the UI responsive under churn.
- Dagre handles the hard layout math; we own only rendering and interaction, which is where UX
  lives.
- Lean dependency set → small embedded bundle, fast load.

# Impact

- Solid has a smaller ecosystem than React; fewer off-the-shelf components means more bespoke
  UI work (accepted — the core views are bespoke anyway).
- Hand-rolled SVG graph interaction (pan/zoom/hit-test) is non-trivial; budget for it.
- Dagre layout is synchronous and CPU-bound on huge graphs; large namespaces may need
  incremental/Web Worker layout — deferred until measured.

# Alternatives

- **React + React Flow.** Rejected: user prefers Solid; React Flow is capable but heavy and
  pulls the whole React ecosystem.
- **Cytoscape.js / vis-network.** Rejected for v1: opinionated rendering/styling fights the
  bespoke ArgoCD-style look and adds bundle weight; revisit if custom SVG hits limits.
- **Tailwind / utility CSS.** Rejected for v1: extra build dependency in the embedded asset
  pipeline for marginal benefit at this component count; a small token-based CSS system suffices.

# Notes

- Testing: Vitest + `@solidjs/testing-library` for components; the graph layout/store mapping
  (pure functions) are unit-tested without a DOM.
- Verify Solid/Vite/Dagre versions and SSE patterns against current docs (Context7) when
  scaffolding the client slice.
