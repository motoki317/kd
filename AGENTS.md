# Agent guide

Compact navigation aid for AI agents working on this repo — the "where do I look" sheet. Humans see
[README.md](README.md); decisions live in ADRs ([docs/ADR/](docs/ADR/)); deep topology-canvas
mechanics live in [docs/frontend-internals.md](docs/frontend-internals.md). Keep this file scannable —
push detail to those.

## Repo at a glance

- Server: `cmd/kd/main.go` (entry) → `internal/server` (router, embed) → `internal/api` (REST+SSE).
- Cache: `internal/kube/store` (dynamic informer per discovered GVR, one factory per context).
- Graph: `internal/kube/graph` — `Build` produces nodes + edges (every relationship) from a cache
  snapshot; `Summarize`/`SummarizeBuilt` roll up to a health digest. The server streams the FULL
  graph; the client projects relationship subsets + grouping itself (no server-side view Filter).
- Auth: `internal/auth` (proxy header) + `internal/rbac` (declarative policy.yaml — roles/users/
  groups/deny, hot-reloaded).
- Multi-context: `internal/kube/registry` (lazy per-context cache) + `internal/kube/kubeconfig`
  (merged kubeconfig snapshot at startup).
- Client: `web/src/` Solid + Vite. Entry `index.tsx` → `App.tsx` (bootstrap + JSX; its wiring lives
  in flat factory modules: `appKeyboard.ts`, `urlState.ts`, `graphSubscription.ts`, `clusterSession.ts`,
  `selection.ts`, `sidebarHealth.ts`). Canvas: `components/Topology.tsx` (viewport + SVG core) with its
  seams in `components/topology/`; layout engines in `layout/`; styles in `styles/<area>.css` behind the
  `index.css` @import barrel. Canvas internals: [docs/frontend-internals.md](docs/frontend-internals.md).

## Where things live

| Concern | File |
| --- | --- |
| Add a grouping layout | `web/src/layout/` (relationship/kind; barrel `index.ts` re-exports the public surface) or `web/src/capacityLayout.ts` (the Nodes capacity view) + dispatch on `groupBy` in `web/src/components/Topology.tsx` |
| Add a kind icon | official glyph (Argo CD's set): add the kind in `web/scripts/import-k8s-icons.mjs` and regenerate `web/src/k8sIconPaths.ts`; no upstream glyph: kd-drawn stroke fragment in `web/src/icons.tsx`. Either way extend `icons.test.ts` coverage (attribution: `NOTICE`) |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) + alias if not substring |
| Add a graph edge kind | `internal/kube/graph/edges.go` + `EdgeType` in `model.go` + a `web/src/relationships.ts` category |
| Surface a kind's "declarative essence" in the drawer | extractor in the matching `internal/kube/graph/spec_<domain>.go` (shared helpers in `spec.go`) — full recipe below the table |
| Add a CR/CRD health rule | dispatch in `internal/kube/graph/health_cr.go`, family rules in `health_cr_<family>.go` + `health_cr_test.go` |
| Touch styles | `web/src/styles/<area>.css`; `index.css` is the @import barrel and documents the order-dependent cascade chains |
| Touch drawer usage gauges | `web/src/resourceBars.ts` (shared-scale bar model) → `web/src/components/UsageGauges.tsx` (render: tracks/fills/segments/legend/caption) — used by `ResourceSummary.tsx` (pod/Node top gauge + workload rollup with by-pod/by-container split) and `ContainerCards.tsx` (per-container bars); rollup math in `web/src/usageAggregate.ts`. Invariants in docs/frontend-internals.md "Drawer resource gauges" |
| Add an SSE event | `internal/api/sse.go` (server) + `web/src/api.ts` (client handler) |
| Touch RBAC policy | `internal/rbac/` (schema in `policy.go`, matcher in `rbac.go`) + structured `policy.*` values in `charts/kd/values.yaml`; format doc in `charts/kd/README.md` |
| ADR for a decision | `docs/ADR/YYYYMMDD-title.md` (template at `_template.md`) |

### Recipe: surface a kind's "declarative essence" in the drawer

The pattern (routes/rules → ports → DataKeys/SecretType → access/class → batch → HPA → PDB → node
taints → NetworkPolicy → Certificate → Issuer): show the spec fact the status line buries, as a chip
reusing the address-row idiom.

1. Extractor in the matching `internal/kube/graph/spec_<domain>.go` (routing tables in
   `spec_routing.go`). Typed kinds type-assert; CRs like HPA navigate `*unstructured`.
2. Field on `Node` in `model.go` → wire in `build.go` → add to the `nodeEqual` repaint check in
   `diff.go`.
3. Render a labelled chip in `web/src/components/KindFacts.tsx` (+ `web/src/types.ts` field).
4. **If the extractor type-asserts a kind NOT already converted, register it in `unstructured.go`
   `typedFactories`** — the dynamic-informer store yields `*unstructured`, so an unregistered kind
   leaves the assertion failing and the field silently empty on real data, while typed-fixture unit
   tests still pass (cost a live-verify round on NetworkPolicy).
5. NEVER emit secret values (key names + sizes only). Use a string field, not `omitempty` int, when
   `0` is meaningful (PDB disruptions).

## Build / test

```bash
just build       # vite build → embed → go build  (the authority; sets the embed_web tag)
just test        # go test + npm test
just check       # gofmt gate + go vet + (advisory) golangci-lint + tsc — run before committing Go
just dev         # Go API :9123 + Vite :5173 (proxied)
go test ./...                # Go tests only
cd web && npm test           # web tests only — MUST run from web/
```

Three traps, each cost a debugging session — heed them:

- **Use `npm test`, NOT bare `npx vitest`.** `npx vitest run` can resolve a different globally-cached
  vitest whose rolldown can't parse the project's JSX/tsconfig and runs without jsdom — a wall of
  phantom `RolldownError: Parse failure` / `localStorage is not defined` failures that don't reproduce
  under `npm test`. If a full run suddenly fails ~10 files on parse/env errors while single-file runs
  pass, this is it.
- **Typecheck with `npm run typecheck` (`tsc -b --noEmit`), NOT bare `tsc --noEmit`.** The build uses
  project references (`tsconfig.app.json` carries the strict app settings); bare `tsc` uses the root
  tsconfig and passes on errors the build then fails on. `just build` is the final authority.
- **CWD matters.** Web tooling must run from `web/`; a compound `cd web && …` shifts the parent shell's
  cwd and breaks the next call. `cd <repo>/web` before web tooling; git ops from the repo root.

## Releases (two independent semver tracks)

- **App** — tag `vX.Y.Z` → GoReleaser (`.goreleaser.yaml`): GitHub Release (linux/darwin
  binaries + changelog) and multi-arch image `ghcr.io/motoki317/kd:X.Y.Z` + `latest`. The git tag
  keeps the `v` (the release trigger); the **image tag drops it** (`X.Y.Z`, not `vX.Y.Z`).
- **Chart** — tag `chart-vX.Y.Z` → `helm push` to `oci://ghcr.io/motoki317/charts` (lands at
  `ghcr.io/motoki317/charts/kd`). Bump `charts/kd/Chart.yaml` `version` first (CI fails on
  mismatch); bump `appVersion` to `X.Y.Z` (no `v` — it must match the image tag) to pin a new kd
  image. Rationale: ADR 20260612-release-pipeline.

## Conventions

- Conventional Commits, **English**. Commit per coherent slice. Git ops ONLY when explicitly asked, or
  when moving between phases.
- **No machine-local or environment leakage — this is absolute.** Git-tracked files (code, comments,
  tests, docs) **and commit messages** must read identically on any machine and reveal nothing about the
  author's clusters. **NEVER write a locally-available resource name into the repo** — not a namespace,
  cluster, context, node, service, pod, middleware, or product name you can see in *your* kube
  environment, and not a cloud ARN / account ID / internal hostname / machine-local path (`/Users/…`,
  `/home/…`). This binds **everywhere**, with no exception for the tempting cases that have leaked before:
  a dogfooding/"verified live" note (in a commit message, `docs/backlog.md`, or a code comment), a **test
  fixture or its expected value**, an example in a doc. Describing a real finding is never a license to
  name the real resource — invent a placeholder and use it consistently on both the input and the
  expected side. Use generic, clearly-fictional placeholders: `<repo>/web` for paths; AWS docs
  identifiers (account `111122223333`, region `us-west-2`, cluster `prod-cluster`); invented namespaces/
  workloads (`team-a`, `api-b`, `shop`). A real value needed to reproduce something stays in gitignored
  scratch (`docs/plans/` or a session-only browser tab), never a tracked file.
  - **Enforced by a test:** `internal/leakcheck` derives the real kube context/cluster/namespace names
    and account IDs from your local kubeconfig (it hardcodes none — it stays cluster-agnostic) and fails
    if any reaches a tracked file. Names a kubeconfig can't surface (internal product/service names) go in
    a gitignored `.leakcheck` denylist — copy `.leakcheck.example`. Run `go test ./internal/leakcheck/`
    before committing dogfooding notes.
- ADRs are dated `YYYYMMDD-title.md`; design rationale lives there, not in comments.
- TDD for pure logic (`auth`, `rbac`, `graph`, layout, store mapping). Fixture-driven where possible
  (`graph_test.go` decodes YAML into runtime objects).
- Code comments explain WHY (non-obvious decisions, hidden constraints) — never WHAT.
- The client is Solid, not React: `createMemo`/`createEffect` (no `useEffect`); stores via
  `createStore` + `reconcile` for SSE patches.

## Verifying UI changes live (agent-browser)

Tests alone miss real UI bugs (coalesced key events, toolbar overflow, focus escapes, a fade that never
fires, a length-encoding that overshoots on real data). For ANY visible/interactive change, drive the
**actual** UI with the **`agent-browser`** CLI (the `agent-browser` skill — NOT ad-hoc Playwright).
Build first; the server embeds the client:

```bash
just build                                                  # MUST rebuild (embed_web) or you test stale JS
pkill -f 'kd -dev-user'; ./kd -dev-user dev -addr :8099 &   # poll /healthz before driving it
```
Drive it (run agent-browser from a subshell — `cd` shifts the persistent cwd; keep git/build at the
repo root). JS for `eval --stdin` MUST be an IIFE `(() => { … })()`:
```bash
(cd /tmp && agent-browser open "http://localhost:8099/?ctx=<ctx>&ns=<ns>&group=nodes" --wait domcontentloaded)
sleep 6   # SSE settle; ~15s for a remote EKS context's FIRST informer sync
(cd /tmp && agent-browser screenshot /tmp/x.png)   # then Read the PNG to eyeball layout
```
- **Measure what you changed**, don't just eyeball it: assert a class (`.faded`), a computed
  `fill`/`strokeDasharray`, an element's rect vs the drawer bounds, a count, a left-to-right order. A
  screenshot confirms layout; an `eval` measurement confirms behaviour. Re-test from a narrow viewport
  for overflow.
- **Dogfood against real data.** kd's merged kubeconfig exposes every context; `?ctx=<arn>` at a real
  cluster hits production shapes (dozens of pods/node, near-zero usages, terminal pods) docker-desktop
  never reproduces. **Never let a real cluster/namespace/ARN name reach a tracked file** (see the
  leakage rule) — keep it in the browser session only.
- The frozen-compositor caveat (rAF/animations never advance headless → fake fit/overflow bugs) and the
  full recipe set live in the **`improvement-cycle`** skill's `dogfooding-kd-ui.md`.

## Client UI gotchas (Solid / SVG / jsdom)

- **Eager `createMemo`** runs on creation → referencing a memo/`const` declared *later* throws (TDZ).
  Read `props.x` directly, or declare in dependency order.
- **Signals commit synchronously**: a discrete handler (keypress) that `set`s then reads sees the new
  value at once — apply repeated keyboard actions *instantly*, not via an animation easing from the
  lagging signal, or rapid presses coalesce into one step.
- `on(dep, fn, { defer: true })` skips the initial run; wrap DOM reads in `queueMicrotask` when you need
  a just-set reactive class committed first. `ref={varName}` assigns the element to `varName`.
- **SVG**: `<text>` ignores CSS `text-overflow` (truncate in JS); markers default to
  `markerUnits="strokeWidth"` so arrowheads scale with a zoomed stroke; a `stroke="transparent"` wide
  path still receives pointer events — use it as a fat invisible hit target over a thin line.
- **CSS**: a two-class selector out-specifies a one-class one (no `!important`); gate animations behind
  `@media (prefers-reduced-motion: reduce)`; persist display prefs in `localStorage` under `kd:*` keys.
  Setting `display:` on a **direct child of `<details>`** out-cascades the UA rule that hides closed
  content (`details:not([open]) > :not(summary){display:none}`), so the section shows whether open or
  closed and the `<summary>` becomes a dead toggle — re-hide with an explicit `:not([open])` rule. (Only
  reproduces in a real browser; jsdom renders neither CSS nor native `<details>` toggling — verify live.)
  In a `flex-wrap` row, a **zero-basis item "fits" beside a 100%-width sibling on the same line** (zero
  hypothetical size fits zero remaining space) and renders 0px wide instead of wrapping — a full-width
  banner added inside a flex header silently collapsed the summary beside it to invisible. Put the
  banner OUTSIDE the flex row (a sibling), or give the squeezed item a real flex-basis. (Caught live in
  the drawer deleted-banner work; jsdom reports no widths, so only a live measure shows it.)
- **jsdom limits**: `offsetParent` is always null, `scrollIntoView`/`Element.animate` are missing (stub
  them), `getBoundingClientRect` returns zeros, and `animationend` never fires (assert the class was
  *added*, not auto-removed). Unit-test the DOM contract; verify the behaviour live.
- **Clipboard in a non-secure context**: `navigator.clipboard` is `undefined` on any non-secure origin
  (plain `http://<lan-ip>` — a real way operators reach a port-forwarded kd). `navigator.clipboard?.writeText(x).then(…)`
  optional-chains only `clipboard`, so `?.writeText(x)` is `undefined` and the bare `.then` throws a
  *synchronous* TypeError a trailing `.catch` can't catch. Either optional-chain the WHOLE chain
  (`?.writeText(x)?.then(…)?.catch(…)`) or wrap an `await navigator.clipboard.writeText(x)` in `try/catch`
  (what `CopyButton`/the drawer/label-chips do). Confirm only on real success; no-op silently otherwise.

## UI design principles (user-stated)

kd's core aim: a **human-friendly** dashboard built with deep consideration of human cognitive
characteristics — the UI lets perception do the work (spot, compare, scan) rather than making the
operator read and reason. In user-facing copy, show this concretely ("big things look big") instead
of asserting it with adverbs like "intuitively".

Apply the **four design principles** to every visual change — group **related** info so it reads at a
glance, and make structure legible without a legend. Each is grounded in a real kd example:

- **Proximity** — related things together; a number belongs next to what it describes. *kd:* each node
  bar carries its own `value / capacity` label at its right end.
- **Alignment** — line elements up on shared edges/baselines. *kd:* every node track starts at the same
  left gutter; "Req"/"Use" axis labels right-align against the bars.
- **Repetition** — reuse ONE visual language per meaning. *kd:* Req and Use bars share one colour scheme
  (req is not a lighter shade); the same "+N more" pill folds every crowded group across every view.
- **Contrast** — make different things look clearly different; pull the eye to what matters. *kd:* the
  live value is emphasized (`--text`, semibold), its capacity dim (`--text-dim`); a selected element
  stays bright while the rest fade.

Also: **explicit over implicit** — prefer a label/text/tooltip over making the operator infer a bare
colour/shape (*kd:* "other namespaces" is a *labelled* bar, not just gray). **Avoid icon-only UI** — use
icons *with* text or a text label; if a control row overflows, compact or relocate it.

### Design language (2026-06 overhaul — keep new work inside it)

The user-directed de-AI-slop overhaul fixed a concrete visual language; hold every change to it:

- **Typeface = role.** IBM Plex Sans for chrome/prose; IBM Plex Mono for DATA — any name, kind,
  count, or value an operator might paste into a terminal, plus logs/manifests. (Canvas card names
  stay sans deliberately: card widths are char-count-tuned and mono is ~20% wider.)
- **Type scale tokens only** (`--fs-caps/meta/body/title` in tokens.css) — no ad-hoc px sizes.
  Nothing readable sits under `--fs-meta` (12.5px); `--fs-caps` is for UPPERCASE labels only, where
  tracking+caps carry the hierarchy, not smallness. (Zoom-coupled canvas SVG text is exempt.)
- **Sharp corners**: `--radius-s`/`--radius-m` (2/4px). No pills, no capsules; `border-radius: 50%`
  is reserved for real status dots.
- **Resting density**: the permanent chrome shows only what an operator reads every glance —
  search, layout, health, namespaces. Narrowing facets (relationship/kind chips) fold behind the
  toolbar's Filters disclosure; no permanent legends (rows explain themselves on hover; the health
  pills pair color+word where they're used). A folded control must badge its active state.
- **Keyboard surface is FOUR bindings** (`/`, `↑↓`, `Esc`, `?` — appKeyboard.ts). Every action has
  a visible, clickable control. Do not add a shortcut without removing one in trade; the help card
  must stay a single small column.

## Where durable state lives (docs layout)

Long-lived context must be **git-tracked** so it survives across agents and is visible to humans — never
parked in gitignored scratch:

- **`docs/backlog.md`** (git-tracked) — the persistent improvement backlog: open items, future work, and
  a "rejected — do not re-propose" list. The single home for improvement tasks.
- **`docs/ADR/`** (git-tracked) — dated decision records; design rationale, not comments.
- **`docs/frontend-internals.md`** (git-tracked) — deep topology-canvas mechanics (layouts, collapse,
  edge routing, fit) that would bloat this file.
- **git log** — the authoritative per-change "what + why" (Conventional Commits, one per slice).
- **`docs/plans/`** (gitignored) — **volatile single-session scratch only.** Never the backlog or
  long-term tasks.

For self-directed improvement work ("improve the UX", "find things to improve", work the backlog), use
the **`improvement-cycle`** skill: discover → adversarially verify each candidate against the real code →
implement one → verify live → test → commit → log. The **`backlog-management`** skill defines the backlog
format + lifecycle. Stop generating when a strict re-survey yields ≈0 high-value items.

## Reference facts (deployment environment)

- **Proxy auth:** upstream `github.com/motoki317/manifest/.common/traefik-forward-auth` emits
  `X-Forwarded-User` (the header kd trusts); Grafana consumes the same via `auth.proxy` in
  `monitor/values-grafana.yaml`.
- **Toolchain:** go 1.26.2, node v24.14.1 (no pnpm/bun — npm or corepack), kubectl v1.36, dev kube
  context `docker-desktop`.

## Common surprises

Genuinely surprising, cross-cutting gotchas. (Topology-canvas mechanics — capacity view, LR layout,
collapse, edge routing, auto-fit — moved to [docs/frontend-internals.md](docs/frontend-internals.md).)

- **A CR field's real nesting comes from the object, not the drawer's YAML view.** When writing an
  unstructured reader (`unstructured.Nested…(u.Object, path…)`), confirm the path with `kubectl get …
  -o json` (or `-o jsonpath`). The drawer's YAML viewer indents `spec:`'s children to a shallow level,
  so a `spec.summary` reads like a top-level `summary` — a unit test written from that wrong assumption
  passes while the real card stays blank live (the policy-report `spec.summary` vs wgpolicy top-level
  `summary` bug). Numbers may decode as int64 OR float64, so try both.
- **`embed_web` build tag**: the default `go build` does NOT embed the client (placeholder page).
  `just build` sets the tag.
- **Events are queried LIVE, not from the cache**: `"events"` is in `store.DefaultSkipKinds`
  (high-cardinality, short-lived), so the informer snapshot NEVER holds Events. The shared
  `resourceEvents` helper (`internal/api/events.go`) builds the graph from the snapshot (for the
  resource UID + owned subtree) but fetches the events themselves via
  `store.Client().CoreV1().Events(ns).List()` at request time (`NamespaceAll` for the `__cluster__`
  sentinel). Both the REST `/events` handler and the `/events/stream` SSE feed call it — the stream
  re-lists on a server-side ticker and pushes only diffs (it does NOT wake on the store's change
  signal, which only fires for cached/watched kinds). Do NOT "read events from `SnapshotNamespace`" —
  they aren't there, and the Events tab silently goes empty (the f80bab1→42ee8a2 regression). The
  handler test must run WITHOUT `EagerKinds:["events"]` — eager-loading events is a config real deploys
  never use, and it masks exactly this bug.
- **`Build` vs `BuildForLogs` — pick by purpose**:
  - `graph.Build` is for the **displayed topology**. It runs `isHistorical`, which drops finished
    controller-pods (`Succeeded` under a Job/CronJob/Workflow) and zero-replica ReplicaSets — they
    dominate real namespaces and never reflect current state.
  - `graph.BuildForLogs` is for **anything that resolves pods to read their logs**. It keeps completed
    pods (still drops superseded ReplicaSets). A finished Job/CronJob/Workflow has nothing BUT
    completed pods, so resolving through `Build` aggregated zero pods and the Logs tab was silently
    empty (e5c190c).
  - Two twists that compound it: (1) an Argo step pod's phase is `Succeeded` even when the step
    container exits non-zero (the `wait` sidecar completes the pod), so a FAILED workflow's failure
    logs live in a pod `isHistorical` would drop; (2) these pods are absent from the SSE display
    graph, so `hasDescendantPod` returns false — a finished Workflow needs `Workflow` in
    `LOGGABLE_KINDS` to show the tab.
- **Pod log container defaults to `main`, not the first container**: an Argo pod lists its `wait`
  executor sidecar (and `init`) BEFORE `main`, so defaulting to `pod.Spec.Containers[0]` streamed pure
  executor noise. Both server (`defaultLogContainer` in `logstream.go`) and client (`defaultLogContainer`
  in `web/src/logs.ts`) prefer a container named `main`, falling back to the first — keep the two in
  lockstep or the picker shows a different container than the server streams.
- **SSE `summary` event**: the server emits a per-stream `summary` computed on the UNFILTERED graph; the
  client overrides the sidebar entry with it. Never roll up filtered nodes on the client — that bug is
  the whole reason `rollupHealth` was deleted.
- **Cluster-scope sentinel** `"__cluster__"` (`CLUSTER_SCOPE` / `store.ClusterScope`):
  - Treated everywhere as a real namespace by route shape, but expands to the cluster's
    cluster-scoped snapshot server-side. The sidebar pins it above the namespace list.
  - Cluster-scoped objects ride along into namespace views when referenced AND drawable there
    (`store.appendRideAlong`): a PVC's PV (via the `mounts` edge), a RoleBinding's ClusterRole
    `roleRef`, and the ClusterRoleBindings that grant a ClusterRole to a ServiceAccount in the
    namespace (+ that ClusterRole — the RBAC view's whole reason cluster-scoped grants are visible
    from inside a namespace). The CRB case is resolved in REVERSE (the binding names the namespaced
    SA), so it scans every ClusterRoleBinding — fine at their cardinality, unlike CRs. A Pod's Node
    deliberately does NOT ride along: no relationship category draws the `scheduledOn` edge (the
    pod↔node story is the Nodes group-by view), so a rode-along Node only ever appeared as a
    permanently-orphaned card.
  - A cluster-scoped resource's drawer must substitute the sentinel for its empty `{ns}` (an empty
    path segment → `namespaces//…` → 307→404).
- **PVC → PV edge**: emitted as `EdgeMounts` (not a new edge type) so the existing volumes view picks it
  up automatically. The "Pod → PVC → PV" chain is complete.
- **Force empty slices to `[]` server-side**: a nil Go slice marshals as `null`, and a client reducer
  that does `[...g.edges]` throws inside the SSE listener (silently aborting it) — every edgeless
  namespace hung on "connecting…". Honor the wire contract (`[]` not `null`) AND make reducers defensive
  (`?? []`).
