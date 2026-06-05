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
- Auth: `internal/auth` (proxy header) + `internal/rbac` (Casbin-style policy.csv, hot-reloaded).
- Multi-context: `internal/kube/registry` (lazy per-context cache) + `internal/kube/kubeconfig`
  (merged kubeconfig snapshot at startup).
- Client: `web/src/` Solid + Vite. Entry `index.tsx` → `App.tsx`; shared state via signals/stores.
  Canvas internals: [docs/frontend-internals.md](docs/frontend-internals.md).

## Where things live

| Concern | File |
| --- | --- |
| Add a grouping layout | `web/src/layout.ts` (relationship/kind) or `web/src/capacityLayout.ts` (the Nodes capacity view) + dispatch on `groupBy` in `web/src/components/Topology.tsx` |
| Add a kind icon | `web/src/icons.tsx` + extend `icons.test.ts` coverage |
| Add a short kind label | `web/src/names.ts` (`KIND_SHORT_LABELS`) + alias if not substring |
| Add a graph edge kind | `internal/kube/graph/edges.go` + `EdgeType` in `model.go` + a `web/src/relationships.ts` category |
| Surface a kind's "declarative essence" in the drawer | extractor in `internal/kube/graph/spec.go` (typed kinds type-assert; CRs like HPA navigate `*unstructured`) → field on `Node` in `model.go` → wire in `build.go` → add to the `nodesEqual` repaint check in `diff.go` → render a labelled chip in `web/src/components/ResourceSummary.tsx` (+ `web/src/types.ts` field). The pattern (routes/rules → ports → DataKeys/SecretType → access/class → batch → HPA → PDB): show the spec fact the status line buries, as a chip reusing the address-row idiom. NEVER emit secret values (key names + sizes only). Use a string field, not `omitempty` int, when `0` is meaningful (PDB disruptions). |
| Add a CR/CRD health rule | `internal/kube/graph/health_cr.go` (group/kind dispatch) + `health_cr_test.go` |
| Add an SSE event | `internal/api/sse.go` (server) + `web/src/api.ts` (client handler) |
| Touch RBAC policy | `internal/rbac/` + sample `policy.csv` in `deploy/policy-configmap.yaml` |
| ADR for a decision | `docs/ADR/YYYYMMDD-title.md` (template at `_template.md`) |

## Build / test

```bash
just build       # vite build → embed → go build  (the authority; sets the embed_web tag)
just test        # go test + npm test
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

## Conventions

- Conventional Commits, **English**. Commit per coherent slice. Git ops ONLY when explicitly asked, or
  when moving between phases.
- **No machine-local or environment leakage.** Git-tracked files (code, comments, tests, docs) and
  commit messages must read identically on any machine. Never commit machine-local paths (`/Users/…`,
  `/home/…`) or private-environment state — real kubectl context/cluster names, cloud ARNs, account IDs,
  internal hostnames, private product names. Use generic placeholders: `<repo>/web` for paths, AWS's
  docs identifiers (account `111122223333`, region `us-west-2`, cluster `prod-cluster`). A real value
  needed to reproduce something stays in gitignored scratch (`docs/plans/`), never a tracked file.
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
- **ArgoCD RBAC** (pattern kd's policy.csv mirrors): `argocd/values.yaml` → `policy.default:
  role:readonly`, plus `g, <uuid>, role:admin` group bindings.
- **Toolchain:** go 1.26.2, node v24.14.1 (no pnpm/bun — npm or corepack), kubectl v1.36, dev kube
  context `docker-desktop`.

## Common surprises

Genuinely surprising, cross-cutting gotchas. (Topology-canvas mechanics — capacity view, LR layout,
collapse, edge routing, auto-fit — moved to [docs/frontend-internals.md](docs/frontend-internals.md).)

- **`embed_web` build tag**: the default `go build` does NOT embed the client (placeholder page).
  `just build` sets the tag.
- **Events are queried LIVE, not from the cache**: `"events"` is in `store.DefaultSkipKinds`
  (high-cardinality, short-lived), so the informer snapshot NEVER holds Events. The `/events` handler
  (`internal/api/events.go`) builds the graph from the snapshot (for the resource UID + owned subtree)
  but fetches the events themselves via `store.Client().CoreV1().Events(ns).List()` at request time
  (`NamespaceAll` for the `__cluster__` sentinel). Do NOT "read events from `SnapshotNamespace`" — they
  aren't there, and the Events tab silently goes empty (the f80bab1→42ee8a2 regression). The handler
  test must run WITHOUT `EagerKinds:["events"]` — eager-loading events is a config real deploys never
  use, and it masks exactly this bug.
- **SSE `summary` event**: the server emits a per-stream `summary` computed on the UNFILTERED graph; the
  client overrides the sidebar entry with it. Never roll up filtered nodes on the client — that bug is
  the whole reason `rollupHealth` was deleted.
- **Cluster-scope sentinel**: namespace `"__cluster__"` (`CLUSTER_SCOPE` / `store.ClusterScope`) is
  treated everywhere as a real namespace by route shape but expands to the cluster's cluster-scoped
  snapshot server-side. Cluster-scoped objects also ride along into namespace views when referenced (a
  Pod's Node, a PVC's PV). The sidebar pins it above the namespace list. A cluster-scoped resource's
  drawer must substitute the sentinel for its empty `{ns}` (an empty path segment → `namespaces//…` →
  307→404).
- **PVC → PV edge**: emitted as `EdgeMounts` (not a new edge type) so the existing volumes view picks it
  up automatically. The "Pod → PVC → PV" chain is complete.
- **Force empty slices to `[]` server-side**: a nil Go slice marshals as `null`, and a client reducer
  that does `[...g.edges]` throws inside the SSE listener (silently aborting it) — every edgeless
  namespace hung on "connecting…". Honor the wire contract (`[]` not `null`) AND make reducers defensive
  (`?? []`).
