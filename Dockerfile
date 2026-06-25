# Build the client, embed it into the Go binary, and ship a minimal static image.

FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# Emits into the Go server package (see web/vite.config.ts outDir).
RUN npm run build

FROM golang:1.26-alpine AS server
WORKDIR /src
# git: the build stamps internal/version from `git describe` (the .git dir rides in via COPY . .),
# matching `just build`, so a local `docker build .` carries the same identity. Keep .git in the
# build context (do not add a .dockerignore that drops it) or the stamp falls back to "dev".
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Bring in the built client so go:embed (embed_web tag) can include it.
COPY --from=web /internal/server/webdist ./internal/server/webdist
# safe.directory clears git's dubious-ownership guard on the root-owned copy; --match 'v[0-9]*'
# picks the app tag (vX.Y.Z), never the chart-v* tags sharing the commit.
RUN git config --global --add safe.directory /src && \
    VERSION="$(git describe --tags --always --dirty --match 'v[0-9]*' 2>/dev/null || echo dev)" && \
    COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)" && \
    CGO_ENABLED=0 go build -tags embed_web \
      -ldflags="-s -w -X github.com/motoki317/kd/internal/version.version=${VERSION} -X github.com/motoki317/kd/internal/version.commit=${COMMIT}" \
      -o /kd ./cmd/kd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /kd /kd
EXPOSE 9123
USER nonroot:nonroot
ENTRYPOINT ["/kd"]
