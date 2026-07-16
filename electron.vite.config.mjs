import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Read package.json rather than npm_package_version — that env var only exists
// under an `npm run` wrapper, so a bare `npx electron-vite build` would silently
// stamp the app 0.0.0.
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

// Compile-time constants so the app can show which build it's running. Version
// alone can't answer "am I on the latest?" — two builds can share one version —
// so BUILD_TIME is the real discriminator. `release.ps1` sets it; a plain build
// falls back to "now".
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__: JSON.stringify(process.env.BUILD_TIME || new Date().toISOString().slice(0, 16).replace('T', ' ')),
}

export default defineConfig({
  main: {
    define,
    build: {
      rollupOptions: { input: resolve('src/main/index.js') },
      // chokidar must stay external (native fs internals are not bundle-friendly)
      lib: { entry: resolve('src/main/index.js'), formats: ['es'] },
    },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve('src/preload/index.js') },
      lib: { entry: resolve('src/preload/index.js'), formats: ['cjs'] },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    define,
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    plugins: [react()],
  },
})
