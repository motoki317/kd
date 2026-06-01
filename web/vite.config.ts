import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// The production build is emitted into the Go server package so it can be embedded
// via go:embed (see docs/ADR/20260527-architecture-overview.md). In dev, /api is
// proxied to the Go server so the client and API share an origin (no CORS), and a
// dev identity header is injected so no forward-auth proxy is needed locally.
export default defineConfig({
  plugins: [solid()],
  // Component tests render Solid into jsdom; pure-logic tests ignore the environment.
  test: {
    environment: 'jsdom',
  },
  build: {
    outDir: '../internal/server/webdist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:9123',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('X-Forwarded-User', 'dev'))
        },
      },
    },
  },
})
