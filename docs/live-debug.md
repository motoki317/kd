# Live debugging kd (agents)

How to run kd against a real, disposable cluster and drive its actual UI. Unit tests miss real UI
bugs (coalesced key events, frozen animations, layout overflow, silent SSE aborts) — any visible or
interactive change gets verified live, and any "does the backend really send X" question gets
answered against a running cluster, not by reading code alone.

## The disposable cluster (default)

k3d + tracked fixtures: no real cluster, no leakage risk, reproducible anywhere docker runs.

```bash
just demo-up      # k3d cluster "kd-demo" + healthy demo namespaces (shop/blog/team-a)
just demo-down    # tear down
```

The kubeconfig lands at `/tmp/kd-demo.kubeconfig` (never merged into `~/.kube/config`, so kd sees
exactly one clean context, `k3d-kd-demo`). k3s bundles metrics-server: usage gauges and the Nodes
view work ~30–60 s after pods start.

### Broken shapes — `docs/demo/diagnostics/`

Tracked failure fixtures, one file per shape, each self-contained in its own `diag-<shape>`
namespace. The header comment of each file names the UI signal to assert. Apply one or all:

```bash
KUBECONFIG=/tmp/kd-demo.kubeconfig kubectl apply -f docs/demo/diagnostics/            # all shapes
KUBECONFIG=/tmp/kd-demo.kubeconfig kubectl apply -f docs/demo/diagnostics/oom.yaml    # one shape
```

crashloop · badimage · unschedulable · badconfig · readiness (never-ready, behind a Service) ·
oom · nearoom (≥90 % of limit, not killed) · jobfail (terminal Job) · initfail · multicontainer
(one bad sidecar) · quota (no child pod — ReplicaSet-only signal) · pendingpvc. Most reach their
failure state within ~60 s; delete a namespace to clear a shape.

Shapes that need interaction, not just a manifest:

- **Finalizer-stuck delete:** add a bogus finalizer to a pod, `kubectl delete --wait=false`. Clear
  it with a JSON-patch `remove` on `/metadata/finalizers` — strategic-merge `finalizers: []` does
  NOT clear it, and a stuck pod hangs its namespace in Terminating.
- **Saturated HPA:** a busybox spin loop (`while :; do :; done`, cpu request 10m) under an HPA with
  `maxReplicas: 2`, 50 % target → ScalingLimited in ~60 s.
- **Node / status conditions:** patch the `status` subresource — the kubelet self-reverts within
  seconds, so it is non-destructive; re-inject right before reading the render:
  ```bash
  KUBECONFIG=/tmp/kd-demo.kubeconfig kubectl patch node k3d-kd-demo-server-0 \
    --subresource=status --type=json \
    -p '[{"op":"replace","path":"/status/conditions/<idx>/status","value":"True"}]'
  ```
  Find `<idx>` by listing `.status.conditions` and picking the type (e.g. DiskPressure). The same
  trick fakes any rollup state (a Pod phase, unavailable replicas) without breaking anything.

New fixture rule: fictional names only (`internal/leakcheck` enforces), busybox-based, one shape
per file with its namespace inside, header naming what the UI must show.

## Running kd

```bash
just build   # MUST rebuild — embed_web bakes the client into the binary, or you test stale JS
KUBECONFIG=/tmp/kd-demo.kubeconfig ./kd -dev-user dev -addr :8099   # background task; poll /healthz
```

- Stop kd by its listening-port PID (`ss -ltnp 'sport = :8099'`) — `pkill -f 'kd -dev-user'` can
  self-match the shell that launched it.
- API base: `/api/v1/contexts/<ctx>/…` (not `/api/contexts/…`). Cluster scope is the namespace
  sentinel `__cluster__`.
- Deep-link: `?ctx=k3d-kd-demo&ns=diag-oom&group=relationship&sel=Kind/name`
  (`Kind/ns/name` cross-namespace). URL-encode an ARN-style context name.
- SSE settles ~6 s after open; a remote context's FIRST informer sync takes ~15–25 s (it shows
  `pending` in `/api/v1/contexts` until touched — trigger it by requesting its namespaces).
- kd discovers GVRs at startup: after installing a CRD, restart kd or the new kind never appears.

## Driving the UI (agent-browser)

Use the `agent-browser` CLI (the skill), not ad-hoc Playwright. Run it from a subshell so it never
shifts the persistent cwd; JS for `eval --stdin` must be an IIFE `(() => { … })()` (each eval
shares scope — bare `const` collides across evals).

```bash
(cd /tmp && agent-browser open "http://localhost:8099/?ctx=k3d-kd-demo&ns=diag-crashloop" --wait domcontentloaded)
# sleep ~6s for SSE settle, then:
(cd /tmp && agent-browser screenshot /tmp/x.png)   # then Read the PNG
```

**Measure what you changed — don't just eyeball.** A screenshot confirms layout; an `eval`
measurement confirms behaviour: assert a class, a computed style, a rect vs bounds, a count, an
order. Dispatch real events on elements (`el.dispatchEvent(new MouseEvent('click',{bubbles:true}))`).
Re-test from a narrow viewport (`agent-browser set viewport 375 667`, then reload) for overflow.

## Measurement pitfalls (headless) — check before believing a finding

The frozen headless compositor and jsdom-style gaps manufacture convincing fake bugs. Each of these
cost a real debugging session:

1. **rAF may never fire** — probe first (`requestAnimationFrame(() => window.__r = 1)`, read after
   a sleep). Every non-initial viewport move (fit, selection zoom, animateTo) is rAF-driven, so a
   transform that "didn't change" after a click proves nothing. Unit-test the fit *math*; never
   conclude a pan/zoom is broken from a headless transform diff.
2. **Entry `@keyframes` freeze at their `from` frame** — a just-mounted element measures at its
   starting offset/opacity (the drawer reads 32 px off-screen). Force `el.style.animation='none'`
   and re-measure, or load with reduced motion (`set media reduced-motion`).
3. **Transitioned properties read stale after a runtime toggle** (theme flip) — load the page
   already in the target state (set the `kd:*` localStorage pref, then re-open).
4. **`color(srgb …)`/`oklab(…)` backgrounds break naive rgb parsers** — composite the alpha
   yourself or skip; don't "fix" a contrast number from a misparsed background.
5. **The DOM lags a synchronous signal by one render tick** — assert the synchronously-committed
   attribute (`aria-expanded`), or re-measure counts after a sleep. And **re-query elements after
   an action**: Solid's reconciliation replaces nodes, so a held ref reads pre-toggle attributes
   forever.
6. **A throw inside an SSE/event listener is swallowed** (only `console.*` is captured) — the
   symptom is a feature that silently never updates. Confirm the server sends the data first; note
   the sandbox buffers streaming responses, so `curl` cannot read SSE here — use an in-browser
   `fetch` + ReadableStream or a real `EventSource` in `eval`.
7. **`graph/stream` multiplexes two node sets** — the namespace graph AND the cluster-wide
   capacity feed (all pods, no edges). Counting kinds across the whole dump conflates them; pick
   the event with non-Pod/Node kinds or non-empty `edges`.
8. **`navigator.clipboard` rejects headless** ("Document is not focused") — a missing `.copied`
   flash is the designed no-op, not broken wiring; assert the handler in unit tests.
9. **`kd:*` localStorage prefs persist across opens** and poison default-state tests —
   `localStorage.removeItem` + reload before asserting defaults.
10. **Lazy-loaded panels mount slowly under headless throttling** (the drawer is behind
    `lazy()`/Suspense) — a probe right after selecting can read "no drawer" falsely; re-probe
    before diagnosing.
11. **A wedged screenshot pipe** ("Resource temporarily unavailable") while `eval` still works —
    `agent-browser close` + fresh `open`; the page may return as `about:blank`, check
    `location.href` before blaming your last click.

View-specific interaction recipes (capacity expand/click/hover, theme audit) live in the
improvement-cycle skill's `dogfooding-kd-ui.md`.

## Real clusters — escalation only

The merged kubeconfig's real contexts (`?ctx=<arn>`) give production shapes a demo cluster can't:
dozens of pods per node, near-zero usages, varied node sizes, real CRD operators. Escalate to one
only when the k3d cluster can't reproduce the shape — and **never let a real cluster / namespace /
context / node / ARN name reach a tracked file or commit message** (AGENTS.md leakage rule;
`go test ./internal/leakcheck/` before committing any dogfooding note). Real names stay in the
browser session and gitignored scratch only.
