---
date: "2026-06-12"
author: "@motoki317"
status: "accepted"
---

# Context

kd is going public. It ships two artifacts with different change cadences: the app (a single
static binary, also packaged as a container image) and the Helm chart that deploys it. A chart
template fix should not force an app release, and an app release should not imply the chart
changed. Both need reproducible, semver-addressed releases that a first-time user can consume
without building from source.

# Decision

**Two independent semver release tracks, both starting at 0.1.0**, driven by git tags:

- **App** — tag `vX.Y.Z` runs GoReleaser (`.goreleaser.yaml`): builds the web client, embeds
  it (`embed_web`), cross-compiles linux/darwin × amd64/arm64, publishes a GitHub Release
  (archives, checksums, conventional-commit-grouped changelog) and a multi-arch container
  image `ghcr.io/motoki317/kd:vX.Y.Z` + `latest`.
- **Chart** — tag `chart-vX.Y.Z` packages `charts/kd` and pushes it as an OCI artifact to
  `oci://ghcr.io/motoki317/charts` (so it resolves as `oci://ghcr.io/motoki317/charts/kd`).
  `Chart.yaml` is the version authority; the workflow fails if the tag and `version` disagree,
  so a tag can never silently publish a stale chart version.

The chart's `appVersion` pins the kd image tag the chart deploys by default (no more
`latest`), making `helm install` reproducible. Bumping the default image is a normal chart
change: bump `appVersion` + `version`, tag `chart-v…`.

The release image (`Dockerfile.goreleaser`) COPYs the GoReleaser-built binary into distroless
static — the binary is built once and shared between the GitHub Release and the image. The
root `Dockerfile` stays as the from-source path for users building their own image.

A plain CI workflow (push/PR) runs the same gates as the local pre-commit hook: web build,
gofmt, vet, embedded go build, both test suites, plus `helm lint`.

# Consequences

- A user installs a released chart that pulls a released, immutable image — no `latest` drift.
- Chart fixes ship same-day without cutting an app release, and vice versa.
- Release notes write themselves from Conventional Commits (already the repo convention).
- One binary build feeds GitHub Releases and ghcr — no risk of the archive and the image
  containing different builds of the same tag.

# Impact

- Two tag namespaces to remember (`v*` vs `chart-v*`); AGENTS.md documents both.
- `Chart.yaml` must be bumped before chart tags — enforced by the workflow, not convention.
- ghcr packages created by CI start private; they must be flipped to public once (with the
  repo) for anonymous `docker pull` / `helm install`.
- GoReleaser config drift is caught only at release time; CI does not run `goreleaser check`
  (acceptable: releases are infrequent and the failure is loud and pre-publish).

# Alternatives

- **One version for app + chart.** Rejected: couples cadences; most chart-only fixes would
  ship no-op app releases (and vice versa), making versions noise instead of signal.
- **Chart repository via GitHub Pages (chart-releaser).** Rejected: OCI on ghcr needs no
  extra branch/hosting, reuses the registry the image already lives in, and is the
  helm-native direction (`helm install oci://…` since Helm 3.8).
- **`latest` as the chart's default image tag.** Rejected: a chart release must deploy the
  same bits tomorrow; `latest` silently changes under a fixed chart version.
- **Hand-rolled release workflow (matrix go build + docker buildx + gh release).** Rejected:
  GoReleaser does archives/checksums/changelog/multi-arch manifests in one config with less
  YAML than the matrix, and is the ecosystem standard for Go binaries.
- **Building the release image from the root Dockerfile.** Rejected: it rebuilds web+Go from
  source under emulation for arm64 (slow) and can diverge from the released binaries.

# Notes

- Release order for a new kd version that the chart should pin: tag `vX.Y.Z` first, then bump
  `appVersion`/`version` and tag `chart-v…` — the image must exist before a chart defaults
  to it.
- GoReleaser's `dockers_v2` builds the multi-platform image natively (buildx); the Dockerfile
  reads the per-platform binary from `$TARGETPLATFORM/kd` in the build context.
- The `org.opencontainers.image.source` label links the ghcr packages to this repository.
