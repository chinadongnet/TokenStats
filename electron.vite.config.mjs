import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Compile-time constants so the app can show which build it's running.
// `release.ps1` sets BUILD_TIME; a plain build falls back to "now".
const define = {
  __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '0.0.0'),
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
