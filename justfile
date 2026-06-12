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

# Fast pre-commit gate (wired as a git pre-commit hook by the flake's git-hooks
# integration). Skips the slow advisory golangci-lint that `check` runs, to keep
# per-slice commits fast.
pre-commit:
    @u="$(gofmt -l cmd internal)"; if [ -n "$u" ]; then echo "gofmt needed:"; echo "$u"; exit 1; fi
    go vet ./...
    cd web && npx tsc -b --noEmit
    go test ./...
    cd web && npm test --if-present

# Full pre-push gate (wired as a git pre-push hook): both build paths must pass
# before anything leaves the machine — `just build` (local toolchain) and the Nix
# flake build (which also catches a stale vendorHash / npmDepsHash).
pre-push: build
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
