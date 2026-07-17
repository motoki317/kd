# Agent guide

Compact navigation aid for AI agents working on this repo — the "where do I look" sheet. Humans see
[README.md](README.md); decisions live in ADRs ([docs/ADR/](docs/ADR/)); topology-canvas mechanics in
[docs/frontend-internals.md](docs/frontend-internals.md); live debugging in
[docs/live-debug.md](docs/live-debug.md). Keep this file scannable — push detail to those.

## Repo at a glance

- Server: `cmd/kd/main.go` (entry) → `internal/server` (router, embed) → `internal/api` (REST+SSE).
- Cache: `internal/kube/store` (dynamic informer per discovered GVR, one factory per context).
- Graph: `internal/kube/graph` — `Build` produces nodes + edges from a cache snapshot;
  `Summarize`/`SummarizeBuilt` roll up to a health digest. The server streams the FULL graph; the
  client projects relationship subsets + grouping itself (no server-side view filter).
- Auth: `internal/auth` (proxy header) + `internal/rbac` (declarative policy.yaml, hot-reloaded).
- Multi-context: `internal/kube/registry` (lazy per-context cache) + `internal/kube/kubeconfig`
  (merged kubeconfig snapshot at startup).
- Client: `web/src/` Solid + Vite. Entry `index.tsx` → `App.tsx` (bootstrap + JSX; its wiring lives
  in flat factory modules: `appKeyboard.ts`, `urlState.ts`, `graphSubscription.ts`,
  `clusterSession.ts`, `selection.ts`, `sidebarHealth.ts`). Canvas: `components/Topology.tsx`
  (viewport + SVG core) with its seams in `components/topology/`; layout engines in `layout/`;
  styles in `styles/<area>.css` behind the `index.css` @import barrel.

## Where things live

| Concern | File |
| --- | --- |
| Add a grouping layout | `web/src/layout/` (relationship/kind; barrel `index.ts`) or `web/src/capacityLayout.ts` (the Nodes view) + dispatch on `groupBy` in `web/src/components/Topology.tsx` |
| Add a kind icon | official glyph (Argo CD's set): add the kind in `web/scripts/import-k8s-icons.mjs`, regenerate `web/src/k8sIconPaths.ts`; no upstream glyph: kd-drawn fragment in `web/src/icons.tsx`. Either way extend `icons.test.ts` (attribution: `NOTICE`) |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) + alias if not substring |
| Add a graph edge kind | `internal/kube/graph/edges.go` + `EdgeType` in `model.go` + a `web/src/relationships.ts` category |
| Surface a kind's "declarative essence" in the drawer | extractor in the matching `internal/kube/graph/spec_<domain>.go` (helpers in `spec.go`) — recipe below |
| Add a CR/CRD health rule | dispatch in `internal/kube/graph/health_cr.go`, family rules in `health_cr_<family>.go` + `health_cr_test.go` |
| Touch styles | `web/src/styles/<area>.css`; `index.css` is the @import barrel and documents the order-dependent cascade chains |
| Touch drawer usage gauges | `web/src/resourceBars.ts` (shared-scale bar model) → `web/src/components/UsageGauges.tsx` (render) — used by `ResourceSummary.tsx` (top gauge + workload rollup) and `ContainerCards.tsx`; rollup math in `web/src/usageAggregate.ts`. Invariants: docs/frontend-internals.md "Drawer resource gauges" |
| Add an SSE event | `internal/api/sse.go` (server) + `web/src/api.ts` (client handler) |
| Touch RBAC policy | `internal/rbac/` (schema `policy.go`, matcher `rbac.go`) + structured `policy.*` values in `charts/kd/values.yaml`; format doc in `charts/kd/README.md` |
| ADR for a decision | `docs/ADR/YYYYMMDD-title.md` (template at `_template.md`) |

### Recipe: surface a kind's "declarative essence" in the drawer

Show the spec fact the status line buries, as a labelled chip (the address-row idiom):

1. Extractor in `internal/kube/graph/spec_<domain>.go` (routing tables in `spec_routing.go`). Typed
   kinds type-assert; CRs navigate `*unstructured`.
2. Field on `Node` in `model.go` → wire in `build.go` → add to the `nodeEqual` repaint check in
   `diff.go`.
3. Labelled chip in `web/src/components/KindFacts.tsx` (+ `web/src/types.ts` field).
4. **If the extractor type-asserts a kind NOT already converted, register it in `unstructured.go`
   `typedFactories`** — the store yields `*unstructured`, so an unregistered kind leaves the field
   silently empty on real data while typed-fixture unit tests still pass.
5. NEVER emit secret values (key names + sizes only). Use a string field, not `omitempty` int, when
   `0` is meaningful (PDB disruptions).

## Build / test

```bash
just build       # vite build → embed → go build  (the authority; sets the embed_web tag)
just test        # go test + npm test
just check       # gofmt gate + go vet + (advisory) golangci-lint + tsc — run before committing Go
just dev         # Go API :9123 + Vite :5173 (proxied)
```

Three traps, each cost a debugging session:

- **Use `npm test`, NOT bare `npx vitest`.** A globally-cached vitest can parse differently and run
  without jsdom — a wall of phantom parse/`localStorage` failures that don't reproduce under
  `npm test`.
- **Typecheck with `npm run typecheck` (`tsc -b --noEmit`), NOT bare `tsc --noEmit`.** The build
  uses project references; bare `tsc` passes on errors the build then fails on. `just build` is the
  final authority.
- **CWD matters.** Web tooling runs from `web/`; a compound `cd web && …` shifts the parent shell's
  cwd and breaks the next call. Git ops from the repo root.

## Releases (two independent semver tracks)

App: tag `vX.Y.Z` → GoReleaser → GitHub Release + multi-arch image `ghcr.io/motoki317/kd:X.Y.Z`
(the **image tag drops the `v`**). Chart: bump `charts/kd/Chart.yaml` `version` first (CI fails on
mismatch) and `appVersion` (no `v` — must match the image tag), then tag `chart-vX.Y.Z` →
`oci://ghcr.io/motoki317/charts`. The runbook (order, gates, traps) is the **`release`** skill;
rationale in ADR 20260612-release-pipeline.

## Conventions

- Conventional Commits, **English**. Commit per coherent slice. Git ops ONLY when explicitly asked,
  or when moving between phases.
- **No machine-local or environment leakage — this is absolute.** Git-tracked files **and commit
  messages** must read identically on any machine and reveal nothing about the author's clusters.
  NEVER write a locally-visible resource name into the repo — no real namespace, cluster, context,
  node, service, pod, or product name; no cloud ARN, account ID, internal hostname, or
  machine-local path. No exception for the tempting cases that have leaked before: a
  dogfooding/"verified live" note, a **test fixture or its expected value**, a doc example —
  invent a placeholder and use it consistently on both the input and expected side. Use
  clearly-fictional placeholders: `<repo>/web` for paths; AWS docs identifiers (`111122223333`,
  `us-west-2`, `prod-cluster`); invented namespaces/workloads (`team-a`, `api-b`, `shop`). Real
  values stay in gitignored scratch. **Enforced by `internal/leakcheck`** — it derives the real
  names from your kubeconfig; names it can't surface go in a gitignored `.leakcheck` denylist
  (copy `.leakcheck.example`). Run `go test ./internal/leakcheck/` before committing dogfooding
  notes.
- ADRs are dated `YYYYMMDD-title.md`; design rationale lives there, not in comments.
- TDD for pure logic (`auth`, `rbac`, `graph`, layout, store mapping); fixture-driven where
  possible (`graph_test.go` decodes YAML into runtime objects). Code comments explain WHY — never
  WHAT.
- The client is Solid, not React: `createMemo`/`createEffect` (no `useEffect`); stores via
  `createStore` + `reconcile` for SSE patches.

## Verifying changes live

For ANY visible/interactive change — and any "does the backend really send X" question — drive the
real thing per **[docs/live-debug.md](docs/live-debug.md)**: `just demo-up` (throwaway k3d cluster;
tracked healthy seed + broken-shape fixtures in `docs/demo/`), `just build` (MUST rebuild — the
binary embeds the client), then the **`agent-browser`** skill (not ad-hoc Playwright). **Measure
what you changed** with `eval` — a class, a computed style, a rect vs bounds, a count, an order — a
screenshot only confirms layout; re-test from a narrow viewport for overflow. The headless
measurement pitfalls (frozen rAF/animations, stale transitions, swallowed SSE throws, …) are listed
there — check them before believing a finding. Real clusters are escalation only; never let a real
name reach a tracked file.

## Client UI gotchas (Solid / SVG / jsdom)

- **Eager `createMemo`** runs on creation → referencing a memo/`const` declared *later* throws
  (TDZ). Read `props.x` directly, or declare in dependency order.
- **Signals commit synchronously**: a discrete handler that `set`s then reads sees the new value at
  once — apply repeated keyboard actions *instantly*, not via an animation easing from the lagging
  signal, or rapid presses coalesce into one step.
- `on(dep, fn, { defer: true })` skips the initial run; wrap DOM reads in `queueMicrotask` when a
  just-set reactive class must commit first. `ref={varName}` assigns the element.
- **SVG**: `<text>` ignores CSS `text-overflow` (truncate in JS); markers default to
  `markerUnits="strokeWidth"` so arrowheads scale with a zoomed stroke; a `stroke="transparent"`
  wide path still receives pointer events — use it as a fat invisible hit target over a thin line.
- **CSS**: a two-class selector out-specifies a one-class one (no `!important`); gate animations
  behind `prefers-reduced-motion`; persist display prefs in `localStorage` under `kd:*` keys.
  Setting `display:` on a **direct child of `<details>`** out-cascades the UA rule that hides
  closed content — re-hide with an explicit `:not([open])` rule (reproduces only in a real
  browser). In a `flex-wrap` row, a **zero-basis item "fits" beside a 100%-width sibling** and
  renders 0px wide instead of wrapping — put a full-width banner OUTSIDE the flex row, or give the
  squeezed item a real flex-basis (jsdom reports no widths; only a live measure shows it).
- **jsdom limits**: `offsetParent` always null, `scrollIntoView`/`Element.animate` missing (stub),
  `getBoundingClientRect` returns zeros, `animationend` never fires (assert the class was *added*,
  not auto-removed). Unit-test the DOM contract; verify the behaviour live.
- **Clipboard on a non-secure origin** (plain `http://<lan-ip>` — a real way operators reach kd):
  `navigator.clipboard` is `undefined`, and `navigator.clipboard?.writeText(x).then(…)` throws a
  *synchronous* TypeError a trailing `.catch` can't catch. Optional-chain the WHOLE chain or wrap
  an `await` in `try/catch` (what `CopyButton`/the drawer do). Confirm only on real success; no-op
  silently otherwise.

## UI design principles (user-stated)

kd's core aim: a **human-friendly** dashboard — the UI lets perception do the work (spot, compare,
scan) rather than making the operator read and reason. In user-facing copy, show this concretely
("big things look big") instead of asserting it with adverbs like "intuitively".

Apply the **four design principles** to every visual change, each grounded in a real kd example:

- **Proximity** — related things together; a number belongs next to what it describes (each node
  bar carries its own `value / capacity` label at its right end).
- **Alignment** — shared edges/baselines (every node track starts at the same left gutter;
  "Req"/"Use" labels right-align against the bars).
- **Repetition** — ONE visual language per meaning (Req and Use bars share one colour scheme; the
  same "+N more" pill folds every crowded group in every view).
- **Contrast** — different things look clearly different; pull the eye to what matters (live value
  semibold `--text`, capacity dim `--text-dim`; a selected element stays bright while the rest
  fade).

Also: **explicit over implicit** — prefer a label/text/tooltip over a bare colour/shape ("other
namespaces" is a *labelled* bar, not just gray). **Avoid icon-only UI** — icons *with* text; if a
control row overflows, compact or relocate it.

### Design language (2026-06 overhaul — keep new work inside it)

- **Typeface = role.** IBM Plex Sans for chrome/prose; IBM Plex Mono for DATA — any name, kind,
  count, or value an operator might paste into a terminal, plus logs/manifests. (Canvas card names
  stay sans deliberately: card widths are char-count-tuned and mono is ~20% wider.)
- **Type scale tokens only** (`--fs-caps/meta/body/title` in tokens.css) — no ad-hoc px sizes.
  Nothing readable under `--fs-meta` (12.5px); `--fs-caps` is for UPPERCASE labels only.
  (Zoom-coupled canvas SVG text is exempt.)
- **Sharp corners**: `--radius-s`/`--radius-m` (2/4px). No pills, no capsules; `border-radius: 50%`
  is reserved for real status dots.
- **Resting density**: permanent chrome shows only what an operator reads every glance — search,
  layout, health, namespaces. Narrowing facets fold behind the toolbar's Filters disclosure; no
  permanent legends. A folded control must badge its active state.
- **Keyboard surface is FOUR bindings** (`/`, `↑↓`, `Esc`, `?` — appKeyboard.ts). Every action has
  a visible, clickable control. Do not add a shortcut without removing one in trade; the help card
  must stay a single small column.

## Where durable state lives (docs layout)

Long-lived context must be **git-tracked** — never parked in gitignored scratch:

- **`docs/backlog.md`** — the persistent improvement backlog (open items, future work, rejected
  list). Format + lifecycle: the **`backlog-management`** skill.
- **`docs/ADR/`** — dated decision records. **git log** — the authoritative per-change "what + why".
- **`docs/frontend-internals.md`** — deep canvas mechanics. **`docs/live-debug.md`** — the
  live-debug recipe. **`docs/plans/`** (gitignored) — volatile single-session scratch ONLY.

For self-directed improvement work ("improve the UX", work the backlog), use the
**`improvement-cycle`** skill: discover → adversarially verify against the real code → implement
one → verify live → test → commit → log. Stop when a strict re-survey yields ≈0 high-value items.

## Reference facts (deployment environment)

- **Proxy auth:** upstream `github.com/motoki317/manifest/.common/traefik-forward-auth` emits
  `X-Forwarded-User` (the header kd trusts); Grafana consumes the same via `auth.proxy`.
- **Toolchain:** go 1.26.2, node v24.14.1 (npm or corepack — no pnpm/bun), kubectl v1.36.

## Common surprises

Genuinely surprising, cross-cutting gotchas (canvas mechanics: docs/frontend-internals.md):

- **A CR field's real nesting comes from the object, not the drawer's YAML view.** Confirm
  `unstructured.Nested…` paths with `kubectl get … -o json` — the drawer's YAML viewer flattens
  indentation, so a unit test written from it passes while the real card stays blank live. Numbers
  may decode as int64 OR float64; try both.
- **`embed_web` build tag**: plain `go build` does NOT embed the client (placeholder page);
  `just build` sets the tag.
- **Events are queried LIVE, not from the cache**: `"events"` is in `store.DefaultSkipKinds`, so
  the informer snapshot NEVER holds Events. The shared `resourceEvents` helper
  (`internal/api/events.go`) builds the graph from the snapshot but fetches events via
  `store.Client().CoreV1().Events(ns).List()` at request time (`NamespaceAll` for `__cluster__`);
  the `/events/stream` SSE re-lists on a ticker (the store's change signal never fires for
  uncached kinds). Do NOT read events from `SnapshotNamespace` — the tab silently goes empty. The
  handler test must run WITHOUT `EagerKinds:["events"]`; that non-default config masks exactly
  this bug.
- **`Build` vs `BuildForLogs` vs `BuildWithLogSources` — pick by purpose**: `Build` = the displayed
  topology (`isHistorical` drops finished controller-pods and zero-replica ReplicaSets — they
  dominate real namespaces). `BuildForLogs` = anything resolving pods to READ logs (keeps completed
  pods; using `Build` made finished-run logs empty). `BuildWithLogSources` = topology filtering +
  per-node `loggable` marking from viewer-authorized source pods (sources never become graph
  nodes; callers include completed/terminal pods and enforce `logs/get` per pod namespace). An
  Argo step pod can be `Succeeded` with a failed `main`, so every log path retains completed pods.
- **Pod log container defaults to `main`, not the first container** (an Argo pod lists its `wait`
  sidecar first): `defaultLogContainer` exists in BOTH `logstream.go` and `web/src/logs.ts` — keep
  them in lockstep or the picker shows a different container than the server streams.
- **SSE `summary` event**: computed per-stream on the UNFILTERED graph; the client overrides the
  sidebar entry with it. Never roll up filtered nodes on the client.
- **Cluster-scope sentinel** `"__cluster__"` (`CLUSTER_SCOPE` / `store.ClusterScope`): a "namespace"
  by route shape, expanded server-side to the cluster-scoped snapshot; the sidebar pins it.
  Cluster-scoped objects ride along into namespace views when referenced AND drawable there
  (`store.appendRideAlong`): a PVC's PV, a RoleBinding's ClusterRole `roleRef`, and the
  ClusterRoleBindings granting a ClusterRole to a namespace SA (+ that ClusterRole) — the CRB case
  resolves in REVERSE, scanning every CRB (fine at their cardinality). A Pod's Node deliberately
  does NOT ride along: no relationship category draws `scheduledOn` (the pod↔node story is the
  Nodes view), so it would only be a permanently-orphaned card. A cluster-scoped resource's drawer
  must substitute the sentinel for its empty `{ns}` (empty path segment → 307→404).
- **PVC → PV edge** is `EdgeMounts` (not a new edge type) so the volumes view picks it up — the
  "Pod → PVC → PV" chain is complete.
- **Force empty slices to `[]` server-side**: a nil Go slice marshals as `null`, and a client
  reducer doing `[...g.edges]` throws inside the SSE listener (silently aborting it) — every
  edgeless namespace hung on "connecting…". Honor the wire contract (`[]` not `null`) AND make
  reducers defensive (`?? []`).
