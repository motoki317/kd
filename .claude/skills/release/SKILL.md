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

Two **independent release tracks**, each driven by pushing a git tag (rationale: ADR
`docs/ADR/20260612-release-pipeline.md`). A normal "ship everything at X.Y.Z" cuts both, usually
on the same commit.

| Track | Tag | Workflow | Publishes |
| --- | --- | --- | --- |
| **App** | `vX.Y.Z` | `release.yaml` (GoReleaser) | GitHub Release (binaries + changelog) and image `ghcr.io/motoki317/kd:X.Y.Z` + `latest` (image tag has **no `v`**; the git tag keeps it) |
| **Chart** | `chart-vX.Y.Z` | `release-chart.yaml` | Helm chart at `oci://ghcr.io/motoki317/charts/kd` |

## Key facts that shape the flow

- **The app version comes from the tag, NOT a file** — GoReleaser stamps `main.version`/`main.commit`;
  there is no source bump to hunt for. The changelog spans commits since the previous tag.
- **The chart version DOES live in a file and CI verifies it** — `chart-vX.Y.Z` must exactly match
  `charts/kd/Chart.yaml` `version`, so a chart release is always *bump-commit-then-tag*.
- **`appVersion` pins the image the chart deploys** — bump it to `X.Y.Z` (**no `v`** — `image.tag`
  defaults to `appVersion`, and kd image tags drop the `v`) whenever the chart should ship the new
  app build.
- **Tags are lightweight and sit on the same commit** (both point at the chart-bump commit when
  cutting both).
- **Conventional-commit prefixes drive the changelog**: `feat`/`fix`/`perf` get sections;
  `docs`/`test`/`chore`/`style`/`ci` are excluded. Write good subjects *before* tagging — they
  become the public release notes.

## Runbook (both tracks at X.Y.Z)

1. **Land all work on `main`** — the tag freezes the contents; `git status` clean.
2. **Bump the chart**: `charts/kd/Chart.yaml` `version: X.Y.Z` + `appVersion: "X.Y.Z"`. Commit as
   `chore(chart): bump kd chart to X.Y.Z, pin appVersion X.Y.Z`.
3. **Pre-flight gates** (each has bitten a release — run them):
   `go test ./internal/leakcheck/` · `helm lint charts/kd` · `just check && just test` (or at
   least `just build`).
4. **Push `main`** so the tagged commit exists on the remote.
5. **Tag + push — the public, hard-to-undo step** (only when the user asked for the release):
   ```bash
   git tag vX.Y.Z && git tag chart-vX.Y.Z
   git push origin vX.Y.Z chart-vX.Y.Z
   ```
6. **Verify green**: `gh run list --limit 5`, `gh run watch <id>`; then `gh release view vX.Y.Z`
   and confirm the image/chart are pullable. (Chart job ~20s; app job slower — QEMU multi-arch.)

**App-only**: skip step 2, tag only `vX.Y.Z`. **Chart-only**: steps 2–3, tag only `chart-vX.Y.Z`.

## Traps that leave a release half-published

- **Chart tag ≠ Chart.yaml version → CI hard-fails.** Always bump+commit before tagging.
- **Tagging before pushing main** — push `main` first so history is clean and the changelog range
  correct.
- **A `chore`/`docs`-only release shows an empty app changelog** — expected; user-facing changes
  must land as `feat`/`fix`/`perf`.
- **Never move a published `vX.Y.Z` tag** — cut `vX.Y.(Z+1)`; the image and `latest` are already
  out. Deleting/overwriting a remote tag needs explicit user direction.

If the pipeline changes, update this runbook AND the AGENTS.md "Releases" pointer together; the
ADR records the decision.
