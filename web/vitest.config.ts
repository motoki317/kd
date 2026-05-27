import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

// Separate from vite.config.ts so the dev-server proxy config does not load during tests.
// jsdom lets component tests render; the pure modules (layout, graphState) run there too.
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
