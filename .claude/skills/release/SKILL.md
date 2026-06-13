---
name: release
description: >-
  Use when cutting a kd release — publishing a new version of the kd app and/or its Helm chart, or
  when the user says "release X.Y.Z", "tag a release", "ship a new version", or "publish the chart".
  Encodes the two independent semver tracks (app `vX.Y.Z` → GoReleaser; chart `chart-vX.Y.Z` →
  helm push), the exact order of operations, the pre-flight gates, and the traps that fail a release
  half-published. Reach for this whenever a git tag is about to trigger a public artifact.
---

# Cutting a kd release

kd has **two independent release tracks**, each driven by pushing a git tag. The authoritative
summary is AGENTS.md "Releases" and ADR `docs/ADR/20260612-release-pipeline.md` — read those for the
*why*; this skill is the *runbook* for actually doing it without leaving a release half-done.

| Track | Tag pattern | Workflow | Publishes |
| --- | --- | --- | --- |
| **App** | `vX.Y.Z` | `.github/workflows/release.yaml` (GoReleaser) | GitHub Release (linux/darwin binaries + changelog) and multi-arch image `ghcr.io/motoki317/kd:vX.Y.Z` + `latest` |
| **Chart** | `chart-vX.Y.Z` | `.github/workflows/release-chart.yaml` | Helm chart OCI artifact at `oci://ghcr.io/motoki317/charts/kd` |

The tracks are independent: you can release the app without the chart and vice-versa. A normal "ship
everything at version X.Y.Z" cuts **both**, usually on the same commit.

## Key facts that shape the flow

- **The app version comes from the tag, NOT a file.** GoReleaser stamps `main.version`/`main.commit`
  from the `vX.Y.Z` tag. There is **no source bump** for an app release — do not go hunting for a
  version constant to edit. The changelog spans commits since the previous tag (`fetch-depth: 0`).
- **The chart version DOES live in a file and CI verifies it.** `release-chart.yaml` fails unless
  `chart-vX.Y.Z` exactly matches `charts/kd/Chart.yaml` `version`. So a chart release is always
  *bump-commit-then-tag*, never tag-first.
- **`appVersion` pins the image the chart deploys by default.** Bump `charts/kd/Chart.yaml`
  `appVersion` to `vX.Y.Z` whenever the chart should ship the new app build (the usual case when
  cutting both together). `image.tag` still overrides per-install.
- **Tags are lightweight and sit on the same commit** (matches `v0.1.0` / `chart-v0.1.0`). When
  cutting both tracks together, both tags point at the chart-bump commit.
- **Conventional-commit prefixes drive the app changelog.** `feat`/`fix`/`perf` get their own
  sections; `docs`/`test`/`chore`/`style`/`ci` are excluded. Write good commit subjects *before*
  tagging — they become the public release notes.

## The runbook (cutting both app + chart at X.Y.Z)

1. **Land all the work on `main` first.** Every change that should be in the release must be committed
   (and pushed) before any tag — the tag freezes the release contents. Confirm a clean tree:
   `git status` shows nothing to commit.
2. **Bump the chart** in `charts/kd/Chart.yaml`: set `version: X.Y.Z` and `appVersion: "vX.Y.Z"`.
   Commit as `chore(chart): bump kd chart to X.Y.Z, pin appVersion vX.Y.Z` (chore → excluded from the
   app changelog, correctly).
3. **Pre-flight gates** (each has bitten a release before — run them, don't assume):
   - `go test ./internal/leakcheck/` — never publish a tree leaking a real cluster/namespace/ARN name.
   - `helm lint charts/kd` — the same lint CI runs; catches a bad chart before the tag does.
   - `just check && just test` (or at least `just build`) — the release builds embed the web client.
4. **Push `main`** so the tagged commit exists on the remote: `git push origin main`.
5. **Create the lightweight tags on HEAD** and push them — *this is the public, hard-to-undo step*:
   ```bash
   git tag vX.Y.Z && git tag chart-vX.Y.Z
   git push origin vX.Y.Z chart-vX.Y.Z
   ```
   Pushing the tags triggers the workflows immediately. Treat it like any outward-facing publish:
   only do it when the user has asked for the release (they did if they're invoking this skill);
   otherwise confirm first.
6. **Verify the workflows ran green:**
   ```bash
   gh run list --limit 5          # both "Release kd" and "Release chart" should appear queued/running
   gh run watch <run-id>          # or watch until success
   ```
   The chart job is quick (~20s: lint + package + push). The app job is slower (multi-arch image
   build via QEMU). On success, confirm the GitHub Release exists (`gh release view vX.Y.Z`) and the
   image/chart are pullable.

**App-only** release: skip steps 2 (chart bump) — just tag `vX.Y.Z` on the commit you want and push.
**Chart-only** release: do steps 2–3, tag only `chart-vX.Y.Z`, push.

## Traps that leave a release half-published

- **Chart tag ≠ Chart.yaml version → CI hard-fails.** If you tag `chart-vX.Y.Z` without bumping
  `version` to `X.Y.Z` first, the release job exits 1 at the verify step. Always bump+commit before
  tagging; the bump commit is what the tag should point at.
- **Tagging before pushing the commit.** The tag references a commit; if `main` wasn't pushed, the
  workflow may run against a commit the remote just received via the tag push — push `main` first so
  history is clean and the changelog range is correct.
- **A `chore`/`docs`-only release shows an empty app changelog.** Expected — those prefixes are
  filtered. If the release genuinely has user-facing changes, make sure they landed as `feat`/`fix`/
  `perf` commits, not buried under `chore`.
- **Re-tagging a published version.** Don't move a `vX.Y.Z` tag after the image/release exists — cut
  `vX.Y.(Z+1)` instead. The image tag and `latest` are already out.
- **Deleting/overwriting a remote tag** is an outward-facing action with downstream pull impact —
  never do it without explicit user direction.

## Updating this skill

If the pipeline changes (new workflow step, a version moves into a file, a new track), update this
runbook AND the AGENTS.md "Releases" section together — the ADR records the decision, this skill and
AGENTS are the operational copies that must not drift.
