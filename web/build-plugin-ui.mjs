// Builds each plugin's admin UI (<plugin>/ui/index.tsx) into one ES module, <out>/<plugin>/ui.js.
// One build per plugin, so plugins can't share code by accident: the only imports left in a bundle are
// the SDK (/sdk/*.js, served by the app) and declared dependencies' UIs (/api/plugins/<id>/ui.js).
// Usage: node build-plugin-ui.mjs [pluginsDir=../src/plugins] [outDir=../dist/plugins]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, process.argv[2] ?? '../src/plugins')
const out = path.resolve(here, process.argv[3] ?? '../dist/plugins')
const SDK = { react: '/sdk/react.js', 'react/jsx-runtime': '/sdk/jsx-runtime.js', '@mcontrolprogram/ui': '/sdk/ui.js' }
const paths = (id) => SDK[id] ?? (id.startsWith('@plugin/') ? `/api/plugins/${id.slice(8)}/ui.js` : id)

for (const id of fs.readdirSync(src).sort()) {
  const entry = path.join(src, id, 'ui', 'index.tsx')
  if (!fs.existsSync(entry)) continue
  await build({
    configFile: false, logLevel: 'warn', root: here,
    plugins: [react()],
    build: {
      outDir: path.join(out, id), emptyOutDir: false, copyPublicDir: false, minify: true,
      lib: { entry, formats: ['es'], fileName: () => 'ui.js' },
      rollupOptions: { external: (x) => x in SDK || x.startsWith('@plugin/'), output: { paths } },
    },
  })
  const code = fs.readFileSync(path.join(out, id, 'ui.js'), 'utf8')
  // import specifiers only: `from "x"`, bare `import "x"`, dynamic `import("x")` (string literals elsewhere are text)
  const bad = [...code.matchAll(/\bfrom\s*["']([^"'\n]+)["']|\bimport\s*\(?\s*["']([^"'\n]+)["']/g)].map((m) => m[1] ?? m[2]).filter((s) => !Object.values(SDK).includes(s) && !/^\/api\/plugins\/[\w-]+\/ui\.js$/.test(s))
  if (bad.length) throw new Error(`plugin ${id}: ui.js imports ${bad.join(', ')}; only the SDK and @plugin/<dependency> may be imported`)
  console.log(`plugin ui: ${id} → ${path.relative(process.cwd(), path.join(out, id, 'ui.js'))} (${code.length} bytes)`)
}
