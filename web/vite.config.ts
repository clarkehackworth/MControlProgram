import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Besides the app, the build emits the plugin UI SDK at fixed URLs (/sdk/*.js). Plugin UI bundles import
 * react, react/jsx-runtime and @mcontrolprogram/ui from there, so they share the app's module instances.
 */
const SDK = ['react', 'jsx-runtime', 'ui']
export default defineConfig({
  plugins: [react(), {
    name: 'sdk-dev', // dev server: /sdk/x.js → the source module (same optimized deps as the app)
    configureServer(s) { s.middlewares.use((req, _res, next) => { const m = req.url?.match(/^\/sdk\/([\w-]+)\.js/); if (m && SDK.includes(m[1])) req.url = `/src/sdk/${m[1]}.ts`; next() }) },
  }],
  server: { proxy: { '/api': 'http://127.0.0.1:7700' } },
  build: {
    rollupOptions: {
      input: { index: 'index.html', ...Object.fromEntries(SDK.map((n) => [`sdk/${n}`, `src/sdk/${n}.ts`])) },
      preserveEntrySignatures: 'exports-only',
      output: { entryFileNames: (c) => (c.name.startsWith('sdk/') ? '[name].js' : 'assets/[name]-[hash].js') },
    },
  },
})
