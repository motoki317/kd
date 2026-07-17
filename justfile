[private]
default:
    @just --list

# Multi-line recipes use [script] (bash reads the temp file as an argument), NOT shebangs (kernel
# exec of the temp file) — shebang recipes die with EACCES when just's tempdir (XDG_RUNTIME_DIR on
# Linux) is mounted noexec, as WSL2 mounts /run/user.
set script-interpreter := ['bash', '-euo', 'pipefail']

# Run the Go API (:9123) and the Vite dev server (:5173) together.
[script]
dev:
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

# Build the client, embed it, and build the kd binary into ./kd. Stamps internal/version via
# -ldflags so the About card and `kd --version` report the build. --match 'v[0-9]*' picks the APP
# tag (vX.Y.Z), never the chart-v* tags that share the commit; --always --dirty keep it non-empty
# and mark a modified tree.
[script]
build: build-web
    v="$(git describe --tags --always --dirty --match 'v[0-9]*' 2>/dev/null || echo dev)"
    c="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    CGO_ENABLED=0 go build -tags embed_web \
      -ldflags="-s -w -X github.com/motoki317/kd/internal/version.version=${v} -X github.com/motoki317/kd/internal/version.commit=${c}" \
      -o kd ./cmd/kd

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
# error). That file gate is only sound because the flake sets proxyVendor, which
# pins vendorHash to go.mod/go.sum alone (see the comment in flake.nix).
# ~60–95s, so it is kept off the per-commit hot path.
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
