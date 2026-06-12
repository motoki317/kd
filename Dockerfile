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
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Bring in the built client so go:embed (embed_web tag) can include it.
COPY --from=web /internal/server/webdist ./internal/server/webdist
RUN CGO_ENABLED=0 go build -tags embed_web -ldflags="-s -w" -o /kd ./cmd/kd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /kd /kd
EXPOSE 9123
USER nonroot:nonroot
ENTRYPOINT ["/kd"]
