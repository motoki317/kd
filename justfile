[private]
default:
    @just --list

# Run the Go API (:8080) and the Vite dev server (:5173) together.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    go run ./cmd/kd &
    (cd web && npm run dev) &
    wait

# Run the Go API server only.
dev-server:
    go run ./cmd/kd

# Run the Vite dev server only.
dev-web:
    cd web && npm run dev

# Build the client, embed it, and build the kd binary into ./kd.
build: build-web
    CGO_ENABLED=0 go build -tags embed_web -o kd ./cmd/kd

# Build the client into the embed directory (internal/server/webdist).
build-web:
    cd web && npm run build

# Run all tests (Go + client).
test: test-go test-web

test-go:
    go test ./...

test-web:
    cd web && npm test --if-present

# Static checks: gofmt + go vet + golangci-lint + client typecheck.
check:
    @u="$(gofmt -l cmd internal)"; if [ -n "$u" ]; then echo "gofmt needed:"; echo "$u"; exit 1; fi
    go vet ./...
    golangci-lint run ./... || true
    cd web && npx tsc -b --noEmit

# Pre-commit gate (wired as a git pre-commit hook by the flake's git-hooks
# integration): every commit must build. `build` runs `tsc -b && vite build` plus
# the embedded go build; gofmt/vet and the test suites guard the rest. (Skips the
# slow advisory golangci-lint that `check` runs, to keep per-slice commits fast.)
pre-commit: build
    @u="$(gofmt -l cmd internal)"; if [ -n "$u" ]; then echo "gofmt needed:"; echo "$u"; exit 1; fi
    go vet ./...
    go test ./...
    cd web && npm test --if-present

# Verify the Nix flake build. Wired as a git pre-commit hook that runs ONLY when a
# commit touches dependency/flake files (see the `files` filter in flake.nix) — the
# only changes that break the Nix path (stale vendorHash / npmDepsHash or a flake
# error). ~60–95s, so it is kept off the per-commit hot path.
nix-build:
    nix build .#kd --no-link --print-build-logs

# Regenerate the Helm chart's values.schema.json from values.yaml, then lint the chart.
chart-schema:
    cd charts/kd && helm schema && helm lint .

# Format Go and client sources.
fmt:
    go fmt ./...
    cd web && npx prettier --write src

# Install client dependencies.
setup:
    cd web && npm install
